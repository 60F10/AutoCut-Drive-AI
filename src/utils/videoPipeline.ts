import type {
  AnalyticsRecord,
  DriveFileMeta,
  EditStylePreset,
  ExportQuality,
  FramingMode,
  GeminiEditPlan,
  SubtitleBlock,
  TikTokEditOptions,
  VideoCut,
} from '../types';

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm']);
const EDITED_MARKER = '_EDITADO';

export const MOBILE_RAM_WARNING_BYTES = 200 * 1024 * 1024; // 200 MB
export const HEAVY_VIDEO_DURATION_SEC = 360; // 6 minutes
export const ULTRA_HD_MIN_LONG_EDGE = 3840; // 4K UHD

export function exceedsMobileRamThreshold(totalBytes: number): boolean {
  return totalBytes > MOBILE_RAM_WARNING_BYTES;
}

export interface HeavyVideoAssessment {
  isHeavy: boolean;
  reasons: string[];
  message: string | null;
}

/**
 * Evaluates whether a raw video file is likely to stress mobile browser RAM
 * (e.g. > 200 MB, 4K resolution, or > 6 minutes long) and returns a friendly warning.
 */
export function evaluateHeavyVideoWarning(input: {
  sizeBytes?: number;
  durationSec?: number;
  width?: number;
  height?: number;
}): HeavyVideoAssessment {
  const sizeBytes = Math.max(0, Number(input.sizeBytes) || 0);
  const durationSec = Math.max(0, Number(input.durationSec) || 0);
  const width = Math.max(0, Number(input.width) || 0);
  const height = Math.max(0, Number(input.height) || 0);
  const longEdge = Math.max(width, height);

  const reasons: string[] = [];
  if (sizeBytes > MOBILE_RAM_WARNING_BYTES) {
    reasons.push(`pesa ${formatBytes(sizeBytes)} (> 200 MB)`);
  }
  if (longEdge >= ULTRA_HD_MIN_LONG_EDGE) {
    reasons.push(`resolución 4K (${width}×${height})`);
  }
  if (durationSec > HEAVY_VIDEO_DURATION_SEC) {
    reasons.push(`dura ${formatDurationHuman(durationSec)} (> 6 min)`);
  }

  if (reasons.length === 0) {
    return { isHeavy: false, reasons: [], message: null };
  }

  return {
    isHeavy: true,
    reasons,
    message: `Vídeo bruto pesado detectado (${reasons.join(', ')}). En móvil te recomendamos usar "720p móvil" y cerrar otras pestañas para no saturar la RAM del navegador.`,
  };
}

export interface StylePresetMeta {
  id: EditStylePreset;
  label: string;
  description: string;
  targetDurationHint: string;
  promptDirectives: string;
}

export const EDIT_STYLE_PRESETS: StylePresetMeta[] = [
  {
    id: 'funny_jumpcut',
    label: 'Gracioso / Jump-cut',
    description: 'Cortes secos rápidos, prioriza comentarios graciosos, fails y remates.',
    targetDurationHint: '30–60 s',
    promptDirectives: `Estilo seleccionado: GRACIOSO / JUMP-CUT.
- Ritmo muy rápido mediante cortes secos (jump cuts), eliminando TODOS los silencios, pausas muertas, tiempos de espera y partes aburridas.
- Mantén una narrativa clara: inicio rápido con gancho -> desarrollo con el momento cómico, improviso o problema/fail cotidiano -> remate final gracioso o reacción.
- Prioriza frases espontáneas, quejas cómicas, risas, gestos expresivos y acciones clave visuales.
- Duración adaptativa: si el bruto dura menos de 2-3 minutos, apunta a unos 30 segundos; si es más largo (3 a 10 minutos), apunta a 45-60 segundos.`,
  },
  {
    id: 'agile_vlog',
    label: 'Vlog ágil',
    description: 'Narrativa fluida y natural, conserva contexto y transiciones limpias.',
    targetDurationHint: '35–60 s',
    promptDirectives: `Estilo seleccionado: VLOG ÁGIL.
- Mantén una narrativa fluida, cercana y natural, conservando suficiente contexto para que la historia se entienda sin saltos bruscos excesivos ni forzar el humor.
- Elimina silencios largos, repeticiones, tiempos muertos y momentos sin valor, pero deja respirar brevemente las transiciones entre escenas o ideas clave.
- Prioriza explicaciones claras, planos de contexto visual interesantes, progreso real de la actividad y un cierre natural.
- Duración objetivo: entre 35 y 60 segundos según la riqueza del bruto.`,
  },
  {
    id: 'express_summary',
    label: 'Resumen exprés',
    description: 'Ultra directo al grano (20–30 s), solo puntos clave y acciones principales.',
    targetDurationHint: '20–30 s',
    promptDirectives: `Estilo seleccionado: RESUMEN EXPRÉS.
- Ultra directo al grano: recorta agresivamente cualquier rodeo, saludo largo, pausa o comentario secundario.
- Apunta estrictamente a una duración final compacta de 20 a 30 segundos (duracion_objetivo_seg entre 20 y 30).
- Conserva únicamente el gancho inicial, las acciones principales paso a paso o ideas esenciales y el resultado final.`,
  },
];

