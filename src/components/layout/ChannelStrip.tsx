import type { ReactNode } from 'react';
import { MeterCanvas } from '../MeterCanvas';
import { CHANNELS } from '../../protocol';
import type { Device } from '../../protocol';
import type { HotPathMode, MetersStoreRef, VizSourceKind } from '../../react/useConsole';

interface Props {
  metersRef: MetersStoreRef;
  selected: Device | null;
  /** 当前数据源：本地分析时电平表看"虚拟设备"，Mute 按钮无意义 */
  vizSource: VizSourceKind;
  /** 电平表的取数目标（useConsole 已按数据源合成） */
  meterTarget: string | null;
  hotPath: HotPathMode;
  onHotPathChange: (mode: HotPathMode) => void;
  onToggleMute: (deviceId: string, ch: number, muted: boolean) => void;
  /** 通道带下方的扩展区（可视化管线挂这里，但本组件不认识它） */
  children?: ReactNode;
}

/**
 * 调音台通道带：上面电平表、下面 Mute，逐列对齐。
 *
 * 对齐原理：两侧都是「16 等分 + 每侧 3px 内缩」——
 * 表侧每列条宽 colW-6（居中，即每侧 3px），按钮侧 mx-0.75，
 * 且两个容器同宽、同水平 padding，因此是**像素级**对齐。
 * ⚠️ 按钮区的 pl-7.5（30px）必须与 MeterCanvas 里的 AXIS_W 一致。
 *
 * 数据源与画布解耦：本组件只认「一个 meters 表 + 一个 key」，
 * 电平是设备推来的还是浏览器自己算的，它完全不知道。
 */
export function ChannelStrip({
  metersRef,
  selected,
  vizSource,
  meterTarget,
  hotPath,
  onHotPathChange,
  onToggleMute,
  children,
}: Props) {
  const localMode = vizSource === 'local';
  // 通道数跟设备能力走（ADSP1616 → 16 / ADSP0808AEC → 8），不硬编码
  const channelCount = selected?.channels.length ?? CHANNELS;

  return (
    <section className="flex min-h-0 flex-col rounded-lg border border-slate-800 bg-slate-900/40">
      <div className="flex items-center justify-between border-b border-slate-800 px-3 py-2">
        <h2 className="text-xs font-medium text-slate-400">
          {localMode
            ? '本地音频电平（CH1 · RMS → dBFS，由浏览器计算）'
            : selected
              ? `${selected.name} · ${channelCount} 通道电平（dBFS · 20Hz 批量推送）`
              : '通道面板'}
        </h2>
        {/* 性能 A/B：高频数据走 ref 还是进 React 状态（现场对照用） */}
        <div className="flex items-center gap-1 rounded-md border border-slate-700 p-0.5 text-[10px]">
          <button
            className={`rounded px-2 py-0.5 transition ${
              hotPath === 'ref' ? 'bg-slate-700 text-slate-100' : 'text-slate-500'
            }`}
            onClick={() => onHotPathChange('ref')}
            title="高频数据直写 ref，Canvas 直读：零 React 渲染"
          >
            高频旁路
          </button>
          <button
            className={`rounded px-2 py-0.5 transition ${
              hotPath === 'state' ? 'bg-rose-500/30 text-rose-200' : 'text-slate-500'
            }`}
            onClick={() => onHotPathChange('state')}
            title="每条 meters 消息触发一次 React 渲染（对照组）"
          >
            全量渲染
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2 p-2">
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-40 flex-1 rounded-t-md border border-b-0 border-slate-800 bg-slate-950/60 p-1.5">
            <MeterCanvas metersRef={metersRef} deviceId={meterTarget} channels={channelCount} />
          </div>
          <div
            className="grid rounded-b-md border border-slate-800 bg-slate-950/40 py-1.5 pr-1.5 pl-7.5"
            style={{ gridTemplateColumns: `repeat(${channelCount}, minmax(0, 1fr))` }}
          >
            {Array.from({ length: channelCount }, (_, i) => {
              const muted = selected?.channels[i]?.muted ?? false;
              const disabled = !selected || localMode;
              return (
                <button
                  key={i}
                  disabled={disabled}
                  onClick={() => {
                    if (selected && !localMode) onToggleMute(selected.deviceId, i + 1, !muted);
                  }}
                  title={
                    localMode
                      ? '本地分析模式下没有设备通道，静音按钮不可用'
                      : `CH${i + 1} ${muted ? '取消静音' : '静音'}（可靠指令：seq + ack）`
                  }
                  className={`mx-0.75 h-8 rounded-sm border text-[9px] leading-none transition disabled:opacity-40 ${
                    muted
                      ? 'border-rose-500/60 bg-rose-500/20 text-rose-200'
                      : 'border-slate-700 text-slate-500 hover:border-slate-500 hover:text-slate-200'
                  }`}
                >
                  {i + 1}
                </button>
              );
            })}
          </div>
        </div>

        {children}
      </div>
    </section>
  );
}
