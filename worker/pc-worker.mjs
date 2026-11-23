#!/usr/bin/env node
/**
 * AutoCut Drive AI — Local Native PC Analysis & Render Worker (Primary Engine · 0 €)
 *
 * Watches `<AUTOCUT_DRIVE_DIR>/_AutoCut_Jobs/` every 3 seconds:
 * 1. `analyze_<id>.json` (`kind: "analyze"`, `target: "pc"`):
 *    Runs shared `worker/analyze-core.mjs` (Whisper with GPU CUDA + CPU fallback,
 *    local `_AutoCut_Jobs/_cache/` transcript reuse, Gemini multimodal Phases A/B/C)
 *    and writes `plan` + `status: "analyzed"`.
 * 2. `job_<id>.json` (render, `target: "pc"` or omitted):
 *    Renders via `worker/render-core.mjs` (`h264_nvenc` GPU NVIDIA / `libx264 -preset fast` CPU)
 *    and writes finished MP4 to `<AUTOCUT_DRIVE_DIR>/_AutoCut_Output/`.
 *
 * Heartbeat:
 * - Writes `<AUTOCUT_DRIVE_DIR>/_AutoCut_Jobs/_worker_status.json` every 60 s (and on start / busy changes).
 *
 * Privacy & Rotating Logs:
 * - Writes strictly sanitized telemetry logs to `worker/logs/pc-worker.log` (5 files × 5 MB).
 * - NEVER logs tokens, API keys, transcripts, Drive IDs, paths, or user filenames.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildAssFileContent,
  detectVideoEncoder,
  escapePathForFfmpegFilter,
  hasZscaleFilter,
  renderJob,
  sanitizeOutputFilename,
  sliceSubtitlesForSegment,
} from './render-core.mjs';
import {
  buildTranscriptCacheFilename,
  claimJobAtomically,
  normalizeWhisperDevice,
  orchestrateAnalyzeJob,
  parseWhisperDeviceLine,
} from './analyze-core.mjs';
import {
  CLEANUP_INTERVAL_MS,
  COMMANDS_DIR_NAME,
  cleanupStaleTempDirs,
  createStorageReporter,
  createTempWorkDir,
  ensureWorkDir,
  getWorkDirConfig,
  releaseTempWorkDir,
  resolveHfHome,
  scanCleanupCommands,
} from './cleanup.mjs';

export { buildAssFileContent, escapePathForFfmpegFilter, sliceSubtitlesForSegment };

const WORKER_VERSION = '2.0.0';
const JOBS_DIR_NAME = '_AutoCut_Jobs';
const OUTPUT_DIR_NAME = '_AutoCut_Output';
const STYLES_DIR_NAME = '_AutoCut_Styles';
const FONTS_DIR_NAME = 'fonts';
const CACHE_DIR_NAME = '_cache';
const SOURCES_DIR_NAME = '_sources';
const WORKER_STATUS_FILENAME = '_worker_status.json';
const DEFAULT_POLL_INTERVAL_MS = 3000;
const HEARTBEAT_INTERVAL_MS = 60_000;
const DEFAULT_LOG_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const DEFAULT_LOG_MAX_FILES = 5;
const COMMANDS_POLL_INTERVAL_MS = 5000;

// Carpeta de trabajo activa (se fija en main() a partir de AUTOCUT_WORK_DIR).
const runtimeConfig = { ...getWorkDirConfig({}), hfHome: '' };

/**
 * Ejecuta `transcribe.py --probe` (sin cargar el modelo) y devuelve { device, computeType } o null.
 */
export function probeWhisperDevice({ pythonBin, scriptPath, env = process.env, timeoutMs = 30_000 }) {
  return new Promise((resolve) => {
    execFile(
      pythonBin,
      [scriptPath, '--probe'],
      { env, timeout: timeoutMs, windowsHide: true },
      (error, _stdout, stderr) => {
        if (error) return resolve(null);
        resolve(parseWhisperDeviceLine(stderr));
      }
    );
  });
}

/**
 * Entorno para transcribe.py: hereda el del worker y fija HF_HOME si .env.local lo define.
 */
export function buildWhisperEnv(env = process.env) {
  const out = { ...env };
  const hfHome = String(env.HF_HOME || '').trim();
  if (hfHome) out.HF_HOME = hfHome;
  return out;
}

