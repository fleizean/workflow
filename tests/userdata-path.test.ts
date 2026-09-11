// D-09/BUILD-12: a development build gets its own userData and a packaged one never relocates it; WR-06, WR-04 and the
// D-36 door guard the production directory through one realpath-aware rule. Plain stand-ins: electron is never mocked.

import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

import { PRODUCTION_DATA_DOOR_OPEN } from '../src/main/config';
import {
    DEVELOPMENT_USER_DATA_SUFFIX,
    USER_DATA_DIR_SWITCH,
    applyDevelopmentUserDataPath,
    applyUnpackagedUserDataPath,
    canonicalPath,
    devUserDataPath,
    isSameOrInside,
    productionDataDoorRefuses,
    type DoorInput,
    type UnpackagedUserDataApp
} from '../src/main/userdata-path';
import { isWithin } from '../tools/smoke-packaged.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODULE = 'src/main/userdata-path.ts';
const CONFIG = 'src/main/config.ts';
const moduleSource = fs.readFileSync(path.join(repoRoot, MODULE), 'utf8');
const pkg = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')
) as Record<string, unknown>;

// The name Electron resolves at runtime, read from the manifest rather than restated here.
const MANIFEST_NAME = String(pkg['name']);

// A stand-in that exists on no machine; forward slashes so path.join normalises it on every platform.
const APP_DATA = 'C:/Users/x/AppData/Roaming';

// Not the manifest name, so a module that used a literal could not pass by coincidence.
const STUB_NAME = 'stub-app-name';

const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';

interface SetPathCall {
    name: string;
    value: string;
}

interface RecordingApp extends UnpackagedUserDataApp {
    readonly setPathCalls: SetPathCall[];
}

// Electron's app object, with userData at <appData>/<name> (or the --user-data-dir given) until setPath moves it.
function recordingApp(options: { isPackaged: boolean; name: string; userDataDir?: string; appData?: string }): RecordingApp {
    const appData = options.appData ?? APP_DATA;
    const paths: Record<string, string> = {
        appData,
        userData: options.userDataDir ?? path.join(appData, options.name)
    };
    const setPathCalls: SetPathCall[] = [];
    return {
        isPackaged: options.isPackaged,
        commandLine: {
            hasSwitch: (name: string): boolean => name === USER_DATA_DIR_SWITCH && options.userDataDir !== undefined
        },
        getName: () => options.name,
        getPath: (name: string): string => {
            const value = paths[name];
            if (value === undefined) {
                throw new Error('recordingApp: no stub value for getPath("' + name + '")');
            }
            return value;
        },
        setPath: (name: string, value: string): void => {
            setPathCalls.push({ name, value });
            paths[name] = value;
        },
        setPathCalls
    };
}

// For presence checks only, so a comment cannot satisfy them; the absence check reads the raw text.
const moduleCode = moduleSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

// cmd without the variables that would turn a child Electron into plain Node; verbatim so quotes reach cmd intact.
function cmd(line: string): string {
    const env = { ...process.env };
    delete env['ELECTRON_RUN_AS_NODE'];
    delete env['NODE_OPTIONS'];
    const result = spawnSync('cmd', ['/d', '/c', line], { env, encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true });
    if (result.status !== 0) {
        throw new Error('cmd /c ' + line + ' failed: ' + (result.stderr || String(result.error)));
    }
    return result.stdout.trim();
}

// A fresh temp root holding a long-named "production" directory. Links are unlinked before the root is removed,
// so the recursive removal can never walk through one into its target.
function withProductionFixture(run: (fixture: { root: string; target: string; addLink: (link: string) => void }) => void): void {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wft-spelling-'));
    const target = path.join(root, 'Production Dir');
    fs.mkdirSync(target);
    const links: string[] = [];
    try {
        run({ root, target, addLink: (link) => links.push(link) });
    } finally {
        for (const link of links) {
            fs.unlinkSync(link);
        }
        fs.rmSync(root, { recursive: true, force: true });
    }
}

function junction(link: string, target: string): void {
    cmd('mklink /J "' + link + '" "' + target + '"');
    expect(fs.realpathSync.native(link), 'the junction ' + link + ' was not created').toBe(fs.realpathSync.native(target));
}

