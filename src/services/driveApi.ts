import type { DriveFileMeta } from '../types';
import { logError, logInfo } from './debugLogger';

const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';

export class DriveAuthExpiredError extends Error {
  constructor(message = 'Tu sesión de Google Drive expiró. Vuelve a iniciar sesión.') {
    super(message);
    this.name = 'DriveAuthExpiredError';
  }
}

export class DriveHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'DriveHttpError';
    this.status = status;
  }
}

async function assertDriveOk(res: Response, operation: string): Promise<void> {
  if (res.status === 401) {
    logError('Drive', `${operation}: sesión expirada`, { http: 401 });
    throw new DriveAuthExpiredError();
  }
  if (!res.ok) {
    let detail = '';
    try {
      const json = await res.json();
      detail = json?.error?.message || '';
    } catch {
      detail = await res.text().catch(() => '');
    }
    const msg = detail || `Error de Google Drive (${res.status})`;
    logError('Drive', `${operation}: error HTTP`, { http: res.status, detalle: msg });
    throw new DriveHttpError(res.status, msg);
  }
}

export async function listDriveFolderFiles(
  folderId: string,
  accessToken: string
): Promise<DriveFileMeta[]> {
  const t0 = performance.now();
  const safeFolderId = folderId.replace(/'/g, "\\'");
  const query = encodeURIComponent(`'${safeFolderId}' in parents and trashed = false`);
  const fields = encodeURIComponent(
    'files(id,name,mimeType,size,modifiedTime,webViewLink,thumbnailLink)'
  );
  const url = `${DRIVE_API_BASE}/files?q=${query}&fields=${fields}&pageSize=100&orderBy=modifiedTime desc`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  await assertDriveOk(res, 'Listar carpeta');
  const data = (await res.json()) as { files?: DriveFileMeta[] };
  const files = Array.isArray(data.files) ? data.files : [];
  logInfo('Drive', 'Carpeta listada correctamente', {
    archivos: files.length,
    http: res.status,
    ms: Math.round(performance.now() - t0),
  });
  return files;
}

export async function downloadDriveVideo(
  fileId: string,
  accessToken: string,
  fallbackSizeBytes: number,
  onProgress?: (percent: number) => void
): Promise<Blob> {
  const t0 = performance.now();
  const url = `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?alt=media`;
  logInfo('Drive', 'Iniciando descarga de vídeo bruto', {
    estimadoMB: Number((fallbackSizeBytes / (1024 * 1024)).toFixed(2)),
  });

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  await assertDriveOk(res, 'Descargar vídeo');

  const totalBytes = Number(res.headers.get('content-length')) || fallbackSizeBytes || 0;
  if (!res.body) {
    const blob = await res.blob();
    onProgress?.(100);
    logInfo('Drive', 'Descarga completada', {
      pesoMB: Number((blob.size / (1024 * 1024)).toFixed(2)),
      ms: Math.round(performance.now() - t0),
    });
    return blob;
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      received += value.byteLength;
      if (totalBytes > 0) {
        onProgress?.(Math.min(99, Math.round((received / totalBytes) * 100)));
      }
    }
  }

  onProgress?.(100);
  const mimeType = res.headers.get('content-type') || 'video/mp4';
  const blob = new Blob(chunks as BlobPart[], { type: mimeType });
  logInfo('Drive', 'Descarga completada', {
    pesoMB: Number((blob.size / (1024 * 1024)).toFixed(2)),
    ms: Math.round(performance.now() - t0),
  });
  return blob;
}

export interface DriveUploadResult {
  id: string;
  name: string;
  webViewLink?: string;
  size?: string;
}

/**
 * Uploads the rendered MP4 video to the target Google Drive folder using multipart upload.
 */