export const DEFAULT_TIKTOK_OPTIONS: TikTokEditOptions = {
  subtitlesEnabled: false,
  silenceTrimEnabled: true,
  audioNormalizeEnabled: true,
  framingMode: 'center_crop',
};

export function normalizeFramingMode(value?: unknown): FramingMode {
  return value === 'blur_pad' ? 'blur_pad' : 'center_crop';
}

export function normalizeTikTokOptions(raw?: Partial<TikTokEditOptions> | null): TikTokEditOptions {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_TIKTOK_OPTIONS };
  }
  return {
    subtitlesEnabled: Boolean(raw.subtitlesEnabled),
    silenceTrimEnabled: raw.silenceTrimEnabled !== false,
    audioNormalizeEnabled: raw.audioNormalizeEnabled !== false,
    framingMode: normalizeFramingMode(raw.framingMode),
  };
}

export function normalizeStylePreset(value?: unknown): EditStylePreset {
  if (value === 'agile_vlog' || value === 'express_summary' || value === 'funny_jumpcut') {
    return value;
  }
  return 'funny_jumpcut';
}

export function buildGeminiSystemPrompt(
  mode: 'single' | 'multi',
  stylePreset: EditStylePreset = 'funny_jumpcut',
  customInstruction?: string,
  tiktokOptions?: Partial<TikTokEditOptions>
): string {
  const preset =
    EDIT_STYLE_PRESETS.find((p) => p.id === normalizeStylePreset(stylePreset)) ??
    EDIT_STYLE_PRESETS[0];
  const opts = normalizeTikTokOptions(tiktokOptions);

  const cleanInstruction = typeof customInstruction === 'string' ? customInstruction.trim() : '';

  const intro =
    mode === 'multi'
      ? `Eres un editor de vídeo experto en contenido vertical (Reels/TikTok/Shorts). Recibirás MÚLTIPLES vídeos brutos etiquetados como "Clip 0", "Clip 1", "Clip 2", etc.
Tu objetivo es mezclar y ordenar los mejores momentos de todos los clips proporcionados para construir UNA SOLA historia coherente y dinámica.`
      : `Eres un editor de vídeo experto en contenido vertical (Reels/TikTok/Shorts). Tu objetivo es transformar un vídeo bruto en una pieza vertical ágil y atractiva.`;

  const silenceDirective = opts.silenceTrimEnabled
    ? 'Elimina estrictamente silencios, respiraciones largas y pausas muertas mayores a 0.4 segundos ajustando start_sec y end_sec al milímetro.'
    : 'Respeta pausas naturales breves si aportan ritmo o dramatismo.';

  const technicalRules =
    mode === 'multi'
      ? `Reglas técnicas obligatorias:
1. Puedes alternar libremente entre los distintos clips en el orden narrativo más efectivo.
2. En cada elemento de "cortes" indica obligatoriamente "clip_index" (entero 0, 1, 2... correspondiente al Clip de origen), "start_sec", "end_sec", "motivo" y "puntuacion_interes" (entero de 1 a 10 según su gancho/retención en TikTok).
3. ${silenceDirective} Los timestamps start_sec y end_sec deben ser precisos al decimal para no cortar palabras a medias.
4. Genera una etiqueta corta de 1 palabra en mayúsculas sin tildes que identifique el contenido (ej: COCINA, VLOG, RECETA, FAIL, COCHE, VIAJE).
5. Respeta estrictamente el esquema JSON solicitado.`
      : `Reglas técnicas obligatorias:
1. Usa siempre "clip_index": 0 en cada corte.
2. En cada elemento de "cortes" indica obligatoriamente "start_sec", "end_sec", "motivo" y "puntuacion_interes" (entero de 1 a 10 según su gancho/retención en TikTok).
3. ${silenceDirective} Los timestamps start_sec y end_sec deben ser precisos al decimal para no cortar palabras a medias.
4. Genera una etiqueta corta de 1 palabra en mayúsculas sin tildes que identifique el contenido (ej: COCINA, VLOG, RECETA, FAIL, COCHE, VIAJE).
5. Respeta estrictamente el esquema JSON solicitado.`;

  const subtitlesBlock = opts.subtitlesEnabled
    ? `\n\nSUBTÍTULOS AUTOMÁTICOS ACTIVADOS:
- Devuelve además el campo "subtitulos": un array de bloques cortos (2 a 5 palabras por bloque, estilo TikTok dinámico) cubriendo lo que se dice dentro de los cortes seleccionados.
- Cada bloque debe incluir "clip_index", "start_sec", "end_sec" (marcas exactas sobre el vídeo bruto) y "text" (texto limpio, sin emojis rotos).`
    : '';

  const customBlock = cleanInstruction
    ? `\n\nINSTRUCCIÓN PRIORITARIA DEL USUARIO (cúmplela con máxima prioridad manteniendo el esquema JSON):\n"${cleanInstruction}"`
    : '';

  return `${intro}\n\n${preset.promptDirectives}\n\n${technicalRules}${subtitlesBlock}${customBlock}`;
}

