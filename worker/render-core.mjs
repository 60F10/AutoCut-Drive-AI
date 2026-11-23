/**
 * AutoCut Drive AI — Shared Native FFmpeg Render Core
 *
 * Reused by both `worker/pc-worker.mjs` (local Windows/macOS/Linux PC worker)
 * and `worker/cloud-worker.mjs` (GitHub Actions ubuntu-latest runner).
 * Zero external npm dependencies — Node.js built-ins only.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const QUALITY_PROFILES = {
  '720p': {
    width: 720,
    height: 1280,
    fps: 30,
    crf: '24',
    nvencCq: '23',
    maxrate: '3800k',
    bufsize: '7600k',
    audioBitrate: '128k',
  },
  '1080p': {
    width: 1080,
    height: 1920,
    fps: 30,
    crf: '21',
    nvencCq: '20',
    maxrate: '6500k',
    bufsize: '13000k',
    audioBitrate: '160k',
  },
};

export const SDR_COLOR_ARGS = [
  '-colorspace',
  'bt709',
  '-color_primaries',
  'bt709',
  '-color_trc',
  'bt709',
];

const HLG_TO_SDR_FILTER =
  'zscale=tin=arib-std-b67:min=bt2020nc:pin=bt2020:rin=tv:t=linear:npl=203,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0:peak=4,zscale=t=bt709:m=bt709:r=tv,format=yuv420p';

const PQ_TO_SDR_FILTER =
  'zscale=tin=smpte2084:min=bt2020nc:pin=bt2020:rin=tv:t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0:peak=4,zscale=t=bt709:m=bt709:r=tv,format=yuv420p';

/**
 * Returns the tuned CPU libx264 preset for cloud runners (no GPU):
 * - 1080p -> veryfast
 * - 720p  -> ultrafast
 */
export function getCloudCpuPreset(quality) {
  return quality === '720p' ? 'ultrafast' : 'veryfast';
}

/**
 * Derives the companion `ffprobe` binary path from a given `ffmpeg` binary path.
 */
export function resolveFfprobeBin(ffmpegBin = 'ffmpeg') {
  const str = String(ffmpegBin || 'ffmpeg').trim();
  if (!str || str === 'ffmpeg') return 'ffprobe';
  const dir = path.dirname(str);
  const base = path.basename(str);
  const replaced = base.replace(/ffmpeg/i, (m) => (m === m.toUpperCase() ? 'FFPROBE' : 'ffprobe'));
  if (replaced === base) return 'ffprobe';
  return dir === '.' ? replaced : path.join(dir, replaced);
}

/**
 * Returns the exact HDR -> SDR BT.709 tonemap filter chain for iPhone HLG (`arib-std-b67`)
 * or PQ (`smpte2084`) footage, or empty string for SDR footage (or when zscale is disabled).
 */
export function buildHdrToSdrFilterChain(colorTransfer, zscaleAvailable = true) {
  if (!zscaleAvailable) return '';
  const normalized = String(colorTransfer || '')
    .trim()
    .toLowerCase();
  if (normalized === 'arib-std-b67') return HLG_TO_SDR_FILTER;
  if (normalized === 'smpte2084') return PQ_TO_SDR_FILTER;
  return '';
}

/**
 * Escapes an absolute filesystem path for FFmpeg's `ass=` / `subtitles=` filtergraph
 * on both Windows (`C:\Users\...`) and POSIX systems.
 */
export function escapePathForFfmpegFilter(filePath) {
  return filePath
    .replace(/\\/g, '/')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

function formatAssTime(seconds) {
  const clamped = Math.max(0, Number(seconds) || 0);
  const totalCs = Math.round(clamped * 100);
  const hours = Math.floor(totalCs / 360000);
  const minutes = Math.floor((totalCs % 360000) / 6000);
  const secs = Math.floor((totalCs % 6000) / 100);
  const cs = totalCs % 100;
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(
    cs
  ).padStart(2, '0')}`;
}

export const BUILTIN_SUBTITLE_STYLES = [
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

export const DEFAULT_SUBTITLE_STYLE = BUILTIN_SUBTITLE_STYLES[0];

function normalizeHexColor(value, fallback) {
  const str = String(value ?? '').trim();
  if (/^#[0-9a-fA-F]{6}$/.test(str)) return str.toUpperCase();
  if (/^[0-9a-fA-F]{6}$/.test(str)) return `#${str.toUpperCase()}`;
  if (/^#[0-9a-fA-F]{3}$/.test(str)) {
    return `#${str[1]}${str[1]}${str[2]}${str[2]}${str[3]}${str[3]}`.toUpperCase();
  }
  return fallback.toUpperCase();
}

function clampStyleNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function sanitizeFontFileName(raw) {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim().replace(/^.*[/\\]/, '');
  if (!trimmed || !/\.(ttf|otf)$/i.test(trimmed)) return undefined;
  const safe = trimmed.replace(/[<>:"/\\|?*\x00-\x1F]/g, '');
  return safe || undefined;
}

/**
 * Normalizes a `SubtitleStyleProfile` object, falling back safely to Clásico TikTok defaults.
 */
export function normalizeSubtitleStyle(raw, fallback = DEFAULT_SUBTITLE_STYLE) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const fontName =
    typeof src.fontName === 'string' && src.fontName.trim()
      ? src.fontName.trim().replace(/[,;\r\n]/g, '').slice(0, 64) || fallback.fontName
      : fallback.fontName;
  const fontFile = sanitizeFontFileName(src.fontFile);
  const backgroundBox = src.backgroundBox === 'box' ? 'box' : 'none';
  const highlightMode =
    src.highlightMode === 'none' ||
    src.highlightMode === 'karaoke' ||
    src.highlightMode === 'longest_word'
      ? src.highlightMode
      : fallback.highlightMode;

  return {
    id: typeof src.id === 'string' && src.id.trim() ? src.id.trim().slice(0, 64) : fallback.id,
    nombre:
      typeof src.nombre === 'string' && src.nombre.trim()
        ? src.nombre.trim().slice(0, 64)
        : fallback.nombre,
    fontName,
    ...(fontFile ? { fontFile } : {}),
    fontSizePct: clampStyleNumber(src.fontSizePct, 1.2, 10, fallback.fontSizePct),
    bold: typeof src.bold === 'boolean' ? src.bold : fallback.bold,
    uppercase: typeof src.uppercase === 'boolean' ? src.uppercase : fallback.uppercase,
    primaryColor: normalizeHexColor(src.primaryColor, fallback.primaryColor),
    highlightColor: normalizeHexColor(src.highlightColor, fallback.highlightColor),
    outlineColor: normalizeHexColor(src.outlineColor, fallback.outlineColor),
    outlineWidth: clampStyleNumber(src.outlineWidth, 0, 2.5, fallback.outlineWidth),
    shadow: clampStyleNumber(src.shadow, 0, 1.5, fallback.shadow),
    backgroundBox,
    boxColor: normalizeHexColor(src.boxColor, fallback.boxColor),
    boxOpacity: clampStyleNumber(src.boxOpacity, 0, 1, fallback.boxOpacity),
    positionPct: clampStyleNumber(src.positionPct, 4, 85, fallback.positionPct),
    maxWordsPerBlock: Math.round(
      clampStyleNumber(src.maxWordsPerBlock, 1, 10, fallback.maxWordsPerBlock)
    ),
    maxCharsPerBlock: Math.round(
      clampStyleNumber(src.maxCharsPerBlock, 8, 60, fallback.maxCharsPerBlock)
    ),
    highlightMode,
    popAnimation:
      typeof src.popAnimation === 'boolean' ? src.popAnimation : fallback.popAnimation,
  };
}

/**
 * Converts a `#RRGGBB` color + opacity (0..1, where 1 = opaque) to ASS `&HAABBGGRR`.
 */
export function hexToAssColor(hex, opacity = 1) {
  const norm = normalizeHexColor(hex, '#FFFFFF');
  const r = norm.slice(1, 3);
  const g = norm.slice(3, 5);
  const b = norm.slice(5, 7);
  const clamped = Math.max(0, Math.min(1, Number.isFinite(Number(opacity)) ? Number(opacity) : 1));
  const aa = Math.round((1 - clamped) * 255)
    .toString(16)
    .toUpperCase()
    .padStart(2, '0');
  return `&H${aa}${b}${g}${r}`;
}

function sanitizeAssText(text, uppercase = false) {
  const safe = String(text || '')
    .replace(/[{}]/g, '')
    .replace(/\r?\n/g, ' ')
    .trim();
  return uppercase ? safe.toUpperCase() : safe;
}

/**
 * Highlights the longest word in a subtitle block using `highlightAss` (default yellow `&H0000E5FF`),
 * restoring `primaryAss` (default white `&H00FFFFFF`) for the rest, without altering any word text.
 */
export function highlightLongestWordAss(
  text,
  primaryAss = '&H00FFFFFF',
  highlightAss = '&H0000E5FF',
  uppercase = false
) {
  const safe = sanitizeAssText(text, uppercase);
  if (!safe) return '';

  const tokens = safe.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return '';

  let longestIdx = 0;
  let longestLen = -1;
  for (let i = 0; i < tokens.length; i += 1) {
    const cleanLen =
      tokens[i].replace(/^[¡¿"'«(\[]+|[.,?!:;"'»)\]]+$/g, '').length || tokens[i].length;
    if (cleanLen > longestLen) {
      longestLen = cleanLen;
      longestIdx = i;
    }
  }

  return tokens
    .map((tok, idx) =>
      idx === longestIdx ? `{\\c${highlightAss}&}${tok}{\\c${primaryAss}&}` : tok
    )
    .join(' ');
}

const POP_ANIMATION_TAG = '{\\fscx80\\fscy80\\t(0,120,\\fscx100\\fscy100)}';

function buildKaraokeDialogueLines(block, style, primaryAss, highlightAss) {
  const blockStart = Math.max(0, Number(block?.start) || 0);
  const blockEnd = Math.max(blockStart + 0.05, Number(block?.end) || blockStart + 0.05);
  const rawWords =
    Array.isArray(block?.words) && block.words.length > 0
      ? block.words
          .map((w) => ({
            start: Number(w?.start),
            end: Number(w?.end),
            text: sanitizeAssText(w?.text, style.uppercase),
          }))
          .filter((w) => Boolean(w.text) && Number.isFinite(w.start) && Number.isFinite(w.end))
      : [];

  let wordEntries = rawWords;
  if (wordEntries.length === 0) {
    const safe = sanitizeAssText(block?.text, style.uppercase);
    const tokens = safe.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return [];
    const step = (blockEnd - blockStart) / tokens.length;
    wordEntries = tokens.map((tok, idx) => ({
      start: blockStart + idx * step,
      end: blockStart + (idx + 1) * step,
      text: tok,
    }));
  }

  const lines = [];
  const count = wordEntries.length;
  for (let i = 0; i < count; i += 1) {
    const evStart =
      i === 0
        ? blockStart
        : Math.max(blockStart, Math.min(blockEnd - 0.02, wordEntries[i].start));
    const nextStart = i < count - 1 ? wordEntries[i + 1].start : blockEnd;
    const evEnd =
      i < count - 1
        ? Math.max(evStart + 0.02, Math.min(blockEnd, nextStart))
        : Math.max(evStart + 0.02, blockEnd);

    const rendered = wordEntries
      .map((entry, idx) =>
        idx === i ? `{\\c${highlightAss}&}${entry.text}{\\c${primaryAss}&}` : entry.text
      )
      .join(' ');

    const popPrefix = style.popAnimation && i === 0 ? POP_ANIMATION_TAG : '';
    lines.push(
      `Dialogue: 0,${formatAssTime(evStart)},${formatAssTime(evEnd)},TikTok,,0,0,0,,${popPrefix}${rendered}`
    );
  }
  return lines;
}

/**
 * Resolves a subtitle style profile against an optional `fontsDir`.
 * If `style.fontFile` is set and exists inside `fontsDir`, returns `effectiveFontsDir = fontsDir`.
 * If `style.fontFile` is missing, falls back to the default font (`DejaVu Sans`) and calls `onWarning`.
 */
export async function resolveSubtitleStyleWithFonts({
  style,
  fontsDir = null,
  onWarning = null,
}) {
  const normalized = normalizeSubtitleStyle(style);
  if (!normalized.fontFile) {
    return {
      effectiveStyle: normalized,
      effectiveFontsDir: null,
      fontFallbackUsed: false,
    };
  }

  const safeFile = path.basename(normalized.fontFile);
  if (fontsDir) {
    try {
      const stat = await fsp.stat(path.join(fontsDir, safeFile));
      if (stat.isFile() && stat.size > 0) {
        return {
          effectiveStyle: normalized,
          effectiveFontsDir: fontsDir,
          fontFallbackUsed: false,
        };
      }
    } catch {
      // Missing font file -> fall back cleanly
    }
  }

  if (typeof onWarning === 'function') {
    onWarning('subtitle_font_missing');
  }

  const fallbackStyle = {
    ...normalized,
    fontName: DEFAULT_SUBTITLE_STYLE.fontName,
  };
  delete fallbackStyle.fontFile;

  return {
    effectiveStyle: fallbackStyle,
    effectiveFontsDir: null,
    fontFallbackUsed: true,
  };
}

/**
 * Builds an ASS subtitle file from a `SubtitleStyleProfile` (defaults to "Clásico TikTok").
 * All sizes and vertical margins scale from `height` percentages so 720p and 1080p match cleanly.
 * With the default "Clásico TikTok" profile, output is byte-for-byte identical to the legacy builder.
 */
export function buildAssFileContent(blocks, width = 1080, height = 1920, style = null) {
  const s = normalizeSubtitleStyle(style);
  const fontSize = Math.max(16, Math.round((height * s.fontSizePct) / 100));
  const outline = s.outlineWidth <= 0 ? 0 : Math.max(1, Math.round((height * s.outlineWidth) / 100));
  const shadow = s.shadow <= 0 ? 0 : Math.max(1, Math.round((height * s.shadow) / 100));
  const marginV = Math.max(20, Math.round((height * s.positionPct) / 100));
  const marginH = Math.max(24, Math.round(height * 0.025));

  const primaryAss = hexToAssColor(s.primaryColor, 1);
  const highlightAss = hexToAssColor(s.highlightColor, 1);
  const borderStyle = s.backgroundBox === 'box' ? 3 : 1;
  const boxAss = hexToAssColor(s.boxColor, s.boxOpacity);
  const outlineAss = s.backgroundBox === 'box' ? boxAss : hexToAssColor(s.outlineColor, 1);
  const backAss = s.backgroundBox === 'box' ? boxAss : '&H00000000';
  const boldFlag = s.bold ? -1 : 0;

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: TikTok,${s.fontName},${fontSize},${primaryAss},${highlightAss},${outlineAss},${backAss},${boldFlag},0,0,0,100,100,0,0,${borderStyle},${outline},${shadow},2,${marginH},${marginH},${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;

  const lines = [];
  for (const b of Array.isArray(blocks) ? blocks : []) {
    if (s.highlightMode === 'karaoke') {
      lines.push(...buildKaraokeDialogueLines(b, s, primaryAss, highlightAss));
      continue;
    }

    let formattedText = '';
    if (s.highlightMode === 'none') {
      formattedText = sanitizeAssText(b?.text, s.uppercase);
    } else {
      formattedText = highlightLongestWordAss(b?.text, primaryAss, highlightAss, s.uppercase);
    }
    if (!formattedText) continue;

    const popPrefix = s.popAnimation ? POP_ANIMATION_TAG : '';
    lines.push(
      `Dialogue: 0,${formatAssTime(b.start)},${formatAssTime(b.end)},TikTok,,0,0,0,,${popPrefix}${formattedText}`
    );
  }

  return `${header}\n${lines.join('\n')}\n`;
}

/**
 * Builds final-timeline subtitle blocks strictly from real word-level timestamps on each cut.
 *
 * Rules:
 * - Iterates cuts in assembly order tracking a final-timeline cursor.
 * - Filters words with `word.start >= cut.start` and `word.end <= cut.end` and maps to
 *   `t_final = cursor + (t - cut.start)`.
 * - Groups 1..4 words per block, max 26 chars, max 1.6 s duration.
 * - Always closes a block after punctuation (`.`, `?`, `!`, `,`).
 * - Never mixes words from two cuts into the same block.
 * - Each block ends at next block's start if gap < 0.25 s; otherwise at last word end + 0.15 s.
 * - Preserves exact word text verbatim (no rewriting/invention).
 */
export function buildSubtitlesFromCutWords(cuts, style = null) {
  if (!Array.isArray(cuts) || cuts.length === 0) return [];
  const s = normalizeSubtitleStyle(style);
  const maxWordsPerBlock = s.maxWordsPerBlock;
  const maxCharsPerBlock = s.maxCharsPerBlock;

  const rawBlocks = [];
  let cursor = 0;

  for (const cut of cuts) {
    const cutStart = Math.max(0, Number(cut?.start) || 0);
    const cutEnd = Math.max(cutStart + 0.15, Number(cut?.end) || cutStart + 0.15);
    const cutDur = cutEnd - cutStart;

    const words = Array.isArray(cut?.words) ? cut.words : [];
    const inCutWords = words
      .map((w) => ({
        start: Number(w?.start),
        end: Number(w?.end),
        text: String(w?.text || '').trim(),
      }))
      .filter(
        (w) =>
          Boolean(w.text) &&
          Number.isFinite(w.start) &&
          Number.isFinite(w.end) &&
          w.end >= w.start &&
          w.start >= cutStart &&
          w.end <= cutEnd
      )
      .sort((a, b) => a.start - b.start || a.end - b.end)
      .map((w) => ({
        start: cursor + (w.start - cutStart),
        end: cursor + (w.end - cutStart),
        text: w.text,
      }));

    let current = [];

    const flushCurrent = () => {
      if (current.length === 0) return;
      rawBlocks.push({
        start: current[0].start,
        rawEnd: current[current.length - 1].end,
        text: current.map((w) => w.text).join(' '),
        words: current.map((w) => ({
          start: Number(w.start.toFixed(3)),
          end: Number(w.end.toFixed(3)),
          text: w.text,
        })),
      });
      current = [];
    };

    const maxBlockDuration = Math.max(1.6, maxWordsPerBlock * 0.4);

    for (const word of inCutWords) {
      if (current.length > 0) {
        const candidateText = `${current.map((w) => w.text).join(' ')} ${word.text}`;
        const candidateDuration = word.end - current[0].start;
        if (
          current.length >= maxWordsPerBlock ||
          candidateText.length > maxCharsPerBlock ||
          candidateDuration > maxBlockDuration + 1e-6
        ) {
          flushCurrent();
        }
      }

      current.push(word);

      if (/[.?!,]$/.test(word.text)) {
        flushCurrent();
      }
    }

    // Never leak words across cut boundaries
    flushCurrent();
    cursor += cutDur;
  }

  return rawBlocks.map((block, idx) => {
    const next = rawBlocks[idx + 1];
    const gap = next ? next.start - block.rawEnd : Infinity;
    const computedEnd =
      next && gap < 0.25 && next.start > block.start ? next.start : block.rawEnd + 0.15;

    return {
      start: Number(block.start.toFixed(3)),
      end: Number(Math.max(block.start + 0.05, computedEnd).toFixed(3)),
      text: block.text,
      words: block.words,
    };
  });
}

/**
 * Legacy helper retained for backward-compatibility with existing imports.
 */
export function sliceSubtitlesForSegment(subtitlesData, timelineOffsetSec, cutDurationSec) {
  if (!Array.isArray(subtitlesData) || subtitlesData.length === 0) return [];
  const segStart = timelineOffsetSec;
  const segEnd = timelineOffsetSec + cutDurationSec;
  const result = [];

  for (const block of subtitlesData) {
    const start = Number(block?.start);
    const end = Number(block?.end);
    const text = String(block?.text || '').trim();
    if (!text || !Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (end <= segStart || start >= segEnd) continue;

    const localStart = Math.max(0, start - segStart);
    const localEnd = Math.min(cutDurationSec, end - segStart);
    if (localEnd - localStart < 0.08) continue;

    result.push({
      start: Number(localStart.toFixed(2)),
      end: Number(localEnd.toFixed(2)),
      text,
    });
  }

  return result;
}

export function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (stdout.length > 65536) stdout = stdout.slice(-32768);
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (stderr.length > 65536) stderr = stderr.slice(-32768);
      if (options.onStderr) options.onStderr(text);
    });

    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

export async function hasZscaleFilter(ffmpegBin = 'ffmpeg') {
  try {
    const res = await runProcess(ffmpegBin, ['-hide_banner', '-filters']);
    if (res.code !== 0) return false;
    return /\bzscale\b/.test(res.stdout);
  } catch {
    return false;
  }
}

export async function probeVideoColorTransfer(ffprobeBin, inputPath) {
  try {
    const res = await runProcess(ffprobeBin, [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=color_transfer',
      '-of',
      'default=nw=1:nk=1',
      inputPath,
    ]);
    if (res.code !== 0) return '';
    return res.stdout.trim().split(/\r?\n/)[0]?.trim() || '';
  } catch {
    return '';
  }
}

export async function probeVideoDimensions(ffprobeBin, inputPath) {
  try {
    const res = await runProcess(ffprobeBin, [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height:stream_side_data=rotation:stream_tags=rotate',
      '-of',
      'json',
      inputPath,
    ]);
    if (res.code !== 0) {
      return { width: 0, height: 0, isLandscape: false };
    }
    const parsed = JSON.parse(res.stdout || '{}');
    const stream = Array.isArray(parsed?.streams) ? parsed.streams[0] : null;
    let width = Math.max(0, Number(stream?.width) || 0);
    let height = Math.max(0, Number(stream?.height) || 0);

    const sideRotation = Array.isArray(stream?.side_data_list)
      ? stream.side_data_list.find((sd) => Number.isFinite(Number(sd?.rotation)))?.rotation
      : undefined;
    const tagRotation = stream?.tags?.rotate;
    const rotation = Number(sideRotation ?? tagRotation ?? 0);

    if (Number.isFinite(rotation) && Math.abs(Math.round(rotation)) % 180 === 90) {
      [width, height] = [height, width];
    }

    return {
      width,
      height,
      isLandscape: width > 0 && height > 0 ? width > height : false,
    };
  } catch {
    return { width: 0, height: 0, isLandscape: false };
  }
}

export async function probeMediaDurations(ffprobeBin, mediaPath) {
  const res = await runProcess(ffprobeBin, [
    '-v',
    'error',
    '-show_entries',
    'stream=codec_type,duration:format=duration',
    '-of',
    'json',
    mediaPath,
  ]);
  if (res.code !== 0) {
    throw new Error(`No se pudo inspeccionar duraciones con ffprobe: ${summarizeFfmpegError(res.stderr)}`);
  }

  const parsed = JSON.parse(res.stdout || '{}');
  const formatDuration = Number(parsed?.format?.duration);
  const streams = Array.isArray(parsed?.streams) ? parsed.streams : [];
  const videoStream = streams.find((s) => s?.codec_type === 'video');
  const audioStream = streams.find((s) => s?.codec_type === 'audio');

  const videoDurationSec = Number(videoStream?.duration);
  const audioDurationSec = Number(audioStream?.duration);

  return {
    videoDurationSec: Number.isFinite(videoDurationSec)
      ? videoDurationSec
      : Number.isFinite(formatDuration)
      ? formatDuration
      : NaN,
    audioDurationSec: Number.isFinite(audioDurationSec)
      ? audioDurationSec
      : audioStream && Number.isFinite(formatDuration)
      ? formatDuration
      : NaN,
    hasAudio: Boolean(audioStream),
  };
}

/**
 * Rounds a duration to a whole number of video frames (minimum 1 frame) so that every
 * segment's video and PCM audio have identical lengths and concat accumulates no drift.
 */
export function quantizeDurationToFrames(durationSec, fps = 30) {
  const f = Number(fps) > 0 ? Number(fps) : 30;
  const frames = Math.max(1, Math.round((Number(durationSec) || 0) * f));
  return frames / f;
}

/**
 * Mandatory post-render A/V sync verification:
 * - |videoDuration - expectedDuration| < 0.10 s
 * - |audioDuration - videoDuration| < 0.05 s (when audio stream is present)
 */
export function verifyRenderedDurations({
  videoDurationSec,
  audioDurationSec,
  expectedDurationSec,
  hasAudio = true,
}) {
  const v = Number(videoDurationSec);
  const a = Number(audioDurationSec);
  const e = Number(expectedDurationSec);

  const fmt = (n) => (Number.isFinite(n) ? n.toFixed(2) : 'NaN');

  const videoDelta = Math.abs(v - e);
  const avDelta = hasAudio ? Math.abs(a - v) : 0;

  if (
    !Number.isFinite(v) ||
    !Number.isFinite(e) ||
    videoDelta >= 0.1 ||
    (hasAudio && (!Number.isFinite(a) || avDelta >= 0.05))
  ) {
    throw new Error(
      `[FFmpeg] Desincronización detectada: vídeo ${fmt(v)} s, audio ${fmt(
        hasAudio ? a : v
      )} s, esperado ${fmt(e)} s`
    );
  }

  return {
    ok: true,
    videoDurationSec: v,
    audioDurationSec: hasAudio ? a : v,
    expectedDurationSec: e,
    videoDelta,
    avDelta,
  };
}

/**
 * Parses the JSON summary printed by `loudnorm=...:print_format=json` from FFmpeg stderr.
 */
export function parseLoudnormMeasurements(stderr) {
  const text = String(stderr || '');
  const matches = text.match(/\{[\s\S]*?"input_i"[\s\S]*?\}/g);
  if (!matches || matches.length === 0) return null;
  try {
    const parsed = JSON.parse(matches[matches.length - 1]);
    const keys = ['input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset'];
    for (const k of keys) {
      const val = Number(parsed[k]);
      if (!Number.isFinite(val)) return null;
    }
    return {
      input_i: String(parsed.input_i),
      input_tp: String(parsed.input_tp),
      input_lra: String(parsed.input_lra),
      input_thresh: String(parsed.input_thresh),
      target_offset: String(parsed.target_offset),
    };
  } catch {
    return null;
  }
}

export async function detectVideoEncoder(ffmpegBin, forceCpu = false) {
  try {
    const ver = await runProcess(ffmpegBin, ['-version']);
    if (ver.code !== 0) {
      throw new Error(`ffmpeg respondió con código ${ver.code}`);
    }
  } catch (err) {
    throw new Error(
      `No se encontró FFmpeg ("${ffmpegBin}"). Instálalo en Windows con: winget install Gyan.FFmpeg (${err.message})`
    );
  }

  if (forceCpu) {
    return { codec: 'libx264', label: 'libx264 (CPU)' };
  }

  // Real 0.1s dummy encode probe so we never get false positives without an NVIDIA GPU
  try {
    const probe = await runProcess(ffmpegBin, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=black:s=128x128:d=0.1',
      '-c:v',
      'h264_nvenc',
      '-f',
      'null',
      '-',
    ]);
    if (probe.code === 0) {
      return { codec: 'h264_nvenc', label: 'h264_nvenc (GPU NVIDIA)' };
    }
  } catch {
    // Fallback to CPU
  }

  return { codec: 'libx264', label: 'libx264 (CPU)' };
}

export async function fileHasAudioStream(ffmpegBin, inputPath) {
  try {
    const res = await runProcess(ffmpegBin, ['-hide_banner', '-i', inputPath]);
    return /Stream\s+#\d+:\d+.*Audio:/i.test(res.stderr);
  } catch {
    return true;
  }
}

export function sanitizeOutputFilename(rawName, jobId) {
  const base = path.basename(String(rawName || `AutoCut_${jobId}.mp4`)).replace(
    /[<>:"/\\|?*\x00-\x1F]/g,
    '_'
  );
  return base.toLowerCase().endsWith('.mp4') ? base : `${base}.mp4`;
}

export function summarizeFfmpegError(stderr) {
  const lines = String(stderr || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return 'FFmpeg finalizó con un error desconocido.';
  return lines.slice(-4).join(' | ').slice(0, 480);
}

function buildVideoCodecArgs(encoderCodec, profile, cpuPreset = 'fast') {
  return encoderCodec === 'h264_nvenc'
    ? [
        '-c:v',
        'h264_nvenc',
        '-preset',
        'p4',
        '-rc',
        'vbr',
        '-cq',
        profile.nvencCq,
        '-b:v',
        '0',
        '-maxrate',
        profile.maxrate,
        '-bufsize',
        profile.bufsize,
        '-profile:v',
        'high',
      ]
    : [
        '-c:v',
        'libx264',
        '-preset',
        cpuPreset,
        '-crf',
        profile.crf,
        '-maxrate',
        profile.maxrate,
        '-bufsize',
        profile.bufsize,
        '-profile:v',
        'high',
        '-level',
        '4.1',
      ];
}

/**
 * Builds segment FFmpeg args with exact A/V sync (duration D = end - start in both streams):
 * - Always selects `0:v:0` and `0:a:0` (ignores iPhone secondary `apac` audio & data streams).
 * - Never runs `silenceremove`, `loudnorm`, or subtitle burning inside segment pass.
 * - Uses `afade` + `apad=whole_dur=D` and output `-t D` for sample-accurate segment length.
 * - Prepends HDR -> SDR BT.709 `zscale`/`tonemap=hable` chain when input is HLG or PQ.
 * - Always tags SDR BT.709 color metadata.
 */
export function buildSegmentFfmpegArgs({
  inputPath,
  outputPath,
  cut,
  profile,
  framing,
  audioMode, // 'source' | 'silent' | 'none'
  encoderCodec,
  cpuPreset = 'fast',
  colorTransfer = '',
  zscaleAvailable = true,
  overlays = [],
  brollSmoothPan = true,
  brollAmbientAudio = false,
}) {
  const startSec = Math.max(0, Number(cut.start) || 0);
  const endSec = Math.max(startSec + 0.15, Number(cut.end) || startSec + 0.15);
  const durationSec = quantizeDurationToFrames(Math.max(0.15, endSec - startSec), profile.fps);
  const startStr = startSec.toFixed(3);
  const durStr = durationSec.toFixed(3);
  const fadeOutStartStr = Math.max(0, durationSec - 0.03).toFixed(3);

  const w = profile.width;
  const h = profile.height;
  const fps = profile.fps;

  const hdrChain = buildHdrToSdrFilterChain(colorTransfer, zscaleAvailable);
  const hdrPrefix = hdrChain ? `${hdrChain},` : '';

  // Normalize optional active B-roll overlays sorted along [0, durationSec]
  const rawOverlays = Array.isArray(overlays) ? overlays : [];
  const activeOverlays = [];
  let prevOvEnd = 0;
  for (const ov of [...rawOverlays].sort((a, b) => (Number(a?.offsetSec) || 0) - (Number(b?.offsetSec) || 0))) {
    if (!ov || !ov.inputPath) continue;
    const ovStart = Math.max(0, Number(ov.start) || 0);
    const ovEnd = Math.max(ovStart, Number(ov.end) || 0);
    const ovDur = ovEnd - ovStart;
    const offsetSec = Math.max(0, Number(ov.offsetSec) || 0);
    if (ovDur < 0.05 || offsetSec >= durationSec - 0.02 || offsetSec < prevOvEnd - 0.001) {
      continue;
    }
    const clampedDur = Math.min(ovDur, durationSec - offsetSec);
    if (clampedDur < 0.05) continue;
    activeOverlays.push({
      inputPath: ov.inputPath,
      start: ovStart,
      dur: clampedDur,
      offsetSec,
      encuadreX: Number.isFinite(Number(ov.encuadreX))
        ? Math.max(0, Math.min(1, Number(ov.encuadreX)))
        : 0.5,
      colorTransfer: ov.colorTransfer || '',
      isLandscape: Boolean(ov.isLandscape),
      hasAudio: ov.hasAudio !== false,
    });
    prevOvEnd = offsetSec + clampedDur;
  }

  // Zero-overlay baseline path (identical to original args)
  if (activeOverlays.length === 0) {
    const filterParts = [];
    if (framing === 'blur_bg') {
      filterParts.push(`[0:v:0]setpts=PTS-STARTPTS,${hdrPrefix}split=2[bgsrc][fgsrc]`);
      filterParts.push(
        `[bgsrc]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},boxblur=24:4[bg]`
      );
      filterParts.push(`[fgsrc]scale=${w}:${h}:force_original_aspect_ratio=decrease[fg]`);
      filterParts.push(`[bg][fg]overlay=(W-w)/2:(H-h)/2,fps=${fps},format=yuv420p,setsar=1[v0]`);
    } else {
      filterParts.push(
        `[0:v:0]setpts=PTS-STARTPTS,${hdrPrefix}scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},fps=${fps},format=yuv420p,setsar=1[v0]`
      );
    }

    const finalVideoLabel = '[v0]';
    const extraInputs = [];
    let finalAudioLabel = null;

    if (audioMode === 'source') {
      filterParts.push(
        `[0:a:0]asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,afade=t=in:d=0.02,afade=t=out:st=${fadeOutStartStr}:d=0.03,apad=whole_dur=${durStr}[a0]`
      );
      finalAudioLabel = '[a0]';
    } else if (audioMode === 'silent') {
      extraInputs.push(
        '-f',
        'lavfi',
        '-t',
        durStr,
        '-i',
        'anullsrc=channel_layout=stereo:sample_rate=48000'
      );
      filterParts.push(
        `[1:a:0]atrim=duration=${durStr},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad=whole_dur=${durStr}[a0]`
      );
      finalAudioLabel = '[a0]';
    }

    const videoCodecArgs = buildVideoCodecArgs(encoderCodec, profile, cpuPreset);

    return [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-ss',
      startStr,
      '-t',
      durStr,
      '-i',
      inputPath,
      ...extraInputs,
      '-filter_complex',
      filterParts.join(';'),
      '-map',
      finalVideoLabel,
      ...(finalAudioLabel ? ['-map', finalAudioLabel] : ['-an']),
      ...videoCodecArgs,
      '-pix_fmt',
      'yuv420p',
      '-r',
      String(fps),
      ...SDR_COLOR_ARGS,
      '-video_track_timescale',
      '90000',
      ...(finalAudioLabel
        ? ['-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2']
        : []),
      '-t',
      durStr,
      '-movflags',
      '+faststart',
      outputPath,
    ];
  }

  // B-roll overlay composition path:
  // Subsegment concat visually + continuous uncut audio from anchor input [0:a:0]
  const filterParts = [];
  const extraInputs = [];

  for (const ov of activeOverlays) {
    extraInputs.push('-ss', ov.start.toFixed(3), '-t', ov.dur.toFixed(3), '-i', ov.inputPath);
  }

  const pieces = [];
  let cursor = 0;
  for (let i = 0; i < activeOverlays.length; i += 1) {
    const ov = activeOverlays[i];
    if (ov.offsetSec - cursor >= 0.02) {
      pieces.push({ type: 'anchor', start: cursor, end: ov.offsetSec });
    }
    pieces.push({ type: 'broll', overlayIdx: i, overlay: ov });
    cursor = ov.offsetSec + ov.dur;
  }
  if (durationSec - cursor >= 0.02) {
    pieces.push({ type: 'anchor', start: cursor, end: durationSec });
  }

  const anchorPieceIndices = [];
  for (let pIdx = 0; pIdx < pieces.length; pIdx += 1) {
    if (pieces[pIdx].type === 'anchor') {
      anchorPieceIndices.push(pIdx);
    }
  }

  if (anchorPieceIndices.length > 0) {
    if (framing === 'blur_bg') {
      filterParts.push(`[0:v:0]setpts=PTS-STARTPTS,${hdrPrefix}split=2[bgsrc][fgsrc]`);
      filterParts.push(
        `[bgsrc]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},boxblur=24:4[bg]`
      );
      filterParts.push(`[fgsrc]scale=${w}:${h}:force_original_aspect_ratio=decrease[fg]`);
      filterParts.push(
        `[bg][fg]overlay=(W-w)/2:(H-h)/2,fps=${fps},format=yuv420p,setsar=1[anc_base]`
      );
    } else {
      filterParts.push(
        `[0:v:0]setpts=PTS-STARTPTS,${hdrPrefix}scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},fps=${fps},format=yuv420p,setsar=1[anc_base]`
      );
    }

    if (anchorPieceIndices.length === 1) {
      const pIdx = anchorPieceIndices[0];
      const p = pieces[pIdx];
      filterParts.push(
        `[anc_base]trim=start=${p.start.toFixed(3)}:end=${p.end.toFixed(3)},setpts=PTS-STARTPTS[segv_${pIdx}]`
      );
    } else {
      const splitLabels = anchorPieceIndices.map((_, k) => `[anc_s${k}]`).join('');
      filterParts.push(`[anc_base]split=${anchorPieceIndices.length}${splitLabels}`);
      anchorPieceIndices.forEach((pIdx, k) => {
        const p = pieces[pIdx];
        filterParts.push(
          `[anc_s${k}]trim=start=${p.start.toFixed(3)}:end=${p.end.toFixed(3)},setpts=PTS-STARTPTS[segv_${pIdx}]`
        );
      });
    }
  }

  for (let pIdx = 0; pIdx < pieces.length; pIdx += 1) {
    const p = pieces[pIdx];
    if (p.type !== 'broll') continue;
    const ov = p.overlay;
    const inIdx = 1 + p.overlayIdx;
    const ovDurStr = ov.dur.toFixed(3);
    const ovHdr = buildHdrToSdrFilterChain(ov.colorTransfer, zscaleAvailable);
    const ovHdrPrefix = ovHdr ? `${ovHdr},` : '';

    if (ov.isLandscape) {
      let cropXExpr;
      if (brollSmoothPan) {
        const panStart = Math.max(0, Math.min(0.92, ov.encuadreX - 0.04));
        cropXExpr = `'max(0,min(iw-ow,(iw-ow)*(${panStart.toFixed(4)}+0.0800*min(1,t/${ovDurStr}))))'`;
      } else {
        cropXExpr = `'max(0,min(iw-ow,(iw-ow)*${ov.encuadreX.toFixed(4)}))'`;
      }
      filterParts.push(
        `[${inIdx}:v:0]setpts=PTS-STARTPTS,${ovHdrPrefix}scale=-2:${h},crop=${w}:${h}:${cropXExpr}:0,fps=${fps},format=yuv420p,setsar=1[segv_${pIdx}]`
      );
    } else {
      filterParts.push(
        `[${inIdx}:v:0]setpts=PTS-STARTPTS,${ovHdrPrefix}scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},fps=${fps},format=yuv420p,setsar=1[segv_${pIdx}]`
      );
    }
  }

  const finalVideoLabel = '[v0]';
  if (pieces.length === 1) {
    filterParts.push(`[segv_0]null[v0]`);
  } else {
    const segLabels = pieces.map((_, idx) => `[segv_${idx}]`).join('');
    filterParts.push(`${segLabels}concat=n=${pieces.length}:v=1:a=0[v0]`);
  }

  // Continuous anchor audio (uncut) + optional -20 dB ambient mix from B-roll inputs
  let finalAudioLabel = null;
  const ambientOverlays =
    brollAmbientAudio && audioMode !== 'none'
      ? activeOverlays
          .map((ov, ovIdx) => ({ ov, ovIdx }))
          .filter(({ ov }) => ov.hasAudio)
      : [];

  if (audioMode === 'source' || audioMode === 'silent') {
    let baseAudioFilter = '';
    if (audioMode === 'source') {
      baseAudioFilter = `[0:a:0]asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,afade=t=in:d=0.02,afade=t=out:st=${fadeOutStartStr}:d=0.03,apad=whole_dur=${durStr}`;
    } else {
      const silentIdx = 1 + activeOverlays.length;
      extraInputs.push(
        '-f',
        'lavfi',
        '-t',
        durStr,
        '-i',
        'anullsrc=channel_layout=stereo:sample_rate=48000'
      );
      baseAudioFilter = `[${silentIdx}:a:0]atrim=duration=${durStr},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad=whole_dur=${durStr}`;
    }

    if (ambientOverlays.length === 0) {
      filterParts.push(`${baseAudioFilter}[a0]`);
    } else {
      filterParts.push(`${baseAudioFilter}[a_anchor]`);
      const ambLabels = [];
      ambientOverlays.forEach(({ ov, ovIdx }, k) => {
        const inIdx = 1 + ovIdx;
        const delayMs = Math.max(0, Math.round(ov.offsetSec * 1000));
        const label = `[a_amb_${k}]`;
        ambLabels.push(label);
        filterParts.push(
          `[${inIdx}:a:0]atrim=duration=${ov.dur.toFixed(3)},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=-20dB,adelay=${delayMs}|${delayMs}${label}`
        );
      });
      filterParts.push(
        `[a_anchor]${ambLabels.join('')}amix=inputs=${1 + ambLabels.length}:duration=first:normalize=0,apad=whole_dur=${durStr}[a0]`
      );
    }
    finalAudioLabel = '[a0]';
  }

  const videoCodecArgs = buildVideoCodecArgs(encoderCodec, profile, cpuPreset);

  return [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-ss',
    startStr,
    '-t',
    durStr,
    '-i',
    inputPath,
    ...extraInputs,
    '-filter_complex',
    filterParts.join(';'),
    '-map',
    finalVideoLabel,
    ...(finalAudioLabel ? ['-map', finalAudioLabel] : ['-an']),
    ...videoCodecArgs,
    '-pix_fmt',
    'yuv420p',
    '-r',
    String(fps),
    ...SDR_COLOR_ARGS,
    '-video_track_timescale',
    '90000',
    ...(finalAudioLabel
      ? ['-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2']
      : []),
    '-t',
    durStr,
    '-movflags',
    '+faststart',
    outputPath,
  ];
}

/**
 * Builds the final assembly pass FFmpeg args over `joined.mp4`:
 * - Video: burns final-timeline `.ass` subtitles and re-encodes when `subtitleAssPath` is provided;
 *   otherwise `-c:v copy`.
 * - Audio: applies 2-pass linear `loudnorm` when `loudnormMeasurements` are provided (or single-pass
 *   when `normalizeAudio` is true without measurements); otherwise `-c:a copy` (or `-an`).
 * - Always `-movflags +faststart`.
 */
export function buildFinalAssemblyFfmpegArgs({
  joinedPath,
  outputPath,
  profile,
  encoderCodec,
  cpuPreset = 'fast',
  hasAudio = true,
  normalizeAudio = true,
  loudnormMeasurements = null,
  subtitleAssPath = null,
  fontsDir = null,
}) {
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', joinedPath, '-map', '0:v:0'];

  if (hasAudio) {
    args.push('-map', '0:a:0');
  } else {
    args.push('-an');
  }

  if (subtitleAssPath) {
    const escapedAss = escapePathForFfmpegFilter(subtitleAssPath);
    const vfArg =
      fontsDir && String(fontsDir).trim()
        ? `ass='${escapedAss}':fontsdir='${escapePathForFfmpegFilter(String(fontsDir).trim())}'`
        : `ass='${escapedAss}'`;
    args.push(
      '-vf',
      vfArg,
      ...buildVideoCodecArgs(encoderCodec, profile, cpuPreset),
      '-pix_fmt',
      'yuv420p',
      '-r',
      String(profile.fps),
      ...SDR_COLOR_ARGS
    );
  } else {
    args.push('-c:v', 'copy');
  }

  if (hasAudio) {
    if (normalizeAudio && loudnormMeasurements) {
      const m = loudnormMeasurements;
      args.push(
        '-af',
        `loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`,
        '-c:a',
        'aac',
        '-b:a',
        profile.audioBitrate,
        '-ar',
        '48000',
        '-ac',
        '2'
      );
    } else if (normalizeAudio) {
      args.push(
        '-af',
        'loudnorm=I=-14:TP=-1.5:LRA=11',
        '-c:a',
        'aac',
        '-b:a',
        profile.audioBitrate,
        '-ar',
        '48000',
        '-ac',
        '2'
      );
    } else {
      // Intermediate segments carry PCM audio, so the final pass always encodes AAC once.
      args.push('-c:a', 'aac', '-b:a', profile.audioBitrate, '-ar', '48000', '-ac', '2');
    }
  }

  args.push('-movflags', '+faststart', outputPath);
  return args;
}

/**
 * Resolves final-timeline subtitle blocks:
 * Priority 1: real word-level timestamps on `manifest.cuts` (`buildSubtitlesFromCutWords`).
 * Priority 2: legacy `manifest.options.subtitlesData`.
 */
export function resolveFinalSubtitles(manifest, styleOverride = null) {
  const options = manifest?.options || {};
  if (!options.subtitlesEnabled) return [];

  const effectiveStyle = normalizeSubtitleStyle(styleOverride || options.subtitleStyle);
  const cuts = Array.isArray(manifest?.cuts) ? manifest.cuts : [];
  const hasWordLevelSubs = cuts.some((c) => Array.isArray(c?.words) && c.words.length > 0);
  if (hasWordLevelSubs) {
    return buildSubtitlesFromCutWords(cuts, effectiveStyle);
  }

  if (Array.isArray(options.subtitlesData) && options.subtitlesData.length > 0) {
    return options.subtitlesData
      .map((b) => ({
        start: Number(b?.start),
        end: Number(b?.end),
        text: String(b?.text || '').trim(),
      }))
      .filter((b) => Boolean(b.text) && Number.isFinite(b.start) && Number.isFinite(b.end) && b.end > b.start);
  }

  return [];
}

/**
 * Renders a complete single-clip or Multi-Clip `RenderJobManifest` from already-resolved
 * local `sourcePaths` into `workDir`, returning the absolute path to the finished MP4.
 */
export async function renderJob({
  manifest,
  sourcePaths,
  workDir,
  ffmpegBin = 'ffmpeg',
  ffprobeBin,
  encoder,
  zscaleAvailable,
  fontsDir = null,
  onProgress,
  onWarning,
}) {
  if (!Array.isArray(sourcePaths) || sourcePaths.length === 0) {
    throw new Error('No se recibieron rutas locales de vídeo fuente (sourcePaths).');
  }
  if (!Array.isArray(manifest?.cuts) || manifest.cuts.length === 0) {
    throw new Error('El manifiesto no contiene cortes activos (cuts).');
  }

  const resolvedFfprobe = ffprobeBin || resolveFfprobeBin(ffmpegBin);
  const canUseZscale =
    typeof zscaleAvailable === 'boolean' ? zscaleAvailable : await hasZscaleFilter(ffmpegBin);

  const jobId = manifest.jobId || 'job';
  const options = manifest.options || {};
  const qualityKey = options.quality === '720p' ? '720p' : '1080p';
  const profile = QUALITY_PROFILES[qualityKey];
  const framing = options.framing === 'blur_bg' ? 'blur_bg' : 'center_crop';
  const normalizeAudio = Boolean(options.normalizeAudio);

  const encoderCodec = encoder?.codec || 'libx264';
  const cpuPreset =
    typeof encoder?.cpuPreset === 'function'
      ? encoder.cpuPreset(qualityKey)
      : encoder?.cpuPreset || 'fast';

  // Inspect audio streams and HDR color_transfer per source clip
  const audioFlags = [];
  const colorTransfers = [];
  for (const filePath of sourcePaths) {
    audioFlags.push(await fileHasAudioStream(ffmpegBin, filePath));
    colorTransfers.push(await probeVideoColorTransfer(resolvedFfprobe, filePath));
  }
  const anyClipHasAudio = audioFlags.some(Boolean);

  const voiceoverBrollEnabled = options.voiceoverBrollEnabled !== false;
  const brollSmoothPan = options.brollSmoothPanEnabled !== false;
  const brollAmbientAudio = Boolean(options.brollAmbientAudioEnabled);
  const rawManifestOverlays =
    voiceoverBrollEnabled && Array.isArray(manifest.overlays) ? manifest.overlays : [];

  const dimensionInfos = [];
  if (rawManifestOverlays.length > 0) {
    for (const filePath of sourcePaths) {
      dimensionInfos.push(await probeVideoDimensions(resolvedFfprobe, filePath));
    }
  }

  const overlaysByCutIndex = new Map();
  for (const ov of rawManifestOverlays) {
    const cutIdx = Math.trunc(Number(ov?.cutIndex));
    if (!Number.isInteger(cutIdx) || cutIdx < 0 || cutIdx >= manifest.cuts.length) continue;
    const ovClipIdx = Math.max(0, Math.min(sourcePaths.length - 1, Number(ov?.clipIndex) || 0));
    const list = overlaysByCutIndex.get(cutIdx) || [];
    list.push({
      inputPath: sourcePaths[ovClipIdx],
      start: Number(ov.start) || 0,
      end: Number(ov.end) || 0,
      offsetSec: Number(ov.offsetSec) || 0,
      encuadreX: Number.isFinite(Number(ov.encuadreX)) ? Number(ov.encuadreX) : 0.5,
      colorTransfer: colorTransfers[ovClipIdx] || '',
      isLandscape: Boolean(dimensionInfos[ovClipIdx]?.isLandscape),
      hasAudio: Boolean(audioFlags[ovClipIdx]),
    });
    overlaysByCutIndex.set(cutIdx, list);
  }

  const segmentPaths = [];
  let expectedTotalDurationSec = 0;
  const totalCuts = manifest.cuts.length;

  for (let i = 0; i < totalCuts; i += 1) {
    const cut = manifest.cuts[i];
    const clipIdx = Math.max(0, Math.min(sourcePaths.length - 1, Number(cut.clipIndex) || 0));
    const inputPath = sourcePaths[clipIdx];
    const hasAudio = audioFlags[clipIdx];
    const audioMode = anyClipHasAudio ? (hasAudio ? 'source' : 'silent') : 'none';
    const startSec = Math.max(0, Number(cut.start) || 0);
    const endSec = Math.max(startSec + 0.15, Number(cut.end) || startSec + 0.15);
    const cutDur = quantizeDurationToFrames(Math.max(0.15, endSec - startSec), profile.fps);
    expectedTotalDurationSec += cutDur;

    // .mov intermediates: PCM audio keeps every segment sample-exact (no AAC priming/padding drift).
    const segPath = path.join(workDir, `seg_${String(i).padStart(3, '0')}.mov`);
    const args = buildSegmentFfmpegArgs({
      inputPath,
      outputPath: segPath,
      cut,
      profile,
      framing,
      audioMode,
      encoderCodec,
      cpuPreset,
      colorTransfer: colorTransfers[clipIdx],
      zscaleAvailable: canUseZscale,
      overlays: overlaysByCutIndex.get(i) || [],
      brollSmoothPan,
      brollAmbientAudio,
    });

    const pctStart = 10 + Math.round((i / totalCuts) * 62);
    if (onProgress) {
      await onProgress({
        percent: pctStart,
        stage: 'segment',
        cutIndex: i,
        totalCuts,
        clipIndex: clipIdx,
      });
    }

    const res = await runProcess(ffmpegBin, args);
    if (res.code !== 0) {
      throw new Error(`Fallo en corte ${i + 1}: ${summarizeFfmpegError(res.stderr)}`);
    }

    segmentPaths.push(segPath);

    const pctAfter = 10 + Math.round(((i + 1) / totalCuts) * 65);
    if (onProgress) {
      await onProgress({
        percent: Math.min(75, pctAfter),
        stage: 'segment_done',
        cutIndex: i,
        totalCuts,
        clipIndex: clipIdx,
      });
    }
  }

  // 1. Join segments via concat demuxer (-c copy) into joined.mp4
  const joinedPath = path.join(workDir, 'joined.mov');
  if (segmentPaths.length === 1) {
    await fsp.copyFile(segmentPaths[0], joinedPath);
  } else {
    if (onProgress) {
      await onProgress({
        percent: 78,
        stage: 'concat',
        cutIndex: totalCuts,
        totalCuts,
      });
    }

    const concatListPath = path.join(workDir, 'concat.txt');
    const concatContent =
      segmentPaths
        .map((p) => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`)
        .join('\n') + '\n';
    await fsp.writeFile(concatListPath, concatContent, 'utf8');

    const concatRes = await runProcess(ffmpegBin, [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      concatListPath,
      '-c',
      'copy',
      joinedPath,
    ]);

    if (concatRes.code !== 0) {
      throw new Error(
        `Fallo al unir segmentos (concat): ${summarizeFfmpegError(concatRes.stderr)}`
      );
    }
  }

  // 2. Final pass over joined.mp4: 2-pass loudnorm + optional final-timeline ASS subtitles
  const { effectiveStyle, effectiveFontsDir } = await resolveSubtitleStyleWithFonts({
    style: options.subtitleStyle,
    fontsDir,
    onWarning,
  });
  const finalSubtitles = resolveFinalSubtitles(manifest, effectiveStyle);
  let finalAssPath = null;
  if (finalSubtitles.length > 0) {
    finalAssPath = path.join(workDir, 'final_subtitles.ass');
    await fsp.writeFile(
      finalAssPath,
      buildAssFileContent(finalSubtitles, profile.width, profile.height, effectiveStyle),
      'utf8'
    );
  }

  let loudnormMeasurements = null;
  if (anyClipHasAudio && normalizeAudio) {
    if (onProgress) {
      await onProgress({
        percent: 82,
        stage: 'loudnorm_measure',
        cutIndex: totalCuts,
        totalCuts,
      });
    }
    const measureRes = await runProcess(ffmpegBin, [
      '-hide_banner',
      '-i',
      joinedPath,
      '-vn',
      '-af',
      'loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json',
      '-f',
      'null',
      '-',
    ]);
    if (measureRes.code === 0) {
      loudnormMeasurements = parseLoudnormMeasurements(measureRes.stderr);
    }
  }

  const finalFileName = sanitizeOutputFilename(manifest.outputFileName, jobId);
  const finalOutputPath = path.join(workDir, finalFileName);

  if (onProgress) {
    await onProgress({
      percent: 86,
      stage: 'final_assembly',
      cutIndex: totalCuts,
      totalCuts,
    });
  }

  const finalArgs = buildFinalAssemblyFfmpegArgs({
    joinedPath,
    outputPath: finalOutputPath,
    profile,
    encoderCodec,
    cpuPreset,
    hasAudio: anyClipHasAudio,
    normalizeAudio,
    loudnormMeasurements,
    subtitleAssPath: finalAssPath,
    fontsDir: effectiveFontsDir,
  });

  const finalRes = await runProcess(ffmpegBin, finalArgs);
  if (finalRes.code !== 0) {
    throw new Error(`Fallo en montaje final: ${summarizeFfmpegError(finalRes.stderr)}`);
  }

  // 3. Mandatory post-render duration & A/V sync verification with ffprobe
  const probed = await probeMediaDurations(resolvedFfprobe, finalOutputPath);
  verifyRenderedDurations({
    videoDurationSec: probed.videoDurationSec,
    audioDurationSec: probed.audioDurationSec,
    expectedDurationSec: expectedTotalDurationSec,
    hasAudio: anyClipHasAudio && probed.hasAudio,
  });

  return finalOutputPath;
}
