#!/usr/bin/env node
/**
 * AutoCut Drive AI — Cloud Render & Analysis Worker for GitHub Actions (Node 20+, zero deps)
 *
 * Handles two job kinds in `_AutoCut_Jobs/`:
 * 1. `analyze_<id>.json` (`kind: "analyze"`):
 *    Streams source videos to disk -> Whisper transcription (with Drive `_cache` reuse) ->
 *    Gemini multimodal Phase A (video+audio proxy) + Phase B (global story script) +
 *    deterministic cut conversion + Phase C (coherence review) -> writes `plan` & `status: "analyzed"`.
 * 2. `job_<id>.json` (render):
 *    Streams source videos to disk -> renders via `worker/render-core.mjs` (`libx264` + HDR->SDR +
 *    2-pass loudnorm + word-level ASS subtitles) -> uploads MP4 to `_AutoCut_Output` in 8 MB chunks.
 *
 * PRIVACY GUARANTEE (public GitHub Actions logs):
 * - Emits `::add-mask::<token>` immediately for OAuth tokens and `GEMINI_API_KEY`.
 * - Logs ONLY safe telemetry: jobId, kind, clip count, MB, elapsed seconds, HTTP codes,
 *   stage, progress, encoder, quality, cacheHit. NEVER logs filenames, transcripts, tokens,
 *   headers, or Drive IDs.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import {
  getCloudCpuPreset,
  renderJob,
  sanitizeOutputFilename,
} from './render-core.mjs';
import {
  buildTranscriptCacheFilename,
  claimJobAtomically,
  normalizeWhisperDevice,
  orchestrateAnalyzeJob,
} from './analyze-core.mjs';

export { buildTranscriptCacheFilename };

const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';
const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';
const JOBS_SUBFOLDER = '_AutoCut_Jobs';
const OUTPUT_SUBFOLDER = '_AutoCut_Output';
const STYLES_SUBFOLDER = '_AutoCut_Styles';
const FONTS_SUBFOLDER = 'fonts';
const CACHE_SUBFOLDER = '_cache';

const TOKEN_REFRESH_AGE_MS = 45 * 60 * 1000; // Refresh proactively after 45 min
const PROGRESS_WRITE_THROTTLE_MS = 10_000; // At most 1 progress write every 10 s
export const RESUMABLE_CHUNK_BYTES = 8 * 1024 * 1024; // 8 MB chunks (multiple of 256 KB)

const SAFE_LOG_KEYS = new Set([
  'jobId',
  'kind',
  'clips',
  'cuts',
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
  'claimedBy',
  'coherent',
]);

/**
 * Formats a privacy-safe log line strictly whitelisting numeric/structural telemetry.
 * Guarantees no filenames, transcripts, OAuth tokens, headers, or folder IDs can ever leak.
 */
export function formatSafeCloudLog(level, stage, metrics = {}) {
  const ts = new Date().toISOString().slice(11, 23);
  const safe = {};
  for (const [k, v] of Object.entries(metrics || {})) {
    if (!SAFE_LOG_KEYS.has(k) || v === undefined || v === null) continue;
    if (typeof v === 'number' && Number.isFinite(v)) {
      safe[k] = v;
    } else if (typeof v === 'boolean') {
      safe[k] = v;
    } else if (typeof v === 'string') {
      const trimmed = v.trim();
      if (
        trimmed.length <= 48 &&
        !trimmed.includes('/') &&
        !trimmed.includes('\\') &&
        !trimmed.includes('.') &&
        !/^(ya29|AIza|ghp_|github_pat_|Bearer)/i.test(trimmed)
      ) {
        safe[k] = trimmed;
      }
    }
  }
  const suffix = Object.keys(safe).length > 0 ? ` ${JSON.stringify(safe)}` : '';
  return `[${ts}] [${level}] [cloud-worker] ${stage}${suffix}`;
}

function logSafe(level, stage, metrics) {
  const line = formatSafeCloudLog(level, stage, metrics);
  if (level === 'ERROR') {
    console.error(line);
  } else {
    console.log(line);
  }
}