export interface ExportQualityProfile {
  id: ExportQuality;
  label: string;
  shortLabel: string;
  description: string;
  width: number;
  height: number;
  fps: number;
  preset: 'ultrafast' | 'veryfast';
  crf: string;
  maxrate: string;
  bufsize: string;
  h264Profile: 'main' | 'high';
  audioBitrate: '128k' | '192k';
}

export const EXPORT_QUALITY_PROFILES: Record<ExportQuality, ExportQualityProfile> = {
  mobile_fast: {
    id: 'mobile_fast',
    label: 'Rápido móvil — 720p',
    shortLabel: '720p móvil',
    description: '720×1280 · 30 fps · ultrafast · CRF 26 · max 3M · AAC 128k (menos RAM en móvil)',
    width: 720,
    height: 1280,
    fps: 30,
    preset: 'ultrafast',
    crf: '26',
    maxrate: '3M',
    bufsize: '6M',
    h264Profile: 'main',
    audioBitrate: '128k',
  },
  high_1080p: {
    id: 'high_1080p',
    label: 'Máxima calidad — 1080p',
    shortLabel: '1080p HD',
    description: '1080×1920 · 30 fps · veryfast · CRF 21 · max 6M TikTok · AAC 192k',
    width: 1080,
    height: 1920,
    fps: 30,
    preset: 'veryfast',
    crf: '21',
    maxrate: '6M',
    bufsize: '12M',
    h264Profile: 'high',
    audioBitrate: '192k',
  },
};

export function normalizeExportQuality(value?: unknown): ExportQuality {
  return value === 'mobile_fast' ? 'mobile_fast' : 'high_1080p';
}

export function detectDefaultExportQuality(userAgent?: string, screenWidth?: number): ExportQuality {
  const ua =
    typeof userAgent === 'string'
      ? userAgent
      : typeof navigator !== 'undefined'
      ? navigator.userAgent
      : '';
  const width =
    typeof screenWidth === 'number'
      ? screenWidth
      : typeof window !== 'undefined'
      ? window.innerWidth
      : 1280;

  if (/iPhone|iPad|iPod|Android|Mobile|CriOS|FxiOS/i.test(ua) || width < 768) {
    return 'mobile_fast';
  }
  return 'high_1080p';
}

/**
 * Extracts a Google Drive folder ID from either a raw ID or a full Drive folder URL.
 */
export function extractDriveFolderId(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';

  const folderPathMatch = trimmed.match(/\/folders\/([a-zA-Z0-9_-]{8,})/);
  if (folderPathMatch?.[1]) {
    return folderPathMatch[1];
  }

  const queryIdMatch = trimmed.match(/[?&]id=([a-zA-Z0-9_-]{8,})/);
  if (queryIdMatch?.[1]) {
    return queryIdMatch[1];
  }

  return trimmed.replace(/^\/+|\/+$/g, '');
}

export function getExtension(filename: string): string {
  const dotIdx = filename.lastIndexOf('.');
  if (dotIdx <= 0) return '';
  return filename.slice(dotIdx).toLowerCase();
}

export function getBaseName(filename: string): string {
  const dotIdx = filename.lastIndexOf('.');
  if (dotIdx <= 0) return filename;
  return filename.slice(0, dotIdx);
}

export function isSupportedVideoFile(name: string, mimeType?: string): boolean {
  const ext = getExtension(name);
  if (VIDEO_EXTENSIONS.has(ext)) return true;
  if (mimeType) {
    const normalized = mimeType.toLowerCase();
    return (
      normalized.startsWith('video/') ||
      normalized === 'video/mp4' ||
      normalized === 'video/quicktime' ||
      normalized === 'video/webm'
    );
  }
  return false;
}

/**
 * Sanitizes Gemini's `etiqueta` to 1 uppercase word without accents or special characters.
 */
export function sanitizeEtiqueta(raw: string): string {
  const withoutDiacritics = raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .trim();

  const firstToken = withoutDiacritics.split(/[^A-Z0-9]+/).find(Boolean);
  return firstToken || 'VIDEO';
}

export function sanitizeProjectSlug(raw: string): string {
  const cleaned = raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned || 'Proyecto';
}

export function buildEditedFilename(originalName: string, etiqueta: string): string {
  const baseName = getBaseName(originalName).trim();
  const safeTag = sanitizeEtiqueta(etiqueta);
  return `${baseName}${EDITED_MARKER}_${safeTag}.mp4`;
}

/**
 * Multi-clip combined output filename:
 * `{nombreProyectoOPrimerClip}_COMBINADO_EDITADO_{etiqueta}.mp4`
 */
export function buildCombinedEditedFilename(
  projectNameOrFirstClip: string,
  etiqueta: string
): string {
  const rawBase = getBaseName(projectNameOrFirstClip).trim();
  const safeBase = sanitizeProjectSlug(rawBase);
  const safeTag = sanitizeEtiqueta(etiqueta);
  return `${safeBase}_COMBINADO${EDITED_MARKER}_${safeTag}.mp4`;
}

export interface FolderScanResult {
  pending: DriveFileMeta[];
  alreadyEditedSources: DriveFileMeta[];
  editedOutputs: DriveFileMeta[];
}

