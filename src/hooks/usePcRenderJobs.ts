import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
import type {
  AnalyzeJobManifest,
  AnalyzeJobSourceFile,
  AnalyzeJobSyncEntry,
  AppErrorBanner,
  BrollDensity,
  DriveFileMeta,
  EditStylePreset,
  ExportQuality,
  PcJobSyncEntry,
  PcWorkerStatus,
  ProcessEngineMode,
  QueueItem,
  RenderJobManifest,
  RenderJobSourceFile,
  RenderJobTarget,
  SourceClipRef,
  TikTokEditOptions,
  WhisperModelId,
} from '../types';
import {
  DriveAuthExpiredError,
  DriveHttpError,
  deleteDriveFile,
  dispatchCloudRenderJob,
  downloadDriveVideo,
  ensureCloudSourcesSubfolder,
  fetchCloudWorkflowStatus,
  listPcRenderJobsAndOutputs,
  patchDriveJsonFile,
  uploadAnalyzeJobManifest,
  uploadRenderJobManifest,
  uploadSourceVideoResumable8MB,
} from '../services/driveApi';
import { getCachedDriveToken } from '../services/googleAuth';
import {
  buildAnalyzeJobManifest,
  buildCombinedEditedFilename,
  buildEditedFilename,
  buildRenderJobManifest,
  cloudEditPlanToGeminiEditPlan,
  formatAnalyzeStageLabel,
  formatPcJobStatusLabel,
  formatPhaseError,
} from '../utils/videoPipeline';
import {
  BASE_REMOTE_POLL_INTERVAL_MS,
  RemoteJobsPoller,
  computeNextPollBackoffMs,
  hasActiveRemoteJobs,
  inspectStuckCloudJobs,
  isBackoffTriggerHttpStatus,
  isPcWorkerOnline,
  resolveProcessTarget,
  type CloudWorkflowFailureRecord,
} from '../utils/remoteJobsSync';
import { logError, logInfo, logWarn } from '../services/debugLogger';