const SAFE_PC_LOG_KEYS = new Set([
  'jobId',
  'kind',
  'clips',
  'cuts',
  'clip',
  'cutIndex',
  'totalCuts',
  'mb',
  'sec',
  'http',
  'stage',
  'progress',
  'encoder',
  'quality',
  'jobsFound',
  'cacheHit',
  'whisperModel',
  'whisperDevice',
  'fallbackCpu',
  'coherent',
  'claimedBy',
  'busy',
  'pollMs',
  'zscaleAvailable',
  'count',
  'version',
]);

const FORBIDDEN_VALUE_PATTERN =
  /(ya29\.[0-9A-Za-z._-]+|AIza[0-9A-Za-z_-]{16,}|gh[pousr]_[0-9A-Za-z]{12,}|github_pat_[0-9A-Za-z_]{12,}|Bearer\s+|api[_-]?key|access[_-]?token|refresh[_-]?token|\.(?:mp4|mov|webm|m4v|mkv|avi|wav|mp3|json|ass|srt|log|env)\b|[\\/])/i;

/**
 * Formats a privacy-safe log line strictly whitelisting structural/numeric telemetry.
 * Guarantees NO tokens, API keys, paths, or user filenames can ever appear in logs.
 */
export function formatSafePcLog(level, stage, metrics = {}) {
  const ts = new Date().toISOString().slice(11, 23);
  const safeLevel = level === 'ERROR' || level === 'WARN' ? level : 'INFO';
  const safeStage = String(stage || 'event')
    .replace(FORBIDDEN_VALUE_PATTERN, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);

  const safe = {};
  for (const [k, v] of Object.entries(metrics || {})) {
    if (!SAFE_PC_LOG_KEYS.has(k) || v === undefined || v === null) continue;
    if (typeof v === 'number' && Number.isFinite(v)) {
      safe[k] = v;
    } else if (typeof v === 'boolean') {
      safe[k] = v;
    } else if (typeof v === 'string') {
      const trimmed = v.trim();
      if (trimmed.length > 0 && trimmed.length <= 48 && !FORBIDDEN_VALUE_PATTERN.test(trimmed)) {
        safe[k] = trimmed;
      }
    }
  }
  const suffix = Object.keys(safe).length > 0 ? ` ${JSON.stringify(safe)}` : '';
  return `[${ts}] [${safeLevel}] [pc-worker] ${safeStage}${suffix}`;
}

/**
 * Lightweight rotating file logger: keeps up to `maxFiles` (default 5) files of `maxBytes` (default 5 MB).
 */
export class RotatingFileLogger {
  constructor({
    logFilePath,
    maxBytes = DEFAULT_LOG_MAX_BYTES,
    maxFiles = DEFAULT_LOG_MAX_FILES,
    mirrorConsole = true,
  }) {
    this.logFilePath = logFilePath;
    this.maxBytes = Math.max(1024, Number(maxBytes) || DEFAULT_LOG_MAX_BYTES);
    this.maxFiles = Math.max(1, Math.round(Number(maxFiles) || DEFAULT_LOG_MAX_FILES));
    this.mirrorConsole = mirrorConsole;
    this.dirReady = false;
  }

  rotateIfNeeded(incomingBytes) {
    try {
      if (!fs.existsSync(this.logFilePath)) return;
      const stat = fs.statSync(this.logFilePath);
      if (stat.size + incomingBytes <= this.maxBytes) return;

      // Keep total of maxFiles: base file + (maxFiles - 1) numbered backups (.1 .. .(maxFiles-1))
      const oldestIdx = this.maxFiles - 1;
      if (oldestIdx >= 1) {
        const oldestPath = `${this.logFilePath}.${oldestIdx}`;
        if (fs.existsSync(oldestPath)) {
          fs.unlinkSync(oldestPath);
        }
        for (let i = oldestIdx - 1; i >= 1; i -= 1) {
          const src = `${this.logFilePath}.${i}`;
          const dst = `${this.logFilePath}.${i + 1}`;
          if (fs.existsSync(src)) {
            fs.renameSync(src, dst);
          }
        }
        fs.renameSync(this.logFilePath, `${this.logFilePath}.1`);
      } else {
        fs.truncateSync(this.logFilePath, 0);
      }
    } catch {
      // Never crash worker on log rotation error
    }
  }

  write(level, stage, metrics = {}) {
    const line = formatSafePcLog(level, stage, metrics);
    if (this.mirrorConsole) {
      if (level === 'ERROR') {
        console.error(line);
      } else {
        console.log(line);
      }
    }
    if (!this.logFilePath) return line;

    try {
      if (!this.dirReady) {
        fs.mkdirSync(path.dirname(this.logFilePath), { recursive: true });
        this.dirReady = true;
      }
      const payload = `${line}\n`;
      this.rotateIfNeeded(Buffer.byteLength(payload, 'utf8'));
      fs.appendFileSync(this.logFilePath, payload, 'utf8');
    } catch {
      // Ignore filesystem log write errors
    }
    return line;
  }
}

