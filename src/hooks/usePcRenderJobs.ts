import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import type {
  AppErrorBanner,
  DriveFileMeta,
  ExportQuality,
  PcJobSyncEntry,
  QueueItem,
  RenderJobManifest,
  RenderJobSourceFile,
  RenderJobTarget,
  TikTokEditOptions,
} from '../types';
import {
  DriveAuthExpiredError,
  deleteDriveFile,
  dispatchCloudRenderJob,
  downloadDriveVideo,
  ensureCloudSourcesSubfolder,
  listPcRenderJobsAndOutputs,
  uploadRenderJobManifest,
  uploadSourceVideoResumable8MB,
} from '../services/driveApi';
import { getCachedDriveToken } from '../services/googleAuth';
import {
  buildRenderJobManifest,
  formatPcJobStatusLabel,
  formatPhaseError,
} from '../utils/videoPipeline';
import { logError, logInfo, logWarn } from '../services/debugLogger';

interface UsePcRenderJobsParams {
  folderId: string;
  accessToken: string | null;
  isDriveConnected: boolean;
  cloudRenderConfigured: boolean;
  exportQuality: ExportQuality;
  tiktokOptions: TikTokEditOptions;
  itemsRef: MutableRefObject<QueueItem[]>;
  updateQueueItem: (id: string, patch: Partial<QueueItem>) => void;
  clearAuthSession: () => void;
  onError: (error: string | AppErrorBanner | null) => void;
}

export interface LastSentPcJobInfo {
  itemId: string;
  jobId: string;
  jobFileId: string;
  target: RenderJobTarget;
  outputFileName: string;
  sentAt: number;
}

export interface CloudUploadProgress {
  clipIndex: number;
  totalClips: number;
  percent: number;
  message: string;
}

const ACTIVE_REMOTE_POLL_INTERVAL_MS = 15_000;
const AUTO_RELAUNCH_PENDING_MS = 3 * 60 * 1000; // 3 minutes

