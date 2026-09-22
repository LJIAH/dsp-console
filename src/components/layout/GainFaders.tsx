import { useRef } from 'react';
import type { Device } from '../../protocol';

/** 增益范围与步进：与协议 ChannelSchema 的约定一致（-12 ~ +12 dB） */
const MIN_GAIN = -12;
const MAX_GAIN = 12;
const STEP = 0.5;

interface Props {
  device: Device | null;
  channelCount: number;
  /** 拖动中的乐观值（key = `deviceId:ch`） */
  draft: { key: string; value: number } | null;
  onPreview: (deviceId: string, ch: number, gain: number) => void;
  onCommit: (deviceId: string, ch: number, gain: number) => void;
  disabled: boolean;
}

/**
 * 通道增益推子行（自绘竖直滑块，与电平表/静音键逐列对齐）
 *
 * ── 为什么自绘而不是 <input type="range"> ──────────────────────
 *   1. 竖排 range 依赖 `writing-mode: vertical-lr`，各浏览器与移动端的
 *      观感、拖动手感都不一致，而我们要跨端演示；
 *   2. 自绘能直接复用通道带的视觉语言（同样的每侧 3px 内缩、同样的像素级对齐）；
 *   3. 需要精确控制「拖动中」与「松手」两个时机 —— 这正是滑块的灵魂（见下）。
 *
 * ── 交互契约（本次实现的重点） ─────────────────────────────────
 *   拖动中 → onPreview → 本地乐观值（每帧跟随）+ **节流发可丢预览指令**
 *   松手时 → onCommit  → **seq + ack 的可靠定值指令**（超时重发、重连重发）
 *   键盘（↑↓ / PgUp / PgDn）没有"松手"事件，直接按定值提交
 *
 *   反面教材就是教学版 Demo 的写法：`onChange` 直接发可靠指令，
 *   拖 1 秒 = 60 条指令 + 60 个 pending 各自等超时重发。
 */
export function GainFaders({ device, channelCount, draft, onPreview, onCommit, disabled }: Props) {
  return (
    <div
      className="grid shrink-0 gap-0 border-x border-slate-800 bg-slate-950/30 py-1.5 pr-1.5 pl-7.5"
      style={{ gridTemplateColumns: `repeat(${channelCount}, minmax(0, 1fr))` }}
    >
      {Array.from({ length: channelCount }, (_, i) => {
        const ch = device?.channels[i];
        const key = `${device?.deviceId ?? ''}:${i + 1}`;
        // 拖动中显示本地乐观值，否则显示设备权威值
        const gain = draft?.key === key ? draft.value : (ch?.gain ?? 0);
        return (
          <div key={i} className="mx-0.75 flex justify-center">
            <Fader
              value={gain}
              disabled={disabled || !device}
              label={`CH${i + 1} 增益`}
              onChange={(v) => {
                if (device) onPreview(device.deviceId, i + 1, v);
              }}
              onCommit={(v) => {
                if (device) onCommit(device.deviceId, i + 1, v);
              }}
            />
          </div>
        );
      })}
    </div>
  );
}

interface FaderProps {
  value: number;
  disabled: boolean;
  label: string;
  onChange: (value: number) => void;
  onCommit: (value: number) => void;
}

function Fader({ value, disabled, label, onChange, onCommit }: FaderProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const ratio = (value - MIN_GAIN) / (MAX_GAIN - MIN_GAIN);
  const text = `${label}：${value > 0 ? '+' : ''}${value.toFixed(1)} dB`;

  /** 由指针的 y 坐标反算增益（底部 = MIN，顶部 = MAX），按 STEP 对齐 */
  const valueAt = (clientY: number): number => {
    const el = trackRef.current;
    if (!el) return value;
    const rect = el.getBoundingClientRect();
    const r = Math.min(1, Math.max(0, 1 - (clientY - rect.top) / rect.height));
    const raw = MIN_GAIN + r * (MAX_GAIN - MIN_GAIN);
    return Math.round(raw / STEP) * STEP;
  };

  return (
    <div
      ref={trackRef}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-valuemin={MIN_GAIN}
      aria-valuemax={MAX_GAIN}
      aria-valuenow={value}
      aria-valuetext={`${value > 0 ? '+' : ''}${value.toFixed(1)} dB`}
      aria-disabled={disabled}
      title={`${text}（拖动=预览，松手=下发；键盘 ↑↓ 可调）`}
      onPointerDown={(e) => {
        if (disabled) return;
        // 捕获可能失败（pointerId 无效、元素已卸载、平台差异）。
        // 它一旦抛出就会中断整个 handler —— 推子彻底没反应，异常还会冒到 React 错误边界。
        // 降级成"无捕获"：指针移出元素会丢 move，但点击定位仍然有效。
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          /* 忽略：降级为无捕获模式 */
        }
        dragging.current = true;
        onChange(valueAt(e.clientY));
      }}
      onPointerMove={(e) => {
        if (!dragging.current || disabled) return;
        onChange(valueAt(e.clientY));
      }}
      onPointerUp={(e) => {
        if (!dragging.current) return;
        dragging.current = false;
        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
          /* 本来就没捕获成功，忽略 */
        }
        // 用松手位置现算，避免 props 滞后一帧拿到旧值
        onCommit(valueAt(e.clientY));
      }}
      onPointerCancel={() => {
        // 系统手势中断（移动端常见）：用户已经拖到哪就是哪，按所见即所得提交
        if (!dragging.current) return;
        dragging.current = false;
        onCommit(value);
      }}
      onLostPointerCapture={() => {
        // 兜底：捕获意外丢失（拖出窗口、系统弹窗、切窗口……）时也必须收尾。
        // 否则 dragging 卡在 true —— 之后鼠标一动推子就跟着乱跳，
        // 而且这一次调整永远不会被提交，等权威值回来就成了"被弹回去"。
        if (!dragging.current) return;
        dragging.current = false;
        onCommit(value);
      }}
      onKeyDown={(e) => {
        if (disabled) return;
        const delta =
          e.key === 'ArrowUp'
            ? STEP
            : e.key === 'ArrowDown'
              ? -STEP
              : e.key === 'PageUp'
                ? STEP * 6
                : e.key === 'PageDown'
                  ? -STEP * 6
                  : 0;
        if (delta === 0) return;
        e.preventDefault();
        const next = Math.round(Math.max(MIN_GAIN, Math.min(MAX_GAIN, value + delta)) * 2) / 2;
        onChange(next);
        onCommit(next);
      }}
      className={`relative flex h-24 w-full touch-none items-center justify-center rounded-sm outline-none transition ${
        disabled
          ? 'cursor-not-allowed opacity-40'
          : 'cursor-ns-resize hover:bg-slate-800/40 focus-visible:ring-1 focus-visible:ring-sky-500/60'
      }`}
    >
      {/* 轨道 */}
      <div className="relative h-full w-1.5 overflow-hidden rounded-full bg-slate-800">
        {/* 已填充（底 → 把手）：用青蓝，与电平的绿/黄/红区分开 */}
        <div
          className="absolute inset-x-0 bottom-0 rounded-full bg-gradient-to-t from-sky-600/60 to-sky-400/80"
          style={{ height: `${ratio * 100}%` }}
        />
      </div>
      {/* 把手 */}
      <div
        className="pointer-events-none absolute left-1/2 h-2.5 w-4 -translate-x-1/2 translate-y-1/2 rounded-sm border border-slate-400 bg-slate-200 shadow-sm"
        style={{ bottom: `${ratio * 100}%` }}
      />
    </div>
  );
}
