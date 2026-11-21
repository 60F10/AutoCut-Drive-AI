import { useEffect, useState } from 'react';
import { Check, Folder, HardDrive, RotateCcw, Save, ShieldCheck, Trash2, Zap } from 'lucide-react';
import type { User } from 'firebase/auth';
import type { AppSettings, ExportQuality, GeminiModelId, WatchIntervalSec } from '../types';
import type { VideoCacheStats } from '../services/videoStorage';
import { extractDriveFolderId, formatBytes } from '../utils/videoPipeline';
import { GoogleSignInButton } from './GoogleSignInButton';

interface SettingsViewProps {
  settings: AppSettings;
  onSaveSettings: (next: AppSettings) => void;
  onResetSettings: () => void;
  user: User | null;
  isLoggingIn: boolean;
  onGoogleLogin: () => void;
  onGoogleLogout: () => void;
  geminiConfigured: boolean;
  cacheStats: VideoCacheStats;
  isClearingCache: boolean;
  onClearVideoCache: () => void;
}

export function SettingsView({
  settings,
  onSaveSettings,
  onResetSettings,
  user,
  isLoggingIn,
  onGoogleLogin,
  onGoogleLogout,
  geminiConfigured,
  cacheStats,
  isClearingCache,
  onClearVideoCache,
}: SettingsViewProps) {
  const [folderInput, setFolderInput] = useState(settings.folderId);
  const [model, setModel] = useState<GeminiModelId>(settings.model);
  const [watchIntervalSec, setWatchIntervalSec] = useState<WatchIntervalSec>(
    settings.watchIntervalSec
  );
  const [autoWatchEnabled, setAutoWatchEnabled] = useState(settings.autoWatchEnabled);
  const [autoUploadEnabled, setAutoUploadEnabled] = useState(settings.autoUploadEnabled);
  const [exportQuality, setExportQuality] = useState<ExportQuality>(settings.exportQuality);
  const [savedBanner, setSavedBanner] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    setFolderInput(settings.folderId);
    setModel(settings.model);
    setWatchIntervalSec(settings.watchIntervalSec);
    setAutoWatchEnabled(settings.autoWatchEnabled);
    setAutoUploadEnabled(settings.autoUploadEnabled);
    setExportQuality(settings.exportQuality);
  }, [settings]);

  const parsedFolderId = extractDriveFolderId(folderInput);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setValidationError(null);

    if (autoWatchEnabled && !parsedFolderId) {
      setValidationError(
        'Introduce un ID o enlace de carpeta de Google Drive antes de activar la vigilancia automática.'
      );
      return;
    }

    onSaveSettings({
      folderId: parsedFolderId,
      model,
      watchIntervalSec,
      autoWatchEnabled,
      autoUploadEnabled,
      exportQuality,
    });
    setFolderInput(parsedFolderId);
    setSavedBanner(true);
    window.setTimeout(() => setSavedBanner(false), 3000);
  };

  return (
    <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
      <form
        onSubmit={handleSubmit}
        className="xl:col-span-7 rounded-xl border border-white/10 bg-[#121216] divide-y divide-white/10 overflow-hidden"
      >
        {/* Section 1: Google Drive Folder */}
        <div className="p-6 space-y-4">
          <div>
            <h2 className="font-display text-base font-semibold text-[#EDF1F7]">
              Carpeta vigilada de Google Drive
            </h2>
            <p className="mt-1 text-xs text-[#8B96A8] leading-relaxed">
              Pega el ID de tu carpeta o la URL completa de Google Drive. La app ignorará cualquier archivo con <span className="font-mono text-[#C8D0DC]">_EDITADO</span> para evitar bucles infinitos.
            </p>
          </div>

          <div className="space-y-2">
            <label
              htmlFor="drive-folder-id"
              className="block text-xs font-medium text-[#C8D0DC]"
            >
              ID o enlace de carpeta de Google Drive
            </label>
            <div className="relative">
              <Folder
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#687487]"
                aria-hidden="true"
              />
              <input
                id="drive-folder-id"
                type="text"
                value={folderInput}
                onChange={(e) => {
                  setFolderInput(e.target.value);
                  setValidationError(null);
                }}
                placeholder="Ej: 1A2B3C4D5E6F7G8H9I0J o https://drive.google.com/drive/folders/..."
                className="h-10 w-full rounded-lg border border-white/[0.1] bg-[#0B0E12] pl-9 pr-3 font-mono text-xs text-[#EDF1F7] placeholder:text-[#5C6778] focus:border-[#E11D48] focus:outline-none"
              />
            </div>

            {folderInput.trim() && parsedFolderId !== folderInput.trim() && (
              <p className="text-xs text-[#10B981]">
                ID detectado automáticamente:{' '}
                <span className="font-mono font-medium">{parsedFolderId}</span>
              </p>
            )}
          </div>
        </div>

        {/* Section 2: Gemini Model */}
        <div className="p-6 space-y-4">
          <div>
            <h2 className="font-display text-base font-semibold text-[#EDF1F7]">
              Modelo de análisis Gemini
            </h2>
            <p className="mt-1 text-xs text-[#8B96A8]">
              El vídeo se sube mediante Gemini Files API (resumable upload) y se elimina automáticamente al terminar el análisis.
            </p>
          </div>

          <div
            role="radiogroup"
            aria-label="Seleccionar modelo de Gemini"
            className="grid grid-cols-1 sm:grid-cols-2 gap-3"
          >
            {(
              [
                {
                  id: 'gemini-2.5-flash',
                  title: 'gemini-2.5-flash',
                  desc: 'Por defecto · Rápido e ideal para clips cortos y vlogs diarios.',
                },
                {
                  id: 'gemini-2.5-pro',
                  title: 'gemini-2.5-pro',
                  desc: 'Mayor precisión narrativa en brutos largos de 3 a 10 minutos.',
                },
              ] as Array<{ id: GeminiModelId; title: string; desc: string }>
            ).map((option) => {
              const selected = model === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => setModel(option.id)}
                  className={`rounded-lg border p-4 text-left transition-colors ${
                    selected
                      ? 'border-[#E11D48] bg-[#E11D48]/[0.08]'
                      : 'border-white/10 bg-[#09090b] hover:border-white/20'
                  }`}
                >
                  <p className="font-mono text-xs font-semibold text-[#EDF1F7]">{option.title}</p>
                  <p className="mt-1.5 text-xs text-[#8B96A8] leading-relaxed">{option.desc}</p>
                </button>
              );
            })}
          </div>
        </div>

        {/* Section 2.5: FFmpeg.wasm Render Quality / Mobile Performance Mode */}
        <div className="p-6 space-y-4">
          <div className="flex items-start gap-2.5">
            <Zap className="h-4 w-4 text-[#F43F5E] shrink-0 mt-0.5" aria-hidden="true" />
            <div>
              <h2 className="font-display text-base font-semibold text-[#EDF1F7]">
                Modo de renderizado FFmpeg.wasm
              </h2>
              <p className="mt-1 text-xs text-[#8B96A8] leading-relaxed">
                El modo rápido móvil (720p) reduce el uso de RAM y acelera el exportado ~3× en Safari iOS y Android.
              </p>
            </div>
          </div>

          <div
            role="radiogroup"
            aria-label="Modo de renderizado de vídeo"
            className="grid grid-cols-1 sm:grid-cols-2 gap-3"
          >
            {(
              [
                {
                  id: 'mobile_fast',
                  title: 'Rápido móvil — 720p',
                  specs: '720×1280 · 30fps · ultrafast · CRF 26',
                  desc: 'Recomendado en iPhone y Android. Exportado mucho más rápido y menos memoria.',
                },
                {
                  id: 'high_1080p',
                  title: 'Máxima calidad — 1080p',
                  specs: '1080×1920 · 30fps · veryfast · CRF 21',
                  desc: 'Máxima nitidez vertical para escritorio o clips cortos con buena RAM disponible.',
                },
              ] as Array<{ id: ExportQuality; title: string; specs: string; desc: string }>
            ).map((option) => {
              const selected = exportQuality === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  data-testid={`settings-quality-${option.id}`}
                  onClick={() => setExportQuality(option.id)}
                  className={`rounded-lg border p-4 text-left transition-colors ${
                    selected
                      ? 'border-[#E11D48] bg-[#E11D48]/[0.08]'
                      : 'border-white/10 bg-[#09090b] hover:border-white/20'
                  }`}
                >
                  <p className="text-xs font-semibold text-[#EDF1F7]">{option.title}</p>
                  <p className="mt-1 font-mono text-[11px] text-[#F43F5E]">{option.specs}</p>
                  <p className="mt-1.5 text-xs text-[#8B96A8] leading-relaxed">{option.desc}</p>
                </button>
              );
            })}
          </div>
        </div>

        {/* Section 3: Watch Mode & Interval */}
        <div className="p-6 space-y-5">
          <div>
            <h2 className="font-display text-base font-semibold text-[#EDF1F7]">
              Vigilancia automática y subida
            </h2>
            <p className="mt-1 text-xs text-[#8B96A8]">
              Escanea la carpeta automáticamente mientras esta pestaña permanezca abierta.
            </p>
          </div>

          <div className="space-y-2">
            <label className="block text-xs font-medium text-[#C8D0DC]">
              Intervalo de vigilancia
            </label>
            <div className="inline-flex items-center gap-1 rounded-lg border border-white/[0.08] bg-[#0B0E12] p-1">
              {(
                [
                  { value: 30, label: '30s' },
                  { value: 60, label: '60s' },
                  { value: 300, label: '5min' },
                ] as Array<{ value: WatchIntervalSec; label: string }>
              ).map((opt) => {
                const active = watchIntervalSec === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setWatchIntervalSec(opt.value)}
                    aria-pressed={active}
                    className={`rounded-md px-4 py-1.5 font-mono text-xs font-medium transition-colors whitespace-nowrap ${
                      active
                        ? 'bg-[#1D232E] text-white'
                        : 'text-[#8B96A8] hover:text-[#EDF1F7]'
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-3 pt-1">
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={autoWatchEnabled}
                onChange={(e) => setAutoWatchEnabled(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-white/25 bg-[#0B0E12] accent-[#E11D48]"
              />
              <span>
                <span className="block text-sm font-medium text-[#EDF1F7]">
                  Activar Modo Vigilancia Automática
                </span>
                <span className="block text-xs text-[#8B96A8]">
                  Busca nuevos vídeos brutos en la carpeta según el intervalo elegido y los añade a la cola.
                </span>
              </span>
            </label>

            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={autoUploadEnabled}
                onChange={(e) => setAutoUploadEnabled(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-white/25 bg-[#0B0E12] accent-[#E11D48]"
              />
              <span>
                <span className="block text-sm font-medium text-[#EDF1F7]">
                  Solicitar subida a Google Drive al terminar el render
                </span>
                <span className="block text-xs text-[#8B96A8]">
                  Al finalizar FFmpeg.wasm te pedirá confirmación antes de guardar el archivo <span className="font-mono">_EDITADO_ETIQUETA.mp4</span> en tu carpeta.
                </span>
              </span>
            </label>
          </div>
        </div>

        {/* Form Footer */}
        <div className="p-6 flex flex-wrap items-center justify-between gap-3 bg-[#0e0e12]">
          <div className="min-w-0">
            {validationError ? (
              <p className="text-xs text-[#F87171]">{validationError}</p>
            ) : savedBanner ? (
              <p className="inline-flex items-center gap-1.5 text-xs text-[#10B981]">
                <Check className="h-3.5 w-3.5" />
                Ajustes guardados en este navegador
              </p>
            ) : (
              <p className="text-xs text-[#687487]">
                Preferencias guardadas localmente en localStorage.
              </p>
            )}
          </div>

          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={onResetSettings}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-white/10 px-3 text-xs font-medium text-[#8B96A8] hover:bg-white/[0.04] hover:text-white transition-colors whitespace-nowrap"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Restablecer
            </button>
            <button
              type="submit"
              className="inline-flex h-9 items-center gap-2 rounded-lg bg-[#E11D48] px-4 text-xs font-medium text-white hover:bg-[#BE123C] transition-colors whitespace-nowrap"
            >
              <Save className="h-3.5 w-3.5" />
              Guardar ajustes
            </button>
          </div>
        </div>
      </form>

      {/* Right column: Connections, IndexedDB Cache & Quick Folder Guide */}
      <div className="xl:col-span-5 space-y-5">
        <section className="rounded-xl border border-white/10 bg-[#121216] p-6 space-y-4">
          <div className="flex items-start gap-3">
            <ShieldCheck className="h-5 w-5 text-[#10B981] shrink-0 mt-0.5" />
            <div className="space-y-1">
              <h2 className="font-display text-base font-semibold text-[#EDF1F7]">
                Conexiones y seguridad
              </h2>
              <p className="text-xs text-[#8B96A8] leading-relaxed">
                Las llamadas a Gemini se ejecutan en el servidor usando la clave del entorno ({geminiConfigured ? 'Gemini disponible' : 'pendiente en Secrets'}). Tu token de Google Drive se guarda solo en memoria mientras la pestaña está abierta.
              </p>
            </div>
          </div>

          <div className="space-y-3 pt-3 border-t border-white/10">
            <div className="text-xs">
              <p className="font-medium text-[#EDF1F7]">Cuenta de Google Drive</p>
              <p className="mt-0.5 text-[#8B96A8]">
                {user ? `Conectada como ${user.email}` : 'No conectada todavía'}
              </p>
            </div>

            {user ? (
              <button
                type="button"
                onClick={onGoogleLogout}
                className="h-9 w-full rounded-lg border border-white/10 px-3 text-xs font-medium text-[#EDF1F7] hover:bg-white/[0.05] transition-colors"
              >
                Desconectar Google Drive
              </button>
            ) : (
              <GoogleSignInButton onClick={onGoogleLogin} loading={isLoggingIn} />
            )}
          </div>
        </section>

        {/* IndexedDB Local Video Cache */}
        <section
          data-testid="video-cache-card"
          className="rounded-xl border border-white/10 bg-[#121216] p-6 space-y-4"
        >
          <div className="flex items-start gap-3">
            <HardDrive className="h-5 w-5 text-[#38BDF8] shrink-0 mt-0.5" />
            <div className="space-y-1">
              <h2 className="font-display text-base font-semibold text-[#EDF1F7]">
                Caché local de vídeos (IndexedDB)
              </h2>
              <p className="text-xs text-[#8B96A8] leading-relaxed">
                Los últimos {cacheStats.maxItems} MP4 renderizados se guardan en tu dispositivo para reproducirlos y descargarlos incluso tras recargar la app. Los más antiguos se limpian automáticamente sin borrar los metadatos ni tus enlaces de Drive.
              </p>
            </div>
          </div>

          <div className="flex items-center justify-between rounded-lg border border-white/10 bg-[#09090b] px-4 py-3 text-xs">
            <span className="text-[#8B96A8]">Espacio usado</span>
            <span
              data-testid="video-cache-stats"
              className="font-mono font-medium tabular-nums text-[#EDF1F7]"
            >
              {cacheStats.count} / {cacheStats.maxItems} vídeos · {formatBytes(cacheStats.totalBytes)}
            </span>
          </div>

          <button
            type="button"
            onClick={onClearVideoCache}
            disabled={cacheStats.count === 0 || isClearingCache}
            data-testid="clear-video-cache-btn"
            className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-white/10 bg-[#18181f] px-3 text-xs font-medium text-[#EDF1F7] hover:bg-[#22222b] disabled:opacity-45 transition-colors"
          >
            <Trash2 className="h-3.5 w-3.5 text-[#F87171]" />
            {isClearingCache ? 'Vaciando caché...' : 'Vaciar caché de vídeos'}
          </button>
        </section>

        <section className="rounded-xl border border-white/10 bg-[#121216] p-6 space-y-3">
          <h2 className="font-display text-sm font-semibold text-[#EDF1F7]">
            Cómo obtener el ID de tu carpeta
          </h2>
          <ol className="space-y-2.5 text-xs text-[#8B96A8] leading-relaxed list-decimal list-inside">
            <li>Abre tu carpeta de vídeos brutos en Google Drive.</li>
            <li>
              Copia la URL de la barra del navegador, por ejemplo{' '}
              <span className="font-mono text-[#C8D0DC] break-all">
                drive.google.com/drive/folders/1A2B3C...
              </span>
              .
            </li>
            <li>Pégala arriba y la aplicación extraerá el ID automáticamente.</li>
          </ol>
          <p className="pt-2 border-t border-white/10 text-[11px] text-[#687487] leading-relaxed">
            Consejo para iPhone/Android: activa el modo rápido móvil (720p) para renderizar clips largos sin agotar la memoria del navegador.
          </p>
        </section>
      </div>
    </div>
  );
}