describe('D-09 / BUILD-12: the development userData directory', () => {
    it('lives directly under appData and is named after the application plus the suffix', () => {
        const dir = devUserDataPath(APP_DATA, 'workflow-timer');
        expect(path.basename(dir), 'devUserDataPath in ' + MODULE + ' names the wrong directory')
            .toBe('workflow-timer-dev');
        expect(path.dirname(dir), 'devUserDataPath in ' + MODULE + ' does not sit directly under appData')
            .toBe(path.normalize(APP_DATA));
    });

    it('takes its name from the argument, so it is derived and never a literal', () => {
        const dir = devUserDataPath('/a/b', 'other-name');
        expect(
            dir.endsWith('other-name-dev'),
            MODULE + ' ignored the application name it was given and produced ' + dir +
            ' - the development directory must follow the manifest, not a hard-coded name'
        ).toBe(true);
        expect(path.basename(dir)).toBe('other-name' + DEVELOPMENT_USER_DATA_SUFFIX);
    });

    it('for the real manifest name, is a sibling of the production directory and never the same one', () => {
        const production = path.join(APP_DATA, MANIFEST_NAME);
        const development = devUserDataPath(APP_DATA, MANIFEST_NAME);
        expect(development, 'the development directory IS the production directory').not.toBe(production);
        expect(path.dirname(development)).toBe(path.dirname(production));
        expect(path.basename(development)).toBe(MANIFEST_NAME + DEVELOPMENT_USER_DATA_SUFFIX);
    });
});

describe('D-09: the development branch is unreachable in a packaged build', () => {
    it('throws when isPackaged is true, names D-09, and never calls the path setter', () => {
        const app = recordingApp({ isPackaged: true, name: MANIFEST_NAME });
        expect(
            () => applyDevelopmentUserDataPath(app),
            MODULE + ' returned normally in a PACKAGED build; it must refuse to start instead'
        ).toThrow(/D-09/);
        expect(
            app.setPathCalls,
            MODULE + ' called the path setter in a packaged build before (or instead of) throwing - ' +
            'a crash after the relocation has already moved every user\'s userData'
        ).toEqual([]);
    });

    it('leaves the production userData exactly where the manifest name puts it', () => {
        const app = recordingApp({ isPackaged: true, name: MANIFEST_NAME });
        const before = app.getPath('userData');
        expect(before).toBe(path.join(APP_DATA, MANIFEST_NAME));
        expect(() => applyDevelopmentUserDataPath(app)).toThrow();
        expect(
            app.getPath('userData'),
            'userData moved in a packaged build; installed users would open an empty directory'
        ).toBe(before);
    });

    it('relocates an unpackaged build exactly once, to exactly the derived directory', () => {
        const app = recordingApp({ isPackaged: false, name: STUB_NAME });
        const expected = devUserDataPath(APP_DATA, STUB_NAME);

        const returned = applyDevelopmentUserDataPath(app);

        expect(
            app.setPathCalls,
            MODULE + ' must call the path setter once, for userData, with the derived directory'
        ).toEqual([{ name: 'userData', value: expected }]);
        expect(returned, MODULE + ' returned a different path than the one it applied').toBe(expected);
        expect(app.getPath('userData')).toBe(expected);
    });
});

describe('D-09: the production name comes from the manifest at runtime, not from this module', () => {
    it('derives the development directory from app.getName() and the appData path', () => {
        expect(
            /devUserDataPath\(\s*app\.getPath\(\s*'appData'\s*\)\s*,\s*app\.getName\(\)\s*\)/.test(moduleCode),
            MODULE + ' no longer passes app.getName() into devUserDataPath; the directory must derive ' +
            'from the name Electron resolved from the manifest'
        ).toBe(true);
    });

    it('never spells the manifest name, not even in a comment', () => {
        // Raw text on purpose: a literal anywhere is a second source of truth for where every user's data lives.
        expect(
            moduleSource.includes(MANIFEST_NAME),
            MODULE + ' contains the literal "' + MANIFEST_NAME + '". Derive it from app.getName(); ' +
            'if it is only in a comment, reword the comment'
        ).toBe(false);
        expect(moduleSource.includes('workflow-timer')).toBe(false);
    });
});

