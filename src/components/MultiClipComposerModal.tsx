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
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/80 backdrop-blur-sm pt-safe"
    >
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-xl rounded-t-2xl sm:rounded-xl border border-white/10 bg-[#121216] shadow-2xl overflow-hidden pb-safe"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 p-5 border-b border-white/10">
          <div className="flex items-center gap-2.5">
            <Layers className="h-5 w-5 text-[#F43F5E] shrink-0" />
            <div>
              <h2
                id="multiclip-composer-title"
                className="font-display text-base font-semibold text-[#EDF1F7]"
              >
                Combinar en 1 vídeo (Modo Multi-Clip)
              </h2>
              <p className="text-xs text-[#8B96A8]">
                Gemini mezclará los mejores momentos de los {orderedClips.length} clips en una sola historia vertical.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isProcessing}
            aria-label="Cerrar editor Multi-Clip"
            className="flex h-9 w-9 items-center justify-center rounded-lg text-[#8B96A8] hover:bg-white/[0.06] hover:text-white transition-colors shrink-0"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4 max-h-[72dvh] overflow-y-auto">
          {/* Optional Project Name */}
          <div className="space-y-1.5">
            <label
              htmlFor="multiclip-project-name"
              className="block text-xs font-medium text-[#C8D0DC]"
            >
              Nombre del proyecto (opcional)
            </label>
            <input
              id="multiclip-project-name"
              type="text"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder="Ej: Escapada_Asturias"
              className="h-10 w-full rounded-lg border border-white/10 bg-[#09090b] px-3 text-xs text-[#EDF1F7] placeholder:text-[#5C6778] focus:border-[#E11D48] focus:outline-none"
            />
            <p className="font-mono text-[11px] text-[#687487] truncate">
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
            <div className="flex items-center justify-between text-xs text-[#8B96A8]">
              <span>Orden de entrada para Gemini</span>
              <span className="font-mono tabular-nums">Total: {formatBytes(totalBytes)}</span>
            </div>

            <div className="rounded-lg border border-white/10 bg-[#09090b] divide-y divide-white/[0.06]">
              {orderedClips.map((clip, idx) => (
                <div
                  key={clip.id}
                  data-testid={`multiclip-order-row-${idx}`}
                  className="flex items-center justify-between gap-3 px-3.5 py-2.5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-xs">
                      <span className="font-mono font-semibold text-[#F43F5E] shrink-0">
                        Clip {idx + 1}
                      </span>
                      <span className="truncate font-medium text-[#EDF1F7]">
                        {clip.originalName}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[11px] text-[#687487] font-mono tabular-nums">
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
                      className="flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 text-[#B8C2D1] hover:bg-white/[0.06] hover:text-white disabled:opacity-30 transition-colors"
                    >
                      <ArrowUp className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => moveClip(idx, 1)}
                      disabled={idx === orderedClips.length - 1}
                      aria-label={`Bajar ${clip.originalName}`}
                      className="flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 text-[#B8C2D1] hover:bg-white/[0.06] hover:text-white disabled:opacity-30 transition-colors"
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
              className="flex items-start gap-2.5 rounded-lg border border-[#F59E0B]/30 bg-[#F59E0B]/[0.07] px-3.5 py-2.5 text-xs text-[#FCD34D]"
            >
              <AlertTriangle className="h-4 w-4 shrink-0 text-[#F59E0B] mt-0.5" />
              <span className="leading-relaxed">
                Los clips suman <strong className="font-mono tabular-nums">{formatBytes(totalBytes)}</strong> (más de 200 MB). En navegadores móviles FFmpeg.wasm puede consumir mucha RAM; te recomendamos usar <strong>720p móvil</strong>.
              </span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2.5 px-5 py-4 border-t border-white/10 bg-[#09090b]/80">
          <button
            type="button"
            onClick={onClose}
            disabled={isProcessing}
            className="h-10 rounded-lg border border-white/10 px-4 text-xs font-medium text-[#C8D0DC] hover:bg-white/[0.05] transition-colors whitespace-nowrap"
          >
            Cancelar
          </button>
          <button
            type="submit"
            disabled={isProcessing || orderedClips.length < 2}
            className="inline-flex h-10 items-center gap-2 rounded-lg bg-[#E11D48] px-4 text-xs font-medium text-white hover:bg-[#BE123C] disabled:opacity-45 transition-colors whitespace-nowrap"
          >
            <Sparkles className="h-3.5 w-3.5" />
            Combinar y editar ({orderedClips.length})
          </button>
        </div>
      </form>
    </div>
  );
}
