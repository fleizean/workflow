// CORE-02 / CORE-03, criterion 3: every module under src/main/services loads with `electron` stubbed to throw on
// import, and so does every test that exercises one. Lint states the rule; this runs it, because a lint rule can be
// satisfied by a file that reaches electron through a module that imports it two hops away.
//
// The two halves are complementary and neither is redundant: esbuild elides an import whose bindings are unused, so
// this file cannot see an electron import a service does not use - and lint, which reads the source, can.

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { repoRoot } from './helpers/ts-imports';

// Repeated as a literal inside the factory on purpose: vi.mock is hoisted above every declaration in this file, so
// a factory that read the constant would run before it exists.
const ELECTRON_ABSENT = 'electron was imported by a module that must load without it';

vi.mock('electron', () => {
    throw new Error('electron was imported by a module that must load without it');
});

/** What loading a module did: 'loaded', or the reason the import refused. Vitest wraps a factory throw; cause is ours. */
async function loadOutcome(load: () => Promise<unknown>): Promise<string> {
    try {
        await load();
        return 'loaded';
    } catch (error) {
        const { cause } = error as { cause?: unknown };
        return cause instanceof Error ? cause.message : (error as Error).message;
    }
}

// vite/client is not in tsconfig.node.json's types, and adding it there for one test file would widen the whole
// node program. The call stays written out so Vite's static analysis still sees it.
declare global {
    interface ImportMeta {
        glob(pattern: string): Record<string, () => Promise<Record<string, unknown>>>;
    }
}

const SERVICES_DIR = 'src/main/services';
// Vite resolves this at build time, so the loaders below go through the same module graph the stub above patches.
const serviceModules = import.meta.glob('../src/main/services/**/*.ts');

const relativeToRepo = (globKey: string): string => globKey.replace(/^\.\.\//, '');

function serviceFilesOnDisk(dir = SERVICES_DIR): string[] {
    return fs.readdirSync(path.join(repoRoot, dir), { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
            ? serviceFilesOnDisk(dir + '/' + entry.name)
            : (entry.name.endsWith('.ts') ? [dir + '/' + entry.name] : []));
}

describe('CORE-02: the services load with electron stubbed to throw', () => {
    const onDisk = serviceFilesOnDisk();

    it('found the services it is about to load, and every one of them', () => {
        expect(onDisk.length, SERVICES_DIR + ' holds no module, so loading them proves nothing').toBeGreaterThan(0);
        expect(Object.keys(serviceModules).map(relativeToRepo).sort(), 'a service the glob does not reach')
            .toEqual([...onDisk].sort());
    });

    it('stubs electron in a way that actually refuses the import', async () => {
        // The negative control. Without it every assertion below could pass because the stub never took effect.
        expect(await loadOutcome(() => import('../src/main/window'))).toBe(ELECTRON_ABSENT);
    });

    it.each(Object.entries(serviceModules))('%s loads and exports its surface', async (key, load) => {
        expect(await loadOutcome(load), relativeToRepo(key) + ' cannot load without electron').toBe('loaded');
        const loaded = await load();
        expect(Object.keys(loaded).length, relativeToRepo(key) + ' loaded but exports nothing').toBeGreaterThan(0);
    });
});

/*
 * The other half of criterion 3: "and its tests still pass". A service could stay Electron-free while its test file
 * pulled electron in through a fixture, and the day the service needed a real Electron binary to be tested would
 * arrive unannounced. So any test that imports a service must declare the same stub - which is a literal call,
 * because vi.mock is hoisted syntactically and cannot be wrapped in a helper.
 */
describe('CORE-03: every test that exercises a service declares the stub too', () => {
    const STUB_CALL = 'vi.mock(\'electron\'';
    const IMPORTS_A_SERVICE = /from '(\.\.\/src\/main\/services|@main\/services)/;

    const testFiles = fs.readdirSync(path.join(repoRoot, 'tests'))
        .filter((name) => name.endsWith('.test.ts'))
        .map((name) => 'tests/' + name);

    const exercisingServices = testFiles.filter((file) =>
        IMPORTS_A_SERVICE.test(fs.readFileSync(path.join(repoRoot, file), 'utf8')));

    it('finds the test files that import a service', () => {
        expect(exercisingServices, 'no test imports a service, so this guard would pass vacuously').not.toEqual([]);
    });

    it('finds the stub in each of them', () => {
        const missing = exercisingServices.filter((file) =>
            !fs.readFileSync(path.join(repoRoot, file), 'utf8').includes(STUB_CALL));
        expect(
            missing,
            'These tests exercise a service without stubbing electron, so they would keep passing on the day a ' +
            'service started needing it:\n  ' + missing.join('\n  ') + '\nAdd ' + STUB_CALL +
            ', () => { throw new Error(...); }); at the top of each.'
        ).toEqual([]);
    });
});
