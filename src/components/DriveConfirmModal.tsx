import { CloudUpload, X } from 'lucide-react';
import type { PendingDriveUpload } from '../types';
import { formatBytes } from '../utils/videoPipeline';

interface DriveConfirmModalProps {
  pendingUpload: PendingDriveUpload | null;
  onConfirm: () => void;
  onCancel: () => void;
  isUploading: boolean;
}

export function DriveConfirmModal({
  pendingUpload,
  onConfirm,
  onCancel,
  isUploading,
}: DriveConfirmModalProps) {
  if (!pendingUpload) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="drive-upload-confirm-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[#05060a]/85 backdrop-blur-md pt-safe-modal"
    >
      <div className="w-full max-w-md rounded-lg cyber-panel p-6 shadow-[0_0_40px_rgba(0,240,255,0.14)]">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <CloudUpload className="h-5 w-5 text-[#00f0ff] shrink-0" />
            <h2
              id="drive-upload-confirm-title"
              className="font-display text-base font-semibold text-[#EEF5FF]"
            >
              Confirmar subida a Google Drive
            </h2>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={isUploading}
            aria-label="Cerrar confirmación"
            className="flex h-9 w-9 items-center justify-center rounded-md border border-[#00f0ff]/20 text-[#94A3B8] hover:border-[#00f0ff]/55 hover:bg-[#00f0ff]/10 hover:text-[#00f0ff] transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <p className="mt-3 text-sm text-[#94A3B8] leading-relaxed">
          Se creará un nuevo archivo editado en tu carpeta de Google Drive sin modificar ni eliminar el vídeo original.
        </p>

        <div className="mt-4 rounded-md border border-[#00f0ff]/20 bg-[#05060a] p-3.5 space-y-2 text-xs">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[#7D8EA8]">Archivo final</span>
            <span className="font-mono text-[#00f0ff] truncate max-w-[230px]">
              {pendingUpload.fileName}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-[#7D8EA8]">Carpeta destino</span>
            <span className="font-mono text-[#CFE2FF] truncate max-w-[230px]">
              {pendingUpload.folderId || 'Sin configurar'}
            </span>
          </div>
          {pendingUpload.sizeBytes > 0 && (
            <div className="flex items-center justify-between gap-3">
              <span className="text-[#7D8EA8]">Tamaño</span>
              <span className="font-mono tabular-nums text-[#fcee0a]">
                {formatBytes(pendingUpload.sizeBytes)}
              </span>
            </div>
          )}
        </div>

        <div className="mt-6 flex items-center justify-end gap-2.5">
          <button
            type="button"
            onClick={onCancel}
            disabled={isUploading}
            className="h-10 rounded-md border border-[#00f0ff]/25 px-4 text-xs font-medium text-[#CFE2FF] hover:border-[#00f0ff]/60 hover:bg-[#00f0ff]/10 transition-colors whitespace-nowrap"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isUploading || !pendingUpload.folderId}
            className="h-10 cyber-btn-primary px-5 text-xs disabled:opacity-45 whitespace-nowrap"
          >
            {isUploading ? 'Subiendo...' : 'Confirmar subida'}
          </button>
        </div>
      </div>
    </div>
  );
}