/**
 * Filters raw videos from a Drive folder, preventing infinite processing loops by checking
 * whether any file in the same folder already starts with `{nombreBase}_EDITADO`.
 */
export function detectPendingVideos(files: DriveFileMeta[]): FolderScanResult {
  const videoFiles = files.filter((file) => isSupportedVideoFile(file.name, file.mimeType));
  const editedOutputs: DriveFileMeta[] = [];
  const rawCandidates: DriveFileMeta[] = [];

  for (const file of videoFiles) {
    if (file.name.toUpperCase().includes(EDITED_MARKER)) {
      editedOutputs.push(file);
    } else {
      rawCandidates.push(file);
    }
  }

  const allUpperNames = files.map((f) => f.name.toUpperCase());
  const pending: DriveFileMeta[] = [];
  const alreadyEditedSources: DriveFileMeta[] = [];

  for (const raw of rawCandidates) {
    const expectedPrefix = `${getBaseName(raw.name).toUpperCase()}${EDITED_MARKER}`;
    const hasEditedVersion = allUpperNames.some((name) => name.startsWith(expectedPrefix));
    if (hasEditedVersion) {
      alreadyEditedSources.push(raw);
    } else {
      pending.push(raw);
    }
  }

  return { pending, alreadyEditedSources, editedOutputs };
}

/**
 * Validates and cleans cuts returned by Gemini.
 * For single-clip edits, sorts chronologically and resolves tiny overlaps.
 * For multi-clip edits, preserves Gemini's narrative cut order across clip_index.
 */
export function normalizeCuts(
  cuts: Array<{
    clip_index?: number;
    start_sec: number;
    end_sec: number;
    motivo: string;
    puntuacion_interes?: number;
    enabled?: boolean;
    id?: string;
  }>,
  options?: {
    maxDurationSec?: number;
    clipCount?: number;
    clipDurationsSec?: number[];
    preserveOrder?: boolean;
  }
): VideoCut[] {
  const clipCount = Math.max(1, options?.clipCount ?? 1);
  const preserveOrder = Boolean(options?.preserveOrder || clipCount > 1);

  const cleaned = cuts
    .map((cut, index) => {
      const rawClipIdx = Number.isFinite(Number(cut.clip_index))
        ? Math.floor(Number(cut.clip_index))
        : 0;
      const clipIndex = Math.max(0, Math.min(clipCount - 1, rawClipIdx));
      const clipMaxDuration =
        options?.clipDurationsSec?.[clipIndex] || options?.maxDurationSec || 0;

      const start = Math.max(0, Number(cut.start_sec) || 0);
      let end = Math.max(0, Number(cut.end_sec) || 0);
      if (clipMaxDuration > 0) {
        end = Math.min(end, clipMaxDuration);
      }

      const rawScore = Number(cut.puntuacion_interes);
      const score =
        Number.isFinite(rawScore) && rawScore > 0
          ? Math.max(1, Math.min(10, Math.round(rawScore)))
          : undefined;

      return {
        id: cut.id ?? `cut-${index + 1}`,
        clip_index: clipIndex,
        start_sec: Number(start.toFixed(2)),
        end_sec: Number(end.toFixed(2)),
        motivo: String(cut.motivo || 'Momento destacado').trim(),
        ...(score !== undefined ? { puntuacion_interes: score } : {}),
        enabled: cut.enabled !== false,
      };
    })
    .filter((cut) => cut.end_sec - cut.start_sec >= 0.15);

  if (preserveOrder) {
    return cleaned;
  }

  cleaned.sort((a, b) => a.start_sec - b.start_sec);

  // Clamp tiny overlaps cleanly for single-clip chronological cuts
  const nonOverlapping: VideoCut[] = [];
  for (const cut of cleaned) {
    const prev = nonOverlapping[nonOverlapping.length - 1];
    if (prev && prev.clip_index === cut.clip_index && cut.start_sec < prev.end_sec) {
      const adjustedStart = Number(prev.end_sec.toFixed(2));
      if (cut.end_sec - adjustedStart >= 0.15) {
        nonOverlapping.push({ ...cut, start_sec: adjustedStart });
      }
    } else {
      nonOverlapping.push(cut);
    }
  }

  return nonOverlapping;
}

export function normalizeSubtitles(
  rawSubtitles: unknown,
  options?: {
    maxDurationSec?: number;
    clipCount?: number;
    clipDurationsSec?: number[];
  }
): SubtitleBlock[] {
  if (!Array.isArray(rawSubtitles)) return [];
  const clipCount = Math.max(1, options?.clipCount ?? 1);

  return rawSubtitles
    .map((entry, idx) => {
      const item = entry as Record<string, unknown>;
      const rawClipIdx = Number.isFinite(Number(item?.clip_index))
        ? Math.floor(Number(item.clip_index))
        : 0;
      const clipIndex = Math.max(0, Math.min(clipCount - 1, rawClipIdx));
      const clipMaxDuration =
        options?.clipDurationsSec?.[clipIndex] || options?.maxDurationSec || 0;

      const start = Math.max(0, Number(item?.start_sec) || 0);
      let end = Math.max(0, Number(item?.end_sec) || 0);
      if (clipMaxDuration > 0) {
        end = Math.min(end, clipMaxDuration);
      }
      const text = String(item?.text ?? '').replace(/\s+/g, ' ').trim();

      return {
        id: typeof item?.id === 'string' && item.id ? item.id : `sub-${idx + 1}`,
        clip_index: clipIndex,
        start_sec: Number(start.toFixed(2)),
        end_sec: Number(end.toFixed(2)),
        text,
      };
    })
    .filter((sub) => sub.text.length > 0 && sub.end_sec - sub.start_sec >= 0.1);
}