const workerDir = path.dirname(fileURLToPath(import.meta.url));
const defaultLogPath = path.join(workerDir, 'logs', 'pc-worker.log');
let activeLogger = new RotatingFileLogger({ logFilePath: defaultLogPath });

function logSafe(level, stage, metrics) {
  return activeLogger.write(level, stage, metrics);
}

/**
 * Loads KEY=VALUE pairs from `worker/.env.local` without overwriting non-empty existing env vars.
 */
export function loadLocalEnvFile(envFilePath, targetEnv = process.env) {
  if (!envFilePath || !fs.existsSync(envFilePath)) return {};
  const loaded = {};
  let raw = '';
  try {
    raw = fs.readFileSync(envFilePath, 'utf8');
  } catch {
    return loaded;
  }

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = line.slice(0, eqIdx).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let val = line.slice(eqIdx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!targetEnv[key]) {
      targetEnv[key] = val;
      loaded[key] = true;
    }
  }
  return loaded;
}

/**
 * PC worker claims:
 * - `kind: "analyze"` ONLY when `status === "pending"` AND `target === "pc"` (ignores `target: "cloud"` and omitted target).
 * - Render jobs (`kind !== "analyze"`) when `status === "pending"` AND `target !== "cloud"` (backward-compatible with omitted target).
 */
export function shouldPcWorkerClaimJob(manifest) {
  if (!manifest || typeof manifest !== 'object') return false;
  if (manifest.status !== 'pending') return false;
  if (manifest.kind === 'analyze') {
    return manifest.target === 'pc';
  }
  return manifest.target !== 'cloud';
}

export function isAnalyzeJobManifest(manifest) {
  return Boolean(manifest && typeof manifest === 'object' && manifest.kind === 'analyze');
}

export function printHelp() {
  console.log(`
AutoCut Drive AI — PC Worker (análisis Whisper GPU + Gemini y render FFmpeg NVENC · 0 €)

Uso:
  node worker/pc-worker.mjs --dir "G:\\Mi unidad\\AutoCut_Videos"
  npm run worker -- --dir "G:\\Mi unidad\\AutoCut_Videos"

Opciones:
  --dir, -d <ruta>       Ruta local sincronizada de Google Drive
                         (o AUTOCUT_DRIVE_DIR en worker/.env.local)
  --interval <ms>        Intervalo de vigilancia en milisegundos (por defecto: 3000)
  --ffmpeg <ruta>        Ruta al binario de ffmpeg (por defecto: ffmpeg)
  --python <ruta>        Ruta a Python con faster-whisper (por defecto: python/python3)
  --cpu                  Forzar codificación por CPU (libx264) aunque exista GPU NVIDIA
  --once                 Procesar los trabajos pendientes una sola vez y salir
  --help, -h             Mostrar esta ayuda

Variables en worker/.env.local:
  GEMINI_API_KEY, AUTOCUT_DRIVE_DIR, WHISPER_MODEL (defecto: medium),
  WHISPER_DEVICE (defecto: auto), AUTOCUT_WORK_DIR (carpeta de temporales),
  HF_HOME (caché de modelos de Hugging Face)
`);
}

export function parseCliArgs(argv, env = process.env) {
  const defaultPython = process.platform === 'win32' ? 'python' : 'python3';
  const opts = {
    driveDir: env.AUTOCUT_DRIVE_DIR || '',
    pollIntervalMs: Number(env.AUTOCUT_POLL_INTERVAL_MS) || DEFAULT_POLL_INTERVAL_MS,
    ffmpegBin: env.AUTOCUT_FFMPEG_BIN || 'ffmpeg',
    pythonBin: env.AUTOCUT_PYTHON_BIN || defaultPython,
    whisperModel: env.WHISPER_MODEL === 'small' ? 'small' : 'medium',
    whisperDevice: normalizeWhisperDevice(env.WHISPER_DEVICE, 'auto'),
    forceCpu: env.AUTOCUT_FORCE_CPU === '1' || env.AUTOCUT_FORCE_CPU === 'true',
    workDir: String(env.AUTOCUT_WORK_DIR || '').trim(),
    hfHome: String(env.HF_HOME || '').trim(),
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
    } else if (arg === '--python' && argv[i + 1]) {
      opts.pythonBin = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--python=')) {
      opts.pythonBin = arg.slice('--python='.length);
    }
  }

  return opts;
}

