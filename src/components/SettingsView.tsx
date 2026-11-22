import { useEffect, useState } from 'react';
import {
  Bug,
  Check,
  ClipboardCopy,
  Cpu,
  Folder,
  HardDrive,
  RotateCcw,
  Save,
  ShieldCheck,
  Trash2,
  Zap,
} from 'lucide-react';
import type { User } from 'firebase/auth';
import type { AppSettings, ExportQuality, GeminiModelId, WatchIntervalSec } from '../types';
import type { VideoCacheStats } from '../services/videoStorage';
import {
  clearDebugLogs,
  getDebugLogStats,
  subscribeDebugLogs,
  type DebugLogStats,
} from '../services/debugLogger';
import {
  DEFAULT_GEMINI_MODEL,
  RECOMMENDED_GEMINI_MODELS,
  extractDriveFolderId,
  formatBytes,
  sanitizeGeminiModelName,
} from '../utils/videoPipeline';
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
  onCopyDiagnosticReport: () => Promise<boolean>;
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
  onCopyDiagnosticReport,
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
  const [logStats, setLogStats] = useState<DebugLogStats>(() => getDebugLogStats());
  const [copiedReport, setCopiedReport] = useState(false);

  useEffect(() => {
    setLogStats(getDebugLogStats());
    return subscribeDebugLogs(() => setLogStats(getDebugLogStats()));
  }, []);

  const handleCopyReportClick = async () => {
    const ok = await onCopyDiagnosticReport();
    if (ok) {
      setCopiedReport(true);
      window.setTimeout(() => setCopiedReport(false), 2000);
    }
  };

  const handleClearLogsClick = () => {
    clearDebugLogs();
  };

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

    const rawModel = model.trim().replace(/^models\//i, '');
    if (rawModel && !/^[a-zA-Z0-9._-]{3,80}$/.test(rawModel)) {
      setValidationError(
        'El nombre del modelo de Gemini solo puede contener letras, números, puntos, guiones y guiones bajos.'
      );
      return;
    }

    const cleanedModel = sanitizeGeminiModelName(rawModel, DEFAULT_GEMINI_MODEL);

    onSaveSettings({
      folderId: parsedFolderId,
      model: cleanedModel,
      watchIntervalSec,
      autoWatchEnabled,
      autoUploadEnabled,
      exportQuality,
    });
    setFolderInput(parsedFolderId);
    setModel(cleanedModel);
    setSavedBanner(true);
    window.setTimeout(() => setSavedBanner(false), 3000);
  };

  return (
    <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
      <form
        onSubmit={handleSubmit}
        className="xl:col-span-7 cyber-panel rounded-md divide-y divide-[#00f0ff]/20 overflow-hidden"
      >
        {/* Section 1: Google Drive Folder */}
        <div className="p-5 sm:p-6 space-y-4">
          <div>
            <h2 className="font-display text-base font-semibold text-[#EEF5FF]">
              Carpeta vigilada de Google Drive
            </h2>
            <p className="mt-1 text-xs text-[#94A8C4] leading-relaxed">
              Pega el ID de tu carpeta o la URL completa de Google Drive. La app ignorará cualquier archivo con <span className="font-mono text-[#fcee0a]">_EDITADO</span> para evitar bucles infinitos.
            </p>
          </div>

          <div className="space-y-2">
            <label
              htmlFor="drive-folder-id"
              className="block text-xs font-medium text-[#C8D7EC]"
            >
              ID o enlace de carpeta de Google Drive
            </label>
            <div className="relative">
              <Folder
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#00f0ff]"
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
                className="h-11 sm:h-10 w-full rounded-md border border-[#00f0ff]/25 bg-[#05060a] pl-9 pr-3 font-mono text-xs text-[#EEF5FF] placeholder:text-[#5F738E] focus:border-[#00f0ff] focus:outline-none"
              />
            </div>

            {folderInput.trim() && parsedFolderId !== folderInput.trim() && (
              <p className="text-xs text-[#00f0ff]">
                ID detectado automáticamente:{' '}
                <span className="font-mono font-semibold text-[#fcee0a]">{parsedFolderId}</span>
              </p>
            )}
          </div>
        </div>

        {/* Section 2: Gemini Model */}
        <div className="p-5 sm:p-6 space-y-4">
          <div>
            <h2 className="font-display text-base font-semibold text-[#EEF5FF]">
              Modelo de análisis Gemini
            </h2>
            <p className="mt-1 text-xs text-[#94A8C4]">
              Tu vídeo bruto nunca sale del dispositivo: el navegador extrae entre 12 y 16 fotogramas ligeros (480px JPEG, &lt; 2 MB) para analizarlos con Gemini sin errores 413.
            </p>
          </div>

          <div
            role="radiogroup"
            aria-label="Seleccionar modelo de Gemini"
            className="grid grid-cols-1 sm:grid-cols-3 gap-3"
          >
            {RECOMMENDED_GEMINI_MODELS.map((option) => {
              const selected = model.trim().replace(/^models\//i, '') === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  data-testid={`settings-model-${option.id}`}
                  onClick={() => {
                    setModel(option.id);
                    setValidationError(null);
                  }}
                  className={`min-h-[44px] rounded-md border p-3.5 text-left transition-all ${
                    selected
                      ? 'border-[#00f0ff] bg-[#00f0ff]/10 shadow-[0_0_16px_rgba(0,240,255,0.16)]'
                      : 'border-[#00f0ff]/20 bg-[#05060a]/85 hover:border-[#00f0ff]/45'
                  }`}
                >
                  <p
                    className={`font-mono text-xs font-semibold break-all ${
                      selected ? 'text-[#00f0ff]' : 'text-[#EEF5FF]'
                    }`}
                  >
                    {option.title}
                  </p>
                  <p className="mt-1.5 text-[11px] text-[#94A8C4] leading-relaxed">{option.desc}</p>
                </button>
              );
            })}
          </div>

          <div className="space-y-1.5 pt-1">
            <label
              htmlFor="gemini-model-input"
              className="block text-xs font-medium text-[#C8D7EC]"
            >
              Modelo personalizado o sobrescritura directa
            </label>
            <div className="relative">
              <Cpu
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#00f0ff]"
                aria-hidden="true"
              />
              <input
                id="gemini-model-input"
                data-testid="gemini-model-input"
                type="text"
                value={model}
                onChange={(e) => {
                  setModel(e.target.value);
                  setValidationError(null);
                }}
                placeholder={DEFAULT_GEMINI_MODEL}
                className="h-11 sm:h-10 w-full rounded-md border border-[#00f0ff]/25 bg-[#05060a] pl-9 pr-3 font-mono text-xs text-[#EEF5FF] placeholder:text-[#5F738E] focus:border-[#00f0ff] focus:outline-none"
              />
            </div>
            <p className="text-[11px] text-[#8EA2BD] leading-relaxed">
              Si Google jubila o lanza un nuevo modelo, puedes escribir aquí su identificador exacto (por defecto{' '}
              <span className="font-mono text-[#00f0ff]">{DEFAULT_GEMINI_MODEL}</span>) o configurarlo mediante{' '}
              <span className="font-mono text-[#fcee0a]">VITE_GEMINI_MODEL</span> /{' '}
              <span className="font-mono text-[#fcee0a]">GEMINI_MODEL</span>.
            </p>
          </div>
        </div>

        {/* Section 2.5: FFmpeg.wasm Render Quality / Mobile Performance Mode */}
        <div className="p-5 sm:p-6 space-y-4">
          <div className="flex items-start gap-2.5">
            <Zap className="h-4 w-4 text-[#fcee0a] shrink-0 mt-0.5" aria-hidden="true" />
            <div>
              <h2 className="font-display text-base font-semibold text-[#EEF5FF]">
                Modo de renderizado FFmpeg.wasm
              </h2>
              <p className="mt-1 text-xs text-[#94A8C4] leading-relaxed">
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
                  className={`min-h-[44px] rounded-md border p-4 text-left transition-all ${
                    selected
                      ? 'border-[#00f0ff] bg-[#00f0ff]/10 shadow-[0_0_16px_rgba(0,240,255,0.16)]'
                      : 'border-[#00f0ff]/20 bg-[#05060a]/85 hover:border-[#00f0ff]/45'
                  }`}
                >
                  <p
                    className={`text-xs font-semibold ${
                      selected ? 'text-[#00f0ff]' : 'text-[#EEF5FF]'
                    }`}
                  >
                    {option.title}
                  </p>
                  <p className="mt-1 font-mono text-[11px] font-medium text-[#fcee0a]">
                    {option.specs}
                  </p>
                  <p className="mt-1.5 text-xs text-[#94A8C4] leading-relaxed">{option.desc}</p>
                </button>
              );
            })}
          </div>
        </div>

        {/* Section 3: Watch Mode & Interval */}
        <div className="p-5 sm:p-6 space-y-5">
          <div>
            <h2 className="font-display text-base font-semibold text-[#EEF5FF]">
              Vigilancia automática y subida
            </h2>
            <p className="mt-1 text-xs text-[#94A8C4]">
              Escanea la carpeta automáticamente mientras esta pestaña permanezca abierta.
            </p>
          </div>

          <div className="space-y-2">
            <label className="block text-xs font-medium text-[#C8D7EC]">
              Intervalo de vigilancia
            </label>
            <div className="inline-flex items-center gap-1 rounded-md border border-[#00f0ff]/25 bg-[#05060a] p-1">
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
                    className={`min-h-[36px] rounded-sm px-4 py-1.5 font-mono text-xs font-medium transition-colors whitespace-nowrap ${
                      active
                        ? 'bg-[#00f0ff]/18 text-[#00f0ff]'
                        : 'text-[#8EA2BD] hover:text-[#EEF5FF]'
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
                className="mt-0.5 h-4 w-4 rounded-sm border-[#00f0ff]/40 bg-[#05060a] accent-[#00f0ff]"
              />
              <span>
                <span className="block text-sm font-medium text-[#EEF5FF]">
                  Activar Modo Vigilancia Automática
                </span>
                <span className="block text-xs text-[#94A8C4]">
                  Busca nuevos vídeos brutos en la carpeta según el intervalo elegido y los añade a la cola.
                </span>
              </span>
            </label>

            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={autoUploadEnabled}
                onChange={(e) => setAutoUploadEnabled(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded-sm border-[#00f0ff]/40 bg-[#05060a] accent-[#00f0ff]"
              />
              <span>
                <span className="block text-sm font-medium text-[#EEF5FF]">
                  Solicitar subida a Google Drive al terminar el render
                </span>
                <span className="block text-xs text-[#94A8C4]">
                  Al finalizar FFmpeg.wasm te pedirá confirmación antes de guardar el archivo <span className="font-mono text-[#fcee0a]">_EDITADO_ETIQUETA.mp4</span> en tu carpeta.
                </span>
              </span>
            </label>
          </div>
        </div>

        {/* Form Footer */}
        <div className="p-5 sm:p-6 flex flex-wrap items-center justify-between gap-3 bg-[#05060a]/80">
          <div className="min-w-0">
            {validationError ? (
              <p className="font-mono text-xs text-[#ff6ca9]">{validationError}</p>
            ) : savedBanner ? (
              <p className="inline-flex items-center gap-1.5 font-mono text-xs text-[#00f0ff]">
                <Check className="h-3.5 w-3.5" />
                Ajustes guardados en este navegador
              </p>
            ) : (
              <p className="text-xs text-[#8EA2BD]">
                Preferencias guardadas localmente en localStorage.
              </p>
            )}
          </div>

          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={onResetSettings}
              className="inline-flex h-10 items-center gap-1.5 rounded-md border border-[#00f0ff]/25 px-3 text-xs font-medium text-[#8EA2BD] hover:border-[#00f0ff]/55 hover:text-white transition-colors whitespace-nowrap"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Restablecer
            </button>
            <button
              type="submit"
              className="cyber-btn-primary inline-flex h-10 items-center gap-2 px-4 text-xs whitespace-nowrap"
            >
              <Save className="h-3.5 w-3.5" />
              Guardar ajustes
            </button>
          </div>
        </div>
      </form>

      {/* Right column: Connections, IndexedDB Cache & Quick Folder Guide */}
      <div className="xl:col-span-5 space-y-5">
        <section className="cyber-panel rounded-md p-5 sm:p-6 space-y-4">
          <div className="flex items-start gap-3">
            <ShieldCheck className="h-5 w-5 text-[#00f0ff] shrink-0 mt-0.5" />
            <div className="space-y-1">
              <h2 className="font-display text-base font-semibold text-[#EEF5FF]">
                Conexiones y seguridad
              </h2>
              <p className="text-xs text-[#94A8C4] leading-relaxed">
                Las llamadas a Gemini se ejecutan en el servidor usando la clave del entorno (
                <span className="font-mono text-[#00f0ff]">
                  {geminiConfigured ? 'Gemini disponible' : 'pendiente en Secrets'}
                </span>
                ). Tu token de Google Drive se guarda solo en memoria mientras la pestaña está abierta.
              </p>
            </div>
          </div>

          <div className="space-y-3 pt-3 border-t border-[#00f0ff]/20">
            <div className="text-xs">
              <p className="font-medium text-[#EEF5FF]">Cuenta de Google Drive</p>
              <p className="mt-0.5 font-mono text-[#94A8C4]">
                {user ? `Conectada como ${user.email}` : 'No conectada todavía'}
              </p>
            </div>

            {user ? (
              <button
                type="button"
                onClick={onGoogleLogout}
                className="h-10 w-full rounded-md border border-[#ff2a85]/40 bg-[#ff2a85]/10 px-3 text-xs font-medium text-[#EEF5FF] hover:bg-[#ff2a85]/20 transition-colors"
              >
                Desconectar Google Drive
              </button>
            ) : (
              <GoogleSignInButton onClick={onGoogleLogin} loading={isLoggingIn} />
            )}
          </div>
        </section>

        {/* Diagnostic & Support Card */}
        <section
          data-testid="diagnostic-support-card"
          className="cyber-panel rounded-md p-5 sm:p-6 space-y-4 border border-[#00f0ff]/35"
        >
          <div className="flex items-start gap-3">
            <Bug className="h-5 w-5 text-[#fcee0a] shrink-0 mt-0.5" />
            <div className="space-y-1">
              <h2 className="font-display text-base font-semibold text-[#EEF5FF]">
                Diagnóstico y soporte
              </h2>
              <p className="text-xs text-[#94A8C4] leading-relaxed">
                Copia en un toque la cronología de acciones, configuración y errores (sin tokens ni claves) para pegarla en un chat y depurar desde el móvil.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2.5">
            <div className="rounded-md border border-[#00f0ff]/25 bg-[#05060a] px-3.5 py-2.5">
              <p className="text-[11px] text-[#8EA2BD]">Eventos registrados</p>
              <p
                data-testid="diagnostic-events-count"
                className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-[#00f0ff]"
              >
                {logStats.total} / {logStats.maxEntries}
              </p>
            </div>
            <div className="rounded-md border border-[#00f0ff]/25 bg-[#05060a] px-3.5 py-2.5">
              <p className="text-[11px] text-[#8EA2BD]">Errores capturados</p>
              <p
                data-testid="diagnostic-errors-count"
                className={`mt-0.5 font-mono text-sm font-semibold tabular-nums ${
                  logStats.errors > 0 ? 'text-[#ff6ca9]' : 'text-[#EEF5FF]'
                }`}
              >
                {logStats.errors}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <button
              type="button"
              onClick={handleCopyReportClick}
              data-testid="copy-diagnostic-report-btn"
              className="cyber-btn-primary inline-flex min-h-[44px] w-full items-center justify-center gap-2 px-3.5 text-xs whitespace-nowrap"
            >
              {copiedReport ? (
                <>
                  <Check className="h-4 w-4" />
                  ¡Copiado!
                </>
              ) : (
                <>
                  <ClipboardCopy className="h-4 w-4" />
                  Copiar informe completo
                </>
              )}
            </button>

            <button
              type="button"
              onClick={handleClearLogsClick}
              disabled={logStats.total === 0}
              data-testid="clear-diagnostic-log-btn"
              className="inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-md border border-[#00f0ff]/25 bg-[#05060a] px-3.5 text-xs font-medium text-[#C8D7EC] hover:border-[#ff2a85]/60 hover:text-[#ff85b8] disabled:opacity-45 transition-colors whitespace-nowrap"
            >
              <Trash2 className="h-4 w-4" />
              Limpiar registro
            </button>
          </div>
        </section>

        {/* IndexedDB Local Video Cache */}
        <section
          data-testid="video-cache-card"
          className="cyber-panel rounded-md p-5 sm:p-6 space-y-4"
        >
          <div className="flex items-start gap-3">
            <HardDrive className="h-5 w-5 text-[#00f0ff] shrink-0 mt-0.5" />
            <div className="space-y-1">
              <h2 className="font-display text-base font-semibold text-[#EEF5FF]">
                Caché local de vídeos (IndexedDB)
              </h2>
              <p className="text-xs text-[#94A8C4] leading-relaxed">
                Los últimos {cacheStats.maxItems} MP4 renderizados se guardan en tu dispositivo para reproducirlos y descargarlos incluso tras recargar la app. Los más antiguos se limpian automáticamente sin borrar los metadatos ni tus enlaces de Drive.
              </p>
            </div>
          </div>

          <div className="flex items-center justify-between rounded-md border border-[#00f0ff]/25 bg-[#05060a] px-4 py-3 text-xs">
            <span className="text-[#8EA2BD]">Espacio usado</span>
            <span
              data-testid="video-cache-stats"
              className="font-mono font-semibold tabular-nums text-[#fcee0a]"
            >
              {cacheStats.count} / {cacheStats.maxItems} vídeos · {formatBytes(cacheStats.totalBytes)}
            </span>
          </div>

          <button
            type="button"
            onClick={onClearVideoCache}
            disabled={cacheStats.count === 0 || isClearingCache}
            data-testid="clear-video-cache-btn"
            className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-md border border-[#ff2a85]/35 bg-[#05060a] px-3 text-xs font-medium text-[#EEF5FF] hover:border-[#ff2a85]/70 hover:bg-[#ff2a85]/12 disabled:opacity-45 transition-colors"
          >
            <Trash2 className="h-3.5 w-3.5 text-[#ff2a85]" />
            {isClearingCache ? 'Vaciando caché...' : 'Vaciar caché de vídeos'}
          </button>
        </section>

        <section className="cyber-panel rounded-md p-5 sm:p-6 space-y-3">
          <h2 className="font-display text-sm font-semibold text-[#EEF5FF]">
            Cómo obtener el ID de tu carpeta
          </h2>
          <ol className="space-y-2.5 text-xs text-[#94A8C4] leading-relaxed list-decimal list-inside">
            <li>Abre tu carpeta de vídeos brutos en Google Drive.</li>
            <li>
              Copia la URL de la barra del navegador, por ejemplo{' '}
              <span className="font-mono text-[#00f0ff] break-all">
                drive.google.com/drive/folders/1A2B3C...
              </span>
              .
            </li>
            <li>Pégala arriba y la aplicación extraerá el ID automáticamente.</li>
          </ol>
          <p className="pt-2 border-t border-[#00f0ff]/20 text-[11px] text-[#8EA2BD] leading-relaxed">
            Consejo para iPhone/Android: activa el modo rápido móvil (720p) para renderizar clips largos sin agotar la memoria del navegador.
          </p>
        </section>
      </div>
    </div>
  );
}
