import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Captions,
  CheckSquare,
  CloudUpload,
  Download,
  Film,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Scissors,
  Sparkles,
  Square,
  Star,
} from 'lucide-react';
import type { ExportQuality, QueueItem, TikTokEditOptions } from '../types';
import {
  buildCombinedEditedFilename,
  buildEditedFilename,
  buildSrtSubtitles,
  calculateSelectedDuration,
  filterEditedCuts,
  formatBytes,
  formatSeconds,
  getBaseName,
  remapSubtitlesToFinalTimeline,
} from '../utils/videoPipeline';

interface StudioViewProps {
  items: QueueItem[];
  selectedItemId: string | null;
  onSelectItem: (id: string) => void;
  onToggleCut: (itemId: string, cutId: string) => void;
  onSelectAllCuts: (itemId: string, enabled: boolean) => void;
  onReorderCut: (itemId: string, cutId: string, direction: -1 | 1) => void;
  onUpdateCutTiming: (
    itemId: string,
    cutId: string,
    patch: { start_sec?: number; end_sec?: number }
  ) => void;
  onRerenderItem: (itemId: string) => void;
  onRequestDriveUpload: (itemId: string) => void;
  exportQuality: ExportQuality;
  onChangeExportQuality: (quality: ExportQuality) => void;
  tiktokOptions: TikTokEditOptions;
  onChangeTikTokOptions: (patch: Partial<TikTokEditOptions>) => void;
  isRendering: boolean;
  renderProgress: { percent: number; message: string } | null;
  canUploadToDrive: boolean;
  onBackToQueue: () => void;
}

export function StudioView({
  items,
  selectedItemId,
  onSelectItem,
  onToggleCut,
  onSelectAllCuts,
  onReorderCut,
  onUpdateCutTiming,
  onRerenderItem,
  onRequestDriveUpload,
  exportQuality,
  onChangeExportQuality,
  tiktokOptions,
  onChangeTikTokOptions,
  isRendering,
  renderProgress,
  canUploadToDrive,
  onBackToQueue,
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
          currentItem.sourceClips.every((c) => Boolean(c.rawBlob))
      )
    : Boolean(currentItem.rawBlob);
  const isPendingFinalRender = currentItem.stage === 'review' || !currentItem.editedUrl;
  const hasGeneratedSubtitles = Boolean(plan.subtitulos && plan.subtitulos.length > 0);
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

            <button
              type="button"
              data-testid="studio-render-final-btn"
              onClick={() => onRerenderItem(currentItem.id)}
              disabled={isRendering || enabledCuts.length === 0 || !hasRealSource}
              title={
                !hasRealSource
                  ? 'Disponible para vídeos reales descargados de Drive o cargados localmente'
                  : undefined
              }
              className="cyber-btn-primary flex h-11 w-full items-center justify-center gap-2 px-4 text-sm disabled:opacity-45 whitespace-nowrap"
            >
              <RefreshCw className={`h-4 w-4 ${isRendering ? 'animate-spin' : ''}`} />
              {isPendingFinalRender
                ? `Renderizar vídeo final (${enabledCuts.length})`
                : `Re-renderizar vídeo final (${enabledCuts.length})`}
            </button>

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
                Conecta Google Drive y define un ID de carpeta en Ajustes para subir el MP4 final.
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
                        <p
                          data-testid={`cut-reason-${index}`}
                          className={`mt-1 text-xs leading-relaxed ${
                            cut.enabled ? 'text-[#C8D7EC]' : 'text-[#5A6C86]'
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
