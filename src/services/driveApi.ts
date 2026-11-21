import type { DriveFileMeta } from '../types';

const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';

export class DriveAuthExpiredError extends Error {
  constructor(message = 'Tu sesión de Google Drive expiró. Vuelve a iniciar sesión.') {
    super(message);
    this.name = 'DriveAuthExpiredError';
  }
}

async function assertDriveOk(res: Response): Promise<void> {
  if (res.status === 401) {
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
    throw new Error(detail || `Error de Google Drive (${res.status})`);
  }
}

export async function listDriveFolderFiles(
  folderId: string,
  accessToken: string
): Promise<DriveFileMeta[]> {
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

  await assertDriveOk(res);
  const data = (await res.json()) as { files?: DriveFileMeta[] };
  return Array.isArray(data.files) ? data.files : [];
}

export async function downloadDriveVideo(
  fileId: string,
  accessToken: string,
  fallbackSizeBytes: number,
  onProgress?: (percent: number) => void
): Promise<Blob> {
  const url = `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?alt=media`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  await assertDriveOk(res);

  const totalBytes = Number(res.headers.get('content-length')) || fallbackSizeBytes || 0;
  if (!res.body) {
    const blob = await res.blob();
    onProgress?.(100);
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
  return new Blob(chunks as BlobPart[], { type: mimeType });
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

  await assertDriveOk(res);
  onProgress?.(100);
  return (await res.json()) as DriveUploadResult;
}
