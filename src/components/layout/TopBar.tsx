import { Metric } from '../ui/Metric';
import { useNow } from '../../react/useNow';
import type { CoreState } from '../../core/ws-core';
import type { MetricsSnapshot } from '../../plugins/observability';
import type { ReconnectInfo } from '../../assembly/profiles';

/** 展示用五态 = 内核「事实状态」 + 重连插件「意图」合成（状态归属见 ws-core 注释） */
type DisplayState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

const STATE_META: Record<DisplayState, { label: string; cls: string; dot: string }> = {
  idle: { label: 'IDLE', cls: 'border-slate-600 text-slate-300', dot: 'bg-slate-500' },
  connecting: {
    label: '连接中',
    cls: 'border-amber-500/50 text-amber-300',
    dot: 'bg-amber-400 animate-pulse',
  },
  open: { label: '已连接', cls: 'border-emerald-500/50 text-emerald-300', dot: 'bg-emerald-400' },
  reconnecting: {
    label: '重连中',
    cls: 'border-amber-500/50 text-amber-300',
    dot: 'bg-amber-400 animate-pulse',
  },
  closed: { label: '已断开', cls: 'border-rose-500/50 text-rose-300', dot: 'bg-rose-500' },
};

function composeState(core: CoreState, info: ReconnectInfo, now: number): DisplayState {
  if (core === 'open') return 'open';
  if (core === 'connecting') return info.attempt > 0 ? 'reconnecting' : 'connecting';
  if (core === 'closed' && info.nextRetryAt > now) return 'reconnecting';
  return core;
}

interface Props {
  metrics: MetricsSnapshot;
  info: ReconnectInfo;
  onClose: () => void;
  onReconnect: () => void;
  onResync: () => void;
}

export function TopBar({ metrics, info, onClose, onReconnect, onResync }: Props) {
  const now = useNow();
  const displayState = composeState(metrics.coreState, info, now);
  const meta = STATE_META[displayState];
  const countdown = info.nextRetryAt > now ? ((info.nextRetryAt - now) / 1_000).toFixed(1) : null;
  const reconnectCount = metrics.events.filter((e) => e.kind === 'reconnect').length;

  return (
    <header className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-slate-800 px-4 py-3">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold tracking-wide text-slate-100">DSP Console</span>
        <span className="text-[10px] text-slate-500">数字音频设备 Web 控制台</span>
      </div>

      <div
        className={`flex items-center gap-2 rounded-md border px-2.5 py-1 text-xs transition-colors duration-300 ${meta.cls}`}
      >
        <span className={`h-2 w-2 rounded-full ${meta.dot}`} />
        <span>{meta.label}</span>
        {displayState === 'reconnecting' && (
          <span className="num text-[11px] opacity-80">
            第 {info.attempt} 次{countdown ? ` · ${countdown}s` : ''}
          </span>
        )}
        {info.givenUp && <span className="text-[11px]">已放弃（点右侧按钮重连）</span>}
      </div>

      <div className="flex items-center gap-5">
        <Metric label="rx" value={metrics.rx} />
        <Metric label="tx" value={metrics.tx} />
        <Metric
          label="丢弃/非法"
          value={`${metrics.parseErrors}/${metrics.binaryFrames}`}
          tone={metrics.parseErrors > 0 ? 'text-amber-300' : undefined}
        />
        <Metric label="重连" value={reconnectCount} />
        <Metric label="rtt" value={metrics.lastRtt === null ? '—' : `${metrics.lastRtt}ms`} />
        <Metric label="在途指令" value={metrics.pending} />
        <Metric label="outbox" value={metrics.outbox} />
      </div>

      <div className="ml-auto flex items-center gap-2">
        {/* 主动断开 vs 服务端踢：演示"manuallyClosed 不重连"的对照 */}
        <button
          className="rounded-md border border-slate-700 px-2.5 py-1 text-xs text-slate-300 transition hover:border-slate-500 hover:text-slate-100"
          onClick={onClose}
        >
          主动断开
        </button>
        <button
          className="rounded-md border border-slate-700 px-2.5 py-1 text-xs text-slate-300 transition hover:border-slate-500 hover:text-slate-100"
          onClick={onReconnect}
        >
          重新连接
        </button>
        <button
          className="rounded-md border border-slate-700 px-2.5 py-1 text-xs text-slate-300 transition hover:border-slate-500 hover:text-slate-100"
          onClick={onResync}
        >
          拉快照
        </button>
      </div>
    </header>
  );
}
