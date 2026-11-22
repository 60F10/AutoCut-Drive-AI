import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ActiveView,
  AnalyticsRecord,
  AppErrorBanner,
  AppSettings,
  EditStylePreset,
  PendingDriveUpload,
  QueueItem,
  SourceClipRef,
  TikTokEditOptions,
} from '../types';
import {
  buildCombinedEditedFilename,
  buildEditedFilename,
  detectPendingVideos,
  evaluateHeavyVideoWarning,
  formatPhaseError,
  isSupportedVideoFile,
  mergeMultiClipEditPlans,
  parseHumanReadableApiError,
  type ErrorPhase,
} from '../utils/videoPipeline';
import { createDemoAnalyticsRecords, createDemoQueueItems } from '../utils/demoData';
import { getCachedDriveToken } from '../services/googleAuth';
import {
  DriveAuthExpiredError,
  downloadDriveVideo,
  listDriveFolderFiles,
  uploadEditedVideoMultipart,
} from '../services/driveApi';
import {
  GeminiClientError,
  analyzeVideoWithGemini,
} from '../services/geminiClient';
import { inspectVideoMetadata } from '../services/ffmpegService';
import {
  clearAllEditedVideoBlobs,
  deleteEditedVideoBlob,
  getEditedVideoBlob,
  saveEditedVideoBlob,
} from '../services/videoStorage';
import { logError, logInfo } from '../services/debugLogger';

const ANALYTICS_STORAGE_KEY = 'autocut_drive_ai_analytics_v1';
const GALLERY_ITEMS_STORAGE_KEY = 'autocut_drive_ai_gallery_items_v1';

function loadInitialAnalytics(): AnalyticsRecord[] {
  try {
    const raw = window.localStorage.getItem(ANALYTICS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as AnalyticsRecord[]) : [];
  } catch {
    return [];
  }
}

function serializeCompletedItems(items: QueueItem[]): QueueItem[] {
  return items
    .filter((item) => item.stage === 'completed' && Boolean(item.analysis) && item.source !== 'demo')
    .slice(0, 40)
    .map((item) => ({
      ...item,
      rawBlob: undefined,
      rawUrl: undefined,
      editedBlob: undefined,
      editedUrl: undefined,
      sourceClips: item.sourceClips?.map((clip) => ({
        ...clip,
        rawBlob: undefined,
        rawUrl: undefined,
      })),
    }));
}

