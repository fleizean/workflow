// .mts on purpose: the package stays CommonJS (a sandboxed preload cannot be ESM), and as .ts Vite would load this
// ESM file as CommonJS and suggest "type": "module".
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    resolve: {
        alias: {
            '@main': resolve(import.meta.dirname, 'src/main'),
            '@lib': resolve(import.meta.dirname, 'src/lib'),
            '@shared': resolve(import.meta.dirname, 'src/shared')
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
