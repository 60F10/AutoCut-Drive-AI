import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  BookOpen,
  Captions,
  CheckCircle2,
  CheckSquare,
  ChevronDown,
  ChevronUp,
  Cloud,
  CloudUpload,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  Film,
  Loader2,
  Monitor,
  Pause,
  Play,
  RefreshCw,
  RotateCw,
  Scissors,
  Settings,
  Smartphone,
  Sparkles,
  Square,
  Star,
  Trash2,
  Wand2,
  Zap,
} from 'lucide-react';
import type {
  ExportQuality,
  PlanCutFunction,
  QueueItem,
  RenderJobTarget,
  TikTokEditOptions,
} from '../types';
import {
  buildCombinedEditedFilename,
  buildEditedFilename,
  buildSrtSubtitles,
  calculateSelectedDuration,
  evaluateMultiClipMobileRamProtection,
  filterEditedCuts,
  formatBytes,
  formatPcJobStatusLabel,
  formatSeconds,
  getBaseName,
  isMobileViewportOrUserAgent,
  remapSubtitlesToFinalTimeline,
  shouldRecommendPcRender,
} from '../utils/videoPipeline';
import { canFallbackPcJobToCloud } from '../utils/remoteJobsSync';

interface StudioViewProps {
  items: QueueItem[];
  selectedItemId: string | null;
  onSelectItem: (id: string) => void;
  onToggleCut: (itemId: string, cutId: string) => void;
  onToggleOverlay?: (itemId: string, overlayId: string) => void;
  onDeleteOverlay?: (itemId: string, overlayId: string) => void;
  onSelectAllCuts: (itemId: string, enabled: boolean) => void;
  onReorderCut: (itemId: string, cutId: string, direction: -1 | 1) => void;
  onUpdateCutTiming: (
    itemId: string,
    cutId: string,
    patch: { start_sec?: number; end_sec?: number }
  ) => void;
  onRerenderItem: (itemId: string, qualityOverride?: ExportQuality) => void;
  onRenderRemote: (itemId: string) => void;
  onSendToCloud: (itemId: string) => void;
  onSendToPc: (itemId: string) => void;
  onRedoStory: (itemId: string, instruction: string) => void;
  onRetryCloudDispatch: (jobFileId: string) => void;
  onFallbackPcJobToCloud: (jobFileId: string, kind: 'render' | 'analyze') => void;
  cloudRenderConfigured: boolean;
  isPcOnline: boolean;
  resolvedTarget: RenderJobTarget;
  isSendingToPc: boolean;
  isSendingAnalyze: boolean;
  sendingTarget: RenderJobTarget | null;
  cloudUploadProgress: {
    clipIndex: number;
    totalClips: number;
    percent: number;
    message: string;
  } | null;
  lastSentPcJob: {
    itemId: string;
    jobId: string;
    jobFileId: string;
    target: RenderJobTarget;
    outputFileName: string;
  } | null;
  failedDispatchJobFileIds: Record<string, string>;
  retryingDispatchJobFileId: string | null;
  fallingBackJobFileId: string | null;
  onRequestDriveUpload: (itemId: string) => void;
  exportQuality: ExportQuality;
  onChangeExportQuality: (quality: ExportQuality) => void;
  tiktokOptions: TikTokEditOptions;
  onChangeTikTokOptions: (patch: Partial<TikTokEditOptions>) => void;
  isRendering: boolean;
  renderProgress: { percent: number; message: string } | null;
  canUploadToDrive: boolean;
  onBackToQueue: () => void;
  onGoToGallery: () => void;
  onGoToSettings: () => void;
}

const CUT_FUNCTION_META: Record<
  PlanCutFunction,
  { label: string; className: string }
> = {
  gancho: {
    label: 'Gancho',
    className: 'border-[#ff2a85]/60 bg-[#ff2a85]/16 text-[#ff85b8]',
  },
  contexto: {
    label: 'Contexto',
    className: 'border-[#00f0ff]/45 bg-[#00f0ff]/12 text-[#7df7ff]',
  },
  desarrollo: {
    label: 'Desarrollo',
    className: 'border-[#8EA2BD]/45 bg-[#8EA2BD]/12 text-[#C8D7EC]',
  },
  climax: {
    label: 'Clímax',
    className: 'border-[#fcee0a]/60 bg-[#fcee0a]/15 text-[#fcee0a]',
  },
  remate: {
    label: 'Remate',
    className: 'border-[#ff2a85]/55 bg-[#ff2a85]/14 text-[#ffb3d1]',
  },
  cierre: {
    label: 'Cierre',
    className: 'border-[#00f0ff]/55 bg-[#00f0ff]/15 text-[#00f0ff]',
  },
  recurso: {
    label: 'Recurso',
    className: 'border-[#a855f7]/55 bg-[#a855f7]/15 text-[#d8b4fe]',
  },
};

export function OverlayThumbnail({
  videoUrl,
  seekSec,
  clipIndex,
}: {
  videoUrl?: string;
  seekSec: number;
  clipIndex: number;
}) {
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!videoUrl) {
      setThumbUrl(null);
      return;
    }
    let cancelled = false;
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.src = videoUrl;

    const cleanup = () => {
      video.removeAttribute('src');
      video.load();
    };

    const capture = () => {
      if (cancelled || video.videoWidth <= 0 || video.videoHeight <= 0) {
        cleanup();
        return;
      }
      try {
        const canvas = document.createElement('canvas');
        const targetH = 96;
        const targetW = Math.max(54, Math.round((video.videoWidth / video.videoHeight) * targetH));
        canvas.width = targetW;
        canvas.height = targetH;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(video, 0, 0, targetW, targetH);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.65);
          if (!cancelled) setThumbUrl(dataUrl);
        }
      } catch {
        // Fallback to styled badge
      } finally {
        cleanup();
      }
    };

    video.onloadedmetadata = () => {
      const targetTime = Math.max(
        0,
        Math.min(Number.isFinite(video.duration) ? Math.max(0, video.duration - 0.1) : seekSec, seekSec)
      );
      video.currentTime = targetTime;
    };
    video.onseeked = capture;
    video.onerror = cleanup;

    return () => {
      cancelled = true;
      cleanup();
    };
  }, [videoUrl, seekSec]);

  if (thumbUrl) {
    return (
      <img
        src={thumbUrl}
        alt={`Miniatura recurso Clip ${clipIndex + 1} en ${formatSeconds(seekSec)}`}
        className="h-14 w-11 shrink-0 rounded-sm border border-[#a855f7]/45 object-cover bg-[#05060a]"
      />
    );
  }

  return (
    <div
      aria-hidden="true"
      className="flex h-14 w-11 shrink-0 flex-col items-center justify-center gap-0.5 rounded-sm border border-[#a855f7]/40 bg-[#a855f7]/12 text-[#d8b4fe]"
    >
      <Film className="h-3.5 w-3.5" />
      <span className="font-mono text-[9px] font-semibold">C{clipIndex + 1}</span>
    </div>
  );
}

