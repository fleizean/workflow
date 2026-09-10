/*
 * electron.vite.config.ts - the three build targets.
 *
 *   main      src/main/index.ts        -> out/main/index.js   (package.json `main`)
 *   preload   src/preload/index.ts     -> out/preload/index.js
 *   renderer  src/renderer/index.html  -> out/renderer/index.html
 *
 * Entry points are electron-vite conventions, not configuration, so none is named below.
 *
 * Deliberately absent, each for a reason someone will otherwise re-derive the wrong way:
 *
 * - externalizeDepsPlugin. electron-vite 5 deprecates it; externalization is on by default.
 *   Tutorials and the daltonmenezes/electron-app template predate that and still call it.
 *
 * - @electron-toolkit/tsconfig, @electron-toolkit/utils and @electron-toolkit/preload. The tsconfig
 *   preset's base sets noImplicitAny to false, which quietly guts `strict` - the property BUILD-02
 *   exists to guarantee. tsconfig.node.json and tsconfig.web.json are written by hand instead, with
 *   strict and noImplicitAny both stated explicitly, which removes the trap at its source rather
 *   than overriding it and hoping nobody deletes the override. Those two files are kept free of
 *   comments on purpose: plan 02-02's guard JSON-parses them, because a text search cannot tell a
 *   commented-out option from a live one - so the reasoning lives here instead. The utils package
 *   would supply an is-dev flag; src/main/userdata-path.ts reads app.isPackaged directly, because
 *   that is exactly the property D-09's guarantee is stated in.
 *
 * - "type": "module" in package.json. A sandboxed preload cannot be an ES module, so the package
 *   stays CommonJS and electron-vite emits CommonJS for main and preload.
 */

import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
    main: {
        resolve: {
            alias: {
                '@main': resolve('src/main'),
                '@lib': resolve('src/lib'),
                '@shared': resolve('src/shared')
            }
        },
        build: {
            rollupOptions: {
                // A native addon must never be bundled. Externalization already covers everything
                // in `dependencies`; naming it here means a future dependency move cannot silently
                // break the .node resolution the packaged smoke launch depends on (BUILD-05).
                external: ['better-sqlite3']
            }
        }
    },
    preload: {
        resolve: {
            alias: {
                '@shared': resolve('src/shared')
            }
        }
        // Output format stays at the default, CommonJS: a sandboxed preload cannot be ESM.
    },
    renderer: {
        resolve: {
            alias: {
                '@renderer': resolve('src/renderer/src'),
                '@shared': resolve('src/shared')
            }
        },
        plugins: [react(), tailwindcss()]
    }
});