function loadPersistedGalleryItems(): QueueItem[] {
  try {
    const raw = window.localStorage.getItem(GALLERY_ITEMS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return (parsed as QueueItem[]).filter(
      (item) => item && typeof item.id === 'string' && Boolean(item.analysis)
    );
  } catch {
    return [];
  }
}

interface UseVideoQueueOptions {
  settings: AppSettings;
  persistSettings: (next: AppSettings) => void;
  stylePreset: EditStylePreset;
  customInstruction: string;
  tiktokOptions: TikTokEditOptions;
  accessToken: string | null;
  cloudRenderConfigured?: boolean;
  clearAuthSession: () => void;
  refreshCacheStats: () => Promise<void>;
  onError: (error: string | AppErrorBanner | null) => void;
  onNavigateView: (view: ActiveView) => void;
  onSelectStudioItem: (itemId: string) => void;
}

export function useVideoQueue({
  settings,
  persistSettings,
  stylePreset,
  customInstruction,
  tiktokOptions,
  accessToken,
  cloudRenderConfigured = false,
  clearAuthSession,
  refreshCacheStats,
  onError,
  onNavigateView,
  onSelectStudioItem,
}: UseVideoQueueOptions) {
  const [items, setItems] = useState<QueueItem[]>(loadPersistedGalleryItems);
  const [analyticsRecords, setAnalyticsRecords] = useState<AnalyticsRecord[]>(loadInitialAnalytics);
  const [selectedForCombine, setSelectedForCombine] = useState<string[]>([]);
  const [multiClipModalOpen, setMultiClipModalOpen] = useState(false);
  const [alreadyEditedCount, setAlreadyEditedCount] = useState(0);
  const [lastScanTime, setLastScanTime] = useState<number | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [isProcessingAny, setIsProcessingAny] = useState(false);
  const [isClearingCache, setIsClearingCache] = useState(false);
  const [restoringDriveId, setRestoringDriveId] = useState<string | null>(null);
  const [pendingDriveUpload, setPendingDriveUpload] = useState<PendingDriveUpload | null>(null);
  const [isUploadingToDrive, setIsUploadingToDrive] = useState(false);
  const [nextScanCountdownSec, setNextScanCountdownSec] = useState<number | null>(null);
  const [heavyVideoWarning, setHeavyVideoWarning] = useState<string | null>(null);

  const itemsRef = useRef(items);
  itemsRef.current = items;

  // Rehydrate cached MP4 Blobs from IndexedDB on startup so Gallery survives reloads
  useEffect(() => {
    let cancelled = false;
    const initialPersisted = itemsRef.current.filter(
      (item) => item.stage === 'completed' && !item.editedUrl && item.source !== 'demo'
    );

    const hydrate = async () => {
      if (initialPersisted.length > 0) {
        const hydratedPairs = await Promise.all(
          initialPersisted.map(async (item) => {
            const stored = await getEditedVideoBlob(item.id);
            return { id: item.id, stored };
          })
        );

        if (!cancelled) {
          const map = new Map(hydratedPairs.map((pair) => [pair.id, pair.stored]));
          setItems((prev) =>
            prev.map((item) => {
              if (!map.has(item.id)) return item;
              const stored = map.get(item.id);
              if (!stored?.blob) {
                return { ...item, cachedInIndexedDb: false };
              }
              const blobUrl = URL.createObjectURL(stored.blob);
              return {
                ...item,
                editedBlob: stored.blob,
                editedUrl: blobUrl,
                editedSizeBytes: stored.sizeBytes || stored.blob.size,
                cachedInIndexedDb: true,
              };
            })
          );
        }
      }
      if (!cancelled) {
        await refreshCacheStats();
      }
    };

    hydrate();
    return () => {
      cancelled = true;
    };
  }, [refreshCacheStats]);

  // Persist completed real items' metadata to localStorage whenever items change
  useEffect(() => {
    try {
      const serializable = serializeCompletedItems(items);
      window.localStorage.setItem(GALLERY_ITEMS_STORAGE_KEY, JSON.stringify(serializable));
    } catch {
      // Ignore storage quota errors
    }
  }, [items]);

  const updateQueueItem = useCallback((itemId: string, patch: Partial<QueueItem>) => {
    setItems((prev) =>
      prev.map((item) =>
        item.id === itemId ? { ...item, ...patch, lastUpdated: Date.now() } : item
      )
    );
  }, []);

  const cacheEditedVideo = useCallback(
    async (itemId: string, blob: Blob, fileName: string) => {
      const { evictedIds } = await saveEditedVideoBlob(itemId, blob, fileName);
      if (evictedIds.length > 0) {
        const evictedSet = new Set(evictedIds);
        setItems((prev) =>
          prev.map((item) => {
            if (!evictedSet.has(item.id)) return item;
            if (item.editedUrl) URL.revokeObjectURL(item.editedUrl);
            return {
              ...item,
              editedBlob: undefined,
              editedUrl: undefined,
              cachedInIndexedDb: false,
            };
          })
        );
      }
      await refreshCacheStats();
    },
    [refreshCacheStats]
  );

  const handleClearVideoCache = useCallback(async () => {
    setIsClearingCache(true);
    try {
      await clearAllEditedVideoBlobs();
      setItems((prev) =>
        prev.map((item) => {
          if (!item.cachedInIndexedDb && !item.editedBlob) return item;
          if (item.editedUrl) URL.revokeObjectURL(item.editedUrl);
          return {
            ...item,
            editedBlob: undefined,
            editedUrl: undefined,
            cachedInIndexedDb: false,
          };
        })
      );
      await refreshCacheStats();
    } finally {
      setIsClearingCache(false);
    }
  }, [refreshCacheStats]);

  const appendAnalyticsRecord = useCallback((record: AnalyticsRecord) => {
    setAnalyticsRecords((prev) => {
      const next = [...prev.filter((r) => r.id !== record.id), record].slice(-120);
      try {
        window.localStorage.setItem(ANALYTICS_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Ignore storage quota errors
      }
      return next;
    });
  }, []);

  const maybePromptDriveUpload = useCallback(
    (itemId: string, fileName: string, sizeBytes: number) => {
      const canUpload = Boolean(
        (accessToken || getCachedDriveToken()) && settings.folderId && settings.autoUploadEnabled
      );
      if (canUpload) {
        setPendingDriveUpload({
          itemId,
          fileName,
          folderId: settings.folderId,
          sizeBytes,
        });
      }
    },
    [accessToken, settings.folderId, settings.autoUploadEnabled]
  );

  const handleDownloadFromDrive = useCallback(
    async (itemId: string) => {
      const target = itemsRef.current.find((i) => i.id === itemId);
      if (!target?.uploadedDriveId) return;

      const token = accessToken || getCachedDriveToken();
      if (!token) {
        onError('Inicia sesión con Google Drive para descargar este vídeo.');
        return;
      }

      onError(null);
      setRestoringDriveId(itemId);
      try {
        const blob = await downloadDriveVideo(
          target.uploadedDriveId,
          token,
          target.editedSizeBytes || target.sizeBytes
        );
        const editedUrl = URL.createObjectURL(blob);
        const fileName = target.outputFileName || `${target.originalName}_EDITADO.mp4`;
        setItems((prev) =>
          prev.map((item) => {
            if (item.id !== itemId) return item;
            if (item.editedUrl) URL.revokeObjectURL(item.editedUrl);
            return {
              ...item,
              editedBlob: blob,
              editedUrl,
              editedSizeBytes: blob.size,
              cachedInIndexedDb: true,
              lastUpdated: Date.now(),
            };
          })
        );
        await cacheEditedVideo(itemId, blob, fileName);
      } catch (err) {
        if (err instanceof DriveAuthExpiredError) {
          clearAuthSession();
        }
        onError(
          formatPhaseError(
            'Drive',
            err instanceof Error
              ? err.message
              : 'No se pudo recuperar el vídeo desde Google Drive.'
          )
        );
      } finally {
        setRestoringDriveId(null);
      }
    },
    [accessToken, cacheEditedVideo, clearAuthSession, onError]
  );

  const handleScanFolder = useCallback(async () => {
    onError(null);
    const token = accessToken || getCachedDriveToken();
    if (!token) {
      onError(formatPhaseError('Drive', 'Inicia sesión con Google Drive antes de escanear una carpeta.'));
      return;
    }
    if (!settings.folderId) {
      onError(formatPhaseError('Drive', 'Configura el ID de tu carpeta de Google Drive en Ajustes.'));
      onNavigateView('settings');
      return;
    }

    setIsScanning(true);
    logInfo('Drive', 'Escaneando carpeta de Google Drive');
    try {
      const files = await listDriveFolderFiles(settings.folderId, token);
      const { pending, alreadyEditedSources } = detectPendingVideos(files);
      setAlreadyEditedCount(alreadyEditedSources.length);
      setLastScanTime(Date.now());
      logInfo('Drive', 'Escaneo completado', {
        pendientes: pending.length,
        yaEditados: alreadyEditedSources.length,
        totalDrive: files.length,
      });

      setItems((prev) => {
        const existingDriveIds = new Set(
          prev.filter((i) => i.driveFileId).map((i) => i.driveFileId as string)
        );
        const newlyDetected: QueueItem[] = pending
          .filter((file) => !existingDriveIds.has(file.id))
          .map((file) => ({
            id: `drive-${file.id}`,
            source: 'drive',
            driveFileId: file.id,
            originalName: file.name,
            mimeType: file.mimeType || 'video/mp4',
            sizeBytes: Number(file.size) || 0,
            modifiedTime: file.modifiedTime,
            stage: 'pending',
            stageDetail: 'Detectado en Google Drive sin versión _EDITADO',
            progress: 0,
            lastUpdated: Date.now(),
          }));
        return [...newlyDetected, ...prev];
      });
    } catch (err) {
      if (err instanceof DriveAuthExpiredError) {
        clearAuthSession();
      }
      logError('Drive', 'Error al escanear carpeta de Drive', undefined, err);
      onError(
        formatPhaseError(
          'Drive',
          err instanceof Error ? err.message : 'No se pudo escanear la carpeta de Google Drive.'
        )
      );
    } finally {
      setIsScanning(false);
    }
  }, [accessToken, settings.folderId, clearAuthSession, onError, onNavigateView]);

  // Automatic folder watch timer when enabled (tab open)
  useEffect(() => {
    if (!settings.autoWatchEnabled || !settings.folderId || !accessToken) {
      setNextScanCountdownSec(null);
      return;
    }

    let remaining = settings.watchIntervalSec;
    setNextScanCountdownSec(remaining);

    const tick = window.setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        remaining = settings.watchIntervalSec;
        if (!isScanning && !isProcessingAny) {
          handleScanFolder();
        }
      }
      setNextScanCountdownSec(remaining);
    }, 1000);

    return () => window.clearInterval(tick);
  }, [
    settings.autoWatchEnabled,
    settings.folderId,
    settings.watchIntervalSec,
    accessToken,
    isScanning,
    isProcessingAny,
    handleScanFolder,
  ]);

  const handleToggleAutoWatch = useCallback(() => {
    if (!settings.autoWatchEnabled && !settings.folderId) {
      onError('Configura el ID de carpeta en Ajustes para activar la vigilancia automática.');
      onNavigateView('settings');
      return;
    }
    persistSettings({
      ...settings,
      autoWatchEnabled: !settings.autoWatchEnabled,
    });
  }, [settings, persistSettings, onError, onNavigateView]);

  const handleAddLocalFiles = useCallback(
    (fileList: FileList) => {
      onError(null);
      const added: QueueItem[] = [];

      Array.from(fileList).forEach((file) => {
        if (!isSupportedVideoFile(file.name, file.type)) return;
        const rawUrl = URL.createObjectURL(file);
        added.push({
          id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          source: 'local',
          originalName: file.name,
          mimeType: file.type || 'video/mp4',
          sizeBytes: file.size,
          modifiedTime: new Date(file.lastModified).toISOString(),
          stage: 'pending',
          stageDetail: 'Vídeo local listo para analizar o combinar en Multi-Clip',
          progress: 0,
          rawBlob: file,
          rawUrl,
          lastUpdated: Date.now(),
        });
      });

      if (added.length === 0) {
        onError(
          'Selecciona archivos de vídeo válidos desde tu dispositivo (.mp4, .mov, .webm).'
        );
        return;
      }

      setItems((prev) => [...added, ...prev]);
      const totalAddedMb = Number(
        (added.reduce((sum, f) => sum + f.sizeBytes, 0) / (1024 * 1024)).toFixed(2)
      );
      logInfo('UI', 'Vídeos locales añadidos a la cola', {
        cantidad: added.length,
        pesoTotalMB: totalAddedMb,
        primero: added[0]?.originalName,
      });

      // Inspect resolution & duration asynchronously to warn early about heavy/4K files
      const activeRenderTarget = cloudRenderConfigured ? 'cloud' : 'mobile';
      added.forEach((entry) => {
        if (!entry.rawBlob) return;
        const quickCheck = evaluateHeavyVideoWarning({
          sizeBytes: entry.sizeBytes,
          renderTarget: activeRenderTarget,
        });
        if (quickCheck.isHeavy && quickCheck.message) {
          setHeavyVideoWarning(`${entry.originalName}: ${quickCheck.message}`);
        }

        inspectVideoMetadata(entry.rawBlob).then((meta) => {
          if (meta.durationSec > 0) {
            updateQueueItem(entry.id, { durationSec: meta.durationSec });
          }
          const fullCheck = evaluateHeavyVideoWarning({
            sizeBytes: entry.sizeBytes,
            durationSec: meta.durationSec,
            width: meta.width,
            height: meta.height,
            renderTarget: activeRenderTarget,
          });
          if (fullCheck.isHeavy && fullCheck.message) {
            setHeavyVideoWarning(`${entry.originalName}: ${fullCheck.message}`);
          }
        });
      });
    },
    [cloudRenderConfigured, onError, updateQueueItem]
  );

  const handleLoadDemo = useCallback(() => {
    onError(null);
    const demoItems = createDemoQueueItems();
    setItems((prev) => {
      const existingIds = new Set(prev.map((i) => i.id));
      const fresh = demoItems.filter((d) => !existingIds.has(d.id));
      return [...fresh, ...prev];
    });
    onSelectStudioItem(demoItems[0].id);

    const demoStats = createDemoAnalyticsRecords();
    setAnalyticsRecords((prev) => {
      const existingIds = new Set(prev.map((r) => r.id));
      const freshStats = demoStats.filter((s) => !existingIds.has(s.id));
      const merged = [...prev, ...freshStats];
      try {
        window.localStorage.setItem(ANALYTICS_STORAGE_KEY, JSON.stringify(merged));
      } catch {
        // Ignore storage quota errors
      }
      return merged;
    });
  }, [onError, onSelectStudioItem]);

  const handleRemoveQueueItem = useCallback(
    (itemId: string) => {
      setItems((prev) => {
        const found = prev.find((i) => i.id === itemId);
        if (found?.rawUrl) URL.revokeObjectURL(found.rawUrl);
        if (found?.editedUrl) URL.revokeObjectURL(found.editedUrl);
        return prev.filter((i) => i.id !== itemId);
      });
      setSelectedForCombine((prev) => prev.filter((id) => id !== itemId));
      deleteEditedVideoBlob(itemId).then(() => refreshCacheStats());
    },
    [refreshCacheStats]
  );

  const handleClearPending = useCallback(() => {
    const removedIds = new Set<string>();
    setItems((prev) =>
      prev.filter((item) => {
        if (item.stage === 'pending' || item.stage === 'error') {
          removedIds.add(item.id);
          if (item.rawUrl) URL.revokeObjectURL(item.rawUrl);
          return false;
        }
        return true;
      })
    );
    if (removedIds.size > 0) {
      setSelectedForCombine((prev) => prev.filter((id) => !removedIds.has(id)));
    }
  }, []);

  const handleToggleSelectForCombine = useCallback((itemId: string) => {
    setSelectedForCombine((prev) =>
      prev.includes(itemId) ? prev.filter((id) => id !== itemId) : [...prev, itemId]
    );
  }, []);

  const processSingleItem = useCallback(
    async (itemId: string, openStudioOnReview = true) => {
      const target = itemsRef.current.find((i) => i.id === itemId);
      if (!target) return;

      if (target.source === 'demo' && !target.rawBlob) {
        onError(
          'Los vídeos de ejemplo no contienen archivo binario para enviar a Gemini. Sube un vídeo desde tu galería o escanea tu carpeta de Google Drive.'
        );
        return;
      }

      onError(null);
      setIsProcessingAny(true);
      const processStartMs = performance.now();
      let currentPhase: ErrorPhase = target.source === 'drive' && !target.rawBlob ? 'Drive' : 'Extracción frames';
      logInfo('UI', 'Clic en procesar vídeo', {
        archivo: target.originalName,
        origen: target.source,
        pesoMB: Number((target.sizeBytes / (1024 * 1024)).toFixed(2)),
        modelo: settings.model,
        calidad: settings.exportQuality === 'mobile_fast' ? '720p' : '1080p',
      });

      try {
        let rawBlob = target.rawBlob;
        let rawUrl = target.rawUrl;

        // Stage 1: Download from Google Drive if needed
        if (!rawBlob && target.source === 'drive' && target.driveFileId) {
          currentPhase = 'Drive';
          const token = accessToken || getCachedDriveToken();
          if (!token) {
            throw new DriveAuthExpiredError(
              'Inicia sesión con Google Drive para descargar el vídeo.'
            );
          }

          updateQueueItem(itemId, {
            stage: 'downloading',
            stageDetail: 'Descargando archivo bruto desde Google Drive...',
            progress: 5,
            errorMessage: undefined,
          });

          rawBlob = await downloadDriveVideo(
            target.driveFileId,
            token,
            target.sizeBytes,
            (percent) => {
              updateQueueItem(itemId, {
                stage: 'downloading',
                stageDetail: `Descargando desde Google Drive (${percent}%)...`,
                progress: percent,
              });
            }
          );

          rawUrl = URL.createObjectURL(rawBlob);
          updateQueueItem(itemId, { rawBlob, rawUrl });
        }

        if (!rawBlob) {
          throw new Error('No se encontró el archivo de vídeo para procesar.');
        }

        currentPhase = 'Extracción frames';
        const meta = await inspectVideoMetadata(rawBlob);
        const durationSec = meta.durationSec;
        if (durationSec > 0) {
          updateQueueItem(itemId, { durationSec });
        }

        const heavyCheck = evaluateHeavyVideoWarning({
          sizeBytes: rawBlob.size || target.sizeBytes,
          durationSec,
          width: meta.width,
          height: meta.height,
          renderTarget: cloudRenderConfigured ? 'cloud' : 'mobile',
        });
        if (heavyCheck.isHeavy && heavyCheck.message) {
          setHeavyVideoWarning(`${target.originalName}: ${heavyCheck.message}`);
        }

        // Stage 2: Extract lightweight frames in browser (< 2 MB) & analyze with Gemini
        updateQueueItem(itemId, {
          stage: 'analyzing',
          stageDetail: 'Extrayendo fotogramas ligeros en el navegador...',
          progress: 10,
        });

        currentPhase = 'Análisis IA';
        const { plan, geminiFileCleaned } = await analyzeVideoWithGemini(
          rawBlob,
          target.originalName,
          settings.model,
          durationSec,
          (message, progress) => {
            updateQueueItem(itemId, {
              stage: 'analyzing',
              stageDetail: message,
              progress,
            });
          },
          {
            stylePreset,
            customInstruction,
            subtitlesEnabled: tiktokOptions.subtitlesEnabled,
            silenceTrimEnabled: tiktokOptions.silenceTrimEnabled,
          }
        );

        const outputFileName = buildEditedFilename(target.originalName, plan.etiqueta);

        // Stage 3: Pause at editable EDL preview before heavy FFmpeg.wasm render
        updateQueueItem(itemId, {
          analysis: plan,
          outputFileName,
          geminiFileCleaned,
          stylePreset,
          customInstruction: customInstruction.trim() || undefined,
          tiktokOptions: { ...tiktokOptions },
          exportQuality: settings.exportQuality,
          stage: 'review',
          stageDetail: `EDL listo (${plan.cortes.length} cortes) — Revisa y pulsa Renderizar vídeo final`,
          progress: 100,
        });

        logInfo('IA', 'EDL listo para revisión en Estudio', {
          archivo: target.originalName,
          cortes: plan.cortes.length,
          etiqueta: plan.etiqueta,
          totalMs: Math.round(performance.now() - processStartMs),
        });

        onSelectStudioItem(itemId);
        if (openStudioOnReview) {
          onNavigateView('studio');
        }
      } catch (err) {
        if (err instanceof DriveAuthExpiredError) {
          clearAuthSession();
          currentPhase = 'Drive';
        }
        const structured: AppErrorBanner =
          err instanceof GeminiClientError
            ? {
                message: formatPhaseError(err.phase, err.message),
                technicalDetail: err.technicalDetail,
                actionHint: err.actionHint,
              }
            : (() => {
                const parsed = parseHumanReadableApiError(err);
                return {
                  message: formatPhaseError(currentPhase, parsed.userMessage),
                  technicalDetail: parsed.technicalDetail,
                  actionHint: parsed.actionHint,
                };
              })();
        const logCat =
          currentPhase === 'Drive'
            ? 'Drive'
            : currentPhase === 'Extracción frames'
            ? 'Frames'
            : 'IA';
        logError(
          logCat,
          `Fallo procesando ${target.originalName}: ${structured.message}`,
          {
            fase: currentPhase,
            totalMs: Math.round(performance.now() - processStartMs),
          },
          err
        );
        updateQueueItem(itemId, {
          stage: 'error',
          errorMessage: structured.message,
          stageDetail: structured.message,
          progress: 0,
        });
        onError(structured);
      } finally {
        setIsProcessingAny(false);
      }
    },
    [
      accessToken,
      cloudRenderConfigured,
      settings.model,
      settings.exportQuality,
      stylePreset,
      customInstruction,
      tiktokOptions,
      updateQueueItem,
      clearAuthSession,
      onError,
      onSelectStudioItem,
      onNavigateView,
    ]
  );

  // Full Multi-Clip end-to-end pipeline
  const handleStartMultiClipCombine = useCallback(
    async (
      orderedIds: string[],
      projectName: string,
      chosenPreset: EditStylePreset,
      chosenInstruction: string
    ) => {
      const orderedItems = orderedIds
        .map((id) => itemsRef.current.find((i) => i.id === id))
        .filter((i): i is QueueItem => Boolean(i));

      if (orderedItems.length < 2) return;

      const hasDemoWithoutBlob = orderedItems.some((item) => item.source === 'demo' && !item.rawBlob);
      if (hasDemoWithoutBlob) {
        setMultiClipModalOpen(false);
        onError(
          'Los clips de ejemplo no contienen binario para enviar a Gemini. Selecciona 2 o más vídeos de Google Drive o subidos desde tu móvil/PC.'
        );
        return;
      }

      setMultiClipModalOpen(false);
      setSelectedForCombine([]);
      onError(null);
      setIsProcessingAny(true);

      const combinedId = `multiclip-${Date.now()}`;
      const projectBase = projectName.trim() || orderedItems[0].originalName;
      const displayName = projectName.trim()
        ? `${projectName.trim()} (${orderedItems.length} clips)`
        : `${orderedItems[0].originalName} + ${orderedItems.length - 1} más`;

      const initialSourceClips: SourceClipRef[] = orderedItems.map((clip) => ({
        id: clip.id,
        source: clip.source,
        driveFileId: clip.driveFileId,
        originalName: clip.originalName,
        mimeType: clip.mimeType,
        sizeBytes: clip.sizeBytes,
        durationSec: clip.durationSec,
        rawBlob: clip.rawBlob,
        rawUrl: clip.rawUrl,
      }));

      const totalSizeBytes = initialSourceClips.reduce((sum, c) => sum + c.sizeBytes, 0);
      const activeQuality = settings.exportQuality;

      const combinedItem: QueueItem = {
        id: combinedId,
        source: initialSourceClips.some((c) => c.source === 'drive') ? 'drive' : 'local',
        isMultiClip: true,
        projectName: projectName.trim() || undefined,
        originalName: displayName,
        mimeType: 'video/mp4',
        sizeBytes: totalSizeBytes,
        stage: 'downloading',
        stageDetail: `Preparando ${orderedItems.length} clips para combinar...`,
        progress: 5,
        sourceClips: initialSourceClips,
        stylePreset: chosenPreset,
        customInstruction: chosenInstruction.trim() || undefined,
        exportQuality: activeQuality,
        lastUpdated: Date.now(),
      };

      setItems((prev) => [combinedItem, ...prev]);

      const multiStartMs = performance.now();
      logInfo('UI', 'Iniciando combinación Multi-Clip', {
        clips: orderedItems.length,
        pesoTotalMB: Number((totalSizeBytes / (1024 * 1024)).toFixed(2)),
        modelo: settings.model,
        estilo: chosenPreset,
      });

      let currentPhase: ErrorPhase = 'Drive';
      try {
        const resolvedClips: SourceClipRef[] = [];
        const perClipResults: Array<{
          clipIndex: number;
          fileName: string;
          durationSec: number;
          plan: Awaited<ReturnType<typeof analyzeVideoWithGemini>>['plan'];
        }> = [];
        let allCleaned = true;

        // Strictly 1 clip at a time: download (if Drive) -> inspect -> extract lightweight frames -> analyze -> immediately free Drive blob!
        for (let i = 0; i < initialSourceClips.length; i += 1) {
          const clip = initialSourceClips[i];
          const clipNum = i + 1;
          const totalClips = initialSourceClips.length;
          let blob: Blob | undefined = clip.rawBlob;
          const downloadedFromDriveNow = !blob && clip.source === 'drive' && Boolean(clip.driveFileId);

          if (downloadedFromDriveNow && clip.driveFileId) {
            currentPhase = 'Drive';
            const token = accessToken || getCachedDriveToken();
            if (!token) {
              throw new DriveAuthExpiredError(
                'Inicia sesión con Google Drive para descargar los clips seleccionados.'
              );
            }

            updateQueueItem(combinedId, {
              stage: 'downloading',
              stageDetail: `Descargando Clip ${clipNum}/${totalClips}: ${clip.originalName}...`,
              progress: Math.round(((i * 2) / (totalClips * 2)) * 95),
            });

            blob = await downloadDriveVideo(
              clip.driveFileId,
              token,
              clip.sizeBytes,
              (pct) => {
                const overall = Math.round(((i + (pct / 100) * 0.45) / totalClips) * 92);
                updateQueueItem(combinedId, {
                  stage: 'downloading',
                  stageDetail: `Descargando Clip ${clipNum}/${totalClips} (${pct}%)...`,
                  progress: overall,
                });
              }
            );
          }

          if (!blob) {
            throw new Error(`Falta el archivo binario para el Clip ${clipNum} (${clip.originalName}).`);
          }

          currentPhase = 'Extracción frames';
          const meta = await inspectVideoMetadata(blob);
          const durationSec = clip.durationSec || meta.durationSec || 0;

          currentPhase = 'Análisis IA';
          updateQueueItem(combinedId, {
            stage: 'analyzing',
            stageDetail: `Clip ${clipNum}/${totalClips}: extrayendo fotogramas ligeros y analizando con Gemini...`,
            progress: Math.round(((i + 0.5) / totalClips) * 92),
          });

          const clipAnalysis = await analyzeVideoWithGemini(
            blob,
            clip.originalName,
            settings.model,
            durationSec,
            (msg, pct) => {
              const overall = Math.round(((i + 0.45 + (pct / 100) * 0.55) / totalClips) * 92);
              updateQueueItem(combinedId, {
                stage: 'analyzing',
                stageDetail: `Clip ${clipNum}/${totalClips}: ${msg}`,
                progress: Math.min(94, overall),
              });
            },
            {
              stylePreset: chosenPreset,
              customInstruction: chosenInstruction,
              subtitlesEnabled: tiktokOptions.subtitlesEnabled,
              silenceTrimEnabled: tiktokOptions.silenceTrimEnabled,
              clipIndex: i,
            }
          );

          allCleaned = allCleaned && clipAnalysis.geminiFileCleaned;
          perClipResults.push({
            clipIndex: i,
            fileName: clip.originalName,
            durationSec,
            plan: clipAnalysis.plan,
          });

          // Release Drive rawBlob immediately after analysis so 7 clips never sit in RAM at once!
          // (Local File objects are disk-backed OS handles; Drive blobs are in-RAM buffers and will be lazy-fetched 1 by 1 in FFmpeg.)
          const keepBlobInState = clip.source === 'local' ? blob : undefined;
          if (clip.source === 'drive' && clip.rawUrl) {
            URL.revokeObjectURL(clip.rawUrl);
          }
          if (clip.source === 'drive') {
            logInfo('Drive', `Bruto Drive ${clipNum}/${totalClips} liberado de RAM tras análisis`, {
              archivo: clip.originalName,
              pesoMB: Number((clip.sizeBytes / (1024 * 1024)).toFixed(2)),
            });
          }

          resolvedClips.push({
            ...clip,
            rawBlob: keepBlobInState,
            rawUrl: clip.source === 'local' ? clip.rawUrl : undefined,
            durationSec,
          });

          // Drop local reference before starting next clip
          blob = undefined;
        }

        const totalRawDurationSec = resolvedClips.reduce(
          (sum, c) => sum + (c.durationSec || 0),
          0
        );

        const heavyCheck = evaluateHeavyVideoWarning({
          sizeBytes: totalSizeBytes,
          durationSec: totalRawDurationSec,
          renderTarget: cloudRenderConfigured ? 'cloud' : 'mobile',
        });
        if (heavyCheck.isHeavy && heavyCheck.message) {
          setHeavyVideoWarning(`${displayName}: ${heavyCheck.message}`);
        }

        const plan = mergeMultiClipEditPlans(perClipResults, {
          projectName,
        });
        const geminiFileCleaned = allCleaned;

        const outputFileName = buildCombinedEditedFilename(projectBase, plan.etiqueta);

        // 3. Pause at editable EDL preview in Studio before sequential FFmpeg.wasm render
        updateQueueItem(combinedId, {
          sourceClips: resolvedClips,
          durationSec: totalRawDurationSec,
          analysis: plan,
          outputFileName,
          geminiFileCleaned,
          tiktokOptions: { ...tiktokOptions },
          stage: 'review',
          stageDetail: `Plan Multi-Clip listo (${plan.cortes.length} cortes de ${resolvedClips.length} clips) — Revisa y renderiza`,
          progress: 100,
        });

        logInfo('IA', 'Plan Multi-Clip listo para revisión', {
          clips: resolvedClips.length,
          cortes: plan.cortes.length,
          totalMs: Math.round(performance.now() - multiStartMs),
        });

        onSelectStudioItem(combinedId);
        onNavigateView('studio');
      } catch (err) {
        if (err instanceof DriveAuthExpiredError) {
          clearAuthSession();
          currentPhase = 'Drive';
        }
        const structured: AppErrorBanner =
          err instanceof GeminiClientError
            ? {
                message: formatPhaseError(err.phase, err.message),
                technicalDetail: err.technicalDetail,
                actionHint: err.actionHint,
              }
            : (() => {
                const parsed = parseHumanReadableApiError(err);
                return {
                  message: formatPhaseError(currentPhase, parsed.userMessage),
                  technicalDetail: parsed.technicalDetail,
                  actionHint: parsed.actionHint,
                };
              })();
        logError(
          currentPhase === 'Drive' ? 'Drive' : currentPhase === 'Extracción frames' ? 'Frames' : 'IA',
          `Fallo en Multi-Clip (${displayName}): ${structured.message}`,
          {
            fase: currentPhase,
            totalMs: Math.round(performance.now() - multiStartMs),
          },
          err
        );
        updateQueueItem(combinedId, {
          stage: 'error',
          errorMessage: structured.message,
          stageDetail: structured.message,
          progress: 0,
        });
        onError(structured);
      } finally {
        setIsProcessingAny(false);
      }
    },
    [
      accessToken,
      cloudRenderConfigured,
      settings.model,
      settings.exportQuality,
      tiktokOptions,
      updateQueueItem,
      clearAuthSession,
      onError,
      onSelectStudioItem,
      onNavigateView,
    ]
  );

  const handleProcessAllPending = useCallback(async () => {
    const pendingIds = itemsRef.current
      .filter(
        (i) =>
          (i.stage === 'pending' || i.stage === 'error') &&
          !i.isMultiClip &&
          (i.source !== 'demo' || i.rawBlob)
      )
      .map((i) => i.id);

    if (pendingIds.length === 0) {
      onError(
        'No hay vídeos reales pendientes en la cola. Sube vídeos locales o escanea tu carpeta de Google Drive.'
      );
      return;
    }

    for (const id of pendingIds) {
      await processSingleItem(id, false);
    }
    if (pendingIds.length > 0) {
      onSelectStudioItem(pendingIds[0]);
      onNavigateView('studio');
    }
  }, [processSingleItem, onError, onSelectStudioItem, onNavigateView]);

  const handleRequestDriveUpload = useCallback(
    (itemId: string) => {
      const target = itemsRef.current.find((i) => i.id === itemId);
      if (!target || !target.analysis) return;

      const fileName =
        target.outputFileName ||
        (target.isMultiClip
          ? buildCombinedEditedFilename(
              target.projectName || target.sourceClips?.[0]?.originalName || target.originalName,
              target.analysis.etiqueta
            )
          : buildEditedFilename(target.originalName, target.analysis.etiqueta));

      setPendingDriveUpload({
        itemId,
        fileName,
        folderId: settings.folderId,
        sizeBytes: target.editedBlob?.size ?? 0,
      });
    },
    [settings.folderId]
  );

  const handleConfirmDriveUpload = useCallback(async () => {
    if (!pendingDriveUpload) return;

    const target = itemsRef.current.find((i) => i.id === pendingDriveUpload.itemId);
    const token = accessToken || getCachedDriveToken();

    if (!token) {
      setPendingDriveUpload(null);
      onError('Inicia sesión con Google Drive antes de subir el vídeo editado.');
      return;
    }

    if (!pendingDriveUpload.folderId) {
      setPendingDriveUpload(null);
      onError('Configura el ID de carpeta de Google Drive en Ajustes.');
      onNavigateView('settings');
      return;
    }

    if (!target?.editedBlob) {
      setPendingDriveUpload(null);
      onError(
        'Este vídeo todavía no tiene un archivo MP4 renderizado (los ejemplos solo simulan la línea de tiempo).'
      );
      return;
    }

    setIsUploadingToDrive(true);
    onError(null);

    try {
      updateQueueItem(target.id, {
        stage: 'uploading',
        stageDetail: `Subiendo ${pendingDriveUpload.fileName} a Google Drive...`,
        progress: 20,
      });

      const uploaded = await uploadEditedVideoMultipart(
        pendingDriveUpload.folderId,
        pendingDriveUpload.fileName,
        target.editedBlob,
        token,
        (percent) => {
          updateQueueItem(target.id, {
            stage: 'uploading',
            stageDetail: `Subiendo a Google Drive (${percent}%)...`,
            progress: percent,
          });
        }
      );

      updateQueueItem(target.id, {
        stage: 'completed',
        stageDetail: `Subido a Drive como ${uploaded.name}`,
        progress: 100,
        uploadedDriveId: uploaded.id,
        uploadedWebViewLink: uploaded.webViewLink,
      });
      setPendingDriveUpload(null);
    } catch (err) {
      if (err instanceof DriveAuthExpiredError) {
        clearAuthSession();
      }
      const message = formatPhaseError(
        'Drive',
        err instanceof Error ? err.message : 'Error al subir el archivo a Google Drive.'
      );
      updateQueueItem(target.id, {
        stage: 'error',
        errorMessage: message,
        stageDetail: message,
      });
      onError(message);
      setPendingDriveUpload(null);
    } finally {
      setIsUploadingToDrive(false);
    }
  }, [pendingDriveUpload, accessToken, updateQueueItem, clearAuthSession, onError, onNavigateView]);

  const selectedCombineItems = useMemo(
    () =>
      selectedForCombine
        .map((id) => items.find((i) => i.id === id))
        .filter((i): i is QueueItem => Boolean(i)),
    [selectedForCombine, items]
  );

  const queueCounts = useMemo(() => {
    const pending = items.filter((i) => i.stage === 'pending' || i.stage === 'error').length;
    const completed = items.filter((i) => i.stage === 'completed' && Boolean(i.analysis)).length;
    const studioReady = items.filter((i) => Boolean(i.analysis)).length;
    return { total: items.length, pending, completed, studioReady };
  }, [items]);

  return {
    items,
    itemsRef,
    setItems,
    updateQueueItem,
    analyticsRecords,
    selectedForCombine,
    setSelectedForCombine,
    selectedCombineItems,
    multiClipModalOpen,
    setMultiClipModalOpen,
    alreadyEditedCount,
    lastScanTime,
    isScanning,
    isProcessingAny,
    isClearingCache,
    restoringDriveId,
    pendingDriveUpload,
    setPendingDriveUpload,
    isUploadingToDrive,
    nextScanCountdownSec,
    heavyVideoWarning,
    setHeavyVideoWarning,
    queueCounts,
    cacheEditedVideo,
    appendAnalyticsRecord,
    maybePromptDriveUpload,
    handleClearVideoCache,
    handleDownloadFromDrive,
    handleScanFolder,
    handleToggleAutoWatch,
    handleAddLocalFiles,
    handleLoadDemo,
    handleRemoveQueueItem,
    handleClearPending,
    handleToggleSelectForCombine,
    processSingleItem,
    handleStartMultiClipCombine,
    handleProcessAllPending,
    handleRequestDriveUpload,
    handleConfirmDriveUpload,
  };
}
