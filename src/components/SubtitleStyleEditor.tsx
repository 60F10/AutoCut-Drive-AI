import { useEffect, useMemo, useState } from 'react';
import {
  Captions,
  Check,
  Copy,
  FolderSync,
  Plus,
  RefreshCw,
  Save,
  Sparkles,
  Star,
  Trash2,
} from 'lucide-react';
import type {
  SubtitleBackgroundBox,
  SubtitleHighlightMode,
  SubtitleStyleProfile,
} from '../types';
import {
  hexToRgbaCss,
  isBuiltInSubtitleStyleId,
  normalizeSubtitleStyleProfile,
} from '../utils/subtitleStyles';

interface SubtitleStyleEditorProps {
  profiles: SubtitleStyleProfile[];
  defaultStyleId: string;
  driveFonts: string[];
  isDriveConnected: boolean;
  hasFolderId: boolean;
  isSyncingStyles: boolean;
  isSavingStyle: boolean;
  lastSyncSource: 'local' | 'drive';
  onChangeDefaultStyleId: (styleId: string) => void;
  onSyncStyles: () => void;
  onCreateProfile: (
    base?: SubtitleStyleProfile,
    customName?: string
  ) => Promise<SubtitleStyleProfile | null>;
  onDuplicateProfile: (source: SubtitleStyleProfile) => Promise<SubtitleStyleProfile | null>;
  onSaveProfile: (profile: SubtitleStyleProfile) => Promise<SubtitleStyleProfile | null>;
  onDeleteProfile: (profileId: string) => Promise<boolean>;
}

const PREVIEW_HEIGHT_PX = 384;
const PREVIEW_WIDTH_PX = 216;

const SAMPLE_WORDS = ['Esto', 'queda', 'brutal', 'ahora', 'mismo'];