describe('WR-06: an explicit --user-data-dir in an unpackaged build', () => {
    const FIXTURE_DIR = path.join('C:/fixtures', 'wft-parity', 'ud');
    const production = path.join(APP_DATA, STUB_NAME);

    it('is honoured as given, and the path setter is never called', () => {
        const app = recordingApp({ isPackaged: false, name: STUB_NAME, userDataDir: FIXTURE_DIR });
        expect(applyUnpackagedUserDataPath(app), MODULE + ' overrode an explicit --user-data-dir').toBe(FIXTURE_DIR);
        expect(app.setPathCalls).toEqual([]);
        expect(app.getPath('userData')).toBe(FIXTURE_DIR);
    });

    it('without the switch, still relocates to the development directory exactly once', () => {
        const app = recordingApp({ isPackaged: false, name: STUB_NAME });
        const expected = devUserDataPath(APP_DATA, STUB_NAME);
        expect(applyUnpackagedUserDataPath(app)).toBe(expected);
        expect(app.setPathCalls).toEqual([{ name: 'userData', value: expected }]);
    });

    it('refuses the production directory and anything inside it, without calling the path setter', () => {
        // `..x` is a child named "..x", not a parent reference.
        for (const dir of [production, path.join(production, 'sub'), path.join(production, '..x', 'data')]) {
            const app = recordingApp({ isPackaged: false, name: STUB_NAME, userDataDir: dir });
            expect(() => applyUnpackagedUserDataPath(app), MODULE + ' accepted --user-data-dir=' + dir).toThrow(/WR-06/);
            expect(app.setPathCalls).toEqual([]);
        }
    });

    it.runIf(CASE_INSENSITIVE)(
        'refuses the production directory spelled in another case, where the filesystem ignores case', () => {
            const app = recordingApp({
                isPackaged: false, name: STUB_NAME, userDataDir: path.join(APP_DATA, STUB_NAME.toUpperCase())
            });
            expect(() => applyUnpackagedUserDataPath(app)).toThrow(/WR-06/);
        });

    it.runIf(process.platform === 'win32')('refuses a junction to the production directory (IN-06)', () => {
        withProductionFixture(({ root, target, addLink }) => {
            const link = path.join(root, 'link');
            junction(link, target);
            addLink(link);
            const app = recordingApp({ isPackaged: false, name: path.basename(target), appData: root, userDataDir: link });
            expect(() => applyUnpackagedUserDataPath(app), MODULE + ' accepted a junction to ' + target).toThrow(/WR-06/);
            expect(app.setPathCalls).toEqual([]);
        });
    });

    it('accepts a sibling whose name merely starts with the production name', () => {
        const sibling = production + '-fixture';
        const app = recordingApp({ isPackaged: false, name: STUB_NAME, userDataDir: sibling });
        expect(applyUnpackagedUserDataPath(app)).toBe(sibling);
    });

    it('still throws D-09 in a packaged build, switch or no switch, without calling the path setter', () => {
        for (const userDataDir of [FIXTURE_DIR, undefined]) {
            const app = recordingApp({ isPackaged: true, name: STUB_NAME, userDataDir });
            expect(() => applyUnpackagedUserDataPath(app)).toThrow(/D-09/);
            expect(app.setPathCalls).toEqual([]);
        }
    });
});

