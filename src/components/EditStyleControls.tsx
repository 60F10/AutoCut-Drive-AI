import { useState } from 'react';
import {
  Captions,
  ChevronDown,
  ChevronUp,
  Crop,
  SlidersHorizontal,
  Sparkles,
  Volume2,
  Waves,
  Zap,
} from 'lucide-react';
import type {
  EditStylePreset,
  ExportQuality,
  FramingMode,
  TikTokEditOptions,
} from '../types';
import { DEFAULT_TIKTOK_OPTIONS, EDIT_STYLE_PRESETS } from '../utils/videoPipeline';

interface EditStyleControlsProps {
  stylePreset: EditStylePreset;
  onChangeStylePreset: (preset: EditStylePreset) => void;
  customInstruction: string;
  onChangeCustomInstruction: (value: string) => void;
  tiktokOptions?: TikTokEditOptions;
  onChangeTikTokOptions?: (patch: Partial<TikTokEditOptions>) => void;
  exportQuality?: ExportQuality;
  onChangeExportQuality?: (quality: ExportQuality) => void;
  collapsible?: boolean;
  defaultExpanded?: boolean;
  compact?: boolean;
}

const FRAMING_MODES: Array<{ id: FramingMode; label: string; hint: string }> = [
  {
    id: 'center_crop',
    label: 'Recorte centrado',
    hint: 'Llena el 9:16 a pantalla completa',
  },
  {
    id: 'blur_pad',
    label: 'Fondo desenfocado',
    hint: 'Conserva vídeo horizontal completo',
  },
];

