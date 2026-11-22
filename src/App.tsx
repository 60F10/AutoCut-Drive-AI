import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { User } from 'firebase/auth';
import { AlertCircle, RefreshCw, X } from 'lucide-react';
import type {
  ActiveView,
  AnalyticsRecord,
  AppSettings,
  EditStylePreset,
  ExportQuality,
  PendingDriveUpload,
  QueueItem,
  SourceClipRef,
} from './types';
import {
  buildCombinedEditedFilename,
  buildEditedFilename,
  calculateSelectedDuration,
  detectDefaultExportQuality,
  detectPendingVideos,
  extractDriveFolderId,
  isSupportedVideoFile,
  normalizeExportQuality,
  normalizeStylePreset,
  toLocalDateKey,
} from './utils/videoPipeline';
import { createDemoAnalyticsRecords, createDemoQueueItems } from './utils/demoData';
import {
  getCachedDriveToken,
  initGoogleAuth,
  signInWithGoogleDrive,
  signOutGoogleDrive,
} from './services/googleAuth';
import {
  DriveAuthExpiredError,
  downloadDriveVideo,
  listDriveFolderFiles,
  uploadEditedVideoMultipart,
} from './services/driveApi';
import {
  analyzeMultiClipWithGemini,
  analyzeVideoWithGemini,
  checkServerHealth,
} from './services/geminiClient';
import {
  readVideoDuration,
  renderCutsWithFfmpeg,
  renderMultiClipCutsWithFfmpeg,
} from './services/ffmpegService';
import {
  MAX_CACHED_VIDEOS,
  clearAllEditedVideoBlobs,
  deleteEditedVideoBlob,
  getEditedVideoBlob,
  getVideoCacheStats,
  saveEditedVideoBlob,
  type VideoCacheStats,
} from './services/videoStorage';
import { Sidebar } from './components/Sidebar';
import { MobileBottomNav } from './components/MobileBottomNav';
import { QueueView } from './components/QueueView';
import { GalleryView } from './components/GalleryView';
import { StudioView } from './components/StudioView';
import { SettingsView } from './components/SettingsView';
import { DriveConfirmModal } from './components/DriveConfirmModal';
import { MultiClipComposerModal } from './components/MultiClipComposerModal';
import { OfflineIndicator } from './components/PWAInstallButton';

const SETTINGS_STORAGE_KEY = 'autocut_drive_ai_settings_v1';
const ANALYTICS_STORAGE_KEY = 'autocut_drive_ai_analytics_v1';
const STYLE_PRESET_STORAGE_KEY = 'autocut_drive_ai_style_preset_v1';
const GALLERY_ITEMS_STORAGE_KEY = 'autocut_drive_ai_gallery_items_v1';

function createDefaultSettings(): AppSettings {
  return {
    folderId: '',
    model: 'gemini-2.5-flash',
    watchIntervalSec: 60,
    autoWatchEnabled: false,
    autoUploadEnabled: true,
    exportQuality: detectDefaultExportQuality(),
  };
}

function loadInitialSettings(): AppSettings {
  const defaults = createDefaultSettings();
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    const validModel =
      parsed.model === 'gemini-2.5-pro' ? 'gemini-2.5-pro' : 'gemini-2.5-flash';
    const validInterval =
      parsed.watchIntervalSec === 30 ||
      parsed.watchIntervalSec === 60 ||
      parsed.watchIntervalSec === 300
        ? parsed.watchIntervalSec
        : 60;
    const validQuality =
      parsed.exportQuality === 'mobile_fast' || parsed.exportQuality === 'high_1080p'
        ? parsed.exportQuality
        : defaults.exportQuality;
    return {
      folderId: extractDriveFolderId(String(parsed.folderId ?? '')),
      model: validModel,
      watchIntervalSec: validInterval,
      autoWatchEnabled: Boolean(parsed.autoWatchEnabled),
      autoUploadEnabled: parsed.autoUploadEnabled !== false,
      exportQuality: normalizeExportQuality(validQuality),
    };
  } catch {
    return defaults;
  }
}

function loadInitialStylePreset(): EditStylePreset {
  try {
    const raw = window.localStorage.getItem(STYLE_PRESET_STORAGE_KEY);
    return normalizeStylePreset(raw);
  } catch {
    return 'funny_jumpcut';
  }
}

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

