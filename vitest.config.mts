import { defineConfig } from 'vitest/config';

// The .mts extension is deliberate and load-bearing. This package is CommonJS and must stay
// that way: a sandboxed Electron preload cannot be an ES module, and main.js, preload.js and
// database/db.js all use require(). Named vitest.config.ts, Vite loads this file as CommonJS,
// warns about the ESM syntax above, and suggests adding "type": "module" — the one change that
// would break the preload. The .mts extension removes the warning with no other cost.
export default defineConfig({
    test: {
        environment: 'node',
        include: ['tests/**/*.test.ts'],
        globals: false,
        testTimeout: 20_000,
        // Plan 01-07's WAL fixture forks a child process; keep worker isolation predictable.
        pool: 'forks'
    }
});
