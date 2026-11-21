import { Film, ListVideo, LogOut, Radio, Settings, X } from 'lucide-react';
import type { User } from 'firebase/auth';
import type { ActiveView, AppSettings } from '../types';
import { GoogleSignInButton } from './GoogleSignInButton';

interface SidebarProps {
  activeView: ActiveView;
  onSelectView: (view: ActiveView) => void;
  settings: AppSettings;
  onToggleAutoWatch: () => void;
  nextScanCountdownSec: number | null;
  queueCounts: { total: number; pending: number; studioReady: number };
  user: User | null;
  isLoggingIn: boolean;
  onGoogleLogin: () => void;
  onGoogleLogout: () => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
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
  mobileOpen,
  onCloseMobile,
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

  const sidebarContent = (
    <div className="flex h-full flex-col bg-[#111419] border-r border-white/[0.08]">
      {/* Brand Zone: Single-line wordmark */}
      <div className="flex h-16 items-center justify-between px-5 border-b border-white/[0.08]">
        <span className="font-display text-[17px] font-semibold tracking-tight text-[#EDF1F7] whitespace-nowrap shrink-0">
          AutoCut Drive AI
        </span>
        <button
          type="button"
          onClick={onCloseMobile}
          aria-label="Cerrar menú lateral"
          className="lg:hidden flex h-9 w-9 items-center justify-center rounded-md text-[#8B96A8] hover:bg-white/[0.06] hover:text-white transition-colors"
        >
          <X className="h-4 w-4" />
        </button>
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
              onClick={() => {
                onSelectView(item.id);
                onCloseMobile();
              }}
              aria-current={active ? 'page' : undefined}
              className={`w-full flex items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors whitespace-nowrap ${
                active
                  ? 'bg-white/[0.08] text-white'
                  : 'text-[#8B96A8] hover:bg-white/[0.04] hover:text-[#EDF1F7]'
              }`}
            >
              <span className="flex items-center gap-2.5 truncate">
                <Icon className={`h-4 w-4 shrink-0 ${active ? 'text-[#F43F5E]' : 'text-[#687487]'}`} />
                <span className="truncate">{item.label}</span>
              </span>
              {typeof item.count === 'number' && item.count > 0 && (
                <span className="font-mono text-xs tabular-nums text-[#8B96A8]">
                  {item.count}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {/* Auto-Watch Control Block */}
      <div className="mx-3 mt-2 rounded-lg border border-white/[0.08] bg-[#151921] p-4">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-2 text-xs font-medium text-[#C8D0DC] whitespace-nowrap">
            <Radio
              className={`h-3.5 w-3.5 shrink-0 ${
                settings.autoWatchEnabled ? 'text-[#10B981]' : 'text-[#687487]'
              }`}
            />
            Vigilancia
          </span>
          <span
            className={`text-xs font-medium whitespace-nowrap ${
              settings.autoWatchEnabled ? 'text-[#10B981]' : 'text-[#687487]'
            }`}
          >
            {settings.autoWatchEnabled ? 'Activa' : 'Pausada'}
          </span>
        </div>

        <div className="mt-2.5 space-y-1 text-xs text-[#8B96A8]">
          <div className="flex items-center justify-between">
            <span>Intervalo</span>
            <span className="font-mono tabular-nums text-[#C8D0DC]">{intervalLabel}</span>
          </div>
          <div className="flex items-center justify-between">
            <span>Modelo</span>
            <span className="font-mono text-[#C8D0DC]">{settings.model}</span>
          </div>
          {settings.autoWatchEnabled && nextScanCountdownSec !== null && (
            <div className="flex items-center justify-between">
              <span>Próximo escaneo</span>
              <span className="font-mono tabular-nums text-[#EDF1F7]">
                {nextScanCountdownSec} s
              </span>
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={onToggleAutoWatch}
          className={`mt-3 w-full rounded-md px-3 py-2 text-xs font-medium transition-colors whitespace-nowrap ${
            settings.autoWatchEnabled
              ? 'border border-white/[0.12] bg-transparent text-[#EDF1F7] hover:bg-white/[0.06]'
              : 'bg-white/[0.08] text-[#EDF1F7] hover:bg-white/[0.13]'
          }`}
        >
          {settings.autoWatchEnabled ? 'Pausar vigilancia' : 'Activar vigilancia'}
        </button>
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Google Drive Auth Footer */}
      <div className="border-t border-white/[0.08] p-4">
        {user ? (
          <div className="space-y-3">
            <div className="flex items-center gap-3 min-w-0">
              {user.photoURL ? (
                <img
                  src={user.photoURL}
                  alt={user.displayName || 'Cuenta de Google'}
                  referrerPolicy="no-referrer"
                  className="h-8 w-8 rounded-full border border-white/[0.12] object-cover shrink-0"
                />
              ) : (
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[#1C222D] text-xs font-semibold text-[#EDF1F7] shrink-0">
                  {(user.displayName || user.email || 'G').slice(0, 1).toUpperCase()}
                </div>
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium text-[#EDF1F7]">
                  {user.displayName || 'Google Drive conectado'}
                </p>
                <p className="truncate text-[11px] text-[#8B96A8]">{user.email}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={onGoogleLogout}
              className="flex w-full items-center justify-center gap-2 rounded-md border border-white/[0.09] px-3 py-2 text-xs font-medium text-[#B8C2D1] hover:bg-white/[0.05] hover:text-white transition-colors whitespace-nowrap"
            >
              <LogOut className="h-3.5 w-3.5" />
              Cerrar sesión
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-xs text-[#8B96A8]">
              Conecta Google Drive para vigilar tu carpeta y subir los vídeos editados.
            </p>
            <GoogleSignInButton onClick={onGoogleLogin} loading={isLoggingIn} />
          </div>
        )}
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop Sidebar */}
      <aside className="hidden lg:block w-[264px] shrink-0 h-screen sticky top-0">
        {sidebarContent}
      </aside>

      {/* Mobile Drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-black/70 backdrop-blur-[2px]"
            onClick={onCloseMobile}
            aria-hidden="true"
          />
          <aside className="relative z-10 w-[280px] max-w-[85vw] h-full">
            {sidebarContent}
          </aside>
        </div>
      )}
    </>
  );
}
