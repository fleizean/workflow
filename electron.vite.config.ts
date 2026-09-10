// Three build targets. Deliberately absent: externalizeDepsPlugin (default in electron-vite 5), the @electron-toolkit
// presets (their base sets noImplicitAny false) and "type": "module" (a sandboxed preload must stay CommonJS).

import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
    main: {
        resolve: {
            alias: {
                '@main': resolve(__dirname, 'src/main'),
                '@lib': resolve(__dirname, 'src/lib'),
                '@shared': resolve(__dirname, 'src/shared')
            }
        },
        build: {
            rollupOptions: {
                // A native addon is never bundled; named so a dependency move cannot break its .node resolution (BUILD-05).
                external: ['better-sqlite3']
            }
        }
    },
    preload: {
        resolve: {
            alias: {
                '@shared': resolve(__dirname, 'src/shared')
            }
        }
    },
    renderer: {
        resolve: {
            alias: {
                '@renderer': resolve(__dirname, 'src/renderer/src'),
                '@shared': resolve(__dirname, 'src/shared')
            }
        },
        plugins: [react(), tailwindcss()]
    }
});
