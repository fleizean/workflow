// ARCH-02/ARCH-03/ARCH-05 and SPA-01, read off the renderer tree itself. Lint enforces the same directions on any
// file that could be written (tests/lint-coverage.test.ts); these are the claims about the tree as it stands, which
// lint has no way to make - that a route table exists, that something calls the facade, that a specifier resolves
// inside the feature that wrote it.

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { read, readAliases, repoRoot, resolveModuleFile, stripCommentsAndStrings } from './helpers/ts-imports';
import { listV121 } from './helpers/v121-source';

const RENDERER = 'src/renderer';
const SRC = 'src/renderer/src';
const ROUTER = 'src/renderer/src/app/router.tsx';
const GLOBALS = 'src/renderer/src/styles/globals.css';
const TICKS = 'src/renderer/src/app/providers/timer-feed.ts';
const TICK_PROVIDER = 'src/renderer/src/app/providers/TimerProvider.tsx';
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
            // IN-06: useRoutes([{ path, element }]) is a route table that names no <Route and no createRouter.
            .filter((file) => /<Route\b|create(?:Hash|Browser|Memory)Router\b|\buseRoutes\s*\(/.test(codeOf(file)));
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

    /*
     * CR-03(b). A lifted area may CALL the facade; it may not hand it on. Each hop of
     *
     *   features/history/api/useSessions.ts   export { invoke } from '@renderer/lib/ipc'
     *   features/history/index.ts             export { invoke } from './api/useSessions'
     *   components/ui/Modal.tsx               import { invoke } from '@renderer/features/history'
     *
     * is individually legal, and together they put the bridge in any component. no-restricted-imports cannot see
     * it: the ban it would have to apply is the one the first hop lifts. So the rule is decided here instead, as
     * narrowly as closes the chain: no renderer file re-exports the facade, zustand or the query client.
     */
    it('never hands the facade, the store library or the query client on through an export', () => {
        const aliases = readAliases('electron.vite.config.ts', ['renderer', 'resolve', 'alias']);
        const LAUNDERED = /^(?:zustand|@tanstack\/react-query)(?:\/|$)|^@shared\/constants\/bridge$/;

        // Only an export-from, never a plain import: what a file re-exports is its own public surface.
        const reExportsOf = (file: string): string[] =>
            [...read(file).matchAll(/\bexport\s+(?:\*|\{[^}]*\})(?:\s+as\s+\w+)?\s*from\s*['"]([^'"]+)['"]/g)]
                .map((match) => match[1] ?? '');

        const offenders: string[] = [];
        let checked = 0;
        for (const file of rendererSources()) {
            for (const specifier of reExportsOf(file)) {
                checked += 1;
                if (LAUNDERED.test(specifier)) {
                    offenders.push(file + ' re-exports ' + specifier);
                    continue;
                }
                const target = resolveModuleFile(file, specifier, aliases);
                if (target === FACADE) offenders.push(file + ' re-exports the IPC facade');
            }
        }
        expect(checked, 'no file re-exports anything, so this scan proves nothing').toBeGreaterThan(5);
        expect(
            offenders,
            'a lifted area may call these; handing one on makes it reachable from every file that imports the ' +
            'feature, one legal hop at a time (ARCH-03)'
        ).toEqual([]);
    });

    it('imports nothing from the retired v1.2.1 tree', () => {
        const offenders = rendererSources()
            .filter((file) => literalsOf(file).some((value) => value.includes('legacy/')));
        expect(offenders, 'the v2 renderer must not depend on the tree Phase 8 deletes').toEqual([]);
    });
});

/*
 * Criterion 1's security half (S2), read off the tree. eslint.config.js refuses each of these in any renderer file
 * that could be written; this is the claim about the files that ARE written, and it is separate on purpose - a lint
 * rule proves what would be refused, not that nothing already present slipped in before the rule existed.
 *
 * What neither can prove is that the escaping actually happens, because there is no jsdom here.
 * tools/smoke-packaged.mjs does that against the packaged app.
 */
