import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    /**
     * 比默认宽：`tests/gateway-frames.test.ts` 会真的起一个 Mock 网关子进程、
     * 连上去收几帧再校验 —— 那是契约测试里唯一"不是自己跟自己比"的一环。
     */
    testTimeout: 20_000,
  },
});
