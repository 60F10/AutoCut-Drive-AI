import type { DriveFileMeta, GeminiEditPlan, VideoCut } from '../types';

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm']);
const EDITED_MARKER = '_EDITADO';

/**
 * Extracts a Google Drive folder ID from either a raw ID or a full Drive folder URL.
 */
export function extractDriveFolderId(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';

  const folderPathMatch = trimmed.match(/\/folders\/([a-zA-Z0-9_-]{8,})/);
  if (folderPathMatch?.[1]) {
    return folderPathMatch[1];
  }

  const queryIdMatch = trimmed.match(/[?&]id=([a-zA-Z0-9_-]{8,})/);
  if (queryIdMatch?.[1]) {
    return queryIdMatch[1];
  }

  // Strip stray trailing slashes or query params if someone pasted an ID with whitespace
  return trimmed.replace(/^\/+|\/+$/g, '');
}

export function getExtension(filename: string): string {
  const dotIdx = filename.lastIndexOf('.');
  if (dotIdx <= 0) return '';
  return filename.slice(dotIdx).toLowerCase();
}

export function getBaseName(filename: string): string {
  const dotIdx = filename.lastIndexOf('.');
  if (dotIdx <= 0) return filename;
  return filename.slice(0, dotIdx);
}

export function isSupportedVideoFile(name: string, mimeType?: string): boolean {
  const ext = getExtension(name);
  if (VIDEO_EXTENSIONS.has(ext)) return true;
  if (mimeType) {
    const normalized = mimeType.toLowerCase();
    return (
      normalized === 'video/mp4' ||
      normalized === 'video/quicktime' ||
      normalized === 'video/webm'
    );
  }
  return false;
}

/**
 * Sanitizes Gemini's `etiqueta` to 1 uppercase word without accents or special characters.
 */
export function sanitizeEtiqueta(raw: string): string {
  const withoutDiacritics = raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .trim();

  const firstToken = withoutDiacritics.split(/[^A-Z0-9]+/).find(Boolean);
  return firstToken || 'VIDEO';
}

export function buildEditedFilename(originalName: string, etiqueta: string): string {
  const baseName = getBaseName(originalName).trim();
  const safeTag = sanitizeEtiqueta(etiqueta);
  return `${baseName}${EDITED_MARKER}_${safeTag}.mp4`;
}

export interface FolderScanResult {
  pending: DriveFileMeta[];
  alreadyEditedSources: DriveFileMeta[];
  editedOutputs: DriveFileMeta[];
}

/**
 * Filters raw videos from a Drive folder, preventing infinite processing loops by checking
 * whether any file in the same folder already starts with `{nombreBase}_EDITADO`.
 */
export function detectPendingVideos(files: DriveFileMeta[]): FolderScanResult {
  const videoFiles = files.filter((file) => isSupportedVideoFile(file.name, file.mimeType));
  const editedOutputs: DriveFileMeta[] = [];
  const rawCandidates: DriveFileMeta[] = [];

  for (const file of videoFiles) {
    if (file.name.toUpperCase().includes(EDITED_MARKER)) {
      editedOutputs.push(file);
    } else {
      rawCandidates.push(file);
    }
  }

  const allUpperNames = files.map((f) => f.name.toUpperCase());
  const pending: DriveFileMeta[] = [];
  const alreadyEditedSources: DriveFileMeta[] = [];

  for (const raw of rawCandidates) {
    const expectedPrefix = `${getBaseName(raw.name).toUpperCase()}${EDITED_MARKER}`;
    const hasEditedVersion = allUpperNames.some((name) => name.startsWith(expectedPrefix));
    if (hasEditedVersion) {
      alreadyEditedSources.push(raw);
    } else {
      pending.push(raw);
    }
  }

  return { pending, alreadyEditedSources, editedOutputs };
}

/**
 * Validates, sorts, and removes invalid/overlapping ranges from Gemini cuts.
 */
export function normalizeCuts(
  cuts: Array<{ start_sec: number; end_sec: number; motivo: string; enabled?: boolean; id?: string }>,
  maxDurationSec?: number
): VideoCut[] {
  const cleaned = cuts
    .map((cut, index) => {
      const start = Math.max(0, Number(cut.start_sec) || 0);
      let end = Math.max(0, Number(cut.end_sec) || 0);
      if (maxDurationSec && maxDurationSec > 0) {
        end = Math.min(end, maxDurationSec);
      }
      return {
        id: cut.id ?? `cut-${index + 1}`,
        start_sec: Number(start.toFixed(2)),
        end_sec: Number(end.toFixed(2)),
        motivo: String(cut.motivo || 'Momento destacado').trim(),
        enabled: cut.enabled !== false,
      };
    })
    .filter((cut) => cut.end_sec - cut.start_sec >= 0.15)
    .sort((a, b) => a.start_sec - b.start_sec);

  // Clamp tiny overlaps cleanly so jump cuts never duplicate frames
  const nonOverlapping: VideoCut[] = [];
  for (const cut of cleaned) {
    const prev = nonOverlapping[nonOverlapping.length - 1];
    if (prev && cut.start_sec < prev.end_sec) {
      const adjustedStart = Number(prev.end_sec.toFixed(2));
      if (cut.end_sec - adjustedStart >= 0.15) {
        nonOverlapping.push({ ...cut, start_sec: adjustedStart });
      }
    } else {
      nonOverlapping.push(cut);
    }
  }

  return nonOverlapping;
}