export function isAnalyzeManifest(manifest) {
  return Boolean(manifest && typeof manifest === 'object' && manifest.kind === 'analyze');
}

export function getCloudJobRoute(manifest) {
  if (isAnalyzeManifest(manifest)) return 'analyze';
  return 'render';
}

export function shouldCloudWorkerClaimJob(manifest) {
  if (!manifest || typeof manifest !== 'object') return false;
  if (manifest.status !== 'pending') return false;
  if (manifest.kind === 'analyze') {
    return manifest.target !== 'pc';
  }
  return manifest.target === 'cloud';
}

export function parseCloudCliArgs(argv) {
  const opts = { jobFileId: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--job-file-id' && argv[i + 1]) {
      opts.jobFileId = argv[i + 1].trim();
      i += 1;
    } else if (arg.startsWith('--job-file-id=')) {
      opts.jobFileId = arg.slice('--job-file-id='.length).trim();
    }
  }
  return opts;
}

class PhaseError extends Error {
  constructor(phase, message) {
    const clean = String(message || 'Error inesperado').trim();
    const formatted = clean.startsWith(`[${phase}]`) ? clean : `[${phase}] ${clean}`;
    super(formatted);
    this.name = 'PhaseError';
    this.phase = phase;
  }
}

class DriveTokenManager {
  constructor({ clientId, clientSecret, refreshToken }) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.refreshToken = refreshToken;
    this.accessToken = '';
    this.obtainedAtMs = 0;
  }

  async getToken(forceRefresh = false) {
    const ageMs = Date.now() - this.obtainedAtMs;
    if (!forceRefresh && this.accessToken && ageMs < TOKEN_REFRESH_AGE_MS) {
      return this.accessToken;
    }

    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: this.refreshToken,
      grant_type: 'refresh_token',
    });

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!res.ok) {
      logSafe('ERROR', 'oauth_token_refresh_failed', { http: res.status });
      throw new PhaseError(
        'Drive',
        `No se pudo renovar el token OAuth de Google Drive (HTTP ${res.status}). Revisa los Secrets de GitHub.`
      );
    }

    const data = await res.json();
    const token = typeof data?.access_token === 'string' ? data.access_token.trim() : '';
    if (!token) {
      throw new PhaseError('Drive', 'Google OAuth no devolvió un access_token válido.');
    }

    console.log(`::add-mask::${token}`);
    this.accessToken = token;
    this.obtainedAtMs = Date.now();
    logSafe('INFO', 'oauth_token_ready', { http: res.status });
    return token;
  }
}

async function driveFetch(tokenManager, url, init = {}, phase = 'Drive') {
  let token = await tokenManager.getToken(false);
  let res = await fetch(url, {
    ...init,
    headers: {
      ...(init.headers || {}),
      Authorization: `Bearer ${token}`,
    },
  });

  if (res.status === 401) {
    token = await tokenManager.getToken(true);
    res = await fetch(url, {
      ...init,
      headers: {
        ...(init.headers || {}),
        Authorization: `Bearer ${token}`,
      },
    });
  }

  if (!res.ok) {
    logSafe('ERROR', 'drive_http_error', { http: res.status });
    throw new PhaseError(phase, `Error de Google Drive (HTTP ${res.status}).`);
  }
  return res;
}

