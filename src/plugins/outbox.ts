/**
 * ⑥ 离线指令队列插件
 *
 * send() 在未连接时不再静默丢弃，而是按序入队；重连成功后按序补发。
 * 队列有上限：满了丢最旧（实时语义 —— 旧消息的价值低于新消息）。
 *
 * ⚠️ 顺序敏感：必须在 backpressure 之前 use。
 *    backpressure 的拦截器第一步就是 `if (!isOpen()) return`（丢新保实时），
 *    若它在前，断线期间的消息会被它先拦掉，outbox 永远收不到货。
 *
 * ⚠️ 「入队」也要分性质：像拖动预览这种**下一条会覆盖它**的实时量，补发没有任何意义，
 *    却照样把队列塞满（60ms 节流下每秒 10~16 条，十几秒就顶到上限），
 *    同时把真正需要补发的消息（订阅、定值）挤出去 —— 所以支持 volatile 判定。
 */
import type { Plugin } from '../core/ws-core';

export interface OutboxOptions {
  /** 队列上限（默认取 ctx.opts.outboxLimit，再退到 200），满了丢最旧 */
  limit?: number;
  /**
   * 易失判定：返回 true = 断线期间**直接丢弃**，不入队。
   * 判据只有一条：**这条消息过期后还有没有价值**。
   *   · setGainPreview（拖动预览）—— 没有，下一条就覆盖它 → volatile
   *   · subscribe / setGain（定值）—— 有，必须让设备收到 → 入队
   */
  isVolatile?: (data: unknown) => boolean;
}

export function outboxPlugin(options: OutboxOptions = {}): Plugin {
  return {
    name: 'outbox',
    setup(ctx) {
      const queue: unknown[] = [];
      const limit = () => options.limit ?? ctx.opts.outboxLimit ?? 200;
      const isVolatile = options.isVolatile ?? (() => false);
      let dropped = 0;

      ctx.addSendInterceptor((data, next) => {
        if (ctx.isOpen()) {
          next(data);
          return;
        }
        // 未连接。
        // ① 易失消息直接丢：补发无意义，还会挤占队列
        if (isVolatile(data)) {
          dropped += 1;
          ctx.emit('outbox:dropped', { dropped, size: queue.length });
          return;
        }
        // ② 其余入队等重连补发。不调 next = 本条不发
        queue.push(data);
        if (queue.length > limit()) queue.shift();
        // 带上 type：队列里到底堆了什么，必须能观测（否则只能看到一个数字在动）
        ctx.emit('outbox:queued', { size: queue.length, type: (data as { type?: string })?.type });
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
          // 首连不需要补发历史。
          // ⚠️ 清空必须广播出去：观测面板的队列长度是事件驱动的，
          //    静默清空会让界面永远显示一个已经不存在的长度。
          queue.length = 0;
          ctx.emit('outbox:flushed', { count: 0 });
          return;
        }
        flush();
      });

      ctx.onTeardown(() => queue.splice(0, queue.length));

      ctx.expose('getOutboxSize', () => queue.length);
      ctx.expose('getOutboxDropped', () => dropped);
    },
  };
}
