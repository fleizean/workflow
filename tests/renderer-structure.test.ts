// ARCH-02/ARCH-03/ARCH-05 and SPA-01, read off the renderer tree itself. Lint enforces the same directions on any
// file that could be written (tests/lint-coverage.test.ts); these are the claims about the tree as it stands, which
// lint has no way to make - that a route table exists, that something calls the facade, that a specifier resolves
// inside the feature that wrote it.

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { read, readAliases, repoRoot, resolveModuleFile, stripCommentsAndStrings } from './helpers/ts-imports';

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

    /*
     * Resolved, not matched. Lint refuses `@renderer/features/<other>/...`, which is how a cross-feature import is
     * actually written - but from inside features/shell/api the same file is `../../timer/state/timer.store`, and
     * no import-path pattern can see that one. Resolving each specifier to a repository path closes the gap that
     * lint structurally cannot.
     */
    it('imports another feature only through its index.ts, whatever the specifier looks like', () => {
        const aliases = readAliases('electron.vite.config.ts', ['renderer', 'resolve', 'alias']);
        const featureOf = (file: string): string | undefined =>
            /^src\/renderer\/src\/features\/([^/]+)/.exec(file)?.[1];

        const offenders: string[] = [];
        let resolved = 0;
        for (const file of rendererSources()) {
            const own = featureOf(file);
            for (const value of literalsOf(file)) {
                const target = resolveModuleFile(file, value, aliases);
                if (target === undefined) {
                    continue;
                }
                resolved += 1;
                const targetFeature = featureOf(target);
                if (targetFeature === undefined || targetFeature === own) {
                    continue;
                }
                const surface = 'src/renderer/src/features/' + targetFeature + '/index.ts';
                if (target !== surface) {
                    offenders.push(file + ' -> ' + target);
                }
            }
        }
        expect(resolved, 'no specifier resolved to a file, so this scan proves nothing').toBeGreaterThan(10);
        expect(offenders, 'a feature is reached past its public surface (ARCH-03)').toEqual([]);
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

/*
 * Criterion 1's other half, and SPA-15.
 *
 * The v1.2.1 renderer is MOVED, not deleted - Phase 8 ticks the parity checklist against it and SPA-14 deletes it
 * then. The four page fragments are the exception: nothing in the repository has ever referenced them (the Phase 1
 * inventory found exactly one mention, in RESTRUCTURE-BRIEF.md, flagging them as dead), so they are deleted here
 * rather than carried. "Moved" and "deleted" are different claims, so they are asserted separately.
 *
 * The unused-preload-API half of SPA-15 is not here. The four v1.2.1 APIs that were exposed and never called are
 * dispositioned one by one in tests/ipc-parity.test.ts, and tests/preload-bridge.test.ts holds the v2 bridge's
 * surface equal to the contract's channel list - so an unused API cannot exist in the v2 preload without a contract
 * channel to match it. Deleting the five entries from the frozen preload.js would destroy the reference those two
 * files are measured against.
 */
describe('criterion 1 / SPA-15: the v1.2.1 renderer moved, and the dead fragments did not come with it', () => {
    const LEGACY_PAGES = 'legacy/pages';
    const LIVE_PAGES = ['companies.html', 'index.html', 'settings.html', 'work-history.html'];

    it('has no v1.2.1 renderer left under src/', () => {
        const survivors = ['src/pages', 'src/styles'].filter((dir) => exists(dir));
        expect(survivors, 'these belong under legacy/ now (criterion 1)').toEqual([]);

        const flatScripts = tracked(RENDERER).filter((file) => /^src\/renderer\/[^/]+\.js$/.test(file));
        expect(flatScripts, 'the v1.2.1 flat renderer scripts are back inside the v2 renderer root').toEqual([]);
    });

    it('kept exactly the four pages Phase 8 ticks its parity checklist against', () => {
        expect(fs.readdirSync(path.join(repoRoot, LEGACY_PAGES)).sort()).toEqual(LIVE_PAGES);
    });

    it('deleted the four unreferenced page fragments rather than moving them', () => {
        const surviving = [
            'src/pages/fragments', 'legacy/pages/fragments', 'legacy/fragments'
        ].filter((dir) => exists(dir));
        expect(
            surviving,
            'SPA-15 removes the dead fragments. Moving them would keep 226 lines of markup that nothing has ever ' +
            'loaded, in the one directory a later reader would mistake for a source of truth.'
        ).toEqual([]);
    });

    /*
     * The deletion had to leave the CUSTODY-09 inventory untouched, and it did: the fragments held no
     * addEventListener and no window.api call, so 106/21/67 are unchanged. tests/inventory.test.ts recomputes all
     * three from legacy/ and compares them element-wise with the committed artifacts, which is the real guard -
     * this is the pointer to it, so a reader of criterion 1 is not left wondering whether the counts moved.
     */
    it('kept the behaviour inventory measurable, by moving what the inventory counts', () => {
        for (const artifact of ['baselines/v1.2.1/handlers.tsv', 'baselines/v1.2.1/api-calls.tsv']) {
            const rows = read(artifact).split('\n').filter((row) => row.trim() !== '');
            expect(rows.length, artifact + ' is empty, so the inventory cannot be recomputed').toBeGreaterThan(0);
            const stale = rows.filter((row) => !row.startsWith(LEGACY_PAGES + '/') && !row.startsWith('legacy/renderer/'));
            expect(stale.slice(0, 3), artifact + ' still cites files at their pre-cutover paths').toEqual([]);
        }
    });
});

/*
 * Criterion 4's last mile. tests/renderer-data-path.test.ts RUNS the data path - a failing handler, the real
 * facade, the real query objects, the real client - but it cannot render a component, because this project has no
 * jsdom. So the two joints between what is executed and what is mounted are asserted here on the source: that the
 * hooks hand useQuery the very objects the other file executes, and that the subscription is mounted once, from a
 * provider, inside the client it invalidates.
 */
describe('criterion 4: the executed data path is the mounted one', () => {
    const APP = path.posix.join(SRC, 'app/App.tsx');
    const SYNC = path.posix.join(SRC, 'app/providers/DataSyncProvider.tsx');
    const CHANGED_EVENT = 'data:changed';

    const apiFiles = (): string[] => rendererSources().filter((file) => /^features\/[^/]+\/api$/.test(areaOf(file)));

    it('passes useQuery a named object, never one written out at the call site', () => {
        const callers = apiFiles().filter((file) => /\buseQuery\s*\(/.test(codeOf(file)));
        expect(callers.length, 'no feature calls useQuery, so this scan proves nothing').toBeGreaterThan(2);

        const offenders = callers.filter((file) => !/\buseQuery\s*\(\s*[A-Za-z_$][\w$]*\s*\)/.test(codeOf(file)));
        expect(
            offenders,
            'an options object written inline cannot be executed by a test, so "a failed call renders an error ' +
            'state" would be a claim about a copy of the code rather than about the code (SPA-05).'
        ).toEqual([]);
    });

    it('exports that object, so the test runs the same one the hook passes in', () => {
        const offenders = apiFiles()
            .filter((file) => /\buseQuery\s*\(/.test(codeOf(file)))
            .filter((file) => {
                const named = /\buseQuery\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/.exec(codeOf(file))?.[1] ?? '';
                return !new RegExp('export\\s+const\\s+' + named + '\\b').test(codeOf(file));
            });
        expect(offenders, 'the object handed to useQuery is not exported').toEqual([]);
    });

    it('subscribes to ' + CHANGED_EVENT + ' exactly once, and from app/providers', () => {
        const subscribers = rendererSources()
            .filter((file) => literalsOf(file).includes(CHANGED_EVENT));
        expect(
            subscribers,
            'a second subscriber invalidates twice per event; a subscriber inside a screen stops when that screen ' +
            'unmounts, which is every route change (SPA-07)'
        ).toEqual([SYNC]);
        expect(codeOf(SYNC), 'the provider does not invalidate anything').toContain('invalidateDomains');
    });

    it('mounts that provider inside the client it invalidates', () => {
        const app = codeOf(APP);
        const query = app.indexOf('<QueryProvider>');
        const sync = app.indexOf('<DataSyncProvider>');
        expect(query, 'App.tsx no longer mounts QueryProvider').toBeGreaterThan(-1);
        expect(
            sync,
            'App.tsx does not mount DataSyncProvider, so nothing listens for a change made in main'
        ).toBeGreaterThan(-1);
        expect(
            sync > query,
            'DataSyncProvider is outside QueryProvider, so useQueryClient would throw on the first render'
        ).toBe(true);
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

/*
 * Criterion 5. v1.2.1 defined showAlert twice (legacy/pages/index.html:514, settings.html:387), hand-built an
 * overlay at six sites across three pages, and capped the shell and the bottom navigation at two different widths.
 * These are the four claims that replaces, each read off the tree rather than off a reviewer's memory.
 */
describe('criterion 5: one Modal, one Toast, one alert, one width', () => {
    const UI = 'components/ui';
    const MODAL = path.posix.join(SRC, UI, 'Modal.tsx');
    const SHELL = path.posix.join(SRC, 'components/layout/AppShell.tsx');
    const NAV = path.posix.join(SRC, 'components/layout/BottomNav.tsx');
    const WIDTH_TOKEN = '--container-app';
    const WIDTH_UTILITY = 'max-w-app';

    /** Component declarations only - an uppercase name, which is what React calls a component. */
    const componentsNamed = (file: string, word: RegExp): string[] =>
        [...codeOf(file).matchAll(/\b(?:function|const|class)\s+([A-Z][A-Za-z0-9_]*)/g)]
            .map((match) => match[1] ?? '')
            .filter((name) => word.test(name));

    it('declares every modal, dialog, alert and toast component in ' + UI, () => {
        const word = /Modal|Dialog|Alert|Toast/;
        const offenders = rendererSources()
            .filter((file) => areaOf(file) !== UI && componentsNamed(file, word).length > 0)
            .map((file) => file + ' -> ' + componentsNamed(file, word).join(', '));
        expect(offenders, 'a screen with its own dialog is how v1.2.1 ended up with two showAlerts').toEqual([]);
    });

    it('draws exactly one overlay, and it is ' + MODAL, () => {
        const overlays = rendererSources()
            .filter((file) => literalsOf(file).some((value) => value.includes('fixed inset-0')));
        expect(overlays, 'a second full-screen overlay is a second modal, whatever it is called').toEqual([MODAL]);
    });

    it('asks nothing through the browser\'s own alert or confirm', () => {
        const offenders = rendererSources()
            .filter((file) => /\b(?:window\s*\.\s*)?(?:alert|confirm)\s*\(/.test(codeOf(file)));
        expect(offenders, 'a native dialog blocks the renderer and looks nothing like the app').toEqual([]);
    });

    it('bounds that modal by the window and lets it scroll inside it (SPA-03)', () => {
        const classes = literalsOf(MODAL).join(' ');
        expect(classes, 'a dialog taller than the window puts its own buttons out of reach').toContain('max-h-full');
        expect(classes).toContain('overflow-y-auto');
    });

    it('has the one alert implementation the two scans above are about', () => {
        expect(exists(MODAL), MODAL + ' does not exist, so this whole block proves nothing').toBe(true);
        expect(exists(path.posix.join(SRC, UI, 'AlertDialog.tsx'))).toBe(true);
        expect(exists(path.posix.join(SRC, UI, 'ToastStack.tsx'))).toBe(true);
    });

    it('takes the shell and the bottom navigation from one width token', () => {
        expect(read(GLOBALS), GLOBALS + ' no longer declares ' + WIDTH_TOKEN).toContain(WIDTH_TOKEN + ':');
        for (const file of [SHELL, NAV]) {
            const classes = literalsOf(file).join(' ');
            expect(classes, file + ' does not read the one width token').toContain(WIDTH_UTILITY);
            expect(
                classes,
                file + ': the 448/430 mismatch is back. Both widths must come from ' + WIDTH_TOKEN + ' (SPA-02).'
            ).not.toMatch(/max-w-(?:md|sm|lg|xl|\[)/);
        }
    });
});
