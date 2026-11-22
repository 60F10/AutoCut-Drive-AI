#!/usr/bin/env node
/**
 * AutoCut Drive AI — Local Native PC Render Worker (0 € Hybrid Mode)
 *
 * Watches `<AUTOCUT_DRIVE_DIR>/_AutoCut_Jobs/job_*.json` every 3 seconds,
 * renders pending single-clip or Multi-Clip manifests with native FFmpeg
 * (auto-detecting NVIDIA `h264_nvenc` with automatic `libx264 -preset fast` fallback),
 * writes the finished MP4 to `<AUTOCUT_DRIVE_DIR>/_AutoCut_Output/`, and updates
 * the job JSON status/progress so the mobile PWA displays real-time progress.
 *
 * Zero external npm dependencies — uses only Node.js built-in modules.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const JOBS_DIR_NAME = '_AutoCut_Jobs';
const OUTPUT_DIR_NAME = '_AutoCut_Output';
const DEFAULT_POLL_INTERVAL_MS = 3000;

const QUALITY_PROFILES = {
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

function log(level, message, details) {
  const ts = new Date().toISOString().slice(11, 23);
  const suffix = details ? ` ${JSON.stringify(details)}` : '';
  const line = `[${ts}] [${level}] ${message}${suffix}`;
  if (level === 'ERROR') {
    console.error(line);
  } else {
    console.log(line);
  }
}

export function printHelp() {
  console.log(`
AutoCut Drive AI — Worker nativo de renderizado en PC (FFmpeg, coste 0 €)

Uso:
  node worker/pc-worker.mjs --dir "G:\\Mi unidad\\AutoCut"
  npm run worker -- --dir "G:\\Mi unidad\\AutoCut"

Opciones:
  --dir, -d <ruta>       Ruta local de la carpeta sincronizada de Google Drive
                         (también puede definirse con la variable AUTOCUT_DRIVE_DIR)
  --interval <ms>        Intervalo de vigilancia en milisegundos (por defecto: 3000)
  --ffmpeg <ruta>        Ruta personalizada al binario de ffmpeg (por defecto: ffmpeg)
  --cpu                  Forzar codificación por CPU (libx264) aunque exista GPU NVIDIA
  --once                 Procesar los trabajos pendientes una sola vez y salir
  --help, -h             Mostrar esta ayuda

Ejemplo en Windows PowerShell:
  $env:AUTOCUT_DRIVE_DIR = "G:\\Mi unidad\\Videos_AutoCut"
  npm run worker
`);
}

export function parseCliArgs(argv, env = process.env) {
  const opts = {
    driveDir: env.AUTOCUT_DRIVE_DIR || '',
    pollIntervalMs: Number(env.AUTOCUT_POLL_INTERVAL_MS) || DEFAULT_POLL_INTERVAL_MS,
    ffmpegBin: env.AUTOCUT_FFMPEG_BIN || 'ffmpeg',
    forceCpu: env.AUTOCUT_FORCE_CPU === '1' || env.AUTOCUT_FORCE_CPU === 'true',
    once: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--once') {
      opts.once = true;
    } else if (arg === '--cpu') {
      opts.forceCpu = true;
    } else if ((arg === '--dir' || arg === '-d') && argv[i + 1]) {
      opts.driveDir = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--dir=')) {
      opts.driveDir = arg.slice('--dir='.length);
    } else if (arg === '--interval' && argv[i + 1]) {
      opts.pollIntervalMs = Math.max(1000, Number(argv[i + 1]) || DEFAULT_POLL_INTERVAL_MS);
      i += 1;
    } else if (arg.startsWith('--interval=')) {
      opts.pollIntervalMs = Math.max(
        1000,
        Number(arg.slice('--interval='.length)) || DEFAULT_POLL_INTERVAL_MS
      );
    } else if (arg === '--ffmpeg' && argv[i + 1]) {
      opts.ffmpegBin = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--ffmpeg=')) {
      opts.ffmpegBin = arg.slice('--ffmpeg='.length);
    }
  }

  return opts;
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

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
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

async function detectVideoEncoder(ffmpegBin, forceCpu) {
  // 1. Verify ffmpeg binary is available
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
    return { codec: 'libx264', label: 'libx264 (CPU forzado)' };
  }

  // 2. Real 0.1s dummy encode probe so we never get false positives without an NVIDIA GPU
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

async function fileHasAudioStream(ffmpegBin, inputPath) {
  try {
    const res = await runProcess(ffmpegBin, ['-hide_banner', '-i', inputPath]);
    return /Stream\s+#\d+:\d+.*Audio:/i.test(res.stderr);
  } catch {
    return true;
  }
}

async function resolveSourceFilePath(driveDir, fileName) {
  const direct = path.join(driveDir, fileName);
  if (fs.existsSync(direct)) return direct;

  const targetLower = fileName.toLowerCase();
  const skipDirs = new Set([JOBS_DIR_NAME.toLowerCase(), OUTPUT_DIR_NAME.toLowerCase()]);

  // Case-insensitive match in root & immediate subdirectories (max depth 2)
  const queue = [{ dir: driveDir, depth: 0 }];
  while (queue.length > 0) {
    const { dir, depth } = queue.shift();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === targetLower) {
        return fullPath;
      }
      if (entry.isDirectory() && depth < 2 && !skipDirs.has(entry.name.toLowerCase())) {
        queue.push({ dir: fullPath, depth: depth + 1 });
      }
    }
  }

  return null;
}

async function writeJobManifest(jobFilePath, manifest) {
  const payload = JSON.stringify(
    {
      ...manifest,
      updatedAt: new Date().toISOString(),
    },
    null,
    2
  );
  // Direct write is safest on Google Drive for Desktop virtual FUSE/WinFsp drives
  await fsp.writeFile(jobFilePath, payload, 'utf8');
}

function buildSegmentFfmpegArgs({
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
    filterParts.push(`[bgsrc]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},boxblur=24:4[bg]`);
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
          'fast',
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

function sanitizeOutputFilename(rawName, jobId) {
  const base = path.basename(String(rawName || `AutoCut_${jobId}.mp4`)).replace(
    /[<>:"/\\|?*\x00-\x1F]/g,
    '_'
  );
  return base.toLowerCase().endsWith('.mp4') ? base : `${base}.mp4`;
}

function summarizeFfmpegError(stderr) {
  const lines = String(stderr || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return 'FFmpeg finalizó con un error desconocido.';
  return lines.slice(-4).join(' | ').slice(0, 480);
}

async function processJob({ jobFilePath, manifest, driveDir, outputDir, ffmpegBin, encoder }) {
  const jobId = manifest.jobId || path.basename(jobFilePath, '.json');
  const tempWorkDir = await fsp.mkdtemp(path.join(os.tmpdir(), `autocut_job_${jobId}_`));
  const workingManifest = {
    ...manifest,
    status: 'processing',
    progress: 5,
    errorMessage: undefined,
    encoderUsed: encoder.codec,
  };

  log('INFO', `Iniciando trabajo ${jobId}`, {
    output: manifest.outputFileName,
    clips: manifest.sourceFiles?.length ?? 0,
    cortes: manifest.cuts?.length ?? 0,
    calidad: manifest.options?.quality ?? '1080p',
    encoder: encoder.label,
  });

  try {
    await writeJobManifest(jobFilePath, workingManifest);

    if (!Array.isArray(manifest.sourceFiles) || manifest.sourceFiles.length === 0) {
      throw new Error('El manifiesto no contiene archivos fuente (sourceFiles).');
    }
    if (!Array.isArray(manifest.cuts) || manifest.cuts.length === 0) {
      throw new Error('El manifiesto no contiene cortes activos (cuts).');
    }

    // 1. Resolve all source video files locally inside Google Drive synced folder
    const resolvedPaths = [];
    for (const src of manifest.sourceFiles) {
      const found = await resolveSourceFilePath(driveDir, src.name);
      if (!found) {
        throw new Error(
          `No se encontró el vídeo fuente "${src.name}" en "${driveDir}". Asegúrate de que Google Drive para ordenador haya sincronizado el archivo.`
        );
      }
      resolvedPaths.push(found);
    }

    // 2. Inspect audio stream availability per clip so Multi-Clip concat stays stream-compatible
    const audioFlags = [];
    for (const filePath of resolvedPaths) {
      audioFlags.push(await fileHasAudioStream(ffmpegBin, filePath));
    }
    const anyClipHasAudio = audioFlags.some(Boolean);

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

    // 3. Encode each active cut sequentially into uniform intermediate MP4 segments
    const segmentPaths = [];
    let timelineCursorSec = 0;
    const totalCuts = manifest.cuts.length;

    for (let i = 0; i < totalCuts; i += 1) {
      const cut = manifest.cuts[i];
      const clipIdx = Math.max(0, Math.min(resolvedPaths.length - 1, Number(cut.clipIndex) || 0));
      const inputPath = resolvedPaths[clipIdx];
      const hasAudio = audioFlags[clipIdx];
      const audioMode = anyClipHasAudio ? (hasAudio ? 'source' : 'silent') : 'none';
      const cutDur = Math.max(0.15, (Number(cut.end) || 0) - (Number(cut.start) || 0));

      let subtitleAssPath = null;
      if (subtitlesEnabled) {
        const segSubs = sliceSubtitlesForSegment(options.subtitlesData, timelineCursorSec, cutDur);
        if (segSubs.length > 0) {
          subtitleAssPath = path.join(tempWorkDir, `sub_${String(i).padStart(3, '0')}.ass`);
          await fsp.writeFile(
            subtitleAssPath,
            buildAssFileContent(segSubs, profile.width, profile.height),
            'utf8'
          );
        }
      }

      const segPath = path.join(tempWorkDir, `seg_${String(i).padStart(3, '0')}.mp4`);
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
        encoderCodec: encoder.codec,
      });

      const pctStart = 10 + Math.round((i / totalCuts) * 76);
      workingManifest.progress = pctStart;
      await writeJobManifest(jobFilePath, workingManifest);

      log('INFO', `Renderizando corte ${i + 1}/${totalCuts} (Clip ${clipIdx + 1})`, {
        jobId,
        rango: `${Number(cut.start).toFixed(2)}s-${Number(cut.end).toFixed(2)}s`,
        subtitulos: Boolean(subtitleAssPath),
      });

      const res = await runProcess(ffmpegBin, args);
      if (res.code !== 0) {
        throw new Error(`Fallo en corte ${i + 1}: ${summarizeFfmpegError(res.stderr)}`);
      }

      segmentPaths.push(segPath);
      timelineCursorSec += cutDur;

      const pctAfter = 10 + Math.round(((i + 1) / totalCuts) * 78);
      workingManifest.progress = Math.min(88, pctAfter);
      await writeJobManifest(jobFilePath, workingManifest);
    }

    // 4. Concatenate segments with zero-reencode `-c copy` (or move single segment)
    const finalFileName = sanitizeOutputFilename(manifest.outputFileName, jobId);
    const tempFinalPath = path.join(tempWorkDir, finalFileName);

    if (segmentPaths.length === 1) {
      await fsp.copyFile(segmentPaths[0], tempFinalPath);
    } else {
      workingManifest.progress = 92;
      await writeJobManifest(jobFilePath, workingManifest);

      const concatListPath = path.join(tempWorkDir, 'concat.txt');
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
        tempFinalPath,
      ]);

      if (concatRes.code !== 0) {
        throw new Error(`Fallo al unir segmentos (concat): ${summarizeFfmpegError(concatRes.stderr)}`);
      }
    }

    // 5. Copy finished MP4 into `_AutoCut_Output` and mark job JSON completed
    workingManifest.progress = 96;
    await writeJobManifest(jobFilePath, workingManifest);

    await fsp.mkdir(outputDir, { recursive: true });
    const destinationPath = path.join(outputDir, finalFileName);
    await fsp.copyFile(tempFinalPath, destinationPath);

    const outStat = await fsp.stat(destinationPath);
    workingManifest.status = 'completed';
    workingManifest.progress = 100;
    workingManifest.outputFileName = finalFileName;
    delete workingManifest.errorMessage;
    await writeJobManifest(jobFilePath, workingManifest);

    log('INFO', `Trabajo ${jobId} completado correctamente`, {
      archivo: destinationPath,
      pesoMB: Number((outStat.size / (1024 * 1024)).toFixed(2)),
      encoder: encoder.codec,
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log('ERROR', `Trabajo ${jobId} falló`, { error: errorMsg });
    try {
      await writeJobManifest(jobFilePath, {
        ...workingManifest,
        status: 'error',
        errorMessage: errorMsg,
      });
    } catch (writeErr) {
      log('ERROR', `No se pudo guardar el estado de error en ${jobFilePath}`, {
        error: writeErr instanceof Error ? writeErr.message : String(writeErr),
      });
    }
  } finally {
    await fsp.rm(tempWorkDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function scanAndProcessPending({ jobsDir, outputDir, driveDir, ffmpegBin, encoder }) {
  let entries;
  try {
    entries = await fsp.readdir(jobsDir, { withFileTypes: true });
  } catch {
    return 0;
  }

  const pendingJobs = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^job_.*\.json$/i.test(entry.name)) continue;
    const jobFilePath = path.join(jobsDir, entry.name);
    try {
      const raw = await fsp.readFile(jobFilePath, 'utf8');
      if (!raw.trim()) continue;
      const manifest = JSON.parse(raw);
      if (manifest && manifest.status === 'pending') {
        pendingJobs.push({ jobFilePath, manifest });
      }
    } catch {
      // Ignore half-synced JSON files until Google Drive finishes writing them
    }
  }

  pendingJobs.sort((a, b) => {
    const aMs = Date.parse(a.manifest.createdAt || '') || 0;
    const bMs = Date.parse(b.manifest.createdAt || '') || 0;
    return aMs - bMs;
  });

  for (const job of pendingJobs) {
    await processJob({
      ...job,
      driveDir,
      outputDir,
      ffmpegBin,
      encoder,
    });
  }

  return pendingJobs.length;
}

async function main() {
  const cli = parseCliArgs(process.argv.slice(2));
  if (cli.help) {
    printHelp();
    process.exit(0);
  }

  if (!cli.driveDir || !cli.driveDir.trim()) {
    console.error(
      'Error: Debes indicar la carpeta local sincronizada de Google Drive con --dir "<ruta>" o la variable AUTOCUT_DRIVE_DIR.\n'
    );
    printHelp();
    process.exit(1);
  }

  const driveDir = path.resolve(cli.driveDir.trim());
  if (!fs.existsSync(driveDir)) {
    console.error(`Error: La carpeta indicada no existe: "${driveDir}"`);
    process.exit(1);
  }

  const jobsDir = path.join(driveDir, JOBS_DIR_NAME);
  const outputDir = path.join(driveDir, OUTPUT_DIR_NAME);
  await fsp.mkdir(jobsDir, { recursive: true });
  await fsp.mkdir(outputDir, { recursive: true });

  const encoder = await detectVideoEncoder(cli.ffmpegBin, cli.forceCpu);

  log('INFO', 'AutoCut Drive AI — PC Worker iniciado', {
    driveDir,
    jobsDir,
    outputDir,
    encoder: encoder.label,
    pollMs: cli.pollIntervalMs,
  });

  if (cli.once) {
    const count = await scanAndProcessPending({
      jobsDir,
      outputDir,
      driveDir,
      ffmpegBin: cli.ffmpegBin,
      encoder,
    });
    log('INFO', `Modo --once finalizado (${count} trabajo(s) procesados).`);
    return;
  }

  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await scanAndProcessPending({
        jobsDir,
        outputDir,
        driveDir,
        ffmpegBin: cli.ffmpegBin,
        encoder,
      });
    } finally {
      busy = false;
    }
  };

  await tick();
  const intervalId = setInterval(() => {
    void tick();
  }, cli.pollIntervalMs);

  const shutdown = () => {
    log('INFO', 'Deteniendo PC Worker...');
    clearInterval(intervalId);
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const isMainModule =
  process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (isMainModule) {
  main().catch((err) => {
    log('ERROR', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