/**
 * Filters user-edited EDL cuts keeping only enabled valid segments.
 * Preserves explicit user ordering when `preserveOrder` is true.
 */
export function filterEditedCuts(cuts: VideoCut[], preserveOrder = true): VideoCut[] {
  const valid = cuts.filter(
    (cut) =>
      cut.enabled &&
      Number.isFinite(cut.start_sec) &&
      Number.isFinite(cut.end_sec) &&
      cut.end_sec - cut.start_sec >= 0.15
  );
  if (preserveOrder) {
    return valid;
  }
  return [...valid].sort((a, b) => a.start_sec - b.start_sec);
}

/**
 * Projects raw-clip subtitle timestamps onto the final concatenated timeline
 * according to the user's active & ordered EDL cuts.
 */
export function remapSubtitlesToFinalTimeline(
  subtitles: SubtitleBlock[],
  activeCuts: VideoCut[]
): SubtitleBlock[] {
  if (!subtitles.length || !activeCuts.length) return [];

  const mapped: SubtitleBlock[] = [];
  let cursorSec = 0;

  for (const cut of activeCuts) {
    const cutStart = Math.max(0, cut.start_sec);
    const cutEnd = Math.max(cutStart, cut.end_sec);
    const cutDuration = cutEnd - cutStart;
    if (cutDuration < 0.15) continue;

    const matching = subtitles
      .filter(
        (sub) =>
          (sub.clip_index ?? 0) === (cut.clip_index ?? 0) &&
          sub.end_sec > cutStart &&
          sub.start_sec < cutEnd
      )
      .sort((a, b) => a.start_sec - b.start_sec);

    for (const sub of matching) {
      const clippedStart = Math.max(sub.start_sec, cutStart);
      const clippedEnd = Math.min(sub.end_sec, cutEnd);
      if (clippedEnd - clippedStart < 0.1) continue;

      mapped.push({
        id: `${sub.id}-${mapped.length + 1}`,
        clip_index: cut.clip_index ?? 0,
        start_sec: Number((cursorSec + (clippedStart - cutStart)).toFixed(2)),
        end_sec: Number((cursorSec + (clippedEnd - cutStart)).toFixed(2)),
        text: sub.text,
      });
    }

    cursorSec += cutDuration;
  }

  return mapped;
}

