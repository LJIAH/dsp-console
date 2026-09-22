/**
 * WS 帧数据源：把挂在 WebSocket 上的高频帧适配成 `FrameSource`
 *
 * 这就是"两条数据源"里的第一条（设备推送）。
 * 第二条（Web Audio 本地分析）会实现同一个接口 ——
 * 到时候只需换掉传给 `VizCanvas` 的 source，**渲染器与画布宿主一行都不用改**。
 *
 * 数据源与渲染器解耦的关键，就是这个 12 行的适配器：
 * 上游是"消息"、下游是"帧"，中间只做一次结构转换。
 */
import type { WSCore } from '../../core/ws-core';
import type { FrameSource } from '../types';

export function createWsFrameSource<F>(
  client: WSCore,
  type: string,
  map: (payload: any) => F,
): FrameSource<F> {
  return {
    name: `ws:${type}`,
    subscribe(cb) {
      // client.on 返回取消函数，可直接作为清理句柄
      return client.on(type, (payload: any) => cb(map(payload)));
    },
  };
}