export function parseGeminiEditPlan(raw: unknown, maxDurationSec?: number): GeminiEditPlan {
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('La respuesta de Gemini no tiene un formato JSON válido.');
  }

  const obj = parsed as Record<string, unknown>;
  const rawCuts = Array.isArray(obj.cortes) ? obj.cortes : [];
  const cuts = normalizeCuts(
    rawCuts as Array<{ start_sec: number; end_sec: number; motivo: string }>,
    maxDurationSec
  );

  if (cuts.length === 0) {
    throw new Error('Gemini no devolvió ningún corte válido para renderizar.');
  }

  const totalSelected = calculateSelectedDuration(cuts);
  const targetDuration = Number(obj.duracion_objetivo_seg);

  return {
    etiqueta: sanitizeEtiqueta(String(obj.etiqueta || 'VIDEO')),
    titulo_interno: String(obj.titulo_interno || 'Resumen dinámico editado').trim(),
    duracion_objetivo_seg:
      Number.isFinite(targetDuration) && targetDuration > 0
        ? Math.round(targetDuration)
        : Math.round(totalSelected),
    cortes: cuts,
  };
}

export function calculateSelectedDuration(cuts: VideoCut[]): number {
  const total = cuts.reduce((sum, cut) => {
    if (!cut.enabled) return sum;
    return sum + Math.max(0, cut.end_sec - cut.start_sec);
  }, 0);
  return Number(total.toFixed(2));
}

export interface FfmpegFilterBuild {
  filterComplex: string;
  args: string[];
  activeCount: number;
}

/**
 * Generates FFmpeg filter_complex with trim/atrim, setpts/asetpts, and concat=n=X:v=1:a=1
 * preserving vertical 9:16 orientation and encoding to H.264 + AAC MP4.
 */
export function buildFfmpegFilterComplex(
  cuts: VideoCut[],
  inputFileName = 'input.mp4',
  outputFileName = 'output.mp4',
  hasAudio = true
): FfmpegFilterBuild {
  const activeCuts = cuts
    .filter((cut) => cut.enabled && cut.end_sec > cut.start_sec)
    .sort((a, b) => a.start_sec - b.start_sec);

  if (activeCuts.length === 0) {
    throw new Error('Activa al menos un corte antes de renderizar el vídeo.');
  }

  const filterParts: string[] = [];
  const concatInputs: string[] = [];

  activeCuts.forEach((cut, idx) => {
    const start = cut.start_sec.toFixed(3);
    const end = cut.end_sec.toFixed(3);
    filterParts.push(`[0:v]trim=start=${start}:end=${end},setpts=PTS-STARTPTS[v${idx}]`);
    if (hasAudio) {
      filterParts.push(`[0:a]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS[a${idx}]`);
      concatInputs.push(`[v${idx}][a${idx}]`);
    } else {
      concatInputs.push(`[v${idx}]`);
    }
  });

  if (hasAudio) {
    filterParts.push(`${concatInputs.join('')}concat=n=${activeCuts.length}:v=1:a=1[outv][outa]`);
  } else {
    filterParts.push(`${concatInputs.join('')}concat=n=${activeCuts.length}:v=1:a=0[outv]`);
  }

  const filterComplex = filterParts.join(';');

  const args = [
    '-i',
    inputFileName,
    '-filter_complex',
    filterComplex,
    '-map',
    '[outv]',
    ...(hasAudio ? ['-map', '[outa]'] : ['-an']),
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '23',
    '-pix_fmt',
    'yuv420p',
    ...(hasAudio ? ['-c:a', 'aac', '-b:a', '128k'] : []),
    '-movflags',
    '+faststart',
    outputFileName,
  ];

  return {
    filterComplex,
    args,
    activeCount: activeCuts.length,
  };
}

export function formatSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00.0';
  const totalTenths = Math.round(seconds * 10);
  const mins = Math.floor(totalTenths / 600);
  const wholeSecs = Math.floor((totalTenths % 600) / 10);
  const tenths = totalTenths % 10;
  return `${mins}:${String(wholeSecs).padStart(2, '0')}.${tenths}`;
}

export function formatBytes(bytes?: number | string): string {
  const num = typeof bytes === 'string' ? Number(bytes) : bytes ?? 0;
  if (!Number.isFinite(num) || num <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let idx = 0;
  let value = num;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value.toFixed(value >= 100 || idx === 0 ? 0 : 1)} ${units[idx]}`;
}
