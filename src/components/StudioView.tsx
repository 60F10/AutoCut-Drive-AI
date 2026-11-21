import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckSquare,
  CloudUpload,
  Download,
  Film,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Scissors,
  Square,
} from 'lucide-react';
import type { QueueItem } from '../types';
import {
  buildCombinedEditedFilename,
  buildEditedFilename,
  calculateSelectedDuration,
  formatBytes,
  formatSeconds,
} from '../utils/videoPipeline';

interface StudioViewProps {
  items: QueueItem[];
  selectedItemId: string | null;
  onSelectItem: (id: string) => void;
  onToggleCut: (itemId: string, cutId: string) => void;
  onSelectAllCuts: (itemId: string, enabled: boolean) => void;
  onRerenderItem: (itemId: string) => void;
  onRequestDriveUpload: (itemId: string) => void;
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
  onRerenderItem,
  onRequestDriveUpload,
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

  // Interactive storyboard playback for demo items (no real MP4 blob)
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
      <div className="rounded-xl border border-white/[0.08] bg-[#111419] px-6 py-16 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl border border-white/[0.08] bg-[#171B22] text-[#8B96A8]">
          <Film className="h-5 w-5" />
        </div>
        <h2 className="mt-4 font-display text-lg font-semibold text-[#EDF1F7]">
          Ningún vídeo analizado seleccionado
        </h2>
        <p className="mx-auto mt-2 max-w-md text-sm text-[#8B96A8]">
          Procesa un vídeo desde tu carpeta de Google Drive o carga una sesión de ejemplo en la cola para revisar y ajustar los jump cuts aquí.
        </p>
        <button
          type="button"
          onClick={onBackToQueue}
          className="mt-6 inline-flex h-10 items-center gap-2 rounded-lg bg-[#E11D48] px-4 text-sm font-medium text-white hover:bg-[#BE123C] transition-colors whitespace-nowrap"
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

