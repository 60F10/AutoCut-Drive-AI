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
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-[2px]"
    >
      <div className="w-full max-w-md rounded-xl border border-white/[0.1] bg-[#111419] p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <CloudUpload className="h-5 w-5 text-[#38BDF8] shrink-0" />
            <h2
              id="drive-upload-confirm-title"
              className="font-display text-base font-semibold text-[#EDF1F7]"
            >
              Confirmar subida a Google Drive
            </h2>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={isUploading}
            aria-label="Cerrar confirmación"
            className="rounded-md p-1 text-[#8B96A8] hover:bg-white/[0.06] hover:text-white transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <p className="mt-3 text-sm text-[#A3AEBF] leading-relaxed">
          Se creará un nuevo archivo editado en tu carpeta de Google Drive sin modificar ni eliminar el vídeo original.
        </p>

        <div className="mt-4 rounded-lg border border-white/[0.08] bg-[#0B0E12] p-3.5 space-y-2 text-xs">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[#8B96A8]">Archivo final</span>
            <span className="font-mono text-[#EDF1F7] truncate max-w-[240px]">
              {pendingUpload.fileName}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-[#8B96A8]">Carpeta destino</span>
            <span className="font-mono text-[#C8D0DC] truncate max-w-[240px]">
              {pendingUpload.folderId || 'Sin configurar'}
            </span>
          </div>
          {pendingUpload.sizeBytes > 0 && (
            <div className="flex items-center justify-between gap-3">
              <span className="text-[#8B96A8]">Tamaño</span>
              <span className="font-mono tabular-nums text-[#C8D0DC]">
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
            className="h-9 rounded-lg border border-white/[0.1] px-4 text-xs font-medium text-[#C8D0DC] hover:bg-white/[0.05] transition-colors whitespace-nowrap"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isUploading || !pendingUpload.folderId}
            className="h-9 rounded-lg bg-[#E11D48] px-4 text-xs font-medium text-white hover:bg-[#BE123C] disabled:opacity-45 transition-colors whitespace-nowrap"
          >
            {isUploading ? 'Subiendo...' : 'Confirmar subida'}
          </button>
        </div>
      </div>
    </div>
  );
}