function escapeDriveQuery(val) {
  return String(val).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function findSubfolder(tokenManager, parentId, folderName) {
  const q = encodeURIComponent(
    `'${escapeDriveQuery(parentId)}' in parents and name = '${escapeDriveQuery(
      folderName
    )}' and mimeType = '${DRIVE_FOLDER_MIME}' and trashed = false`
  );
  const res = await driveFetch(
    tokenManager,
    `${DRIVE_API_BASE}/files?q=${q}&fields=files(id)&pageSize=5`,
    { method: 'GET' }
  );
  const data = await res.json();
  return data?.files?.[0]?.id || null;
}

async function findOrCreateSubfolder(tokenManager, parentId, folderName) {
  const existingId = await findSubfolder(tokenManager, parentId, folderName);
  if (existingId) {
    return existingId;
  }

  const createRes = await driveFetch(tokenManager, `${DRIVE_API_BASE}/files?fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({
      name: folderName,
      mimeType: DRIVE_FOLDER_MIME,
      parents: [parentId],
    }),
  });
  const created = await createRes.json();
  return created.id;
}

async function downloadCloudStyleFonts(tokenManager, rootFolderId, workDir, jobId) {
  if (!rootFolderId) return null;
  try {
    const stylesFolderId = await findSubfolder(tokenManager, rootFolderId, STYLES_SUBFOLDER);
    if (!stylesFolderId) return null;
    const fontsFolderId = await findSubfolder(tokenManager, stylesFolderId, FONTS_SUBFOLDER);
    if (!fontsFolderId) return null;

    const q = encodeURIComponent(`'${escapeDriveQuery(fontsFolderId)}' in parents and trashed = false`);
    const res = await driveFetch(
      tokenManager,
      `${DRIVE_API_BASE}/files?q=${q}&fields=files(id,name)&pageSize=50`,
      { method: 'GET' }
    );
    const data = await res.json();
    const files = Array.isArray(data?.files)
      ? data.files.filter((f) => typeof f?.name === 'string' && /\.(ttf|otf)$/i.test(f.name))
      : [];
    if (files.length === 0) return null;

    const localFontsDir = path.join(workDir, 'fonts');
    await fsp.mkdir(localFontsDir, { recursive: true });
    for (const file of files) {
      const safeName = path.basename(file.name).replace(/[<>:"/\\|?*\x00-\x1F]/g, '');
      if (!safeName) continue;
      await streamDownloadDriveFile(tokenManager, file.id, path.join(localFontsDir, safeName));
    }
    logSafe('INFO', 'subtitle_fonts_downloaded', { jobId, clips: files.length });
    return localFontsDir;
  } catch {
    logSafe('WARN', 'subtitle_fonts_download_failed', { jobId });
    return null;
  }
}

async function readJobManifestById(tokenManager, fileId) {
  const res = await driveFetch(
    tokenManager,
    `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?alt=media`,
    { method: 'GET' }
  );
  const parsed = await res.json();
  if (!parsed || typeof parsed !== 'object') {
    throw new PhaseError('Drive', 'El archivo de trabajo JSON en Drive no es válido.');
  }
  return parsed;
}

async function patchJobManifest(tokenManager, fileId, manifest) {
  const payload = JSON.stringify(
    {
      ...manifest,
      updatedAt: new Date().toISOString(),
    },
    null,
    2
  );
  await driveFetch(
    tokenManager,
    `${DRIVE_UPLOAD_BASE}/files/${encodeURIComponent(fileId)}?uploadType=media`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: payload,
    }
  );
}

async function readCachedTranscriptFromDrive(tokenManager, cacheFolderId, fileName) {
  try {
    const q = encodeURIComponent(
      `'${escapeDriveQuery(cacheFolderId)}' in parents and name = '${escapeDriveQuery(
        fileName
      )}' and trashed = false`
    );
    const listRes = await driveFetch(
      tokenManager,
      `${DRIVE_API_BASE}/files?q=${q}&fields=files(id)&pageSize=1`,
      { method: 'GET' }
    );
    const listData = await listRes.json();
    const fileId = listData?.files?.[0]?.id;
    if (!fileId) return null;

    const dlRes = await driveFetch(
      tokenManager,
      `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?alt=media`,
      { method: 'GET' }
    );
    const parsed = await dlRes.json();
    if (!parsed || !Array.isArray(parsed.segments)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeCachedTranscriptToDrive(tokenManager, cacheFolderId, fileName, transcriptObj) {
  try {
    const q = encodeURIComponent(
      `'${escapeDriveQuery(cacheFolderId)}' in parents and name = '${escapeDriveQuery(
        fileName
      )}' and trashed = false`
    );
    const listRes = await driveFetch(
      tokenManager,
      `${DRIVE_API_BASE}/files?q=${q}&fields=files(id)&pageSize=1`,
      { method: 'GET' }
    );
    const listData = await listRes.json();
    const existingId = listData?.files?.[0]?.id;
    const jsonContent = JSON.stringify(transcriptObj);

    if (existingId) {
      await driveFetch(
        tokenManager,
        `${DRIVE_UPLOAD_BASE}/files/${encodeURIComponent(existingId)}?uploadType=media`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json; charset=UTF-8' },
          body: jsonContent,
        }
      );
      return;
    }

    const boundary = `autocut_cache_${Date.now()}`;
    const metadata = {
      name: fileName,
      parents: [cacheFolderId],
      mimeType: 'application/json',
    };
    const multipartBody =
      `--${boundary}\r\n` +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      `${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\n` +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      `${jsonContent}\r\n` +
      `--${boundary}--`;

    await driveFetch(tokenManager, `${DRIVE_UPLOAD_BASE}/files?uploadType=multipart&fields=id`, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body: multipartBody,
    });
  } catch {
    // Non-fatal: cache write failure should never abort analysis
  }
}

