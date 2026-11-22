export type GeminiModelId = string;

export interface AppErrorBanner {
  message: string;
  technicalDetail?: string;
  actionHint?: 'settings';
}

export type WatchIntervalSec = 30 | 60 | 300;

export type ActiveView = 'queue' | 'gallery' | 'studio' | 'settings';

export type EditStylePreset = 'funny_jumpcut' | 'agile_vlog' | 'express_summary';

export type ExportQuality = 'mobile_fast' | 'high_1080p';

export type FramingMode = 'center_crop' | 'blur_pad';

export interface TikTokEditOptions {
  subtitlesEnabled: boolean;
  silenceTrimEnabled: boolean;
  audioNormalizeEnabled: boolean;
  framingMode: FramingMode;
}

export type QueueStage =
  | 'pending'
  | 'downloading'
  | 'analyzing'
  | 'review'
  | 'rendering'
  | 'uploading'
  | 'completed'
  | 'error';

export interface AppSettings {
  folderId: string;
  model: GeminiModelId;
  watchIntervalSec: WatchIntervalSec;
  autoWatchEnabled: boolean;
  autoUploadEnabled: boolean;
  exportQuality: ExportQuality;
}

export interface DriveFileMeta {
  id: string;
  name: string;
  mimeType?: string;
  size?: string;
  modifiedTime?: string;
  webViewLink?: string;
  thumbnailLink?: string;
}

export interface VideoCut {
  id: string;
  clip_index: number;
  start_sec: number;
  end_sec: number;
  motivo: string;
  puntuacion_interes?: number;
  enabled: boolean;
}

export interface SubtitleBlock {
  id: string;
  clip_index: number;
  start_sec: number;
  end_sec: number;
  text: string;
}

export interface GeminiEditPlan {
  etiqueta: string;
  titulo_interno: string;
  duracion_objetivo_seg: number;
  cortes: VideoCut[];
  subtitulos?: SubtitleBlock[];
}

export interface SourceClipRef {
  id: string;
  source: 'drive' | 'local' | 'demo';
  driveFileId?: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  durationSec?: number;
  rawBlob?: Blob;
  rawUrl?: string;
}

export interface QueueItem {
  id: string;
  source: 'drive' | 'local' | 'demo';
  driveFileId?: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  modifiedTime?: string;
  durationSec?: number;
  stage: QueueStage;
  stageDetail?: string;
  progress: number;
  errorMessage?: string;
  rawBlob?: Blob;
  rawUrl?: string;
  editedBlob?: Blob;
  editedUrl?: string;
  editedSizeBytes?: number;
  cachedInIndexedDb?: boolean;
  outputFileName?: string;
  uploadedDriveId?: string;
  uploadedWebViewLink?: string;
  geminiFileCleaned?: boolean;
  analysis?: GeminiEditPlan;
  stylePreset?: EditStylePreset;
  customInstruction?: string;
  exportQuality?: ExportQuality;
  tiktokOptions?: TikTokEditOptions;
  isMultiClip?: boolean;
  projectName?: string;
  sourceClips?: SourceClipRef[];
  completedAt?: number;
  lastUpdated: number;
}

export interface PendingDriveUpload {
  itemId: string;
  fileName: string;
  folderId: string;
  sizeBytes: number;
}

export interface AnalyticsRecord {
  id: string;
  dateKey: string; // YYYY-MM-DD
  processedAt: number;
  etiqueta: string;
  rawDurationSec: number;
  editedDurationSec: number;
  isMultiClip?: boolean;
  clipCount?: number;
}
