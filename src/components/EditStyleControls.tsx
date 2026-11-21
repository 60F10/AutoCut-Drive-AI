import { useState } from 'react';
import { ChevronDown, ChevronUp, SlidersHorizontal, Sparkles, Zap } from 'lucide-react';
import type { EditStylePreset, ExportQuality } from '../types';
import { EDIT_STYLE_PRESETS } from '../utils/videoPipeline';

interface EditStyleControlsProps {
  stylePreset: EditStylePreset;
  onChangeStylePreset: (preset: EditStylePreset) => void;
  customInstruction: string;
  onChangeCustomInstruction: (value: string) => void;
  exportQuality?: ExportQuality;
  onChangeExportQuality?: (quality: ExportQuality) => void;
  collapsible?: boolean;
  defaultExpanded?: boolean;
  compact?: boolean;
}

export function EditStyleControls({
  stylePreset,
  onChangeStylePreset,
  customInstruction,
  onChangeCustomInstruction,
  exportQuality,
  onChangeExportQuality,
  collapsible = false,
  defaultExpanded = true,
  compact = false,
}: EditStyleControlsProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  const activePresetMeta =
    EDIT_STYLE_PRESETS.find((p) => p.id === stylePreset) ?? EDIT_STYLE_PRESETS[0];

  return (
    <section
      aria-label="Estilo de edición e instrucción rápida para Gemini"
      data-testid="edit-style-controls"
      className={`rounded-xl border border-white/10 bg-[#121216] ${
        compact ? 'p-4' : 'p-4 sm:p-5'
      }`}
    >
      {/* Header Row */}
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <Sparkles className="h-4 w-4 text-[#F43F5E] shrink-0" aria-hidden="true" />
          <div className="min-w-0">
            <h2 className="font-display text-sm font-semibold text-[#EDF1F7]">
              Estilo de edición Gemini
            </h2>
            {!expanded && (
              <p className="text-[11px] text-[#8B96A8] truncate">
                {activePresetMeta.label}
                {customInstruction.trim() ? ` · "${customInstruction.trim()}"` : ''}
              </p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Quick Export Quality Toggle when wired */}
          {exportQuality && onChangeExportQuality && (
            <div
              role="group"
              aria-label="Calidad de renderizado FFmpeg"
              className="inline-flex items-center rounded-lg border border-white/10 bg-[#09090b] p-0.5"
            >
              <button
                type="button"
                onClick={() => onChangeExportQuality('mobile_fast')}
                aria-pressed={exportQuality === 'mobile_fast'}
                data-testid="quality-toggle-mobile"
                className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors whitespace-nowrap ${
                  exportQuality === 'mobile_fast'
                    ? 'bg-[#1D232E] text-white'
                    : 'text-[#8B96A8] hover:text-[#EDF1F7]'
                }`}
              >
                <Zap className="h-3 w-3 text-[#10B981]" aria-hidden="true" />
                720p móvil
              </button>
              <button
                type="button"
                onClick={() => onChangeExportQuality('high_1080p')}
                aria-pressed={exportQuality === 'high_1080p'}
                data-testid="quality-toggle-1080p"
                className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors whitespace-nowrap ${
                  exportQuality === 'high_1080p'
                    ? 'bg-[#1D232E] text-white'
                    : 'text-[#8B96A8] hover:text-[#EDF1F7]'
                }`}
              >
                1080p HD
              </button>
            </div>
          )}

          {collapsible && (
            <button
              type="button"
              onClick={() => setExpanded((prev) => !prev)}
              aria-expanded={expanded}
              className="inline-flex h-8 items-center gap-1 rounded-lg border border-white/10 bg-[#09090b] px-2.5 text-xs font-medium text-[#C8D0DC] hover:bg-white/[0.05] transition-colors whitespace-nowrap"
            >
              <SlidersHorizontal className="h-3.5 w-3.5 text-[#8B96A8]" aria-hidden="true" />
              <span className="hidden sm:inline">{expanded ? 'Ocultar' : 'Personalizar'}</span>
              {expanded ? (
                <ChevronUp className="h-3.5 w-3.5 text-[#8B96A8]" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5 text-[#8B96A8]" />
              )}
            </button>
          )}
        </div>
      </div>

      {expanded && (
        <div className="mt-4 space-y-3.5">
          {/* 3 One-Tap Style Presets */}
          <div
            role="radiogroup"
            aria-label="Seleccionar preset de estilo de edición"
            className="grid grid-cols-1 sm:grid-cols-3 gap-2.5"
          >
            {EDIT_STYLE_PRESETS.map((preset) => {
              const selected = stylePreset === preset.id;
              return (
                <button
                  key={preset.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  data-testid={`style-preset-${preset.id}`}
                  onClick={() => onChangeStylePreset(preset.id)}
                  className={`min-h-[44px] rounded-lg border px-3.5 py-2.5 text-left transition-colors ${
                    selected
                      ? 'border-[#E11D48] bg-[#E11D48]/10 text-white'
                      : 'border-white/10 bg-[#09090b] text-[#C8D0DC] hover:border-white/20 hover:bg-white/[0.03]'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-[#EDF1F7]">{preset.label}</span>
                    <span className="font-mono text-[10px] text-[#8B96A8] tabular-nums shrink-0">
                      {preset.targetDurationHint}
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] leading-snug text-[#8B96A8]">
                    {preset.description}
                  </p>
                </button>
              );
            })}
          </div>

          {/* Optional Quick Instruction Box */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <label
                htmlFor={compact ? 'quick-instruction-modal' : 'quick-instruction-queue'}
                className="text-xs font-medium text-[#C8D0DC]"
              >
                Instrucción rápida para Gemini (opcional)
              </label>
              {customInstruction.trim().length > 0 && (
                <button
                  type="button"
                  onClick={() => onChangeCustomInstruction('')}
                  className="text-[11px] text-[#8B96A8] hover:text-white transition-colors"
                >
                  Limpiar
                </button>
              )}
            </div>
            <textarea
              id={compact ? 'quick-instruction-modal' : 'quick-instruction-queue'}
              rows={2}
              maxLength={400}
              value={customInstruction}
              onChange={(e) => onChangeCustomInstruction(e.target.value)}
              placeholder="Ej: Deja sí o sí la parte en la que se cae la taza, máximo 25 seg"
              className="w-full resize-none rounded-lg border border-white/10 bg-[#09090b] px-3 py-2 text-xs text-[#EDF1F7] placeholder:text-[#687487] focus:border-[#E11D48] focus:outline-none leading-relaxed"
            />
          </div>
        </div>
      )}
    </section>
  );
}