function formatSrtTime(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const totalMs = Math.round(clamped * 1000);
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const secs = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(
    secs
  ).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function formatAssTime(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const totalCs = Math.round(clamped * 100);
  const hours = Math.floor(totalCs / 360_000);
  const minutes = Math.floor((totalCs % 360_000) / 6000);
  const secs = Math.floor((totalCs % 6000) / 100);
  const cs = totalCs % 100;
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(
    cs
  ).padStart(2, '0')}`;
}

export function buildSrtSubtitles(timelineSubtitles: SubtitleBlock[]): string {
  return timelineSubtitles
    .map(
      (sub, idx) =>
        `${idx + 1}\n${formatSrtTime(sub.start_sec)} --> ${formatSrtTime(sub.end_sec)}\n${sub.text}`
    )
    .join('\n\n');
}

export function buildAssSubtitles(
  timelineSubtitles: SubtitleBlock[],
  width = 1080,
  height = 1920
): string {
  const fontSize = Math.round(width * 0.058);
  const marginV = Math.round(height * 0.18);
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: TikTok,DejaVu Sans,${fontSize},&H00FFFFFF,&H0000F0FF,&H0005060A,&H80000000,-1,0,0,0,100,100,0,0,1,4,2,2,48,48,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;

  const lines = timelineSubtitles.map((sub) => {
    const safeText = sub.text.replace(/[{}]/g, '').replace(/\r?\n/g, '\\N');
    return `Dialogue: 0,${formatAssTime(sub.start_sec)},${formatAssTime(sub.end_sec)},TikTok,,0,0,0,,${safeText}`;
  });

  return `${header}\n${lines.join('\n')}\n`;
}

export function parseGeminiEditPlan(
  raw: unknown,
  maxDurationSecOrOptions?:
    | number
    | {
        maxDurationSec?: number;
        clipCount?: number;
        clipDurationsSec?: number[];
        preserveOrder?: boolean;
        subtitlesEnabled?: boolean;
      }
): GeminiEditPlan {
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('La respuesta de Gemini no tiene un formato JSON válido.');
  }

  const options =
    typeof maxDurationSecOrOptions === 'number'
      ? { maxDurationSec: maxDurationSecOrOptions }
      : maxDurationSecOrOptions;

  const obj = parsed as Record<string, unknown>;
  const rawCuts = Array.isArray(obj.cortes) ? obj.cortes : [];
  const cuts = normalizeCuts(
    rawCuts as Array<{
      clip_index?: number;
      start_sec: number;
      end_sec: number;
      motivo: string;
      puntuacion_interes?: number;
    }>,
    options
  );

  if (cuts.length === 0) {
    throw new Error('Gemini no devolvió ningún corte válido para renderizar.');
  }

  const totalSelected = calculateSelectedDuration(cuts);
  const targetDuration = Number(obj.duracion_objetivo_seg);
  const includeSubtitles = options?.subtitlesEnabled === true;
  const subtitulos = includeSubtitles
    ? normalizeSubtitles(obj.subtitulos, options)
    : undefined;

  return {
    etiqueta: sanitizeEtiqueta(String(obj.etiqueta || 'VIDEO')),
    titulo_interno: String(obj.titulo_interno || 'Resumen dinámico editado').trim(),
    duracion_objetivo_seg:
      Number.isFinite(targetDuration) && targetDuration > 0
        ? Math.round(targetDuration)
        : Math.round(totalSelected),
    cortes: cuts,
    ...(subtitulos && subtitulos.length > 0 ? { subtitulos } : {}),
  };
}

export function calculateSelectedDuration(cuts: VideoCut[]): number {
  const total = cuts.reduce((sum, cut) => {
    if (!cut.enabled) return sum;
    return sum + Math.max(0, cut.end_sec - cut.start_sec);
  }, 0);
  return Number(total.toFixed(2));
}

export interface FfmpegPipelineOptions {
  framingMode?: FramingMode;
  silenceTrimEnabled?: boolean;
  audioNormalizeEnabled?: boolean;
  subtitleFileName?: string;
  preserveOrder?: boolean;
}

export interface FfmpegFilterBuild {
  filterComplex: string;
  args: string[];
  activeCount: number;
}

function buildVideoSegmentFilter(
  inputLabel: string,
  idx: number,
  start: string,
  end: string,
  profile: ExportQualityProfile,
  framingMode?: FramingMode
): string[] {
  const w = profile.width;
  const h = profile.height;
  const fps = profile.fps;

  if (framingMode === 'center_crop') {
    return [
      `[${inputLabel}]trim=start=${start}:end=${end},setpts=PTS-STARTPTS,` +
        `scale=${w}:${h}:force_original_aspect_ratio=increase,` +
        `crop=${w}:${h},fps=${fps},format=yuv420p,setsar=1[v${idx}]`,
    ];
  }

  if (framingMode === 'blur_pad') {
    return [
      `[${inputLabel}]trim=start=${start}:end=${end},setpts=PTS-STARTPTS,split=2[bgsrc${idx}][fgsrc${idx}]`,
      `[bgsrc${idx}]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},boxblur=24:4[bg${idx}]`,
      `[fgsrc${idx}]scale=${w}:${h}:force_original_aspect_ratio=decrease[fg${idx}]`,
      `[bg${idx}][fg${idx}]overlay=(W-w)/2:(H-h)/2,fps=${fps},format=yuv420p,setsar=1[v${idx}]`,
    ];
  }

  // Legacy default (decrease + black pad) when framingMode is omitted
  return [
    `[${inputLabel}]trim=start=${start}:end=${end},setpts=PTS-STARTPTS,` +
      `scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
      `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black,` +
      `fps=${fps},format=yuv420p,setsar=1[v${idx}]`,
  ];
}

function buildAudioSegmentFilter(
  inputLabel: string,
  idx: number,
  start: string,
  end: string,
  silenceTrimEnabled: boolean
): string {
  const silenceFilter = silenceTrimEnabled
    ? ',silenceremove=start_periods=1:start_duration=0.15:start_threshold=-42dB'
    : '';
  return (
    `[${inputLabel}]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS` +
    `${silenceFilter},aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a${idx}]`
  );
}

/**
 * Single-clip FFmpeg filter_complex with quality-aware vertical scaling, optional framing mode,
 * optional silence trimming, optional -14 LUFS loudness normalization, and optional burned subtitles.
 */
