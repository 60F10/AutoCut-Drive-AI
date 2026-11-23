import type {
  SubtitleBackgroundBox,
  SubtitleHighlightMode,
  SubtitleStyleProfile,
} from '../types';

export const DEFAULT_SUBTITLE_STYLE_ID = 'clasico-tiktok';

/**
 * Built-in subtitle style presets shared with worker/render-core.mjs.
 * Sizes and vertical position are stored as % of video height so 720p and 1080p match proportionally.
 *
 * "Clásico TikTok" exact parity against legacy render-core.mjs:
 * - 1080×1920: fontSize=78 (4.0625%), outline=6 (0.3125%), marginV=620 (32.29%), marginH=48 (2.5%)
 * -  720×1280: fontSize=52 (4.0625%), outline=4 (0.3125%), marginV=413 (32.29%), marginH=32 (2.5%)
 */
export const BUILTIN_SUBTITLE_STYLES: readonly SubtitleStyleProfile[] = [
  {
    id: 'clasico-tiktok',
    nombre: 'Clásico TikTok',
    fontName: 'DejaVu Sans',
    fontSizePct: 4.0625,
    bold: true,
    uppercase: false,
    primaryColor: '#FFFFFF',
    highlightColor: '#FFE500',
    outlineColor: '#000000',
    outlineWidth: 0.3125,
    shadow: 0,
    backgroundBox: 'none',
    boxColor: '#000000',
    boxOpacity: 0,
    positionPct: 32.29,
    maxWordsPerBlock: 4,
    maxCharsPerBlock: 26,
    highlightMode: 'longest_word',
    popAnimation: false,
  },
  {
    id: 'karaoke-amarillo',
    nombre: 'Karaoke amarillo',
    fontName: 'DejaVu Sans',
    fontSizePct: 4.3,
    bold: true,
    uppercase: true,
    primaryColor: '#FFFFFF',
    highlightColor: '#FFE500',
    outlineColor: '#000000',
    outlineWidth: 0.35,
    shadow: 0.12,
    backgroundBox: 'none',
    boxColor: '#000000',
    boxOpacity: 0,
    positionPct: 30,
    maxWordsPerBlock: 3,
    maxCharsPerBlock: 22,
    highlightMode: 'karaoke',
    popAnimation: true,
  },
  {
    id: 'minimal',
    nombre: 'Minimal',
    fontName: 'DejaVu Sans',
    fontSizePct: 3.1,
    bold: false,
    uppercase: false,
    primaryColor: '#F8FAFC',
    highlightColor: '#38BDF8',
    outlineColor: '#0F172A',
    outlineWidth: 0.14,
    shadow: 0.16,
    backgroundBox: 'none',
    boxColor: '#000000',
    boxOpacity: 0,
    positionPct: 22,
    maxWordsPerBlock: 5,
    maxCharsPerBlock: 34,
    highlightMode: 'none',
    popAnimation: false,
  },
  {
    id: 'caja-negra',
    nombre: 'Caja negra',
    fontName: 'DejaVu Sans',
    fontSizePct: 3.4,
    bold: true,
    uppercase: false,
    primaryColor: '#FFFFFF',
    highlightColor: '#FACC15',
    outlineColor: '#000000',
    outlineWidth: 0.6,
    shadow: 0,
    backgroundBox: 'box',
    boxColor: '#000000',
    boxOpacity: 0.78,
    positionPct: 26,
    maxWordsPerBlock: 4,
    maxCharsPerBlock: 28,
    highlightMode: 'longest_word',
    popAnimation: false,
  },
];

export const BUILTIN_SUBTITLE_STYLE_IDS = new Set<string>(
  BUILTIN_SUBTITLE_STYLES.map((p) => p.id)
);

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyleProfile = BUILTIN_SUBTITLE_STYLES[0];

export function isBuiltInSubtitleStyleId(id: string | null | undefined): boolean {
  if (!id) return false;
  return BUILTIN_SUBTITLE_STYLE_IDS.has(String(id).trim());
}