/**
 * Streams a Drive video directly to a local file on disk (never buffering the file in RAM).
 */
async function streamDownloadDriveFile(tokenManager, driveFileId, destPath) {
  const t0 = Date.now();
  const res = await driveFetch(
    tokenManager,
    `${DRIVE_API_BASE}/files/${encodeURIComponent(driveFileId)}?alt=media`,
    { method: 'GET' },
    'Drive'
  );

  if (!res.body) {
    throw new PhaseError('Drive', 'Respuesta sin cuerpo al descargar vídeo fuente.');
  }

  const nodeStream = Readable.fromWeb(res.body);
  const writeStream = fs.createWriteStream(destPath);
  await pipeline(nodeStream, writeStream);

  const stat = await fsp.stat(destPath);
  return {
    bytes: stat.size,
    mb: Number((stat.size / (1024 * 1024)).toFixed(2)),
    sec: Number(((Date.now() - t0) / 1000).toFixed(1)),
    http: res.status,
  };
}

/**
 * Uploads the rendered MP4 to `_AutoCut_Output` via Google Drive resumable upload in 8 MB chunks,
 * reading sequentially from disk so peak upload RAM stays ~8 MB.
 */
async function uploadMp4Resumable8MB(tokenManager, outputFolderId, fileName, localFilePath) {
  const t0 = Date.now();
  const stat = await fsp.stat(localFilePath);
  const totalBytes = stat.size;
  if (totalBytes <= 0) {
    throw new PhaseError('Subida', 'El MP4 generado está vacío (0 bytes).');
  }

  const initRes = await driveFetch(
    tokenManager,
    `${DRIVE_UPLOAD_BASE}/files?uploadType=resumable&fields=id,name,webViewLink,size`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': 'video/mp4',
        'X-Upload-Content-Length': String(totalBytes),
      },
      body: JSON.stringify({
        name: fileName,
        parents: [outputFolderId],
        mimeType: 'video/mp4',
      }),
    },
    'Subida'
  );

  const uploadSessionUri = initRes.headers.get('location');
  if (!uploadSessionUri) {
    throw new PhaseError('Subida', 'Google Drive no devolvió la URL de sesión resumable.');
  }

  const fh = await fsp.open(localFilePath, 'r');
  try {
    let offset = 0;
    let uploadedMeta = null;

    while (offset < totalBytes) {
      const chunkLen = Math.min(RESUMABLE_CHUNK_BYTES, totalBytes - offset);
      const buffer = Buffer.allocUnsafe(chunkLen);
      const { bytesRead } = await fh.read(buffer, 0, chunkLen, offset);
      const slice = bytesRead === chunkLen ? buffer : buffer.subarray(0, bytesRead);
      const rangeEnd = offset + bytesRead - 1;

      const token = await tokenManager.getToken(false);
      const putRes = await fetch(uploadSessionUri, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'video/mp4',
          'Content-Length': String(bytesRead),
          'Content-Range': `bytes ${offset}-${rangeEnd}/${totalBytes}`,
        },
        body: slice,
      });

      if (putRes.status === 308) {
        offset += bytesRead;
        continue;
      }

      if (putRes.ok) {
        uploadedMeta = await putRes.json();
        offset = totalBytes;
        break;
      }

      logSafe('ERROR', 'resumable_chunk_failed', { http: putRes.status });
      throw new PhaseError(
        'Subida',
        `Fallo al subir bloque del MP4 a Google Drive (HTTP ${putRes.status}).`
      );
    }

    if (!uploadedMeta?.id) {
      throw new PhaseError('Subida', 'No se recibió el ID del archivo tras completar la subida.');
    }

    return {
      id: uploadedMeta.id,
      webViewLink: uploadedMeta.webViewLink || undefined,
      mb: Number((totalBytes / (1024 * 1024)).toFixed(2)),
      sec: Number(((Date.now() - t0) / 1000).toFixed(1)),
    };
  } finally {
    await fh.close();
  }
}

