/** 顶栏指标：小标签 + 等宽数字 */
export function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string | number;
  tone?: string;
}) {
  return (
    <div className="flex flex-col leading-tight">
      <span className="text-[10px] tracking-wider text-slate-500 uppercase">{label}</span>
      <span className={`num text-sm ${tone ?? 'text-slate-200'}`}>{value}</span>
    </div>
  );
}