describe('criterion 1 / S2: the renderer never turns text into markup', () => {
    const HTML_SINKS = /\bdangerouslySetInnerHTML\b|\b(?:inner|outer)HTML\b|\binsertAdjacentHTML\b|\bdocument\s*\.\s*write(?:ln)?\s*\(/;

    it('reaches no HTML sink from any renderer source', () => {
        const offenders = rendererSources().filter((file) => HTML_SINKS.test(codeOf(file)));
        expect(
            offenders,
            'v1.2.1 built every row and every dialog with innerHTML and escaped one character of the values it ' +
            'interpolated. React escapes a child by construction; these are the doors around it.'
        ).toEqual([]);
    });

    it('would see one, so the scan above is not vacuous', () => {
        expect(HTML_SINKS.test('el.innerHTML = name;')).toBe(true);
        expect(HTML_SINKS.test('<div dangerouslySetInnerHTML={{ __html: x }} />')).toBe(true);
        expect(rendererSources().length, 'no renderer source was read at all').toBeGreaterThan(5);
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
 * then. The four page fragments are the exception: nothing in the repository has ever referenced them, so they are
 * deleted here rather than carried. "Moved" and "deleted" are different claims, asserted separately.
 *
 * The unused-preload-API half of SPA-15 is not here. The four v1.2.1 APIs exposed and never called are
 * dispositioned one by one in tests/ipc-parity.test.ts, and tests/preload-bridge.test.ts holds the v2 bridge's
 * surface equal to the contract's channel list. Deleting the five entries from the frozen preload.js would destroy
 * the reference those two files are measured against.
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

    /*
     * 08-F: SPA-14 deleted these. The claim is still worth making and is now two claims - the pages are gone
     * from the worktree, and the four the checklist was ticked against are still reachable, because that is
     * what keeps tests/inventory.test.ts able to recompute the counts it diffs. listV121 reads git when the
     * worktree cannot answer.
     */
    it('deleted the four pages Phase 8 ticked its parity checklist against, and left them readable', () => {
        expect(exists(LEGACY_PAGES), LEGACY_PAGES + ' is back in the worktree; SPA-14 deleted it').toBe(false);
        expect(
            listV121(LEGACY_PAGES).map((file) => file.slice(LEGACY_PAGES.length + 1)).sort(),
            'the four v1.2.1 pages are no longer reachable in git either, so the behaviour inventory cannot be recomputed and the parity checklist cites files nobody can open'
        ).toEqual(LIVE_PAGES);
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
     * three from legacy/ and compares them element-wise, which is the real guard; this is the pointer to it.
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
 * jsdom. So the two joints between what is executed and what is mounted are asserted here on the source.
 */
describe('criterion 4: the executed data path is the mounted one', () => {
    const APP = path.posix.join(SRC, 'app/App.tsx');
    const SYNC = path.posix.join(SRC, 'app/providers/DataSyncProvider.tsx');
    const CHANGED_EVENT = 'data:changed';
    /*
     * RENDERER CR-01. Every main-to-renderer event main pushes on its own schedule, not just the one this block was
     * written for. timer:tick was subscribed from TimerPage, so it was torn down on every navigation away from /
     * and the quit confirm then read a frozen snapshot - a persistFailing that flipped while the user was on
     * another screen left the confirm promising "Quitting keeps it".
     */
    const PUSHED_EVENTS = [CHANGED_EVENT, 'timer:tick', 'pomodoro:tick'];

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

    it.each(PUSHED_EVENTS)('subscribes to %s exactly once, and from app/providers', (event) => {
        const subscribers = rendererSources().filter((file) => literalsOf(file).includes(event));
        expect(subscribers.length, 'nothing subscribes to ' + event + ', so this scan proves nothing')
            .toBeGreaterThan(0);
        const misplaced = subscribers.filter((file) => !areaOf(file).startsWith('app/providers'));
        expect(
            misplaced,
            'a second subscriber acts twice per event; a subscriber inside a screen stops when that screen ' +
            'unmounts, which is every route change (SPA-07)'
        ).toEqual([]);
        expect(subscribers.length, event + ' is subscribed from more than one place').toBe(1);
    });

    it('invalidates from the ' + CHANGED_EVENT + ' provider, and feeds the store from the tick one', () => {
        expect(literalsOf(SYNC), CHANGED_EVENT + ' moved out of ' + SYNC).toContain(CHANGED_EVENT);
        expect(codeOf(SYNC), 'the provider does not invalidate anything').toContain('invalidateDomains');
        expect(literalsOf(TICKS), 'timer:tick moved out of ' + TICKS).toContain('timer:tick');
        expect(
            codeOf(TICK_PROVIDER),
            TICK_PROVIDER + ' no longer mounts the subscription tests/shell-tick-lifetime.test.ts runs'
        ).toContain('subscribeTimerTicks(setTimerSnapshot)');
    });

    /*
     * The shell's quit confirm reads the timer snapshot at the click. It may not do so through the timer feature's
     * own store: a store whose freshness one screen owns is a store every other screen reads stale (WR-07).
     */
    it('publishes the timer answer rather than the timer store', () => {
        const surface = codeOf(path.posix.join(SRC, 'features/timer/index.ts'));
        expect(surface, 'features/timer/index.ts exports its Zustand instance, so the boundary is decorative')
            .not.toMatch(/\buseTimerStore\b/);
        const reachers = rendererSources()
            .filter((file) => !file.startsWith(SRC + '/features/timer/'))
            .filter((file) => /\buseTimerStore\b/.test(codeOf(file)));
        expect(reachers, 'these read the timer feature internal store directly').toEqual([]);
    });

    it('mounts both providers inside the client they read, and outside the route table', () => {
        const app = codeOf(APP);
        const query = app.indexOf('<QueryProvider>');
        const router = app.indexOf('<HashRouter>');
        expect(query, 'App.tsx no longer mounts QueryProvider').toBeGreaterThan(-1);
        expect(router, 'App.tsx no longer mounts the router').toBeGreaterThan(-1);
        for (const provider of ['<DataSyncProvider>', '<TimerProvider>']) {
            const at = app.indexOf(provider);
            expect(at, 'App.tsx does not mount ' + provider).toBeGreaterThan(-1);
            expect(at > query, provider + ' is outside QueryProvider, so useQueryClient would throw').toBe(true);
            expect(
                at < router,
                provider + ' is inside the router, so its subscription would be torn down by a route change'
            ).toBe(true);
        }
    });
});

/*
 * Criterion 4, and the obligation 08-D-SUMMARY.md left slice E. Two things mean the pomodoro mode: the clock main
 * runs in (timer.state.mode) and the preference Settings shows (settings.pomodoroEnabled). Home writes both,
 * Settings writes both, and if either wrote one alone the two screens would disagree about what the app is doing.
 * Avoiding that by remembering is what rots when a third caller appears: there is exactly one writer, and this is
 * what says so.
 */
describe('criterion 4: the mode and its preference are written by one caller', () => {
    const MODE_WRITER = path.posix.join(SRC, 'features/settings/api/useTimerMode.ts');

    /*
     * A property SET on an object, which is what any settings:update payload is - and not a prop of that name
     * passed down, a field of that name declared, or `settings.data.pomodoroEnabled` read. The difference is
     * syntactic, so it is read off the parser rather than guessed at with a regular expression.
     */
    const setsFlag = (file: string): boolean => {
        const { sourceFile } = stripCommentsAndStrings(file, read(file));
        let found = false;
        const visit = (node: ts.Node): void => {
            if (
                (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
                ts.isObjectLiteralExpression(node.parent) &&
                node.name.getText(sourceFile) === 'pomodoroEnabled'
            ) {
                found = true;
            }
            ts.forEachChild(node, visit);
        };
        visit(sourceFile);
        return found;
    };

    /**
     * The key spelt as a value, which is what a computed property name would need. A LiteralTypeNode parent means
     * it is a TYPE saying the key is excluded - the Omit in features/settings - which is the opposite of a write.
     */
    const spellsFlag = (file: string, source = read(file)): boolean => {
        const { sourceFile } = stripCommentsAndStrings(file, source);
        let found = false;
        const visit = (node: ts.Node): void => {
            if (ts.isStringLiteral(node) && node.text === 'pomodoroEnabled' && !ts.isLiteralTypeNode(node.parent)) {
                found = true;
            }
            ts.forEachChild(node, visit);
        };
        visit(sourceFile);
        return found;
    };

    it('writes settings.pomodoroEnabled from exactly one file, and it is ' + MODE_WRITER, () => {
        const writers = rendererSources().filter((file) => setsFlag(file));
        expect(
            writers,
            'a second writer of pomodoroEnabled can set the preference without setting the mode, which is the ' +
            'drift 08-D-SUMMARY.md named'
        ).toEqual([MODE_WRITER]);

        /*
         * The other spelling: a computed key, `{ ['pomodoroEnabled']: true }`, is not a PropertyAssignment named
         * pomodoroEnabled and the scan above cannot see it. It has to spell the key as a string somewhere, and
         * reading `settings.data.pomodoroEnabled` never does - that is a member access, not a literal.
         */
        const spellers = rendererSources().filter((file) => file !== MODE_WRITER && spellsFlag(file));
        expect(
            spellers,
            'the key is spelt as a string outside the writer, which is how a computed key would reach it'
        ).toEqual([]);
    });

    it('would see a computed key, and does not read the type that excludes one as a write', () => {
        const probe = 'src/renderer/src/features/settings/probe.ts';
        expect(
            spellsFlag(probe, "const patch = { ['pomodoroEnabled']: true };"),
            'the scan above can never fail, so it says nothing about a computed key'
        ).toBe(true);
        expect(
            spellsFlag(probe, "type Patch = Partial<Omit<Settings, 'pomodoroEnabled'>>;"),
            'the type that keeps the key out of the form would be reported as a write'
        ).toBe(false);
    });

    it('sends timer:setMode from that same file and nowhere else', () => {
        const callers = rendererSources().filter((file) => literalsOf(file).includes('timer:setMode'));
        expect(callers, 'the mode is set somewhere that does not set the preference with it').toEqual([MODE_WRITER]);
    });

    it('reaches that one caller from both screens that toggle the mode', () => {
        const surface = codeOf(path.posix.join(SRC, 'features/settings/index.ts'));
        expect(surface, 'features/settings no longer publishes the writer, so Home cannot reach it')
            .toMatch(/useSetTimerMode/);
        const callers = rendererSources()
            .filter((file) => file !== MODE_WRITER)
            .filter((file) => /\buseSetTimerMode\s*\(/.test(codeOf(file)))
            .sort();
        expect(callers, 'both screens carry a pomodoro toggle, and both go through the one writer').toEqual([
            path.posix.join(SRC, 'features/settings/SettingsPage.tsx'),
            path.posix.join(SRC, 'features/timer/TimerPage.tsx')
        ]);
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

    /*
     * WR-04: "exactly one .css file under src/renderer" says nothing about a stylesheet imported from a package.
     * `import 'material-symbols/outlined.css'` in a component is a second stylesheet by every meaning ARCH-05
     * has, and it passed. The one import that may exist is main.tsx's, which is what puts Tailwind's build-time
     * output into the bundle at all.
     */
    it('imports a stylesheet from one file, and it is the bootstrap', () => {
        const importers = rendererSources()
            .filter((file) => literalsOf(file).some((value) => value.endsWith('.css')))
            .sort();
        expect(importers, 'a component reaching for a stylesheet is a second stylesheet, wherever it lives')
            .toEqual([path.posix.join(SRC, 'app/main.tsx')]);
        expect(
            literalsOf(path.posix.join(SRC, 'app/main.tsx')).filter((value) => value.endsWith('.css')),
            'the bootstrap imports something other than the one stylesheet'
        ).toEqual(['../styles/globals.css']);
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

    /*
     * Stacking, decided by DOM order rather than by a z-index race.
     *
     * BottomNav is `fixed bottom-0 z-50` and the overlay is `fixed inset-0 z-50`, so at equal z-index the later
     * element in the document wins. A modal rendered inside a screen sits before <BottomNav/> in AppShell and
     * loses: the bar paints bright and undimmed over the panel, and can be CLICKED THROUGH it, changing route with
     * the dialog still mounted. AlertDialog happened to win because it mounts after the nav - some dialogs above
     * the bar, some below. v1.2.1 appended both to document.body, so every modal painted over the bar; the portal
     * is that order, restored once for every caller.
     */
    it('renders the overlay into the document root, not into the screen that opened it', () => {
        expect(codeOf(MODAL), MODAL + ' no longer portals, so a screen-opened dialog is back under the nav bar')
            .toContain('createPortal');

        const BOOTSTRAP = path.posix.join(SRC, 'app/main.tsx');
        const others = rendererSources()
            .filter((file) => file !== MODAL && file !== BOOTSTRAP)
            .filter((file) => /\bcreatePortal\b/.test(codeOf(file)) ||
                literalsOf(file).some((value) => /^react-dom(\/|$)/.test(value)));
        expect(
            others,
            'a second portal is a second stacking context nobody has ordered against the first (criterion 5)'
        ).toEqual([]);
    });

    it('declares the portal container after #root, so DOM order settles the tie', () => {
        const entry = read(ENTRY);
        const root = entry.indexOf('id="root"');
        const portal = entry.indexOf('id="modal-root"');
        expect(portal, ENTRY + ' has no #modal-root for Modal to render into').toBeGreaterThan(-1);
        expect(portal, 'the portal container is declared before #root, so the app paints over its own dialogs')
            .toBeGreaterThan(root);
    });

    /*
     * WR-05 clause 3, left open by the Phase 7 verifier: aria-modal="true" was a claim about the document that
     * only the keyboard was held to. The shell is inert while a dialog is open, which is also what stops the click
     * through the overlay onto the navigation.
     */
    it('marks the shell inert while a dialog is open, so aria-modal is true of more than the keyboard', () => {
        expect(literalsOf(SHELL), 'AppShell no longer carries the id Modal marks inert').toContain('app-shell');
        expect(literalsOf(MODAL), MODAL + ' no longer names the shell it makes inert').toContain('app-shell');
        expect(literalsOf(MODAL), MODAL + ' no longer sets inert on anything').toContain('inert');
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