export async function uploadEditedVideoMultipart(
  folderId: string,
  fileName: string,
  videoBlob: Blob,
  accessToken: string,
  onProgress?: (percent: number) => void
): Promise<DriveUploadResult> {
  const t0 = performance.now();
  logInfo('Drive', 'Subiendo vídeo editado a Drive', {
    archivo: fileName,
    pesoMB: Number((videoBlob.size / (1024 * 1024)).toFixed(2)),
  });
  onProgress?.(12);

  const boundary = `autocut_boundary_${Date.now()}`;
  const metadata = {
    name: fileName,
    parents: [folderId],
    mimeType: 'video/mp4',
  };

  const metadataPart =
    `--${boundary}\r\n` +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    'Content-Type: video/mp4\r\n\r\n';

  const closingPart = `\r\n--${boundary}--`;
  const multipartBody = new Blob([metadataPart, videoBlob, closingPart], {
    type: `multipart/related; boundary=${boundary}`,
  });

  onProgress?.(35);

  const url = `${DRIVE_UPLOAD_BASE}/files?uploadType=multipart&fields=id,name,webViewLink,size`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body: multipartBody,
  });

  await assertDriveOk(res, 'Subir vídeo editado');
  onProgress?.(100);
  const result = (await res.json()) as DriveUploadResult;
  logInfo('Drive', 'Vídeo subido a Drive correctamente', {
    archivo: result.name,
    http: res.status,
    ms: Math.round(performance.now() - t0),
  });
  return result;
}

const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';
export const PC_JOBS_SUBFOLDER = '_AutoCut_Jobs';
export const PC_OUTPUT_SUBFOLDER = '_AutoCut_Output';
export const PC_SOURCES_SUBFOLDER = '_sources';
export const PC_WORKER_STATUS_FILENAME = '_worker_status.json';
export const DRIVE_RESUMABLE_CHUNK_BYTES = 8 * 1024 * 1024; // 8 MB chunks (multiple of 256 KB)

function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * Finds a direct subfolder by exact name inside `parentFolderId`, returning its ID or null.
 */
export async function findDriveSubfolder(
  parentFolderId: string,
  folderName: string,
  accessToken: string
): Promise<string | null> {
  const safeParent = escapeDriveQueryValue(parentFolderId);
  const safeName = escapeDriveQueryValue(folderName);
  const query = encodeURIComponent(
    `'${safeParent}' in parents and name = '${safeName}' and mimeType = '${DRIVE_FOLDER_MIME}' and trashed = false`
  );
  const url = `${DRIVE_API_BASE}/files?q=${query}&fields=files(id,name)&pageSize=5`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });
  await assertDriveOk(res, `Buscar subcarpeta ${folderName}`);
  const data = (await res.json()) as { files?: Array<{ id: string; name: string }> };
  return data.files?.[0]?.id ?? null;
}

/**
 * Finds or creates a direct subfolder inside `parentFolderId`.
 */
export async function ensureDriveSubfolder(
  parentFolderId: string,
  folderName: string,
  accessToken: string
): Promise<string> {
  const existingId = await findDriveSubfolder(parentFolderId, folderName, accessToken);
  if (existingId) return existingId;

  const res = await fetch(`${DRIVE_API_BASE}/files?fields=id,name`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
    },
    body: JSON.stringify({
      name: folderName,
      mimeType: DRIVE_FOLDER_MIME,
      parents: [parentFolderId],
    }),
  });
  await assertDriveOk(res, `Crear subcarpeta ${folderName}`);
  const created = (await res.json()) as { id: string; name: string };
  logInfo('Drive', `Subcarpeta ${folderName} creada en Drive`, { carpeta: folderName });
  return created.id;
}

/**
 * Ensures both `_AutoCut_Jobs` and `_AutoCut_Output` subfolders exist inside the configured Drive folder.
 */
export async function ensurePcRenderFolders(
  rootFolderId: string,
  accessToken: string
): Promise<{ jobsFolderId: string; outputFolderId: string }> {
  const [jobsFolderId, outputFolderId] = await Promise.all([
    ensureDriveSubfolder(rootFolderId, PC_JOBS_SUBFOLDER, accessToken),
    ensureDriveSubfolder(rootFolderId, PC_OUTPUT_SUBFOLDER, accessToken),
  ]);
  return { jobsFolderId, outputFolderId };
}

/**
 * Uploads `job_<jobId>.json` into `_AutoCut_Jobs` inside the configured Google Drive folder.
 */