function pickLongestWordIndex(words: string[]): number {
  let longestIdx = 0;
  let longestLen = -1;
  words.forEach((word, idx) => {
    const cleanLen = word.replace(/^[¡¿"'«(\[]+|[.,?!:;"'»)\]]+$/g, '').length || word.length;
    if (cleanLen > longestLen) {
      longestLen = cleanLen;
      longestIdx = idx;
    }
  });
  return longestIdx;
}

function buildOutlineTextShadow(outlinePx: number, outlineColor: string, shadowPx: number): string {
  const shadows: string[] = [];
  if (outlinePx > 0) {
    const r = Math.max(1, Number(outlinePx.toFixed(1)));
    const diag = Number((r * 0.72).toFixed(1));
    shadows.push(
      `${r}px 0 0 ${outlineColor}`,
      `${-r}px 0 0 ${outlineColor}`,
      `0 ${r}px 0 ${outlineColor}`,
      `0 ${-r}px 0 ${outlineColor}`,
      `${diag}px ${diag}px 0 ${outlineColor}`,
      `${-diag}px ${diag}px 0 ${outlineColor}`,
      `${diag}px ${-diag}px 0 ${outlineColor}`,
      `${-diag}px ${-diag}px 0 ${outlineColor}`
    );
  }
  if (shadowPx > 0) {
    const s = Math.max(1, Number(shadowPx.toFixed(1)));
    shadows.push(`${s}px ${s}px ${Math.max(1, s)}px rgba(0, 0, 0, 0.78)`);
  }
  return shadows.join(', ');
}

export function SubtitleStyleEditor({
  profiles,
  defaultStyleId,
  driveFonts,
  isDriveConnected,
  hasFolderId,
  isSyncingStyles,
  isSavingStyle,
  lastSyncSource,
  onChangeDefaultStyleId,
  onSyncStyles,
  onCreateProfile,
  onDuplicateProfile,
  onSaveProfile,
  onDeleteProfile,
}: SubtitleStyleEditorProps) {
  const [selectedId, setSelectedId] = useState<string>(defaultStyleId);
  const [draft, setDraft] = useState<SubtitleStyleProfile>(() => {
    const found = profiles.find((p) => p.id === defaultStyleId) || profiles[0];
    return normalizeSubtitleStyleProfile(found);
  });
  const [dirty, setDirty] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [karaokeWordIdx, setKaraokeWordIdx] = useState(0);
  const [popPulse, setPopPulse] = useState(false);

  const selectedProfile = useMemo(
    () => profiles.find((p) => p.id === selectedId) || profiles[0],
    [profiles, selectedId]
  );

  useEffect(() => {
    if (!selectedProfile) return;
    setSelectedId(selectedProfile.id);
    if (!dirty) {
      setDraft(normalizeSubtitleStyleProfile(selectedProfile));
    }
  }, [selectedProfile, dirty]);

  const sampleTokens = useMemo(() => {
    const picked: string[] = [];
    for (const word of SAMPLE_WORDS) {
      const candidate = [...picked, word].join(' ');
      if (picked.length > 0 && (picked.length >= draft.maxWordsPerBlock || candidate.length > draft.maxCharsPerBlock)) {
        break;
      }
      picked.push(word);
    }
    return picked.map((w) => (draft.uppercase ? w.toUpperCase() : w));
  }, [draft.maxWordsPerBlock, draft.maxCharsPerBlock, draft.uppercase]);

  useEffect(() => {
    if (draft.highlightMode !== 'karaoke') {
      setKaraokeWordIdx(0);
      return;
    }
    const timer = window.setInterval(() => {
      setKaraokeWordIdx((prev) => (prev + 1) % Math.max(1, sampleTokens.length));
    }, 650);
    return () => window.clearInterval(timer);
  }, [draft.highlightMode, sampleTokens.length]);

  const triggerPopPreview = () => {
    setPopPulse(true);
    window.setTimeout(() => setPopPulse(false), 180);
  };

  const showStatusMessage = (msg: string) => {
    setFeedback(msg);
    window.setTimeout(() => setFeedback(null), 2800);
  };

  const selectProfile = (profile: SubtitleStyleProfile) => {
    setSelectedId(profile.id);
    setDraft(normalizeSubtitleStyleProfile(profile));
    setDirty(false);
    setFeedback(null);
  };

  const updateDraft = (patch: Partial<SubtitleStyleProfile>) => {
    setDraft((prev) => ({ ...prev, ...patch }));
    setDirty(true);
  };

  const isSelectedBuiltIn = isBuiltInSubtitleStyleId(draft.id);

  const handleSave = async () => {
    if (isSelectedBuiltIn) {
      const customName =
        draft.nombre === selectedProfile?.nombre
          ? `${draft.nombre} (personalizado)`
          : draft.nombre;
      const created = await onCreateProfile(draft, customName);
      if (created) {
        setSelectedId(created.id);
        setDraft(created);
        setDirty(false);
        showStatusMessage(`Guardado como nuevo perfil «${created.nombre}»`);
      }
      return;
    }

    const saved = await onSaveProfile(draft);
    if (saved) {
      setDraft(saved);
      setDirty(false);
      showStatusMessage(
        isDriveConnected && hasFolderId
          ? 'Perfil guardado en Drive (_AutoCut_Styles/subtitulos)'
          : 'Perfil guardado en este navegador'
      );
    }
  };

  const handleCreateNew = async () => {
    const created = await onCreateProfile(draft, `Estilo ${profiles.length + 1}`);
    if (created) {
      setSelectedId(created.id);
      setDraft(created);
      setDirty(false);
      showStatusMessage(`Perfil «${created.nombre}» creado`);
    }
  };

  const handleDuplicate = async () => {
    const copy = await onDuplicateProfile(draft);
    if (copy) {
      setSelectedId(copy.id);
      setDraft(copy);
      setDirty(false);
      showStatusMessage(`Duplicado como «${copy.nombre}»`);
    }
  };

  const handleDelete = async () => {
    if (isSelectedBuiltIn) return;
    const deletedId = draft.id;
    const deletedName = draft.nombre;
    const ok = await onDeleteProfile(deletedId);
    if (ok) {
      const fallback = profiles.find((p) => p.id !== deletedId) || profiles[0];
      if (fallback) {
        setSelectedId(fallback.id);
        setDraft(normalizeSubtitleStyleProfile(fallback));
      }
      setDirty(false);
      showStatusMessage(`Perfil «${deletedName}» eliminado`);
    }
  };

  const longestWordIdx = useMemo(() => pickLongestWordIndex(sampleTokens), [sampleTokens]);

  // Exact proportional CSS sizing mapped to the 216x384 (9:16) preview canvas
  const previewFontPx = Math.max(9, (PREVIEW_HEIGHT_PX * draft.fontSizePct) / 100);
  const previewOutlinePx =
    draft.backgroundBox === 'box'
      ? 0
      : draft.outlineWidth <= 0
      ? 0
      : Math.max(0.8, (PREVIEW_HEIGHT_PX * draft.outlineWidth) / 100);
  const previewShadowPx =
    draft.shadow <= 0 ? 0 : Math.max(0.8, (PREVIEW_HEIGHT_PX * draft.shadow) / 100);
  const previewBoxPadPx =
    draft.backgroundBox === 'box'
      ? Math.max(3, Math.round((PREVIEW_HEIGHT_PX * Math.max(0.35, draft.outlineWidth)) / 100))
      : 0;
  const previewTextShadow = buildOutlineTextShadow(
    previewOutlinePx,
    draft.outlineColor,
    previewShadowPx
  );

  return (
    <section
      data-testid="settings-subtitle-styles-section"
      className="xl:col-span-12 cyber-panel rounded-md overflow-hidden border border-[#00f0ff]/35"
    >
      {/* Header */}
      <div className="p-5 sm:p-6 border-b border-[#00f0ff]/20 flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-2.5 min-w-0">
          <Captions className="h-5 w-5 text-[#fcee0a] shrink-0 mt-0.5" aria-hidden="true" />
          <div className="space-y-1 min-w-0">
            <h2 className="font-display text-base font-semibold text-[#EEF5FF]">
              Estilo de subtítulos
            </h2>
            <p className="text-xs text-[#94A8C4] leading-relaxed">
              Perfiles compartidos entre PWA, PC y GitHub Actions en{' '}
              <span className="font-mono text-[#00f0ff]">_AutoCut_Styles/subtitulos/</span>. Al lanzar un render, el perfil completo se copia dentro de{' '}
              <span className="font-mono text-[#fcee0a]">job_&lt;id&gt;.json</span> para que sea 100 % reproducible.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <div className="flex items-center gap-2">
            <label
              htmlFor="default-subtitle-style-select"
              className="font-mono text-[11px] text-[#94A8C4] whitespace-nowrap"
            >
              Por defecto:
            </label>
            <select
              id="default-subtitle-style-select"
              data-testid="settings-default-subtitle-style-select"
              value={defaultStyleId}
              onChange={(e) => onChangeDefaultStyleId(e.target.value)}
              className="h-9 rounded-md border border-[#00f0ff]/35 bg-[#05060a] px-2.5 font-mono text-xs text-[#EEF5FF] focus:border-[#00f0ff] focus:outline-none"
            >
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.nombre}
                  {isBuiltInSubtitleStyleId(p.id) ? ' (de serie)' : ''}
                </option>
              ))}
            </select>
          </div>

          <button
            type="button"
            onClick={onSyncStyles}
            disabled={isSyncingStyles || !isDriveConnected || !hasFolderId}
            data-testid="subtitle-styles-sync-btn"
            title={
              isDriveConnected && hasFolderId
                ? 'Sincronizar perfiles y fuentes desde Google Drive'
                : 'Conecta Google Drive y configura la carpeta para sincronizar'
            }
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-[#00f0ff]/35 bg-[#05060a] px-3 font-mono text-xs text-[#00f0ff] hover:bg-[#00f0ff]/12 disabled:opacity-45 transition-colors whitespace-nowrap"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isSyncingStyles ? 'animate-spin' : ''}`} />
            {isSyncingStyles ? 'Sincronizando...' : 'Sincronizar Drive'}
          </button>
        </div>
      </div>

      {/* Profile Picker Bar */}
      <div className="px-5 sm:px-6 py-3.5 border-b border-[#00f0ff]/15 bg-[#05060a]/70 flex flex-wrap items-center justify-between gap-3">
        <div
          role="tablist"
          aria-label="Perfiles de estilo de subtítulos"
          className="flex flex-wrap items-center gap-2"
        >
          {profiles.map((profile) => {
            const active = profile.id === draft.id;
            const isDefault = profile.id === defaultStyleId;
            const builtIn = isBuiltInSubtitleStyleId(profile.id);
            return (
              <button
                key={profile.id}
                type="button"
                role="tab"
                aria-selected={active}
                data-testid={`subtitle-style-item-${profile.id}`}
                onClick={() => selectProfile(profile)}
                className={`inline-flex min-h-[36px] items-center gap-1.5 rounded-md border px-3 py-1.5 font-mono text-xs transition-all ${
                  active
                    ? 'border-[#00f0ff] bg-[#00f0ff]/16 text-[#00f0ff] shadow-[0_0_12px_rgba(0,240,255,0.18)]'
                    : 'border-[#00f0ff]/22 bg-[#0b0e18] text-[#C8D7EC] hover:border-[#00f0ff]/50 hover:text-white'
                }`}
              >
                {isDefault && (
                  <Star className="h-3 w-3 text-[#fcee0a] fill-[#fcee0a] shrink-0" aria-hidden="true" />
                )}
                <span>{profile.nombre}</span>
                {builtIn && (
                  <span className="text-[9px] uppercase tracking-wider text-[#8EA2BD] border border-[#00f0ff]/20 px-1 rounded-sm">
                    serie
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void handleCreateNew()}
            disabled={isSavingStyle}
            data-testid="subtitle-style-create-btn"
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#00f0ff]/35 bg-[#00f0ff]/10 px-2.5 font-mono text-[11px] font-semibold text-[#00f0ff] hover:bg-[#00f0ff]/20 disabled:opacity-45 transition-colors"
          >
            <Plus className="h-3.5 w-3.5" />
            Nuevo
          </button>

          <button
            type="button"
            onClick={() => void handleDuplicate()}
            disabled={isSavingStyle}
            data-testid="subtitle-style-duplicate-btn"
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#fcee0a]/40 bg-[#fcee0a]/10 px-2.5 font-mono text-[11px] font-semibold text-[#fcee0a] hover:bg-[#fcee0a]/20 disabled:opacity-45 transition-colors"
          >
            <Copy className="h-3.5 w-3.5" />
            Duplicar
          </button>

          {!isSelectedBuiltIn && (
            <button
              type="button"
              onClick={() => void handleDelete()}
              disabled={isSavingStyle}
              data-testid="subtitle-style-delete-btn"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#ff2a85]/45 bg-[#ff2a85]/12 px-2.5 font-mono text-[11px] font-semibold text-[#ff85b8] hover:bg-[#ff2a85]/22 disabled:opacity-45 transition-colors"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Borrar
            </button>
          )}
        </div>
      </div>

      {/* Main Editor + Live 9:16 Preview */}
      <div className="p-5 sm:p-6 grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Controls Column */}
        <div className="lg:col-span-7 space-y-5 min-w-0">
          {isSelectedBuiltIn && (
            <div className="rounded-md border border-[#fcee0a]/30 bg-[#fcee0a]/[0.06] px-3.5 py-2.5 text-[11px] text-[#fef08a] leading-relaxed">
              Perfil de serie protegido (no se puede borrar ni sobrescribir). Puedes probar cambios en la vista previa y pulsar{' '}
              <span className="font-mono font-semibold text-[#fcee0a]">Guardar como copia</span> o{' '}
              <span className="font-mono font-semibold text-[#fcee0a]">Duplicar</span>.
            </div>
          )}

          {/* Row 1: Name + Font */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
            <div className="space-y-1.5">
              <label htmlFor="sub-style-name" className="block text-xs font-medium text-[#C8D7EC]">
                Nombre del perfil
              </label>
              <input
                id="sub-style-name"
                data-testid="subtitle-style-name-input"
                type="text"
                value={draft.nombre}
                onChange={(e) => updateDraft({ nombre: e.target.value })}
                className="h-10 w-full rounded-md border border-[#00f0ff]/25 bg-[#05060a] px-3 font-mono text-xs text-[#EEF5FF] focus:border-[#00f0ff] focus:outline-none"
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="sub-style-font" className="block text-xs font-medium text-[#C8D7EC]">
                Familia tipográfica (fontName)
              </label>
              <input
                id="sub-style-font"
                data-testid="subtitle-style-fontname-input"
                type="text"
                value={draft.fontName}
                onChange={(e) => updateDraft({ fontName: e.target.value })}
                placeholder="DejaVu Sans"
                className="h-10 w-full rounded-md border border-[#00f0ff]/25 bg-[#05060a] px-3 font-mono text-xs text-[#EEF5FF] focus:border-[#00f0ff] focus:outline-none"
              />
            </div>
          </div>

          {/* Row 2: Custom Font File from Drive */}
          <div className="space-y-1.5">
            <label htmlFor="sub-style-fontfile" className="block text-xs font-medium text-[#C8D7EC]">
              Fuente propia en Drive (<span className="font-mono text-[#00f0ff]">_AutoCut_Styles/fonts/</span>, opcional)
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              <input
                id="sub-style-fontfile"
                data-testid="subtitle-style-fontfile-input"
                type="text"
                value={draft.fontFile || ''}
                onChange={(e) =>
                  updateDraft({ fontFile: e.target.value.trim() ? e.target.value : undefined })
                }
                placeholder="Ej: Montserrat-ExtraBold.ttf"
                className="h-10 w-full rounded-md border border-[#00f0ff]/25 bg-[#05060a] px-3 font-mono text-xs text-[#EEF5FF] placeholder:text-[#5F738E] focus:border-[#00f0ff] focus:outline-none"
              />
              <select
                aria-label="Seleccionar fuente detectada en Drive"
                value={driveFonts.includes(draft.fontFile || '') ? draft.fontFile || '' : ''}
                onChange={(e) => {
                  const chosen = e.target.value;
                  if (chosen) {
                    const inferredName = chosen.replace(/\.(ttf|otf)$/i, '').replace(/[-_]+/g, ' ');
                    updateDraft({ fontFile: chosen, fontName: inferredName || draft.fontName });
                  } else {
                    updateDraft({ fontFile: undefined });
                  }
                }}
                className="h-10 w-full rounded-md border border-[#00f0ff]/25 bg-[#05060a] px-2.5 font-mono text-xs text-[#C8D7EC] focus:border-[#00f0ff] focus:outline-none"
              >
                <option value="">
                  {driveFonts.length > 0
                    ? `Elegir fuente en Drive (${driveFonts.length})`
                    : 'Fuentes en Drive (0)'}
                </option>
                {driveFonts.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </div>
            <p className="text-[11px] text-[#8EA2BD]">
              Sube archivos <span className="font-mono">.ttf</span> o <span className="font-mono">.otf</span> a{' '}
              <span className="font-mono text-[#C8D7EC]">_AutoCut_Styles/fonts/</span>. Si falta el archivo al renderizar, el worker usa DejaVu Sans automáticamente.
            </p>
          </div>

          {/* Row 3: Highlight Mode & Background Box */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <span className="block text-xs font-medium text-[#C8D7EC]">Modo de resaltado</span>
              <div
                role="radiogroup"
                aria-label="Modo de resaltado de subtítulos"
                className="grid grid-cols-3 gap-1 rounded-md border border-[#00f0ff]/25 bg-[#05060a] p-1"
              >
                {(
                  [
                    { value: 'none', label: 'Ninguno' },
                    { value: 'longest_word', label: 'Clave' },
                    { value: 'karaoke', label: 'Karaoke' },
                  ] as Array<{ value: SubtitleHighlightMode; label: string }>
                ).map((opt) => {
                  const active = draft.highlightMode === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      data-testid={`subtitle-highlight-${opt.value}`}
                      onClick={() => updateDraft({ highlightMode: opt.value })}
                      className={`min-h-[34px] rounded-sm px-2 py-1 font-mono text-[11px] font-medium transition-colors ${
                        active
                          ? 'bg-[#00f0ff]/20 text-[#00f0ff]'
                          : 'text-[#8EA2BD] hover:text-[#EEF5FF]'
                      }`}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="space-y-2">
              <span className="block text-xs font-medium text-[#C8D7EC]">Fondo del texto</span>
              <div
                role="radiogroup"
                aria-label="Fondo del subtítulo"
                className="grid grid-cols-2 gap-1 rounded-md border border-[#00f0ff]/25 bg-[#05060a] p-1"
              >
                {(
                  [
                    { value: 'none', label: 'Sin caja' },
                    { value: 'box', label: 'Caja de fondo' },
                  ] as Array<{ value: SubtitleBackgroundBox; label: string }>
                ).map((opt) => {
                  const active = draft.backgroundBox === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      data-testid={`subtitle-bg-${opt.value}`}
                      onClick={() =>
                        updateDraft({
                          backgroundBox: opt.value,
                          ...(opt.value === 'box' && draft.boxOpacity <= 0 ? { boxOpacity: 0.78 } : {}),
                        })
                      }
                      className={`min-h-[34px] rounded-sm px-2 py-1 font-mono text-[11px] font-medium transition-colors ${
                        active
                          ? 'bg-[#fcee0a]/20 text-[#fcee0a]'
                          : 'text-[#8EA2BD] hover:text-[#EEF5FF]'
                      }`}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Row 4: Sliders (Percentage-based for 720p/1080p consistency) */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label className="space-y-1.5 block">
              <div className="flex items-center justify-between text-xs">
                <span className="text-[#C8D7EC]">Tamaño (% del alto)</span>
                <span className="font-mono text-[#00f0ff] tabular-nums">
                  {draft.fontSizePct.toFixed(2)}% ({Math.round((1920 * draft.fontSizePct) / 100)}px @1080p)
                </span>
              </div>
              <input
                type="range"
                min={1.8}
                max={7.5}
                step={0.05}
                value={draft.fontSizePct}
                onChange={(e) => updateDraft({ fontSizePct: Number(e.target.value) })}
                className="w-full accent-[#00f0ff]"
              />
            </label>

            <label className="space-y-1.5 block">
              <div className="flex items-center justify-between text-xs">
                <span className="text-[#C8D7EC]">Posición desde abajo (%)</span>
                <span className="font-mono text-[#00f0ff] tabular-nums">
                  {draft.positionPct.toFixed(1)}%
                </span>
              </div>
              <input
                type="range"
                min={6}
                max={75}
                step={0.5}
                value={draft.positionPct}
                onChange={(e) => updateDraft({ positionPct: Number(e.target.value) })}
                className="w-full accent-[#00f0ff]"
              />
            </label>

            <label className="space-y-1.5 block">
              <div className="flex items-center justify-between text-xs">
                <span className="text-[#C8D7EC]">
                  {draft.backgroundBox === 'box' ? 'Relleno de caja (%)' : 'Contorno (%)'}
                </span>
                <span className="font-mono text-[#00f0ff] tabular-nums">
                  {draft.outlineWidth.toFixed(2)}%
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={1.2}
                step={0.02}
                value={draft.outlineWidth}
                onChange={(e) => updateDraft({ outlineWidth: Number(e.target.value) })}
                className="w-full accent-[#00f0ff]"
              />
            </label>

            <label className="space-y-1.5 block">
              <div className="flex items-center justify-between text-xs">
                <span className="text-[#C8D7EC]">Sombra (%)</span>
                <span className="font-mono text-[#00f0ff] tabular-nums">
                  {draft.shadow.toFixed(2)}%
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={0.8}
                step={0.02}
                value={draft.shadow}
                onChange={(e) => updateDraft({ shadow: Number(e.target.value) })}
                className="w-full accent-[#00f0ff]"
              />
            </label>
          </div>

          {/* Row 5: Colors + Optional Box Opacity */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <label className="rounded-md border border-[#00f0ff]/20 bg-[#05060a] p-2.5 space-y-1.5 block">
              <span className="block font-mono text-[10px] text-[#94A8C4]">Principal</span>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={draft.primaryColor}
                  onChange={(e) => updateDraft({ primaryColor: e.target.value.toUpperCase() })}
                  className="h-7 w-8 cursor-pointer rounded border border-[#00f0ff]/30 bg-transparent"
                />
                <span className="font-mono text-[11px] text-[#EEF5FF]">{draft.primaryColor}</span>
              </div>
            </label>

            <label className="rounded-md border border-[#00f0ff]/20 bg-[#05060a] p-2.5 space-y-1.5 block">
              <span className="block font-mono text-[10px] text-[#94A8C4]">Resaltado</span>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={draft.highlightColor}
                  onChange={(e) => updateDraft({ highlightColor: e.target.value.toUpperCase() })}
                  className="h-7 w-8 cursor-pointer rounded border border-[#00f0ff]/30 bg-transparent"
                />
                <span className="font-mono text-[11px] text-[#EEF5FF]">{draft.highlightColor}</span>
              </div>
            </label>

            <label className="rounded-md border border-[#00f0ff]/20 bg-[#05060a] p-2.5 space-y-1.5 block">
              <span className="block font-mono text-[10px] text-[#94A8C4]">Contorno</span>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={draft.outlineColor}
                  onChange={(e) => updateDraft({ outlineColor: e.target.value.toUpperCase() })}
                  className="h-7 w-8 cursor-pointer rounded border border-[#00f0ff]/30 bg-transparent"
                />
                <span className="font-mono text-[11px] text-[#EEF5FF]">{draft.outlineColor}</span>
              </div>
            </label>

            <label className="rounded-md border border-[#00f0ff]/20 bg-[#05060a] p-2.5 space-y-1.5 block">
              <span className="block font-mono text-[10px] text-[#94A8C4]">Caja</span>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={draft.boxColor}
                  disabled={draft.backgroundBox !== 'box'}
                  onChange={(e) => updateDraft({ boxColor: e.target.value.toUpperCase() })}
                  className="h-7 w-8 cursor-pointer rounded border border-[#00f0ff]/30 bg-transparent disabled:opacity-40"
                />
                <span className="font-mono text-[11px] text-[#EEF5FF]">
                  {draft.backgroundBox === 'box' ? `${Math.round(draft.boxOpacity * 100)}%` : 'OFF'}
                </span>
              </div>
            </label>
          </div>

          {draft.backgroundBox === 'box' && (
            <label className="space-y-1.5 block">
              <div className="flex items-center justify-between text-xs">
                <span className="text-[#C8D7EC]">Opacidad de la caja de fondo</span>
                <span className="font-mono text-[#fcee0a] tabular-nums">
                  {Math.round(draft.boxOpacity * 100)}%
                </span>
              </div>
              <input
                type="range"
                min={0.15}
                max={1}
                step={0.02}
                value={draft.boxOpacity}
                onChange={(e) => updateDraft({ boxOpacity: Number(e.target.value) })}
                className="w-full accent-[#fcee0a]"
              />
            </label>
          )}

          {/* Row 6: Toggles + Block limits */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-center">
            <div className="flex flex-wrap items-center gap-4">
              <label className="inline-flex items-center gap-2 text-xs text-[#EEF5FF] cursor-pointer">
                <input
                  type="checkbox"
                  checked={draft.bold}
                  onChange={(e) => updateDraft({ bold: e.target.checked })}
                  className="h-4 w-4 accent-[#00f0ff]"
                />
                Negrita
              </label>
              <label className="inline-flex items-center gap-2 text-xs text-[#EEF5FF] cursor-pointer">
                <input
                  type="checkbox"
                  checked={draft.uppercase}
                  onChange={(e) => updateDraft({ uppercase: e.target.checked })}
                  className="h-4 w-4 accent-[#00f0ff]"
                />
                Mayúsculas
              </label>
              <label className="inline-flex items-center gap-2 text-xs text-[#EEF5FF] cursor-pointer">
                <input
                  type="checkbox"
                  data-testid="subtitle-style-pop-toggle"
                  checked={draft.popAnimation}
                  onChange={(e) => {
                    updateDraft({ popAnimation: e.target.checked });
                    if (e.target.checked) triggerPopPreview();
                  }}
                  className="h-4 w-4 accent-[#00f0ff]"
                />
                Animación pop (120 ms)
              </label>
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <label className="space-y-1 block">
                <span className="block font-mono text-[10px] text-[#94A8C4]">Máx. palabras</span>
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={draft.maxWordsPerBlock}
                  onChange={(e) =>
                    updateDraft({ maxWordsPerBlock: Math.max(1, Math.min(10, Number(e.target.value) || 1)) })
                  }
                  className="h-9 w-full rounded-md border border-[#00f0ff]/25 bg-[#05060a] px-2.5 font-mono text-xs text-[#EEF5FF]"
                />
              </label>
              <label className="space-y-1 block">
                <span className="block font-mono text-[10px] text-[#94A8C4]">Máx. caracteres</span>
                <input
                  type="number"
                  min={8}
                  max={60}
                  value={draft.maxCharsPerBlock}
                  onChange={(e) =>
                    updateDraft({ maxCharsPerBlock: Math.max(8, Math.min(60, Number(e.target.value) || 8)) })
                  }
                  className="h-9 w-full rounded-md border border-[#00f0ff]/25 bg-[#05060a] px-2.5 font-mono text-xs text-[#EEF5FF]"
                />
              </label>
            </div>
          </div>

          {/* Save Footer */}
          <div className="pt-3 border-t border-[#00f0ff]/15 flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0 text-xs">
              {feedback ? (
                <span
                  data-testid="subtitle-style-feedback"
                  className="inline-flex items-center gap-1.5 font-mono text-[#00f0ff]"
                >
                  <Check className="h-3.5 w-3.5 shrink-0" />
                  {feedback}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-[#8EA2BD]">
                  <FolderSync className="h-3.5 w-3.5 text-[#00f0ff]/75 shrink-0" />
                  {lastSyncSource === 'drive' && isDriveConnected && hasFolderId
                    ? 'Sincronizado con Drive (_AutoCut_Styles/subtitulos)'
                    : 'Almacenamiento local (conecta Drive para compartir con PC y nube)'}
                </span>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {draft.id !== defaultStyleId && (
                <button
                  type="button"
                  onClick={() => onChangeDefaultStyleId(draft.id)}
                  data-testid="subtitle-style-set-default-btn"
                  className="inline-flex h-9 items-center gap-1.5 rounded-md border border-[#fcee0a]/45 bg-[#fcee0a]/10 px-3 font-mono text-xs font-semibold text-[#fcee0a] hover:bg-[#fcee0a]/20 transition-colors"
                >
                  <Star className="h-3.5 w-3.5" />
                  Usar por defecto
                </button>
              )}

              <button
                type="button"
                onClick={() => void handleSave()}
                disabled={isSavingStyle || (!dirty && !isSelectedBuiltIn)}
                data-testid="subtitle-style-save-btn"
                className="cyber-btn-primary inline-flex h-9 items-center gap-1.5 px-3.5 text-xs font-semibold disabled:opacity-45"
              >
                <Save className="h-3.5 w-3.5" />
                {isSavingStyle
                  ? 'Guardando...'
                  : isSelectedBuiltIn
                  ? 'Guardar como copia'
                  : 'Guardar perfil'}
              </button>
            </div>
          </div>
        </div>

        {/* Live 9:16 Preview Column */}
        <div className="lg:col-span-5 flex flex-col items-center space-y-3">
          <div className="w-full flex items-center justify-between gap-2 max-w-[260px]">
            <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-[#00f0ff]">
              Vista previa 9:16
            </span>
            {draft.popAnimation && (
              <button
                type="button"
                onClick={triggerPopPreview}
                className="inline-flex items-center gap-1 rounded-sm border border-[#00f0ff]/35 bg-[#00f0ff]/10 px-2 py-0.5 font-mono text-[10px] text-[#00f0ff] hover:bg-[#00f0ff]/20"
              >
                <Sparkles className="h-3 w-3" />
                Probar pop
              </button>
            )}
          </div>

          <div
            data-testid="subtitle-style-live-preview"
            style={{ width: `${PREVIEW_WIDTH_PX}px`, height: `${PREVIEW_HEIGHT_PX}px` }}
            className="relative overflow-hidden rounded-md border border-[#00f0ff]/45 bg-gradient-to-b from-[#172038] via-[#263452] to-[#0a0f1c] shadow-[0_0_28px_rgba(0,240,255,0.14)] select-none"
          >
            {/* Simulated sample 9:16 vlog frame */}
            <div
              aria-hidden="true"
              className="absolute inset-0 bg-[radial-gradient(circle_at_50%_28%,rgba(0,240,255,0.22),transparent_58%),radial-gradient(circle_at_80%_75%,rgba(255,42,133,0.18),transparent_50%)]"
            />
            <div
              aria-hidden="true"
              className="absolute left-1/2 top-[16%] -translate-x-1/2 h-20 w-20 rounded-full bg-white/10 border border-white/15 blur-[1px]"
            />
            <div
              aria-hidden="true"
              className="absolute left-1/2 top-[38%] -translate-x-1/2 h-36 w-36 rounded-t-full bg-white/[0.07] border-t border-white/12"
            />

            {/* Subtle top badge */}
            <div className="absolute top-2.5 left-2.5 right-2.5 flex items-center justify-between font-mono text-[9px] text-white/65">
              <span>1080×1920</span>
              <span>{draft.highlightMode}</span>
            </div>

            {/* Subtitle Overlay positioned from bottom by positionPct */}
            <div
              className="absolute left-2.5 right-2.5 flex justify-center pointer-events-none"
              style={{ bottom: `${draft.positionPct}%` }}
            >
              <div
                data-testid="subtitle-preview-text"
                style={{
                  fontFamily: `"${draft.fontName}", "DejaVu Sans", system-ui, sans-serif`,
                  fontSize: `${previewFontPx}px`,
                  fontWeight: draft.bold ? 800 : 400,
                  lineHeight: 1.15,
                  color: draft.primaryColor,
                  textShadow: previewTextShadow || undefined,
                  backgroundColor:
                    draft.backgroundBox === 'box'
                      ? hexToRgbaCss(draft.boxColor, draft.boxOpacity)
                      : 'transparent',
                  padding: draft.backgroundBox === 'box' ? `${previewBoxPadPx}px ${previewBoxPadPx + 4}px` : 0,
                  borderRadius: draft.backgroundBox === 'box' ? '4px' : 0,
                  transform: popPulse ? 'scale(0.8)' : 'scale(1)',
                  transition: 'transform 120ms ease-out',
                }}
                className="text-center max-w-full break-words"
              >
                {sampleTokens.map((token, idx) => {
                  const isHighlighted =
                    (draft.highlightMode === 'longest_word' && idx === longestWordIdx) ||
                    (draft.highlightMode === 'karaoke' && idx === karaokeWordIdx);
                  return (
                    <span
                      key={`${token}-${idx}`}
                      style={isHighlighted ? { color: draft.highlightColor } : undefined}
                    >
                      {token}
                      {idx < sampleTokens.length - 1 ? ' ' : ''}
                    </span>
                  );
                })}
              </div>
            </div>
          </div>

          <p
            data-testid="subtitle-preview-disclaimer"
            className="max-w-[260px] text-center text-[11px] text-[#8EA2BD] leading-relaxed"
          >
            Vista previa aproximada con CSS sobre un fotograma 9:16 de ejemplo; el render final con FFmpeg/libass es el que manda.
          </p>
        </div>
      </div>
    </section>
  );
}
