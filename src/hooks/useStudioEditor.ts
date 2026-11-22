import { useCallback, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type {
  AnalyticsRecord,
  ExportQuality,
  QueueItem,
  TikTokEditOptions,
} from '../types';
import {
  calculateSelectedDuration,
  formatPhaseError,
  toLocalDateKey,
} from '../utils/videoPipeline';
import {
  renderCutsWithFfmpeg,
  renderMultiClipCutsWithFfmpeg,
  type RenderProgress,
} from '../services/ffmpegService';
import { DriveAuthExpiredError, downloadDriveVideo } from '../services/driveApi';
import { getCachedDriveToken } from '../services/googleAuth';
import { logError, logInfo } from '../services/debugLogger';

interface UseStudioEditorOptions {
  itemsRef: MutableRefObject<QueueItem[]>;
  setItems: Dispatch<SetStateAction<QueueItem[]>>;
  updateQueueItem: (itemId: string, patch: Partial<QueueItem>) => void;
  exportQuality: ExportQuality;
  tiktokOptions: TikTokEditOptions;
  accessToken: string | null;
  clearAuthSession: () => void;
  cacheEditedVideo: (itemId: string, blob: Blob, fileName: string) => Promise<void>;
  appendAnalyticsRecord: (record: AnalyticsRecord) => void;
  maybePromptDriveUpload: (itemId: string, fileName: string, sizeBytes: number) => void;
  onError: (message: string | null) => void;
}

export function useStudioEditor({
  itemsRef,
  setItems,
  updateQueueItem,
  exportQuality,
  tiktokOptions,
  accessToken,
  clearAuthSession,
  cacheEditedVideo,
  appendAnalyticsRecord,
  maybePromptDriveUpload,
  onError,
}: UseStudioEditorOptions) {
  const [selectedStudioId, setSelectedStudioId] = useState<string | null>(null);
  const [isStudioRendering, setIsStudioRendering] = useState(false);
  const [studioRenderProgress, setStudioRenderProgress] = useState<RenderProgress | null>(null);

  const handleToggleCut = useCallback(
    (itemId: string, cutId: string) => {
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
    },
    [setItems]
  );

  const handleSelectAllCuts = useCallback(
    (itemId: string, enabled: boolean) => {
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
    },
    [setItems]
  );

  const handleReorderCut = useCallback(
    (itemId: string, cutId: string, direction: -1 | 1) => {
      setItems((prev) =>
        prev.map((item) => {
          if (item.id !== itemId || !item.analysis) return item;
          const cortes = [...item.analysis.cortes];
          const idx = cortes.findIndex((c) => c.id === cutId);
          const targetIdx = idx + direction;
          if (idx < 0 || targetIdx < 0 || targetIdx >= cortes.length) return item;
          const temp = cortes[idx];
          cortes[idx] = cortes[targetIdx];
          cortes[targetIdx] = temp;
          return {
            ...item,
            analysis: {
              ...item.analysis,
              cortes,
            },
          };
        })
      );
    },
    [setItems]
  );

  const handleUpdateCutTiming = useCallback(
    (itemId: string, cutId: string, patch: { start_sec?: number; end_sec?: number }) => {
      setItems((prev) =>
        prev.map((item) => {
          if (item.id !== itemId || !item.analysis) return item;
          return {
            ...item,
            analysis: {
              ...item.analysis,
              cortes: item.analysis.cortes.map((cut) => {
                if (cut.id !== cutId) return cut;
                const clipMax = item.isMultiClip
                  ? item.sourceClips?.[cut.clip_index]?.durationSec
                  : item.durationSec;

                let nextStart =
                  typeof patch.start_sec === 'number' && Number.isFinite(patch.start_sec)
                    ? patch.start_sec
                    : cut.start_sec;
                let nextEnd =
                  typeof patch.end_sec === 'number' && Number.isFinite(patch.end_sec)
                    ? patch.end_sec
                    : cut.end_sec;

                nextStart = Math.max(0, Math.round(nextStart * 10) / 10);
                nextEnd = Math.max(0.2, Math.round(nextEnd * 10) / 10);

                if (clipMax && clipMax > 0.2) {
                  nextEnd = Math.min(nextEnd, Math.round(clipMax * 10) / 10);
                  nextStart = Math.min(nextStart, Math.max(0, Math.round((clipMax - 0.2) * 10) / 10));
                }

                if (patch.start_sec !== undefined && nextStart >= nextEnd - 0.2) {
                  nextStart = Math.max(0, Math.round((nextEnd - 0.2) * 10) / 10);
                } else if (patch.end_sec !== undefined && nextEnd <= nextStart + 0.2) {
                  nextEnd = Math.round((nextStart + 0.2) * 10) / 10;
                  if (clipMax && clipMax > 0.2) {
                    nextEnd = Math.min(nextEnd, Math.round(clipMax * 10) / 10);
                  }
                }

                if (nextEnd <= nextStart) {
                  return cut;
                }

                return {
                  ...cut,
                  start_sec: nextStart,
                  end_sec: nextEnd,
                };
              }),
            },
          };
        })
      );
    },
    [setItems]
  );

  const handleRerenderItem = useCallback(
    async (itemId: string, qualityOverride?: ExportQuality) => {
      const target = itemsRef.current.find((i) => i.id === itemId);
      if (!target || !target.analysis) return;

      const isMulti = Boolean(
        target.isMultiClip &&
          target.sourceClips &&
          target.sourceClips.length > 0 &&
          target.sourceClips.every(
            (c) => Boolean(c.rawBlob) || (c.source === 'drive' && Boolean(c.driveFileId))
          )
      );

      if (!isMulti && !target.rawBlob) return;

      const activeQuality = qualityOverride ?? exportQuality;
      const isFirstRender = !target.completedAt;
      onError(null);
      setIsStudioRendering(true);
      setStudioRenderProgress({
        percent: 5,
        message: isFirstRender
          ? 'Iniciando renderizado final TikTok...'
          : 'Preparando re-renderizado...',
      });

      const renderStartMs = performance.now();
      const activeCutsCount = target.analysis.cortes.filter((c) => c.enabled).length;
      logInfo('FFmpeg', 'Iniciando renderizado de vídeo en Studio', {
        archivo: target.originalName,
        multiClip: isMulti ? 'sí' : 'no',
        clips: isMulti ? target.sourceClips?.length ?? 0 : 1,
        cortesActivos: activeCutsCount,
        calidad: activeQuality === 'mobile_fast' ? '720p' : '1080p',
        subtitulos: tiktokOptions.subtitlesEnabled ? 'sí' : 'no',
        encuadre: tiktokOptions.framingMode,
      });

      try {
        const effectiveTikTokOptions: TikTokEditOptions = { ...tiktokOptions };
        const renderConfig = {
          tiktokOptions: effectiveTikTokOptions,
          subtitles: target.analysis.subtitulos,
          preserveOrder: true,
        };

        updateQueueItem(itemId, {
          exportQuality: activeQuality,
          tiktokOptions: effectiveTikTokOptions,
          stage: 'rendering',
          stageDetail:
            activeQuality === 'mobile_fast'
              ? 'Renderizando vídeo final en 720p móvil...'
              : 'Renderizando vídeo final en 1080p HD TikTok...',
          progress: 5,
        });

        const editedBlob = isMulti
          ? await renderMultiClipCutsWithFfmpeg(
              target.sourceClips!.map((c) => ({
                blob: c.rawBlob,
                originalFileName: c.originalName,
                sizeBytes: c.sizeBytes,
                loadBlob:
                  !c.rawBlob && c.source === 'drive' && c.driveFileId
                    ? async (onDownloadPercent) => {
                        const token = accessToken || getCachedDriveToken();
                        if (!token) {
                          throw new DriveAuthExpiredError(
                            'Inicia sesión con Google Drive para descargar los clips durante el renderizado.'
                          );
                        }
                        return downloadDriveVideo(
                          c.driveFileId!,
                          token,
                          c.sizeBytes,
                          onDownloadPercent
                        );
                      }
                    : undefined,
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
              activeQuality,
              renderConfig
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
              activeQuality,
              renderConfig
            );

        const editedUrl = URL.createObjectURL(editedBlob);
        if (target.editedUrl) {
          URL.revokeObjectURL(target.editedUrl);
        }

        const fileName = target.outputFileName || `${target.originalName}_EDITADO.mp4`;
        const completedAt = Date.now();

        updateQueueItem(itemId, {
          editedBlob,
          editedUrl,
          editedSizeBytes: editedBlob.size,
          cachedInIndexedDb: true,
          stage: 'completed',
          stageDetail: 'Vídeo final renderizado y guardado en caché local (Galería y Estudio)',
          progress: 100,
          completedAt: target.completedAt ?? completedAt,
        });

        await cacheEditedVideo(itemId, editedBlob, fileName);

        const finalDuration = calculateSelectedDuration(target.analysis.cortes);
        appendAnalyticsRecord({
          id: `ana-${itemId}`,
          dateKey: toLocalDateKey(target.completedAt ?? completedAt),
          processedAt: target.completedAt ?? completedAt,
          etiqueta: target.analysis.etiqueta,
          rawDurationSec: target.durationSec || finalDuration,
          editedDurationSec: finalDuration,
          isMultiClip: Boolean(target.isMultiClip),
          clipCount: target.isMultiClip ? target.sourceClips?.length ?? 2 : 1,
        });

        logInfo('FFmpeg', 'Renderizado completado', {
          archivo: fileName,
          salidaMB: Number((editedBlob.size / (1024 * 1024)).toFixed(2)),
          ms: Math.round(performance.now() - renderStartMs),
        });

        if (isFirstRender) {
          maybePromptDriveUpload(itemId, fileName, editedBlob.size);
        }
      } catch (err) {
        if (err instanceof DriveAuthExpiredError) {
          clearAuthSession();
        }
        const phase = err instanceof DriveAuthExpiredError ? 'Drive' : 'FFmpeg';
        const message = formatPhaseError(
          phase,
          err instanceof Error ? err.message : 'Error al renderizar los cortes.'
        );
        console.error('[FFmpeg] Error durante el renderizado en Studio:', err);
        logError(
          phase === 'Drive' ? 'Drive' : 'FFmpeg',
          `Fallo al renderizar ${target.originalName}: ${message}`,
          {
            calidad: activeQuality === 'mobile_fast' ? '720p' : '1080p',
            ms: Math.round(performance.now() - renderStartMs),
          },
          err
        );
        onError(message);
        updateQueueItem(itemId, {
          stage: target.completedAt ? 'completed' : 'review',
          errorMessage: message,
          stageDetail: message,
        });
      } finally {
        setIsStudioRendering(false);
        setStudioRenderProgress(null);
      }
    },
    [
      itemsRef,
      exportQuality,
      tiktokOptions,
      accessToken,
      clearAuthSession,
      updateQueueItem,
      cacheEditedVideo,
      appendAnalyticsRecord,
      maybePromptDriveUpload,
      onError,
    ]
  );

  return {
    selectedStudioId,
    setSelectedStudioId,
    isStudioRendering,
    studioRenderProgress,
    handleToggleCut,
    handleSelectAllCuts,
    handleReorderCut,
    handleUpdateCutTiming,
    handleRerenderItem,
  };
}