export async function uploadRenderJobManifest(
  rootFolderId: string,
  manifest: import('../types').RenderJobManifest,
  accessToken: string
): Promise<DriveUploadResult> {
  const t0 = performance.now();
  const { jobsFolderId } = await ensurePcRenderFolders(rootFolderId, accessToken);
  const fileName = `job_${manifest.jobId}.json`;
  const jsonContent = JSON.stringify(manifest, null, 2);

  const boundary = `autocut_job_${Date.now()}`;
  const metadata = {
    name: fileName,
    parents: [jobsFolderId],
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

  const url = `${DRIVE_UPLOAD_BASE}/files?uploadType=multipart&fields=id,name,webViewLink,size`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body: multipartBody,
  });

  await assertDriveOk(res, 'Subir manifiesto de render');
  const result = (await res.json()) as DriveUploadResult;
  logInfo(manifest.target === 'cloud' ? 'Nube' : 'PC', 'Manifiesto de render subido a _AutoCut_Jobs', {
    jobId: manifest.jobId,
    destino: manifest.target || 'pc',
    clips: manifest.sourceFiles.length,
    cortes: manifest.cuts.length,
    calidad: manifest.options.quality,
    ms: Math.round(performance.now() - t0),
  });
  return result;
}

/**
 * Uploads `analyze_<jobId>.json` (`kind: "analyze"`) into `_AutoCut_Jobs` inside the configured Drive folder.
 */
export async function uploadAnalyzeJobManifest(
  rootFolderId: string,
  manifest: import('../types').AnalyzeJobManifest,
  accessToken: string
): Promise<DriveUploadResult> {
  const t0 = performance.now();
  const { jobsFolderId } = await ensurePcRenderFolders(rootFolderId, accessToken);
  const fileName = `analyze_${manifest.jobId}.json`;
  const jsonContent = JSON.stringify(manifest, null, 2);

  const boundary = `autocut_analyze_${Date.now()}`;
  const metadata = {
    name: fileName,
    parents: [jobsFolderId],
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

  const url = `${DRIVE_UPLOAD_BASE}/files?uploadType=multipart&fields=id,name,webViewLink,size`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body: multipartBody,
  });

  await assertDriveOk(res, 'Subir manifiesto de análisis');
  const result = (await res.json()) as DriveUploadResult;
  logInfo(manifest.target === 'pc' ? 'PC' : 'Nube', 'Manifiesto de análisis subido a _AutoCut_Jobs', {
    jobId: manifest.jobId,
    destino: manifest.target || 'cloud',
    clips: manifest.sourceFiles.length,
    whisperModel: manifest.options.whisperModel || 'small',
    ms: Math.round(performance.now() - t0),
  });
  return result;
}

/**
 * Updates an existing JSON file in Google Drive (e.g. changing a pending PC job's target to "cloud").
 */
export async function patchDriveJsonFile(
  fileId: string,
  payload: unknown,
  accessToken: string
): Promise<void> {
  const url = `${DRIVE_UPLOAD_BASE}/files/${encodeURIComponent(fileId)}?uploadType=media`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
    },
    body: JSON.stringify(payload, null, 2),
  });
  await assertDriveOk(res, 'Actualizar manifiesto en Drive');
}

/**
 * Ensures `_AutoCut_Jobs/_sources/` exists for temporary uploads of local clips before cloud rendering.
 */
export async function ensureCloudSourcesSubfolder(
  rootFolderId: string,
  accessToken: string
): Promise<string> {
  const { jobsFolderId } = await ensurePcRenderFolders(rootFolderId, accessToken);
  return ensureDriveSubfolder(jobsFolderId, PC_SOURCES_SUBFOLDER, accessToken);
}

/**
 * Uploads a local video Blob into `_AutoCut_Jobs/_sources/` via Google Drive resumable upload
 * in 8 MB chunks so large phone recordings upload reliably with real progress feedback.
 */
