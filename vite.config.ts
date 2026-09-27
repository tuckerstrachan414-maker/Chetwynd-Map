import { defineConfig } from 'vitest/config';

// Relative base so the build works both at the GitHub Pages sub-path and locally.
export default defineConfig({
  base: './',
  assetsInclude: ['**/*.glsl', '**/*.ktx2', '**/*.bin'],
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 4000,
  },
  worker: { format: 'es' },
  server: { host: true },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
