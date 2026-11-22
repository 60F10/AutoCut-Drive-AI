import { Film, LayoutGrid, ListVideo, LogOut, Radio, Settings } from 'lucide-react';
import type { User } from 'firebase/auth';
import type { ActiveView, AppSettings } from '../types';
import { GoogleSignInButton } from './GoogleSignInButton';
import { PWAInstallButton } from './PWAInstallButton';

interface SidebarProps {
  activeView: ActiveView;
  onSelectView: (view: ActiveView) => void;
  settings: AppSettings;
  onToggleAutoWatch: () => void;
  nextScanCountdownSec: number | null;
  queueCounts: { total: number; pending: number; completed: number; studioReady: number };
  user: User | null;
  isLoggingIn: boolean;
  onGoogleLogin: () => void;
  onGoogleLogout: () => void;
}

export function Sidebar({
  activeView,
  onSelectView,
  settings,
  onToggleAutoWatch,
  nextScanCountdownSec,
  queueCounts,
  user,
  isLoggingIn,
  onGoogleLogin,
  onGoogleLogout,
}: SidebarProps) {
  const navItems: Array<{
    id: ActiveView;
    label: string;
    count?: number;
    icon: typeof ListVideo;
  }> = [
    {
      id: 'queue',
      label: 'Cola de vídeos',
      count: queueCounts.total,
      icon: ListVideo,
    },
    {
      id: 'studio',
      label: 'Estudio de cortes',
      count: queueCounts.studioReady,
      icon: Film,
    },
    {
      id: 'gallery',
      label: 'Galería',
      count: queueCounts.completed,
      icon: LayoutGrid,
    },
    {
      id: 'settings',
      label: 'Ajustes',
      icon: Settings,
    },
  ];

  const intervalLabel =
    settings.watchIntervalSec === 30
      ? '30 s'
      : settings.watchIntervalSec === 60
      ? '60 s'
      : '5 min';

  return (
    <aside className="hidden md:block w-[256px] shrink-0 h-dvh-app sticky top-0">
      <div className="flex h-full flex-col bg-[#0c0f1a]/92 backdrop-blur-md border-r border-[#00f0ff]/25">
        {/* Brand Zone: Single-line wordmark */}
        <div className="flex h-16 items-center px-5 border-b border-[#00f0ff]/20">
          <span className="font-display text-[17px] font-bold tracking-tight text-[#EEF5FF] whitespace-nowrap shrink-0">
            AutoCut <span className="text-[#00f0ff]">Drive AI</span>
          </span>
        </div>

        {/* Navigation */}
        <nav aria-label="Navegación principal" className="px-3 py-4 space-y-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = activeView === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelectView(item.id)}
                aria-current={active ? 'page' : undefined}
                className={`w-full flex items-center justify-between gap-3 rounded-md border px-3 py-2.5 text-sm font-medium transition-all whitespace-nowrap ${
                  active
                    ? 'border-[#00f0ff]/45 bg-[#00f0ff]/10 text-[#00f0ff] shadow-[0_0_14px_rgba(0,240,255,0.16)]'
                    : 'border-transparent text-[#8EA2BD] hover:border-[#00f0ff]/20 hover:bg-[#00f0ff]/[0.05] hover:text-[#EEF5FF]'
                }`}
              >
                <span className="flex items-center gap-2.5 truncate">
                  <Icon
                    className={`h-4 w-4 shrink-0 ${active ? 'text-[#00f0ff]' : 'text-[#6A7E99]'}`}
                  />
                  <span className="truncate">{item.label}</span>
                </span>
                {typeof item.count === 'number' && item.count > 0 && (
                  <span
                    className={`font-mono text-xs tabular-nums ${
                      active ? 'text-[#fcee0a] font-semibold' : 'text-[#8EA2BD]'
                    }`}
                  >
                    {item.count}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        {/* Auto-Watch Control Block */}
        <div className="mx-3 mt-2 rounded-md border border-[#00f0ff]/25 bg-[#05060a]/85 p-4">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2 text-xs font-medium text-[#C8D7EC] whitespace-nowrap">
              <Radio
                className={`h-3.5 w-3.5 shrink-0 ${
                  settings.autoWatchEnabled ? 'text-[#00f0ff]' : 'text-[#6A7E99]'
                }`}
              />
              Vigilancia
            </span>
            <span
              className={`font-mono text-xs font-medium whitespace-nowrap ${
                settings.autoWatchEnabled ? 'text-[#00f0ff]' : 'text-[#6A7E99]'
              }`}
            >
              {settings.autoWatchEnabled ? 'Activa' : 'Pausada'}
            </span>
          </div>

          <div className="mt-2.5 space-y-1 text-xs text-[#8EA2BD]">
            <div className="flex items-center justify-between">
              <span>Intervalo</span>
              <span className="font-mono tabular-nums text-[#EEF5FF]">{intervalLabel}</span>
            </div>
            <div className="flex items-center justify-between">
              <span>Modelo</span>
              <span className="font-mono text-[#EEF5FF]">{settings.model}</span>
            </div>
            <div className="flex items-center justify-between">
              <span>Salida</span>
              <span className="font-mono text-[#fcee0a]">
                {settings.exportQuality === 'mobile_fast' ? '720p móvil' : '1080p HD'}
              </span>
            </div>
            {settings.autoWatchEnabled && nextScanCountdownSec !== null && (
              <div className="flex items-center justify-between">
                <span>Próximo escaneo</span>
                <span className="font-mono tabular-nums text-[#00f0ff]">
                  {nextScanCountdownSec} s
                </span>
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={onToggleAutoWatch}
            className={`mt-3 w-full rounded-md border px-3 py-2 text-xs font-medium transition-colors whitespace-nowrap ${
              settings.autoWatchEnabled
                ? 'border-[#ff2a85]/45 bg-[#ff2a85]/10 text-[#ff85b8] hover:bg-[#ff2a85]/20'
                : 'border-[#00f0ff]/35 bg-[#00f0ff]/10 text-[#00f0ff] hover:bg-[#00f0ff]/18'
            }`}
          >
            {settings.autoWatchEnabled ? 'Pausar vigilancia' : 'Activar vigilancia'}
          </button>
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Google Drive Auth & PWA Install Footer */}
        <div className="border-t border-[#00f0ff]/20 p-4 space-y-3">
          <PWAInstallButton compact />
          {user ? (
            <div className="space-y-3">
              <div className="flex items-center gap-3 min-w-0">
                {user.photoURL ? (
                  <img
                    src={user.photoURL}
                    alt={user.displayName || 'Cuenta de Google'}
                    referrerPolicy="no-referrer"
                    className="h-8 w-8 rounded-full border border-[#00f0ff]/40 object-cover shrink-0"
                  />
                ) : (
                  <div className="flex h-8 w-8 items-center justify-center rounded-full border border-[#00f0ff]/35 bg-[#05060a] font-mono text-xs font-semibold text-[#00f0ff] shrink-0">
                    {(user.displayName || user.email || 'G').slice(0, 1).toUpperCase()}
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium text-[#EEF5FF]">
                    {user.displayName || 'Google Drive conectado'}
                  </p>
                  <p className="truncate font-mono text-[11px] text-[#8EA2BD]">{user.email}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={onGoogleLogout}
                className="flex w-full items-center justify-center gap-2 rounded-md border border-[#00f0ff]/25 px-3 py-2 text-xs font-medium text-[#C8D7EC] hover:border-[#ff2a85]/50 hover:bg-[#ff2a85]/10 hover:text-white transition-colors whitespace-nowrap"
              >
                <LogOut className="h-3.5 w-3.5" />
                Cerrar sesión
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-xs text-[#8EA2BD]">
                Conecta Google Drive para vigilar tu carpeta y subir los vídeos editados.
              </p>
              <GoogleSignInButton onClick={onGoogleLogin} loading={isLoggingIn} />
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
