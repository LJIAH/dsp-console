/**
 * ⑩ 分发插件 —— 必须最后一个 use（装配铁律二）
 *
 * 它是**兜底消费者**：走到这里的消息都是业务消息
 * （pong 被 heartbeat 吃掉、ack 被 reliable 吃掉）。
 * 装在前面会把 pong/ack 也当业务消息分发出去。
 */
import type { Plugin } from '../core/ws-core';

export function pubsubPlugin(): Plugin {
  return {
    name: 'pubsub',
    setup(ctx) {
      ctx.onMessage((msg) => {
        if (typeof msg?.type === 'string') {
          // 按 type 路由：业务侧 client.on('meters', fn) / client.on('state', fn)
          ctx.emit(msg.type, msg.payload);
        }
        return true; // 兜底消费
      });
    },
  };
}