export function sanitizeSubtitleStyleId(raw: string): string {
  const cleaned = String(raw || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return cleaned || `estilo-${Date.now().toString(36)}`;
}

export function createCustomSubtitleStyleId(
  nombre: string,
  existingIds: Iterable<string>
): string {
  const used = new Set(Array.from(existingIds));
  const base = sanitizeSubtitleStyleId(nombre || 'mi-estilo');
  if (!used.has(base) && !isBuiltInSubtitleStyleId(base)) {
    return base;
  }
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base}-${i}`;
    if (!used.has(candidate) && !isBuiltInSubtitleStyleId(candidate)) {
      return candidate;
    }
  }
  return `${base}-${Date.now().toString(36)}`;
}

export function normalizeHexColor(value: unknown, fallback: string): string {
  const str = String(value ?? '').trim();
  if (/^#[0-9a-fA-F]{6}$/.test(str)) {
    return str.toUpperCase();
  }
  if (/^[0-9a-fA-F]{6}$/.test(str)) {
    return `#${str.toUpperCase()}`;
  }
  if (/^#[0-9a-fA-F]{3}$/.test(str)) {
    const r = str[1];
    const g = str[2];
    const b = str[3];
    return `#${r}${r}${g}${g}${b}${b}`.toUpperCase();
  }
  return fallback.toUpperCase();
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export function sanitizeFontFileName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim().replace(/^.*[/\\]/, '');
  if (!trimmed) return undefined;
  if (!/\.(ttf|otf)$/i.test(trimmed)) return undefined;
  const safe = trimmed.replace(/[<>:"/\\|?*\x00-\x1F]/g, '');
  return safe || undefined;
}

export function normalizeSubtitleStyleProfile(
  raw: Partial<SubtitleStyleProfile> | null | undefined,
  fallback: SubtitleStyleProfile = DEFAULT_SUBTITLE_STYLE
): SubtitleStyleProfile {
  const src = raw && typeof raw === 'object' ? raw : {};
  const id =
    typeof src.id === 'string' && src.id.trim()
      ? sanitizeSubtitleStyleId(src.id)
      : fallback.id;
  const nombre =
    typeof src.nombre === 'string' && src.nombre.trim()
      ? src.nombre.trim().slice(0, 64)
      : fallback.nombre;
  const fontName =
    typeof src.fontName === 'string' && src.fontName.trim()
      ? src.fontName.trim().replace(/[,;\r\n]/g, '').slice(0, 64) || fallback.fontName
      : fallback.fontName;
  const fontFile = sanitizeFontFileName(src.fontFile);
  const backgroundBox: SubtitleBackgroundBox =
    src.backgroundBox === 'box' ? 'box' : 'none';
  const highlightMode: SubtitleHighlightMode =
    src.highlightMode === 'none' ||
    src.highlightMode === 'karaoke' ||
    src.highlightMode === 'longest_word'
      ? src.highlightMode
      : fallback.highlightMode;

  return {
    id,
    nombre,
    fontName,
    ...(fontFile ? { fontFile } : {}),
    fontSizePct: clampNumber(src.fontSizePct, 1.2, 10, fallback.fontSizePct),
    bold: typeof src.bold === 'boolean' ? src.bold : fallback.bold,
    uppercase: typeof src.uppercase === 'boolean' ? src.uppercase : fallback.uppercase,
    primaryColor: normalizeHexColor(src.primaryColor, fallback.primaryColor),
    highlightColor: normalizeHexColor(src.highlightColor, fallback.highlightColor),
    outlineColor: normalizeHexColor(src.outlineColor, fallback.outlineColor),
    outlineWidth: clampNumber(src.outlineWidth, 0, 2.5, fallback.outlineWidth),
    shadow: clampNumber(src.shadow, 0, 1.5, fallback.shadow),
    backgroundBox,
    boxColor: normalizeHexColor(src.boxColor, fallback.boxColor),
    boxOpacity: clampNumber(src.boxOpacity, 0, 1, fallback.boxOpacity),
    positionPct: clampNumber(src.positionPct, 4, 85, fallback.positionPct),
    maxWordsPerBlock: Math.round(clampNumber(src.maxWordsPerBlock, 1, 10, fallback.maxWordsPerBlock)),
    maxCharsPerBlock: Math.round(clampNumber(src.maxCharsPerBlock, 8, 60, fallback.maxCharsPerBlock)),
    highlightMode,
    popAnimation:
      typeof src.popAnimation === 'boolean' ? src.popAnimation : fallback.popAnimation,
  };
}

/**
 * Converts a `#RRGGBB` color + opacity (0..1, 1=opaque) to ASS `&HAABBGGRR` format.
 * Note: In ASS, alpha 00 = fully opaque and FF = fully transparent.
 */
export function hexToAssColor(hex: string, opacity = 1): string {
  const norm = normalizeHexColor(hex, '#FFFFFF');
  const r = norm.slice(1, 3);
  const g = norm.slice(3, 5);
  const b = norm.slice(5, 7);
  const clampedOpacity = Math.max(0, Math.min(1, Number.isFinite(opacity) ? opacity : 1));
  const alphaByte = Math.round((1 - clampedOpacity) * 255);
  const aa = alphaByte.toString(16).toUpperCase().padStart(2, '0');
  return `&H${aa}${b}${g}${r}`;
}

export function hexToRgbaCss(hex: string, opacity = 1): string {
  const norm = normalizeHexColor(hex, '#000000');
  const r = parseInt(norm.slice(1, 3), 16);
  const g = parseInt(norm.slice(3, 5), 16);
  const b = parseInt(norm.slice(5, 7), 16);
  const a = Math.max(0, Math.min(1, Number.isFinite(opacity) ? opacity : 1));
  return `rgba(${r}, ${g}, ${b}, ${a.toFixed(2)})`;
}

export function cloneSubtitleStyleProfile(
  profile: SubtitleStyleProfile
): SubtitleStyleProfile {
  return normalizeSubtitleStyleProfile(profile, profile);
}

export function duplicateSubtitleStyleProfile(
  source: SubtitleStyleProfile,
  existingIds: Iterable<string>,
  customName?: string
): SubtitleStyleProfile {
  const nombre = (customName || `${source.nombre} (copia)`).trim().slice(0, 64);
  const id = createCustomSubtitleStyleId(nombre, existingIds);
  return normalizeSubtitleStyleProfile({ ...source, id, nombre }, source);
}

export function mergeSubtitleStyleProfiles(
  customProfiles: SubtitleStyleProfile[]
): SubtitleStyleProfile[] {
  const seen = new Set<string>(BUILTIN_SUBTITLE_STYLES.map((p) => p.id));
  const merged: SubtitleStyleProfile[] = BUILTIN_SUBTITLE_STYLES.map((p) =>
    cloneSubtitleStyleProfile(p)
  );
  for (const raw of customProfiles) {
    if (!raw || typeof raw !== 'object') continue;
    const normalized = normalizeSubtitleStyleProfile(raw);
    if (seen.has(normalized.id)) continue;
    seen.add(normalized.id);
    merged.push(normalized);
  }
  return merged;
}

export function resolveSubtitleStyleById(
  profiles: SubtitleStyleProfile[],
  styleId: string | null | undefined
): SubtitleStyleProfile {
  if (styleId) {
    const found = profiles.find((p) => p.id === styleId);
    if (found) return cloneSubtitleStyleProfile(found);
  }
  const builtInDefault = profiles.find((p) => p.id === DEFAULT_SUBTITLE_STYLE_ID);
  return cloneSubtitleStyleProfile(builtInDefault || DEFAULT_SUBTITLE_STYLE);
}
