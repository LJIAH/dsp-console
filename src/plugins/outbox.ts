/**
 * ⑥ 离线指令队列插件
 *
 * send() 在未连接时不再静默丢弃，而是按序入队；重连成功后按序补发。
 * 队列有上限：满了丢最旧（实时语义 —— 旧消息的价值低于新消息）。
 *
 * ⚠️ 顺序敏感：必须在 backpressure 之前 use。
 *    backpressure 的拦截器第一步就是 `if (!isOpen()) return`（丢新保实时），
 *    若它在前，断线期间的消息会被它先拦掉，outbox 永远收不到货。
 */
import type { Plugin } from '../core/ws-core';

export function outboxPlugin(): Plugin {
  return {
    name: 'outbox',
    setup(ctx) {
      const queue: unknown[] = [];
      const limit = () => ctx.opts.outboxLimit ?? 200;

      ctx.addSendInterceptor((data, next) => {
        if (ctx.isOpen()) {
          next(data);
          return;
        }
        // 未连接：入队而不是丢弃。不调 next = 本条不发（等待重连补发）
        queue.push(data);
        if (queue.length > limit()) queue.shift();
        ctx.emit('outbox:queued', { size: queue.length });
      });

      const flush = () => {
        if (!ctx.isOpen() || queue.length === 0) return;
        let count = 0;
        while (queue.length && ctx.isOpen()) {
          // 补发用 sendRaw：不再过一次拦截链，避免"自己把自己再排进队"
          ctx.sendRaw(queue.shift());
          count += 1;
        }
        ctx.emit('outbox:flushed', { count });
      };

      ctx.onOpen(() => {
        if (!ctx.shared.isReopen) {
          queue.length = 0; // 首连不需要补发历史
          return;
        }
        flush();
      });

      ctx.onTeardown(() => queue.splice(0, queue.length));

      ctx.expose('getOutboxSize', () => queue.length);
    },
  };
}
