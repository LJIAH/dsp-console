/**
 * ⑨ 探活插件：页面可见性 / 网络恢复时的主动验证
 *
 * 移动端（尤其 iOS）切后台会掐断连接，`online` 切换是静默断开 ——
 * 这两种情况下 readyState 都可能还停在 OPEN（半开连接）。
 * 总原则：**永远假设连接可能已经死了**，前台/网络恢复时主动验证一次。
 *
 * 与 heartbeat 插件的解耦方式：不直接调用对方的方法，
 * 而是 emit('probe:now') —— heartbeat 订阅它，插件之间无编译期依赖。
 */
import type { Plugin } from '../core/ws-core';

export function visibilityPlugin(): Plugin {
  return {
    name: 'visibility',
    setup(ctx) {
      const verify = () => {
        if (!ctx.isOpen()) {
          ctx.connect(); // 幂等：真的断了才新建（重连插件也会兜底）
        } else {
          // 可能假死（可见 ≠ 活着）：立刻探一次，不等下个心跳周期
          ctx.emit('probe:now');
        }
      };

      const onVisibility = () => {
        if (document.visibilityState === 'visible') verify();
      };

      document.addEventListener('visibilitychange', onVisibility);
      window.addEventListener('online', verify);

      ctx.onTeardown(() => {
        document.removeEventListener('visibilitychange', onVisibility);
        window.removeEventListener('online', verify);
      });
    },
  };
}
