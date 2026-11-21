export type GeminiModelId = 'gemini-2.5-flash' | 'gemini-2.5-pro';

export type WatchIntervalSec = 30 | 60 | 300;

export type ActiveView = 'queue' | 'studio' | 'settings';

export type QueueStage =
  | 'pending'
  | 'downloading'
  | 'analyzing'
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
  start_sec: number;
  end_sec: number;
  motivo: string;
  enabled: boolean;
}

export interface GeminiEditPlan {
  etiqueta: string;
  titulo_interno: string;
  duracion_objetivo_seg: number;
  cortes: VideoCut[];
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
  outputFileName?: string;
  uploadedDriveId?: string;
  uploadedWebViewLink?: string;
  geminiFileCleaned?: boolean;
  analysis?: GeminiEditPlan;
  lastUpdated: number;
}

export interface PendingDriveUpload {
  itemId: string;
  fileName: string;
  folderId: string;
  sizeBytes: number;
}
