/**
 * ⑤ 可靠指令插件：seq + ack + 超时重发 + 重连重发
 *
 * 语义（对齐 `协议设计/05`）：
 *   - 指令带 seq，设备回 ack(seq)；ack 原样带回 seq 才能配对
 *   - 超时重发用**同一个 seq**（设备端靠 seq 幂等去重，重复也补回 ack）
 *   - ok=false 是设备明确拒绝 → 不重发、直接 reject（重试无意义）
 *   - 重连成功后把所有 pending 原样重发（ack 状态未知，靠幂等消化重复）
 *
 * 与教学版差异：sendCommand 返回 Promise —— UI 要 await 之后决定
 * 是否回滚乐观更新（"指令下发成功 ≠ 设备已执行"）。
 */
import type { Plugin } from '../core/ws-core';
import type { AckPayload, ClientMessage } from '../protocol';

interface PendingItem {
  seq: number;
  build: (seq: number) => ClientMessage;
  timer: ReturnType<typeof setTimeout> | null;
  retry: number;
  resolve: (ack: AckPayload) => void;
  reject: (err: Error) => void;
}

export class CommandRejectedError extends Error {
  constructor(readonly ack: AckPayload) {
    super(ack.msg ?? `指令被设备拒绝（code=${ack.code ?? 'unknown'}）`);
    this.name = 'CommandRejectedError';
  }
}

export function reliablePlugin(): Plugin {
  return {
    name: 'reliable',
    setup(ctx) {
      let seq = 0;
      const pending = new Map<number, PendingItem>();

      const ackTimeout = () => ctx.opts.ackTimeout ?? 3_000;
      const maxRetry = () => ctx.opts.maxRetry ?? 3;

      const send = (item: PendingItem) => {
        if (item.timer) clearTimeout(item.timer);
        ctx.sendRaw(item.build(item.seq)); // 绕过背压：指令小、不能丢
        item.timer = setTimeout(() => {
          if (!pending.has(item.seq)) return; // 已 ack，本次重发作废
          if (item.retry >= maxRetry()) {
            pending.delete(item.seq);
            ctx.emit('command:failed', {
              seq: item.seq,
              retry: item.retry,
              reason: 'retry-exhausted',
            });
            item.reject(new Error(`指令 seq=${item.seq} 重试 ${item.retry} 次仍无 ack`));
            return;
          }
          item.retry += 1;
          ctx.emit('command:retry', { seq: item.seq, retry: item.retry });
          send(item);
        }, ackTimeout());
      };

      ctx.onMessage((msg) => {
        if (msg?.type !== 'ack') return;
        const it = pending.get(msg.payload.seq);
        if (!it) return true; // 迟到 / 重复的 ack：忽略但消费掉
        pending.delete(it.seq);
        if (it.timer) clearTimeout(it.timer);
        ctx.emit('command:settled', { seq: it.seq, ok: msg.payload.ok });
        if (msg.payload.ok) it.resolve(msg.payload);
        else it.reject(new CommandRejectedError(msg.payload));
        return true; // 已消费
      });

      // 重连后：pending 全是"ack 状态未知"的指令 → 同一 seq 重发（幂等消化重复）
      ctx.onOpen(() => {
        if (!ctx.shared.isReopen) return;
        for (const item of pending.values()) {
          ctx.emit('command:resend', { seq: item.seq });
          send(item);
        }
      });

      ctx.onTeardown(() => {
        for (const item of pending.values()) {
          if (item.timer) clearTimeout(item.timer);
        }
        pending.clear();
      });

      // expose：client.sendCommand(seq => cmd.setMuted(seq, ...))
      ctx.expose('sendCommand', (build: (seq: number) => ClientMessage) => {
        return new Promise<AckPayload>((resolve, reject) => {
          const id = ++seq;
          const item: PendingItem = { seq: id, build, timer: null, retry: 0, resolve, reject };
          pending.set(id, item);
          send(item);
        });
      });

      ctx.expose('getPendingCount', () => pending.size);
    },
  };
}
