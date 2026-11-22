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
    throw new Error(msg);
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
