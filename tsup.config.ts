import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  clean: true,
  minify: false,
  treeshake: true,
  banner: {
    js: '#!/usr/bin/env node',
  },
});