async function resolveSourceFilePath(driveDir, fileName) {
  const direct = path.join(driveDir, fileName);
  if (fs.existsSync(direct)) return direct;

  const targetLower = fileName.toLowerCase();

  // Check `_AutoCut_Jobs/_sources/` for temporary clips uploaded from phone
  const sourcesDir = path.join(driveDir, JOBS_DIR_NAME, SOURCES_DIR_NAME);
  if (fs.existsSync(sourcesDir)) {
    try {
      const sourceEntries = await fsp.readdir(sourcesDir, { withFileTypes: true });
      const exactOrSuffix = sourceEntries.find(
        (entry) =>
          entry.isFile() &&
          (entry.name.toLowerCase() === targetLower ||
            entry.name.toLowerCase().endsWith(`_${targetLower}`))
      );
      if (exactOrSuffix) {
        return path.join(sourcesDir, exactOrSuffix.name);
      }
    } catch {
      // ignore
    }
  }

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

async function readJobManifestFile(jobFilePath) {
  const raw = await fsp.readFile(jobFilePath, 'utf8');
  if (!raw.trim()) return null;
  return JSON.parse(raw);
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
  await writeFileAtomicWithRetry(jobFilePath, payload);
}

const RETRYABLE_FS_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'EAGAIN', 'UNKNOWN']);

/**
 * Writes `payload` to a sibling temp file and renames it over the target, retrying on
 * transient locks (Google Drive for desktop may hold the file while it syncs it).
 * A failed attempt never leaves the target truncated.
 */
export async function writeFileAtomicWithRetry(filePath, payload, { attempts = 5, baseDelayMs = 400 } = {}) {
  // Temp name must not start with job_/analyze_ so no scanner mistakes it for a real job.
  const tmpPath = path.join(path.dirname(filePath), `~${path.basename(filePath)}.${process.pid}.tmp`);
  let lastErr = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await fsp.writeFile(tmpPath, payload, 'utf8');
      await fsp.rename(tmpPath, filePath);
      return;
    } catch (err) {
      lastErr = err;
      await fsp.rm(tmpPath, { force: true }).catch(() => {});
      if (!RETRYABLE_FS_CODES.has(err?.code) || attempt === attempts - 1) break;
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * (attempt + 1)));
    }
  }
  throw lastErr;
}

export async function writeWorkerHeartbeat({
  jobsDir,
  encoder,
  whisperDevice,
  whisperModel,
  busy,
  storage,
}) {
  const statusPath = path.join(jobsDir, WORKER_STATUS_FILENAME);
  const payload = {
    lastSeen: new Date().toISOString(),
    version: WORKER_VERSION,
    encoder: typeof encoder === 'string' ? encoder : encoder?.codec || 'libx264',
    whisperDevice: whisperDevice || 'auto',
    whisperModel: whisperModel || 'medium',
    busy: Boolean(busy),
  };
  if (storage && typeof storage === 'object') {
    payload.storage = {
      workDirMB: storage.workDirMB,
      hfCacheMB: storage.hfCacheMB,
      freeGB: storage.freeGB,
    };
  }
  try {
    await writeFileAtomicWithRetry(statusPath, JSON.stringify(payload, null, 2), { attempts: 2 });
  } catch {
    logSafe('WARN', 'heartbeat_write_failed', { busy: Boolean(busy) });
  }
  return payload;
}

async function readLocalCachedTranscript(cacheDir, driveFileId, modifiedTime) {
  const cacheName = buildTranscriptCacheFilename(driveFileId, modifiedTime);
  const cachePath = path.join(cacheDir, cacheName);
  try {
    const raw = await fsp.readFile(cachePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.segments)) {
      return parsed;
    }
  } catch {
    // cache miss
  }
  return null;
}

async function writeLocalCachedTranscript(cacheDir, driveFileId, modifiedTime, transcriptObj) {
  const cacheName = buildTranscriptCacheFilename(driveFileId, modifiedTime);
  const cachePath = path.join(cacheDir, cacheName);
  try {
    await fsp.mkdir(cacheDir, { recursive: true });
    await fsp.writeFile(cachePath, JSON.stringify(transcriptObj), 'utf8');
  } catch {
    logSafe('WARN', 'transcript_cache_write_failed');
  }
}