export function usePcRenderJobs({
  folderId,
  accessToken,
  isDriveConnected,
  cloudRenderConfigured,
  exportQuality,
  tiktokOptions,
  itemsRef,
  updateQueueItem,
  clearAuthSession,
  onError,
}: UsePcRenderJobsParams) {
  const [pcJobs, setPcJobs] = useState<PcJobSyncEntry[]>([]);
  const [pcOutputs, setPcOutputs] = useState<DriveFileMeta[]>([]);
  const [isSyncingPcJobs, setIsSyncingPcJobs] = useState(false);
  const [lastPcSyncTime, setLastPcSyncTime] = useState<number | null>(null);
  const [sendingToPcId, setSendingToPcId] = useState<string | null>(null);
  const [sendingTarget, setSendingTarget] = useState<RenderJobTarget | null>(null);
  const [cloudUploadProgress, setCloudUploadProgress] = useState<CloudUploadProgress | null>(null);
  const [lastSentPcJob, setLastSentPcJob] = useState<LastSentPcJobInfo | null>(null);
  const [failedDispatchJobFileIds, setFailedDispatchJobFileIds] = useState<Record<string, string>>(
    {}
  );
  const [retryingDispatchJobFileId, setRetryingDispatchJobFileId] = useState<string | null>(null);
  const [downloadingOutputId, setDownloadingOutputId] = useState<string | null>(null);
  const [pcOutputPreviewUrls, setPcOutputPreviewUrls] = useState<Record<string, string>>({});
  const [isPageVisible, setIsPageVisible] = useState<boolean>(() =>
    typeof document === 'undefined' ? true : document.visibilityState === 'visible'
  );

  const previewUrlsRef = useRef<Record<string, string>>({});
  const syncingRef = useRef(false);
  const autoRetriedJobIdsRef = useRef<Set<string>>(new Set());
  const cleanedTempJobsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    return () => {
      Object.values(previewUrlsRef.current).forEach((url) => {
        try {
          URL.revokeObjectURL(url);
        } catch {
          // ignore
        }
      });
    };
  }, []);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const handleVisibility = () => {
      setIsPageVisible(document.visibilityState === 'visible');
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, []);

  const resolveDriveToken = useCallback((): string | null => {
    return accessToken || getCachedDriveToken();
  }, [accessToken]);

  const cleanupTempSourcesForJob = useCallback(
    async (manifest: RenderJobManifest, token: string) => {
      if (manifest.target !== 'cloud' || manifest.status !== 'completed') return;
      if (cleanedTempJobsRef.current.has(manifest.jobId)) return;

      // STRICT SAFETY: ONLY delete files explicitly tagged `uploadedTempSource: true`
      // (uploaded by the PWA to `_AutoCut_Jobs/_sources/`). Never touch user's original Drive clips.
      const tempSources = (manifest.sourceFiles || []).filter(
        (src) => src.uploadedTempSource === true && Boolean(src.driveFileId)
      );
      cleanedTempJobsRef.current.add(manifest.jobId);
      if (tempSources.length === 0) return;

      logInfo('Nube', 'Limpiando clips temporales de _sources/ tras render completado', {
        jobId: manifest.jobId,
        temporales: tempSources.length,
      });

      for (const src of tempSources) {
        try {
          if (src.driveFileId) {
            await deleteDriveFile(src.driveFileId, token);
          }
        } catch (err) {
          logWarn('Nube', 'No se pudo eliminar un clip temporal de _sources/', {
            jobId: manifest.jobId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    },
    []
  );

  const syncPcJobs = useCallback(
    async (silent = false) => {
      const token = resolveDriveToken();
      if (!token || !folderId.trim()) {
        if (!silent) {
          onError({
            message:
              'Conecta Google Drive y configura el ID de carpeta en Ajustes para consultar los renders remotos.',
            actionHint: 'settings',
          });
        }
        return;
      }

      if (syncingRef.current) return;
      syncingRef.current = true;
      setIsSyncingPcJobs(true);

      try {
        const snapshot = await listPcRenderJobsAndOutputs(folderId.trim(), token);
        setPcJobs(snapshot.jobs);
        setPcOutputs(snapshot.outputs);
        setLastPcSyncTime(Date.now());

        const nowMs = Date.now();
        const currentItems = itemsRef.current;

        for (const entry of snapshot.jobs) {
          const { manifest, outputFile } = entry;
          const target: RenderJobTarget = manifest.target === 'cloud' ? 'cloud' : 'pc';

          // Clear failed dispatch marker once worker picks up or finishes the job
          if (manifest.status === 'processing' || manifest.status === 'completed') {
            setFailedDispatchJobFileIds((prev) => {
              if (!prev[entry.jobFileId]) return prev;
              const next = { ...prev };
              delete next[entry.jobFileId];
              return next;
            });
          }

          // Clean up PWA-uploaded `_sources/` temp clips once cloud render completes
          if (target === 'cloud' && manifest.status === 'completed') {
            void cleanupTempSourcesForJob(manifest, token);
          }

          // Auto-relaunch pending cloud jobs older than 3 minutes (once per session)
          if (
            target === 'cloud' &&
            manifest.status === 'pending' &&
            cloudRenderConfigured &&
            !autoRetriedJobIdsRef.current.has(entry.jobFileId)
          ) {
            const createdMs = Date.parse(manifest.createdAt || '');
            if (Number.isFinite(createdMs) && nowMs - createdMs > AUTO_RELAUNCH_PENDING_MS) {
              autoRetriedJobIdsRef.current.add(entry.jobFileId);
              logInfo('Nube', 'Relanzando trabajo en la nube pendiente > 3 min', {
                jobId: manifest.jobId,
                esperaMin: Math.round((nowMs - createdMs) / 60_000),
              });
              void dispatchCloudRenderJob(entry.jobFileId)
                .then(() => {
                  setFailedDispatchJobFileIds((prev) => {
                    if (!prev[entry.jobFileId]) return prev;
                    const next = { ...prev };
                    delete next[entry.jobFileId];
                    return next;
                  });
                })
                .catch((err) => {
                  const errMsg =
                    err instanceof Error ? err.message : 'No se pudo relanzar GitHub Actions.';
                  setFailedDispatchJobFileIds((prev) => ({
                    ...prev,
                    [entry.jobFileId]: errMsg,
                  }));
                });
            }
          }

          // Reflect live remote status back onto matching QueueItems
          const matchingItem = currentItems.find(
            (it) =>
              (it.pcJobId && it.pcJobId === manifest.jobId) ||
              (manifest.queueItemId && it.id === manifest.queueItemId)
          );
          if (!matchingItem) continue;

          const statusLabel = formatPcJobStatusLabel(manifest.status, manifest.progress, target);
          const resolvedDriveId = outputFile?.id || manifest.outputDriveId;
          const resolvedWebViewLink = outputFile?.webViewLink || manifest.outputWebViewLink;

          const patch: Partial<QueueItem> = {
            pcJobId: manifest.jobId,
            pcJobFileId: entry.jobFileId,
            pcJobTarget: target,
            pcJobStatus: manifest.status,
            pcJobProgress: manifest.progress,
            pcJobError: manifest.errorMessage,
            outputFileName: outputFile?.name || manifest.outputFileName || matchingItem.outputFileName,
          };

          if (resolvedDriveId) {
            patch.pcOutputDriveId = resolvedDriveId;
          }
          if (resolvedWebViewLink) {
            patch.pcOutputWebViewLink = resolvedWebViewLink;
          }

          if (manifest.status === 'completed') {
            const originLabel = target === 'cloud' ? 'Renderizado en la nube' : 'Renderizado en PC';
            patch.stage = 'completed';
            patch.progress = 100;
            patch.completedAt = matchingItem.completedAt || Date.now();
            patch.stageDetail = manifest.encoderUsed
              ? `${originLabel} (${manifest.encoderUsed}) · Listo en _AutoCut_Output`
              : `${originLabel} · Listo en _AutoCut_Output`;
            if (resolvedDriveId) {
              patch.uploadedDriveId = resolvedDriveId;
            }
            if (resolvedWebViewLink) {
              patch.uploadedWebViewLink = resolvedWebViewLink;
            }
            if (outputFile?.size) {
              patch.editedSizeBytes = Number(outputFile.size) || matchingItem.editedSizeBytes;
            }
          } else if (manifest.status === 'processing' || manifest.status === 'pending') {
            patch.stageDetail = `${target === 'cloud' ? 'Nube' : 'PC'}: ${statusLabel}`;
          } else if (manifest.status === 'error') {
            patch.stageDetail = `${target === 'cloud' ? 'Nube' : 'PC'} Error: ${
              manifest.errorMessage || 'Fallo en FFmpeg remoto'
            }`;
          }

          updateQueueItem(matchingItem.id, patch);
        }
      } catch (err) {
        if (err instanceof DriveAuthExpiredError) {
          clearAuthSession();
          if (!silent) {
            onError(formatPhaseError('Drive', err.message));
          }
        } else {
          const msg = err instanceof Error ? err.message : 'No se pudo consultar _AutoCut_Jobs.';
          logError('Drive', 'Error al sincronizar renders remotos', { error: msg });
          if (!silent) {
            onError(formatPhaseError('Drive', msg));
          }
        }
      } finally {
        syncingRef.current = false;
        setIsSyncingPcJobs(false);
      }
    },
    [
      resolveDriveToken,
      folderId,
      cloudRenderConfigured,
      itemsRef,
      updateQueueItem,
      clearAuthSession,
      onError,
      cleanupTempSourcesForJob,
    ]
  );

  const sendItemToPc = useCallback(
    async (itemId: string): Promise<RenderJobManifest | null> => {
      const token = resolveDriveToken();
      if (!token) {
        onError('Inicia sesión con Google Drive para enviar el render al PC.');
        return null;
      }
      if (!folderId.trim()) {
        onError({
          message: 'Configura primero el ID de tu carpeta de Google Drive en Ajustes.',
          actionHint: 'settings',
        });
        return null;
      }

      const item = itemsRef.current.find((i) => i.id === itemId);
      if (!item || !item.analysis) {
        onError('Este vídeo todavía no tiene cortes analizados por Gemini.');
        return null;
      }

      if (item.source === 'demo') {
        logWarn('UI', 'Intento de envío a PC con vídeo de demostración', {
          item: item.originalName,
        });
      }

      setSendingToPcId(itemId);
      setSendingTarget('pc');
      onError(null);

      try {
        const manifest = buildRenderJobManifest({
          item,
          exportQuality,
          tiktokOptions,
          target: 'pc',
        });

        logInfo('UI', 'Enviando manifiesto de render a PC (sin descargar bruto en móvil)', {
          jobId: manifest.jobId,
          clips: manifest.sourceFiles.length,
          cortes: manifest.cuts.length,
          calidad: manifest.options.quality,
          encuadre: manifest.options.framing,
          subtitulos: manifest.options.subtitlesEnabled,
        });

        const uploaded = await uploadRenderJobManifest(folderId.trim(), manifest, token);

        updateQueueItem(itemId, {
          pcJobId: manifest.jobId,
          pcJobFileId: uploaded.id,
          pcJobTarget: 'pc',
          pcJobStatus: 'pending',
          pcJobProgress: 0,
          pcJobError: undefined,
          outputFileName: manifest.outputFileName,
          stageDetail: `Enviado a PC (_AutoCut_Jobs/${uploaded.name}) · En cola PC`,
        });

        const newEntry: PcJobSyncEntry = {
          manifest,
          jobFileId: uploaded.id,
          jobFileName: uploaded.name,
          modifiedTime: manifest.createdAt,
        };

        setPcJobs((prev) => [
          newEntry,
          ...prev.filter((entry) => entry.manifest.jobId !== manifest.jobId),
        ]);
        setLastPcSyncTime(Date.now());
        setLastSentPcJob({
          itemId,
          jobId: manifest.jobId,
          jobFileId: uploaded.id,
          target: 'pc',
          outputFileName: manifest.outputFileName,
          sentAt: Date.now(),
        });

        return manifest;
      } catch (err) {
        if (err instanceof DriveAuthExpiredError) {
          clearAuthSession();
          onError(formatPhaseError('Drive', err.message));
        } else {
          const msg =
            err instanceof Error ? err.message : 'No se pudo enviar el trabajo a _AutoCut_Jobs.';
          logError('Drive', 'Fallo al enviar trabajo de render a PC', { error: msg });
          onError(formatPhaseError('Drive', msg));
        }
        return null;
      } finally {
        setSendingToPcId(null);
        setSendingTarget(null);
      }
    },
    [
      resolveDriveToken,
      folderId,
      itemsRef,
      exportQuality,
      tiktokOptions,
      updateQueueItem,
      clearAuthSession,
      onError,
    ]
  );

  const sendItemToCloud = useCallback(
    async (itemId: string): Promise<RenderJobManifest | null> => {
      if (!cloudRenderConfigured) {
        onError({
          message:
            'El render en la nube aún no está configurado en el servidor. Consulta la guía en Ajustes.',
          actionHint: 'settings',
        });
        return null;
      }

      const token = resolveDriveToken();
      if (!token) {
        onError('Inicia sesión con Google Drive para renderizar en la nube.');
        return null;
      }
      if (!folderId.trim()) {
        onError({
          message: 'Configura primero el ID de tu carpeta de Google Drive en Ajustes.',
          actionHint: 'settings',
        });
        return null;
      }

      const item = itemsRef.current.find((i) => i.id === itemId);
      if (!item || !item.analysis) {
        onError('Este vídeo todavía no tiene cortes analizados por Gemini.');
        return null;
      }

      setSendingToPcId(itemId);
      setSendingTarget('cloud');
      setCloudUploadProgress(null);
      onError(null);

      try {
        const isMulti = Boolean(item.isMultiClip && item.sourceClips && item.sourceClips.length > 0);
        const clipCandidates = isMulti
          ? item.sourceClips!.map((clip, idx) => ({
              index: idx,
              name: clip.originalName,
              driveFileId: clip.driveFileId,
              rawBlob: clip.rawBlob,
            }))
          : [
              {
                index: 0,
                name: item.originalName,
                driveFileId: item.driveFileId,
                rawBlob: item.rawBlob,
              },
            ];

        // Check if any local clips need resumable upload to `_AutoCut_Jobs/_sources/`
        const needsLocalUpload = clipCandidates.some((c) => !c.driveFileId);
        let sourcesFolderId: string | null = null;
        if (needsLocalUpload) {
          const missingRealSource = clipCandidates.find((c) => !c.driveFileId && !c.rawBlob);
          if (missingRealSource) {
            throw new Error(
              'Este clip de ejemplo no tiene archivo real para subir a la nube. Usa un vídeo de Google Drive o súbelo desde tu dispositivo.'
            );
          }
          logInfo('Nube', 'Preparando carpeta _AutoCut_Jobs/_sources para clips locales', {
            clipsLocales: clipCandidates.filter((c) => !c.driveFileId).length,
          });
          sourcesFolderId = await ensureCloudSourcesSubfolder(folderId.trim(), token);
        }

        const resolvedSourceFiles: RenderJobSourceFile[] = [];
        const localToUpload = clipCandidates.filter((c) => !c.driveFileId);
        let uploadedLocalCount = 0;

        for (const clip of clipCandidates) {
          if (clip.driveFileId) {
            resolvedSourceFiles.push({
              name: clip.name,
              driveFileId: clip.driveFileId,
            });
            continue;
          }

          uploadedLocalCount += 1;
          const uploadIndex = uploadedLocalCount;
          const totalLocal = localToUpload.length;
          const tempFileName = `src_${Date.now().toString(36)}_${clip.index}_${clip.name}`;

          setCloudUploadProgress({
            clipIndex: uploadIndex,
            totalClips: totalLocal,
            percent: 2,
            message: `Subiendo clip local ${uploadIndex}/${totalLocal} a Drive (_sources)...`,
          });

          const uploadedClip = await uploadSourceVideoResumable8MB(
            sourcesFolderId!,
            tempFileName,
            clip.rawBlob!,
            token,
            (pct) => {
              setCloudUploadProgress({
                clipIndex: uploadIndex,
                totalClips: totalLocal,
                percent: pct,
                message: `Subiendo clip local ${uploadIndex}/${totalLocal} a Drive (${pct}%)...`,
              });
            }
          );

          resolvedSourceFiles.push({
            name: clip.name,
            driveFileId: uploadedClip.id,
            uploadedTempSource: true,
          });
        }

        setCloudUploadProgress(null);

        const manifest = buildRenderJobManifest({
          item,
          exportQuality,
          tiktokOptions,
          target: 'cloud',
          sourceFilesOverride: resolvedSourceFiles,
        });

        logInfo('Nube', 'Subiendo manifiesto cloud a _AutoCut_Jobs', {
          jobId: manifest.jobId,
          clips: manifest.sourceFiles.length,
          clipsTemporales: resolvedSourceFiles.filter((s) => s.uploadedTempSource).length,
          cortes: manifest.cuts.length,
          calidad: manifest.options.quality,
        });

        const uploaded = await uploadRenderJobManifest(folderId.trim(), manifest, token);

        const newEntry: PcJobSyncEntry = {
          manifest,
          jobFileId: uploaded.id,
          jobFileName: uploaded.name,
          modifiedTime: manifest.createdAt,
        };

        setPcJobs((prev) => [
          newEntry,
          ...prev.filter((entry) => entry.manifest.jobId !== manifest.jobId),
        ]);
        setLastPcSyncTime(Date.now());
        setLastSentPcJob({
          itemId,
          jobId: manifest.jobId,
          jobFileId: uploaded.id,
          target: 'cloud',
          outputFileName: manifest.outputFileName,
          sentAt: Date.now(),
        });

        updateQueueItem(itemId, {
          pcJobId: manifest.jobId,
          pcJobFileId: uploaded.id,
          pcJobTarget: 'cloud',
          pcJobStatus: 'pending',
          pcJobProgress: 0,
          pcJobError: undefined,
          outputFileName: manifest.outputFileName,
          stageDetail: 'Nube: Enviando señal a GitHub Actions...',
        });

        // Dispatch GitHub Actions workflow via server proxy
        try {
          await dispatchCloudRenderJob(uploaded.id);
          setFailedDispatchJobFileIds((prev) => {
            if (!prev[uploaded.id]) return prev;
            const next = { ...prev };
            delete next[uploaded.id];
            return next;
          });
          updateQueueItem(itemId, {
            stageDetail: 'Nube: En cola nube · GitHub Actions disparado',
          });
        } catch (dispatchErr) {
          const dispatchMsg =
            dispatchErr instanceof Error
              ? dispatchErr.message
              : 'No se pudo disparar el workflow de GitHub Actions.';
          logError('Nube', 'Manifiesto guardado pero falló el disparo de GitHub Actions', {
            jobId: manifest.jobId,
            error: dispatchMsg,
          });
          setFailedDispatchJobFileIds((prev) => ({
            ...prev,
            [uploaded.id]: dispatchMsg,
          }));
          updateQueueItem(itemId, {
            stageDetail: 'Nube: En cola (pendiente de reintento de envío)',
          });
          onError(
            `El trabajo se guardó en Drive pero falló el aviso a GitHub Actions: ${dispatchMsg}`
          );
        }

        return manifest;
      } catch (err) {
        if (err instanceof DriveAuthExpiredError) {
          clearAuthSession();
          onError(formatPhaseError('Drive', err.message));
        } else {
          const msg =
            err instanceof Error
              ? err.message
              : 'No se pudo preparar el render en la nube.';
          logError('Nube', 'Error al preparar el render en la nube', { error: msg });
          onError(msg);
        }
        return null;
      } finally {
        setCloudUploadProgress(null);
        setSendingToPcId(null);
        setSendingTarget(null);
      }
    },
    [
      cloudRenderConfigured,
      resolveDriveToken,
      folderId,
      itemsRef,
      exportQuality,
      tiktokOptions,
      updateQueueItem,
      clearAuthSession,
      onError,
    ]
  );

  const retryCloudDispatch = useCallback(
    async (jobFileId: string): Promise<boolean> => {
      if (!cloudRenderConfigured) {
        onError({
          message:
            'El render en la nube no está configurado en el servidor. Revisa Ajustes.',
          actionHint: 'settings',
        });
        return false;
      }

      setRetryingDispatchJobFileId(jobFileId);
      onError(null);

      try {
        logInfo('Nube', 'Reintentando disparo manual de GitHub Actions');
        await dispatchCloudRenderJob(jobFileId);
        setFailedDispatchJobFileIds((prev) => {
          if (!prev[jobFileId]) return prev;
          const next = { ...prev };
          delete next[jobFileId];
          return next;
        });

        const matchingEntry = pcJobs.find((j) => j.jobFileId === jobFileId);
        if (matchingEntry) {
          const matchingItem = itemsRef.current.find(
            (it) =>
              it.pcJobFileId === jobFileId ||
              it.pcJobId === matchingEntry.manifest.jobId ||
              (matchingEntry.manifest.queueItemId && it.id === matchingEntry.manifest.queueItemId)
          );
          if (matchingItem) {
            updateQueueItem(matchingItem.id, {
              stageDetail: 'Nube: En cola nube · Reenvío a GitHub Actions aceptado',
            });
          }
        }
        return true;
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : 'No se pudo reintentar el envío a GitHub Actions.';
        logError('Nube', 'Error en reintento manual de disparo', { error: msg });
        setFailedDispatchJobFileIds((prev) => ({
          ...prev,
          [jobFileId]: msg,
        }));
        onError(msg);
        return false;
      } finally {
        setRetryingDispatchJobFileId(null);
      }
    },
    [cloudRenderConfigured, pcJobs, itemsRef, updateQueueItem, onError]
  );

  const downloadPcOutputVideo = useCallback(
    async (outputFile: DriveFileMeta, triggerSave = false): Promise<string | null> => {
      const existingUrl = previewUrlsRef.current[outputFile.id];
      if (existingUrl) {
        if (triggerSave) {
          const anchor = document.createElement('a');
          anchor.href = existingUrl;
          anchor.download = outputFile.name;
          anchor.click();
        }
        return existingUrl;
      }

      const token = resolveDriveToken();
      if (!token) {
        onError('Inicia sesión con Google Drive para descargar el MP4 renderizado.');
        return null;
      }

      setDownloadingOutputId(outputFile.id);
      onError(null);

      try {
        logInfo('Drive', 'Descargando MP4 completado desde _AutoCut_Output', {
          archivo: outputFile.name,
          pesoMB: Number(((Number(outputFile.size) || 0) / (1024 * 1024)).toFixed(2)),
        });

        const blob = await downloadDriveVideo(
          outputFile.id,
          token,
          Number(outputFile.size) || 0
        );
        const objectUrl = URL.createObjectURL(blob);
        previewUrlsRef.current[outputFile.id] = objectUrl;
        setPcOutputPreviewUrls((prev) => ({ ...prev, [outputFile.id]: objectUrl }));

        if (triggerSave) {
          const anchor = document.createElement('a');
          anchor.href = objectUrl;
          anchor.download = outputFile.name;
          anchor.click();
        }

        return objectUrl;
      } catch (err) {
        if (err instanceof DriveAuthExpiredError) {
          clearAuthSession();
          onError(formatPhaseError('Drive', err.message));
        } else {
          const msg =
            err instanceof Error
              ? err.message
              : 'No se pudo descargar el MP4 desde _AutoCut_Output.';
          logError('Drive', 'Error al descargar resultado remoto', {
            archivo: outputFile.name,
            error: msg,
          });
          onError(formatPhaseError('Drive', msg));
        }
        return null;
      } finally {
        setDownloadingOutputId(null);
      }
    },
    [resolveDriveToken, clearAuthSession, onError]
  );

  // Initial silent sync when Drive connects with a valid folderId (also checks >3 min pending cloud jobs)
  useEffect(() => {
    if (!isDriveConnected || !folderId.trim()) return;
    void syncPcJobs(true);
  }, [isDriveConnected, folderId, syncPcJobs]);

  // Active remote jobs polling: every 15 s ONLY while pending/processing AND tab is visible
  const hasActivePcJobs = pcJobs.some(
    (entry) => entry.manifest.status === 'pending' || entry.manifest.status === 'processing'
  );

  useEffect(() => {
    if (!isDriveConnected || !folderId.trim() || !hasActivePcJobs || !isPageVisible) return;
    const timer = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      void syncPcJobs(true);
    }, ACTIVE_REMOTE_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [isDriveConnected, folderId, hasActivePcJobs, isPageVisible, syncPcJobs]);

  // Immediate refresh when returning to the tab while remote jobs are active
  useEffect(() => {
    if (!isPageVisible || !isDriveConnected || !folderId.trim() || !hasActivePcJobs) return;
    void syncPcJobs(true);
  }, [isPageVisible]);

  return {
    pcJobs,
    pcOutputs,
    isSyncingPcJobs,
    lastPcSyncTime,
    sendingToPcId,
    sendingTarget,
    cloudUploadProgress,
    lastSentPcJob,
    failedDispatchJobFileIds,
    retryingDispatchJobFileId,
    downloadingOutputId,
    pcOutputPreviewUrls,
    hasActivePcJobs,
    sendItemToPc,
    sendItemToCloud,
    retryCloudDispatch,
    syncPcJobs,
    downloadPcOutputVideo,
  };
}
