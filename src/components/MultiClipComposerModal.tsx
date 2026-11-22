import { useEffect, useState } from 'react';
import { AlertTriangle, ArrowDown, ArrowUp, Layers, Sparkles, X } from 'lucide-react';
import type { EditStylePreset, ExportQuality, QueueItem } from '../types';
import {
  exceedsMobileRamThreshold,
  formatBytes,
  getBaseName,
} from '../utils/videoPipeline';
import { EditStyleControls } from './EditStyleControls';

interface MultiClipComposerModalProps {
  open: boolean;
  selectedItems: QueueItem[];
  stylePreset: EditStylePreset;
  onChangeStylePreset: (preset: EditStylePreset) => void;
  customInstruction: string;
  onChangeCustomInstruction: (value: string) => void;
  exportQuality: ExportQuality;
  onChangeExportQuality: (quality: ExportQuality) => void;
  onClose: () => void;
  onStartCombine: (
    orderedIds: string[],
    projectName: string,
    stylePreset: EditStylePreset,
    customInstruction: string
  ) => void;
  isProcessing: boolean;
}

export function MultiClipComposerModal({
  open,
  selectedItems,
  stylePreset,
  onChangeStylePreset,
  customInstruction,
  onChangeCustomInstruction,
  exportQuality,
  onChangeExportQuality,
  onClose,
  onStartCombine,
  isProcessing,
}: MultiClipComposerModalProps) {
  const [orderedIds, setOrderedIds] = useState<string[]>([]);
  const [projectName, setProjectName] = useState('');

  useEffect(() => {
    if (open) {
      setOrderedIds(selectedItems.map((i) => i.id));
      setProjectName('');
    }
  }, [open, selectedItems]);

  if (!open) return null;

  const itemMap = new Map(selectedItems.map((item) => [item.id, item]));
  const orderedClips = orderedIds
    .map((id) => itemMap.get(id))
    .filter((item): item is QueueItem => Boolean(item));

  const totalBytes = orderedClips.reduce((sum, item) => sum + (item.sizeBytes || 0), 0);
  const showRamWarning = exceedsMobileRamThreshold(totalBytes);
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

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (orderedClips.length < 2) return;
    onStartCombine(
      orderedClips.map((c) => c.id),
      projectName.trim(),
      stylePreset,
      customInstruction.trim()
    );
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
                Gemini mezclará los mejores momentos de los{' '}
                <span className="font-mono font-semibold text-[#00f0ff]">{orderedClips.length}</span>{' '}
                clips en una sola historia vertical.
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

          {/* Style Preset, Quick Instruction & 720p/1080p Quality */}
          <EditStyleControls
            stylePreset={stylePreset}
            onChangeStylePreset={onChangeStylePreset}
            customInstruction={customInstruction}
            onChangeCustomInstruction={onChangeCustomInstruction}
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

          {/* Discreet non-blocking > 200 MB RAM warning */}
          {showRamWarning && (
            <div
              role="note"
              data-testid="mobile-ram-warning"
              className="flex items-start gap-2.5 rounded-md border border-[#fcee0a]/45 bg-[#fcee0a]/[0.08] px-3.5 py-2.5 text-xs text-[#fef08a]"
            >
              <AlertTriangle className="h-4 w-4 shrink-0 text-[#fcee0a] mt-0.5" />
              <span className="leading-relaxed">
                Los clips suman{' '}
                <strong className="font-mono tabular-nums text-[#fcee0a]">
                  {formatBytes(totalBytes)}
                </strong>{' '}
                (más de 200 MB). En navegadores móviles FFmpeg.wasm puede consumir mucha RAM; te recomendamos usar <strong>720p móvil</strong>.
              </span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2.5 px-5 py-4 border-t border-[#00f0ff]/20 bg-[#05060a]/85">
          <button
            type="button"
            onClick={onClose}
            disabled={isProcessing}
            className="h-11 rounded-md border border-[#00f0ff]/25 px-4 text-xs font-medium text-[#CFE2FF] hover:border-[#00f0ff]/60 hover:bg-[#00f0ff]/10 transition-colors whitespace-nowrap"
          >
            Cancelar
          </button>
          <button
            type="submit"
            disabled={isProcessing || orderedClips.length < 2}
            className="inline-flex h-11 items-center gap-2 cyber-btn-magenta px-5 text-xs disabled:opacity-45 whitespace-nowrap"
          >
            <Sparkles className="h-3.5 w-3.5" />
            Combinar y editar ({orderedClips.length})
          </button>
        </div>
      </form>
    </div>
  );
}