async function processAnalyzeJob({
  jobFilePath,
  manifest,
  driveDir,
  jobsDir,
  ffmpegBin,
  pythonBin,
  defaultWhisperModel,
  whisperDeviceState,
  onHeartbeatRefresh,
}) {
  const jobId = String(manifest.jobId || 'unknown').slice(0, 48);

  const claimResult = await claimJobAtomically({
    workerId: 'pc',
    canClaim: shouldPcWorkerClaimJob,
    readManifest: () => readJobManifestFile(jobFilePath),
    writeManifest: (nextManifest) => writeJobManifest(jobFilePath, nextManifest),
    extraPatch: {
      kind: 'analyze',
      target: 'pc',
      stage: 'descarga',
      progress: 5,
    },
  });

  if (!claimResult.claimed || !claimResult.manifest) {
    logSafe('INFO', 'analyze_claim_skipped', {
      jobId,
      kind: 'analyze',
      claimedBy: claimResult.manifest?.claimedBy || 'other',
    });
    return;
  }

  const claimedManifest = claimResult.manifest;
  const tempWorkDir = await createTempWorkDir({
    workDir: runtimeConfig.workDir,
    prefix: `autocut_pc_analyze_${jobId}_`,
  });
  const cacheDir = path.join(jobsDir, CACHE_DIR_NAME);
  const transcribeScriptPath = path.join(workerDir, 'transcribe.py');
  const geminiApiKey = (process.env.GEMINI_API_KEY || '').trim();
  const whisperModel =
    claimedManifest.options?.whisperModel === 'medium'
      ? 'medium'
      : claimedManifest.options?.whisperModel === 'small'
      ? 'small'
      : defaultWhisperModel || 'medium';

  try {
    await orchestrateAnalyzeJob({
      manifest: claimedManifest,
      target: 'pc',
      workDir: tempWorkDir,
      apiKey: geminiApiKey,
      missingApiKeyMessage:
        '[Análisis IA] Falta GEMINI_API_KEY en worker/.env.local del PC.',
      ffmpegBin,
      pythonBin,
      transcribeScriptPath,
      whisperModel,
      whisperDevice: whisperDeviceState.requested ?? whisperDeviceState.current,
      whisperEnv: buildWhisperEnv(),
      onWhisperDevice: async (device) => {
        if (whisperDeviceState.current !== device) {
          whisperDeviceState.current = device;
          if (onHeartbeatRefresh) await onHeartbeatRefresh();
        }
      },
      progressThrottleMs: 3000,
      prepareSourcePaths: async ({ manifest: current, writeProgress }) => {
        const resolvedPaths = [];
        const totalClips = current.sourceFiles.length;
        for (let i = 0; i < totalClips; i += 1) {
          const src = current.sourceFiles[i];
          const found = await resolveSourceFilePath(driveDir, src.name);
          if (!found) {
            throw new Error(
              `[Drive] No se encontró el clip ${i + 1} en la carpeta sincronizada de Google Drive. Verifica que el archivo esté disponible sin conexión.`
            );
          }
          resolvedPaths.push(found);
          const pct = 5 + Math.round(((i + 1) / totalClips) * 15);
          await writeProgress('descarga', pct, i === totalClips - 1);
        }
        return resolvedPaths;
      },
      getCachedTranscript: async (driveFileId, modifiedTime) => {
        const hit = await readLocalCachedTranscript(cacheDir, driveFileId, modifiedTime);
        logSafe('INFO', 'transcript_cache_lookup', { jobId, cacheHit: Boolean(hit) });
        return hit;
      },
      saveCachedTranscript: async (driveFileId, modifiedTime, transcriptObj) => {
        await writeLocalCachedTranscript(cacheDir, driveFileId, modifiedTime, transcriptObj);
      },
      patchManifest: (nextManifest) => writeJobManifest(jobFilePath, nextManifest),
      onLog: (level, stage, metrics) => logSafe(level, stage, metrics),
      onWhisperFallbackCpu: async () => {
        whisperDeviceState.current = 'cpu';
        whisperDeviceState.requested = 'cpu';
        logSafe('WARN', 'whisper_fallback_cpu', { jobId, fallbackCpu: true, whisperDevice: 'cpu' });
        if (onHeartbeatRefresh) {
          await onHeartbeatRefresh();
        }
      },
    });
  } catch {
    // Error already persisted to manifest and logged by orchestrateAnalyzeJob
  } finally {
    await releaseTempWorkDir(tempWorkDir);
  }
}