async function listPendingCloudJobs(tokenManager, jobsFolderId) {
  const q = encodeURIComponent(
    `'${escapeDriveQuery(jobsFolderId)}' in parents and trashed = false`
  );
  const res = await driveFetch(
    tokenManager,
    `${DRIVE_API_BASE}/files?q=${q}&fields=files(id,name,modifiedTime)&pageSize=50&orderBy=createdTime asc`,
    { method: 'GET' }
  );
  const data = await res.json();
  const files = (data?.files || []).filter((f) => /^(job|analyze)_.*\.json$/i.test(f.name || ''));

  const pending = [];
  for (const file of files) {
    try {
      const manifest = await readJobManifestById(tokenManager, file.id);
      if (shouldCloudWorkerClaimJob(manifest)) {
        pending.push({ fileId: file.id, manifest });
      }
    } catch {
      // Skip unreadable job files
    }
  }

  pending.sort((a, b) => {
    const aMs = Date.parse(a.manifest.createdAt || '') || 0;
    const bMs = Date.parse(b.manifest.createdAt || '') || 0;
    return aMs - bMs;
  });

  return pending;
}

/**
 * Processes an `analyze_<id>.json` (`kind: "analyze"`) job:
 * descarga (5-20) -> transcripcion (20-55) -> vision (55-80) -> guion (80-92) -> revision (92-100).
 */
