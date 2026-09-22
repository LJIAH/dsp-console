import type { Device } from '../../protocol';

interface Props {
  devices: Device[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function DeviceListPanel({ devices, selectedId, onSelect }: Props) {
  return (
    <section className="flex min-h-0 flex-col rounded-lg border border-slate-800 bg-slate-900/40">
      <h2 className="border-b border-slate-800 px-3 py-2 text-xs font-medium text-slate-400">
        设备（{devices.length}）
      </h2>
      <ul className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {devices.map((d) => (
          <li key={d.deviceId}>
            <button
              onClick={() => onSelect(d.deviceId)}
              className={`mb-1 flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left text-xs transition ${
                d.deviceId === selectedId
                  ? 'bg-slate-700/60 text-slate-100'
                  : 'text-slate-400 hover:bg-slate-800/60'
              }`}
            >
              <span className="flex flex-col">
                <span className="font-medium">{d.name}</span>
                <span className="num text-[10px] text-slate-500">
                  {d.deviceId} · {d.model}
                </span>
              </span>
              <span className="flex items-center gap-1.5">
                {/* bootId：设备重启会变，是"序号归零、需拉全量"的判据 */}
                <span className="num text-[10px] text-slate-500">{d.bootId.slice(0, 6)}</span>
                <span
                  className={`h-1.5 w-1.5 rounded-full ${d.online ? 'bg-emerald-400' : 'bg-slate-600'}`}
                />
              </span>
            </button>
          </li>
        ))}
        {devices.length === 0 && (
          <li className="px-3 py-6 text-center text-xs text-slate-600">
            暂无数据 — 网关起了吗？
          </li>
        )}
      </ul>
    </section>
  );
}
