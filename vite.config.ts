import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * 构建选型：Vite（不是 Next.js）。
 *
 * 这个应用 100% 是浏览器端逻辑（长连接 / 高频渲染 / 本地分析），
 * SSR/RSC/文件路由在这里没有收益；而 Next 至今没有内置的 WS 服务端，
 * 连接层只能靠独立进程 —— 那不如把边界画清楚：
 *   前端 = 纯静态 SPA（Vite 构建），网关 = 独立 Node 进程（server/）。
 * 这正好复刻真实 B/S 上位机的拓扑：浏览器 ← 网关 ← 设备。
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // 真机演示：手机连同一局域网访问（跨端适配的现场验证）
    host: true,
  },
});
