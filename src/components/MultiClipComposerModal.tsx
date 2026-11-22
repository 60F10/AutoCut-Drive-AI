import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  Cloud,
  Layers,
  Monitor,
  X,
  Zap,
} from 'lucide-react';
import type {
  EditStylePreset,
  ExportQuality,
  QueueItem,
  RenderJobTarget,
  TikTokEditOptions,
} from '../types';
import {
  evaluateMultiClipMobileRamProtection,
  exceedsMobileRamThreshold,
  formatBytes,
  getBaseName,
  isMobileViewportOrUserAgent,
} from '../utils/videoPipeline';
import { EditStyleControls } from './EditStyleControls';

interface MultiClipComposerModalProps {
  open: boolean;
  selectedItems: QueueItem[];
  stylePreset: EditStylePreset;
  onChangeStylePreset: (preset: EditStylePreset) => void;
  customInstruction: string;
  onChangeCustomInstruction: (value: string) => void;
  tiktokOptions: TikTokEditOptions;
  onChangeTikTokOptions: (patch: Partial<TikTokEditOptions>) => void;
  exportQuality: ExportQuality;
  onChangeExportQuality: (quality: ExportQuality) => void;
  onClose: () => void;
  onStartCombine: (
    orderedIds: string[],
    projectName: string,
    stylePreset: EditStylePreset,
    customInstruction: string
  ) => void;
  onStartCloudAnalyze: (
    orderedIds: string[],
    projectName: string,
    stylePreset: EditStylePreset,
    customInstruction: string
  ) => void;
  cloudRenderConfigured: boolean;
  resolvedTarget: RenderJobTarget;
  canUseCloud: boolean;
  isProcessing: boolean;
}