export function StudioView({
  items,
  selectedItemId,
  onSelectItem,
  onToggleCut,
  onToggleOverlay,
  onDeleteOverlay,
  onSelectAllCuts,
  onReorderCut,
  onUpdateCutTiming,
  onRerenderItem,
  onRenderRemote,
  onSendToCloud,
  onSendToPc,
  onRedoStory,
  onRetryCloudDispatch,
  onFallbackPcJobToCloud,
  cloudRenderConfigured,
  isPcOnline,
  resolvedTarget,
  isSendingToPc,
  isSendingAnalyze,
  sendingTarget,
  cloudUploadProgress,
  lastSentPcJob,
  failedDispatchJobFileIds,
  retryingDispatchJobFileId,
  fallingBackJobFileId,
  onRequestDriveUpload,
  exportQuality,
  onChangeExportQuality,
  tiktokOptions,
  onChangeTikTokOptions,
  isRendering,
  renderProgress,
  canUploadToDrive,
  onBackToQueue,
  onGoToGallery,
  onGoToSettings,
}: StudioViewProps) {
  const analyzedItems = useMemo(() => items.filter((i) => Boolean(i.analysis)), [items]);
  const currentItem = useMemo(
    () => analyzedItems.find((i) => i.id === selectedItemId) ?? analyzedItems[0] ?? null,
    [analyzedItems, selectedItemId]
  );

  const videoRef = useRef<HTMLVideoElement>(null);
  const [activeCutId, setActiveCutId] = useState<string | null>(null);
  const [demoPlaying, setDemoPlaying] = useState(false);
  const [demoCutIndex, setDemoCutIndex] = useState(0);
  const [showOtherRenderOptions, setShowOtherRenderOptions] = useState(false);
  const [showFullScript, setShowFullScript] = useState(false);
  const [showRedoStory, setShowRedoStory] = useState(false);
  const [redoInstruction, setRedoInstruction] = useState('');

  const enabledCuts = useMemo(
    () => (currentItem?.analysis?.cortes ?? []).filter((c) => c.enabled),
    [currentItem]
  );

  const selectedDurationSec = useMemo(
    () => (currentItem?.analysis ? calculateSelectedDuration(currentItem.analysis.cortes) : 0),
    [currentItem]
  );

  const remappedSubtitles = useMemo(() => {
    const rawSubs = currentItem?.analysis?.subtitulos;
    if (!rawSubs || rawSubs.length === 0 || !currentItem?.analysis) return [];
    const activeOrdered = filterEditedCuts(currentItem.analysis.cortes, true);
    return remapSubtitlesToFinalTimeline(rawSubs, activeOrdered);
  }, [currentItem]);

  const timelineMeta = useMemo(() => {
    if (!currentItem) {
      return { totalSec: 60, clipOffsets: [0] };
    }
    const cuts = currentItem.analysis?.cortes ?? [];
    if (!currentItem.isMultiClip) {
      const total =
        currentItem.durationSec && currentItem.durationSec > 0
          ? currentItem.durationSec
          : Math.max(...cuts.map((c) => c.end_sec), 1) * 1.1;
      return { totalSec: Math.max(total, 1), clipOffsets: [0] };
    }

    const maxCutClipIdx = cuts.reduce((max, c) => Math.max(max, c.clip_index ?? 0), 0);
    const clipCount = Math.max(currentItem.sourceClips?.length ?? 0, maxCutClipIdx + 1, 1);

    const clipOffsets: number[] = [];
    let runningTotal = 0;

    for (let i = 0; i < clipCount; i += 1) {
      clipOffsets.push(runningTotal);
      const declaredDuration = currentItem.sourceClips?.[i]?.durationSec ?? 0;
      const maxEndForClip = cuts
        .filter((c) => (c.clip_index ?? 0) === i)
        .reduce((max, c) => Math.max(max, c.end_sec), 0);
      const clipDuration =
        declaredDuration > 0
          ? Math.max(declaredDuration, maxEndForClip)
          : Math.max(maxEndForClip * 1.15, 30);
      runningTotal += clipDuration;
    }

    return {
      totalSec: Math.max(runningTotal, 1),
      clipOffsets,
    };
  }, [currentItem]);

  useEffect(() => {
    setDemoPlaying(false);
    setDemoCutIndex(0);
    setActiveCutId(enabledCuts[0]?.id ?? null);
    setShowFullScript(false);
    setShowRedoStory(false);
    setRedoInstruction(currentItem?.customInstruction ?? '');
  }, [currentItem?.id]);

  useEffect(() => {
    if (!demoPlaying || !currentItem || currentItem.editedUrl || enabledCuts.length === 0) {
      return;
    }
    const timer = window.setInterval(() => {
      setDemoCutIndex((prev) => {
        const next = (prev + 1) % enabledCuts.length;
        setActiveCutId(enabledCuts[next]?.id ?? null);
        return next;
      });
    }, 2200);
    return () => window.clearInterval(timer);
  }, [demoPlaying, currentItem, enabledCuts]);

  if (!currentItem || !currentItem.analysis) {
    return (
      <div className="cyber-panel rounded-md px-6 py-16 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-md border border-[#00f0ff]/30 bg-[#05060a] text-[#00f0ff]">
          <Film className="h-5 w-5" />
        </div>
        <h2 className="mt-4 font-display text-lg font-semibold text-[#EEF5FF]">
          Ningún vídeo analizado seleccionado
        </h2>
        <p className="mx-auto mt-2 max-w-md text-sm text-[#94A8C4]">
          Procesa un vídeo desde tu carpeta de Google Drive o carga una sesión de ejemplo en la cola para revisar, ajustar y renderizar los cortes aquí.
        </p>
        <button
          type="button"
          onClick={onBackToQueue}
          className="cyber-btn-primary mt-6 inline-flex h-11 items-center gap-2 px-5 text-sm whitespace-nowrap"
        >
          Volver a la cola
        </button>
      </div>
    );
  }

  const plan = currentItem.analysis;
  const targetOutputName =
    currentItem.outputFileName ||
    (currentItem.isMultiClip
      ? buildCombinedEditedFilename(currentItem.projectName || currentItem.originalName, plan.etiqueta)
      : buildEditedFilename(currentItem.originalName, plan.etiqueta));
  const allEnabled = plan.cortes.every((c) => c.enabled);
  const hasRealSource = currentItem.isMultiClip
    ? Boolean(
        currentItem.sourceClips &&
          currentItem.sourceClips.length > 0 &&
          currentItem.sourceClips.every(
            (c) => Boolean(c.rawBlob) || (c.source === 'drive' && Boolean(c.driveFileId))
          )
      )
    : Boolean(currentItem.rawBlob);
  const multiClipMobileGuard = currentItem.isMultiClip
    ? evaluateMultiClipMobileRamProtection({
        clipCount: currentItem.sourceClips?.length ?? 0,
        totalBytes: currentItem.sizeBytes || 0,
        exportQuality,
        isMobile: isMobileViewportOrUserAgent(),
      })
    : { shouldWarn: false, clipCount: 1, totalBytes: currentItem.sizeBytes || 0, reason: null };
  const isPendingFinalRender = currentItem.stage === 'review' || !currentItem.editedUrl;
  const isPcRenderRecommended = shouldRecommendPcRender({
    sizeBytes: currentItem.sizeBytes,
    isMultiClip: currentItem.isMultiClip,
  });
  const activePcJobId =
    (lastSentPcJob?.itemId === currentItem.id ? lastSentPcJob.jobId : undefined) ||
    currentItem.pcJobId;
  const activeJobFileId =
    (lastSentPcJob?.itemId === currentItem.id ? lastSentPcJob.jobFileId : undefined) ||
    currentItem.pcJobFileId;
  const activePcTarget: RenderJobTarget =
    (lastSentPcJob?.itemId === currentItem.id ? lastSentPcJob.target : undefined) ||
    currentItem.pcJobTarget ||
    'pc';
  const activePcStatus = currentItem.pcJobStatus || (activePcJobId ? 'pending' : undefined);
  const activeDispatchError = activeJobFileId ? failedDispatchJobFileIds[activeJobFileId] : undefined;
  const isSendingCloud = isSendingToPc && sendingTarget === 'cloud';
  const isSendingPc = isSendingToPc && sendingTarget === 'pc';
  const hasWordLevelSubtitles = Boolean(plan.cortes.some((c) => c.words && c.words.length > 0));
  const hasGeneratedSubtitles = Boolean(
    (plan.subtitulos && plan.subtitulos.length > 0) || hasWordLevelSubtitles
  );
  const hasCloudStoryInfo = Boolean(
    plan.gancho || plan.historia || plan.guionResultante || plan.revision
  );
  const activeDemoCut =
    enabledCuts.find((c) => c.id === activeCutId) ?? enabledCuts[demoCutIndex] ?? plan.cortes[0];

  const getClipDisplayLabel = (clipIndex: number): { short: string; name?: string } => {
    const safeIdx = Math.max(0, clipIndex || 0);
    const source = currentItem.sourceClips?.[safeIdx];
    return {
      short: `Clip ${safeIdx + 1}`,
      name: source?.originalName,
    };
  };

  const handleJumpToCut = (cutId: string) => {
    setActiveCutId(cutId);
    const enabledIdx = enabledCuts.findIndex((c) => c.id === cutId);
    if (enabledIdx >= 0) {
      setDemoCutIndex(enabledIdx);
    }

    if (videoRef.current && currentItem.editedUrl && enabledIdx >= 0) {
      let offset = 0;
      for (let i = 0; i < enabledIdx; i += 1) {
        offset += enabledCuts[i].end_sec - enabledCuts[i].start_sec;
      }
      videoRef.current.currentTime = offset;
      videoRef.current.play().catch(() => {});
    } else if (videoRef.current && currentItem.rawUrl && !currentItem.editedUrl) {
      const cut = plan.cortes.find((c) => c.id === cutId);
      if (cut) {
        videoRef.current.currentTime = cut.start_sec;
        videoRef.current.play().catch(() => {});
      }
    }
  };

  const handleDownloadEdited = () => {
    if (!currentItem.editedUrl) return;
    const anchor = document.createElement('a');
    anchor.href = currentItem.editedUrl;
    anchor.download = targetOutputName;
    anchor.click();
  };

  const handleDownloadSrt = () => {
    if (remappedSubtitles.length === 0) return;
    const srtText = buildSrtSubtitles(remappedSubtitles);
    const blob = new Blob([srtText], { type: 'application/x-subrip;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${getBaseName(targetOutputName)}.srt`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="space-y-5">
      {/* Item Switcher when multiple analyzed videos exist */}
      {analyzedItems.length > 1 && (
        <div className="flex items-center gap-2 overflow-x-auto pb-1">
          {analyzedItems.map((item) => {
            const active = item.id === currentItem.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelectItem(item.id)}
                className={`min-h-[38px] rounded-md px-3 py-1.5 font-mono text-xs font-medium border transition-colors whitespace-nowrap shrink-0 ${
                  active
                    ? 'border-[#00f0ff] bg-[#00f0ff]/12 text-[#00f0ff]'
                    : 'border-[#00f0ff]/20 bg-[#0c0f1a]/90 text-[#8EA2BD] hover:border-[#00f0ff]/45 hover:text-white'
                }`}
              >
                {item.stage === 'review' ? '● ' : ''}
                {item.originalName}
              </button>
            );
          })}
        </div>
      )}

      {/* Pre-render EDL Review Banner */}
      {currentItem.stage === 'review' && (
        <div
          role="status"
          data-testid="edl-review-banner"
          className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-[#fcee0a]/45 bg-[#fcee0a]/[0.08] px-4 py-3 text-xs text-[#FEF08A]"
        >
          <span className="flex items-center gap-2.5 leading-relaxed">
            <Sparkles className="h-4 w-4 text-[#fcee0a] shrink-0" />
            <span>
              <strong className="text-[#fcee0a]">Previsualización EDL lista:</strong> activa o desactiva cortes, cambia el orden o ajusta inicio y fin antes de lanzar el renderizado MP4 en FFmpeg.wasm.
            </span>
          </span>
        </div>
      )}

      {/* Balanced 2-column Studio Split */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-stretch">
        {/* Left Column: 9:16 Vertical Preview Stage */}
        <section className="xl:col-span-5 cyber-panel flex flex-col rounded-md p-5">
          <div className="flex items-center justify-between gap-2 pb-4 border-b border-[#00f0ff]/20">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="font-display text-sm font-semibold text-[#EEF5FF]">
                  Vista previa vertical (9:16)
                </h2>
                <span
                  data-testid="studio-render-status"
                  className={`font-mono text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-sm border ${
                    currentItem.editedUrl
                      ? 'border-[#00f0ff]/40 bg-[#00f0ff]/10 text-[#00f0ff]'
                      : 'border-[#fcee0a]/40 bg-[#fcee0a]/10 text-[#fcee0a]'
                  }`}
                >
                  {currentItem.editedUrl ? 'MP4 listo' : 'Pre-render EDL'}
                </span>
              </div>
              <p className="text-xs text-[#8EA2BD] font-mono truncate max-w-[260px] mt-0.5">
                {targetOutputName}
              </p>
            </div>
            <span className="font-mono text-xs font-semibold tabular-nums text-[#00f0ff] shrink-0">
              {formatSeconds(selectedDurationSec)}
            </span>
          </div>

          {/* 9:16 Frame */}
          <div className="my-5 flex justify-center">
            <div className="relative w-full max-w-[280px] aspect-[9/16] overflow-hidden rounded-md border border-[#00f0ff]/35 bg-[#05060a] flex flex-col shadow-[0_0_24px_rgba(0,240,255,0.1)]">
              {currentItem.editedUrl ? (
                <video
                  ref={videoRef}
                  src={currentItem.editedUrl}
                  controls
                  playsInline
                  className="h-full w-full object-contain bg-black"
                />
              ) : currentItem.rawUrl ? (
                <video
                  ref={videoRef}
                  src={currentItem.rawUrl}
                  controls
                  playsInline
                  className="h-full w-full object-contain bg-black"
                />
              ) : (
                <div className="relative flex h-full w-full flex-col justify-between bg-gradient-to-b from-[#0e1424] via-[#080a12] to-[#05060a] p-4">
                  <div className="flex items-center justify-between text-[11px] font-mono text-[#8EA2BD]">
                    <span>
                      9:16 · {tiktokOptions.framingMode === 'blur_pad' ? 'Blur' : 'Crop'}
                    </span>
                    <span className="tabular-nums text-[#00f0ff]">
                      {activeDemoCut
                        ? `${formatSeconds(activeDemoCut.start_sec)} – ${formatSeconds(activeDemoCut.end_sec)}`
                        : '0:00.0'}
                    </span>
                  </div>

                  <div className="my-auto space-y-3 text-center px-2">
                    <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-md border border-[#ff2a85]/45 bg-[#ff2a85]/10">
                      <Scissors className="h-5 w-5 text-[#ff2a85]" />
                    </div>
                    {currentItem.isMultiClip && activeDemoCut && (
                      <p className="font-mono text-[11px] font-medium text-[#fcee0a]">
                        {getClipDisplayLabel(activeDemoCut.clip_index).short}
                        {getClipDisplayLabel(activeDemoCut.clip_index).name
                          ? ` · ${getClipDisplayLabel(activeDemoCut.clip_index).name}`
                          : ''}
                      </p>
                    )}
                    <p className="font-display text-sm font-semibold text-white">
                      {plan.titulo_interno}
                    </p>
                    {activeDemoCut ? (
                      <p className="text-xs leading-relaxed text-[#C8D7EC]">
                        {activeDemoCut.motivo}
                      </p>
                    ) : (
                      <p className="text-xs text-[#8EA2BD]">
                        Activa al menos un corte para previsualizar.
                      </p>
                    )}
                  </div>

                  <div className="space-y-3 bg-gradient-to-t from-black/85 via-black/45 to-transparent pt-4">
                    <div className="flex items-center justify-between text-[11px] font-mono text-[#8EA2BD]">
                      <span>Sesión de muestra</span>
                      <span className="tabular-nums text-[#fcee0a]">
                        Corte {enabledCuts.length > 0 ? demoCutIndex + 1 : 0}/{enabledCuts.length}
                      </span>
                    </div>
                    <button
                      type="button"
                      disabled={enabledCuts.length === 0}
                      onClick={() => setDemoPlaying((prev) => !prev)}
                      className="flex w-full min-h-[40px] items-center justify-center gap-2 rounded-md border border-[#00f0ff]/35 bg-[#00f0ff]/12 px-3 py-2 text-xs font-medium text-[#00f0ff] hover:bg-[#00f0ff]/20 disabled:opacity-40 transition-colors"
                    >
                      {demoPlaying ? (
                        <>
                          <Pause className="h-3.5 w-3.5" />
                          Pausar vista previa
                        </>
                      ) : (
                        <>
                          <Play className="h-3.5 w-3.5 fill-current" />
                          Simular secuencia de cortes
                        </>
                      )}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* FFmpeg Energy Render Progress Bar */}
          {isRendering && renderProgress && (
            <div className="mb-4 rounded-md border border-[#00f0ff]/30 bg-[#05060a] p-3 space-y-2">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="flex items-center gap-2 text-[#EEF5FF] truncate">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-[#fcee0a] shrink-0" />
                  <span className="truncate">{renderProgress.message}</span>
                </span>
                <span className="font-mono font-semibold tabular-nums text-[#fcee0a] shrink-0">
                  {renderProgress.percent}%
                </span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-sm border border-[#00f0ff]/25 bg-[#0c0f1a]">
                <div
                  className="h-full cyber-energy-bar transition-transform duration-150 origin-left"
                  style={{ transform: `scaleX(${Math.max(0.04, renderProgress.percent / 100)})` }}
                />
              </div>
            </div>
          )}

          {/* Action & Export Pipeline Controls */}
          <div className="mt-auto space-y-2.5">
            {/* Quick Render Quality + Framing + Audio Controls */}
            <div className="rounded-md border border-[#00f0ff]/25 bg-[#05060a] p-2.5 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-medium text-[#8EA2BD]">Salida FFmpeg</span>
                <div
                  role="group"
                  aria-label="Calidad de renderizado en Estudio"
                  className="inline-flex items-center gap-1"
                >
                  <button
                    type="button"
                    onClick={() => onChangeExportQuality('mobile_fast')}
                    aria-pressed={exportQuality === 'mobile_fast'}
                    className={`min-h-[30px] rounded-sm px-2 py-0.5 font-mono text-[11px] font-medium transition-colors whitespace-nowrap ${
                      exportQuality === 'mobile_fast'
                        ? 'bg-[#00f0ff]/18 text-[#00f0ff] border border-[#00f0ff]/45'
                        : 'text-[#8EA2BD] hover:text-white border border-transparent'
                    }`}
                  >
                    720p móvil
                  </button>
                  <button
                    type="button"
                    onClick={() => onChangeExportQuality('high_1080p')}
                    aria-pressed={exportQuality === 'high_1080p'}
                    className={`min-h-[30px] rounded-sm px-2 py-0.5 font-mono text-[11px] font-medium transition-colors whitespace-nowrap ${
                      exportQuality === 'high_1080p'
                        ? 'bg-[#00f0ff]/18 text-[#00f0ff] border border-[#00f0ff]/45'
                        : 'text-[#8EA2BD] hover:text-white border border-transparent'
                    }`}
                  >
                    1080p HD
                  </button>
                </div>
              </div>

              <div className="flex items-center justify-between gap-2 pt-2 border-t border-[#00f0ff]/12">
                <span className="text-[11px] font-medium text-[#8EA2BD]">Encuadre 9:16</span>
                <div
                  role="group"
                  aria-label="Encuadre 9:16 en Estudio"
                  className="inline-flex items-center gap-1"
                >
                  <button
                    type="button"
                    onClick={() => onChangeTikTokOptions({ framingMode: 'center_crop' })}
                    aria-pressed={tiktokOptions.framingMode === 'center_crop'}
                    className={`min-h-[30px] rounded-sm px-2 py-0.5 font-mono text-[11px] font-medium transition-colors whitespace-nowrap ${
                      tiktokOptions.framingMode === 'center_crop'
                        ? 'bg-[#00f0ff]/18 text-[#00f0ff] border border-[#00f0ff]/45'
                        : 'text-[#8EA2BD] hover:text-white border border-transparent'
                    }`}
                  >
                    Recorte
                  </button>
                  <button
                    type="button"
                    onClick={() => onChangeTikTokOptions({ framingMode: 'blur_pad' })}
                    aria-pressed={tiktokOptions.framingMode === 'blur_pad'}
                    className={`min-h-[30px] rounded-sm px-2 py-0.5 font-mono text-[11px] font-medium transition-colors whitespace-nowrap ${
                      tiktokOptions.framingMode === 'blur_pad'
                        ? 'bg-[#00f0ff]/18 text-[#00f0ff] border border-[#00f0ff]/45'
                        : 'text-[#8EA2BD] hover:text-white border border-transparent'
                    }`}
                  >
                    Fondo blur
                  </button>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-1.5 pt-2 border-t border-[#00f0ff]/12">
                <button
                  type="button"
                  role="switch"
                  aria-checked={tiktokOptions.silenceTrimEnabled}
                  onClick={() =>
                    onChangeTikTokOptions({ silenceTrimEnabled: !tiktokOptions.silenceTrimEnabled })
                  }
                  className={`min-h-[28px] rounded-sm border px-2 py-0.5 font-mono text-[10px] font-medium transition-colors ${
                    tiktokOptions.silenceTrimEnabled
                      ? 'border-[#00f0ff]/50 bg-[#00f0ff]/12 text-[#00f0ff]'
                      : 'border-[#00f0ff]/15 text-[#7A8EA8] hover:text-[#EEF5FF]'
                  }`}
                >
                  Silencios: {tiktokOptions.silenceTrimEnabled ? 'ON' : 'OFF'}
                </button>

                <button
                  type="button"
                  role="switch"
                  aria-checked={tiktokOptions.audioNormalizeEnabled}
                  onClick={() =>
                    onChangeTikTokOptions({
                      audioNormalizeEnabled: !tiktokOptions.audioNormalizeEnabled,
                    })
                  }
                  className={`min-h-[28px] rounded-sm border px-2 py-0.5 font-mono text-[10px] font-medium transition-colors ${
                    tiktokOptions.audioNormalizeEnabled
                      ? 'border-[#fcee0a]/50 bg-[#fcee0a]/10 text-[#fcee0a]'
                      : 'border-[#00f0ff]/15 text-[#7A8EA8] hover:text-[#EEF5FF]'
                  }`}
                >
                  -14 LUFS: {tiktokOptions.audioNormalizeEnabled ? 'ON' : 'OFF'}
                </button>

                <button
                  type="button"
                  role="switch"
                  aria-checked={tiktokOptions.subtitlesEnabled && hasGeneratedSubtitles}
                  disabled={!hasGeneratedSubtitles}
                  title={
                    hasGeneratedSubtitles
                      ? 'Quemar subtítulos en el MP4 final'
                      : 'Activa "Subtítulos automáticos" antes de analizar con Gemini para generarlos'
                  }
                  onClick={() =>
                    onChangeTikTokOptions({ subtitlesEnabled: !tiktokOptions.subtitlesEnabled })
                  }
                  className={`min-h-[28px] rounded-sm border px-2 py-0.5 font-mono text-[10px] font-medium transition-colors disabled:opacity-45 ${
                    tiktokOptions.subtitlesEnabled && hasGeneratedSubtitles
                      ? 'border-[#ff2a85]/60 bg-[#ff2a85]/15 text-[#ff85b8]'
                      : 'border-[#00f0ff]/15 text-[#7A8EA8] hover:text-[#EEF5FF]'
                  }`}
                >
                  Subtítulos:{' '}
                  {hasGeneratedSubtitles
                    ? tiktokOptions.subtitlesEnabled
                      ? 'ON'
                      : 'OFF'
                    : 'No solicitados'}
                </button>
              </div>
            </div>

            {/* Primary CTA: Auto-routed Remote Render (PC primary + Cloud fallback) */}
            <div className="rounded-md border border-[#00f0ff]/45 bg-[#00f0ff]/[0.06] p-3 space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-1.5">
                <span className="inline-flex items-center gap-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-[#00f0ff]">
                  {resolvedTarget === 'pc' ? (
                    <>
                      <Monitor className="h-3.5 w-3.5" />
                      PC Windows · GPU local · 0 €
                    </>
                  ) : (
                    <>
                      <Cloud className="h-3.5 w-3.5" />
                      GitHub Actions · Respaldo nube · 0 €
                    </>
                  )}
                </span>
                {isPcRenderRecommended && (
                  <span
                    data-testid="studio-pc-recommended-tag"
                    className="font-mono text-[10px] font-semibold px-1.5 py-0.5 rounded-sm border border-[#fcee0a]/60 bg-[#fcee0a]/15 text-[#fcee0a]"
                  >
                    Ideal para &gt;100 MB / Multi-Clip
                  </span>
                )}
              </div>

              <button
                type="button"
                data-testid="studio-render-cloud-btn"
                onClick={() => onRenderRemote(currentItem.id)}
                disabled={
                  (resolvedTarget === 'cloud' && !cloudRenderConfigured) ||
                  isSendingToPc ||
                  enabledCuts.length === 0 ||
                  !canUploadToDrive
                }
                title={
                  resolvedTarget === 'cloud' && !cloudRenderConfigured
                    ? 'Enciende tu PC o configura GITHUB_DISPATCH_TOKEN y GITHUB_REPO en Secrets (ver Ajustes)'
                    : !canUploadToDrive
                    ? 'Conecta Google Drive y configura tu carpeta en Ajustes para lanzar el render remoto'
                    : resolvedTarget === 'pc'
                    ? 'Renderiza con FFmpeg nativo y GPU en tu PC Windows'
                    : 'Renderiza con FFmpeg nativo en GitHub Actions sin gastar RAM del móvil'
                }
                className="cyber-btn-primary flex min-h-[46px] w-full items-center justify-center gap-2 px-3.5 py-2 text-xs sm:text-sm font-semibold disabled:opacity-45 transition-colors"
              >
                {resolvedTarget === 'cloud' && !cloudRenderConfigured ? (
                  <>
                    <Settings className="h-4 w-4 shrink-0" />
                    Configura el render en la nube (ver Ajustes)
                  </>
                ) : isSendingToPc ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin shrink-0" />
                    {cloudUploadProgress
                      ? `Subiendo clip ${cloudUploadProgress.clipIndex}/${cloudUploadProgress.totalClips} (${cloudUploadProgress.percent}%)...`
                      : sendingTarget === 'pc'
                      ? 'Enviando al PC...'
                      : 'Enviando a la nube...'}
                  </>
                ) : (
                  <>
                    {resolvedTarget === 'pc' ? (
                      <Monitor className="h-4 w-4 shrink-0" />
                    ) : (
                      <Cloud className="h-4 w-4 shrink-0" />
                    )}
                    <span>Renderizar</span>
                    <span
                      data-testid="studio-render-target-badge"
                      className="rounded-sm border border-black/30 bg-black/25 px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider"
                    >
                      {resolvedTarget === 'pc' ? 'PC' : 'NUBE'}
                    </span>
                  </>
                )}
              </button>

              {resolvedTarget === 'cloud' && !cloudRenderConfigured && (
                <button
                  type="button"
                  data-testid="studio-open-cloud-settings-btn"
                  onClick={onGoToSettings}
                  className="w-full text-center font-mono text-[11px] font-semibold text-[#00f0ff] hover:underline"
                >
                  Abrir guía en Ajustes →
                </button>
              )}

              {cloudUploadProgress && (
                <div
                  data-testid="studio-cloud-upload-progress"
                  className="rounded-sm border border-[#00f0ff]/35 bg-[#05060a] p-2.5 space-y-1.5"
                >
                  <div className="flex items-center justify-between gap-2 font-mono text-[11px]">
                    <span className="text-[#C8D7EC] truncate">{cloudUploadProgress.message}</span>
                    <span className="text-[#fcee0a] font-semibold tabular-nums shrink-0">
                      {cloudUploadProgress.percent}%
                    </span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-sm border border-[#00f0ff]/25 bg-[#0c0f1a]">
                    <div
                      className="h-full cyber-energy-bar transition-transform duration-150 origin-left"
                      style={{
                        transform: `scaleX(${Math.max(0.04, cloudUploadProgress.percent / 100)})`,
                      }}
                    />
                  </div>
                </div>
              )}

              {activePcJobId && activePcStatus && (
                <div
                  role="status"
                  data-testid="studio-pc-sent-banner"
                  className="rounded-sm border border-[#00f0ff]/35 bg-[#05060a]/90 px-3 py-2 text-[11px] space-y-1.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1.5 font-mono font-semibold text-[#00f0ff]">
                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                      {activePcTarget === 'cloud' ? 'Enviado a la nube' : 'Enviado a PC'}
                    </span>
                    <span className="font-mono text-[#fcee0a]">
                      {formatPcJobStatusLabel(
                        activePcStatus,
                        currentItem.pcJobProgress,
                        activePcTarget
                      )}
                    </span>
                  </div>
                  <p className="font-mono text-[10px] text-[#8EA2BD] truncate">
                    job_{activePcJobId}.json → {targetOutputName}
                  </p>
                  {activePcTarget === 'pc' &&
                    activeJobFileId &&
                    cloudRenderConfigured &&
                    canFallbackPcJobToCloud({
                      target: 'pc',
                      status: activePcStatus,
                      createdAt: currentItem.pcJobCreatedAt,
                      pcOnline: isPcOnline,
                      cloudRenderConfigured,
                    }) && (
                      <div className="pt-1">
                        <button
                          type="button"
                          data-testid="studio-fallback-cloud-btn"
                          disabled={fallingBackJobFileId === activeJobFileId}
                          onClick={() => onFallbackPcJobToCloud(activeJobFileId, 'render')}
                          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#ff2a85]/60 bg-[#ff2a85]/18 px-2.5 font-mono text-[11px] font-semibold text-[#ffd1e3] hover:bg-[#ff2a85]/28 disabled:opacity-45"
                        >
                          {fallingBackJobFileId === activeJobFileId ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Cloud className="h-3.5 w-3.5" />
                          )}
                          Enviar a la nube
                        </button>
                      </div>
                    )}
                  {activePcStatus === 'error' && (
                    <div className="pt-1 space-y-1.5">
                      {currentItem.pcJobError && (
                        <p className="font-mono text-[10px] text-[#ff85b8] break-words">
                          {currentItem.pcJobError}
                        </p>
                      )}
                      <div className="flex flex-wrap items-center gap-2">
                        {typeof currentItem.cloudWorkflowRunUrl === 'string' &&
                          /^https:\/\//i.test(currentItem.cloudWorkflowRunUrl.trim()) && (
                            <a
                              href={currentItem.cloudWorkflowRunUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              data-testid="studio-view-run-link"
                              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#00f0ff]/45 bg-[#00f0ff]/12 px-2.5 font-mono text-[11px] font-semibold text-[#00f0ff] hover:bg-[#00f0ff]/22"
                            >
                              Ver ejecución
                              <ExternalLink className="h-3 w-3" />
                            </a>
                          )}
                        {activePcTarget === 'cloud' && activeJobFileId && (
                          <button
                            type="button"
                            data-testid="studio-retry-failed-job-btn"
                            disabled={retryingDispatchJobFileId === activeJobFileId}
                            onClick={() => onRetryCloudDispatch(activeJobFileId)}
                            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#ff2a85]/60 bg-[#ff2a85]/18 px-2.5 font-mono text-[11px] font-semibold text-[#ffd1e3] hover:bg-[#ff2a85]/28 disabled:opacity-45"
                          >
                            {retryingDispatchJobFileId === activeJobFileId ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <RotateCw className="h-3.5 w-3.5" />
                            )}
                            Reintentar
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                  {activeDispatchError && activeJobFileId && activePcStatus === 'pending' && (
                    <div className="pt-1 space-y-1.5">
                      <p className="font-mono text-[10px] text-[#ff85b8] break-words">
                        {activeDispatchError}
                      </p>
                      <button
                        type="button"
                        data-testid="studio-retry-dispatch-btn"
                        disabled={retryingDispatchJobFileId === activeJobFileId}
                        onClick={() => onRetryCloudDispatch(activeJobFileId)}
                        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#ff2a85]/60 bg-[#ff2a85]/18 px-2.5 font-mono text-[11px] font-semibold text-[#ffd1e3] hover:bg-[#ff2a85]/28 disabled:opacity-45"
                      >
                        {retryingDispatchJobFileId === activeJobFileId ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <RotateCw className="h-3.5 w-3.5" />
                        )}
                        Reintentar envío
                      </button>
                    </div>
                  )}
                  <div className="flex flex-wrap gap-3 pt-0.5">
                    <button
                      type="button"
                      onClick={onBackToQueue}
                      className="font-mono text-[10px] font-semibold text-[#00f0ff] hover:underline"
                    >
                      Ver progreso en Cola →
                    </button>
                    <button
                      type="button"
                      onClick={onGoToGallery}
                      className="font-mono text-[10px] font-semibold text-[#fcee0a] hover:underline"
                    >
                      Ver en Galería →
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Collapsible Secondary Render Options: Explicit PC / Cloud & Local Mobile FFmpeg.wasm */}
            <div
              data-testid="studio-other-render-options"
              className="rounded-md border border-[#00f0ff]/22 bg-[#05060a]/85 overflow-hidden"
            >
              <button
                type="button"
                data-testid="studio-other-options-toggle"
                aria-expanded={showOtherRenderOptions}
                onClick={() => setShowOtherRenderOptions((prev) => !prev)}
                className="flex min-h-[40px] w-full items-center justify-between gap-2 px-3 py-2 font-mono text-xs font-medium text-[#C8D7EC] hover:bg-[#00f0ff]/[0.06] hover:text-[#00f0ff] transition-colors"
              >
                <span>Otras opciones (PC / nube / móvil)</span>
                {showOtherRenderOptions ? (
                  <ChevronUp className="h-4 w-4 text-[#00f0ff]" />
                ) : (
                  <ChevronDown className="h-4 w-4 text-[#8EA2BD]" />
                )}
              </button>

              {showOtherRenderOptions && (
                <div className="border-t border-[#00f0ff]/18 p-3 space-y-2.5">
                  <button
                    type="button"
                    data-testid="studio-send-to-pc-btn"
                    onClick={() => onSendToPc(currentItem.id)}
                    disabled={isSendingToPc || enabledCuts.length === 0 || !canUploadToDrive}
                    title={
                      !canUploadToDrive
                        ? 'Conecta Google Drive y configura tu carpeta en Ajustes para enviar el manifiesto a _AutoCut_Jobs'
                        : 'Sube el JSON de cortes a _AutoCut_Jobs para tu worker de Windows'
                    }
                    className="flex min-h-[42px] w-full items-center justify-center gap-2 rounded-md border border-[#00f0ff]/50 bg-[#00f0ff]/12 px-3 py-2 text-xs font-semibold text-[#EEF5FF] hover:bg-[#00f0ff]/20 hover:border-[#00f0ff] disabled:opacity-45 transition-colors"
                  >
                    {isSendingPc ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin text-[#00f0ff] shrink-0" />
                        Enviando trabajo al PC...
                      </>
                    ) : (
                      <>
                        <Monitor className="h-4 w-4 text-[#00f0ff] shrink-0" />
                        Forzar envío a PC ({enabledCuts.length} cortes)
                      </>
                    )}
                  </button>

                  {cloudRenderConfigured && (
                    <button
                      type="button"
                      data-testid="studio-force-cloud-btn"
                      onClick={() => onSendToCloud(currentItem.id)}
                      disabled={isSendingToPc || enabledCuts.length === 0 || !canUploadToDrive}
                      title="Dispara el render directamente en GitHub Actions aunque el PC esté en línea"
                      className="flex min-h-[42px] w-full items-center justify-center gap-2 rounded-md border border-[#ff2a85]/45 bg-[#ff2a85]/10 px-3 py-2 text-xs font-semibold text-[#EEF5FF] hover:bg-[#ff2a85]/20 hover:border-[#ff2a85] disabled:opacity-45 transition-colors"
                    >
                      {isSendingCloud ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin text-[#ff2a85] shrink-0" />
                          Enviando a la nube...
                        </>
                      ) : (
                        <>
                          <Cloud className="h-4 w-4 text-[#ff85b8] shrink-0" />
                          Forzar envío a la nube ({enabledCuts.length} cortes)
                        </>
                      )}
                    </button>
                  )}

                  {multiClipMobileGuard.shouldWarn && (
                    <div
                      role="note"
                      data-testid="studio-mobile-ram-guard"
                      className="rounded-md border border-[#ff2a85]/55 bg-[#ff2a85]/12 p-3 text-xs text-[#ffd1e3] space-y-2"
                    >
                      <div className="flex items-start gap-2">
                        <AlertTriangle className="h-4 w-4 text-[#ff2a85] shrink-0 mt-0.5" />
                        <p className="leading-relaxed">{multiClipMobileGuard.reason}</p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          data-testid="studio-switch-720p-btn"
                          onClick={() => onChangeExportQuality('mobile_fast')}
                          className="inline-flex h-9 items-center gap-1.5 rounded-md border border-[#00f0ff]/65 bg-[#00f0ff]/18 px-3 font-mono text-[11px] font-semibold text-[#00f0ff] hover:bg-[#00f0ff]/28 transition-colors"
                        >
                          <Zap className="h-3.5 w-3.5" />
                          Cambiar a 720p móvil
                        </button>
                        {hasRealSource && enabledCuts.length > 0 && (
                          <button
                            type="button"
                            data-testid="studio-switch-720p-and-render-btn"
                            disabled={isRendering}
                            onClick={() => {
                              onChangeExportQuality('mobile_fast');
                              onRerenderItem(currentItem.id, 'mobile_fast');
                            }}
                            className="inline-flex h-9 items-center gap-1.5 cyber-btn-primary px-3 text-[11px] font-semibold disabled:opacity-45"
                          >
                            <Zap className="h-3.5 w-3.5" />
                            720p y renderizar ahora
                          </button>
                        )}
                      </div>
                    </div>
                  )}

                  <button
                    type="button"
                    data-testid="studio-render-final-btn"
                    onClick={() => onRerenderItem(currentItem.id)}
                    disabled={isRendering || enabledCuts.length === 0 || !hasRealSource}
                    title={
                      !hasRealSource
                        ? 'Disponible para vídeos reales descargados de Drive o cargados localmente'
                        : 'Renderizado local con FFmpeg.wasm (recomendado solo para clips cortos)'
                    }
                    className="flex min-h-[42px] w-full items-center justify-center gap-2 rounded-md border border-[#fcee0a]/35 bg-[#fcee0a]/[0.08] px-3 text-xs font-semibold text-[#FEF08A] hover:bg-[#fcee0a]/15 hover:border-[#fcee0a]/65 disabled:opacity-45 transition-colors whitespace-nowrap"
                  >
                    {isRendering ? (
                      <RefreshCw className="h-4 w-4 animate-spin" />
                    ) : (
                      <Smartphone className="h-4 w-4" />
                    )}
                    {isPendingFinalRender
                      ? `Renderizar en este móvil (${enabledCuts.length})`
                      : `Re-renderizar en este móvil (${enabledCuts.length})`}
                  </button>
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <button
                type="button"
                onClick={handleDownloadEdited}
                disabled={!currentItem.editedUrl}
                className="flex h-10 items-center justify-center gap-2 rounded-md border border-[#00f0ff]/30 bg-[#05060a] px-3 text-xs font-medium text-[#EEF5FF] hover:border-[#00f0ff]/65 hover:text-[#00f0ff] disabled:opacity-40 transition-colors whitespace-nowrap"
              >
                <Download className="h-3.5 w-3.5 text-[#00f0ff]" />
                Descargar MP4
              </button>

              <button
                type="button"
                onClick={() => onRequestDriveUpload(currentItem.id)}
                disabled={isRendering || !currentItem.editedBlob || enabledCuts.length === 0}
                className="flex h-10 items-center justify-center gap-2 rounded-md border border-[#ff2a85]/35 bg-[#05060a] px-3 text-xs font-medium text-[#EEF5FF] hover:border-[#ff2a85]/70 hover:text-[#ff85b8] disabled:opacity-40 transition-colors whitespace-nowrap"
              >
                <CloudUpload className="h-3.5 w-3.5 text-[#ff2a85]" />
                Subir a Drive
              </button>
            </div>

            {remappedSubtitles.length > 0 && (
              <button
                type="button"
                data-testid="download-srt-btn"
                onClick={handleDownloadSrt}
                className="flex h-9 w-full items-center justify-center gap-2 rounded-md border border-[#fcee0a]/35 bg-[#fcee0a]/[0.06] px-3 font-mono text-xs font-medium text-[#fcee0a] hover:border-[#fcee0a]/70 hover:bg-[#fcee0a]/12 transition-colors whitespace-nowrap"
              >
                <Captions className="h-3.5 w-3.5" />
                Descargar subtítulos .SRT ({remappedSubtitles.length} bloques)
              </button>
            )}

            {!canUploadToDrive && (
              <p className="text-[11px] text-[#8EA2BD] text-center">
                Conecta Google Drive y define un ID de carpeta en Ajustes para renderizar en la nube, enviar al PC o subir el MP4 final.
              </p>
            )}
          </div>
        </section>

        {/* Right Column: AI Edit Plan, Visual Timeline, and Editable EDL Cut List */}
        <section className="xl:col-span-7 cyber-panel flex flex-col rounded-md p-5">
          {/* Header Metadata */}
          <div className="border-b border-[#00f0ff]/20 pb-4">
            <div className="flex flex-wrap items-center gap-2 text-xs text-[#8EA2BD]">
              <span className="font-mono font-semibold text-[#fcee0a]">{plan.etiqueta}</span>
              <span aria-hidden="true">·</span>
              <span>{currentItem.originalName}</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono tabular-nums">{formatBytes(currentItem.sizeBytes)}</span>
              {currentItem.geminiFileCleaned && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono text-[#00f0ff]">Temporal de Gemini eliminado</span>
                </>
              )}
            </div>

            <h2 className="mt-2 font-display text-xl font-semibold text-[#EEF5FF]">
              {plan.titulo_interno}
            </h2>

            <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-[#8EA2BD]">
              <div>
                <span>Duración seleccionada: </span>
                <strong
                  data-testid="selected-duration"
                  className="font-mono tabular-nums text-[#00f0ff]"
                >
                  {formatSeconds(selectedDurationSec)}
                </strong>
              </div>
              <div>
                <span>Objetivo IA: </span>
                <strong className="font-mono tabular-nums text-[#fcee0a]">
                  {plan.duracion_objetivo_seg}s
                </strong>
              </div>
              <div>
                <span>Cortes activos: </span>
                <strong
                  data-testid="active-cuts-count"
                  className="font-mono tabular-nums text-[#EEF5FF]"
                >
                  {enabledCuts.length} / {plan.cortes.length}
                </strong>
              </div>
            </div>

            {/* Cloud Story Overview Card (titulo, gancho, historia, revision.notas, Ver guion, Rehacer historia) */}
            {hasCloudStoryInfo && (
              <div
                data-testid="studio-story-card"
                className="mt-4 rounded-md border border-[#00f0ff]/30 bg-[#05060a]/90 p-3.5 space-y-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-[#00f0ff]">
                    <Sparkles className="h-3.5 w-3.5 text-[#fcee0a]" />
                    Guion multimodal (Whisper + Gemini)
                  </span>
                  {plan.revision && (
                    <span
                      data-testid="studio-revision-badge"
                      className={`font-mono text-[10px] font-semibold px-2 py-0.5 rounded-sm border ${
                        plan.revision.coherente
                          ? 'border-[#00f0ff]/45 bg-[#00f0ff]/12 text-[#00f0ff]'
                          : 'border-[#fcee0a]/55 bg-[#fcee0a]/12 text-[#fcee0a]'
                      }`}
                    >
                      {plan.revision.coherente ? 'Coherencia verificada' : 'Revisar ritmo'}
                    </span>
                  )}
                </div>

                {plan.gancho && (
                  <div className="space-y-0.5">
                    <p className="font-mono text-[10px] font-semibold uppercase tracking-wider text-[#ff85b8]">
                      Gancho
                    </p>
                    <p
                      data-testid="studio-story-gancho"
                      className="text-xs font-medium text-[#EEF5FF] leading-relaxed"
                    >
                      {plan.gancho}
                    </p>
                  </div>
                )}

                {plan.historia && (
                  <div className="space-y-0.5">
                    <p className="font-mono text-[10px] font-semibold uppercase tracking-wider text-[#8EA2BD]">
                      Historia
                    </p>
                    <p
                      data-testid="studio-story-historia"
                      className="text-xs text-[#C8D7EC] leading-relaxed"
                    >
                      {plan.historia}
                    </p>
                  </div>
                )}

                {plan.revision && plan.revision.notas && plan.revision.notas.length > 0 && (
                  <div
                    data-testid="studio-revision-notas"
                    className="rounded-sm border border-[#00f0ff]/18 bg-[#0c0f1a]/80 px-3 py-2 space-y-1"
                  >
                    <p className="font-mono text-[10px] font-semibold uppercase tracking-wider text-[#fcee0a]">
                      Notas de revisión
                    </p>
                    <ul className="space-y-1 text-[11px] text-[#B5C6DC] list-disc list-inside">
                      {plan.revision.notas.map((nota, idx) => (
                        <li key={idx} className="leading-relaxed">
                          {nota}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-2 pt-1">
                  {plan.guionResultante && (
                    <button
                      type="button"
                      data-testid="studio-view-full-script-btn"
                      onClick={() => setShowFullScript((prev) => !prev)}
                      className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#00f0ff]/35 bg-[#00f0ff]/10 px-3 font-mono text-[11px] font-semibold text-[#00f0ff] hover:bg-[#00f0ff]/18 transition-colors"
                    >
                      <BookOpen className="h-3.5 w-3.5" />
                      {showFullScript ? 'Ocultar guion completo' : 'Ver guion completo'}
                    </button>
                  )}

                  <button
                    type="button"
                    data-testid="studio-redo-story-toggle-btn"
                    onClick={() => setShowRedoStory((prev) => !prev)}
                    className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#ff2a85]/45 bg-[#ff2a85]/12 px-3 font-mono text-[11px] font-semibold text-[#ffb3d1] hover:bg-[#ff2a85]/22 transition-colors"
                  >
                    <Wand2 className="h-3.5 w-3.5" />
                    Rehacer historia
                  </button>
                </div>

                {showFullScript && plan.guionResultante && (
                  <div
                    data-testid="studio-full-script-panel"
                    className="rounded-sm border border-[#00f0ff]/25 bg-[#0c0f1a] p-3 space-y-1.5"
                  >
                    <p className="font-mono text-[10px] font-semibold uppercase tracking-wider text-[#00f0ff]">
                      Guion resultante (texto hablado continuo)
                    </p>
                    <p className="text-xs leading-relaxed text-[#EEF5FF] whitespace-pre-wrap">
                      {plan.guionResultante}
                    </p>
                  </div>
                )}

                {showRedoStory && (
                  <div
                    data-testid="studio-redo-story-form"
                    className="rounded-sm border border-[#ff2a85]/35 bg-[#0c0f1a] p-3 space-y-2.5"
                  >
                    <label
                      htmlFor="studio-redo-story-input"
                      className="block text-[11px] font-medium text-[#EEF5FF]"
                    >
                      Nueva indicación para Gemini (reutiliza la transcripción en caché de Drive)
                    </label>
                    <input
                      id="studio-redo-story-input"
                      data-testid="studio-redo-story-input"
                      type="text"
                      value={redoInstruction}
                      onChange={(e) => setRedoInstruction(e.target.value)}
                      placeholder="Ej: Hazlo más dinámico, empieza por el momento gracioso y déjalo en 35s..."
                      className="h-9 w-full rounded-md border border-[#00f0ff]/25 bg-[#05060a] px-3 text-xs text-[#EEF5FF] placeholder:text-[#5F738E] focus:border-[#00f0ff] focus:outline-none"
                    />
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-[10px] text-[#8EA2BD]">
                        No vuelve a ejecutar Whisper si la transcripción ya está en _AutoCut_Jobs/_cache.
                      </span>
                      <button
                        type="button"
                        data-testid="studio-redo-story-submit-btn"
                        disabled={!cloudRenderConfigured || !canUploadToDrive || isSendingAnalyze}
                        title={
                          !cloudRenderConfigured
                            ? 'Configura GitHub Actions y GEMINI_API_KEY en Ajustes'
                            : !canUploadToDrive
                            ? 'Conecta Google Drive y configura tu carpeta en Ajustes'
                            : 'Generar un nuevo guion en la nube reutilizando la transcripción'
                        }
                        onClick={() => {
                          onRedoStory(currentItem.id, redoInstruction);
                          setShowRedoStory(false);
                        }}
                        className="cyber-btn-magenta inline-flex h-8 items-center gap-1.5 px-3 text-[11px] font-semibold disabled:opacity-45 whitespace-nowrap"
                      >
                        {isSendingAnalyze ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Cloud className="h-3.5 w-3.5" />
                        )}
                        Generar nueva historia
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Visual Timeline Track */}
          <div className="py-4 border-b border-[#00f0ff]/20">
            <div className="flex items-center justify-between text-[11px] text-[#8EA2BD] mb-2">
              <span>
                {currentItem.isMultiClip
                  ? `Línea de tiempo combinada (${timelineMeta.clipOffsets.length} clips)`
                  : 'Línea de tiempo de cortes sobre bruto'}
              </span>
              <span className="font-mono tabular-nums text-[#C8D7EC]">
                0:00.0 — {formatSeconds(timelineMeta.totalSec)}
              </span>
            </div>
            <div
              data-testid="studio-timeline-track"
              className="relative h-8 w-full overflow-hidden rounded-sm bg-[#05060a] border border-[#00f0ff]/30"
            >
              {currentItem.isMultiClip &&
                timelineMeta.clipOffsets.slice(1).map((offsetSec, idx) => {
                  const dividerLeftPct = Math.min(
                    100,
                    (offsetSec / timelineMeta.totalSec) * 100
                  );
                  return (
                    <div
                      key={`clip-divider-${idx + 1}`}
                      aria-hidden="true"
                      style={{ left: `${dividerLeftPct}%` }}
                      className="pointer-events-none absolute top-0 bottom-0 w-px bg-[#fcee0a]/45"
                    />
                  );
                })}
              {plan.cortes.map((cut) => {
                const clipIdx = currentItem.isMultiClip ? Math.max(0, cut.clip_index ?? 0) : 0;
                const clipOffset = timelineMeta.clipOffsets[clipIdx] ?? 0;
                const leftPct = Math.min(
                  99,
                  ((clipOffset + cut.start_sec) / timelineMeta.totalSec) * 100
                );
                const widthPct = Math.max(
                  1.2,
                  Math.min(
                    100 - leftPct,
                    ((cut.end_sec - cut.start_sec) / timelineMeta.totalSec) * 100
                  )
                );
                const isSelected = activeCutId === cut.id;
                const clipTag = currentItem.isMultiClip ? `Clip ${clipIdx + 1} · ` : '';
                return (
                  <button
                    key={cut.id}
                    type="button"
                    onClick={() => handleJumpToCut(cut.id)}
                    title={`${clipTag}${formatSeconds(cut.start_sec)} – ${formatSeconds(cut.end_sec)}`}
                    aria-label={`Ir al corte ${clipTag}${formatSeconds(cut.start_sec)} a ${formatSeconds(cut.end_sec)}`}
                    style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                    className={`absolute top-1 bottom-1 rounded-[2px] transition-opacity ${
                      !cut.enabled
                        ? 'bg-white/[0.12] opacity-35'
                        : isSelected
                        ? 'bg-[#00f0ff] ring-1 ring-white shadow-[0_0_10px_rgba(0,240,255,0.6)]'
                        : 'bg-[#ff2a85] hover:bg-[#ff5c9f]'
                    }`}
                  />
                );
              })}
            </div>
          </div>

          {/* Cut List Controls */}
          <div className="flex items-center justify-between py-3">
            <div>
              <h3 className="font-display text-sm font-semibold text-[#EEF5FF]">
                Lista de cortes editable (EDL)
              </h3>
              <p className="text-[11px] text-[#8EA2BD]">
                Reordena, activa o afina inicio y fin antes de renderizar
              </p>
            </div>
            <button
              type="button"
              onClick={() => onSelectAllCuts(currentItem.id, !allEnabled)}
              className="inline-flex items-center gap-1.5 font-mono text-xs font-medium text-[#00f0ff] hover:text-[#7df7ff] transition-colors shrink-0"
            >
              {allEnabled ? (
                <>
                  <Square className="h-3.5 w-3.5" />
                  Desactivar todos
                </>
              ) : (
                <>
                  <CheckSquare className="h-3.5 w-3.5" />
                  Activar todos
                </>
              )}
            </button>
          </div>

          {/* Interactive Editable EDL Cut Rows */}
          <div className="flex-1 divide-y divide-[#00f0ff]/12 overflow-y-auto max-h-[520px] pr-1">
            {plan.cortes.map((cut, index) => {
              const clipDuration = Math.max(0, cut.end_sec - cut.start_sec);
              const isFocused = activeCutId === cut.id;
              const score = cut.puntuacion_interes ?? 8;

              return (
                <div
                  key={cut.id}
                  data-testid={`studio-cut-row-${index}`}
                  className={`flex items-start gap-3 py-3.5 px-2.5 rounded-sm transition-colors ${
                    isFocused ? 'bg-[#00f0ff]/[0.08]' : 'hover:bg-[#00f0ff]/[0.03]'
                  }`}
                >
                  {/* Enable checkbox */}
                  <label className="mt-0.5 flex h-6 w-6 items-center justify-center shrink-0">
                    <input
                      type="checkbox"
                      checked={cut.enabled}
                      onChange={() => onToggleCut(currentItem.id, cut.id)}
                      aria-label={`Activar corte ${index + 1}: ${cut.motivo}`}
                      className="h-4 w-4 rounded-sm border-[#00f0ff]/40 bg-[#05060a] accent-[#00f0ff]"
                    />
                  </label>

                  {/* Cut Info + Timing Controls */}
                  <div className="flex-1 min-w-0 space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => handleJumpToCut(cut.id)}
                        className="flex-1 text-left min-w-0"
                      >
                        <div className="flex flex-wrap items-center gap-2 min-w-0">
                          <span
                            data-testid={`cut-range-${index}`}
                            className={`font-mono text-xs tabular-nums font-semibold ${
                              cut.enabled ? 'text-[#00f0ff]' : 'text-[#5A6C86] line-through'
                            }`}
                          >
                            {String(index + 1).padStart(2, '0')}. {formatSeconds(cut.start_sec)} –{' '}
                            {formatSeconds(cut.end_sec)}
                          </span>

                          {cut.funcion && CUT_FUNCTION_META[cut.funcion] && (
                            <span
                              data-testid={`cut-funcion-${index}`}
                              className={`inline-flex items-center rounded-sm border px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider ${
                                CUT_FUNCTION_META[cut.funcion].className
                              }`}
                            >
                              {CUT_FUNCTION_META[cut.funcion].label}
                            </span>
                          )}

                          <span
                            data-testid={`cut-score-${index}`}
                            title="Puntuación de interés estimada por Gemini"
                            className={`inline-flex items-center gap-0.5 rounded-sm border px-1.5 py-0.5 font-mono text-[10px] font-semibold tabular-nums ${
                              score >= 9
                                ? 'border-[#fcee0a]/45 bg-[#fcee0a]/10 text-[#fcee0a]'
                                : 'border-[#00f0ff]/30 bg-[#00f0ff]/10 text-[#00f0ff]'
                            }`}
                          >
                            <Star className="h-2.5 w-2.5 fill-current" aria-hidden="true" />
                            {score}/10
                          </span>

                          {currentItem.isMultiClip && (
                            <span
                              data-testid={`cut-clip-label-${index}`}
                              className="font-mono text-[11px] font-medium text-[#ff85b8] truncate max-w-[180px]"
                              title={getClipDisplayLabel(cut.clip_index).name}
                            >
                              {getClipDisplayLabel(cut.clip_index).short}
                            </span>
                          )}
                        </div>
                        {cut.texto && (
                          <p
                            data-testid={`cut-texto-${index}`}
                            className={`mt-1.5 text-xs font-medium leading-relaxed ${
                              cut.enabled ? 'text-[#EEF5FF]' : 'text-[#6A7E99]'
                            }`}
                          >
                            «{cut.texto}»
                          </p>
                        )}
                        <p
                          data-testid={`cut-reason-${index}`}
                          className={`mt-1 text-xs leading-relaxed ${
                            cut.texto
                              ? cut.enabled
                                ? 'text-[#8EA2BD]'
                                : 'text-[#52647D]'
                              : cut.enabled
                              ? 'text-[#C8D7EC]'
                              : 'text-[#5A6C86]'
                          }`}
                        >
                          {cut.motivo}
                        </p>
                      </button>

                      {/* Duration + Reorder Buttons */}
                      <div className="flex items-center gap-1 shrink-0">
                        <span className="font-mono text-xs tabular-nums text-[#C8D7EC] mr-1">
                          {clipDuration.toFixed(1)}s
                        </span>
                        <button
                          type="button"
                          data-testid={`cut-move-up-${index}`}
                          onClick={() => onReorderCut(currentItem.id, cut.id, -1)}
                          disabled={index === 0 || isRendering}
                          aria-label={`Subir corte ${index + 1}`}
                          title="Subir corte"
                          className="flex h-7 w-7 items-center justify-center rounded-sm border border-[#00f0ff]/25 bg-[#05060a] text-[#C8D7EC] hover:border-[#00f0ff] hover:text-[#00f0ff] disabled:opacity-30 transition-colors"
                        >
                          <ArrowUp className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          data-testid={`cut-move-down-${index}`}
                          onClick={() => onReorderCut(currentItem.id, cut.id, 1)}
                          disabled={index === plan.cortes.length - 1 || isRendering}
                          aria-label={`Bajar corte ${index + 1}`}
                          title="Bajar corte"
                          className="flex h-7 w-7 items-center justify-center rounded-sm border border-[#00f0ff]/25 bg-[#05060a] text-[#C8D7EC] hover:border-[#00f0ff] hover:text-[#00f0ff] disabled:opacity-30 transition-colors"
                        >
                          <ArrowDown className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>

                    {/* Fine Start/End Timing Controls */}
                    <div className="flex flex-wrap items-center gap-2 pt-0.5">
                      <div className="inline-flex items-center gap-1 rounded-sm border border-[#00f0ff]/18 bg-[#05060a] px-2 py-1">
                        <label
                          htmlFor={`cut-start-${cut.id}`}
                          className="font-mono text-[10px] text-[#8EA2BD]"
                        >
                          Inicio
                        </label>
                        <button
                          type="button"
                          disabled={isRendering}
                          aria-label={`Restar 0.5s al inicio del corte ${index + 1}`}
                          onClick={() =>
                            onUpdateCutTiming(currentItem.id, cut.id, {
                              start_sec: cut.start_sec - 0.5,
                            })
                          }
                          className="px-1 font-mono text-[11px] text-[#8EA2BD] hover:text-[#00f0ff] disabled:opacity-30"
                        >
                          −
                        </button>
                        <input
                          id={`cut-start-${cut.id}`}
                          data-testid={`cut-start-input-${index}`}
                          type="number"
                          step="0.1"
                          min="0"
                          disabled={isRendering}
                          value={Number(cut.start_sec.toFixed(1))}
                          onChange={(e) => {
                            const val = parseFloat(e.target.value);
                            if (Number.isFinite(val)) {
                              onUpdateCutTiming(currentItem.id, cut.id, { start_sec: val });
                            }
                          }}
                          className="w-14 bg-transparent text-center font-mono text-[11px] tabular-nums text-[#EEF5FF] focus:outline-none"
                        />
                        <button
                          type="button"
                          disabled={isRendering}
                          aria-label={`Sumar 0.5s al inicio del corte ${index + 1}`}
                          onClick={() =>
                            onUpdateCutTiming(currentItem.id, cut.id, {
                              start_sec: cut.start_sec + 0.5,
                            })
                          }
                          className="px-1 font-mono text-[11px] text-[#8EA2BD] hover:text-[#00f0ff] disabled:opacity-30"
                        >
                          +
                        </button>
                      </div>

                      <div className="inline-flex items-center gap-1 rounded-sm border border-[#00f0ff]/18 bg-[#05060a] px-2 py-1">
                        <label
                          htmlFor={`cut-end-${cut.id}`}
                          className="font-mono text-[10px] text-[#8EA2BD]"
                        >
                          Fin
                        </label>
                        <button
                          type="button"
                          disabled={isRendering}
                          aria-label={`Restar 0.5s al fin del corte ${index + 1}`}
                          onClick={() =>
                            onUpdateCutTiming(currentItem.id, cut.id, {
                              end_sec: cut.end_sec - 0.5,
                            })
                          }
                          className="px-1 font-mono text-[11px] text-[#8EA2BD] hover:text-[#00f0ff] disabled:opacity-30"
                        >
                          −
                        </button>
                        <input
                          id={`cut-end-${cut.id}`}
                          data-testid={`cut-end-input-${index}`}
                          type="number"
                          step="0.1"
                          min="0.2"
                          disabled={isRendering}
                          value={Number(cut.end_sec.toFixed(1))}
                          onChange={(e) => {
                            const val = parseFloat(e.target.value);
                            if (Number.isFinite(val)) {
                              onUpdateCutTiming(currentItem.id, cut.id, { end_sec: val });
                            }
                          }}
                          className="w-14 bg-transparent text-center font-mono text-[11px] tabular-nums text-[#EEF5FF] focus:outline-none"
                        />
                        <button
                          type="button"
                          disabled={isRendering}
                          aria-label={`Sumar 0.5s al fin del corte ${index + 1}`}
                          onClick={() =>
                            onUpdateCutTiming(currentItem.id, cut.id, {
                              end_sec: cut.end_sec + 0.5,
                            })
                          }
                          className="px-1 font-mono text-[11px] text-[#8EA2BD] hover:text-[#00f0ff] disabled:opacity-30"
                        >
                          +
                        </button>
                      </div>
                    </div>

                    {/* B-Roll Overlays anchored to this cut */}
                    {(() => {
                      const cutOverlays = (plan.overlays ?? []).filter(
                        (ov) => ov.anchorCutId === cut.id
                      );
                      if (cutOverlays.length === 0) return null;

                      return (
                        <div
                          data-testid={`cut-overlays-list-${index}`}
                          className="mt-2.5 space-y-2 border-l-2 border-[#a855f7]/50 pl-3"
                        >
                          {cutOverlays.map((ov) => {
                            const isOvEnabled = ov.enabled !== false;
                            const ovClipUrl = currentItem.isMultiClip
                              ? currentItem.sourceClips?.[ov.clip_index]?.rawUrl
                              : currentItem.rawUrl;
                            const ovClipInfo = getClipDisplayLabel(ov.clip_index);

                            return (
                              <div
                                key={ov.id}
                                data-testid={`studio-overlay-card-${ov.id}`}
                                className={`flex flex-wrap sm:flex-nowrap items-start gap-2.5 rounded-sm border p-2.5 transition-opacity ${
                                  isOvEnabled
                                    ? 'border-[#a855f7]/35 bg-[#a855f7]/[0.07]'
                                    : 'border-[#52647D]/30 bg-[#05060a]/60 opacity-55'
                                }`}
                              >
                                <OverlayThumbnail
                                  videoUrl={ovClipUrl}
                                  seekSec={ov.start_sec}
                                  clipIndex={ov.clip_index}
                                />

                                <div className="min-w-0 flex-1 space-y-1">
                                  <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                                    <span className="inline-flex items-center rounded-sm border border-[#a855f7]/50 bg-[#a855f7]/15 px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wider text-[#d8b4fe]">
                                      Voz sobre recurso
                                    </span>
                                    <span
                                      className="font-mono text-[11px] font-semibold text-[#e9d5ff]"
                                      title={ovClipInfo.name}
                                    >
                                      {ovClipInfo.short}
                                    </span>
                                    <span
                                      className={`font-mono text-[11px] tabular-nums ${
                                        isOvEnabled ? 'text-[#00f0ff]' : 'text-[#6A7E99] line-through'
                                      }`}
                                    >
                                      {formatSeconds(ov.start_sec)} – {formatSeconds(ov.end_sec)}
                                    </span>
                                    <span className="font-mono text-[10px] text-[#8EA2BD]">
                                      (entra en +{ov.offsetSec.toFixed(1)}s)
                                    </span>
                                  </div>

                                  <p className="text-[11px] leading-relaxed text-[#C8D7EC]">
                                    {ov.motivo}
                                  </p>
                                </div>

                                <div className="flex items-center gap-1.5 shrink-0">
                                  <button
                                    type="button"
                                    data-testid={`studio-overlay-toggle-${ov.id}`}
                                    aria-label={`${isOvEnabled ? 'Desactivar' : 'Activar'} recurso de ${ovClipInfo.short}`}
                                    onClick={() => onToggleOverlay?.(currentItem.id, ov.id)}
                                    className="inline-flex h-7 items-center gap-1 rounded-sm border border-[#00f0ff]/30 bg-[#05060a] px-2 font-mono text-[10px] font-medium text-[#C8D7EC] hover:border-[#00f0ff] hover:text-[#00f0ff] transition-colors"
                                  >
                                    {isOvEnabled ? (
                                      <>
                                        <EyeOff className="h-3 w-3" />
                                        Desactivar
                                      </>
                                    ) : (
                                      <>
                                        <Eye className="h-3 w-3" />
                                        Activar
                                      </>
                                    )}
                                  </button>

                                  <button
                                    type="button"
                                    data-testid={`studio-overlay-delete-${ov.id}`}
                                    aria-label={`Eliminar recurso de ${ovClipInfo.short}`}
                                    onClick={() => onDeleteOverlay?.(currentItem.id, ov.id)}
                                    className="inline-flex h-7 items-center gap-1 rounded-sm border border-[#ff2a85]/35 bg-[#05060a] px-2 font-mono text-[10px] font-medium text-[#ff85b8] hover:border-[#ff2a85] hover:bg-[#ff2a85]/15 transition-colors"
                                  >
                                    <Trash2 className="h-3 w-3" />
                                    Eliminar
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      );
                    })()}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}
