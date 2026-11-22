#!/usr/bin/env node
/**
 * AutoCut Drive AI — Local Native PC Render Worker (0 € Hybrid Mode)
 *
 * Watches `<AUTOCUT_DRIVE_DIR>/_AutoCut_Jobs/job_*.json` every 3 seconds,
 * ignores cloud-targeted jobs (`target === "cloud"`), renders pending PC jobs
 * using shared `worker/render-core.mjs` (auto-detecting NVIDIA `h264_nvenc`
 * with `libx264 -preset fast` fallback), and writes the finished MP4 to
 * `<AUTOCUT_DRIVE_DIR>/_AutoCut_Output/`.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildAssFileContent,
  detectVideoEncoder,
  escapePathForFfmpegFilter,
  renderJob,
  sanitizeOutputFilename,
  sliceSubtitlesForSegment,
} from './render-core.mjs';

export { buildAssFileContent, escapePathForFfmpegFilter, sliceSubtitlesForSegment };

const JOBS_DIR_NAME = '_AutoCut_Jobs';
const OUTPUT_DIR_NAME = '_AutoCut_Output';
const DEFAULT_POLL_INTERVAL_MS = 3000;

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

/**
 * PC worker claims pending jobs whose target is NOT `"cloud"` (backward-compatible with
 * manifests that omit `target` or set `target: "pc"`).
 */
export function shouldPcWorkerClaimJob(manifest) {
  if (!manifest || typeof manifest !== 'object') return false;
  if (manifest.status !== 'pending') return false;
  if (manifest.target === 'cloud') return false;
  return true;
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

Nota: este worker ignora automáticamente los trabajos con target="cloud"
(que se procesan en GitHub Actions).
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

async function resolveSourceFilePath(driveDir, fileName) {
  const direct = path.join(driveDir, fileName);
  if (fs.existsSync(direct)) return direct;

  const targetLower = fileName.toLowerCase();
  const skipDirs = new Set([JOBS_DIR_NAME.toLowerCase(), OUTPUT_DIR_NAME.toLowerCase()]);

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
  await fsp.writeFile(jobFilePath, payload, 'utf8');
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

    const tempFinalPath = await renderJob({
      manifest,
      sourcePaths: resolvedPaths,
      workDir: tempWorkDir,
      ffmpegBin,
      encoder: { ...encoder, cpuPreset: 'fast' },
      onProgress: async (evt) => {
        workingManifest.progress = Math.max(5, Math.min(92, Math.round(evt.percent)));
        await writeJobManifest(jobFilePath, workingManifest);
        if (evt.stage === 'segment') {
          log('INFO', `Renderizando corte ${evt.cutIndex + 1}/${evt.totalCuts}`, {
            jobId,
            clip: (evt.clipIndex ?? 0) + 1,
          });
        }
      },
    });

    const finalFileName = sanitizeOutputFilename(manifest.outputFileName, jobId);
    workingManifest.progress = 96;
    await writeJobManifest(jobFilePath, workingManifest);

    await fsp.mkdir(outputDir, { recursive: true });
    const destinationPath = path.join(outputDir, finalFileName);
    await fsp.copyFile(tempFinalPath, destinationPath);

    const outStat = await fsp.stat(destinationPath);
    workingManifest.status = 'completed';
    workingManifest.progress = 100;
    workingManifest.outputFileName = finalFileName;
    workingManifest.finishedAt = new Date().toISOString();
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
      if (shouldPcWorkerClaimJob(manifest)) {
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
