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
        className={`inline-flex items-center justify-center gap-2 rounded-md border border-[#00f0ff]/30 bg-[#05060a] font-medium text-[#EEF5FF] hover:border-[#00f0ff] hover:bg-[#00f0ff]/10 transition-colors whitespace-nowrap ${
          compact ? 'w-full min-h-[40px] px-3 py-2 text-xs' : 'h-10 px-3.5 text-xs'
        }`}
      >
        <Download className="h-3.5 w-3.5 text-[#00f0ff]" />
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
          className={`inline-flex items-center justify-center gap-2 rounded-md border border-[#00f0ff]/30 bg-[#05060a] font-medium text-[#EEF5FF] hover:border-[#00f0ff] hover:bg-[#00f0ff]/10 transition-colors whitespace-nowrap ${
            compact ? 'w-full min-h-[40px] px-3 py-2 text-xs' : 'h-10 px-3.5 text-xs'
          }`}
        >
          <Smartphone className="h-3.5 w-3.5 text-[#00f0ff]" />
          Añadir a inicio (iOS)
        </button>

        {showGuide && (
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="ios-pwa-guide-title"
            className="fixed inset-0 z-50 flex items-center justify-center bg-[#05060a]/85 p-4 backdrop-blur-md pt-safe-modal"
          >
            <div className="w-full max-w-sm rounded-lg cyber-panel p-6 shadow-[0_0_40px_rgba(0,240,255,0.14)]">
              <div className="flex items-start justify-between gap-2">
                <h2
                  id="ios-pwa-guide-title"
                  className="font-display text-base font-semibold text-[#EEF5FF]"
                >
                  Instalar en iPhone / iPad
                </h2>
                <button
                  type="button"
                  onClick={() => setShowGuide(false)}
                  aria-label="Cerrar instrucciones de instalación"
                  className="flex h-9 w-9 items-center justify-center rounded-md border border-[#00f0ff]/20 text-[#94A3B8] hover:border-[#00f0ff]/55 hover:bg-[#00f0ff]/10 hover:text-[#00f0ff]"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <ol className="mt-3 space-y-2 text-xs text-[#94A3B8] leading-relaxed list-decimal list-inside">
                <li>
                  Pulsa el botón <strong className="text-[#EEF5FF]">Compartir</strong> en la barra inferior de Safari.
                </li>
                <li>
                  Desplázate y elige <strong className="text-[#EEF5FF]">Añadir a pantalla de inicio</strong>.
                </li>
                <li>Abre AutoCut AI desde tu escritorio como app independiente.</li>
              </ol>
              <button
                type="button"
                onClick={() => setShowGuide(false)}
                className="mt-5 h-10 w-full cyber-btn-primary text-xs"
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
      className="fixed bottom-[calc(4.9rem+env(safe-area-inset-bottom,0px))] md:bottom-4 left-4 right-4 sm:right-auto z-40 flex items-center gap-2 rounded-md border border-[#fcee0a]/50 bg-[#141309]/95 px-3.5 py-2.5 text-xs font-medium text-[#fcee0a] shadow-[0_0_20px_rgba(252,238,10,0.18)] backdrop-blur-md"
    >
      <WifiOff className="h-3.5 w-3.5 shrink-0" />
      <span>Sin conexión — el análisis con Gemini y Drive requieren red</span>
    </div>
  );
}
