import { useEffect, useRef, useState } from 'react';
import { Check, ClipboardCopy, FileText, X } from 'lucide-react';
import { copyTextWithFallback } from '../services/debugLogger';

interface DiagnosticCopyModalProps {
  open: boolean;
  reportText: string;
  onClose: () => void;
}

export function DiagnosticCopyModal({
  open,
  reportText,
  onClose,
}: DiagnosticCopyModalProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [copiedNotice, setCopiedNotice] = useState(false);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.select();
        el.setSelectionRange(0, reportText.length);
      }
    }, 60);
    return () => window.clearTimeout(timer);
  }, [open, reportText]);

  if (!open) return null;

  const handleSelectAll = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    el.select();
    el.setSelectionRange(0, reportText.length);
  };

  const handleRetryCopy = async () => {
    const res = await copyTextWithFallback(reportText);
    if (res.ok) {
      setCopiedNotice(true);
      window.setTimeout(() => setCopiedNotice(false), 2000);
    } else {
      handleSelectAll();
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="diagnostic-copy-modal-title"
      data-testid="diagnostic-copy-modal"
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-[#05060a]/85 backdrop-blur-md pt-safe-modal"
    >
      <div className="w-full max-w-2xl rounded-t-2xl sm:rounded-lg cyber-panel shadow-[0_0_40px_rgba(0,240,255,0.16)] overflow-hidden pb-safe">
        <div className="flex items-start justify-between gap-3 p-5 border-b border-[#00f0ff]/20 bg-[#05060a]/75">
          <div className="flex items-center gap-2.5">
            <FileText className="h-5 w-5 text-[#00f0ff] shrink-0" />
            <div>
              <h2
                id="diagnostic-copy-modal-title"
                className="font-display text-base font-semibold text-[#EEF5FF]"
              >
                Copiar informe manualmente
              </h2>
              <p className="text-xs text-[#94A8C4]">
                Tu navegador bloqueó el portapapeles automático. El texto ya está seleccionado para copiarlo.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar informe de diagnóstico"
            className="flex h-10 w-10 items-center justify-center rounded-md border border-[#00f0ff]/20 text-[#94A8C4] hover:border-[#00f0ff]/55 hover:text-[#00f0ff] shrink-0"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-5 space-y-3">
          <textarea
            ref={textareaRef}
            readOnly
            value={reportText}
            rows={12}
            data-testid="diagnostic-copy-textarea"
            aria-label="Informe de diagnóstico completo"
            onClick={handleSelectAll}
            className="w-full rounded-md border border-[#00f0ff]/30 bg-[#05060a] p-3 font-mono text-[11px] leading-relaxed text-[#CFE2FF] focus:border-[#00f0ff] focus:outline-none"
          />
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2.5 px-5 py-4 border-t border-[#00f0ff]/20 bg-[#05060a]/85">
          <button
            type="button"
            onClick={handleSelectAll}
            className="h-10 rounded-md border border-[#00f0ff]/30 px-3.5 text-xs font-medium text-[#CFE2FF] hover:border-[#00f0ff]/65 hover:text-white transition-colors"
          >
            Seleccionar todo
          </button>
          <button
            type="button"
            onClick={handleRetryCopy}
            className="cyber-btn-primary inline-flex h-10 items-center gap-1.5 px-4 text-xs"
          >
            {copiedNotice ? (
              <>
                <Check className="h-3.5 w-3.5" />
                ¡Copiado!
              </>
            ) : (
              <>
                <ClipboardCopy className="h-3.5 w-3.5" />
                Copiar ahora
              </>
            )}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="h-10 rounded-md border border-[#00f0ff]/20 px-3.5 text-xs font-medium text-[#8EA2BD] hover:text-white transition-colors"
          >
            Cerrar
          </button>
        </div>
      </div>
    </div>
  );
}
