// .mts on purpose: the package stays CommonJS (a sandboxed preload cannot be ESM), and as .ts Vite would load this
// ESM file as CommonJS and suggest "type": "module".
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    // Every alias the build declares, for every target. The renderer ones arrived with SPA-05: proving that a failed
    // IPC call ends in an error state means running the renderer's own query objects, and those import @renderer.
    resolve: {
        alias: {
            '@main': resolve(import.meta.dirname, 'src/main'),
            '@lib': resolve(import.meta.dirname, 'src/lib'),
            '@shared': resolve(import.meta.dirname, 'src/shared'),
            '@renderer': resolve(import.meta.dirname, 'src/renderer/src'),
            '@assets': resolve(import.meta.dirname, 'src/assets')
        }
    },
    test: {
        environment: 'node',
        include: ['tests/**/*.test.ts'],
        globals: false,
        testTimeout: 20_000,
        // Plan 01-07's WAL fixture forks a child process; keep worker isolation predictable.
        pool: 'forks'
    }
});
