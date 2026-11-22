import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ActiveView,
  AnalyticsRecord,
  AppSettings,
  EditStylePreset,
  PendingDriveUpload,
  QueueItem,
  SourceClipRef,
} from '../types';
import {
  buildCombinedEditedFilename,
  buildEditedFilename,
  calculateSelectedDuration,
  detectPendingVideos,
  evaluateHeavyVideoWarning,
  isSupportedVideoFile,
  toLocalDateKey,
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
  analyzeMultiClipWithGemini,
  analyzeVideoWithGemini,
} from '../services/geminiClient';
import {
  inspectVideoMetadata,
  renderCutsWithFfmpeg,
  renderMultiClipCutsWithFfmpeg,
} from '../services/ffmpegService';
import {
  clearAllEditedVideoBlobs,
  deleteEditedVideoBlob,
  getEditedVideoBlob,
  saveEditedVideoBlob,
} from '../services/videoStorage';

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
  accessToken: string | null;
  clearAuthSession: () => void;
  refreshCacheStats: () => Promise<void>;
  onError: (message: string | null) => void;
  onNavigateView: (view: ActiveView) => void;
  onSelectStudioItem: (itemId: string) => void;
}

export function useVideoQueue({
  settings,
  persistSettings,
  stylePreset,
  customInstruction,
  accessToken,
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
          err instanceof Error
            ? err.message
            : 'No se pudo recuperar el vídeo desde Google Drive.'
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
      onError('Inicia sesión con Google Drive antes de escanear una carpeta.');
      return;
    }
    if (!settings.folderId) {
      onError('Configura el ID de tu carpeta de Google Drive en Ajustes.');
      onNavigateView('settings');
      return;
    }

    setIsScanning(true);
    try {
      const files = await listDriveFolderFiles(settings.folderId, token);
      const { pending, alreadyEditedSources } = detectPendingVideos(files);
      setAlreadyEditedCount(alreadyEditedSources.length);
      setLastScanTime(Date.now());

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
      onError(
        err instanceof Error ? err.message : 'No se pudo escanear la carpeta de Google Drive.'
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

      // Inspect resolution & duration asynchronously to warn early about heavy/4K files
      added.forEach((entry) => {
        if (!entry.rawBlob) return;
        const quickCheck = evaluateHeavyVideoWarning({ sizeBytes: entry.sizeBytes });
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
          });
          if (fullCheck.isHeavy && fullCheck.message) {
            setHeavyVideoWarning(`${entry.originalName}: ${fullCheck.message}`);
          }
        });
      });
    },
    [onError, updateQueueItem]
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
    async (itemId: string) => {
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

      try {
        let rawBlob = target.rawBlob;
        let rawUrl = target.rawUrl;

        // Stage 1: Download from Google Drive if needed
        if (!rawBlob && target.source === 'drive' && target.driveFileId) {
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
        });
        if (heavyCheck.isHeavy && heavyCheck.message) {
          setHeavyVideoWarning(`${target.originalName}: ${heavyCheck.message}`);
        }

        // Stage 2: Analyze with Gemini via server-side Gemini Files API resumable upload
        updateQueueItem(itemId, {
          stage: 'analyzing',
          stageDetail: 'Subiendo a Gemini Files API...',
          progress: 10,
        });

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
          }
        );

        const outputFileName = buildEditedFilename(target.originalName, plan.etiqueta);
        const activeQuality = settings.exportQuality;

        updateQueueItem(itemId, {
          analysis: plan,
          outputFileName,
          geminiFileCleaned,
          stylePreset,
          customInstruction: customInstruction.trim() || undefined,
          exportQuality: activeQuality,
          stage: 'rendering',
          stageDetail:
            activeQuality === 'mobile_fast'
              ? 'Iniciando FFmpeg.wasm (720p rápido móvil)...'
              : 'Iniciando FFmpeg.wasm (1080p HD TikTok)...',
          progress: 5,
        });

        // Stage 3: Render jump cuts in browser with FFmpeg.wasm
        const editedBlob = await renderCutsWithFfmpeg(
          rawBlob,
          target.originalName,
          plan.cortes,
          ({ percent, message }) => {
            updateQueueItem(itemId, {
              stage: 'rendering',
              stageDetail: message,
              progress: percent,
            });
          },
          activeQuality
        );

        const editedUrl = URL.createObjectURL(editedBlob);
        if (target.editedUrl) {
          URL.revokeObjectURL(target.editedUrl);
        }

        const completedAt = Date.now();
        updateQueueItem(itemId, {
          editedBlob,
          editedUrl,
          editedSizeBytes: editedBlob.size,
          cachedInIndexedDb: true,
          outputFileName,
          stage: 'completed',
          stageDetail: 'Renderizado y guardado en caché local (Galería y Estudio)',
          progress: 100,
          completedAt,
        });

        await cacheEditedVideo(itemId, editedBlob, outputFileName);

        appendAnalyticsRecord({
          id: `ana-${itemId}-${completedAt}`,
          dateKey: toLocalDateKey(completedAt),
          processedAt: completedAt,
          etiqueta: plan.etiqueta,
          rawDurationSec: durationSec || calculateSelectedDuration(plan.cortes),
          editedDurationSec: calculateSelectedDuration(plan.cortes),
          isMultiClip: false,
          clipCount: 1,
        });

        onSelectStudioItem(itemId);

        // Stage 4: Prompt explicit user confirmation before uploading to Google Drive
        const canUpload = Boolean(
          (accessToken || getCachedDriveToken()) && settings.folderId && settings.autoUploadEnabled
        );
        if (canUpload) {
          setPendingDriveUpload({
            itemId,
            fileName: outputFileName,
            folderId: settings.folderId,
            sizeBytes: editedBlob.size,
          });
        }
      } catch (err) {
        if (err instanceof DriveAuthExpiredError) {
          clearAuthSession();
        }
        const message =
          err instanceof Error ? err.message : 'Error inesperado al procesar el vídeo.';
        updateQueueItem(itemId, {
          stage: 'error',
          errorMessage: message,
          stageDetail: message,
          progress: 0,
        });
        onError(message);
      } finally {
        setIsProcessingAny(false);
      }
    },
    [
      accessToken,
      settings.model,
      settings.folderId,
      settings.autoUploadEnabled,
      settings.exportQuality,
      stylePreset,
      customInstruction,
      updateQueueItem,
      cacheEditedVideo,
      appendAnalyticsRecord,
      clearAuthSession,
      onError,
      onSelectStudioItem,
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

      try {
        const resolvedClips: SourceClipRef[] = [];

        // 1. Download any Drive clips & inspect metadata
        for (let i = 0; i < initialSourceClips.length; i += 1) {
          const clip = initialSourceClips[i];
          let blob = clip.rawBlob;
          let rawUrl = clip.rawUrl;

          if (!blob && clip.source === 'drive' && clip.driveFileId) {
            const token = accessToken || getCachedDriveToken();
            if (!token) {
              throw new DriveAuthExpiredError(
                'Inicia sesión con Google Drive para descargar los clips seleccionados.'
              );
            }

            updateQueueItem(combinedId, {
              stage: 'downloading',
              stageDetail: `Descargando Clip ${i + 1}/${initialSourceClips.length}: ${clip.originalName}...`,
              progress: Math.round((i / initialSourceClips.length) * 100),
            });

            blob = await downloadDriveVideo(
              clip.driveFileId,
              token,
              clip.sizeBytes,
              (pct) => {
                const overall = Math.round(((i + pct / 100) / initialSourceClips.length) * 100);
                updateQueueItem(combinedId, {
                  stage: 'downloading',
                  stageDetail: `Descargando Clip ${i + 1}/${initialSourceClips.length} (${pct}%)...`,
                  progress: overall,
                });
              }
            );
            rawUrl = URL.createObjectURL(blob);
          }

          if (!blob) {
            throw new Error(`Falta el archivo binario para el Clip ${i + 1} (${clip.originalName}).`);
          }

          const meta = await inspectVideoMetadata(blob);
          const durationSec = clip.durationSec || meta.durationSec;
          resolvedClips.push({
            ...clip,
            rawBlob: blob,
            rawUrl,
            durationSec,
          });
        }

        const totalRawDurationSec = resolvedClips.reduce(
          (sum, c) => sum + (c.durationSec || 0),
          0
        );

        const heavyCheck = evaluateHeavyVideoWarning({
          sizeBytes: totalSizeBytes,
          durationSec: totalRawDurationSec,
        });
        if (heavyCheck.isHeavy && heavyCheck.message) {
          setHeavyVideoWarning(`${displayName}: ${heavyCheck.message}`);
        }

        updateQueueItem(combinedId, {
          sourceClips: resolvedClips,
          durationSec: totalRawDurationSec,
          stage: 'analyzing',
          stageDetail: `Subiendo ${resolvedClips.length} clips a Gemini Files API...`,
          progress: 8,
        });

        // 2. Analyze all clips together via server-side /api/gemini/analyze-multi
        const { plan, geminiFileCleaned } = await analyzeMultiClipWithGemini(
          resolvedClips.map((c) => ({
            blob: c.rawBlob!,
            fileName: c.originalName,
            durationSec: c.durationSec,
          })),
          settings.model,
          projectName,
          (message, progress) => {
            updateQueueItem(combinedId, {
              stage: 'analyzing',
              stageDetail: message,
              progress,
            });
          },
          {
            stylePreset: chosenPreset,
            customInstruction: chosenInstruction,
          }
        );

        const outputFileName = buildCombinedEditedFilename(projectBase, plan.etiqueta);

        updateQueueItem(combinedId, {
          analysis: plan,
          outputFileName,
          geminiFileCleaned,
          stage: 'rendering',
          stageDetail:
            activeQuality === 'mobile_fast'
              ? 'Normalizando clips a 720×1280 (30fps · ultrafast) en FFmpeg.wasm...'
              : 'Normalizando clips a 1080×1920 (30fps · TikTok) en FFmpeg.wasm...',
          progress: 5,
        });

        // 3. Render normalized combined MP4 in browser
        const editedBlob = await renderMultiClipCutsWithFfmpeg(
          resolvedClips.map((c) => ({
            blob: c.rawBlob!,
            originalFileName: c.originalName,
          })),
          plan.cortes,
          ({ percent, message }) => {
            updateQueueItem(combinedId, {
              stage: 'rendering',
              stageDetail: message,
              progress: percent,
            });
          },
          activeQuality
        );

        const editedUrl = URL.createObjectURL(editedBlob);
        const completedAt = Date.now();

        updateQueueItem(combinedId, {
          editedBlob,
          editedUrl,
          editedSizeBytes: editedBlob.size,
          cachedInIndexedDb: true,
          outputFileName,
          stage: 'completed',
          stageDetail: `Combinado con ${plan.cortes.length} cortes de ${resolvedClips.length} brutos`,
          progress: 100,
          completedAt,
        });

        await cacheEditedVideo(combinedId, editedBlob, outputFileName);

        appendAnalyticsRecord({
          id: `ana-${combinedId}`,
          dateKey: toLocalDateKey(completedAt),
          processedAt: completedAt,
          etiqueta: plan.etiqueta,
          rawDurationSec: totalRawDurationSec || calculateSelectedDuration(plan.cortes),
          editedDurationSec: calculateSelectedDuration(plan.cortes),
          isMultiClip: true,
          clipCount: resolvedClips.length,
        });

        onSelectStudioItem(combinedId);

        const canUpload = Boolean(
          (accessToken || getCachedDriveToken()) && settings.folderId && settings.autoUploadEnabled
        );
        if (canUpload) {
          setPendingDriveUpload({
            itemId: combinedId,
            fileName: outputFileName,
            folderId: settings.folderId,
            sizeBytes: editedBlob.size,
          });
        }
      } catch (err) {
        if (err instanceof DriveAuthExpiredError) {
          clearAuthSession();
        }
        const message =
          err instanceof Error ? err.message : 'Error inesperado al combinar los clips.';
        updateQueueItem(combinedId, {
          stage: 'error',
          errorMessage: message,
          stageDetail: message,
          progress: 0,
        });
        onError(message);
      } finally {
        setIsProcessingAny(false);
      }
    },
    [
      accessToken,
      settings.model,
      settings.folderId,
      settings.autoUploadEnabled,
      settings.exportQuality,
      updateQueueItem,
      cacheEditedVideo,
      appendAnalyticsRecord,
      clearAuthSession,
      onError,
      onSelectStudioItem,
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
      await processSingleItem(id);
    }
  }, [processSingleItem, onError]);

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
      const message =
        err instanceof Error ? err.message : 'Error al subir el archivo a Google Drive.';
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
