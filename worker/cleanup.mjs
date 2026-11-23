/**
 * AutoCut Drive AI — Limpieza y almacenamiento del PC worker.
 *
 * - Carpeta de trabajo configurable (AUTOCUT_WORK_DIR) y seguimiento de carpetas de jobs en curso.
 * - Limpieza automática de carpetas `autocut_*` antiguas.
 * - Comandos de limpieza `_AutoCut_Jobs/_commands/cleanup_<id>.json` (scopes).
 * - Datos de almacenamiento para el latido (`storage`).
 *
 * Sin dependencias de src/: la regla de "bruto ya editado" replica la de la PWA
 * (detectPendingVideos / buildEditedFilename en src/utils/videoPipeline.ts).
 */

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const TEMP_DIR_PREFIX = 'autocut_';
export const STALE_TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const FINISHED_JOB_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const COMMANDS_DIR_NAME = '_commands';
export const CLEANUP_SCOPES = [
  'preview_brutos_editados',
  'brutos_editados',
  'jobs_terminados',
  'temp_pc',
];

const JOBS_DIR_NAME = '_AutoCut_Jobs';
const OUTPUT_DIR_NAME = '_AutoCut_Output';
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm']);
const EDITED_MARKER = '_EDITADO';
const TERMINAL_JOB_STATUSES = new Set(['completed', 'analyzed', 'error']);
const COMMAND_FILE_PATTERN = /^cleanup_[A-Za-z0-9_-]+\.json$/;
const JOB_FILE_PATTERN = /^(?:job|analyze)_.*\.json$/i;

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function pathKey(p) {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function toMB(bytes) {
  return Math.round((Number(bytes) / 1048576) * 10) / 10;
}

export async function dirSizeBytes(target) {
  let total = 0;
  const stack = [target];
  while (stack.length > 0) {
    const current = stack.pop();
    let st;
    try {
      st = await fsp.lstat(current);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      let names;
      try {
        names = await fsp.readdir(current);
      } catch {
        continue;
      }
      for (const name of names) stack.push(path.join(current, name));
    } else {
      total += st.size;
    }
  }
  return total;
}

async function removeWithSize(target) {
  const bytes = await dirSizeBytes(target);
  try {
    await fsp.rm(target, { recursive: true, force: true });
  } catch {
    return { ok: false, bytes: 0 };
  }
  return { ok: true, bytes };
}

async function readJsonSafe(filePath) {
  try {
    // Algunos editores (p. ej. PowerShell 5.1 con -Encoding UTF8) añaden BOM al JSON.
    const text = await fsp.readFile(filePath, 'utf8');
    const raw = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Carpeta de trabajo y jobs en curso
// ---------------------------------------------------------------------------

/**
 * AUTOCUT_WORK_DIR definida -> carpeta dedicada; si no, os.tmpdir() (no dedicada).
 */
export function getWorkDirConfig(env = process.env) {
  const raw = String(env.AUTOCUT_WORK_DIR || '').trim();
  if (raw) return { workDir: path.resolve(raw), dedicated: true };
  return { workDir: os.tmpdir(), dedicated: false };
}

export async function ensureWorkDir(workDir) {
  await fsp.mkdir(workDir, { recursive: true });
  return workDir;
}

const activeTempDirs = new Set();

export function isTempDirActive(dir) {
  return activeTempDirs.has(pathKey(dir));
}

export function getActiveTempDirs() {
  return [...activeTempDirs];
}

/**
 * Crea la carpeta temporal de un job dentro de la carpeta de trabajo (y la crea si falta)
 * y la registra como "en curso" para que ninguna limpieza la toque.
 */
export async function createTempWorkDir({ workDir, prefix }) {
  await ensureWorkDir(workDir);
  const dir = await fsp.mkdtemp(path.join(workDir, prefix));
  activeTempDirs.add(pathKey(dir));
  return dir;
}

export async function releaseTempWorkDir(dir) {
  activeTempDirs.delete(pathKey(dir));
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Limpieza de temporales
// ---------------------------------------------------------------------------

/**
 * Borra carpetas `autocut_*` de la carpeta de trabajo con más de `maxAgeMs` que no sean de un job en curso.
 */
export async function cleanupStaleTempDirs({
  workDir,
  maxAgeMs = STALE_TEMP_MAX_AGE_MS,
  now = Date.now(),
  isActive = isTempDirActive,
}) {
  let removed = 0;
  let bytes = 0;
  let entries;
  try {
    entries = await fsp.readdir(workDir, { withFileTypes: true });
  } catch {
    return { removed, bytes };
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.toLowerCase().startsWith(TEMP_DIR_PREFIX)) continue;
    const full = path.join(workDir, entry.name);
    if (isActive(full)) continue;
    let st;
    try {
      st = await fsp.stat(full);
    } catch {
      continue;
    }
    if (now - st.mtimeMs <= maxAgeMs) continue;
    const res = await removeWithSize(full);
    if (res.ok) {
      removed += 1;
      bytes += res.bytes;
    }
  }
  return { removed, bytes };
}

function assertWorkDirIsSafe(workDir, driveDir) {
  const resolved = path.resolve(workDir);
  if (path.parse(resolved).root === resolved) {
    throw new Error('La carpeta de trabajo es la raíz de una unidad: limpieza rechazada.');
  }
  if (driveDir) {
    const work = pathKey(resolved);
    const drive = pathKey(driveDir);
    if (work === drive || work.startsWith(drive + path.sep) || drive.startsWith(work + path.sep)) {
      throw new Error('La carpeta de trabajo se solapa con la carpeta de Drive: limpieza rechazada.');
    }
  }
}

/**
 * Scope "temp_pc": vacía la carpeta de trabajo salvo los jobs en curso.
 * Si la carpeta no es dedicada (os.tmpdir()), solo toca las carpetas `autocut_*`.
 */
export async function emptyWorkDir({ workDir, dedicated, driveDir, isActive = isTempDirActive }) {
  assertWorkDirIsSafe(workDir, driveDir);
  let removed = 0;
  let bytes = 0;
  let entries;
  try {
    entries = await fsp.readdir(workDir, { withFileTypes: true });
  } catch {
    return { archivos: 0, bytes: 0 };
  }
  for (const entry of entries) {
    if (!dedicated && !entry.name.toLowerCase().startsWith(TEMP_DIR_PREFIX)) continue;
    const full = path.join(workDir, entry.name);
    if (isActive(full)) continue;
    const res = await removeWithSize(full);
    if (res.ok) {
      removed += 1;
      bytes += res.bytes;
    }
  }
  return { archivos: removed, bytes };
}

/**
 * Scope "jobs_terminados": borra job_*.json y analyze_*.json en completed/analyzed/error con más de 7 días.
 */
export async function removeFinishedJobManifests({ jobsDir, now = Date.now() }) {
  let removed = 0;
  let bytes = 0;
  let entries;
  try {
    entries = await fsp.readdir(jobsDir, { withFileTypes: true });
  } catch {
    return { archivos: 0, bytes: 0 };
  }
  for (const entry of entries) {
    if (!entry.isFile() || !JOB_FILE_PATTERN.test(entry.name)) continue;
    const full = path.join(jobsDir, entry.name);
    const manifest = await readJsonSafe(full);
    if (!manifest || !TERMINAL_JOB_STATUSES.has(manifest.status)) continue;
    let st;
    try {
      st = await fsp.stat(full);
    } catch {
      continue;
    }
    const refMs = Date.parse(manifest.updatedAt || '') || Date.parse(manifest.finishedAt || '') || st.mtimeMs;
    if (now - refMs <= FINISHED_JOB_MAX_AGE_MS) continue;
    const res = await removeWithSize(full);
    if (res.ok) {
      removed += 1;
      bytes += res.bytes;
    }
  }
  return { archivos: removed, bytes };
}

// ---------------------------------------------------------------------------
// Brutos ya editados
// ---------------------------------------------------------------------------

function getBaseName(filename) {
  const dotIdx = filename.lastIndexOf('.');
  return dotIdx <= 0 ? filename : filename.slice(0, dotIdx);
}

function isVideoName(name) {
  return VIDEO_EXTENSIONS.has(path.extname(name).toLowerCase());
}

/**
 * Localiza los brutos de la carpeta raíz (sin subcarpetas) cuyo MP4 final ya existe en `_AutoCut_Output`.
 *
 * Fuente principal: job_*.json en "completed" cuyo outputFileName existe en `_AutoCut_Output`;
 * todos sus sourceFiles cuentan como editados (cubre Multi-Clip).
 * Respaldo: regla de la PWA (`{base}_EDITADO...` en `_AutoCut_Output`), solo si el nombre base es único en la raíz.
 * Nunca se incluye un bruto citado por un job que aún no ha terminado (pending/processing/...).
 */
export async function findEditedRawVideos({ driveDir }) {
  const jobsDir = path.join(driveDir, JOBS_DIR_NAME);
  const outputDir = path.join(driveDir, OUTPUT_DIR_NAME);

  let rootEntries = [];
  try {
    rootEntries = await fsp.readdir(driveDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const raws = rootEntries.filter(
    (e) => e.isFile() && isVideoName(e.name) && !e.name.toUpperCase().includes(EDITED_MARKER)
  );
  if (raws.length === 0) return [];

  let outputNames = [];
  try {
    outputNames = (await fsp.readdir(outputDir, { withFileTypes: true }))
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.mp4'))
      .map((e) => e.name);
  } catch {
    outputNames = [];
  }
  const outputLower = new Set(outputNames.map((n) => n.toLowerCase()));
  const outputUpper = outputNames.map((n) => n.toUpperCase());

  const primaryEdited = new Set();
  const inUse = new Set();
  let jobEntries = [];
  try {
    jobEntries = await fsp.readdir(jobsDir, { withFileTypes: true });
  } catch {
    jobEntries = [];
  }
  for (const entry of jobEntries) {
    if (!entry.isFile() || !JOB_FILE_PATTERN.test(entry.name)) continue;
    const manifest = await readJsonSafe(path.join(jobsDir, entry.name));
    if (!manifest) continue;
    const names = Array.isArray(manifest.sourceFiles)
      ? manifest.sourceFiles.map((s) => String(s?.name || '').toLowerCase()).filter(Boolean)
      : [];
    if (manifest.status === 'completed' && manifest.kind !== 'analyze') {
      const out = path.basename(String(manifest.outputFileName || '')).toLowerCase();
      if (out && outputLower.has(out)) {
        for (const n of names) primaryEdited.add(n);
      }
    } else if (manifest.status !== 'error') {
      for (const n of names) inUse.add(n);
    }
  }

  const baseCount = new Map();
  for (const raw of raws) {
    const key = getBaseName(raw.name).toUpperCase();
    baseCount.set(key, (baseCount.get(key) || 0) + 1);
  }

  const result = [];
  for (const raw of raws) {
    const lower = raw.name.toLowerCase();
    if (inUse.has(lower)) continue;
    let edited = primaryEdited.has(lower);
    if (!edited) {
      const baseUpper = getBaseName(raw.name).toUpperCase();
      if (baseCount.get(baseUpper) === 1) {
        const prefix = `${baseUpper}${EDITED_MARKER}`;
        edited = outputUpper.some((n) => n.startsWith(prefix));
      }
    }
    if (!edited) continue;
    const full = path.join(driveDir, raw.name);
    try {
      const st = await fsp.stat(full);
      result.push({ path: full, bytes: st.size });
    } catch {
      // desaparecido entre el listado y el stat
    }
  }
  return result;
}

/**
 * Scope "brutos_editados" (dryRun=false) y "preview_brutos_editados" (dryRun=true).
 * En G: el borrado va a la papelera de Google Drive (recuperable 30 días).
 */
export async function cleanEditedRawVideos({ driveDir, dryRun = false }) {
  const edited = await findEditedRawVideos({ driveDir });
  let archivos = 0;
  let bytes = 0;
  for (const item of edited) {
    if (dryRun) {
      archivos += 1;
      bytes += item.bytes;
      continue;
    }
    try {
      await fsp.rm(item.path, { force: true });
      archivos += 1;
      bytes += item.bytes;
    } catch {
      // archivo bloqueado: se queda
    }
  }
  return { archivos, bytes };
}

// ---------------------------------------------------------------------------
// Comandos de limpieza
// ---------------------------------------------------------------------------

/**
 * Ejecuta los scopes en orden fijo: preview_brutos_editados, brutos_editados, jobs_terminados, temp_pc.
 * (brutos_editados va antes que jobs_terminados porque necesita los job_*.json.)
 */
export async function executeCleanupScopes({
  scopes,
  driveDir,
  workDir,
  dedicated,
  now = Date.now(),
  isActive = isTempDirActive,
}) {
  const requested = new Set(Array.isArray(scopes) ? scopes : []);
  const jobsDir = path.join(driveDir, JOBS_DIR_NAME);
  const detalle = {};
  let liberadoBytes = 0;
  let failed = false;

  const handlers = {
    preview_brutos_editados: () => cleanEditedRawVideos({ driveDir, dryRun: true }),
    brutos_editados: () => cleanEditedRawVideos({ driveDir }),
    jobs_terminados: () => removeFinishedJobManifests({ jobsDir, now }),
    temp_pc: () => emptyWorkDir({ workDir, dedicated, driveDir, isActive }),
  };

  for (const scope of CLEANUP_SCOPES) {
    if (!requested.has(scope)) continue;
    try {
      const res = await handlers[scope]();
      detalle[scope] = { archivos: res.archivos, mb: toMB(res.bytes) };
      if (scope !== 'preview_brutos_editados') liberadoBytes += res.bytes;
    } catch (err) {
      failed = true;
      detalle[scope] = { error: String(err?.message || err).slice(0, 200) };
    }
  }

  const unknown = [...requested].filter((s) => !CLEANUP_SCOPES.includes(s));
  if (unknown.length > 0) {
    failed = true;
    detalle.scopes_desconocidos = unknown.map((s) => String(s).slice(0, 40));
  }
  if (requested.size === 0) {
    failed = true;
    detalle.error = 'El comando no incluye scopes.';
  }

  return { status: failed ? 'error' : 'done', liberadoMB: toMB(liberadoBytes), detalle };
}

/**
 * Procesa un cleanup_<id>.json en estado "pending" y reescribe el mismo archivo con el resultado.
 * Devuelve null si el archivo no estaba pendiente o no era legible.
 */
export async function processCleanupCommandFile(filePath, ctx) {
  const command = await readJsonSafe(filePath);
  if (!command || command.status !== 'pending') return null;

  const outcome = await executeCleanupScopes({ ...ctx, scopes: command.scopes });
  const next = {
    ...command,
    status: outcome.status,
    liberadoMB: outcome.liberadoMB,
    detalle: outcome.detalle,
    finishedAt: new Date().toISOString(),
  };
  await fsp.writeFile(filePath, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

export async function scanCleanupCommands({ commandsDir, ctx, inFlight = new Set() }) {
  let entries;
  try {
    entries = await fsp.readdir(commandsDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let processed = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !COMMAND_FILE_PATTERN.test(entry.name)) continue;
    const full = path.join(commandsDir, entry.name);
    if (inFlight.has(full)) continue;
    inFlight.add(full);
    try {
      const done = await processCleanupCommandFile(full, ctx);
      if (done) processed += 1;
    } catch {
      // se reintentará en el siguiente ciclo si sigue pendiente
    } finally {
      inFlight.delete(full);
    }
  }
  return processed;
}

// ---------------------------------------------------------------------------
// Almacenamiento (latido)
// ---------------------------------------------------------------------------

export function resolveHfHome(env = process.env) {
  const raw = String(env.HF_HOME || '').trim();
  return raw ? path.resolve(raw) : path.join(os.homedir(), '.cache', 'huggingface');
}

export async function collectStorageInfo({ workDir, dedicated, hfHome }) {
  let workBytes = 0;
  if (dedicated) {
    workBytes = await dirSizeBytes(workDir);
  } else {
    try {
      const entries = await fsp.readdir(workDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.toLowerCase().startsWith(TEMP_DIR_PREFIX)) {
          workBytes += await dirSizeBytes(path.join(workDir, entry.name));
        }
      }
    } catch {
      workBytes = 0;
    }
  }
  const hfBytes = await dirSizeBytes(hfHome);

  let freeGB = null;
  try {
    const target = await fsp.stat(workDir).then(() => workDir).catch(() => path.parse(workDir).root);
    const fsStat = await fsp.statfs(target);
    freeGB = Math.round(((fsStat.bavail * fsStat.bsize) / 1073741824) * 10) / 10;
  } catch {
    freeGB = null;
  }
  return { workDirMB: toMB(workBytes), hfCacheMB: toMB(hfBytes), freeGB };
}

/**
 * Calcula `storage` como mucho cada `ttlMs` (recorrer carpetas en cada latido sería caro).
 */
export function createStorageReporter({ workDir, dedicated, hfHome, ttlMs = 5 * 60 * 1000 }) {
  let cached = null;
  let cachedAt = 0;
  return {
    async get(now = Date.now()) {
      if (!cached || now - cachedAt > ttlMs) {
        cached = await collectStorageInfo({ workDir, dedicated, hfHome });
        cachedAt = now;
      }
      return cached;
    },
    invalidate() {
      cached = null;
    },
  };
}
