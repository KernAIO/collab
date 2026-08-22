import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    // services carry no unit tests yet; the suites land with the features they cover
    passWithNoTests: true,
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
})