// WR-04: the smoke launch's guards and the harness verdict must agree with this module's rule.
describe('WR-04: one containment rule for every production-directory guard', () => {
    const production = path.join(APP_DATA, STUB_NAME);
    // `..smoke` and `..x.db` are children whose names start with two dots, not parent references.
    const INSIDE = [production, path.join(production, 'sub'), path.join(production, '..smoke'), path.join(production, '..x.db')];
    const OUTSIDE = [APP_DATA, production + '-fixture', path.join(APP_DATA, 'other', 'ud'), path.join(production, '..', 'sibling')];
    const GUARDS: [string, (parent: string, child: string) => boolean][] = [
        ['isSameOrInside in ' + MODULE, isSameOrInside],
        ['isWithin in tools/smoke-packaged.mjs', isWithin]
    ];

    it.each(GUARDS)('%s counts the directory and every child as inside, and nothing else', (label, inside) => {
        for (const child of INSIDE) {
            expect(inside(production, child), 'WR-04: ' + label + ' let ' + child + ' out of ' + production).toBe(true);
        }
        for (const child of OUTSIDE) {
            expect(inside(production, child), 'WR-04: ' + label + ' pulled ' + child + ' into ' + production).toBe(false);
        }
    });

    it.runIf(CASE_INSENSITIVE)(
        'ignores case in both guards, where the filesystem does', () => {
            for (const [label, inside] of GUARDS) {
                expect(inside(production, production.toUpperCase()), 'WR-04: ' + label + ' is case-sensitive').toBe(true);
            }
        });

    for (const [label, inside] of GUARDS) {
        it.runIf(process.platform === 'win32')(label + ' sees through a junction, including to a leaf that does not exist yet', () => {
            withProductionFixture(({ root, target, addLink }) => {
                const link = path.join(root, 'link');
                junction(link, target);
                addLink(link);
                expect(fs.existsSync(path.join(target, 'krono.db')), 'the fixture must not hold the leaf').toBe(false);
                expect(inside(target, link), 'IN-06: ' + label + ' let the junction ' + link + ' out').toBe(true);
                expect(inside(target, path.join(link, 'krono.db')), 'IN-06: ' + label + ' let link\\krono.db out').toBe(true);
                expect(inside(link, target), 'IN-06: ' + label + ' does not canonicalize the parent side').toBe(true);
                expect(inside(target, path.join(root, 'elsewhere')), label + ' pulled a sibling in').toBe(false);
            });
        });

        it.runIf(CASE_INSENSITIVE)(label + ' treats an upper-cased spelling of a real directory as the same one', () => {
            withProductionFixture(({ target }) => {
                expect(inside(target, target.toUpperCase()), label + ' is case-sensitive on a real path').toBe(true);
                expect(inside(target.toUpperCase(), path.join(target, 'krono.db')), label + ' is case-sensitive on the parent').toBe(true);
            });
        });

        it.runIf(process.platform !== 'win32')(label + ' sees through a symlink to the production directory', () => {
            withProductionFixture(({ root, target, addLink }) => {
                const link = path.join(root, 'link');
                fs.symlinkSync(target, link, 'dir');
                addLink(link);
                expect(inside(target, link), 'IN-06: ' + label + ' let the symlink ' + link + ' out').toBe(true);
                expect(inside(target, path.join(link, 'krono.db')), 'IN-06: ' + label + ' let link/krono.db out').toBe(true);
                expect(inside(link, target), 'IN-06: ' + label + ' does not canonicalize the parent side').toBe(true);
            });
        });
    }

    // Computed once at collection: an 8.3 name exists only where the volume generates them.
    const shortName = ((): { root: string; long: string; short: string } | null => {
        if (process.platform !== 'win32') {
            return null;
        }
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wft-short-'));
        const long = path.join(root, 'Production Directory');
        fs.mkdirSync(long);
        let short = long;
        try {
            short = cmd('for %I in ("' + long + '") do @echo %~sI');
        } catch {
            // No short name to test; the skip below says so.
        }
        return { root, long, short };
    })();
    afterAll(() => {
        if (shortName !== null) {
            fs.rmSync(shortName.root, { recursive: true, force: true });
        }
    });
    const skipReason = shortName === null ? ' (skipped: 8.3 names exist only on Windows)'
        : shortName.short === shortName.long ? ' (skipped: this volume produces no 8.3 short name)' : '';

    for (const [label, inside] of GUARDS) {
        it.skipIf(skipReason !== '')(label + ' sees an 8.3 short name of the production directory as inside it' + skipReason, () => {
            if (shortName === null) {
                throw new Error('unreachable: the 8.3 case runs only when a short name exists');
            }
            const { long, short } = shortName;
            expect(short, 'the short name must differ, or this proves nothing').not.toBe(long);
            expect(fs.realpathSync.native(short)).toBe(fs.realpathSync.native(long));
            expect(inside(long, short), 'IN-06: ' + label + ' let the 8.3 name ' + short + ' out').toBe(true);
            expect(inside(long, path.join(short, 'krono.db')), 'IN-06: ' + label + ' let an 8.3 leaf out').toBe(true);
            expect(inside(short, path.join(long, 'krono.db')), 'IN-06: ' + label + ' does not canonicalize the parent side').toBe(true);
        });
    }

    it('canonicalPath keeps a missing tail and resolves the part that exists', () => {
        withProductionFixture(({ target }) => {
            expect(canonicalPath(path.join(target, 'missing', 'krono.db')))
                .toBe(path.join(fs.realpathSync.native(target), 'missing', 'krono.db'));
            expect(canonicalPath(target)).toBe(fs.realpathSync.native(target));
        });
    });

    it('smoke.ts takes its guard from ' + MODULE + ' instead of keeping a second rule', () => {
        const smoke = fs.readFileSync(path.join(repoRoot, 'src/main/smoke.ts'), 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
        expect(/import\s*\{[^}]*\bisSameOrInside\b[^}]*\}\s*from\s*'\.\/userdata-path'/.test(smoke),
            'WR-04: src/main/smoke.ts no longer imports isSameOrInside from ./userdata-path').toBe(true);
        expect(/\brelative\s*\(/.test(smoke), 'WR-04: src/main/smoke.ts computes containment itself again').toBe(false);
    });
});

