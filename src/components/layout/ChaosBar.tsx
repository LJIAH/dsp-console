import { useState } from 'react';

/**
 * 故障注入条：每个按钮 = 一个知识点 = 一个可能的面试追问。
 * 前端只是"扳手"，真正的注入逻辑在网关（`/api/chaos/:name`）。
 */
const CHAOS_ACTIONS = [
  { name: 'drop', label: '优雅断开 (1001)', hint: '触发 onclose → 指数退避重连' },
  { name: 'half-open', label: '半开连接', hint: '不发关闭帧，只能等心跳判死' },
  { name: 'dirty', label: '脏数据', hint: '非 JSON 帧 → 内核层丢弃并计数' },
  { name: 'invalid', label: '结构非法', hint: '合法 JSON 但缺字段 → 协议插件拦下' },
  { name: 'no-ack', label: '指令不回 ack', hint: '观察 3s 超时 → 重发 ×3' },
  { name: 'restore', label: '恢复正常', hint: '关闭所有故障注入' },
] as const;

interface Props {
  onRun: (name: string) => Promise<string>;
}

export function ChaosBar({ onRun }: Props) {
  const [log, setLog] = useState('');

  const run = async (name: string) => {
    try {
      setLog(`${name} → ${await onRun(name)}`);
    } catch (err) {
      setLog(`${name} 失败：${String(err)}（网关没起？pnpm server）`);
    }
  };

  return (
    <footer className="border-t border-slate-800 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-1 text-xs font-medium text-rose-300">故障注入</span>
        {CHAOS_ACTIONS.map((a) => (
          <button
            key={a.name}
            onClick={() => void run(a.name)}
            title={a.hint}
            className="rounded-md border border-slate-700 px-2.5 py-1 text-xs text-slate-300 transition hover:border-rose-500/60 hover:text-rose-200"
          >
            {a.label}
          </button>
        ))}
        {log && <span className="num ml-2 text-[11px] text-slate-500">{log}</span>}
      </div>
    </footer>
  );
}
