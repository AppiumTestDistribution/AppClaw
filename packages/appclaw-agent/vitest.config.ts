import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: __dirname,
  resolve: {
    alias: {
      'appclaw/agent-runtime': resolve(__dirname, '../../src/agent-runtime/index.ts'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
