/**
 * ⑧ 会话插件：把「一条通的连接」升级成「一次可用的会话」
 *
 * 连接通了 ≠ 数据是对的：断线这几十秒里，设备可能已经被别人改过音量、
 * 可能已经离线。所以每次 onOpen 都要做两件事：
 *   1. 重新订阅（服务端不保留断线前的订阅关系）
 *   2. 拉 REST 快照覆盖本地状态（补上断线期间错过的变更）
 *
 * ⚠️ 插件协议要求钩子必须是同步的（guard 只兜同步异常），
 *    所以这里的异步逻辑自己 fire-and-forget + 自己 catch。
 */
import type { Plugin } from '../core/ws-core';
import { cmd } from '../protocol';
import type { Device } from '../protocol';

export function sessionPlugin(): Plugin {
  return {
    name: 'session',
    setup(ctx) {
      const resync = async () => {
        const res = await fetch(ctx.opts.snapshotUrl as string);
        if (!res.ok) throw new Error(`快照请求失败：HTTP ${res.status}`);
        const devices = (await res.json()) as Device[];
        ctx.emit('session:snapshot', { devices, isReopen: ctx.shared.isReopen });
        return devices;
      };

      ctx.onOpen(() => {
        // 1) 重新订阅：走 send()（受背压/outbox 约束），非可靠指令
        ctx.send(cmd.subscribe(0, ['*']));

        // 2) REST 快照对齐（异步，自己 catch —— guard 兜不住 Promise）
        void resync().catch((err: unknown) => {
          // 快照失败不致命：WS 推送会继续进来，下次重连会再试
          ctx.emit('session:snapshot-failed', { msg: String(err) });
        });
      });

      ctx.expose('resync', resync);
    },
  };
}