export function EditStyleControls({
  stylePreset,
  onChangeStylePreset,
  customInstruction,
  onChangeCustomInstruction,
  tiktokOptions = DEFAULT_TIKTOK_OPTIONS,
  onChangeTikTokOptions,
  exportQuality,
  onChangeExportQuality,
  collapsible = false,
  defaultExpanded = true,
  compact = false,
}: EditStyleControlsProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  const activePresetMeta =
    EDIT_STYLE_PRESETS.find((p) => p.id === stylePreset) ?? EDIT_STYLE_PRESETS[0];

  const collapsedSummaryParts = [
    activePresetMeta.label,
    tiktokOptions.framingMode === 'blur_pad' ? 'Fondo blur' : 'Recorte 9:16',
    tiktokOptions.audioNormalizeEnabled ? '-14 LUFS' : null,
    tiktokOptions.subtitlesEnabled ? 'Subtítulos ON' : 'Sin subtítulos',
  ].filter(Boolean);

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
              Motor de edición TikTok & Gemini
            </h2>
            {!expanded && (
              <p className="font-mono text-[11px] text-[#8EA2BD] truncate">
                {collapsedSummaryParts.join(' · ')}
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
        <div className="mt-4 space-y-4">
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

          {/* TikTok Optional Engine Controls */}
          {onChangeTikTokOptions && (
            <div className="rounded-md border border-[#00f0ff]/20 bg-[#05060a]/75 p-3 sm:p-3.5 space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5">
                {/* 1. Automatic Subtitles Switch (OFF by default) */}
                <button
                  type="button"
                  role="switch"
                  aria-checked={tiktokOptions.subtitlesEnabled}
                  data-testid="toggle-subtitles"
                  onClick={() =>
                    onChangeTikTokOptions({
                      subtitlesEnabled: !tiktokOptions.subtitlesEnabled,
                    })
                  }
                  className={`flex min-h-[48px] items-center justify-between gap-3 rounded-md border px-3 py-2 text-left transition-colors ${
                    tiktokOptions.subtitlesEnabled
                      ? 'border-[#ff2a85]/70 bg-[#ff2a85]/12 text-[#EEF5FF]'
                      : 'border-[#00f0ff]/18 bg-[#0c0f1a]/80 text-[#C8D7EC] hover:border-[#00f0ff]/40'
                  }`}
                >
                  <div className="flex items-start gap-2 min-w-0">
                    <Captions
                      className={`h-4 w-4 shrink-0 mt-0.5 ${
                        tiktokOptions.subtitlesEnabled ? 'text-[#ff2a85]' : 'text-[#6A7E99]'
                      }`}
                      aria-hidden="true"
                    />
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-[#EEF5FF] leading-tight">
                        Subtítulos automáticos
                      </p>
                      <p className="mt-0.5 text-[10px] text-[#8EA2BD] leading-snug">
                        {tiktokOptions.subtitlesEnabled
                          ? 'IA + quemado en vídeo'
                          : 'Omitidos (ahorra tiempo y RAM)'}
                      </p>
                    </div>
                  </div>
                  <span
                    aria-hidden="true"
                    className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors ${
                      tiktokOptions.subtitlesEnabled
                        ? 'border-[#ff2a85] bg-[#ff2a85]/35'
                        : 'border-[#00f0ff]/25 bg-[#05060a]'
                    }`}
                  >
                    <span
                      className={`inline-block h-3.5 w-3.5 rounded-full transition-transform ${
                        tiktokOptions.subtitlesEnabled
                          ? 'translate-x-4 bg-[#ff2a85]'
                          : 'translate-x-0.5 bg-[#6A7E99]'
                      }`}
                    />
                  </span>
                </button>

                {/* 2. Automatic Silence Trimming Switch (ON by default) */}
                <button
                  type="button"
                  role="switch"
                  aria-checked={tiktokOptions.silenceTrimEnabled}
                  data-testid="toggle-silence-trim"
                  onClick={() =>
                    onChangeTikTokOptions({
                      silenceTrimEnabled: !tiktokOptions.silenceTrimEnabled,
                    })
                  }
                  className={`flex min-h-[48px] items-center justify-between gap-3 rounded-md border px-3 py-2 text-left transition-colors ${
                    tiktokOptions.silenceTrimEnabled
                      ? 'border-[#00f0ff]/60 bg-[#00f0ff]/10 text-[#EEF5FF]'
                      : 'border-[#00f0ff]/18 bg-[#0c0f1a]/80 text-[#C8D7EC] hover:border-[#00f0ff]/40'
                  }`}
                >
                  <div className="flex items-start gap-2 min-w-0">
                    <Waves
                      className={`h-4 w-4 shrink-0 mt-0.5 ${
                        tiktokOptions.silenceTrimEnabled ? 'text-[#00f0ff]' : 'text-[#6A7E99]'
                      }`}
                      aria-hidden="true"
                    />
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-[#EEF5FF] leading-tight">
                        Recorte de silencios
                      </p>
                      <p className="mt-0.5 text-[10px] text-[#8EA2BD] leading-snug">
                        Elimina pausas muertas
                      </p>
                    </div>
                  </div>
                  <span
                    aria-hidden="true"
                    className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors ${
                      tiktokOptions.silenceTrimEnabled
                        ? 'border-[#00f0ff] bg-[#00f0ff]/30'
                        : 'border-[#00f0ff]/25 bg-[#05060a]'
                    }`}
                  >
                    <span
                      className={`inline-block h-3.5 w-3.5 rounded-full transition-transform ${
                        tiktokOptions.silenceTrimEnabled
                          ? 'translate-x-4 bg-[#00f0ff]'
                          : 'translate-x-0.5 bg-[#6A7E99]'
                      }`}
                    />
                  </span>
                </button>

                {/* 3. Social Audio Normalization (-14 LUFS) Switch (ON by default) */}
                <button
                  type="button"
                  role="switch"
                  aria-checked={tiktokOptions.audioNormalizeEnabled}
                  data-testid="toggle-audio-normalize"
                  onClick={() =>
                    onChangeTikTokOptions({
                      audioNormalizeEnabled: !tiktokOptions.audioNormalizeEnabled,
                    })
                  }
                  className={`flex min-h-[48px] items-center justify-between gap-3 rounded-md border px-3 py-2 text-left transition-colors ${
                    tiktokOptions.audioNormalizeEnabled
                      ? 'border-[#fcee0a]/60 bg-[#fcee0a]/[0.08] text-[#EEF5FF]'
                      : 'border-[#00f0ff]/18 bg-[#0c0f1a]/80 text-[#C8D7EC] hover:border-[#00f0ff]/40'
                  }`}
                >
                  <div className="flex items-start gap-2 min-w-0">
                    <Volume2
                      className={`h-4 w-4 shrink-0 mt-0.5 ${
                        tiktokOptions.audioNormalizeEnabled ? 'text-[#fcee0a]' : 'text-[#6A7E99]'
                      }`}
                      aria-hidden="true"
                    />
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-[#EEF5FF] leading-tight">
                        Normalización -14 LUFS
                      </p>
                      <p className="mt-0.5 text-[10px] text-[#8EA2BD] leading-snug">
                        Audio parejo para redes
                      </p>
                    </div>
                  </div>
                  <span
                    aria-hidden="true"
                    className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors ${
                      tiktokOptions.audioNormalizeEnabled
                        ? 'border-[#fcee0a] bg-[#fcee0a]/30'
                        : 'border-[#00f0ff]/25 bg-[#05060a]'
                    }`}
                  >
                    <span
                      className={`inline-block h-3.5 w-3.5 rounded-full transition-transform ${
                        tiktokOptions.audioNormalizeEnabled
                          ? 'translate-x-4 bg-[#fcee0a]'
                          : 'translate-x-0.5 bg-[#6A7E99]'
                      }`}
                    />
                  </span>
                </button>
              </div>

              {/* 9:16 Framing Mode Selector */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pt-2 border-t border-[#00f0ff]/15">
                <div className="flex items-center gap-2 text-xs font-medium text-[#C8D7EC]">
                  <Crop className="h-3.5 w-3.5 text-[#00f0ff] shrink-0" aria-hidden="true" />
                  <span>Modo de encuadre 9:16</span>
                </div>
                <div
                  role="radiogroup"
                  aria-label="Modo de encuadre 9:16"
                  className="grid grid-cols-2 gap-2 sm:w-auto"
                >
                  {FRAMING_MODES.map((mode) => {
                    const selected = tiktokOptions.framingMode === mode.id;
                    return (
                      <button
                        key={mode.id}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        data-testid={`framing-mode-${mode.id}`}
                        onClick={() => onChangeTikTokOptions({ framingMode: mode.id })}
                        className={`min-h-[40px] rounded-md border px-3 py-1.5 text-left transition-colors ${
                          selected
                            ? 'border-[#00f0ff] bg-[#00f0ff]/14 text-[#00f0ff]'
                            : 'border-[#00f0ff]/20 bg-[#0c0f1a]/80 text-[#94A8C4] hover:border-[#00f0ff]/45 hover:text-[#EEF5FF]'
                        }`}
                      >
                        <p className="font-mono text-[11px] font-semibold leading-tight">
                          {mode.label}
                        </p>
                        <p className="text-[10px] text-[#8EA2BD] leading-tight mt-0.5">
                          {mode.hint}
                        </p>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

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