export async function uploadSourceVideoResumable8MB(
  sourcesFolderId: string,
  fileName: string,
  videoBlob: Blob,
  accessToken: string,
  onProgress?: (percent: number) => void
): Promise<DriveUploadResult> {
  const t0 = performance.now();
  const totalBytes = videoBlob.size;
  const mimeType = videoBlob.type || 'video/mp4';

  logInfo('Nube', 'Iniciando subida resumable de clip local a _sources/', {
    pesoMB: Number((totalBytes / (1024 * 1024)).toFixed(2)),
    chunkMB: 8,
  });

  const initRes = await fetch(
    `${DRIVE_UPLOAD_BASE}/files?uploadType=resumable&fields=id,name,webViewLink,size`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': mimeType,
        'X-Upload-Content-Length': String(totalBytes),
      },
      body: JSON.stringify({
        name: fileName,
        parents: [sourcesFolderId],
        mimeType,
      }),
    }
  );
  await assertDriveOk(initRes, 'Iniciar subida resumable (_sources)');

  const uploadUrl = initRes.headers.get('location');
  if (!uploadUrl) {
    throw new Error('Google Drive no devolvió la URL de subida resumable.');
  }

  let offset = 0;
  let uploaded: DriveUploadResult | null = null;
  onProgress?.(2);

  while (offset < totalBytes) {
    const endExclusive = Math.min(totalBytes, offset + DRIVE_RESUMABLE_CHUNK_BYTES);
    const chunk = videoBlob.slice(offset, endExclusive);
    const rangeEnd = endExclusive - 1;

    const putRes = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': mimeType,
        'Content-Range': `bytes ${offset}-${rangeEnd}/${totalBytes}`,
      },
      body: chunk,
    });

    if (putRes.status === 308) {
      offset = endExclusive;
      onProgress?.(Math.min(98, Math.round((offset / totalBytes) * 100)));
      continue;
    }

    await assertDriveOk(putRes, 'Subir bloque de vídeo (_sources)');
    uploaded = (await putRes.json()) as DriveUploadResult;
    offset = totalBytes;
    onProgress?.(100);
    break;
  }

  if (!uploaded?.id) {
    throw new Error('No se recibió el ID del archivo tras completar la subida resumable.');
  }

  logInfo('Nube', 'Clip local subido a _sources/ correctamente', {
    pesoMB: Number((totalBytes / (1024 * 1024)).toFixed(2)),
    ms: Math.round(performance.now() - t0),
  });
  return uploaded;
}

/**
 * Deletes a temporary file from Drive (used strictly to clean up PWA-uploaded `_sources/` files).
 */
