/**
 * ④ 心跳插件：保活 + 探测，一次 send 完成两件事
 *
 * 为什么必须是"应用层"心跳：
 *   浏览器 WebSocket API 不暴露协议层 ping/pong（JS 既发不出 ping 帧、
 *   也监听不到 pong 帧，浏览器底层自动应答）——应用层心跳是唯一手段。
 *
 * 两个工程细节：
 *   1. 链式 setTimeout 而不是 setInterval：后台标签页定时器被节流时，
 *      setInterval 会攒着一起来（漂移），链式能自然拉长间隔；
 *   2. 连续 missed 才判死（默认 2 次）：一次超时可能只是网络抖动，
 *      直接判死会造成无谓重连。
 *
 * 判死动作：主动 close(1000) —— 把"半开连接"伪装成一次正常断开，
 * 好让 onclose 触发、重连插件接管。code 是 1000 而不是 1006（这是自测点）。
 */
import type { Plugin } from '../core/ws-core';
import { clientPolicy } from '../protocol';

export function heartbeatPlugin(): Plugin {
  return {
    name: 'heartbeat',
    setup(ctx) {
      let tickTimer: ReturnType<typeof setTimeout> | null = null;
      let pongTimer: ReturnType<typeof setTimeout> | null = null;
      let missed = 0;
      let sentAt = 0;

      const stop = () => {
        if (tickTimer) clearTimeout(tickTimer);
        if (pongTimer) clearTimeout(pongTimer);
        tickTimer = null;
        pongTimer = null;
        missed = 0;
      };

      const scheduleTick = () => {
        tickTimer = setTimeout(() => {
          tickTimer = null;
          probe();
          if (ctx.isOpen()) scheduleTick();
        }, ctx.opts.heartbeatInterval ?? clientPolicy.heartbeat.intervalMs);
      };

      const probe = () => {
        if (pongTimer) {
          clearTimeout(pongTimer);
          pongTimer = null; // 清未决等待：迟到的 pong 不该误判上一轮
        }
        sentAt = Date.now();
        // 心跳走 sendRaw：绕过背压/outbox，任何情况下都要能发出
        const ok = ctx.sendRaw(ctx.opts.buildPing());
        if (!ok) return; // 发不出去 → 交给 onclose 处理

        pongTimer = setTimeout(() => {
          pongTimer = null;
          missed += 1;
          ctx.emit('heartbeat:missed', { missed });
          if (missed >= (ctx.opts.maxMissed ?? clientPolicy.heartbeat.maxMissed)) {
            // ⚠️ 先取数再 stop()：stop() 会把 missed 清零，先 stop 再上报
            // 会让面板显示"连续 0 次无 pong 判定假死"（自己抓到的 bug，见 tests/heartbeat.test.ts）
            const missedCount = missed;
            stop();
            ctx.emit('heartbeat:dead', { missed: missedCount });
            // 主动关（不是 1006）：把"半开连接"伪装成一次正常断开，好让重连插件接管
            ctx.closeConnection(clientPolicy.heartbeat.deadCloseCode, 'heartbeat timeout');
          }
        }, ctx.opts.heartbeatTimeout ?? clientPolicy.heartbeat.timeoutMs);
      };

      ctx.onOpen(() => {
        missed = 0;
        stop();
        scheduleTick();
      });
      ctx.onClose(() => stop());
      ctx.onTeardown(stop);

      // 事件式解耦：visibility 插件 emit('probe:now')，不直接跨插件调用
      ctx.on('probe:now', () => {
        if (ctx.isOpen()) probe();
      });

      ctx.onMessage((msg) => {
        if (!ctx.opts.isPong(msg)) return;
        missed = 0;
        if (pongTimer) {
          clearTimeout(pongTimer);
          pongTimer = null;
        }
        ctx.emit('heartbeat:rtt', { rtt: Date.now() - sentAt });
        return true; // 已消费：pong 不下传给业务层
      });
    },
  };
}
