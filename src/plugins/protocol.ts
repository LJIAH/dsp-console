/**
 * ③ 协议校验插件：网络来的数据一律不可信
 *
 * 位置：必须在 heartbeat / reliable / pubsub 之前 ——
 * 它们都默认"消息结构合法"（比如直接读 msg.payload.seq）。
 *
 * 语义：
 *   - 校验失败 → 返回 true（消费掉）+ 上报 `protocol:invalid`，业务链看不到脏数据；
 *   - 校验通过 → 返回 false（不消费），继续向后传递。
 *
 * 注意分工：JSON.parse 失败在更早的**内核层**就被拦掉（core:parse-error）；
 * 本插件处理的是"能解析成 JSON、但结构/边界不合法"的消息。
 */
import type { Plugin } from '../core/ws-core';
import { ServerMessageSchema } from '../protocol';

export function protocolPlugin(): Plugin {
  return {
    name: 'protocol',
    setup(ctx) {
      ctx.onMessage((msg) => {
        const result = ServerMessageSchema.safeParse(msg);
        if (!result.success) {
          ctx.emit('protocol:invalid', {
            type: (msg as { type?: string })?.type ?? '(no type)',
            issues: result.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`),
          });
          return true; // 消费：非法消息不进业务链
        }
        return false;
      });
    },
  };
}
