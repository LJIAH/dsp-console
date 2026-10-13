/**
 * ⑦ 背压插件：一个 send 拦截器就够
 *
 * `bufferedAmount` 是浏览器唯一能看到的"发送积压量"，
 * 超过高水位就**丢新保实时**——因为这条链上传的都是可丢的实时数据，
 * 而"不能丢"的可靠指令走 sendRaw，天然不受影响。
 *
 * ⚠️ 顺序敏感：本插件必须在 outbox 之后 use。
 *    若它在前，"未连接"会被它先拦下（丢新保实时的语义），
 *    outbox 永远收不到货 —— 这类顺序断言在 profiles.ts 里有注释说明。
 */
import type { Plugin } from '../core/ws-core';
import { clientPolicy } from '../protocol';

export function backpressurePlugin(): Plugin {
  return {
    name: 'backpressure',
    setup(ctx) {
      ctx.addSendInterceptor((data, next) => {
        if (!ctx.isOpen()) {
          ctx.emit('backpressure:dropped', { reason: 'offline' });
          return; // 拦截：不调 next
        }
        const highWater: number = ctx.opts.highWater ?? clientPolicy.backpressure.highWaterBytes;
        if (ctx.bufferedAmount() > highWater) {
          ctx.emit('backpressure:dropped', {
            reason: 'high-water',
            buffered: ctx.bufferedAmount(),
          });
          return; // 积压太深：丢新保实时
        }
        next(data);
      });
    },
  };
}
