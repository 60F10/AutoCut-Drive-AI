import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import type {
  AppErrorBanner,
  DriveFileMeta,
  ExportQuality,
  PcJobSyncEntry,
  QueueItem,
  RenderJobManifest,
  TikTokEditOptions,
} from '../types';
import {
  DriveAuthExpiredError,
  downloadDriveVideo,
  listPcRenderJobsAndOutputs,
  uploadRenderJobManifest,
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
  outputFileName: string;
  sentAt: number;
}

const ACTIVE_PC_POLL_INTERVAL_MS = 12_000;

export function usePcRenderJobs({
  folderId,
  accessToken,
  isDriveConnected,
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
  const [lastSentPcJob, setLastSentPcJob] = useState<LastSentPcJobInfo | null>(null);
  const [downloadingOutputId, setDownloadingOutputId] = useState<string | null>(null);
  const [pcOutputPreviewUrls, setPcOutputPreviewUrls] = useState<Record<string, string>>({});

  const previewUrlsRef = useRef<Record<string, string>>({});
  const syncingRef = useRef(false);

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

  const resolveDriveToken = useCallback((): string | null => {
    return accessToken || getCachedDriveToken();
  }, [accessToken]);

  const syncPcJobs = useCallback(
    async (silent = false) => {
      const token = resolveDriveToken();
      if (!token || !folderId.trim()) {
        if (!silent) {
          onError({
            message:
              'Conecta Google Drive y configura el ID de carpeta en Ajustes para consultar los trabajos del PC.',
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

        // Reflect live PC status back onto matching QueueItems so Queue, Studio & Gallery stay in sync
        const currentItems = itemsRef.current;
        for (const entry of snapshot.jobs) {
          const { manifest, outputFile } = entry;
          const matchingItem = currentItems.find(
            (it) =>
              (it.pcJobId && it.pcJobId === manifest.jobId) ||
              (manifest.queueItemId && it.id === manifest.queueItemId)
          );
          if (!matchingItem) continue;

          const statusLabel = formatPcJobStatusLabel(manifest.status, manifest.progress);
          const patch: Partial<QueueItem> = {
            pcJobId: manifest.jobId,
            pcJobStatus: manifest.status,
            pcJobProgress: manifest.progress,
            pcJobError: manifest.errorMessage,
            outputFileName: outputFile?.name || manifest.outputFileName || matchingItem.outputFileName,
          };

          if (outputFile) {
            patch.pcOutputDriveId = outputFile.id;
            patch.pcOutputWebViewLink = outputFile.webViewLink;
          }

          if (manifest.status === 'completed') {
            patch.stage = 'completed';
            patch.progress = 100;
            patch.completedAt = matchingItem.completedAt || Date.now();
            patch.stageDetail = manifest.encoderUsed
              ? `Renderizado en PC (${manifest.encoderUsed}) · Listo en _AutoCut_Output`
              : 'Renderizado en PC · Listo en _AutoCut_Output';
            if (outputFile) {
              patch.uploadedDriveId = outputFile.id;
              patch.uploadedWebViewLink = outputFile.webViewLink;
              patch.editedSizeBytes = Number(outputFile.size) || matchingItem.editedSizeBytes;
            }
          } else if (manifest.status === 'processing' || manifest.status === 'pending') {
            patch.stageDetail = `PC: ${statusLabel}`;
          } else if (manifest.status === 'error') {
            patch.stageDetail = `PC Error: ${manifest.errorMessage || 'Fallo en FFmpeg nativo'}`;
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
          logError('Drive', 'Error al sincronizar trabajos de PC', { error: msg });
          if (!silent) {
            onError(formatPhaseError('Drive', msg));
          }
        }
      } finally {
        syncingRef.current = false;
        setIsSyncingPcJobs(false);
      }
    },
    [resolveDriveToken, folderId, itemsRef, updateQueueItem, clearAuthSession, onError]
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
        logWarn('UI', 'Intento de envío a PC con vídeo de demostración', { item: item.originalName });
      }

      setSendingToPcId(itemId);
      onError(null);

      try {
        const manifest = buildRenderJobManifest({
          item,
          exportQuality,
          tiktokOptions,
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
        onError('Inicia sesión con Google Drive para descargar el MP4 renderizado en el PC.');
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
          logError('Drive', 'Error al descargar resultado del PC', {
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

  // Initial silent sync when Drive connects with a valid folderId
  useEffect(() => {
    if (!isDriveConnected || !folderId.trim()) return;
    void syncPcJobs(true);
  }, [isDriveConnected, folderId, syncPcJobs]);

  // Gentle auto-polling only while there are active PC jobs (pending or processing)
  const hasActivePcJobs = pcJobs.some(
    (entry) => entry.manifest.status === 'pending' || entry.manifest.status === 'processing'
  );

  useEffect(() => {
    if (!isDriveConnected || !folderId.trim() || !hasActivePcJobs) return;
    const timer = window.setInterval(() => {
      void syncPcJobs(true);
    }, ACTIVE_PC_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [isDriveConnected, folderId, hasActivePcJobs, syncPcJobs]);

  return {
    pcJobs,
    pcOutputs,
    isSyncingPcJobs,
    lastPcSyncTime,
    sendingToPcId,
    lastSentPcJob,
    downloadingOutputId,
    pcOutputPreviewUrls,
    hasActivePcJobs,
    sendItemToPc,
    syncPcJobs,
    downloadPcOutputVideo,
  };
}
