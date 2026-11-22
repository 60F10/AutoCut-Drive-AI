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
      className={`cyber-panel rounded-md ${compact ? 'p-4' : 'p-4 sm:p-5'}`}
    >
      {/* Header Row */}
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <Sparkles className="h-4 w-4 text-[#00f0ff] shrink-0" aria-hidden="true" />
          <div className="min-w-0">
            <h2 className="font-display text-sm font-semibold text-[#EEF5FF]">
              Estilo de edición Gemini
            </h2>
            {!expanded && (
              <p className="font-mono text-[11px] text-[#8EA2BD] truncate">
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
              className="inline-flex items-center rounded-md border border-[#00f0ff]/25 bg-[#05060a] p-0.5"
            >
              <button
                type="button"
                onClick={() => onChangeExportQuality('mobile_fast')}
                aria-pressed={exportQuality === 'mobile_fast'}
                data-testid="quality-toggle-mobile"
                className={`inline-flex min-h-[32px] items-center gap-1 rounded-sm px-2.5 py-1 font-mono text-[11px] font-medium transition-colors whitespace-nowrap ${
                  exportQuality === 'mobile_fast'
                    ? 'bg-[#00f0ff]/18 text-[#00f0ff]'
                    : 'text-[#8EA2BD] hover:text-[#EEF5FF]'
                }`}
              >
                <Zap className="h-3 w-3 text-[#fcee0a]" aria-hidden="true" />
                720p móvil
              </button>
              <button
                type="button"
                onClick={() => onChangeExportQuality('high_1080p')}
                aria-pressed={exportQuality === 'high_1080p'}
                data-testid="quality-toggle-1080p"
                className={`inline-flex min-h-[32px] items-center gap-1 rounded-sm px-2.5 py-1 font-mono text-[11px] font-medium transition-colors whitespace-nowrap ${
                  exportQuality === 'high_1080p'
                    ? 'bg-[#00f0ff]/18 text-[#00f0ff]'
                    : 'text-[#8EA2BD] hover:text-[#EEF5FF]'
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
              className="inline-flex h-8 items-center gap-1 rounded-md border border-[#00f0ff]/25 bg-[#05060a] px-2.5 text-xs font-medium text-[#C8D7EC] hover:border-[#00f0ff]/55 hover:text-white transition-colors whitespace-nowrap"
            >
              <SlidersHorizontal className="h-3.5 w-3.5 text-[#00f0ff]" aria-hidden="true" />
              <span className="hidden sm:inline">{expanded ? 'Ocultar' : 'Personalizar'}</span>
              {expanded ? (
                <ChevronUp className="h-3.5 w-3.5 text-[#8EA2BD]" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5 text-[#8EA2BD]" />
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
                  className={`min-h-[44px] rounded-md border px-3.5 py-2.5 text-left transition-all ${
                    selected
                      ? 'border-[#00f0ff] bg-[#00f0ff]/10 text-white shadow-[0_0_16px_rgba(0,240,255,0.16)]'
                      : 'border-[#00f0ff]/20 bg-[#05060a]/85 text-[#C8D7EC] hover:border-[#00f0ff]/45 hover:bg-[#00f0ff]/[0.04]'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className={`text-xs font-semibold ${
                        selected ? 'text-[#00f0ff]' : 'text-[#EEF5FF]'
                      }`}
                    >
                      {preset.label}
                    </span>
                    <span className="font-mono text-[10px] font-medium text-[#fcee0a] tabular-nums shrink-0">
                      {preset.targetDurationHint}
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] leading-snug text-[#94A8C4]">
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
                className="text-xs font-medium text-[#C8D7EC]"
              >
                Instrucción rápida para Gemini (opcional)
              </label>
              {customInstruction.trim().length > 0 && (
                <button
                  type="button"
                  onClick={() => onChangeCustomInstruction('')}
                  className="font-mono text-[11px] text-[#ff2a85] hover:text-[#ff6ca9] transition-colors"
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
              className="w-full resize-none rounded-md border border-[#00f0ff]/25 bg-[#05060a] px-3 py-2 text-xs text-[#EEF5FF] placeholder:text-[#667A96] focus:border-[#00f0ff] focus:outline-none leading-relaxed"
            />
          </div>
        </div>
      )}
    </section>
  );
}
