import { useCallback, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { ExportQuality, QueueItem } from '../types';
import {
  renderCutsWithFfmpeg,
  renderMultiClipCutsWithFfmpeg,
  type RenderProgress,
} from '../services/ffmpegService';

interface UseStudioEditorOptions {
  itemsRef: MutableRefObject<QueueItem[]>;
  setItems: Dispatch<SetStateAction<QueueItem[]>>;
  updateQueueItem: (itemId: string, patch: Partial<QueueItem>) => void;
  exportQuality: ExportQuality;
  cacheEditedVideo: (itemId: string, blob: Blob, fileName: string) => Promise<void>;
  onError: (message: string | null) => void;
}

export function useStudioEditor({
  itemsRef,
  setItems,
  updateQueueItem,
  exportQuality,
  cacheEditedVideo,
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

      onError(null);
      setIsStudioRendering(true);
      setStudioRenderProgress({ percent: 5, message: 'Preparando re-renderizado...' });

      try {
        const activeQuality = exportQuality;
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
        onError(message);
        updateQueueItem(itemId, {
          stage: 'error',
          errorMessage: message,
        });
      } finally {
        setIsStudioRendering(false);
        setStudioRenderProgress(null);
      }
    },
    [itemsRef, exportQuality, updateQueueItem, cacheEditedVideo, onError]
  );

  return {
    selectedStudioId,
    setSelectedStudioId,
    isStudioRendering,
    studioRenderProgress,
    handleToggleCut,
    handleSelectAllCuts,
    handleRerenderItem,
  };
}
