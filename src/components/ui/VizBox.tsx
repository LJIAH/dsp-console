import { VizCanvas } from '../VizCanvas';
import type { LatestStore } from '../../viz/store';
import type { Renderer } from '../../viz/types';

/** 带标题角标的画布框：store + renderer 由外部传入（数据源无关） */
export function VizBox<F>({
  title,
  store,
  renderer,
}: {
  title: string;
  store: LatestStore<F>;
  renderer: Renderer<F>;
}) {
  return (
    <div className="relative overflow-hidden rounded-md border border-slate-800 bg-slate-950/60 p-1.5 pt-4">
      <span className="absolute top-1 left-2 text-[10px] text-slate-500">{title}</span>
      <VizCanvas store={store} renderer={renderer} />
    </div>
  );
}
