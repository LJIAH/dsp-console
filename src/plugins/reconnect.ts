/**
 * ① 重连插件 —— 必须第一个 use（装配铁律一）
 *
 * 为什么必须第一：它的 onOpen 要抢先复位退避计数、生产 shared.isReopen，
 * 后面的 reliable（重连重发）、session（快照对齐）都依赖这个值。
 *
 * 三要素：指数退避（1s→2s→4s…封顶 30s）+ 抖动（[50%,100%] 防惊群）+ code 过滤。
 *
 * 延迟的算法本体在 `./backoff.ts`（纯函数，单测钉住）；参数在 protocol/constants.json。
 */
import type { Plugin } from '../core/ws-core';
import { NO_RETRY_CLOSE_CODES, clientPolicy } from '../protocol';
import { backoffDelay } from './backoff';

export function reconnectPlugin(): Plugin {
  return {
    name: 'reconnect',
    setup(ctx) {
      let attempts = 0;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let currentDelay = 0;
      let nextRetryAt = 0;
      let givenUp = false;

      ctx.onOpen(() => {
        const isReopen = attempts > 0;
        ctx.shared.isReopen = isReopen; // ← 只由本插件写入
        attempts = 0;
        givenUp = false;
        currentDelay = 0;
        nextRetryAt = 0;
        ctx.emit('reconnect:opened', { isReopen });
      });

      ctx.onClose((e) => {
        // 用户主动关闭 → 到此为止（这就是"主动关闭不重连"的落点）
        if (ctx.isManuallyClosed()) return;

        const noRetry: number[] = ctx.opts.noRetryCodes ?? NO_RETRY_CLOSE_CODES;
        if (noRetry.includes(e.code)) {
          // 鉴权失败等：重试无意义。⚠️ 1000 不在名单里——
          // 心跳判死时我们用 close(1000) 主动断开，那是必须重连的
          ctx.emit('reconnect:giveup', { reason: 'no-retry-code', code: e.code });
          return;
        }

        if (attempts >= (ctx.opts.maxReconnectAttempts ?? Infinity)) {
          givenUp = true;
          ctx.emit('reconnect:giveup', { reason: 'max-attempts', attempts });
          return;
        }

        const delay = backoffDelay(attempts, {
          baseDelayMs: ctx.opts.baseDelay ?? clientPolicy.reconnect.baseDelayMs,
          maxDelayMs: ctx.opts.maxDelay ?? clientPolicy.reconnect.maxDelayMs,
          jitterRatio: clientPolicy.reconnect.jitterRatio,
        });
        attempts += 1;
        currentDelay = delay;
        nextRetryAt = Date.now() + delay;

        ctx.emit('reconnect:scheduled', {
          attempt: attempts,
          delay: Math.round(delay),
          nextRetryAt,
        });

        timer = setTimeout(() => {
          timer = null;
          ctx.connect(); // 幂等建连
        }, delay);
      });

      ctx.onTeardown(() => {
        if (timer) clearTimeout(timer);
        timer = null;
      });

      // 供 UI / 观测读取（连接"事实状态"由内核持有，这里是重连"意图"）
      ctx.expose('getReconnectInfo', () => ({
        attempt: attempts,
        delay: currentDelay,
        nextRetryAt,
        givenUp,
      }));
    },
  };
}
