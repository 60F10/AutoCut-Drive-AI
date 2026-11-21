import { useState } from 'react';
import { Download, Smartphone, WifiOff, X } from 'lucide-react';
import { useOnlineStatus, usePWAInstall } from '../hooks/usePWAInstall';

interface PWAInstallButtonProps {
  compact?: boolean;
}

export function PWAInstallButton({ compact = false }: PWAInstallButtonProps) {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showGuide, setShowGuide] = useState(false);

  if (isInstalled) {
    return null;
  }

  if (isInstallable) {
    return (
      <button
        type="button"
        onClick={install}
        className={`inline-flex items-center justify-center gap-2 rounded-lg border border-white/[0.12] bg-[#171B22] font-medium text-[#EDF1F7] hover:bg-[#1F2530] transition-colors whitespace-nowrap ${
          compact ? 'w-full px-3 py-2 text-xs' : 'h-9 px-3.5 text-xs'
        }`}
      >
        <Download className="h-3.5 w-3.5 text-[#F43F5E]" />
        Instalar app
      </button>
    );
  }

  if (isIOS) {
    return (
      <>
        <button
          type="button"
          onClick={() => setShowGuide(true)}
          className={`inline-flex items-center justify-center gap-2 rounded-lg border border-white/[0.12] bg-[#171B22] font-medium text-[#EDF1F7] hover:bg-[#1F2530] transition-colors whitespace-nowrap ${
            compact ? 'w-full px-3 py-2 text-xs' : 'h-9 px-3.5 text-xs'
          }`}
        >
          <Smartphone className="h-3.5 w-3.5 text-[#F43F5E]" />
          Añadir a inicio (iOS)
        </button>

        {showGuide && (
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="ios-pwa-guide-title"
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-[2px]"
          >
            <div className="w-full max-w-sm rounded-xl border border-white/[0.1] bg-[#111419] p-6">
              <div className="flex items-start justify-between gap-2">
                <h2
                  id="ios-pwa-guide-title"
                  className="font-display text-base font-semibold text-[#EDF1F7]"
                >
                  Instalar en iPhone / iPad
                </h2>
                <button
                  type="button"
                  onClick={() => setShowGuide(false)}
                  aria-label="Cerrar instrucciones de instalación"
                  className="rounded p-1 text-[#8B96A8] hover:bg-white/[0.06] hover:text-white"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <ol className="mt-3 space-y-2 text-xs text-[#A3AEBF] leading-relaxed list-decimal list-inside">
                <li>Pulsa el botón <strong>Compartir</strong> en la barra inferior de Safari.</li>
                <li>Desplázate y elige <strong>Añadir a pantalla de inicio</strong>.</li>
                <li>Abre AutoCut AI desde tu escritorio como app independiente.</li>
              </ol>
              <button
                type="button"
                onClick={() => setShowGuide(false)}
                className="mt-5 h-9 w-full rounded-lg bg-[#E11D48] text-xs font-medium text-white hover:bg-[#BE123C] transition-colors"
              >
                Entendido
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  return null;
}

export function OfflineIndicator() {
  const isOnline = useOnlineStatus();
  if (isOnline) return null;

  return (
    <div
      role="status"
      className="fixed bottom-4 left-4 z-40 flex items-center gap-2 rounded-lg border border-[#F59E0B]/40 bg-[#1B160C] px-3.5 py-2 text-xs font-medium text-[#FCD34D] shadow-lg"
    >
      <WifiOff className="h-3.5 w-3.5 shrink-0" />
      <span>Sin conexión — el análisis con Gemini y Drive requieren red</span>
    </div>
  );
}