interface UsePcRenderJobsParams {
  folderId: string;
  accessToken: string | null;
  isDriveConnected: boolean;
  cloudRenderConfigured: boolean;
  processEngine: ProcessEngineMode;
  geminiModel: string;
  whisperModel: WhisperModelId;
  stylePreset: EditStylePreset;
  customInstruction: string;
  exportQuality: ExportQuality;
  tiktokOptions: TikTokEditOptions;
  voiceoverBrollEnabled: boolean;
  brollDensity: BrollDensity;
  brollSmoothPanEnabled: boolean;
  brollAmbientAudioEnabled: boolean;
  itemsRef: MutableRefObject<QueueItem[]>;
  setItems: Dispatch<SetStateAction<QueueItem[]>>;
  updateQueueItem: (id: string, patch: Partial<QueueItem>) => void;
  onOpenStudio: (itemId: string) => void;
  onCloseMultiClipModal?: () => void;
  onClearCombineSelection?: () => void;
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

interface ClipUploadCandidate {
  index: number;
  name: string;
  driveFileId?: string;
  modifiedTime?: string;
  rawBlob?: Blob;
  uploadedTempSource?: boolean;
}

export function usePcRenderJobs({
  folderId,
  accessToken,
  isDriveConnected,
  cloudRenderConfigured,
  processEngine,
  geminiModel,
  whisperModel,
  stylePreset,
  customInstruction,
  exportQuality,
  tiktokOptions,
  voiceoverBrollEnabled,
  brollDensity,
  brollSmoothPanEnabled,
  brollAmbientAudioEnabled,
  itemsRef,
  setItems,
  updateQueueItem,
  onOpenStudio,
  onCloseMultiClipModal,
  onClearCombineSelection,
  clearAuthSession,
  onError,
}: UsePcRenderJobsParams) {
  const [pcJobs, setPcJobs] = useState<PcJobSyncEntry[]>([]);
  const [analyzeJobs, setAnalyzeJobs] = useState<AnalyzeJobSyncEntry[]>([]);
  const [pcOutputs, setPcOutputs] = useState<DriveFileMeta[]>([]);
  const [pcWorkerStatus, setPcWorkerStatus] = useState<PcWorkerStatus | null>(null);
  const [isSyncingPcJobs, setIsSyncingPcJobs] = useState(false);
  const [lastPcSyncTime, setLastPcSyncTime] = useState<number | null>(null);
  const [sendingToPcId, setSendingToPcId] = useState<string | null>(null);
  const [sendingTarget, setSendingTarget] = useState<RenderJobTarget | null>(null);
  const [sendingAnalyzeId, setSendingAnalyzeId] = useState<string | null>(null);
  const [cloudUploadProgress, setCloudUploadProgress] = useState<CloudUploadProgress | null>(null);
  const [lastSentPcJob, setLastSentPcJob] = useState<LastSentPcJobInfo | null>(null);
  const [failedDispatchJobFileIds, setFailedDispatchJobFileIds] = useState<Record<string, string>>(
    {}
  );
  const [retryingDispatchJobFileId, setRetryingDispatchJobFileId] = useState<string | null>(null);
  const [fallingBackJobFileId, setFallingBackJobFileId] = useState<string | null>(null);
  const [downloadingOutputId, setDownloadingOutputId] = useState<string | null>(null);
  const [pcOutputPreviewUrls, setPcOutputPreviewUrls] = useState<Record<string, string>>({});
  const [pollIntervalMs, setPollIntervalMs] = useState<number>(BASE_REMOTE_POLL_INTERVAL_MS);
  const [isPageVisible, setIsPageVisible] = useState<boolean>(() =>
    typeof document === 'undefined' ? true : document.visibilityState === 'visible'
  );

  const isPcOnline = isPcWorkerOnline(pcWorkerStatus);
  const resolvedTarget: RenderJobTarget = resolveProcessTarget({
    processEngine,
    pcOnline: isPcOnline,
  });

  const previewUrlsRef = useRef<Record<string, string>>({});
  const syncingRef = useRef(false);
  const autoRetriedJobIdsRef = useRef<Set<string>>(new Set());
  const cleanedTempJobsRef = useRef<Set<string>>(new Set());
  const appliedAnalyzeJobIdsRef = useRef<Set<string>>(new Set());
  const dispatchedAtByJobFileIdRef = useRef<Record<string, number>>({});
  const cloudWorkflowFailuresRef = useRef<Record<string, CloudWorkflowFailureRecord>>({});
  const pollIntervalMsRef = useRef<number>(BASE_REMOTE_POLL_INTERVAL_MS);
  const pollerRef = useRef<RemoteJobsPoller | null>(null);
  const syncPcJobsRef = useRef<(silent?: boolean) => Promise<void>>(async () => {});
  const wasHiddenRef = useRef<boolean>(false);
  const isDriveConnectedRef = useRef<boolean>(isDriveConnected);
  const trimmedFolderId = folderId.trim();
  const folderIdRef = useRef<string>(trimmedFolderId);
  const hasActivePcJobs = hasActiveRemoteJobs(pcJobs, analyzeJobs);
  const hasActivePcJobsRef = useRef<boolean>(hasActivePcJobs);

  isDriveConnectedRef.current = isDriveConnected;
  folderIdRef.current = trimmedFolderId;
  hasActivePcJobsRef.current = hasActivePcJobs;
  pollIntervalMsRef.current = pollIntervalMs;

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
      const visible = document.visibilityState === 'visible';
      setIsPageVisible(visible);
      if (!visible) {
        wasHiddenRef.current = true;
        return;
      }
      if (
        wasHiddenRef.current &&
        isDriveConnectedRef.current &&
        folderIdRef.current &&
        hasActivePcJobsRef.current
      ) {
        wasHiddenRef.current = false;
        void syncPcJobsRef.current(true);
      } else {
        wasHiddenRef.current = false;
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, []);

  const resolveDriveToken = useCallback((): string | null => {
    return accessToken || getCachedDriveToken();
  }, [accessToken]);

  const ensureSourceFilesInDrive = useCallback(
    async (
      clipCandidates: ClipUploadCandidate[],
      token: string
    ): Promise<AnalyzeJobSourceFile[]> => {
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

      const resolvedSourceFiles: AnalyzeJobSourceFile[] = [];
      const localToUpload = clipCandidates.filter((c) => !c.driveFileId);
      let uploadedLocalCount = 0;

      for (const clip of clipCandidates) {
        if (clip.driveFileId) {
          resolvedSourceFiles.push({
            name: clip.name,
            driveFileId: clip.driveFileId,
            ...(clip.modifiedTime ? { modifiedTime: clip.modifiedTime } : {}),
            ...(clip.uploadedTempSource ? { uploadedTempSource: true } : {}),
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
          modifiedTime: new Date().toISOString(),
          uploadedTempSource: true,
        });
      }

      setCloudUploadProgress(null);
      return resolvedSourceFiles;
    },
    [folderId]
  );

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
              'Conecta Google Drive y configura el ID de carpeta en Ajustes para consultar los trabajos remotos.',
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
        const nowMs = Date.now();

        // Reset backoff back to 15 s once Drive responds cleanly
        if (pollIntervalMsRef.current !== BASE_REMOTE_POLL_INTERVAL_MS) {
          pollIntervalMsRef.current = BASE_REMOTE_POLL_INTERVAL_MS;
          setPollIntervalMs(BASE_REMOTE_POLL_INTERVAL_MS);
        }

        // Check GitHub Actions runs for any cloud job stuck > 3 min with progress <= 5
        const inspection = await inspectStuckCloudJobs({
          jobs: snapshot.jobs,
          analyzeJobs: snapshot.analyzeJobs,
          cloudRenderConfigured,
          dispatchedAtByJobFileId: dispatchedAtByJobFileIdRef.current,
          existingFailures: cloudWorkflowFailuresRef.current,
          nowMs,
          fetchWorkflowStatus: fetchCloudWorkflowStatus,
          logger: {
            info: (message, details) => logInfo('Nube', message, details),
            warn: (message, details) => logWarn('Nube', message, details),
            error: (message, details) => logError('Nube', message, details),
          },
        });

        cloudWorkflowFailuresRef.current = inspection.failures;
        const missingRunSet = new Set(inspection.missingRunJobFileIds);
        const effectiveJobs = inspection.jobs;
        const effectiveAnalyzeJobs = inspection.analyzeJobs;

        setPcJobs(effectiveJobs);
        setAnalyzeJobs(effectiveAnalyzeJobs);
        setPcOutputs(snapshot.outputs);
        setPcWorkerStatus(snapshot.pcWorkerStatus);
        setLastPcSyncTime(nowMs);

        const currentItems = itemsRef.current;

        // 1. Sync Render Jobs (`job_*.json`)
        for (const entry of effectiveJobs) {
          const { manifest, outputFile } = entry;
          const target: RenderJobTarget = manifest.target === 'cloud' ? 'cloud' : 'pc';

          if (manifest.status === 'processing' || manifest.status === 'completed') {
            setFailedDispatchJobFileIds((prev) => {
              if (!prev[entry.jobFileId]) return prev;
              const next = { ...prev };
              delete next[entry.jobFileId];
              return next;
            });
          }

          if (target === 'cloud' && manifest.status === 'completed') {
            void cleanupTempSourcesForJob(manifest, token);
          }

          // Only auto-relaunch once if GitHub Actions had NO run at all after > 3 min
          if (
            target === 'cloud' &&
            manifest.status === 'pending' &&
            cloudRenderConfigured &&
            missingRunSet.has(entry.jobFileId) &&
            !autoRetriedJobIdsRef.current.has(entry.jobFileId)
          ) {
            autoRetriedJobIdsRef.current.add(entry.jobFileId);
            logInfo('Nube', 'Relanzando render en la nube sin ejecución tras > 3 min', {
              jobId: manifest.jobId,
            });
            void dispatchCloudRenderJob(entry.jobFileId)
              .then(() => {
                dispatchedAtByJobFileIdRef.current[entry.jobFileId] = Date.now();
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
            pcJobCreatedAt: manifest.createdAt,
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
            patch.cloudWorkflowRunUrl = undefined;
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
            if ((manifest.progress ?? 0) > 5) {
              patch.cloudWorkflowRunUrl = undefined;
            }
          } else if (manifest.status === 'error') {
            patch.cloudWorkflowRunUrl = entry.workflowRunUrl ?? matchingItem.cloudWorkflowRunUrl;
            patch.stageDetail = manifest.errorMessage?.startsWith('[GitHub]')
              ? manifest.errorMessage
              : `${target === 'cloud' ? 'Nube' : 'PC'} Error: ${
                  manifest.errorMessage || 'Fallo en FFmpeg remoto'
                }`;
          }

          updateQueueItem(matchingItem.id, patch);
        }

        // 2. Sync Remote Analyze Jobs (`analyze_*.json` — PC or Cloud)
        let newlyReadyStudioItemId: string | null = null;

        for (const entry of effectiveAnalyzeJobs) {
          const { manifest } = entry;
          const analyzeTarget: RenderJobTarget = manifest.target === 'pc' ? 'pc' : 'cloud';

          if (manifest.status === 'processing' || manifest.status === 'analyzed') {
            setFailedDispatchJobFileIds((prev) => {
              if (!prev[entry.jobFileId]) return prev;
              const next = { ...prev };
              delete next[entry.jobFileId];
              return next;
            });
          }

          // Only auto-relaunch once if a CLOUD job had NO GitHub Actions run after > 3 min
          if (
            analyzeTarget === 'cloud' &&
            manifest.status === 'pending' &&
            cloudRenderConfigured &&
            missingRunSet.has(entry.jobFileId) &&
            !autoRetriedJobIdsRef.current.has(entry.jobFileId)
          ) {
            autoRetriedJobIdsRef.current.add(entry.jobFileId);
            logInfo('Nube', 'Relanzando análisis en la nube sin ejecución tras > 3 min', {
              jobId: manifest.jobId,
            });
            void dispatchCloudRenderJob(entry.jobFileId)
              .then(() => {
                dispatchedAtByJobFileIdRef.current[entry.jobFileId] = Date.now();
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

          const matchingItem = itemsRef.current.find(
            (it) =>
              (it.analyzeJobId && it.analyzeJobId === manifest.jobId) ||
              (it.analyzeJobFileId && it.analyzeJobFileId === entry.jobFileId) ||
              (manifest.queueItemId && it.id === manifest.queueItemId)
          );

          const stageLabel = formatAnalyzeStageLabel(
            manifest.stage,
            manifest.status,
            manifest.progress,
            analyzeTarget
          );

          if (manifest.status === 'analyzed' && manifest.plan) {
            const alreadyApplied = appliedAnalyzeJobIdsRef.current.has(manifest.jobId);
            if (!alreadyApplied) {
              appliedAnalyzeJobIdsRef.current.add(manifest.jobId);

              const convertedPlan = cloudEditPlanToGeminiEditPlan(manifest.plan, {
                targetDurationSec: manifest.options?.targetDurationSec,
              });

              const isMulti = Boolean(manifest.isMultiClip || manifest.sourceFiles.length > 1);
              const baseName =
                manifest.projectName ||
                matchingItem?.projectName ||
                matchingItem?.originalName ||
                manifest.sourceFiles[0]?.name ||
                'Video_Remoto';
              const outputFileName = isMulti
                ? buildCombinedEditedFilename(baseName, convertedPlan.etiqueta)
                : buildEditedFilename(baseName, convertedPlan.etiqueta);

              if (matchingItem) {
                updateQueueItem(matchingItem.id, {
                  stage: 'review',
                  progress: 100,
                  stageDetail: 'Historia lista · Revisa los cortes y renderiza',
                  errorMessage: undefined,
                  analysis: convertedPlan,
                  outputFileName,
                  geminiFileCleaned: true,
                  analyzeJobId: manifest.jobId,
                  analyzeJobFileId: entry.jobFileId,
                  analyzeJobTarget: analyzeTarget,
                  analyzeJobCreatedAt: manifest.createdAt,
                  analyzeJobStatus: 'analyzed',
                  analyzeJobStage: 'revision',
                  analyzeJobProgress: 100,
                  analyzeJobError: undefined,
                  cloudWorkflowRunUrl: undefined,
                });
                newlyReadyStudioItemId = matchingItem.id;
              } else {
                // Hydrate an analyzed remote job even if the user reloaded the PWA while worker ran
                const hydratedId = manifest.queueItemId || `cloud-analyzed-${manifest.jobId}`;
                const hydratedClips: SourceClipRef[] = manifest.sourceFiles.map((sf, idx) => ({
                  id: `${hydratedId}-clip-${idx}`,
                  source: 'drive',
                  driveFileId: sf.driveFileId,
                  modifiedTime: sf.modifiedTime,
                  originalName: sf.name,
                  mimeType: 'video/mp4',
                  sizeBytes: 0,
                }));

                const hydratedItem: QueueItem = {
                  id: hydratedId,
                  source: 'drive',
                  driveFileId: isMulti ? undefined : manifest.sourceFiles[0]?.driveFileId,
                  isMultiClip: isMulti,
                  projectName: manifest.projectName,
                  originalName: isMulti
                    ? manifest.projectName
                      ? `${manifest.projectName} (${manifest.sourceFiles.length} clips)`
                      : `${manifest.sourceFiles[0]?.name || 'Multi-Clip'} + ${manifest.sourceFiles.length - 1} más`
                    : manifest.sourceFiles[0]?.name || 'Vídeo analizado remotamente',
                  mimeType: 'video/mp4',
                  sizeBytes: 0,
                  modifiedTime: manifest.sourceFiles[0]?.modifiedTime || manifest.createdAt,
                  stage: 'review',
                  stageDetail: 'Historia lista · Revisa los cortes y renderiza',
                  progress: 100,
                  outputFileName,
                  geminiFileCleaned: true,
                  analysis: convertedPlan,
                  sourceClips: isMulti ? hydratedClips : undefined,
                  stylePreset: manifest.options?.stylePreset,
                  customInstruction: manifest.options?.customInstruction,
                  analyzeJobId: manifest.jobId,
                  analyzeJobFileId: entry.jobFileId,
                  analyzeJobTarget: analyzeTarget,
                  analyzeJobCreatedAt: manifest.createdAt,
                  analyzeJobStatus: 'analyzed',
                  analyzeJobStage: 'revision',
                  analyzeJobProgress: 100,
                  lastUpdated: Date.now(),
                };

                setItems((prev) => {
                  if (prev.some((it) => it.id === hydratedId || it.analyzeJobId === manifest.jobId)) {
                    return prev;
                  }
                  return [hydratedItem, ...prev];
                });
              }

              logInfo('IA', 'Plan multimodal recibido y cargado en Estudio', {
                origen: analyzeTarget,
                jobId: manifest.jobId,
                cortes: convertedPlan.cortes.length,
                etiqueta: convertedPlan.etiqueta,
              });
            }
          } else if (manifest.status === 'pending' || manifest.status === 'processing') {
            if (matchingItem && matchingItem.stage !== 'completed') {
              // Only update if this analyze job is the active one on the item
              if (!matchingItem.analyzeJobId || matchingItem.analyzeJobId === manifest.jobId) {
                updateQueueItem(matchingItem.id, {
                  stage: 'analyzing',
                  progress: Math.max(5, Math.min(99, manifest.progress || 5)),
                  stageDetail: stageLabel,
                  errorMessage: undefined,
                  analyzeJobId: manifest.jobId,
                  analyzeJobFileId: entry.jobFileId,
                  analyzeJobTarget: analyzeTarget,
                  analyzeJobCreatedAt: manifest.createdAt,
                  analyzeJobStatus: manifest.status,
                  analyzeJobStage: manifest.stage,
                  analyzeJobProgress: manifest.progress || 0,
                  analyzeJobError: undefined,
                  ...((manifest.progress ?? 0) > 5 ? { cloudWorkflowRunUrl: undefined } : {}),
                });
              }
            }
          } else if (manifest.status === 'error') {
            if (
              matchingItem &&
              (!matchingItem.analyzeJobId || matchingItem.analyzeJobId === manifest.jobId)
            ) {
              updateQueueItem(matchingItem.id, {
                stage: 'error',
                progress: 0,
                stageDetail: stageLabel,
                errorMessage:
                  manifest.errorMessage ||
                  (analyzeTarget === 'pc'
                    ? 'Error inesperado durante el análisis en el PC.'
                    : 'Error inesperado durante el análisis en la nube.'),
                analyzeJobId: manifest.jobId,
                analyzeJobFileId: entry.jobFileId,
                analyzeJobTarget: analyzeTarget,
                analyzeJobCreatedAt: manifest.createdAt,
                analyzeJobStatus: 'error',
                analyzeJobStage: manifest.stage,
                analyzeJobProgress: manifest.progress || 0,
                analyzeJobError: manifest.errorMessage,
                cloudWorkflowRunUrl: entry.workflowRunUrl ?? matchingItem.cloudWorkflowRunUrl,
              });
            }
          }
        }

        if (newlyReadyStudioItemId) {
          onOpenStudio(newlyReadyStudioItemId);
        }
      } catch (err) {
        if (err instanceof DriveAuthExpiredError) {
          clearAuthSession();
          if (!silent) {
            onError(formatPhaseError('Drive', err.message));
          }
        } else {
          if (err instanceof DriveHttpError && isBackoffTriggerHttpStatus(err.status)) {
            const nextIntervalMs = computeNextPollBackoffMs(pollIntervalMsRef.current);
            pollIntervalMsRef.current = nextIntervalMs;
            setPollIntervalMs(nextIntervalMs);
            logWarn('Drive', 'Backoff exponencial activado en polling remoto', {
              http: err.status,
              siguienteIntervaloSeg: Math.round(nextIntervalMs / 1000),
            });
          }
          const msg = err instanceof Error ? err.message : 'No se pudo consultar _AutoCut_Jobs.';
          logError('Drive', 'Error al sincronizar trabajos remotos', { error: msg });
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
      setItems,
      updateQueueItem,
      onOpenStudio,
      clearAuthSession,
      onError,
      cleanupTempSourcesForJob,
    ]
  );

  const submitAnalyzeManifest = useCallback(
    async (params: {
      queueItemId: string;
      sourceFiles: AnalyzeJobSourceFile[];
      preset: EditStylePreset;
      instruction?: string;
      projectName?: string;
      isMultiClip: boolean;
      target: RenderJobTarget;
      token: string;
    }): Promise<AnalyzeJobManifest> => {
      const target = params.target;
      const manifest = buildAnalyzeJobManifest({
        sourceFiles: params.sourceFiles,
        model: geminiModel,
        whisperModel,
        stylePreset: params.preset,
        customInstruction: params.instruction,
        tiktokOptions,
        voiceoverBrollEnabled,
        brollDensity,
        brollSmoothPanEnabled,
        brollAmbientAudioEnabled,
        queueItemId: params.queueItemId,
        projectName: params.projectName,
        isMultiClip: params.isMultiClip,
        target,
      });

      logInfo(target === 'pc' ? 'PC' : 'Nube', 'Subiendo manifiesto de análisis a _AutoCut_Jobs', {
        jobId: manifest.jobId,
        destino: target,
        clips: manifest.sourceFiles.length,
        modelo: manifest.options.model,
        whisper: manifest.options.whisperModel,
        estilo: manifest.options.stylePreset,
      });

      const uploaded = await uploadAnalyzeJobManifest(folderId.trim(), manifest, params.token);

      const newEntry: AnalyzeJobSyncEntry = {
        manifest,
        jobFileId: uploaded.id,
        jobFileName: uploaded.name,
        modifiedTime: manifest.createdAt,
      };

      setAnalyzeJobs((prev) => [
        newEntry,
        ...prev.filter((entry) => entry.manifest.jobId !== manifest.jobId),
      ]);
      setLastPcSyncTime(Date.now());

      if (target === 'pc') {
        updateQueueItem(params.queueItemId, {
          stage: 'analyzing',
          progress: 5,
          errorMessage: undefined,
          analyzeJobId: manifest.jobId,
          analyzeJobFileId: uploaded.id,
          analyzeJobTarget: 'pc',
          analyzeJobCreatedAt: manifest.createdAt,
          analyzeJobStatus: 'pending',
          analyzeJobStage: 'descarga',
          analyzeJobProgress: 0,
          analyzeJobError: undefined,
          cloudWorkflowRunUrl: undefined,
          stageDetail: 'En cola PC (análisis)...',
        });
        return manifest;
      }

      updateQueueItem(params.queueItemId, {
        stage: 'analyzing',
        progress: 5,
        errorMessage: undefined,
        analyzeJobId: manifest.jobId,
        analyzeJobFileId: uploaded.id,
        analyzeJobTarget: 'cloud',
        analyzeJobCreatedAt: manifest.createdAt,
        analyzeJobStatus: 'pending',
        analyzeJobStage: 'descarga',
        analyzeJobProgress: 0,
        analyzeJobError: undefined,
        stageDetail: 'Nube: Enviando señal de análisis a GitHub Actions...',
      });

      try {
        await dispatchCloudRenderJob(uploaded.id);
        dispatchedAtByJobFileIdRef.current[uploaded.id] = Date.now();
        setFailedDispatchJobFileIds((prev) => {
          if (!prev[uploaded.id]) return prev;
          const next = { ...prev };
          delete next[uploaded.id];
          return next;
        });
        updateQueueItem(params.queueItemId, {
          cloudWorkflowRunUrl: undefined,
          stageDetail: 'En cola nube (análisis) · GitHub Actions disparado',
        });
      } catch (dispatchErr) {
        const dispatchMsg =
          dispatchErr instanceof Error
            ? dispatchErr.message
            : 'No se pudo disparar el workflow de GitHub Actions.';
        logError('Nube', 'Manifiesto de análisis guardado pero falló el disparo de GitHub Actions', {
          jobId: manifest.jobId,
          error: dispatchMsg,
        });
        setFailedDispatchJobFileIds((prev) => ({
          ...prev,
          [uploaded.id]: dispatchMsg,
        }));
        updateQueueItem(params.queueItemId, {
          stageDetail: 'Nube: Análisis en cola (pendiente de reintento de envío)',
        });
        onError(
          `El análisis se guardó en Drive pero falló el aviso a GitHub Actions: ${dispatchMsg}`
        );
      }

      return manifest;
    },
    [
      folderId,
      geminiModel,
      whisperModel,
      tiktokOptions,
      voiceoverBrollEnabled,
      brollDensity,
      brollSmoothPanEnabled,
      brollAmbientAudioEnabled,
      updateQueueItem,
      onError,
    ]
  );

  const sendItemToCloudAnalyze = useCallback(
    async (itemId: string): Promise<AnalyzeJobManifest | null> => {
      const target = resolveProcessTarget({ processEngine, pcOnline: isPcOnline });
      logInfo(target === 'pc' ? 'PC' : 'Nube', 'Decisión de enrutado de análisis', {
        motor: processEngine,
        pcEnLinea: isPcOnline,
        destino: target,
      });

      if (target === 'cloud' && !cloudRenderConfigured) {
        onError({
          message:
            'El análisis en la nube aún no está configurado en el servidor. Enciende el PC o consulta la guía en Ajustes.',
          actionHint: 'settings',
        });
        return null;
      }

      const token = resolveDriveToken();
      if (!token) {
        onError('Inicia sesión con Google Drive para analizar el vídeo.');
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
      if (!item) return null;

      setSendingAnalyzeId(itemId);
      setCloudUploadProgress(null);
      onError(null);

      try {
        const isMulti = Boolean(item.isMultiClip && item.sourceClips && item.sourceClips.length > 0);
        const clipCandidates: ClipUploadCandidate[] = isMulti
          ? item.sourceClips!.map((clip, idx) => ({
              index: idx,
              name: clip.originalName,
              driveFileId: clip.driveFileId,
              modifiedTime: clip.modifiedTime,
              rawBlob: clip.rawBlob,
            }))
          : [
              {
                index: 0,
                name: item.originalName,
                driveFileId: item.driveFileId,
                modifiedTime: item.modifiedTime,
                rawBlob: item.rawBlob,
              },
            ];

        updateQueueItem(itemId, {
          stage: 'analyzing',
          progress: 3,
          errorMessage: undefined,
          stageDetail:
            target === 'pc'
              ? 'Preparando clips para análisis en PC...'
              : 'Preparando clips para análisis en la nube...',
        });

        const resolvedSourceFiles = await ensureSourceFilesInDrive(clipCandidates, token);

        // Persist Drive file IDs back onto local items so render/redo won't re-upload
        if (!isMulti && !item.driveFileId && resolvedSourceFiles[0]?.driveFileId) {
          updateQueueItem(itemId, {
            driveFileId: resolvedSourceFiles[0].driveFileId,
            modifiedTime: resolvedSourceFiles[0].modifiedTime || item.modifiedTime,
          });
        } else if (isMulti && item.sourceClips) {
          const updatedClips = item.sourceClips.map((clip, idx) => ({
            ...clip,
            driveFileId: clip.driveFileId || resolvedSourceFiles[idx]?.driveFileId,
            modifiedTime: clip.modifiedTime || resolvedSourceFiles[idx]?.modifiedTime,
          }));
          updateQueueItem(itemId, { sourceClips: updatedClips });
        }

        return await submitAnalyzeManifest({
          queueItemId: itemId,
          sourceFiles: resolvedSourceFiles,
          preset: item.stylePreset || stylePreset,
          instruction: item.customInstruction ?? customInstruction,
          projectName: item.projectName,
          isMultiClip: isMulti,
          target,
          token,
        });
      } catch (err) {
        if (err instanceof DriveAuthExpiredError) {
          clearAuthSession();
          onError(formatPhaseError('Drive', err.message));
        } else {
          const msg =
            err instanceof Error
              ? err.message
              : target === 'pc'
              ? 'No se pudo lanzar el análisis en el PC.'
              : 'No se pudo lanzar el análisis en la nube.';
          logError(target === 'pc' ? 'PC' : 'Nube', 'Error al lanzar análisis remoto', {
            destino: target,
            error: msg,
          });
          updateQueueItem(itemId, {
            stage: 'error',
            progress: 0,
            errorMessage: msg,
            stageDetail:
              target === 'pc'
                ? 'Error al lanzar análisis en PC'
                : 'Error al lanzar análisis en la nube',
          });
          onError(msg);
        }
        return null;
      } finally {
        setCloudUploadProgress(null);
        setSendingAnalyzeId(null);
      }
    },
    [
      processEngine,
      isPcOnline,
      cloudRenderConfigured,
      resolveDriveToken,
      folderId,
      itemsRef,
      stylePreset,
      customInstruction,
      updateQueueItem,
      ensureSourceFilesInDrive,
      submitAnalyzeManifest,
      clearAuthSession,
      onError,
    ]
  );

  const sendMultiClipToCloudAnalyze = useCallback(
    async (
      orderedIds: string[],
      projectName: string,
      chosenPreset: EditStylePreset,
      chosenInstruction: string
    ): Promise<AnalyzeJobManifest | null> => {
      const target = resolveProcessTarget({ processEngine, pcOnline: isPcOnline });
      logInfo(target === 'pc' ? 'PC' : 'Nube', 'Decisión de enrutado de análisis Multi-Clip', {
        motor: processEngine,
        pcEnLinea: isPcOnline,
        destino: target,
      });

      if (target === 'cloud' && !cloudRenderConfigured) {
        onError({
          message:
            'El análisis en la nube aún no está configurado en el servidor. Enciende el PC o consulta la guía en Ajustes.',
          actionHint: 'settings',
        });
        return null;
      }

      const token = resolveDriveToken();
      if (!token) {
        onError('Inicia sesión con Google Drive para analizar los clips.');
        return null;
      }
      if (!folderId.trim()) {
        onError({
          message: 'Configura primero el ID de tu carpeta de Google Drive en Ajustes.',
          actionHint: 'settings',
        });
        return null;
      }

      const orderedItems = orderedIds
        .map((id) => itemsRef.current.find((i) => i.id === id))
        .filter((i): i is QueueItem => Boolean(i));

      if (orderedItems.length < 2) return null;

      const missingSource = orderedItems.find((clip) => !clip.driveFileId && !clip.rawBlob);
      if (missingSource) {
        onCloseMultiClipModal?.();
        onError(
          'Los clips de ejemplo no contienen archivo real para enviar al motor remoto. Selecciona 2 o más vídeos de Google Drive o subidos desde tu móvil/PC.'
        );
        return null;
      }

      onCloseMultiClipModal?.();
      onClearCombineSelection?.();
      onError(null);

      const combinedId = `multiclip-${Date.now()}`;
      const displayName = projectName.trim()
        ? `${projectName.trim()} (${orderedItems.length} clips)`
        : `${orderedItems[0].originalName} + ${orderedItems.length - 1} más`;

      const initialSourceClips: SourceClipRef[] = orderedItems.map((clip) => ({
        id: clip.id,
        source: clip.source,
        driveFileId: clip.driveFileId,
        modifiedTime: clip.modifiedTime,
        originalName: clip.originalName,
        mimeType: clip.mimeType,
        sizeBytes: clip.sizeBytes,
        durationSec: clip.durationSec,
        rawBlob: clip.rawBlob,
        rawUrl: clip.rawUrl,
      }));

      const totalSizeBytes = initialSourceClips.reduce((sum, c) => sum + c.sizeBytes, 0);

      const combinedItem: QueueItem = {
        id: combinedId,
        source: initialSourceClips.some((c) => c.source === 'drive') ? 'drive' : 'local',
        isMultiClip: true,
        projectName: projectName.trim() || undefined,
        originalName: displayName,
        mimeType: 'video/mp4',
        sizeBytes: totalSizeBytes,
        stage: 'analyzing',
        stageDetail:
          target === 'pc'
            ? `Preparando ${orderedItems.length} clips para análisis en PC...`
            : `Preparando ${orderedItems.length} clips para análisis en la nube...`,
        progress: 3,
        sourceClips: initialSourceClips,
        stylePreset: chosenPreset,
        customInstruction: chosenInstruction.trim() || undefined,
        exportQuality,
        lastUpdated: Date.now(),
      };

      setItems((prev) => [combinedItem, ...prev]);
      setSendingAnalyzeId(combinedId);
      setCloudUploadProgress(null);

      try {
        const clipCandidates: ClipUploadCandidate[] = initialSourceClips.map((clip, idx) => ({
          index: idx,
          name: clip.originalName,
          driveFileId: clip.driveFileId,
          modifiedTime: clip.modifiedTime,
          rawBlob: clip.rawBlob,
        }));

        const resolvedSourceFiles = await ensureSourceFilesInDrive(clipCandidates, token);

        // Persist any newly uploaded Drive IDs back onto sourceClips for render / redo
        const hydratedSourceClips = initialSourceClips.map((clip, idx) => ({
          ...clip,
          driveFileId: clip.driveFileId || resolvedSourceFiles[idx]?.driveFileId,
          modifiedTime: clip.modifiedTime || resolvedSourceFiles[idx]?.modifiedTime,
        }));
        updateQueueItem(combinedId, { sourceClips: hydratedSourceClips });

        return await submitAnalyzeManifest({
          queueItemId: combinedId,
          sourceFiles: resolvedSourceFiles,
          preset: chosenPreset,
          instruction: chosenInstruction.trim(),
          projectName: projectName.trim() || undefined,
          isMultiClip: true,
          target,
          token,
        });
      } catch (err) {
        if (err instanceof DriveAuthExpiredError) {
          clearAuthSession();
          onError(formatPhaseError('Drive', err.message));
        } else {
          const msg =
            err instanceof Error
              ? err.message
              : 'No se pudo lanzar el análisis Multi-Clip.';
          logError(target === 'pc' ? 'PC' : 'Nube', 'Error al lanzar análisis Multi-Clip', {
            destino: target,
            error: msg,
          });
          updateQueueItem(combinedId, {
            stage: 'error',
            progress: 0,
            errorMessage: msg,
            stageDetail:
              target === 'pc'
                ? 'Error al lanzar análisis en PC'
                : 'Error al lanzar análisis en la nube',
          });
          onError(msg);
        }
        return null;
      } finally {
        setCloudUploadProgress(null);
        setSendingAnalyzeId(null);
      }
    },
    [
      processEngine,
      isPcOnline,
      cloudRenderConfigured,
      resolveDriveToken,
      folderId,
      itemsRef,
      exportQuality,
      setItems,
      updateQueueItem,
      onCloseMultiClipModal,
      onClearCombineSelection,
      ensureSourceFilesInDrive,
      submitAnalyzeManifest,
      clearAuthSession,
      onError,
    ]
  );

  const redoCloudStory = useCallback(
    async (itemId: string, newInstruction: string): Promise<AnalyzeJobManifest | null> => {
      const target = resolveProcessTarget({ processEngine, pcOnline: isPcOnline });
      logInfo(target === 'pc' ? 'PC' : 'Nube', 'Decisión de enrutado para rehacer historia', {
        motor: processEngine,
        pcEnLinea: isPcOnline,
        destino: target,
      });

      if (target === 'cloud' && !cloudRenderConfigured) {
        onError({
          message:
            'El análisis en la nube aún no está configurado en el servidor. Enciende el PC o consulta la guía en Ajustes.',
          actionHint: 'settings',
        });
        return null;
      }

      const token = resolveDriveToken();
      if (!token) {
        onError('Inicia sesión con Google Drive para rehacer la historia.');
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
      if (!item) return null;

      setSendingAnalyzeId(itemId);
      setCloudUploadProgress(null);
      onError(null);

      try {
        const isMulti = Boolean(item.isMultiClip && item.sourceClips && item.sourceClips.length > 0);
        const clipCandidates: ClipUploadCandidate[] = isMulti
          ? item.sourceClips!.map((clip, idx) => ({
              index: idx,
              name: clip.originalName,
              driveFileId: clip.driveFileId,
              modifiedTime: clip.modifiedTime,
              rawBlob: clip.rawBlob,
            }))
          : [
              {
                index: 0,
                name: item.originalName,
                driveFileId: item.driveFileId,
                modifiedTime: item.modifiedTime,
                rawBlob: item.rawBlob,
              },
            ];

        const resolvedSourceFiles = await ensureSourceFilesInDrive(clipCandidates, token);
        const trimmedInstruction = newInstruction.trim();

        updateQueueItem(itemId, {
          customInstruction: trimmedInstruction || undefined,
          stage: 'analyzing',
          progress: 5,
          stageDetail:
            target === 'pc'
              ? 'Rehaciendo historia en PC (reutilizando transcripción)...'
              : 'Rehaciendo historia en la nube (reutilizando transcripción)...',
        });

        return await submitAnalyzeManifest({
          queueItemId: itemId,
          sourceFiles: resolvedSourceFiles,
          preset: item.stylePreset || stylePreset,
          instruction: trimmedInstruction,
          projectName: item.projectName,
          isMultiClip: isMulti,
          target,
          token,
        });
      } catch (err) {
        if (err instanceof DriveAuthExpiredError) {
          clearAuthSession();
          onError(formatPhaseError('Drive', err.message));
        } else {
          const msg =
            err instanceof Error
              ? err.message
              : 'No se pudo relanzar la historia.';
          logError(target === 'pc' ? 'PC' : 'Nube', 'Error al rehacer historia', {
            destino: target,
            error: msg,
          });
          onError(msg);
        }
        return null;
      } finally {
        setCloudUploadProgress(null);
        setSendingAnalyzeId(null);
      }
    },
    [
      processEngine,
      isPcOnline,
      cloudRenderConfigured,
      resolveDriveToken,
      folderId,
      itemsRef,
      stylePreset,
      updateQueueItem,
      ensureSourceFilesInDrive,
      submitAnalyzeManifest,
      clearAuthSession,
      onError,
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
        logWarn('PC', 'Intento de envío a PC con vídeo de demostración');
      }

      setSendingToPcId(itemId);
      setSendingTarget('pc');
      setCloudUploadProgress(null);
      onError(null);

      try {
        let sourceFilesOverride: RenderJobSourceFile[] | undefined;
        if (item.source !== 'demo') {
          const isMulti = Boolean(
            item.isMultiClip && item.sourceClips && item.sourceClips.length > 0
          );
          const clipCandidates: ClipUploadCandidate[] = isMulti
            ? item.sourceClips!.map((clip, idx) => ({
                index: idx,
                name: clip.originalName,
                driveFileId: clip.driveFileId,
                modifiedTime: clip.modifiedTime,
                rawBlob: clip.rawBlob,
              }))
            : [
                {
                  index: 0,
                  name: item.originalName,
                  driveFileId: item.driveFileId,
                  modifiedTime: item.modifiedTime,
                  rawBlob: item.rawBlob,
                },
              ];

          if (clipCandidates.some((c) => !c.driveFileId && Boolean(c.rawBlob))) {
            const uploadedSources = await ensureSourceFilesInDrive(clipCandidates, token);
            sourceFilesOverride = uploadedSources.map((s) => ({
              name: s.name,
              driveFileId: s.driveFileId,
              ...(s.uploadedTempSource ? { uploadedTempSource: true } : {}),
            }));
          }
        }

        const manifest = buildRenderJobManifest({
          item,
          exportQuality,
          tiktokOptions,
          voiceoverBrollEnabled,
          brollDensity,
          brollSmoothPanEnabled,
          brollAmbientAudioEnabled,
          target: 'pc',
          sourceFilesOverride,
        });

        logInfo('PC', 'Enviando manifiesto de render a PC (sin descargar bruto en móvil)', {
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
          pcJobCreatedAt: manifest.createdAt,
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
          logError('PC', 'Fallo al enviar trabajo de render a PC', { error: msg });
          onError(formatPhaseError('Drive', msg));
        }
        return null;
      } finally {
        setCloudUploadProgress(null);
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
      voiceoverBrollEnabled,
      brollDensity,
      brollSmoothPanEnabled,
      brollAmbientAudioEnabled,
      ensureSourceFilesInDrive,
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
        const clipCandidates: ClipUploadCandidate[] = isMulti
          ? item.sourceClips!.map((clip, idx) => ({
              index: idx,
              name: clip.originalName,
              driveFileId: clip.driveFileId,
              modifiedTime: clip.modifiedTime,
              rawBlob: clip.rawBlob,
            }))
          : [
              {
                index: 0,
                name: item.originalName,
                driveFileId: item.driveFileId,
                modifiedTime: item.modifiedTime,
                rawBlob: item.rawBlob,
              },
            ];

        const uploadedSources = await ensureSourceFilesInDrive(clipCandidates, token);
        const resolvedSourceFiles: RenderJobSourceFile[] = uploadedSources.map((s) => ({
          name: s.name,
          driveFileId: s.driveFileId,
          ...(s.uploadedTempSource ? { uploadedTempSource: true } : {}),
        }));

        const manifest = buildRenderJobManifest({
          item,
          exportQuality,
          tiktokOptions,
          voiceoverBrollEnabled,
          brollDensity,
          brollSmoothPanEnabled,
          brollAmbientAudioEnabled,
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
          pcJobCreatedAt: manifest.createdAt,
          pcJobStatus: 'pending',
          pcJobProgress: 0,
          pcJobError: undefined,
          outputFileName: manifest.outputFileName,
          stageDetail: 'Nube: Enviando señal a GitHub Actions...',
        });

        try {
          await dispatchCloudRenderJob(uploaded.id);
          dispatchedAtByJobFileIdRef.current[uploaded.id] = Date.now();
          setFailedDispatchJobFileIds((prev) => {
            if (!prev[uploaded.id]) return prev;
            const next = { ...prev };
            delete next[uploaded.id];
            return next;
          });
          updateQueueItem(itemId, {
            cloudWorkflowRunUrl: undefined,
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
      voiceoverBrollEnabled,
      brollDensity,
      brollSmoothPanEnabled,
      brollAmbientAudioEnabled,
      ensureSourceFilesInDrive,
      updateQueueItem,
      clearAuthSession,
      onError,
    ]
  );

  const sendItemToRender = useCallback(
    async (itemId: string): Promise<RenderJobManifest | null> => {
      const target = resolveProcessTarget({ processEngine, pcOnline: isPcOnline });
      logInfo(target === 'pc' ? 'PC' : 'Nube', 'Decisión de enrutado de render', {
        motor: processEngine,
        pcEnLinea: isPcOnline,
        destino: target,
      });
      if (target === 'pc') {
        return sendItemToPc(itemId);
      }
      return sendItemToCloud(itemId);
    },
    [processEngine, isPcOnline, sendItemToPc, sendItemToCloud]
  );

  const fallbackPcJobToCloud = useCallback(
    async (jobFileId: string, kind: 'render' | 'analyze'): Promise<boolean> => {
      if (!cloudRenderConfigured) {
        onError({
          message:
            'El respaldo en la nube no está configurado en el servidor. Revisa Ajustes.',
          actionHint: 'settings',
        });
        return false;
      }

      const token = resolveDriveToken();
      if (!token) {
        onError('Inicia sesión con Google Drive para redirigir el trabajo a la nube.');
        return false;
      }

      setFallingBackJobFileId(jobFileId);
      onError(null);

      try {
        if (kind === 'analyze') {
          const entry = analyzeJobs.find((j) => j.jobFileId === jobFileId);
          if (!entry) {
            throw new Error('No se encontró el trabajo de análisis pendiente.');
          }
          const updatedManifest: AnalyzeJobManifest = {
            ...entry.manifest,
            target: 'cloud',
            status: 'pending',
            progress: 0,
            errorMessage: undefined,
            updatedAt: new Date().toISOString(),
          };
          await patchDriveJsonFile(jobFileId, updatedManifest, token);
          await dispatchCloudRenderJob(jobFileId);
          dispatchedAtByJobFileIdRef.current[jobFileId] = Date.now();
          delete cloudWorkflowFailuresRef.current[jobFileId];

          logInfo('Nube', 'Análisis PC redirigido a la nube (fallback manual)', {
            jobId: entry.manifest.jobId,
          });

          setAnalyzeJobs((prev) =>
            prev.map((j) =>
              j.jobFileId !== jobFileId
                ? j
                : { ...j, manifest: updatedManifest, workflowRunUrl: undefined }
            )
          );

          const matchingItem = itemsRef.current.find(
            (it) =>
              it.analyzeJobFileId === jobFileId ||
              it.analyzeJobId === entry.manifest.jobId ||
              (entry.manifest.queueItemId && it.id === entry.manifest.queueItemId)
          );
          if (matchingItem) {
            updateQueueItem(matchingItem.id, {
              stage: 'analyzing',
              progress: 5,
              analyzeJobTarget: 'cloud',
              analyzeJobStatus: 'pending',
              analyzeJobProgress: 0,
              analyzeJobError: undefined,
              cloudWorkflowRunUrl: undefined,
              stageDetail: 'En cola nube (análisis) · Redirigido desde PC',
            });
          }
          return true;
        }

        const entry = pcJobs.find((j) => j.jobFileId === jobFileId);
        if (!entry) {
          throw new Error('No se encontró el trabajo de render pendiente.');
        }
        const updatedManifest: RenderJobManifest = {
          ...entry.manifest,
          target: 'cloud',
          status: 'pending',
          progress: 0,
          errorMessage: undefined,
          updatedAt: new Date().toISOString(),
        };
        await patchDriveJsonFile(jobFileId, updatedManifest, token);
        await dispatchCloudRenderJob(jobFileId);
        dispatchedAtByJobFileIdRef.current[jobFileId] = Date.now();
        delete cloudWorkflowFailuresRef.current[jobFileId];

        logInfo('Nube', 'Render PC redirigido a la nube (fallback manual)', {
          jobId: entry.manifest.jobId,
        });

        setPcJobs((prev) =>
          prev.map((j) =>
            j.jobFileId !== jobFileId
              ? j
              : { ...j, manifest: updatedManifest, workflowRunUrl: undefined }
          )
        );

        const matchingItem = itemsRef.current.find(
          (it) =>
            it.pcJobFileId === jobFileId ||
            it.pcJobId === entry.manifest.jobId ||
            (entry.manifest.queueItemId && it.id === entry.manifest.queueItemId)
        );
        if (matchingItem) {
          updateQueueItem(matchingItem.id, {
            pcJobTarget: 'cloud',
            pcJobStatus: 'pending',
            pcJobProgress: 0,
            pcJobError: undefined,
            cloudWorkflowRunUrl: undefined,
            stageDetail: 'Nube: En cola nube · Redirigido desde PC',
          });
        }
        if (lastSentPcJob?.jobFileId === jobFileId) {
          setLastSentPcJob((prev) => (prev ? { ...prev, target: 'cloud' } : null));
        }
        return true;
      } catch (err) {
        if (err instanceof DriveAuthExpiredError) {
          clearAuthSession();
          onError(formatPhaseError('Drive', err.message));
        } else {
          const msg =
            err instanceof Error
              ? err.message
              : 'No se pudo redirigir el trabajo a GitHub Actions.';
          logError('Nube', 'Error al redirigir trabajo PC a la nube', { error: msg });
          onError(msg);
        }
        return false;
      } finally {
        setFallingBackJobFileId(null);
      }
    },
    [
      cloudRenderConfigured,
      resolveDriveToken,
      analyzeJobs,
      pcJobs,
      itemsRef,
      updateQueueItem,
      lastSentPcJob?.jobFileId,
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
        delete cloudWorkflowFailuresRef.current[jobFileId];
        autoRetriedJobIdsRef.current.delete(jobFileId);
        dispatchedAtByJobFileIdRef.current[jobFileId] = Date.now();

        setFailedDispatchJobFileIds((prev) => {
          if (!prev[jobFileId]) return prev;
          const next = { ...prev };
          delete next[jobFileId];
          return next;
        });

        setPcJobs((prev) =>
          prev.map((entry) =>
            entry.jobFileId !== jobFileId
              ? entry
              : {
                  ...entry,
                  workflowRunUrl: undefined,
                  manifest: {
                    ...entry.manifest,
                    status: 'pending',
                    progress: 0,
                    errorMessage: undefined,
                  },
                }
          )
        );

        setAnalyzeJobs((prev) =>
          prev.map((entry) =>
            entry.jobFileId !== jobFileId
              ? entry
              : {
                  ...entry,
                  workflowRunUrl: undefined,
                  manifest: {
                    ...entry.manifest,
                    status: 'pending',
                    progress: 0,
                    errorMessage: undefined,
                  },
                }
          )
        );

        const matchingRenderEntry = pcJobs.find((j) => j.jobFileId === jobFileId);
        if (matchingRenderEntry) {
          const matchingItem = itemsRef.current.find(
            (it) =>
              it.pcJobFileId === jobFileId ||
              it.pcJobId === matchingRenderEntry.manifest.jobId ||
              (matchingRenderEntry.manifest.queueItemId &&
                it.id === matchingRenderEntry.manifest.queueItemId)
          );
          if (matchingItem) {
            updateQueueItem(matchingItem.id, {
              pcJobStatus: 'pending',
              pcJobProgress: 0,
              pcJobError: undefined,
              cloudWorkflowRunUrl: undefined,
              stageDetail: 'Nube: En cola nube · Reenvío a GitHub Actions aceptado',
            });
          }
        }

        const matchingAnalyzeEntry = analyzeJobs.find((j) => j.jobFileId === jobFileId);
        if (matchingAnalyzeEntry) {
          const matchingItem = itemsRef.current.find(
            (it) =>
              it.analyzeJobFileId === jobFileId ||
              it.analyzeJobId === matchingAnalyzeEntry.manifest.jobId ||
              (matchingAnalyzeEntry.manifest.queueItemId &&
                it.id === matchingAnalyzeEntry.manifest.queueItemId)
          );
          if (matchingItem) {
            updateQueueItem(matchingItem.id, {
              stage: 'analyzing',
              progress: 5,
              errorMessage: undefined,
              analyzeJobStatus: 'pending',
              analyzeJobProgress: 0,
              analyzeJobError: undefined,
              cloudWorkflowRunUrl: undefined,
              stageDetail: 'En cola nube (análisis) · Reenvío aceptado',
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
    [cloudRenderConfigured, pcJobs, analyzeJobs, itemsRef, updateQueueItem, onError]
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

  // Always keep latest syncPcJobs reference without re-triggering effects on re-renders
  syncPcJobsRef.current = syncPcJobs;

  // Initial silent sync ONLY when Drive connection or folderId actually changes
  useEffect(() => {
    if (!isDriveConnected || !trimmedFolderId) return;
    void syncPcJobsRef.current(true);
  }, [isDriveConnected, trimmedFolderId]);

  // Single active polling interval via RemoteJobsPoller ref + stable primitive deps.
  // Polls ONLY while pending/processing jobs exist AND tab is visible; backs off on 429/5xx.
  const shouldPollRemoteJobs = Boolean(
    isDriveConnected && trimmedFolderId && hasActivePcJobs && isPageVisible
  );

  useEffect(() => {
    if (!pollerRef.current) {
      pollerRef.current = new RemoteJobsPoller();
    }
    pollerRef.current.update({
      shouldPoll: shouldPollRemoteJobs,
      intervalMs: pollIntervalMs,
      onTick: () => {
        void syncPcJobsRef.current(true);
      },
    });
  }, [shouldPollRemoteJobs, pollIntervalMs]);

  useEffect(() => {
    return () => {
      pollerRef.current?.dispose();
    };
  }, []);

  return {
    pcJobs,
    analyzeJobs,
    pcOutputs,
    pcWorkerStatus,
    isPcOnline,
    resolvedTarget,
    isSyncingPcJobs,
    lastPcSyncTime,
    sendingToPcId,
    sendingTarget,
    sendingAnalyzeId,
    cloudUploadProgress,
    lastSentPcJob,
    failedDispatchJobFileIds,
    retryingDispatchJobFileId,
    fallingBackJobFileId,
    downloadingOutputId,
    pcOutputPreviewUrls,
    hasActivePcJobs,
    sendItemToRender,
    sendItemToPc,
    sendItemToCloud,
    sendItemToCloudAnalyze,
    sendMultiClipToCloudAnalyze,
    redoCloudStory,
    retryCloudDispatch,
    fallbackPcJobToCloud,
    syncPcJobs,
    downloadPcOutputVideo,
  };
}
