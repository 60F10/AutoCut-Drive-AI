import { useMemo } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { BarChart3, Clock, Tags } from 'lucide-react';
import type { AnalyticsRecord } from '../types';
import { computeQueueAnalytics, formatDurationHuman } from '../utils/videoPipeline';

interface QueueAnalyticsPanelProps {
  records: AnalyticsRecord[];
}

export function QueueAnalyticsPanel({ records }: QueueAnalyticsPanelProps) {
  const summary = useMemo(() => computeQueueAnalytics(records, 7), [records]);

  return (
    <section
      aria-label="Panel de control de rendimiento"
      data-testid="queue-analytics-panel"
      className="grid grid-cols-1 xl:grid-cols-12 gap-5"
    >
      {/* Left: Recharts Bar Chart — Videos processed per day */}
      <div className="xl:col-span-7 rounded-xl border border-white/10 bg-[#121216] p-5 flex flex-col">
        <div className="flex flex-wrap items-center justify-between gap-2 pb-4 border-b border-white/10">
          <div className="flex items-center gap-2">
            <BarChart3 className="h-4 w-4 text-[#F43F5E]" aria-hidden="true" />
            <h2 className="font-display text-sm font-semibold text-[#EDF1F7]">
              Vídeos procesados por día
            </h2>
          </div>
          <div className="flex items-center gap-3 text-xs text-[#8B96A8]">
            <span>Últimos 7 días</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono tabular-nums text-[#EDF1F7]">
              {summary.totalProcessed} total
            </span>
          </div>
        </div>

        <div className="mt-4 h-[190px] w-full min-w-0">
          {summary.totalProcessed === 0 ? (
            <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-white/10 bg-[#09090b] px-4 text-center text-xs text-[#687487]">
              Procesa un vídeo o carga la sesión de ejemplo para ver tu actividad diaria de cortes.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={summary.dailySeries}
                margin={{ top: 8, right: 8, left: -24, bottom: 0 }}
              >
                <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
                <XAxis
                  dataKey="label"
                  tick={{ fill: '#8B96A8', fontSize: 11, fontFamily: 'JetBrains Mono' }}
                  axisLine={{ stroke: 'rgba(255,255,255,0.08)' }}
                  tickLine={false}
                />
                <YAxis
                  allowDecimals={false}
                  tick={{ fill: '#687487', fontSize: 11, fontFamily: 'JetBrains Mono' }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip
                  cursor={{ fill: 'rgba(255,255,255,0.04)' }}
                  contentStyle={{
                    backgroundColor: '#151921',
                    border: '1px solid rgba(255,255,255,0.12)',
                    borderRadius: '8px',
                    fontSize: '12px',
                    color: '#EDF1F7',
                  }}
                  formatter={(value: unknown) => [`${value} vídeos`, 'Procesados']}
                />
                <Bar
                  dataKey="count"
                  fill="#E11D48"
                  radius={[4, 4, 0, 0]}
                  maxBarSize={36}
                  isAnimationActive={false}
                />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* Right: Saved Footage Time + Gemini Tag Breakdown */}
      <div className="xl:col-span-5 rounded-xl border border-white/10 bg-[#121216] p-5 flex flex-col justify-between gap-5">
        {/* Saved Time Block */}
        <div className="pb-4 border-b border-white/10">
          <div className="flex items-center gap-2 text-xs text-[#8B96A8]">
            <Clock className="h-3.5 w-3.5 text-[#10B981]" aria-hidden="true" />
            <span>Metraje ahorrado gracias a los cortes</span>
          </div>
          <div className="mt-2 flex items-baseline justify-between gap-3">
            <p
              data-testid="total-saved-footage"
              className="font-mono text-2xl font-semibold tabular-nums text-[#EDF1F7]"
            >
              {formatDurationHuman(summary.totalSavedSec)}
            </p>
            {summary.avgReductionPct > 0 && (
              <span className="font-mono text-xs tabular-nums text-[#10B981]">
                -{summary.avgReductionPct}% metraje muerto
              </span>
            )}
          </div>
          <p className="mt-1 text-[11px] text-[#687487] font-mono tabular-nums">
            Bruto {formatDurationHuman(summary.totalRawSec)} → Final{' '}
            {formatDurationHuman(summary.totalFinalSec)}
          </p>
        </div>

        {/* Gemini Tag Breakdown */}
        <div className="flex-1 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2 text-xs font-medium text-[#C8D0DC]">
              <Tags className="h-3.5 w-3.5 text-[#F43F5E]" aria-hidden="true" />
              Etiquetas generadas por Gemini
            </span>
            <span className="font-mono text-[11px] tabular-nums text-[#687487]">
              {summary.tagBreakdown.length} categorías
            </span>
          </div>

          {summary.tagBreakdown.length === 0 ? (
            <p className="text-xs text-[#687487]">
              Sin etiquetas registradas todavía.
            </p>
          ) : (
            <div className="space-y-2.5">
              {summary.tagBreakdown.slice(0, 5).map((item) => (
                <div key={item.etiqueta} className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-mono font-medium text-[#EDF1F7]">
                      {item.etiqueta}
                    </span>
                    <span className="font-mono tabular-nums text-[#8B96A8]">
                      {item.count} · {item.sharePct}%
                    </span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/[0.07]">
                    <div
                      className="h-full rounded-full bg-[#E11D48] origin-left transition-transform duration-200"
                      style={{ transform: `scaleX(${Math.max(0.06, item.sharePct / 100)})` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
