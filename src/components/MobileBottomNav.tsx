import { Film, LayoutGrid, ListVideo, Settings } from 'lucide-react';
import type { ActiveView } from '../types';

interface MobileBottomNavProps {
  activeView: ActiveView;
  onSelectView: (view: ActiveView) => void;
  queueCounts: { total: number; pending: number; completed: number; studioReady: number };
}

export function MobileBottomNav({
  activeView,
  onSelectView,
  queueCounts,
}: MobileBottomNavProps) {
  const tabs: Array<{
    id: ActiveView;
    label: string;
    icon: typeof ListVideo;
    count?: number;
  }> = [
    { id: 'queue', label: 'Cola', icon: ListVideo, count: queueCounts.pending },
    { id: 'studio', label: 'Estudio', icon: Film, count: queueCounts.studioReady },
    { id: 'gallery', label: 'Galería', icon: LayoutGrid, count: queueCounts.completed },
    { id: 'settings', label: 'Ajustes', icon: Settings },
  ];

  return (
    <nav
      aria-label="Navegación móvil"
      data-testid="mobile-bottom-nav"
      className="md:hidden fixed bottom-0 inset-x-0 z-40 border-t border-white/10 bg-[#09090b]/90 backdrop-blur-xl pb-safe px-safe"
    >
      <div className="grid grid-cols-4 items-center px-1.5 py-1.5">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const active = activeView === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => onSelectView(tab.id)}
              aria-current={active ? 'page' : undefined}
              className={`relative flex min-h-[48px] min-w-[44px] flex-col items-center justify-center gap-1 rounded-xl px-2 py-1.5 transition-colors ${
                active
                  ? 'text-white bg-white/[0.06]'
                  : 'text-[#8B96A8] active:bg-white/[0.04] hover:text-[#EDF1F7]'
              }`}
            >
              <span className="relative flex items-center justify-center">
                <Icon
                  className={`h-5 w-5 ${active ? 'text-[#F43F5E]' : 'text-[#8B96A8]'}`}
                  aria-hidden="true"
                />
                {typeof tab.count === 'number' && tab.count > 0 && (
                  <span className="absolute -top-1.5 -right-2.5 min-w-[16px] rounded-full bg-[#E11D48] px-1 text-center font-mono text-[10px] font-semibold leading-4 text-white tabular-nums">
                    {tab.count > 99 ? '99+' : tab.count}
                  </span>
                )}
              </span>
              <span
                className={`text-[11px] font-medium leading-none tracking-tight ${
                  active ? 'text-white' : 'text-[#8B96A8]'
                }`}
              >
                {tab.label}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
