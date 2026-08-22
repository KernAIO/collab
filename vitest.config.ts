import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Each suite migrates a scratch database and drives real WebSocket clients.
    testTimeout: 30_000,
    hookTimeout: 120_000,
    maxWorkers: 2,
    minWorkers: 1,
    env: { NODE_ENV: 'test', LOG_LEVEL: process.env.LOG_LEVEL ?? 'silent' },
  },
})
