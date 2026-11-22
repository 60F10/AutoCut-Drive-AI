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

/**
 * Highlights the longest word in a subtitle block in yellow (`&H0000E5FF&`),
 * returning white (`&H00FFFFFF&`) for the rest, without altering any word text.
 */
export function highlightLongestWordAss(text) {
  const safe = String(text || '')
    .replace(/[{}]/g, '')
    .replace(/\r?\n/g, ' ')
    .trim();
  if (!safe) return '';

  const tokens = safe.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return '';

  let longestIdx = 0;
  let longestLen = -1;
  for (let i = 0; i < tokens.length; i += 1) {
    const cleanLen = tokens[i].replace(/^[¡¿"'«(\[]+|[.,?!:;"'»)\]]+$/g, '').length || tokens[i].length;
    if (cleanLen > longestLen) {
      longestLen = cleanLen;
      longestIdx = i;
    }
  }

  return tokens
    .map((tok, idx) =>
      idx === longestIdx ? `{\\c&H0000E5FF&}${tok}{\\c&H00FFFFFF&}` : tok
    )
    .join(' ');
}

/**
 * Builds TikTok/Reels-styled ASS subtitle file scaled proportionally from 1080×1920:
 * - Font: DejaVu Sans Bold, size 78 @ 1080p (proportional @ 720p)
 * - White primary text, black 6 px outline, shadow 0, Alignment=2, MarginV=620 @ 1080p
 * - Longest word in each block highlighted in yellow (&H0000E5FF&)
 */
export function buildAssFileContent(blocks, width = 1080, height = 1920) {
  const scale = width / 1080;
  const fontSize = Math.max(24, Math.round(78 * scale));
  const outline = Math.max(2, Math.round(6 * scale));
  const marginV = Math.max(120, Math.round(620 * scale));
  const marginH = Math.max(24, Math.round(48 * scale));
  const fontName = 'DejaVu Sans';

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: TikTok,${fontName},${fontSize},&H00FFFFFF,&H0000E5FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,${outline},0,2,${marginH},${marginH},${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;

  const lines = blocks
    .map((b) => {
      const highlighted = highlightLongestWordAss(b.text);
      if (!highlighted) return null;
      return `Dialogue: 0,${formatAssTime(b.start)},${formatAssTime(b.end)},TikTok,,0,0,0,,${highlighted}`;
    })
    .filter(Boolean);

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
export function buildSubtitlesFromCutWords(cuts) {
  if (!Array.isArray(cuts) || cuts.length === 0) return [];

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
      });
      current = [];
    };

    for (const word of inCutWords) {
      if (current.length > 0) {
        const candidateText = `${current.map((w) => w.text).join(' ')} ${word.text}`;
        const candidateDuration = word.end - current[0].start;
        if (
          current.length >= 4 ||
          candidateText.length > 26 ||
          candidateDuration > 1.6
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
}) {
  const startSec = Math.max(0, Number(cut.start) || 0);
  const endSec = Math.max(startSec + 0.15, Number(cut.end) || startSec + 0.15);
  const durationSec = Math.max(0.15, endSec - startSec);
  const startStr = startSec.toFixed(3);
  const durStr = durationSec.toFixed(3);
  const fadeOutStartStr = Math.max(0, durationSec - 0.03).toFixed(3);

  const w = profile.width;
  const h = profile.height;
  const fps = profile.fps;

  const hdrChain = buildHdrToSdrFilterChain(colorTransfer, zscaleAvailable);
  const hdrPrefix = hdrChain ? `${hdrChain},` : '';

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
      ? ['-c:a', 'aac', '-b:a', profile.audioBitrate, '-ar', '48000', '-ac', '2']
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
}) {
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', joinedPath, '-map', '0:v:0'];

  if (hasAudio) {
    args.push('-map', '0:a:0');
  } else {
    args.push('-an');
  }

  if (subtitleAssPath) {
    const escapedAss = escapePathForFfmpegFilter(subtitleAssPath);
    args.push(
      '-vf',
      `ass='${escapedAss}'`,
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
      args.push('-c:a', 'copy');
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
export function resolveFinalSubtitles(manifest) {
  const options = manifest?.options || {};
  if (!options.subtitlesEnabled) return [];

  const cuts = Array.isArray(manifest?.cuts) ? manifest.cuts : [];
  const hasWordLevelSubs = cuts.some((c) => Array.isArray(c?.words) && c.words.length > 0);
  if (hasWordLevelSubs) {
    return buildSubtitlesFromCutWords(cuts);
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
  onProgress,
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
    const cutDur = Math.max(0.15, endSec - startSec);
    expectedTotalDurationSec += cutDur;

    const segPath = path.join(workDir, `seg_${String(i).padStart(3, '0')}.mp4`);
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
  const joinedPath = path.join(workDir, 'joined.mp4');
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
  const finalSubtitles = resolveFinalSubtitles(manifest);
  let finalAssPath = null;
  if (finalSubtitles.length > 0) {
    finalAssPath = path.join(workDir, 'final_subtitles.ass');
    await fsp.writeFile(
      finalAssPath,
      buildAssFileContent(finalSubtitles, profile.width, profile.height),
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
