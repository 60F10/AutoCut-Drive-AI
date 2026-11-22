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
      className="md:hidden fixed bottom-0 inset-x-0 z-40 border-t border-[#00f0ff]/30 bg-[#05060a]/92 backdrop-blur-xl pb-safe px-safe shadow-[0_-8px_28px_rgba(0,0,0,0.65)]"
    >
      <div className="grid grid-cols-4 items-center gap-1 px-2 py-1.5">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const active = activeView === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => onSelectView(tab.id)}
              aria-current={active ? 'page' : undefined}
              className={`relative flex min-h-[48px] min-w-[44px] flex-col items-center justify-center gap-1 rounded-md border px-2 py-1.5 transition-all ${
                active
                  ? 'border-[#00f0ff]/55 bg-[#00f0ff]/12 text-[#00f0ff] shadow-[0_0_16px_rgba(0,240,255,0.22)]'
                  : 'border-transparent text-[#8EA2BD] active:bg-[#00f0ff]/10 hover:text-[#EEF5FF]'
              }`}
            >
              <span className="relative flex items-center justify-center">
                <Icon
                  className={`h-5 w-5 ${active ? 'text-[#00f0ff]' : 'text-[#8EA2BD]'}`}
                  aria-hidden="true"
                />
                {typeof tab.count === 'number' && tab.count > 0 && (
                  <span className="absolute -top-1.5 -right-2.5 min-w-[16px] rounded-sm bg-[#ff2a85] px-1 text-center font-mono text-[10px] font-bold leading-4 text-white tabular-nums shadow-[0_0_8px_rgba(255,42,133,0.5)]">
                    {tab.count > 99 ? '99+' : tab.count}
                  </span>
                )}
              </span>
              <span
                className={`font-mono text-[10px] font-medium leading-none tracking-tight ${
                  active ? 'text-[#00f0ff]' : 'text-[#8EA2BD]'
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
