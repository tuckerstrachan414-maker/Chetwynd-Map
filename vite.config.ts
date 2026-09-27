import { defineConfig } from 'vitest/config';

export default defineConfig({
    // Relative asset paths so the same build works at the site root or under a
    // sub-path such as GitHub Pages (https://<user>.github.io/Chetwynd-Map/).
    base: './',
    // MapLibre GL v6 loads its web worker as a sibling module located through
    // `import.meta.url`. Vite's dependency pre-bundler doesn't emit that sibling,
    // which leaves a blank map in dev, so MapLibre is served from its own package.
    optimizeDeps: {
        exclude: ['maplibre-gl'],
    },
    // MapLibre starts its worker with `{ type: 'module' }` (see src/main.ts).
    worker: {
        format: 'es',
    },
    build: {
        target: 'es2022',
        sourcemap: true,
        // MapLibre GL alone is ~1.1 MB minified (~290 kB gzipped); it gets its own long-cached chunk.
        chunkSizeWarningLimit: 1200,
        rolldownOptions: {
            output: {
                codeSplitting: {
                    groups: [
                        { name: 'maplibre', test: /node_modules[\\/]maplibre-gl/ },
                        { name: 'tomtom-sdk', test: /node_modules[\\/](@tomtom-org|@turf|lodash-es|zod)/ },
                    ],
                },
            },
        },
    },
    test: {
        environment: 'jsdom',
        include: ['tests/unit/**/*.test.ts'],
    },
});
