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

/**
 * Returns the tuned CPU libx264 preset for cloud runners (no GPU):
 * - 1080p -> veryfast
 * - 720p  -> ultrafast
 */
export function getCloudCpuPreset(quality) {
  return quality === '720p' ? 'ultrafast' : 'veryfast';
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

export function buildAssFileContent(blocks, width, height) {
  const fontSize = Math.round(width * 0.056);
  const marginV = Math.round(height * 0.18);
  const fontName = process.platform === 'win32' ? 'Arial' : 'DejaVu Sans';
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: TikTok,${fontName},${fontSize},&H00FFFFFF,&H0000F0FF,&H0005060A,&H80000000,-1,0,0,0,100,100,0,0,1,4,2,2,48,48,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;

  const lines = blocks.map((b) => {
    const safeText = String(b.text || '')
      .replace(/[{}]/g, '')
      .replace(/\r?\n/g, '\\N')
      .trim();
    return `Dialogue: 0,${formatAssTime(b.start)},${formatAssTime(b.end)},TikTok,,0,0,0,,${safeText}`;
  });

  return `${header}\n${lines.join('\n')}\n`;
}

/**
 * Slices final-timeline subtitle blocks to the local [0, cutDuration] window of a single segment
 * so subtitles burn cleanly in the single encode pass and concat remains zero-reencode `-c copy`.
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
      if (stdout.length > 32768) stdout = stdout.slice(-16384);
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

export function buildSegmentFfmpegArgs({
  inputPath,
  outputPath,
  cut,
  profile,
  framing,
  removeSilences,
  normalizeAudio,
  audioMode, // 'source' | 'silent' | 'none'
  subtitleAssPath,
  encoderCodec,
  cpuPreset = 'fast',
}) {
  const startSec = Math.max(0, Number(cut.start) || 0);
  const endSec = Math.max(startSec + 0.15, Number(cut.end) || startSec + 0.15);
  const durationSec = Math.max(0.15, endSec - startSec);
  const startStr = startSec.toFixed(3);
  const durStr = durationSec.toFixed(3);

  const w = profile.width;
  const h = profile.height;
  const fps = profile.fps;

  const filterParts = [];
  if (framing === 'blur_bg') {
    filterParts.push(`[0:v]setpts=PTS-STARTPTS,split=2[bgsrc][fgsrc]`);
    filterParts.push(
      `[bgsrc]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},boxblur=24:4[bg]`
    );
    filterParts.push(`[fgsrc]scale=${w}:${h}:force_original_aspect_ratio=decrease[fg]`);
    filterParts.push(`[bg][fg]overlay=(W-w)/2:(H-h)/2,fps=${fps},format=yuv420p,setsar=1[v0]`);
  } else {
    filterParts.push(
      `[0:v]setpts=PTS-STARTPTS,scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},fps=${fps},format=yuv420p,setsar=1[v0]`
    );
  }

  let finalVideoLabel = '[v0]';
  if (subtitleAssPath) {
    const escapedAss = escapePathForFfmpegFilter(subtitleAssPath);
    filterParts.push(`[v0]ass='${escapedAss}'[v0_sub]`);
    finalVideoLabel = '[v0_sub]';
  }

  const extraInputs = [];
  let finalAudioLabel = null;

  if (audioMode === 'source') {
    const silenceClause = removeSilences
      ? ',silenceremove=start_periods=1:start_duration=0.15:start_threshold=-42dB'
      : '';
    filterParts.push(
      `[0:a]asetpts=PTS-STARTPTS${silenceClause},aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a0]`
    );
    finalAudioLabel = '[a0]';
    if (normalizeAudio) {
      filterParts.push('[a0]loudnorm=I=-14:TP=-1.5:LRA=11[a0_norm]');
      finalAudioLabel = '[a0_norm]';
    }
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
      `[1:a]atrim=duration=${durStr},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a0_sil]`
    );
    finalAudioLabel = '[a0_sil]';
  }

  const videoCodecArgs =
    encoderCodec === 'h264_nvenc'
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
    '-video_track_timescale',
    '90000',
    ...(finalAudioLabel
      ? ['-c:a', 'aac', '-b:a', profile.audioBitrate, '-ar', '48000', '-ac', '2', '-shortest']
      : []),
    '-movflags',
    '+faststart',
    outputPath,
  ];
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
  encoder,
  onProgress,
}) {
  if (!Array.isArray(sourcePaths) || sourcePaths.length === 0) {
    throw new Error('No se recibieron rutas locales de vídeo fuente (sourcePaths).');
  }
  if (!Array.isArray(manifest?.cuts) || manifest.cuts.length === 0) {
    throw new Error('El manifiesto no contiene cortes activos (cuts).');
  }

  const jobId = manifest.jobId || 'job';
  const options = manifest.options || {};
  const qualityKey = options.quality === '720p' ? '720p' : '1080p';
  const profile = QUALITY_PROFILES[qualityKey];
  const framing = options.framing === 'blur_bg' ? 'blur_bg' : 'center_crop';
  const removeSilences = Boolean(options.removeSilences);
  const normalizeAudio = Boolean(options.normalizeAudio);
  const subtitlesEnabled = Boolean(
    options.subtitlesEnabled &&
      Array.isArray(options.subtitlesData) &&
      options.subtitlesData.length > 0
  );

  const encoderCodec = encoder?.codec || 'libx264';
  const cpuPreset =
    typeof encoder?.cpuPreset === 'function'
      ? encoder.cpuPreset(qualityKey)
      : encoder?.cpuPreset || 'fast';

  // Inspect audio streams across resolved source clips so Multi-Clip concat stays stream-compatible
  const audioFlags = [];
  for (const filePath of sourcePaths) {
    audioFlags.push(await fileHasAudioStream(ffmpegBin, filePath));
  }
  const anyClipHasAudio = audioFlags.some(Boolean);

  const segmentPaths = [];
  let timelineCursorSec = 0;
  const totalCuts = manifest.cuts.length;

  for (let i = 0; i < totalCuts; i += 1) {
    const cut = manifest.cuts[i];
    const clipIdx = Math.max(0, Math.min(sourcePaths.length - 1, Number(cut.clipIndex) || 0));
    const inputPath = sourcePaths[clipIdx];
    const hasAudio = audioFlags[clipIdx];
    const audioMode = anyClipHasAudio ? (hasAudio ? 'source' : 'silent') : 'none';
    const cutDur = Math.max(0.15, (Number(cut.end) || 0) - (Number(cut.start) || 0));

    let subtitleAssPath = null;
    if (subtitlesEnabled) {
      const segSubs = sliceSubtitlesForSegment(options.subtitlesData, timelineCursorSec, cutDur);
      if (segSubs.length > 0) {
        subtitleAssPath = path.join(workDir, `sub_${String(i).padStart(3, '0')}.ass`);
        await fsp.writeFile(
          subtitleAssPath,
          buildAssFileContent(segSubs, profile.width, profile.height),
          'utf8'
        );
      }
    }

    const segPath = path.join(workDir, `seg_${String(i).padStart(3, '0')}.mp4`);
    const args = buildSegmentFfmpegArgs({
      inputPath,
      outputPath: segPath,
      cut,
      profile,
      framing,
      removeSilences,
      normalizeAudio,
      audioMode,
      subtitleAssPath,
      encoderCodec,
      cpuPreset,
    });

    const pctStart = 10 + Math.round((i / totalCuts) * 72);
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
    timelineCursorSec += cutDur;

    const pctAfter = 10 + Math.round(((i + 1) / totalCuts) * 75);
    if (onProgress) {
      await onProgress({
        percent: Math.min(85, pctAfter),
        stage: 'segment_done',
        cutIndex: i,
        totalCuts,
        clipIndex: clipIdx,
      });
    }
  }

  const finalFileName = sanitizeOutputFilename(manifest.outputFileName, jobId);
  const finalOutputPath = path.join(workDir, finalFileName);

  if (segmentPaths.length === 1) {
    await fsp.copyFile(segmentPaths[0], finalOutputPath);
  } else {
    if (onProgress) {
      await onProgress({
        percent: 87,
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
      '-movflags',
      '+faststart',
      finalOutputPath,
    ]);

    if (concatRes.code !== 0) {
      throw new Error(
        `Fallo al unir segmentos (concat): ${summarizeFfmpegError(concatRes.stderr)}`
      );
    }
  }

  return finalOutputPath;
}