export function MultiClipComposerModal({
  open,
  selectedItems,
  stylePreset,
  onChangeStylePreset,
  customInstruction,
  onChangeCustomInstruction,
  tiktokOptions,
  onChangeTikTokOptions,
  exportQuality,
  onChangeExportQuality,
  onClose,
  onStartCombine,
  onStartCloudAnalyze,
  cloudRenderConfigured,
  resolvedTarget,
  canUseCloud,
  isProcessing,
}: MultiClipComposerModalProps) {
  const [orderedIds, setOrderedIds] = useState<string[]>([]);
  const [projectName, setProjectName] = useState('');
  const [confirmMobile1080p, setConfirmMobile1080p] = useState(false);

  useEffect(() => {
    if (open) {
      setOrderedIds(selectedItems.map((i) => i.id));
      setProjectName('');
      setConfirmMobile1080p(false);
    }
  }, [open, selectedItems]);

  useEffect(() => {
    if (exportQuality === 'mobile_fast') {
      setConfirmMobile1080p(false);
    }
  }, [exportQuality]);

  if (!open) return null;

  const itemMap = new Map(selectedItems.map((item) => [item.id, item]));
  const orderedClips = orderedIds
    .map((id) => itemMap.get(id))
    .filter((item): item is QueueItem => Boolean(item));

  const totalBytes = orderedClips.reduce((sum, item) => sum + (item.sizeBytes || 0), 0);
  const isMobile = isMobileViewportOrUserAgent();
  const mobileRamGuard = evaluateMultiClipMobileRamProtection({
    clipCount: orderedClips.length,
    totalBytes,
    exportQuality,
    isMobile,
  });
  const showRamWarning = mobileRamGuard.shouldWarn || exceedsMobileRamThreshold(totalBytes);
  const previewBase = projectName.trim() || getBaseName(orderedClips[0]?.originalName || 'Proyecto');

  const moveClip = (index: number, direction: -1 | 1) => {
    const targetIdx = index + direction;
    if (targetIdx < 0 || targetIdx >= orderedIds.length) return;
    setOrderedIds((prev) => {
      const next = [...prev];
      const temp = next[index];
      next[index] = next[targetIdx];
      next[targetIdx] = temp;
      return next;
    });
  };

  const launchCloudAnalyze = () => {
    if (orderedClips.length < 2) return;
    setConfirmMobile1080p(false);
    onStartCloudAnalyze(
      orderedClips.map((c) => c.id),
      projectName.trim(),
      stylePreset,
      customInstruction.trim()
    );
  };

  const launchCombine = () => {
    if (orderedClips.length < 2) return;
    setConfirmMobile1080p(false);
    onStartCombine(
      orderedClips.map((c) => c.id),
      projectName.trim(),
      stylePreset,
      customInstruction.trim()
    );
  };

  const canRunRemoteAnalyze = canUseCloud && (resolvedTarget === 'pc' || cloudRenderConfigured);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (orderedClips.length < 2) return;
    if (canRunRemoteAnalyze) {
      launchCloudAnalyze();
      return;
    }
    if (mobileRamGuard.shouldWarn && !confirmMobile1080p) {
      setConfirmMobile1080p(true);
      return;
    }
    launchCombine();
  };

  const handleFastAnalyzeClick = () => {
    if (orderedClips.length < 2) return;
    if (mobileRamGuard.shouldWarn && !confirmMobile1080p) {
      setConfirmMobile1080p(true);
      return;
    }
    launchCombine();
  };

  const handleSwitch720pAndStart = () => {
    onChangeExportQuality('mobile_fast');
    launchCombine();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="multiclip-composer-title"
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-[#05060a]/85 backdrop-blur-md pt-safe-modal"
    >
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-xl rounded-t-2xl sm:rounded-lg cyber-panel shadow-[0_0_40px_rgba(0,240,255,0.14)] overflow-hidden pb-safe"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 p-5 border-b border-[#00f0ff]/20 bg-[#05060a]/70">
          <div className="flex items-center gap-2.5">
            <Layers className="h-5 w-5 text-[#ff2a85] shrink-0" />
            <div>
              <h2
                id="multiclip-composer-title"
                className="font-display text-base font-semibold text-[#EEF5FF]"
              >
                Combinar en 1 vídeo (Modo Multi-Clip)
              </h2>
              <p className="text-xs text-[#94A3B8]">
                En la nube, Whisper transcribe los{' '}
                <span className="font-mono font-semibold text-[#00f0ff]">{orderedClips.length}</span>{' '}
                clips y Gemini monta un guion global con principio, nudo y final.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isProcessing}
            aria-label="Cerrar editor Multi-Clip"
            className="flex h-10 w-10 items-center justify-center rounded-md border border-[#00f0ff]/20 text-[#94A3B8] hover:border-[#00f0ff]/55 hover:bg-[#00f0ff]/10 hover:text-[#00f0ff] transition-colors shrink-0"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4 max-h-[70dvh] overflow-y-auto">
          {/* Optional Project Name */}
          <div className="space-y-1.5">
            <label
              htmlFor="multiclip-project-name"
              className="block text-xs font-medium text-[#CFE2FF]"
            >
              Nombre del proyecto (opcional)
            </label>
            <input
              id="multiclip-project-name"
              type="text"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder="Ej: Escapada_Asturias"
              className="h-11 w-full rounded-md border border-[#00f0ff]/25 bg-[#05060a] px-3 text-xs text-[#EEF5FF] placeholder:text-[#5B6B82] focus:border-[#00f0ff] focus:outline-none focus:shadow-[0_0_12px_rgba(0,240,255,0.2)]"
            />
            <p className="font-mono text-[11px] text-[#fcee0a]/90 truncate">
              Salida: {previewBase}_COMBINADO_EDITADO_ETIQUETA.mp4
            </p>
          </div>

          {/* Style Preset, TikTok Options, Quick Instruction & 720p/1080p Quality */}
          <EditStyleControls
            stylePreset={stylePreset}
            onChangeStylePreset={onChangeStylePreset}
            customInstruction={customInstruction}
            onChangeCustomInstruction={onChangeCustomInstruction}
            tiktokOptions={tiktokOptions}
            onChangeTikTokOptions={onChangeTikTokOptions}
            exportQuality={exportQuality}
            onChangeExportQuality={onChangeExportQuality}
            compact
          />

          {/* Reorderable Clip List */}
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs text-[#94A3B8]">
              <span>Orden de entrada para Gemini</span>
              <span className="font-mono tabular-nums text-[#00f0ff]">
                Total: {formatBytes(totalBytes)}
              </span>
            </div>

            <div className="rounded-md border border-[#00f0ff]/20 bg-[#05060a] divide-y divide-[#00f0ff]/12">
              {orderedClips.map((clip, idx) => (
                <div
                  key={clip.id}
                  data-testid={`multiclip-order-row-${idx}`}
                  className="flex items-center justify-between gap-3 px-3.5 py-2.5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-xs">
                      <span className="font-mono font-semibold text-[#ff2a85] shrink-0">
                        Clip {idx + 1}
                      </span>
                      <span className="truncate font-medium text-[#EEF5FF]">
                        {clip.originalName}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[11px] text-[#7D8EA8] font-mono tabular-nums">
                      {clip.source === 'drive'
                        ? 'Google Drive'
                        : clip.source === 'local'
                        ? 'Galería / Local'
                        : 'Ejemplo'}{' '}
                      · {formatBytes(clip.sizeBytes)}
                    </p>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => moveClip(idx, -1)}
                      disabled={idx === 0}
                      aria-label={`Subir ${clip.originalName}`}
                      className="flex h-10 w-10 items-center justify-center rounded-md border border-[#00f0ff]/25 text-[#CFE2FF] hover:border-[#00f0ff] hover:bg-[#00f0ff]/10 hover:text-[#00f0ff] disabled:opacity-30 transition-colors"
                    >
                      <ArrowUp className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => moveClip(idx, 1)}
                      disabled={idx === orderedClips.length - 1}
                      aria-label={`Bajar ${clip.originalName}`}
                      className="flex h-10 w-10 items-center justify-center rounded-md border border-[#00f0ff]/25 text-[#CFE2FF] hover:border-[#00f0ff] hover:bg-[#00f0ff]/10 hover:text-[#00f0ff] disabled:opacity-30 transition-colors"
                    >
                      <ArrowDown className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Automatic mobile RAM protection (> 3 clips or > 200 MB in 1080p) + desktop > 200 MB notice */}
          {showRamWarning && (
            <div
              role="note"
              data-testid={mobileRamGuard.shouldWarn ? 'mobile-multiclip-ram-guard' : 'mobile-ram-warning'}
              className={`flex items-start gap-2.5 rounded-md border px-3.5 py-3 text-xs ${
                mobileRamGuard.shouldWarn
                  ? 'border-[#ff2a85]/55 bg-[#ff2a85]/[0.1] text-[#ffd1e3]'
                  : 'border-[#fcee0a]/45 bg-[#fcee0a]/[0.08] text-[#fef08a]'
              }`}
            >
              <AlertTriangle
                className={`h-4 w-4 shrink-0 mt-0.5 ${
                  mobileRamGuard.shouldWarn ? 'text-[#ff2a85]' : 'text-[#fcee0a]'
                }`}
              />
              <div className="min-w-0 flex-1 space-y-2">
                {mobileRamGuard.shouldWarn ? (
                  <>
                    <p className="font-semibold text-white">
                      Protección de memoria en móvil (evita cierres en iOS)
                    </p>
                    <p className="leading-relaxed">{mobileRamGuard.reason}</p>
                  </>
                ) : (
                  <p className="leading-relaxed">
                    Los clips suman{' '}
                    <strong className="font-mono tabular-nums text-[#fcee0a]">
                      {formatBytes(totalBytes)}
                    </strong>{' '}
                    (más de 200 MB). El motor secuencial procesa 1 clip a la vez, pero en móvil te recomendamos usar{' '}
                    <strong>720p móvil</strong>.
                  </p>
                )}

                {exportQuality !== 'mobile_fast' ? (
                  <div className="flex flex-wrap items-center gap-2 pt-0.5">
                    <button
                      type="button"
                      data-testid="modal-switch-mobile-720p-btn"
                      onClick={() => onChangeExportQuality('mobile_fast')}
                      className="inline-flex h-9 items-center gap-1.5 rounded-md border border-[#00f0ff]/65 bg-[#00f0ff]/18 px-3 font-mono text-[11px] font-semibold text-[#00f0ff] hover:bg-[#00f0ff]/28 transition-colors"
                    >
                      <Zap className="h-3.5 w-3.5" />
                      Cambiar a 720p móvil
                    </button>
                  </div>
                ) : (
                  <span
                    data-testid="modal-mobile-720p-active"
                    className="inline-flex items-center gap-1.5 font-mono text-[11px] font-semibold text-[#00f0ff]"
                  >
                    <Check className="h-3.5 w-3.5" />
                    Modo 720p móvil activado (baja RAM)
                  </span>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-[#00f0ff]/20 bg-[#05060a]/85 space-y-2.5">
          {confirmMobile1080p && mobileRamGuard.shouldWarn ? (
            <div
              data-testid="mobile-multiclip-confirm-bar"
              className="flex flex-col sm:flex-row items-stretch sm:items-center justify-end gap-2"
            >
              <button
                type="button"
                data-testid="modal-switch-720p-and-start-btn"
                onClick={handleSwitch720pAndStart}
                disabled={isProcessing}
                className="inline-flex h-11 items-center justify-center gap-2 cyber-btn-primary px-4 text-xs font-semibold whitespace-nowrap"
              >
                <Zap className="h-3.5 w-3.5" />
                Cambiar a 720p móvil y continuar
              </button>
              <button
                type="button"
                data-testid="modal-force-1080p-btn"
                onClick={launchCombine}
                disabled={isProcessing}
                className="inline-flex h-11 items-center justify-center gap-2 rounded-md border border-[#ff2a85]/45 bg-[#ff2a85]/10 px-4 text-xs font-medium text-[#ffb3d1] hover:bg-[#ff2a85]/20 transition-colors whitespace-nowrap"
              >
                Seguir en 1080p igualmente
              </button>
            </div>
          ) : (
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={isProcessing}
                className="h-11 rounded-md border border-[#00f0ff]/25 px-3.5 text-xs font-medium text-[#CFE2FF] hover:border-[#00f0ff]/60 hover:bg-[#00f0ff]/10 transition-colors whitespace-nowrap"
              >
                Cancelar
              </button>
              <button
                type="button"
                data-testid="modal-start-combine-btn"
                onClick={handleFastAnalyzeClick}
                disabled={isProcessing || orderedClips.length < 2}
                title="Análisis rápido en el navegador solo con fotogramas (sin audio)"
                className="inline-flex h-11 items-center justify-center gap-1.5 rounded-md border border-[#fcee0a]/35 bg-[#fcee0a]/[0.08] px-3.5 text-xs font-medium text-[#FEF08A] hover:border-[#fcee0a]/65 hover:bg-[#fcee0a]/15 disabled:opacity-45 transition-colors whitespace-nowrap"
              >
                <Zap className="h-3.5 w-3.5" />
                Análisis rápido (sin audio)
              </button>
              <button
                type="button"
                data-testid="modal-start-cloud-analyze-btn"
                onClick={launchCloudAnalyze}
                disabled={!canRunRemoteAnalyze || isProcessing || orderedClips.length < 2}
                title={
                  resolvedTarget === 'cloud' && !cloudRenderConfigured
                    ? 'Enciende el PC o configura GitHub Actions en Ajustes'
                    : !canUseCloud
                    ? 'Conecta Google Drive y configura tu carpeta en Ajustes'
                    : resolvedTarget === 'pc'
                    ? 'Whisper GPU + Gemini multimodal en tu PC Windows'
                    : 'Whisper + Gemini multimodal viendo vídeo y audio en GitHub Actions'
                }
                className="inline-flex h-11 items-center justify-center gap-2 cyber-btn-primary px-4 text-xs font-semibold disabled:opacity-45 whitespace-nowrap"
              >
                {resolvedTarget === 'pc' ? (
                  <Monitor className="h-3.5 w-3.5" />
                ) : (
                  <Cloud className="h-3.5 w-3.5" />
                )}
                <span>Analizar ({orderedClips.length})</span>
                <span className="rounded-sm border border-black/30 bg-black/25 px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider">
                  {resolvedTarget === 'pc' ? 'PC' : 'NUBE'}
                </span>
              </button>
            </div>
          )}
        </div>
      </form>
    </div>
  );
}