export async function deleteDriveFile(fileId: string, accessToken: string): Promise<void> {
  const res = await fetch(`${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });
  if (res.status === 404) return; // Already cleaned up
  await assertDriveOk(res, 'Limpiar temporal de _sources');
}

/**
 * Dispatches the GitHub Actions cloud render workflow via the backend proxy (`/api/cloud-render/dispatch`).
 */
export async function dispatchCloudRenderJob(jobFileId: string): Promise<{ ok: true }> {
  const t0 = performance.now();
  const res = await fetch('/api/cloud-render/dispatch', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ jobFileId }),
  });

  if (res.status === 202 || res.ok) {
    logInfo('Nube', 'Workflow de GitHub Actions disparado', {
      http: res.status,
      ms: Math.round(performance.now() - t0),
    });
    return { ok: true };
  }

  let message = `No se pudo disparar el render en la nube (HTTP ${res.status}).`;
  try {
    const json = (await res.json()) as { error?: string };
    if (json?.error) message = json.error;
  } catch {
    // keep default
  }

  logError('Nube', 'Fallo al disparar GitHub Actions', {
    http: res.status,
    detalle: message,
  });
  throw new Error(message);
}

/**
 * Checks GitHub Actions run status for a dispatched cloud job via `/api/cloud-render/status`.
 */
export async function fetchCloudWorkflowStatus(
  jobFileId: string
): Promise<import('../types').CloudWorkflowRunStatus> {
  const t0 = performance.now();
  const res = await fetch(
    `/api/cloud-render/status?jobFileId=${encodeURIComponent(jobFileId)}`,
    {
      method: 'GET',
      credentials: 'same-origin',
    }
  );

  if (!res.ok) {
    let message = `No se pudo consultar el estado del workflow (HTTP ${res.status}).`;
    try {
      const json = (await res.json()) as { error?: string };
      if (json?.error) message = json.error;
    } catch {
      // keep default
    }
    logError('Nube', 'Error al comprobar estado de workflow en GitHub Actions', {
      http: res.status,
      detalle: message,
      ms: Math.round(performance.now() - t0),
    });
    throw new Error(message);
  }

  const data = (await res.json()) as Partial<import('../types').CloudWorkflowRunStatus>;
  const result: import('../types').CloudWorkflowRunStatus = {
    status: typeof data?.status === 'string' ? data.status : null,
    conclusion: typeof data?.conclusion === 'string' ? data.conclusion : null,
    htmlUrl: typeof data?.htmlUrl === 'string' ? data.htmlUrl : null,
  };

  logInfo('Nube', 'Estado de workflow comprobado en GitHub Actions', {
    status: result.status ?? 'no_encontrado',
    conclusion: result.conclusion ?? 'pendiente',
    http: res.status,
    ms: Math.round(performance.now() - t0),
  });

  return result;
}

export interface PcRenderDriveSnapshot {
  jobs: import('../types').PcJobSyncEntry[];
  analyzeJobs: import('../types').AnalyzeJobSyncEntry[];
  outputs: DriveFileMeta[];
  pcWorkerStatus: import('../types').PcWorkerStatus | null;
  jobsFolderId: string | null;
  outputFolderId: string | null;
}

/**
 * Reads `job_*.json`, `analyze_*.json`, and `_worker_status.json` from `_AutoCut_Jobs`
 * and lists rendered `.mp4` files in `_AutoCut_Output`.
 */
export async function listPcRenderJobsAndOutputs(
  rootFolderId: string,
  accessToken: string
): Promise<PcRenderDriveSnapshot> {
  const t0 = performance.now();
  const [jobsFolderId, outputFolderId] = await Promise.all([
    findDriveSubfolder(rootFolderId, PC_JOBS_SUBFOLDER, accessToken),
    findDriveSubfolder(rootFolderId, PC_OUTPUT_SUBFOLDER, accessToken),
  ]);

  if (!jobsFolderId && !outputFolderId) {
    return {
      jobs: [],
      analyzeJobs: [],
      outputs: [],
      pcWorkerStatus: null,
      jobsFolderId: null,
      outputFolderId: null,
    };
  }

  const [jobFiles, outputFiles] = await Promise.all([
    jobsFolderId ? listDriveFolderFiles(jobsFolderId, accessToken) : Promise.resolve([]),
    outputFolderId ? listDriveFolderFiles(outputFolderId, accessToken) : Promise.resolve([]),
  ]);

  const outputs = outputFiles.filter((f) => f.name.toLowerCase().endsWith('.mp4'));
  const outputByLowerName = new Map<string, DriveFileMeta>();
  for (const out of outputs) {
    outputByLowerName.set(out.name.toLowerCase(), out);
  }

  const renderManifestFiles = jobFiles
    .filter((f) => /^job_.*\.json$/i.test(f.name))
    .slice(0, 25);

  const analyzeManifestFiles = jobFiles
    .filter((f) => /^analyze_.*\.json$/i.test(f.name))
    .slice(0, 25);

  const workerStatusFile = jobFiles.find(
    (f) => f.name.toLowerCase() === PC_WORKER_STATUS_FILENAME
  );

  const jobs: import('../types').PcJobSyncEntry[] = [];
  const analyzeJobs: import('../types').AnalyzeJobSyncEntry[] = [];

  const workerStatusPromise: Promise<import('../types').PcWorkerStatus | null> = workerStatusFile
    ? (async () => {
        try {
          const res = await fetch(
            `${DRIVE_API_BASE}/files/${encodeURIComponent(workerStatusFile.id)}?alt=media`,
            {
              headers: {
                Authorization: `Bearer ${accessToken}`,
              },
            }
          );
          if (!res.ok) return null;
          const parsed = (await res.json()) as Partial<import('../types').PcWorkerStatus>;
          if (parsed && typeof parsed === 'object' && typeof parsed.lastSeen === 'string') {
            return {
              lastSeen: parsed.lastSeen,
              version: typeof parsed.version === 'string' ? parsed.version : undefined,
              encoder: typeof parsed.encoder === 'string' ? parsed.encoder : undefined,
              whisperDevice:
                typeof parsed.whisperDevice === 'string' ? parsed.whisperDevice : undefined,
              whisperModel:
                typeof parsed.whisperModel === 'string' ? parsed.whisperModel : undefined,
              busy: typeof parsed.busy === 'boolean' ? parsed.busy : undefined,
            };
          }
          return null;
        } catch {
          // Ignore temporarily half-synced _worker_status.json
          return null;
        }
      })()
    : Promise.resolve(null);

  const [pcWorkerStatus] = await Promise.all([
    workerStatusPromise,
    ...renderManifestFiles.map(async (file) => {
      try {
        const res = await fetch(
          `${DRIVE_API_BASE}/files/${encodeURIComponent(file.id)}?alt=media`,
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
            },
          }
        );
        if (!res.ok) return;
        const parsed = (await res.json()) as import('../types').RenderJobManifest;
        if (!parsed || typeof parsed !== 'object' || !parsed.jobId || !parsed.status) return;
        if ((parsed as { kind?: string }).kind === 'analyze') return;

        const matchedOutput =
          (parsed.outputFileName
            ? outputByLowerName.get(parsed.outputFileName.toLowerCase())
            : undefined) ||
          (parsed.outputDriveId
            ? {
                id: parsed.outputDriveId,
                name: parsed.outputFileName || `AutoCut_${parsed.jobId}.mp4`,
                webViewLink: parsed.outputWebViewLink,
              }
            : undefined);

        jobs.push({
          manifest: parsed,
          jobFileId: file.id,
          jobFileName: file.name,
          modifiedTime: file.modifiedTime,
          outputFile: matchedOutput,
        });
      } catch {
        // Ignore temporarily half-synced or unreadable JSON files
      }
    }),
    ...analyzeManifestFiles.map(async (file) => {
      try {
        const res = await fetch(
          `${DRIVE_API_BASE}/files/${encodeURIComponent(file.id)}?alt=media`,
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
            },
          }
        );
        if (!res.ok) return;
        const parsed = (await res.json()) as import('../types').AnalyzeJobManifest;
        if (
          !parsed ||
          typeof parsed !== 'object' ||
          parsed.kind !== 'analyze' ||
          !parsed.jobId ||
          !parsed.status
        ) {
          return;
        }

        analyzeJobs.push({
          manifest: parsed,
          jobFileId: file.id,
          jobFileName: file.name,
          modifiedTime: file.modifiedTime,
        });
      } catch {
        // Ignore temporarily half-synced or unreadable JSON files
      }
    }),
  ]);

  jobs.sort((a, b) => {
    const aMs = Date.parse(a.manifest.updatedAt || a.manifest.createdAt || a.modifiedTime || '') || 0;
    const bMs = Date.parse(b.manifest.updatedAt || b.manifest.createdAt || b.modifiedTime || '') || 0;
    return bMs - aMs;
  });

  analyzeJobs.sort((a, b) => {
    const aMs = Date.parse(a.manifest.updatedAt || a.manifest.createdAt || a.modifiedTime || '') || 0;
    const bMs = Date.parse(b.manifest.updatedAt || b.manifest.createdAt || b.modifiedTime || '') || 0;
    return bMs - aMs;
  });

  logInfo('Drive', 'Estado de trabajos remotos sincronizado', {
    renders: jobs.length,
    analisis: analyzeJobs.length,
    completados: jobs.filter((j) => j.manifest.status === 'completed').length,
    outputsMp4: outputs.length,
    pcHeartbeat: Boolean(pcWorkerStatus?.lastSeen),
    ms: Math.round(performance.now() - t0),
  });

  return { jobs, analyzeJobs, outputs, pcWorkerStatus, jobsFolderId, outputFolderId };
}

export const STYLES_ROOT_SUBFOLDER = '_AutoCut_Styles';
export const STYLES_SUBTITLES_SUBFOLDER = 'subtitulos';
export const STYLES_FONTS_SUBFOLDER = 'fonts';

export interface DriveSubtitleStylesSnapshot {
  profiles: import('../types').SubtitleStyleProfile[];
  fileIdByProfileId: Record<string, string>;
  fonts: string[];
}

/**
 * Ensures `<root>/_AutoCut_Styles/subtitulos` exists and returns its Drive folder ID.
 */
export async function ensureSubtitleStylesSubfolder(
  rootFolderId: string,
  accessToken: string
): Promise<string> {
  const stylesRootId = await ensureDriveSubfolder(rootFolderId, STYLES_ROOT_SUBFOLDER, accessToken);
  return ensureDriveSubfolder(stylesRootId, STYLES_SUBTITLES_SUBFOLDER, accessToken);
}

/**
 * Lists custom subtitle style JSON files in `<root>/_AutoCut_Styles/subtitulos/`
 * and available `.ttf`/`.otf` font files in `<root>/_AutoCut_Styles/fonts/`.
 */
export async function listDriveSubtitleStylesAndFonts(
  rootFolderId: string,
  accessToken: string
): Promise<DriveSubtitleStylesSnapshot> {
  const stylesRootId = await findDriveSubfolder(rootFolderId, STYLES_ROOT_SUBFOLDER, accessToken);
  if (!stylesRootId) {
    return { profiles: [], fileIdByProfileId: {}, fonts: [] };
  }

  const [subtitulosFolderId, fontsFolderId] = await Promise.all([
    findDriveSubfolder(stylesRootId, STYLES_SUBTITLES_SUBFOLDER, accessToken),
    findDriveSubfolder(stylesRootId, STYLES_FONTS_SUBFOLDER, accessToken),
  ]);

  const [styleFiles, fontFiles] = await Promise.all([
    subtitulosFolderId ? listDriveFolderFiles(subtitulosFolderId, accessToken) : Promise.resolve([]),
    fontsFolderId ? listDriveFolderFiles(fontsFolderId, accessToken) : Promise.resolve([]),
  ]);

  const jsonFiles = styleFiles.filter((f) => /\.json$/i.test(f.name)).slice(0, 50);
  const profiles: import('../types').SubtitleStyleProfile[] = [];
  const fileIdByProfileId: Record<string, string> = {};

  await Promise.all(
    jsonFiles.map(async (file) => {
      try {
        const res = await fetch(
          `${DRIVE_API_BASE}/files/${encodeURIComponent(file.id)}?alt=media`,
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
            },
          }
        );
        if (!res.ok) return;
        const parsed = (await res.json()) as import('../types').SubtitleStyleProfile;
        if (!parsed || typeof parsed !== 'object' || !parsed.id || !parsed.nombre) return;
        profiles.push(parsed);
        fileIdByProfileId[parsed.id] = file.id;
      } catch {
        // Ignore unreadable or partially synced style JSON files
      }
    })
  );

  const fonts = fontFiles
    .map((f) => f.name)
    .filter((name) => /\.(ttf|otf)$/i.test(name))
    .sort((a, b) => a.localeCompare(b));

  return { profiles, fileIdByProfileId, fonts };
}

/**
 * Creates or updates `<root>/_AutoCut_Styles/subtitulos/<id>.json` in Google Drive.
 */
export async function saveDriveSubtitleStyle(
  rootFolderId: string,
  profile: import('../types').SubtitleStyleProfile,
  accessToken: string,
  existingFileId?: string
): Promise<{ fileId: string }> {
  if (existingFileId) {
    await patchDriveJsonFile(existingFileId, profile, accessToken);
    logInfo('Drive', 'Perfil de subtítulos actualizado en Drive', { id: profile.id });
    return { fileId: existingFileId };
  }

  const subtitulosFolderId = await ensureSubtitleStylesSubfolder(rootFolderId, accessToken);
  const fileName = `${profile.id}.json`;

  // Check if a file with the same name already exists in the folder to avoid duplicates
  const existingFiles = await listDriveFolderFiles(subtitulosFolderId, accessToken);
  const existingByName = existingFiles.find(
    (f) => f.name.toLowerCase() === fileName.toLowerCase()
  );
  if (existingByName) {
    await patchDriveJsonFile(existingByName.id, profile, accessToken);
    logInfo('Drive', 'Perfil de subtítulos sobrescrito en Drive', { id: profile.id });
    return { fileId: existingByName.id };
  }

  const boundary = `autocut_style_${Date.now()}`;
  const metadata = {
    name: fileName,
    parents: [subtitulosFolderId],
    mimeType: 'application/json',
  };
  const jsonContent = JSON.stringify(profile, null, 2);

  const multipartBody =
    `--${boundary}\r\n` +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    `${jsonContent}\r\n` +
    `--${boundary}--`;

  const url = `${DRIVE_UPLOAD_BASE}/files?uploadType=multipart&fields=id,name`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body: multipartBody,
  });

  await assertDriveOk(res, 'Guardar perfil de subtítulos en Drive');
  const created = (await res.json()) as { id: string; name: string };
  logInfo('Drive', 'Perfil de subtítulos guardado en Drive', { id: profile.id });
  return { fileId: created.id };
}

/**
 * Deletes a custom subtitle style JSON file from `<root>/_AutoCut_Styles/subtitulos/`.
 */
export async function deleteDriveSubtitleStyle(
  fileId: string,
  accessToken: string
): Promise<void> {
  await deleteDriveFile(fileId, accessToken);
  logInfo('Drive', 'Perfil de subtítulos eliminado de Drive');
}