describe('D-36: the production-data door', () => {
    const production = path.join(APP_DATA, STUB_NAME);
    const ROWS = [false, true].flatMap((isPackaged) => [false, true].flatMap((smoke) => [false, true].flatMap((doorOpen) =>
        [false, true].map((inside) => ({ isPackaged, smoke, doorOpen, inside })))));
    const REFUSING = { isPackaged: true, smoke: false, doorOpen: false, inside: true };
    const input = (row: (typeof ROWS)[number], userDataDir?: string): DoorInput => ({
        isPackaged: row.isPackaged,
        smoke: row.smoke,
        doorOpen: row.doorOpen,
        productionDir: production,
        userDataDir: userDataDir ?? (row.inside ? production : production + '-fixture')
    });

    it('covers all 16 combinations and refuses exactly one', () => {
        expect(new Set(ROWS.map((row) => JSON.stringify(row))).size).toBe(16);
        expect(ROWS.filter((row) => productionDataDoorRefuses(input(row)))).toEqual([REFUSING]);
    });

    it.each(ROWS)('isPackaged=$isPackaged smoke=$smoke doorOpen=$doorOpen inside=$inside', (row) => {
        const expected = JSON.stringify(row) === JSON.stringify(REFUSING);
        expect(productionDataDoorRefuses(input(row)), 'D-36: wrong verdict for ' + JSON.stringify(row)).toBe(expected);
    });

    it('refuses a child and another-case spelling of the production directory too', () => {
        expect(productionDataDoorRefuses(input(REFUSING, path.join(production, 'sub')))).toBe(true);
        if (CASE_INSENSITIVE) {
            expect(productionDataDoorRefuses(input(REFUSING, production.toUpperCase()))).toBe(true);
        }
    });

    it.runIf(process.platform === 'win32')('refuses a packaged non-smoke launch whose userData is a junction to the production directory', () => {
        withProductionFixture(({ root, target, addLink }) => {
            const link = path.join(root, 'link');
            junction(link, target);
            addLink(link);
            const door = { isPackaged: true, smoke: false, doorOpen: false, productionDir: target };
            expect(productionDataDoorRefuses({ ...door, userDataDir: link }), 'D-36: the door opened for a junction').toBe(true);
            expect(productionDataDoorRefuses({ ...door, userDataDir: path.join(root, 'elsewhere') })).toBe(false);
        });
    });

    it('ships closed: PRODUCTION_DATA_DOOR_OPEN is the literal false in ' + CONFIG, () => {
        const sourceFile = ts.createSourceFile(CONFIG, fs.readFileSync(path.join(repoRoot, CONFIG), 'utf8'), ts.ScriptTarget.Latest, true);
        const declarations = sourceFile.statements
            .filter((statement): statement is ts.VariableStatement => ts.isVariableStatement(statement))
            .filter((statement) => (statement.declarationList.flags & ts.NodeFlags.Const) !== 0)
            .flatMap((statement) => [...statement.declarationList.declarations])
            .filter((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === 'PRODUCTION_DATA_DOOR_OPEN');
        expect(declarations.map((declaration) => declaration.initializer?.kind),
            'D-36: the door may only open in a Phase 10 REL-04 change behind its own checkpoint, and that change updates this test')
            .toEqual([ts.SyntaxKind.FalseKeyword]);
        expect(PRODUCTION_DATA_DOOR_OPEN).toBe(false);
    });
});