export default function App() {
  const [settings, setSettings] = useState<AppSettings>(loadInitialSettings);
  const [stylePreset, setStylePreset] = useState<EditStylePreset>(loadInitialStylePreset);
  const [customInstruction, setCustomInstruction] = useState('');
  const [analyticsRecords, setAnalyticsRecords] = useState<AnalyticsRecord[]>(loadInitialAnalytics);
  const [activeView, setActiveView] = useState<ActiveView>('queue');

  // IndexedDB video cache stats & Drive recovery state
  const [cacheStats, setCacheStats] = useState<VideoCacheStats>({
    count: 0,
    totalBytes: 0,
    maxItems: MAX_CACHED_VIDEOS,
  });
  const [isClearingCache, setIsClearingCache] = useState(false);
  const [restoringDriveId, setRestoringDriveId] = useState<string | null>(null);

  // Auth state (access token is kept strictly in memory via googleAuth.ts)
  const [user, setUser] = useState<User | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [geminiConfigured, setGeminiConfigured] = useState(true);

  // Queue, Multi-Clip Selection & Studio state (initialized from persisted completed gallery items)
  const [items, setItems] = useState<QueueItem[]>(loadPersistedGalleryItems);
  const [selectedForCombine, setSelectedForCombine] = useState<string[]>([]);
  const [multiClipModalOpen, setMultiClipModalOpen] = useState(false);
  const [alreadyEditedCount, setAlreadyEditedCount] = useState(0);
  const [selectedStudioId, setSelectedStudioId] = useState<string | null>(null);
  const [lastScanTime, setLastScanTime] = useState<number | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [isProcessingAny, setIsProcessingAny] = useState(false);
  const [isStudioRendering, setIsStudioRendering] = useState(false);
  const [studioRenderProgress, setStudioRenderProgress] = useState<{
    percent: number;
    message: string;
  } | null>(null);

  // Drive upload confirmation modal state
  const [pendingDriveUpload, setPendingDriveUpload] = useState<PendingDriveUpload | null>(null);
  const [isUploadingToDrive, setIsUploadingToDrive] = useState(false);

  // Feedback banner & watch countdown
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [nextScanCountdownSec, setNextScanCountdownSec] = useState<number | null>(null);

  const itemsRef = useRef(items);
  itemsRef.current = items;

  const refreshCacheStats = useCallback(async () => {
    const stats = await getVideoCacheStats();
    setCacheStats(stats);
  }, []);

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

  useEffect(() => {
    const unsubscribe = initGoogleAuth(
      (authedUser, token) => {
        setUser(authedUser);
        setAccessToken(token);
      },
      () => {
        setUser(null);
        setAccessToken(null);
      }
    );
    checkServerHealth().then((health) => {
      setGeminiConfigured(health.geminiConfigured);
    });
    return unsubscribe;
  }, []);

  const persistSettings = useCallback((next: AppSettings) => {
    setSettings(next);
    try {
      window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Ignore storage quota errors
    }
  }, []);

  const handleChangeStylePreset = useCallback((next: EditStylePreset) => {
    const normalized = normalizeStylePreset(next);
    setStylePreset(normalized);
    try {
      window.localStorage.setItem(STYLE_PRESET_STORAGE_KEY, normalized);
    } catch {
      // Ignore storage quota errors
    }
  }, []);

  const handleChangeExportQuality = useCallback(
    (quality: ExportQuality) => {
      persistSettings({
        ...settings,
        exportQuality: normalizeExportQuality(quality),
      });
    },
    [settings, persistSettings]
  );

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

  const handleDownloadFromDrive = useCallback(
    async (itemId: string) => {
      const target = itemsRef.current.find((i) => i.id === itemId);
      if (!target?.uploadedDriveId) return;

      const token = accessToken || getCachedDriveToken();
      if (!token) {
        setBannerError('Inicia sesión con Google Drive para descargar este vídeo.');
        return;
      }

      setBannerError(null);
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
          setUser(null);
          setAccessToken(null);
        }
        setBannerError(
          err instanceof Error
            ? err.message
            : 'No se pudo recuperar el vídeo desde Google Drive.'
        );
      } finally {
        setRestoringDriveId(null);
      }
    },
    [accessToken, cacheEditedVideo]
  );

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

  const updateQueueItem = useCallback((itemId: string, patch: Partial<QueueItem>) => {
    setItems((prev) =>
      prev.map((item) =>
        item.id === itemId ? { ...item, ...patch, lastUpdated: Date.now() } : item
      )
    );
  }, []);

  const handleGoogleLogin = useCallback(async () => {
    setBannerError(null);
    setIsLoggingIn(true);
    try {
      const session = await signInWithGoogleDrive();
      setUser(session.user);
      setAccessToken(session.accessToken);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'No se pudo iniciar sesión con Google Drive.';
      setBannerError(message);
    } finally {
      setIsLoggingIn(false);
    }
  }, []);

  const handleGoogleLogout = useCallback(async () => {
    await signOutGoogleDrive();
    setUser(null);
    setAccessToken(null);
  }, []);

  const handleScanFolder = useCallback(async () => {
    setBannerError(null);
    const token = accessToken || getCachedDriveToken();
    if (!token) {
      setBannerError('Inicia sesión con Google Drive antes de escanear una carpeta.');
      return;
    }
    if (!settings.folderId) {
      setBannerError('Configura el ID de tu carpeta de Google Drive en Ajustes.');
      setActiveView('settings');
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
        setUser(null);
        setAccessToken(null);
      }
      setBannerError(
        err instanceof Error ? err.message : 'No se pudo escanear la carpeta de Google Drive.'
      );
    } finally {
      setIsScanning(false);
    }
  }, [accessToken, settings.folderId]);

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
      setBannerError('Configura el ID de carpeta en Ajustes para activar la vigilancia automática.');
      setActiveView('settings');
      return;
    }
    persistSettings({
      ...settings,
      autoWatchEnabled: !settings.autoWatchEnabled,
    });
  }, [settings, persistSettings]);

  const handleAddLocalFiles = useCallback((fileList: FileList) => {
    setBannerError(null);
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
      setBannerError('Selecciona archivos de vídeo válidos desde tu dispositivo (.mp4, .mov, .webm).');
      return;
    }

    setItems((prev) => [...added, ...prev]);
  }, []);

  const handleLoadDemo = useCallback(() => {
    setBannerError(null);
    const demoItems = createDemoQueueItems();
    setItems((prev) => {
      const existingIds = new Set(prev.map((i) => i.id));
      const fresh = demoItems.filter((d) => !existingIds.has(d.id));
      return [...fresh, ...prev];
    });
    setSelectedStudioId(demoItems[0].id);

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
  }, []);

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
        setBannerError(
          'Los vídeos de ejemplo no contienen archivo binario para enviar a Gemini. Sube un vídeo desde tu galería o escanea tu carpeta de Google Drive.'
        );
        return;
      }

      setBannerError(null);
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

        const durationSec = await readVideoDuration(rawBlob);
        if (durationSec > 0) {
          updateQueueItem(itemId, { durationSec });
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
              : 'Iniciando FFmpeg.wasm (1080p HD)...',
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

        setSelectedStudioId(itemId);

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
          setUser(null);
          setAccessToken(null);
        }
        const message =
          err instanceof Error ? err.message : 'Error inesperado al procesar el vídeo.';
        updateQueueItem(itemId, {
          stage: 'error',
          errorMessage: message,
          stageDetail: message,
          progress: 0,
        });
        setBannerError(message);
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
        setBannerError(
          'Los clips de ejemplo no contienen binario para enviar a Gemini. Selecciona 2 o más vídeos de Google Drive o subidos desde tu móvil/PC.'
        );
        return;
      }

      setMultiClipModalOpen(false);
      setSelectedForCombine([]);
      setBannerError(null);
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

        // 1. Download any Drive clips & read durations
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

          const durationSec = clip.durationSec || (await readVideoDuration(blob));
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
              : 'Normalizando clips a 1080×1920 (30fps) en FFmpeg.wasm...',
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

        setSelectedStudioId(combinedId);

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
          setUser(null);
          setAccessToken(null);
        }
        const message =
          err instanceof Error ? err.message : 'Error inesperado al combinar los clips.';
        updateQueueItem(combinedId, {
          stage: 'error',
          errorMessage: message,
          stageDetail: message,
          progress: 0,
        });
        setBannerError(message);
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
      setBannerError(
        'No hay vídeos reales pendientes en la cola. Sube vídeos locales o escanea tu carpeta de Google Drive.'
      );
      return;
    }

    for (const id of pendingIds) {
      await processSingleItem(id);
    }
  }, [processSingleItem]);

  const handleToggleCut = useCallback((itemId: string, cutId: string) => {
    setItems((prev) =>
      prev.map((item) => {
        if (item.id !== itemId || !item.analysis) return item;
        return {
          ...item,
          analysis: {
            ...item.analysis,
            cortes: item.analysis.cortes.map((cut) =>
              cut.id === cutId ? { ...cut, enabled: !cut.enabled } : cut
            ),
          },
        };
      })
    );
  }, []);

  const handleSelectAllCuts = useCallback((itemId: string, enabled: boolean) => {
    setItems((prev) =>
      prev.map((item) => {
        if (item.id !== itemId || !item.analysis) return item;
        return {
          ...item,
          analysis: {
            ...item.analysis,
            cortes: item.analysis.cortes.map((cut) => ({ ...cut, enabled })),
          },
        };
      })
    );
  }, []);

  const handleRerenderItem = useCallback(
    async (itemId: string) => {
      const target = itemsRef.current.find((i) => i.id === itemId);
      if (!target || !target.analysis) return;

      const isMulti = Boolean(
        target.isMultiClip &&
          target.sourceClips &&
          target.sourceClips.length > 0 &&
          target.sourceClips.every((c) => Boolean(c.rawBlob))
      );

      if (!isMulti && !target.rawBlob) return;

      setBannerError(null);
      setIsStudioRendering(true);
      setStudioRenderProgress({ percent: 5, message: 'Preparando re-renderizado...' });

      try {
        const activeQuality = settings.exportQuality;
        updateQueueItem(itemId, {
          exportQuality: activeQuality,
          stage: 'rendering',
          stageDetail:
            activeQuality === 'mobile_fast'
              ? 'Re-renderizando cortes en 720p móvil...'
              : 'Re-renderizando cortes en 1080p HD...',
          progress: 5,
        });

        const editedBlob = isMulti
          ? await renderMultiClipCutsWithFfmpeg(
              target.sourceClips!.map((c) => ({
                blob: c.rawBlob!,
                originalFileName: c.originalName,
              })),
              target.analysis.cortes,
              (progress) => {
                setStudioRenderProgress(progress);
                updateQueueItem(itemId, {
                  stage: 'rendering',
                  stageDetail: progress.message,
                  progress: progress.percent,
                });
              },
              activeQuality
            )
          : await renderCutsWithFfmpeg(
              target.rawBlob!,
              target.originalName,
              target.analysis.cortes,
              (progress) => {
                setStudioRenderProgress(progress);
                updateQueueItem(itemId, {
                  stage: 'rendering',
                  stageDetail: progress.message,
                  progress: progress.percent,
                });
              },
              activeQuality
            );

        const editedUrl = URL.createObjectURL(editedBlob);
        if (target.editedUrl) {
          URL.revokeObjectURL(target.editedUrl);
        }

        const fileName = target.outputFileName || `${target.originalName}_EDITADO.mp4`;

        updateQueueItem(itemId, {
          editedBlob,
          editedUrl,
          editedSizeBytes: editedBlob.size,
          cachedInIndexedDb: true,
          stage: 'completed',
          stageDetail: 'Nuevo render guardado en caché local y listo para subir a Drive',
          progress: 100,
        });

        await cacheEditedVideo(itemId, editedBlob, fileName);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Error al re-renderizar los cortes.';
        setBannerError(message);
        updateQueueItem(itemId, {
          stage: 'error',
          errorMessage: message,
        });
      } finally {
        setIsStudioRendering(false);
        setStudioRenderProgress(null);
      }
    },
    [settings.exportQuality, updateQueueItem, cacheEditedVideo]
  );

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
      setBannerError('Inicia sesión con Google Drive antes de subir el vídeo editado.');
      return;
    }

    if (!pendingDriveUpload.folderId) {
      setPendingDriveUpload(null);
      setBannerError('Configura el ID de carpeta de Google Drive en Ajustes.');
      setActiveView('settings');
      return;
    }

    if (!target?.editedBlob) {
      setPendingDriveUpload(null);
      setBannerError(
        'Este vídeo todavía no tiene un archivo MP4 renderizado (los ejemplos solo simulan la línea de tiempo).'
      );
      return;
    }

    setIsUploadingToDrive(true);
    setBannerError(null);

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
        setUser(null);
        setAccessToken(null);
      }
      const message =
        err instanceof Error ? err.message : 'Error al subir el archivo a Google Drive.';
      updateQueueItem(target.id, {
        stage: 'error',
        errorMessage: message,
        stageDetail: message,
      });
      setBannerError(message);
      setPendingDriveUpload(null);
    } finally {
      setIsUploadingToDrive(false);
    }
  }, [pendingDriveUpload, accessToken, updateQueueItem]);

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

  const viewTitle =
    activeView === 'queue'
      ? 'Cola de vídeos'
      : activeView === 'gallery'
      ? 'Galería de resultados'
      : activeView === 'studio'
      ? 'Estudio de cortes'
      : 'Ajustes';

  return (
    <div className="min-h-dvh-app cyber-canvas-bg text-[#EEF5FF] flex">
      <Sidebar
        activeView={activeView}
        onSelectView={setActiveView}
        settings={settings}
        onToggleAutoWatch={handleToggleAutoWatch}
        nextScanCountdownSec={nextScanCountdownSec}
        queueCounts={queueCounts}
        user={user}
        isLoggingIn={isLoggingIn}
        onGoogleLogin={handleGoogleLogin}
        onGoogleLogout={handleGoogleLogout}
      />

      <div className="flex-1 min-w-0 flex flex-col">
        {/* Clean non-interactive mobile header with generous iOS standalone safe-area clearance; desktop CTA stays right-aligned */}
        <header className="sticky top-0 z-30 border-b border-[#00f0ff]/25 bg-[#05060a]/92 backdrop-blur-xl pt-safe-header px-safe">
          <div className="flex min-h-[3.5rem] sm:min-h-[4rem] items-center justify-between gap-3 px-4 sm:px-8 py-2">
            <div className="flex items-center gap-2.5 text-sm min-w-0">
              <span className="font-mono text-[11px] font-semibold tracking-wider text-[#00f0ff] uppercase whitespace-nowrap">
                AutoCut AI
              </span>
              <span className="text-[#00f0ff]/40 font-mono" aria-hidden="true">
                /
              </span>
              <h1 className="font-display text-base font-semibold text-[#EEF5FF] truncate">
                {viewTitle}
              </h1>
            </div>

            <div className="hidden md:flex items-center gap-2.5 shrink-0">
              <button
                type="button"
                onClick={handleScanFolder}
                disabled={isScanning}
                className="inline-flex h-9 items-center gap-2 cyber-btn-primary px-4 text-xs disabled:opacity-50 whitespace-nowrap shrink-0"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${isScanning ? 'animate-spin' : ''}`} />
                {isScanning ? 'Escaneando...' : 'Escanear carpeta'}
              </button>
            </div>
          </div>
        </header>

        {/* Main Content */}
        <main className="flex-1 px-4 py-5 sm:px-8 sm:py-7 pb-mobile-nav md:pb-8 max-w-[1280px] w-full mx-auto space-y-5">
          {bannerError && (
            <div
              role="alert"
              className="flex items-start justify-between gap-3 rounded-md border border-[#ff2a85]/50 bg-[#ff2a85]/12 px-4 py-3 text-xs text-[#ffb3d1] shadow-[0_0_20px_rgba(255,42,133,0.14)]"
            >
              <span className="flex items-start gap-2.5 leading-relaxed">
                <AlertCircle className="h-4 w-4 shrink-0 text-[#ff2a85] mt-0.5" />
                <span>{bannerError}</span>
              </span>
              <button
                type="button"
                onClick={() => setBannerError(null)}
                aria-label="Cerrar aviso"
                className="flex h-7 w-7 items-center justify-center rounded-md text-[#ffb3d1] hover:bg-[#ff2a85]/20 hover:text-white shrink-0"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}

          {activeView === 'queue' && (
            <QueueView
              items={items}
              analyticsRecords={analyticsRecords}
              selectedIds={selectedForCombine}
              onToggleSelectItem={handleToggleSelectForCombine}
              onClearSelection={() => setSelectedForCombine([])}
              onOpenMultiClipComposer={() => setMultiClipModalOpen(true)}
              onRemoveItem={handleRemoveQueueItem}
              onClearPending={handleClearPending}
              stylePreset={stylePreset}
              onChangeStylePreset={handleChangeStylePreset}
              customInstruction={customInstruction}
              onChangeCustomInstruction={setCustomInstruction}
              exportQuality={settings.exportQuality}
              onChangeExportQuality={handleChangeExportQuality}
              alreadyEditedCount={alreadyEditedCount}
              lastScanTime={lastScanTime}
              isScanning={isScanning}
              isProcessingAny={isProcessingAny}
              isDriveConnected={Boolean(user && accessToken)}
              folderId={settings.folderId}
              onScanFolder={handleScanFolder}
              onProcessItem={processSingleItem}
              onProcessAllPending={handleProcessAllPending}
              onOpenStudio={(id) => {
                setSelectedStudioId(id);
                setActiveView('studio');
              }}
              onAddLocalFiles={handleAddLocalFiles}
              onLoadDemo={handleLoadDemo}
              onGoToSettings={() => setActiveView('settings')}
            />
          )}

          {activeView === 'gallery' && (
            <GalleryView
              items={items}
              isDriveConnected={Boolean(user && accessToken)}
              restoringDriveId={restoringDriveId}
              onOpenStudio={(id) => {
                setSelectedStudioId(id);
                setActiveView('studio');
              }}
              onRequestDriveUpload={handleRequestDriveUpload}
              onDownloadFromDrive={handleDownloadFromDrive}
              onLoadDemo={handleLoadDemo}
              onGoToQueue={() => setActiveView('queue')}
            />
          )}

          {activeView === 'studio' && (
            <StudioView
              items={items}
              selectedItemId={selectedStudioId}
              onSelectItem={setSelectedStudioId}
              onToggleCut={handleToggleCut}
              onSelectAllCuts={handleSelectAllCuts}
              onRerenderItem={handleRerenderItem}
              onRequestDriveUpload={handleRequestDriveUpload}
              exportQuality={settings.exportQuality}
              onChangeExportQuality={handleChangeExportQuality}
              isRendering={isStudioRendering}
              renderProgress={studioRenderProgress}
              canUploadToDrive={Boolean(user && accessToken && settings.folderId)}
              onBackToQueue={() => setActiveView('queue')}
            />
          )}

          {activeView === 'settings' && (
            <SettingsView
              settings={settings}
              onSaveSettings={persistSettings}
              onResetSettings={() => persistSettings(createDefaultSettings())}
              user={user}
              isLoggingIn={isLoggingIn}
              onGoogleLogin={handleGoogleLogin}
              onGoogleLogout={handleGoogleLogout}
              geminiConfigured={geminiConfigured}
              cacheStats={cacheStats}
              isClearingCache={isClearingCache}
              onClearVideoCache={handleClearVideoCache}
            />
          )}
        </main>
      </div>

      {/* Fixed iOS/Mobile Bottom Tab Bar (< md) */}
      <MobileBottomNav
        activeView={activeView}
        onSelectView={setActiveView}
        queueCounts={queueCounts}
      />

      <MultiClipComposerModal
        open={multiClipModalOpen}
        selectedItems={selectedCombineItems}
        stylePreset={stylePreset}
        onChangeStylePreset={handleChangeStylePreset}
        customInstruction={customInstruction}
        onChangeCustomInstruction={setCustomInstruction}
        exportQuality={settings.exportQuality}
        onChangeExportQuality={handleChangeExportQuality}
        onClose={() => setMultiClipModalOpen(false)}
        onStartCombine={handleStartMultiClipCombine}
        isProcessing={isProcessingAny}
      />

      <DriveConfirmModal
        pendingUpload={pendingDriveUpload}
        onConfirm={handleConfirmDriveUpload}
        onCancel={() => setPendingDriveUpload(null)}
        isUploading={isUploadingToDrive}
      />

      <OfflineIndicator />
    </div>
  );
}