async function processAnalyzeJob({ tokenManager, jobFileId, manifest, jobsFolderId }) {
  const jobId = String(manifest.jobId || 'unknown').slice(0, 48);

  const claimResult = await claimJobAtomically({
    workerId: 'cloud',
    canClaim: shouldCloudWorkerClaimJob,
    readManifest: () => readJobManifestById(tokenManager, jobFileId),
    writeManifest: (nextManifest) => patchJobManifest(tokenManager, jobFileId, nextManifest),
    extraPatch: {
      kind: 'analyze',
      target: 'cloud',
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
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'autocut_analyze_'));
  const whisperModel =
    claimedManifest.options?.whisperModel === 'medium'
      ? 'medium'
      : claimedManifest.options?.whisperModel === 'small'
      ? 'small'
      : (process.env.WHISPER_MODEL || 'small').trim() || 'small';
  const whisperDevice = normalizeWhisperDevice(process.env.WHISPER_DEVICE, 'cpu');
  const geminiApiKey = (process.env.GEMINI_API_KEY || '').trim();
  const workerDir = path.dirname(fileURLToPath(import.meta.url));
  const transcribeScriptPath = path.join(workerDir, 'transcribe.py');

  try {
    const cacheFolderId = await findOrCreateSubfolder(tokenManager, jobsFolderId, CACHE_SUBFOLDER);

    await orchestrateAnalyzeJob({
      manifest: claimedManifest,
      target: 'cloud',
      workDir,
      apiKey: geminiApiKey,
      missingApiKeyMessage:
        '[Análisis IA] Falta el secreto GEMINI_API_KEY en GitHub Actions. Añádelo en Settings > Secrets > Actions.',
      ffmpegBin: process.env.AUTOCUT_FFMPEG_BIN || 'ffmpeg',
      ffprobeBin: process.env.AUTOCUT_FFPROBE_BIN || undefined,
      pythonBin: process.env.AUTOCUT_PYTHON_BIN || 'python3',
      transcribeScriptPath,
      whisperModel,
      whisperDevice,
      progressThrottleMs: PROGRESS_WRITE_THROTTLE_MS,
      prepareSourcePaths: async ({ manifest: current, workDir: dir, writeProgress }) => {
        const sourcePaths = [];
        const totalClips = current.sourceFiles.length;
        for (let i = 0; i < totalClips; i += 1) {
          const src = current.sourceFiles[i];
          if (!src?.driveFileId || typeof src.driveFileId !== 'string') {
            throw new PhaseError(
              'Drive',
              `Falta el identificador driveFileId del clip ${i + 1} en el manifiesto.`
            );
          }
          const localPath = path.join(dir, `source_${String(i).padStart(3, '0')}.bin`);
          const dlStats = await streamDownloadDriveFile(tokenManager, src.driveFileId, localPath);
          sourcePaths.push(localPath);

          const dlPct = 5 + Math.round(((i + 1) / totalClips) * 15);
          await writeProgress('descarga', dlPct, i === totalClips - 1);
          logSafe('INFO', 'analyze_source_downloaded', {
            jobId,
            clips: i + 1,
            mb: dlStats.mb,
            sec: dlStats.sec,
            http: dlStats.http,
          });
        }
        return sourcePaths;
      },
      getCachedTranscript: async (driveFileId, modifiedTime) => {
        const cacheName = buildTranscriptCacheFilename(driveFileId, modifiedTime);
        const hit = await readCachedTranscriptFromDrive(tokenManager, cacheFolderId, cacheName);
        logSafe('INFO', 'transcript_cache_lookup', { jobId, cacheHit: Boolean(hit) });
        return hit;
      },
      saveCachedTranscript: async (driveFileId, modifiedTime, transcriptObj) => {
        const cacheName = buildTranscriptCacheFilename(driveFileId, modifiedTime);
        await writeCachedTranscriptToDrive(tokenManager, cacheFolderId, cacheName, transcriptObj);
      },
      patchManifest: (nextManifest) => patchJobManifest(tokenManager, jobFileId, nextManifest),
      onLog: (level, stage, metrics) => logSafe(level, stage, metrics),
    });
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function processCloudJob({ tokenManager, jobFileId, manifest, outputFolderId, rootFolderId }) {
  if (isAnalyzeManifest(manifest)) {
    throw new PhaseError('Sistema', 'Un manifiesto kind="analyze" no puede entrar en el flujo de render.');
  }

  const jobId = String(manifest.jobId || 'unknown').slice(0, 48);
  const qualityKey = manifest.options?.quality === '720p' ? '720p' : '1080p';
  const cpuPreset = getCloudCpuPreset(qualityKey);
  const encoderName = `libx264 (${cpuPreset})`;

  const claimResult = await claimJobAtomically({
    workerId: 'cloud',
    canClaim: shouldCloudWorkerClaimJob,
    readManifest: () => readJobManifestById(tokenManager, jobFileId),
    writeManifest: (nextManifest) => patchJobManifest(tokenManager, jobFileId, nextManifest),
    extraPatch: {
      target: 'cloud',
      progress: 5,
      encoderUsed: encoderName,
    },
  });

  if (!claimResult.claimed || !claimResult.manifest) {
    logSafe('INFO', 'job_claim_skipped', {
      jobId,
      kind: 'render',
      claimedBy: claimResult.manifest?.claimedBy || 'other',
    });
    return;
  }

  const claimedManifest = claimResult.manifest;
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'autocut_cloud_'));
  const tJobStart = Date.now();

  let lastProgressWriteMs = 0;
  const workingManifest = {
    ...claimedManifest,
    target: 'cloud',
    status: 'processing',
    progress: 5,
    encoderUsed: encoderName,
    errorMessage: undefined,
  };

  const writeProgress = async (progress, force = false) => {
    const now = Date.now();
    workingManifest.progress = Math.max(0, Math.min(100, Math.round(progress)));
    if (!force && now - lastProgressWriteMs < PROGRESS_WRITE_THROTTLE_MS) {
      return;
    }
    lastProgressWriteMs = now;
    await patchJobManifest(tokenManager, jobFileId, workingManifest);
  };

  logSafe('INFO', 'job_started', {
    jobId,
    kind: 'render',
    clips: claimedManifest.sourceFiles?.length ?? 0,
    cuts: claimedManifest.cuts?.length ?? 0,
    quality: qualityKey,
    encoder: 'libx264',
  });

  try {
    await writeProgress(5, true);

    if (!Array.isArray(manifest.sourceFiles) || manifest.sourceFiles.length === 0) {
      throw new PhaseError('Drive', 'El manifiesto no contiene archivos fuente (sourceFiles).');
    }
    if (!Array.isArray(manifest.cuts) || manifest.cuts.length === 0) {
      throw new PhaseError('FFmpeg', 'El manifiesto no contiene cortes activos (cuts).');
    }

    const sourcePaths = [];
    for (let i = 0; i < manifest.sourceFiles.length; i += 1) {
      const src = manifest.sourceFiles[i];
      if (!src?.driveFileId || typeof src.driveFileId !== 'string') {
        throw new PhaseError(
          'Drive',
          `Falta el identificador driveFileId del clip ${i + 1} en el manifiesto.`
        );
      }
      const localPath = path.join(workDir, `source_${String(i).padStart(3, '0')}.bin`);
      const dlStats = await streamDownloadDriveFile(tokenManager, src.driveFileId, localPath);
      sourcePaths.push(localPath);
      logSafe('INFO', 'source_downloaded', {
        jobId,
        clips: i + 1,
        mb: dlStats.mb,
        sec: dlStats.sec,
        http: dlStats.http,
      });
    }

    let preparedFontsDir = null;
    const requestedFontFile = claimedManifest.options?.subtitleStyle?.fontFile;
    if (typeof requestedFontFile === 'string' && requestedFontFile.trim()) {
      preparedFontsDir = await downloadCloudStyleFonts(tokenManager, rootFolderId, workDir, jobId);
    }

    const tRenderStart = Date.now();
    let finalLocalPath;
    try {
      finalLocalPath = await renderJob({
        manifest,
        sourcePaths,
        workDir,
        ffmpegBin: process.env.AUTOCUT_FFMPEG_BIN || 'ffmpeg',
        ffprobeBin: process.env.AUTOCUT_FFPROBE_BIN || undefined,
        zscaleAvailable: true,
        fontsDir: preparedFontsDir,
        encoder: {
          codec: 'libx264',
          cpuPreset: (q) => getCloudCpuPreset(q),
        },
        onWarning: (code) => {
          logSafe('WARN', code || 'render_warning', { jobId });
        },
        onProgress: async (evt) => {
          const clamped = Math.max(10, Math.min(88, Math.round(evt.percent)));
          await writeProgress(clamped, false);
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new PhaseError('FFmpeg', msg);
    }

    const renderedStat = await fsp.stat(finalLocalPath);
    logSafe('INFO', 'render_completed', {
      jobId,
      mb: Number((renderedStat.size / (1024 * 1024)).toFixed(2)),
      sec: Number(((Date.now() - tRenderStart) / 1000).toFixed(1)),
      encoder: 'libx264',
    });

    await writeProgress(90, true);
    const finalFileName = sanitizeOutputFilename(manifest.outputFileName, jobId);
    const uploaded = await uploadMp4Resumable8MB(
      tokenManager,
      outputFolderId,
      finalFileName,
      finalLocalPath
    );

    logSafe('INFO', 'output_uploaded', {
      jobId,
      mb: uploaded.mb,
      sec: uploaded.sec,
      http: 200,
    });

    workingManifest.status = 'completed';
    workingManifest.progress = 100;
    workingManifest.outputFileName = finalFileName;
    workingManifest.outputDriveId = uploaded.id;
    if (uploaded.webViewLink) {
      workingManifest.outputWebViewLink = uploaded.webViewLink;
    }
    workingManifest.encoderUsed = encoderName;
    workingManifest.finishedAt = new Date().toISOString();
    delete workingManifest.errorMessage;

    await patchJobManifest(tokenManager, jobFileId, workingManifest);
    logSafe('INFO', 'job_completed', {
      jobId,
      kind: 'render',
      mb: uploaded.mb,
      sec: Number(((Date.now() - tJobStart) / 1000).toFixed(1)),
      progress: 100,
    });
  } catch (err) {
    const message =
      err instanceof PhaseError
        ? err.message
        : `[FFmpeg] ${err instanceof Error ? err.message : String(err)}`;
    logSafe('ERROR', 'job_failed', {
      jobId,
      kind: 'render',
      sec: Number(((Date.now() - tJobStart) / 1000).toFixed(1)),
    });
    try {
      await patchJobManifest(tokenManager, jobFileId, {
        ...workingManifest,
        status: 'error',
        errorMessage: message.slice(0, 480),
        finishedAt: new Date().toISOString(),
      });
    } catch {
      logSafe('ERROR', 'job_error_patch_failed', { jobId });
    }
    throw err;
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function main() {
  const clientId = (process.env.GDRIVE_CLIENT_ID || '').trim();
  const clientSecret = (process.env.GDRIVE_CLIENT_SECRET || '').trim();
  const refreshToken = (process.env.GDRIVE_REFRESH_TOKEN || '').trim();
  const rootFolderId = (process.env.AUTOCUT_ROOT_FOLDER_ID || '').trim();
  const geminiApiKey = (process.env.GEMINI_API_KEY || '').trim();

  if (!clientId || !clientSecret || !refreshToken || !rootFolderId) {
    logSafe('ERROR', 'missing_required_env_secrets');
    process.exit(1);
  }

  console.log(`::add-mask::${clientSecret}`);
  console.log(`::add-mask::${refreshToken}`);
  if (geminiApiKey) {
    console.log(`::add-mask::${geminiApiKey}`);
  }

  const cli = parseCloudCliArgs(process.argv.slice(2));
  const tokenManager = new DriveTokenManager({ clientId, clientSecret, refreshToken });
  await tokenManager.getToken(true);

  const [jobsFolderId, outputFolderId] = await Promise.all([
    findOrCreateSubfolder(tokenManager, rootFolderId, JOBS_SUBFOLDER),
    findOrCreateSubfolder(tokenManager, rootFolderId, OUTPUT_SUBFOLDER),
  ]);

  let jobsToRun = [];
  if (cli.jobFileId) {
    if (!/^[A-Za-z0-9_-]{10,}$/.test(cli.jobFileId)) {
      logSafe('ERROR', 'invalid_job_file_id');
      process.exit(1);
    }
    const manifest = await readJobManifestById(tokenManager, cli.jobFileId);
    if (shouldCloudWorkerClaimJob(manifest)) {
      jobsToRun.push({ fileId: cli.jobFileId, manifest });
    } else {
      logSafe('INFO', 'job_skipped_not_pending_cloud', {
        jobId: String(manifest.jobId || '').slice(0, 48),
      });
    }
  } else {
    jobsToRun = await listPendingCloudJobs(tokenManager, jobsFolderId);
  }

  logSafe('INFO', 'queue_checked', { jobsFound: jobsToRun.length });

  let hadFailure = false;
  for (const entry of jobsToRun) {
    try {
      if (getCloudJobRoute(entry.manifest) === 'analyze') {
        await processAnalyzeJob({
          tokenManager,
          jobFileId: entry.fileId,
          manifest: entry.manifest,
          jobsFolderId,
        });
      } else {
        await processCloudJob({
          tokenManager,
          jobFileId: entry.fileId,
          manifest: entry.manifest,
          outputFolderId,
          rootFolderId,
        });
      }
    } catch {
      hadFailure = true;
    }
  }

  if (hadFailure) {
    process.exit(1);
  }
}

const isMainModule =
  process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (isMainModule) {
  main().catch(() => {
    logSafe('ERROR', 'fatal_unhandled_error');
    process.exit(1);
  });
}