    // If playing the rendered edited video, compute cumulative offset of that cut in the edited timeline
    if (videoRef.current && currentItem.editedUrl && enabledIdx >= 0) {
      let offset = 0;
      for (let i = 0; i < enabledIdx; i += 1) {
        offset += enabledCuts[i].end_sec - enabledCuts[i].start_sec;
      }
      videoRef.current.currentTime = offset;
      videoRef.current.play().catch(() => {});
    }
  };

  const handleDownloadEdited = () => {
    if (!currentItem.editedUrl) return;
    const anchor = document.createElement('a');
    anchor.href = currentItem.editedUrl;
    anchor.download = targetOutputName;
    anchor.click();
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
                className={`rounded-lg px-3 py-1.5 text-xs font-medium border transition-colors whitespace-nowrap shrink-0 ${
                  active
                    ? 'border-[#E11D48]/60 bg-[#E11D48]/10 text-white'
                    : 'border-white/[0.08] bg-[#111419] text-[#8B96A8] hover:text-white'
                }`}
              >
                {item.originalName}
              </button>
            );
          })}
        </div>
      )}

      {/* Balanced 2-column Studio Split */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-stretch">
        {/* Left Column: 9:16 Vertical Preview Stage */}
        <section className="xl:col-span-5 flex flex-col rounded-xl border border-white/[0.08] bg-[#111419] p-5">
          <div className="flex items-center justify-between gap-2 pb-4 border-b border-white/[0.08]">
            <div>
              <h2 className="font-display text-sm font-semibold text-[#EDF1F7]">
                Vista previa vertical (9:16)
              </h2>
              <p className="text-xs text-[#8B96A8] font-mono truncate max-w-[260px]">
                {targetOutputName}
              </p>
            </div>
            <span className="font-mono text-xs tabular-nums text-[#C8D0DC]">
              {formatSeconds(selectedDurationSec)}
            </span>
          </div>

          {/* 9:16 Frame */}
          <div className="my-5 flex justify-center">
            <div className="relative w-full max-w-[280px] aspect-[9/16] overflow-hidden rounded-xl border border-white/[0.12] bg-[#07090C] flex flex-col">
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
                /* Interactive storyboard preview for sample session */
                <div className="relative flex h-full w-full flex-col justify-between bg-gradient-to-b from-[#161B24] via-[#0D1016] to-[#080A0D] p-4">
                  <div className="flex items-center justify-between text-[11px] font-mono text-[#8B96A8]">
                    <span>9:16 MP4 · H.264</span>
                    <span className="tabular-nums text-[#F43F5E]">
                      {activeDemoCut
                        ? `${formatSeconds(activeDemoCut.start_sec)} – ${formatSeconds(activeDemoCut.end_sec)}`
                        : '0:00.0'}
                    </span>
                  </div>

                  <div className="my-auto space-y-3 text-center px-2">
                    <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full border border-white/[0.12] bg-white/[0.04]">
                      <Scissors className="h-5 w-5 text-[#F43F5E]" />
                    </div>
                    {currentItem.isMultiClip && activeDemoCut && (
                      <p className="font-mono text-[11px] font-medium text-[#F43F5E]">
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
                      <p className="text-xs leading-relaxed text-[#B8C2D1]">
                        {activeDemoCut.motivo}
                      </p>
                    ) : (
                      <p className="text-xs text-[#8B96A8]">
                        Activa al menos un corte para previsualizar.
                      </p>
                    )}
                  </div>

                  <div className="space-y-3 bg-gradient-to-t from-black/80 via-black/40 to-transparent pt-4">
                    <div className="flex items-center justify-between text-[11px] font-mono text-[#8B96A8]">
                      <span>Sesión de muestra</span>
                      <span className="tabular-nums">
                        Corte {enabledCuts.length > 0 ? demoCutIndex + 1 : 0}/{enabledCuts.length}
                      </span>
                    </div>
                    <button
                      type="button"
                      disabled={enabledCuts.length === 0}
                      onClick={() => setDemoPlaying((prev) => !prev)}
                      className="flex w-full items-center justify-center gap-2 rounded-lg bg-white/[0.1] px-3 py-2 text-xs font-medium text-white hover:bg-white/[0.16] disabled:opacity-40 transition-colors"
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

          {/* FFmpeg Render Progress Bar */}
          {isRendering && renderProgress && (
            <div className="mb-4 rounded-lg border border-white/[0.08] bg-[#151921] p-3 space-y-2">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="flex items-center gap-2 text-[#EDF1F7] truncate">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-[#F59E0B] shrink-0" />
                  <span className="truncate">{renderProgress.message}</span>
                </span>
                <span className="font-mono tabular-nums text-[#F59E0B] shrink-0">
                  {renderProgress.percent}%
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/[0.08]">
                <div
                  className="h-full rounded-full bg-[#F59E0B] transition-transform duration-150 origin-left"
                  style={{ transform: `scaleX(${Math.max(0.04, renderProgress.percent / 100)})` }}
                />
              </div>
            </div>
          )}

          {/* Action Buttons */}
          <div className="mt-auto space-y-2.5">
            <button
              type="button"
              onClick={() => onRerenderItem(currentItem.id)}
              disabled={isRendering || enabledCuts.length === 0 || !hasRealSource}
              title={
                !hasRealSource
                  ? 'Disponible para vídeos reales descargados de Drive o cargados localmente'
                  : undefined
              }
              className="flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-[#E11D48] px-4 text-sm font-medium text-white hover:bg-[#BE123C] disabled:opacity-45 transition-colors whitespace-nowrap"
            >
              <RefreshCw className={`h-4 w-4 ${isRendering ? 'animate-spin' : ''}`} />
              Re-renderizar cortes ({enabledCuts.length})
            </button>

            <div className="grid grid-cols-2 gap-2.5">
              <button
                type="button"
                onClick={handleDownloadEdited}
                disabled={!currentItem.editedUrl}
                className="flex h-9 items-center justify-center gap-2 rounded-lg border border-white/[0.1] bg-[#171B22] px-3 text-xs font-medium text-[#EDF1F7] hover:bg-[#1F2530] disabled:opacity-40 transition-colors whitespace-nowrap"
              >
                <Download className="h-3.5 w-3.5" />
                Descargar MP4
              </button>

              <button
                type="button"
                onClick={() => onRequestDriveUpload(currentItem.id)}
                disabled={isRendering || enabledCuts.length === 0}
                className="flex h-9 items-center justify-center gap-2 rounded-lg border border-white/[0.1] bg-[#171B22] px-3 text-xs font-medium text-[#EDF1F7] hover:bg-[#1F2530] disabled:opacity-40 transition-colors whitespace-nowrap"
              >
                <CloudUpload className="h-3.5 w-3.5 text-[#38BDF8]" />
                Subir a Drive
              </button>
            </div>

            {!canUploadToDrive && (
              <p className="text-[11px] text-[#8B96A8] text-center">
                Conecta Google Drive y define un ID de carpeta en Ajustes para subir el MP4 final.
              </p>
            )}
          </div>
        </section>

        {/* Right Column: AI Edit Plan, Visual Timeline, and Interactive Cut List */}
        <section className="xl:col-span-7 flex flex-col rounded-xl border border-white/[0.08] bg-[#111419] p-5">
          {/* Header Metadata (Zero-Pill clean typographic separators) */}
          <div className="border-b border-white/[0.08] pb-4">
            <div className="flex flex-wrap items-center gap-2 text-xs text-[#8B96A8]">
              <span className="font-mono font-semibold text-[#F43F5E]">{plan.etiqueta}</span>
              <span aria-hidden="true">·</span>
              <span>{currentItem.originalName}</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono tabular-nums">{formatBytes(currentItem.sizeBytes)}</span>
              {currentItem.geminiFileCleaned && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="text-[#10B981]">Temporal de Gemini eliminado</span>
                </>
              )}
            </div>

            <h2 className="mt-2 font-display text-xl font-semibold text-[#EDF1F7]">
              {plan.titulo_interno}
            </h2>

            <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-[#8B96A8]">
              <div>
                <span>Duración seleccionada: </span>
                <strong
                  data-testid="selected-duration"
                  className="font-mono tabular-nums text-[#EDF1F7]"
                >
                  {formatSeconds(selectedDurationSec)}
                </strong>
              </div>
              <div>
                <span>Objetivo IA: </span>
                <strong className="font-mono tabular-nums text-[#C8D0DC]">
                  {plan.duracion_objetivo_seg}s
                </strong>
              </div>
              <div>
                <span>Cortes activos: </span>
                <strong
                  data-testid="active-cuts-count"
                  className="font-mono tabular-nums text-[#EDF1F7]"
                >
                  {enabledCuts.length} / {plan.cortes.length}
                </strong>
              </div>
            </div>
          </div>

          {/* Visual Timeline Track */}
          <div className="py-4 border-b border-white/[0.08]">
            <div className="flex items-center justify-between text-[11px] text-[#8B96A8] mb-2">
              <span>
                {currentItem.isMultiClip
                  ? `Línea de tiempo combinada (${timelineMeta.clipOffsets.length} clips)`
                  : 'Línea de tiempo de cortes sobre bruto'}
              </span>
              <span className="font-mono tabular-nums">
                0:00.0 — {formatSeconds(timelineMeta.totalSec)}
              </span>
            </div>
            <div
              data-testid="studio-timeline-track"
              className="relative h-7 w-full overflow-hidden rounded-md bg-[#090B0E] border border-white/[0.08]"
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
                      className="pointer-events-none absolute top-0 bottom-0 w-px bg-white/[0.18]"
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
                    className={`absolute top-1 bottom-1 rounded-[3px] transition-opacity ${
                      !cut.enabled
                        ? 'bg-white/[0.12] opacity-40'
                        : isSelected
                        ? 'bg-[#FB7185] ring-1 ring-white'
                        : 'bg-[#E11D48] hover:bg-[#F43F5E]'
                    }`}
                  />
                );
              })}
            </div>
          </div>

          {/* Cut List Controls */}
          <div className="flex items-center justify-between py-3">
            <h3 className="font-display text-sm font-semibold text-[#EDF1F7]">
              Cortes sugeridos por Gemini
            </h3>
            <button
              type="button"
              onClick={() => onSelectAllCuts(currentItem.id, !allEnabled)}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-[#8B96A8] hover:text-white transition-colors"
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

          {/* Interactive Cut Rows */}
          <div className="flex-1 divide-y divide-white/[0.06] overflow-y-auto max-h-[460px] pr-1">
            {plan.cortes.map((cut, index) => {
              const clipDuration = Math.max(0, cut.end_sec - cut.start_sec);
              const isFocused = activeCutId === cut.id;
              return (
                <div
                  key={cut.id}
                  className={`flex items-start gap-3.5 py-3.5 px-2 rounded-lg transition-colors ${
                    isFocused ? 'bg-white/[0.04]' : 'hover:bg-white/[0.02]'
                  }`}
                >
                  <label className="mt-0.5 flex items-center">
                    <input
                      type="checkbox"
                      checked={cut.enabled}
                      onChange={() => onToggleCut(currentItem.id, cut.id)}
                      aria-label={`Activar corte ${index + 1}: ${cut.motivo}`}
                      className="h-4 w-4 rounded border-white/25 bg-[#171B22] accent-[#E11D48]"
                    />
                  </label>

                  <button
                    type="button"
                    onClick={() => handleJumpToCut(cut.id)}
                    className="flex-1 text-left min-w-0"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2 min-w-0">
                        <span
                          className={`font-mono text-xs tabular-nums font-medium ${
                            cut.enabled ? 'text-[#EDF1F7]' : 'text-[#687487] line-through'
                          }`}
                        >
                          {String(index + 1).padStart(2, '0')}. {formatSeconds(cut.start_sec)} –{' '}
                          {formatSeconds(cut.end_sec)}
                        </span>
                        {currentItem.isMultiClip && (
                          <>
                            <span className="text-[#4B5565]" aria-hidden="true">
                              ·
                            </span>
                            <span
                              data-testid={`cut-clip-label-${index}`}
                              className="font-mono text-[11px] font-medium text-[#F43F5E] truncate max-w-[200px]"
                              title={getClipDisplayLabel(cut.clip_index).name}
                            >
                              {getClipDisplayLabel(cut.clip_index).short}
                              {getClipDisplayLabel(cut.clip_index).name
                                ? ` (${getClipDisplayLabel(cut.clip_index).name})`
                                : ''}
                            </span>
                          </>
                        )}
                      </div>
                      <span className="font-mono text-xs tabular-nums text-[#8B96A8]">
                        {clipDuration.toFixed(1)}s
                      </span>
                    </div>
                    <p
                      className={`mt-1 text-xs leading-relaxed ${
                        cut.enabled ? 'text-[#B8C2D1]' : 'text-[#5C6778]'
                      }`}
                    >
                      {cut.motivo}
                    </p>
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}