async function processRenderJob({
  jobFilePath,
  manifest,
  driveDir,
  outputDir,
  ffmpegBin,
  encoder,
  zscaleAvailable,
}) {
  const jobId = String(manifest.jobId || path.basename(jobFilePath, '.json')).slice(0, 48);

  const claimResult = await claimJobAtomically({
    workerId: 'pc',
    canClaim: shouldPcWorkerClaimJob,
    readManifest: () => readJobManifestFile(jobFilePath),
    writeManifest: (nextManifest) => writeJobManifest(jobFilePath, nextManifest),
    extraPatch: {
      progress: 5,
      encoderUsed: encoder.codec,
    },
  });

  if (!claimResult.claimed || !claimResult.manifest) {
    logSafe('INFO', 'render_claim_skipped', {
      jobId,
      kind: 'render',
      claimedBy: claimResult.manifest?.claimedBy || 'other',
    });
    return;
  }

  const claimedManifest = claimResult.manifest;
  const tempWorkDir = await createTempWorkDir({
    workDir: runtimeConfig.workDir,
    prefix: `autocut_job_${jobId}_`,
  });
  const tJobStart = Date.now();
  const workingManifest = {
    ...claimedManifest,
    status: 'processing',
    progress: 5,
    encoderUsed: encoder.codec,
  };
  delete workingManifest.errorMessage;

  logSafe('INFO', 'render_started', {
    jobId,
    kind: 'render',
    clips: claimedManifest.sourceFiles?.length ?? 0,
    cuts: claimedManifest.cuts?.length ?? 0,
    quality: claimedManifest.options?.quality ?? '1080p',
    encoder: encoder.codec,
  });

  try {
    await writeJobManifest(jobFilePath, workingManifest);

    if (!Array.isArray(claimedManifest.sourceFiles) || claimedManifest.sourceFiles.length === 0) {
      throw new Error('El manifiesto no contiene archivos fuente (sourceFiles).');
    }
    if (!Array.isArray(claimedManifest.cuts) || claimedManifest.cuts.length === 0) {
      throw new Error('El manifiesto no contiene cortes activos (cuts).');
    }

    const resolvedPaths = [];
    for (let i = 0; i < claimedManifest.sourceFiles.length; i += 1) {
      const src = claimedManifest.sourceFiles[i];
      const found = await resolveSourceFilePath(driveDir, src.name);
      if (!found) {
        throw new Error(
          `No se encontró el vídeo fuente del clip ${i + 1} en la carpeta sincronizada de Google Drive. Asegúrate de que esté sincronizado.`
        );
      }
      resolvedPaths.push(found);
    }

    // Stage optional custom fonts from <driveDir>/_AutoCut_Styles/fonts/ into tempWorkDir/fonts/
    let preparedFontsDir = null;
    const requestedFontFile = claimedManifest.options?.subtitleStyle?.fontFile;
    if (typeof requestedFontFile === 'string' && requestedFontFile.trim()) {
      const sourceFontsDir = path.join(driveDir, STYLES_DIR_NAME, FONTS_DIR_NAME);
      const localFontsDir = path.join(tempWorkDir, 'fonts');
      try {
        const fontEntries = await fsp.readdir(sourceFontsDir, { withFileTypes: true });
        const fontFiles = fontEntries.filter(
          (e) => e.isFile() && /\.(ttf|otf)$/i.test(e.name)
        );
        if (fontFiles.length > 0) {
          await fsp.mkdir(localFontsDir, { recursive: true });
          for (const entry of fontFiles) {
            await fsp.copyFile(
              path.join(sourceFontsDir, entry.name),
              path.join(localFontsDir, entry.name)
            );
          }
          preparedFontsDir = localFontsDir;
        }
      } catch {
        // Folder missing -> renderJob will fall back to default font and invoke onWarning
      }
    }

    // Preserve exact render-core.mjs invocation and encoder args (NVENC / libx264)
    const tempFinalPath = await renderJob({
      manifest: claimedManifest,
      sourcePaths: resolvedPaths,
      workDir: tempWorkDir,
      ffmpegBin,
      zscaleAvailable,
      fontsDir: preparedFontsDir,
      encoder: { ...encoder, cpuPreset: 'fast' },
      onWarning: (code) => {
        logSafe('WARN', code || 'render_warning', { jobId });
      },
      onProgress: async (evt) => {
        workingManifest.progress = Math.max(5, Math.min(92, Math.round(evt.percent)));
        await writeJobManifest(jobFilePath, workingManifest);
        if (evt.stage === 'segment') {
          logSafe('INFO', 'render_segment', {
            jobId,
            cutIndex: evt.cutIndex + 1,
            totalCuts: evt.totalCuts,
            clip: (evt.clipIndex ?? 0) + 1,
          });
        }
      },
    });

    const finalFileName = sanitizeOutputFilename(claimedManifest.outputFileName, jobId);
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

    logSafe('INFO', 'render_completed', {
      jobId,
      kind: 'render',
      mb: Number((outStat.size / (1024 * 1024)).toFixed(2)),
      sec: Number(((Date.now() - tJobStart) / 1000).toFixed(1)),
      encoder: encoder.codec,
      progress: 100,
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logSafe('ERROR', 'render_failed', {
      jobId,
      kind: 'render',
      sec: Number(((Date.now() - tJobStart) / 1000).toFixed(1)),
    });
    try {
      await writeJobManifest(jobFilePath, {
        ...workingManifest,
        status: 'error',
        errorMessage: errorMsg.slice(0, 480),
        finishedAt: new Date().toISOString(),
      });
    } catch {
      logSafe('ERROR', 'render_error_patch_failed', { jobId });
    }
  } finally {
    await releaseTempWorkDir(tempWorkDir);
  }
}

async function scanAndProcessPending({
  jobsDir,
  outputDir,
  driveDir,
  ffmpegBin,
  pythonBin,
  encoder,
  zscaleAvailable,
  defaultWhisperModel,
  whisperDeviceState,
  setBusyState,
}) {
  let entries;
  try {
    entries = await fsp.readdir(jobsDir, { withFileTypes: true });
  } catch {
    return 0;
  }

  const pendingJobs = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!/^(?:job|analyze)_.*\.json$/i.test(entry.name)) continue;
    const jobFilePath = path.join(jobsDir, entry.name);
    try {
      const manifest = await readJobManifestFile(jobFilePath);
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

  if (pendingJobs.length === 0) return 0;

  if (setBusyState) {
    await setBusyState(true);
  }
  try {
    for (const job of pendingJobs) {
      if (isAnalyzeJobManifest(job.manifest)) {
        await processAnalyzeJob({
          ...job,
          driveDir,
          jobsDir,
          ffmpegBin,
          pythonBin,
          defaultWhisperModel,
          whisperDeviceState,
          onHeartbeatRefresh: setBusyState ? () => setBusyState(true) : undefined,
        });
      } else {
        await processRenderJob({
          ...job,
          driveDir,
          outputDir,
          ffmpegBin,
          encoder,
          zscaleAvailable,
        });
      }
    }
  } finally {
    if (setBusyState) {
      await setBusyState(false);
    }
  }

  return pendingJobs.length;
}

async function main() {
  // Load worker/.env.local before parsing CLI / env defaults
  loadLocalEnvFile(path.join(workerDir, '.env.local'), process.env);

  const cli = parseCliArgs(process.argv.slice(2), process.env);
  if (cli.help) {
    printHelp();
    process.exit(0);
  }

  if (!cli.driveDir || !cli.driveDir.trim()) {
    logSafe('ERROR', 'missing_drive_dir');
    printHelp();
    process.exit(1);
  }

  const driveDir = path.resolve(cli.driveDir.trim());
  if (!fs.existsSync(driveDir)) {
    logSafe('ERROR', 'drive_dir_not_found');
    process.exit(1);
  }

  const jobsDir = path.join(driveDir, JOBS_DIR_NAME);
  const outputDir = path.join(driveDir, OUTPUT_DIR_NAME);
  await fsp.mkdir(jobsDir, { recursive: true });
  await fsp.mkdir(outputDir, { recursive: true });

  const workCfg = getWorkDirConfig(process.env);
  runtimeConfig.workDir = workCfg.workDir;
  runtimeConfig.dedicated = workCfg.dedicated;
  runtimeConfig.hfHome = resolveHfHome(process.env);
  await ensureWorkDir(runtimeConfig.workDir);
  const commandsDir = path.join(jobsDir, COMMANDS_DIR_NAME);
  await fsp.mkdir(commandsDir, { recursive: true });
  const storageReporter = createStorageReporter({
    workDir: runtimeConfig.workDir,
    dedicated: runtimeConfig.dedicated,
    hfHome: runtimeConfig.hfHome,
  });

  const encoder = await detectVideoEncoder(cli.ffmpegBin, cli.forceCpu);
  const zscaleAvailable = await hasZscaleFilter(cli.ffmpegBin);
  if (!zscaleAvailable) {
    logSafe('WARN', 'zscale_unavailable', { zscaleAvailable: false });
  }

  const whisperDeviceState = { current: cli.whisperDevice, requested: cli.whisperDevice };
  let isBusy = false;

  const publishHeartbeat = async (busyOverride = isBusy) => {
    isBusy = Boolean(busyOverride);
    let storage = null;
    try {
      storage = await storageReporter.get();
    } catch {
      storage = null;
    }
    await writeWorkerHeartbeat({
      jobsDir,
      encoder: encoder.codec,
      whisperDevice: whisperDeviceState.current,
      whisperModel: cli.whisperModel,
      busy: isBusy,
      storage,
    });
  };

  await publishHeartbeat(false);

  // Dispositivo real de Whisper (sin cargar el modelo) para que el latido no se quede en "auto".
  if (cli.whisperDevice !== 'cpu') {
    const probed = await probeWhisperDevice({
      pythonBin: cli.pythonBin,
      scriptPath: path.join(workerDir, 'transcribe.py'),
      env: buildWhisperEnv(),
    });
    if (probed) {
      whisperDeviceState.current = probed.device;
      await publishHeartbeat(false);
    }
  }

  const runStaleCleanup = async () => {
    const res = await cleanupStaleTempDirs({ workDir: runtimeConfig.workDir });
    if (res.removed > 0) {
      logSafe('INFO', 'stale_temp_cleanup', { count: res.removed, mb: Math.round(res.bytes / 1048576) });
      storageReporter.invalidate();
    }
  };
  await runStaleCleanup().catch(() => {});

  const inFlightCommands = new Set();
  const runCommandsScan = async () => {
    const processed = await scanCleanupCommands({
      commandsDir,
      inFlight: inFlightCommands,
      ctx: {
        driveDir,
        workDir: runtimeConfig.workDir,
        dedicated: runtimeConfig.dedicated,
      },
    });
    if (processed > 0) {
      logSafe('INFO', 'cleanup_commands_processed', { count: processed });
      storageReporter.invalidate();
      await publishHeartbeat(isBusy);
    }
  };
  await runCommandsScan().catch(() => {});

  logSafe('INFO', 'worker_started', {
    version: WORKER_VERSION,
    encoder: encoder.codec,
    whisperDevice: whisperDeviceState.current,
    whisperModel: cli.whisperModel,
    zscaleAvailable,
    pollMs: cli.pollIntervalMs,
  });

  if (cli.once) {
    const count = await scanAndProcessPending({
      jobsDir,
      outputDir,
      driveDir,
      ffmpegBin: cli.ffmpegBin,
      pythonBin: cli.pythonBin,
      encoder,
      zscaleAvailable,
      defaultWhisperModel: cli.whisperModel,
      whisperDeviceState,
      setBusyState: publishHeartbeat,
    });
    logSafe('INFO', 'once_finished', { count });
    return;
  }

  let polling = false;
  const tick = async () => {
    if (polling) return;
    polling = true;
    try {
      await scanAndProcessPending({
        jobsDir,
        outputDir,
        driveDir,
        ffmpegBin: cli.ffmpegBin,
        pythonBin: cli.pythonBin,
        encoder,
        zscaleAvailable,
        defaultWhisperModel: cli.whisperModel,
        whisperDeviceState,
        setBusyState: publishHeartbeat,
      });
    } finally {
      polling = false;
    }
  };

  await tick();
  const pollIntervalId = setInterval(() => {
    void tick();
  }, cli.pollIntervalMs);

  const heartbeatIntervalId = setInterval(() => {
    void publishHeartbeat(isBusy);
  }, HEARTBEAT_INTERVAL_MS);

  const cleanupIntervalId = setInterval(() => {
    void runStaleCleanup().catch(() => {});
  }, CLEANUP_INTERVAL_MS);

  const commandsIntervalId = setInterval(() => {
    void runCommandsScan().catch(() => {});
  }, COMMANDS_POLL_INTERVAL_MS);

  const shutdown = () => {
    logSafe('INFO', 'worker_stopping');
    clearInterval(pollIntervalId);
    clearInterval(heartbeatIntervalId);
    clearInterval(cleanupIntervalId);
    clearInterval(commandsIntervalId);
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const isMainModule =
  process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (isMainModule) {
  // Never die silently: record the error type/code (no paths or secrets) before exiting.
  const describeFatal = (err) => ({
    name: err?.name || typeof err,
    code: err?.code || null,
    syscall: err?.syscall || null,
  });
  process.on('unhandledRejection', (reason) => {
    logSafe('ERROR', 'unhandled_rejection', describeFatal(reason));
  });
  process.on('uncaughtException', (err) => {
    logSafe('ERROR', 'uncaught_exception', describeFatal(err));
    process.exit(1);
  });

  main().catch(() => {
    logSafe('ERROR', 'fatal_unhandled_error');
    process.exit(1);
  });
}
