// ARCH-02/ARCH-03/ARCH-05 and SPA-01, read off the renderer tree itself. The lint rules that enforce the same
// directions arrive with slice F; these are the shape assertions, which lint cannot make.

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { read, repoRoot, stripCommentsAndStrings } from './helpers/ts-imports';

const RENDERER = 'src/renderer';
const SRC = 'src/renderer/src';
const ROUTER = 'src/renderer/src/app/router.tsx';
const GLOBALS = 'src/renderer/src/styles/globals.css';
const ENTRY = 'src/renderer/index.html';

// The Phase 2 folder criterion 6 requires to be gone: one route table, and it lives in app/.
const PHASE_2_ROUTES = 'src/renderer/src/routes';

const exists = (rel: string): boolean => fs.existsSync(path.join(repoRoot, rel));

/** Git-known, committed or not, so a file added by the very change this guards is already visible. */
const tracked = (...dirs: string[]): string[] =>
    execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', ...dirs], {
        cwd: repoRoot,
        encoding: 'utf8'
    })
        .split('\n')
        .map((line) => line.trim())
        .filter((file) => file !== '' && exists(file));

const rendererSources = (): string[] => tracked(SRC).filter((file) => /\.tsx?$/.test(file));

const featureDirs = (): string[] =>
    fs.readdirSync(path.join(repoRoot, SRC, 'features'), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();

/** The folder of SRC a file sits in: src/renderer/src/features/timer/api/x.ts -> features/timer/api. */
const areaOf = (file: string): string => path.posix.dirname(file.slice(SRC.length + 1));

/*
 * Prose is not code. Every scan below reads either the comment-and-string-blanked source or the string literals
 * alone, never the raw text: a file whose header comment explains what v1.2.1's loadFile() did would otherwise
 * read as a file that calls it, and the guard would fail on its own documentation.
 */
const codeOf = (file: string): string => stripCommentsAndStrings(file, read(file)).code;
const literalsOf = (file: string): string[] =>
    stripCommentsAndStrings(file, read(file)).strings.map((token) => token.value);

describe('ARCH-02: the renderer is app/, features/, components/, store/ and lib/', () => {
    it('has every directory the layout names', () => {
        const missing = ['app', 'app/providers', 'components/layout', 'components/ui', 'features', 'lib', 'store']
            .filter((dir) => !exists(path.posix.join(SRC, dir)));
        expect(missing, 'ARCH-02 names these directories and they do not exist: ' + missing.join(', ')).toEqual([]);
    });

    it('no longer has the Phase 2 routes/ folder', () => {
        expect(
            exists(PHASE_2_ROUTES),
            PHASE_2_ROUTES + ' is back. Criterion 6 puts every route in ' + ROUTER + '; a second folder of route ' +
            'components is where a second route table starts.'
        ).toBe(false);
    });

    it('declares every route in one file, and that file is ' + ROUTER, () => {
        const declaring = rendererSources()
            .filter((file) => /<Route\b|create(?:Hash|Browser|Memory)Router\b/.test(codeOf(file)));
        expect(declaring, 'a route is declared outside the one route table').toEqual([ROUTER]);
    });

    it('routes on the hash, because a file URL has no server to rewrite a path', () => {
        const sources = rendererSources();
        expect(sources.some((file) => /\bHashRouter\b/.test(codeOf(file))), 'no HashRouter anywhere').toBe(true);
        const wrong = sources.filter((file) => /\bBrowserRouter\b/.test(codeOf(file)));
        expect(wrong, 'BrowserRouter under file:// blanks the window on the first reload (SPA-01)').toEqual([]);
    });

    it('gives every feature a public index.ts', () => {
        const features = featureDirs();
        expect(features.length, 'no features at all, so this scan proves nothing').toBeGreaterThan(0);
        const offenders = features.filter((name) => !exists(path.posix.join(SRC, 'features', name, 'index.ts')));
        expect(offenders, 'these features have no index.ts, so nothing can import them without reaching inside')
            .toEqual([]);
    });

    it('puts each feature only in the folders ARCH-02 names', () => {
        const ALLOWED = new Set(['api', 'components', 'hooks', 'state']);
        const offenders: string[] = [];
        for (const name of featureDirs()) {
            for (const entry of fs.readdirSync(path.join(repoRoot, SRC, 'features', name), { withFileTypes: true })) {
                if (entry.isDirectory() && !ALLOWED.has(entry.name)) {
                    offenders.push('features/' + name + '/' + entry.name);
                }
            }
        }
        expect(offenders, 'ARCH-02 names api, components, hooks and state; these are something else').toEqual([]);
    });
});

describe('ARCH-03: one direction of flow, asserted on the source', () => {
    // lib/ipc.ts IS the facade, so it is the one file that may name the bridge key.
    const FACADE = 'src/renderer/src/lib/ipc.ts';
    const BRIDGE_KEY = /window\s*(?:\.\s*api\b|\[\s*['"]api['"])|API_BRIDGE_KEY/;
    const FACADE_IMPORT = /^(?:@renderer\/lib\/ipc|(?:\.\.?\/)+lib\/ipc)$/;

    it('opens the preload bridge only in the facade', () => {
        const offenders = rendererSources()
            .filter((file) => file !== FACADE && BRIDGE_KEY.test(codeOf(file)));
        expect(offenders, 'these reach the bridge directly instead of going through lib/ipc.ts').toEqual([]);
    });

    it('calls the facade only from a feature api/ folder or from app/providers/', () => {
        const offenders = rendererSources()
            .filter((file) => file !== FACADE && literalsOf(file).some((value) => FACADE_IMPORT.test(value)))
            .filter((file) => {
                const area = areaOf(file);
                return !/^features\/[^/]+\/api$/.test(area) && !area.startsWith('app/providers');
            });
        expect(offenders, 'ARCH-03: only features/<domain>/api and app/providers may call the IPC facade').toEqual([]);
    });

    it('reads the facade from somewhere, so the two scans above are not vacuous', () => {
        const callers = rendererSources()
            .filter((file) => file !== FACADE && literalsOf(file).some((value) => FACADE_IMPORT.test(value)));
        expect(callers.length, 'nothing calls lib/ipc.ts, so the data path is not wired at all').toBeGreaterThan(0);
    });

    it('uses no web storage', () => {
        const offenders = rendererSources()
            .filter((file) => /\b(?:localStorage|sessionStorage)\b/.test(codeOf(file)));
        expect(
            offenders,
            'v1.2.1 kept the timer and the goal date in localStorage, which main cannot read and a cleared ' +
            'profile forgets. Everything durable belongs in the database (ARCH-03).'
        ).toEqual([]);
    });

    it('imports another feature only through its index.ts', () => {
        const offenders: string[] = [];
        for (const file of rendererSources()) {
            const own = /^features\/([^/]+)/.exec(areaOf(file))?.[1];
            for (const value of literalsOf(file)) {
                const match = /^@renderer\/features\/(.+)$/.exec(value);
                if (match === null) {
                    continue;
                }
                const target = match[1] ?? '';
                const feature = target.split('/')[0] ?? '';
                if (feature !== own && target !== feature) {
                    offenders.push(file + ' -> @renderer/features/' + target);
                }
            }
        }
        expect(offenders, 'a feature is reached past its public surface').toEqual([]);
    });

    it('imports nothing from the retired v1.2.1 tree', () => {
        const offenders = rendererSources()
            .filter((file) => literalsOf(file).some((value) => value.includes('legacy/')));
        expect(offenders, 'the v2 renderer must not depend on the tree Phase 8 deletes').toEqual([]);
    });
});

describe('SPA-01: one document, and screens change inside it', () => {
    it('has exactly one HTML entry under ' + RENDERER, () => {
        // public/legacy-storage.html is the hidden extractor's page, not a screen.
        const entries = tracked(RENDERER).filter((file) => file.endsWith('.html') && !file.includes('/public/'));
        expect(entries).toEqual([ENTRY]);
    });

    it('loads its script module from the one bootstrap', () => {
        const entry = read(ENTRY);
        expect(entry).toContain('src="/src/app/main.tsx"');
    });

    it('never asks the main process to load a page', () => {
        const offenders = rendererSources()
            .filter((file) => /\bloadFile\b|\bnavigateTo\b|location\s*\.\s*href\s*=/.test(codeOf(file)));
        expect(offenders, 'S1: a page argument that reaches loadFile is the path traversal the SPA deletes')
            .toEqual([]);
    });
});

describe('ARCH-05: one stylesheet under ' + RENDERER, () => {
    it('has exactly one .css file, and it is ' + GLOBALS, () => {
        const stylesheets = tracked(RENDERER).filter((file) => file.endsWith('.css'));
        expect(
            stylesheets,
            'Styling is Tailwind utilities on components. A second stylesheet is where per-component classes start.'
        ).toEqual([GLOBALS]);
    });

    it('has no CSS module', () => {
        expect(tracked(RENDERER).filter((file) => file.endsWith('.module.css'))).toEqual([]);
        const importers = rendererSources()
            .filter((file) => literalsOf(file).some((value) => value.endsWith('.module.css')));
        expect(importers, 'a CSS module import with no file is still a CSS module (ARCH-05)').toEqual([]);
    });
});