export function buildFfmpegFilterComplex(
  cuts: VideoCut[],
  inputFileName = 'input.mp4',
  outputFileName = 'output.mp4',
  hasAudio = true,
  exportQuality: ExportQuality = 'high_1080p',
  pipelineOptions?: FfmpegPipelineOptions
): FfmpegFilterBuild {
  const activeCuts = filterEditedCuts(cuts, Boolean(pipelineOptions?.preserveOrder));

  if (activeCuts.length === 0) {
    throw new Error('Activa al menos un corte antes de renderizar el vídeo.');
  }

  const profile = EXPORT_QUALITY_PROFILES[normalizeExportQuality(exportQuality)];
  const filterParts: string[] = [];
  const concatInputs: string[] = [];
  const silenceTrimEnabled = Boolean(pipelineOptions?.silenceTrimEnabled);
  const audioNormalizeEnabled = Boolean(pipelineOptions?.audioNormalizeEnabled);
  const subtitleFileName = pipelineOptions?.subtitleFileName?.trim() || '';

  activeCuts.forEach((cut, idx) => {
    const start = cut.start_sec.toFixed(3);
    const end = cut.end_sec.toFixed(3);
    filterParts.push(
      ...buildVideoSegmentFilter('0:v', idx, start, end, profile, pipelineOptions?.framingMode)
    );
    if (hasAudio) {
      filterParts.push(buildAudioSegmentFilter('0:a', idx, start, end, silenceTrimEnabled));
      concatInputs.push(`[v${idx}][a${idx}]`);
    } else {
      concatInputs.push(`[v${idx}]`);
    }
  });

  if (hasAudio) {
    filterParts.push(`${concatInputs.join('')}concat=n=${activeCuts.length}:v=1:a=1[outv][outa]`);
  } else {
    filterParts.push(`${concatInputs.join('')}concat=n=${activeCuts.length}:v=1:a=0[outv]`);
  }

  let finalVideoLabel = '[outv]';
  if (subtitleFileName) {
    const escapedSub = subtitleFileName.replace(/([\\':])/g, '\\$1');
    filterParts.push(`[outv]subtitles=${escapedSub}[outv_sub]`);
    finalVideoLabel = '[outv_sub]';
  }

  let finalAudioLabel = '[outa]';
  if (hasAudio && audioNormalizeEnabled) {
    filterParts.push('[outa]loudnorm=I=-14:TP=-1.5:LRA=11[outa_norm]');
    finalAudioLabel = '[outa_norm]';
  }

  const filterComplex = filterParts.join(';');

  const args = [
    '-i',
    inputFileName,
    '-filter_complex',
    filterComplex,
    '-map',
    finalVideoLabel,
    ...(hasAudio ? ['-map', finalAudioLabel] : ['-an']),
    '-c:v',
    'libx264',
    '-profile:v',
    profile.h264Profile,
    '-level',
    '4.1',
    '-preset',
    profile.preset,
    '-crf',
    profile.crf,
    '-maxrate',
    profile.maxrate,
    '-bufsize',
    profile.bufsize,
    '-pix_fmt',
    'yuv420p',
    '-r',
    String(profile.fps),
    ...(hasAudio ? ['-c:a', 'aac', '-b:a', profile.audioBitrate, '-ar', '48000'] : []),
    '-movflags',
    '+faststart',
    outputFileName,
  ];

  return {
    filterComplex,
    args,
    activeCount: activeCuts.length,
  };
}

/**
 * Multi-clip FFmpeg filter_complex referencing each input by `clip_index` and normalizing
 * all clips according to `exportQuality`, framing mode, silence trim, -14 LUFS loudness,
 * and optional burned subtitles.
 */
export function buildMultiClipFfmpegFilterComplex(
  cuts: VideoCut[],
  inputFileNames: string[],
  outputFileName = 'output.mp4',
  includeAudio = true,
  exportQuality: ExportQuality = 'high_1080p',
  pipelineOptions?: FfmpegPipelineOptions
): FfmpegFilterBuild {
  if (inputFileNames.length === 0) {
    throw new Error('Se necesita al menos un archivo de entrada para renderizar.');
  }

  // Preserve Gemini's or the user's cross-clip narrative cut order
  const activeCuts = filterEditedCuts(cuts, true);

  if (activeCuts.length === 0) {
    throw new Error('Activa al menos un corte antes de renderizar el vídeo combinado.');
  }

  const profile = EXPORT_QUALITY_PROFILES[normalizeExportQuality(exportQuality)];
  const inputArgs: string[] = [];
  for (const name of inputFileNames) {
    inputArgs.push('-i', name);
  }

  const filterParts: string[] = [];
  const concatInputs: string[] = [];
  const silenceTrimEnabled = Boolean(pipelineOptions?.silenceTrimEnabled);
  const audioNormalizeEnabled = Boolean(pipelineOptions?.audioNormalizeEnabled);
  const subtitleFileName = pipelineOptions?.subtitleFileName?.trim() || '';

  activeCuts.forEach((cut, idx) => {
    const clipIdx = Math.max(0, Math.min(inputFileNames.length - 1, cut.clip_index ?? 0));
    const start = cut.start_sec.toFixed(3);
    const end = cut.end_sec.toFixed(3);

    filterParts.push(
      ...buildVideoSegmentFilter(
        `${clipIdx}:v`,
        idx,
        start,
        end,
        profile,
        pipelineOptions?.framingMode
      )
    );

    if (includeAudio) {
      filterParts.push(
        buildAudioSegmentFilter(`${clipIdx}:a`, idx, start, end, silenceTrimEnabled)
      );
      concatInputs.push(`[v${idx}][a${idx}]`);
    } else {
      concatInputs.push(`[v${idx}]`);
    }
  });

  if (includeAudio) {
    filterParts.push(`${concatInputs.join('')}concat=n=${activeCuts.length}:v=1:a=1[outv][outa]`);
  } else {
    filterParts.push(`${concatInputs.join('')}concat=n=${activeCuts.length}:v=1:a=0[outv]`);
  }

  let finalVideoLabel = '[outv]';
  if (subtitleFileName) {
    const escapedSub = subtitleFileName.replace(/([\\':])/g, '\\$1');
    filterParts.push(`[outv]subtitles=${escapedSub}[outv_sub]`);
    finalVideoLabel = '[outv_sub]';
  }

  let finalAudioLabel = '[outa]';
  if (includeAudio && audioNormalizeEnabled) {
    filterParts.push('[outa]loudnorm=I=-14:TP=-1.5:LRA=11[outa_norm]');
    finalAudioLabel = '[outa_norm]';
  }

  const filterComplex = filterParts.join(';');

  const args = [
    ...inputArgs,
    '-filter_complex',
    filterComplex,
    '-map',
    finalVideoLabel,
    ...(includeAudio ? ['-map', finalAudioLabel] : ['-an']),
    '-c:v',
    'libx264',
    '-profile:v',
    profile.h264Profile,
    '-level',
    '4.1',
    '-preset',
    profile.preset,
    '-crf',
    profile.crf,
    '-maxrate',
    profile.maxrate,
    '-bufsize',
    profile.bufsize,
    '-pix_fmt',
    'yuv420p',
    '-r',
    String(profile.fps),
    ...(includeAudio ? ['-c:a', 'aac', '-b:a', profile.audioBitrate, '-ar', '48000'] : []),
    '-movflags',
    '+faststart',
    outputFileName,
  ];

  return {
    filterComplex,
    args,
    activeCount: activeCuts.length,
  };
}

export interface DailyAnalyticsPoint {
  dateKey: string;
  label: string;
  count: number;
  savedSec: number;
}

export interface TagBreakdownItem {
  etiqueta: string;
  count: number;
  sharePct: number;
}

export interface QueueAnalyticsSummary {
  totalProcessed: number;
  totalSavedSec: number;
  totalRawSec: number;
  totalFinalSec: number;
  avgReductionPct: number;
  dailySeries: DailyAnalyticsPoint[];
  tagBreakdown: TagBreakdownItem[];
}

export function toLocalDateKey(timestampMs: number): string {
  const d = new Date(timestampMs);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function computeQueueAnalytics(
  records: AnalyticsRecord[],
  days = 7,
  referenceDateMs = Date.now()
): QueueAnalyticsSummary {
  const dayBuckets = new Map<string, { label: string; count: number; savedSec: number }>();

  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const dt = new Date(referenceDateMs - offset * 86_400_000);
    const key = toLocalDateKey(dt.getTime());
    const label = dt.toLocaleDateString('es-ES', { day: '2-digit', month: 'short' });
    dayBuckets.set(key, { label, count: 0, savedSec: 0 });
  }

  let totalRawSec = 0;
  let totalFinalSec = 0;
  let totalSavedSec = 0;
  const tagCounts = new Map<string, number>();

  for (const rec of records) {
    const raw = Math.max(0, Number(rec.rawDurationSec) || 0);
    const edited = Math.max(0, Number(rec.editedDurationSec) || 0);
    const saved = Math.max(0, raw - edited);

    totalRawSec += raw;
    totalFinalSec += edited;
    totalSavedSec += saved;

    const tag = sanitizeEtiqueta(rec.etiqueta);
    tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);

    const bucket = dayBuckets.get(rec.dateKey);
    if (bucket) {
      bucket.count += 1;
      bucket.savedSec = Number((bucket.savedSec + saved).toFixed(1));
    }
  }

  const totalProcessed = records.length;
  const avgReductionPct =
    totalRawSec > 0 ? Math.round(((totalRawSec - totalFinalSec) / totalRawSec) * 100) : 0;

  const dailySeries: DailyAnalyticsPoint[] = Array.from(dayBuckets.entries()).map(
    ([dateKey, info]) => ({
      dateKey,
      label: info.label,
      count: info.count,
      savedSec: info.savedSec,
    })
  );

  const tagBreakdown: TagBreakdownItem[] = Array.from(tagCounts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([etiqueta, count]) => ({
      etiqueta,
      count,
      sharePct: totalProcessed > 0 ? Math.round((count / totalProcessed) * 100) : 0,
    }));

  return {
    totalProcessed,
    totalSavedSec: Number(totalSavedSec.toFixed(1)),
    totalRawSec: Number(totalRawSec.toFixed(1)),
    totalFinalSec: Number(totalFinalSec.toFixed(1)),
    avgReductionPct,
    dailySeries,
    tagBreakdown,
  };
}

export function formatSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00.0';
  const totalTenths = Math.round(seconds * 10);
  const mins = Math.floor(totalTenths / 600);
  const wholeSecs = Math.floor((totalTenths % 600) / 10);
  const tenths = totalTenths % 10;
  return `${mins}:${String(wholeSecs).padStart(2, '0')}.${tenths}`;
}

export function formatDurationHuman(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0 s';
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours} h ${mins} min`;
  if (mins > 0) return `${mins} min ${secs} s`;
  return `${secs} s`;
}

export function formatBytes(bytes?: number | string): string {
  const num = typeof bytes === 'string' ? Number(bytes) : bytes ?? 0;
  if (!Number.isFinite(num) || num <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let idx = 0;
  let value = num;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value.toFixed(value >= 100 || idx === 0 ? 0 : 1)} ${units[idx]}`;
}
