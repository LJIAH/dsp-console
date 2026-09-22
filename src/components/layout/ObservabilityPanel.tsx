import { fmtTime } from '../../lib/format';
import type { TimelineEvent } from '../../plugins/observability';

/** 事件类型 → 颜色（心跳 / 重连 / 指令 / 异常 各一色） */
function kindColor(kind: string): string {
  if (kind.startsWith('heartbeat')) return 'text-amber-300';
  if (kind.startsWith('reconnect')) return 'text-sky-300';
  if (kind.startsWith('command')) return 'text-emerald-300';
  if (kind.includes('error') || kind.includes('parse')) return 'text-rose-300';
  return 'text-slate-400';
}

interface Props {
  events: readonly TimelineEvent[];
}

export function ObservabilityPanel({ events }: Props) {
  return (
    <section className="flex min-h-0 flex-col rounded-lg border border-slate-800 bg-slate-900/40">
      <h2 className="border-b border-slate-800 px-3 py-2 text-xs font-medium text-slate-400">
        事件时间轴（观测插件）
      </h2>
      <ul className="min-h-0 flex-1 overflow-y-auto p-2 font-mono text-[10px] leading-relaxed">
        {[...events].reverse().map((e, i) => (
          <li
            key={`${e.at}-${i}`}
            className="flex animate-[event-in_180ms_ease-out] gap-2 border-b border-slate-800/50 py-1"
          >
            <span className="shrink-0 text-slate-600">{fmtTime(e.at)}</span>
            <span className={`shrink-0 ${kindColor(e.kind)}`}>[{e.kind}]</span>
            <span className="min-w-0 flex-1 text-slate-400">{e.text}</span>
          </li>
        ))}
        {events.length === 0 && (
          <li className="px-2 py-6 text-center text-slate-600">暂无事件</li>
        )}
      </ul>
    </section>
  );
}
