/*
 * tests/userdata-path.test.ts
 *
 * The standing proof for D-09 and BUILD-12: a development build gets its own userData directory,
 * and that relocation can never happen in a packaged build.
 *
 * The failure this file prevents is silent and one-way. src/main/userdata-path.ts is the only
 * module in the repository allowed to move userData. If its development branch were ever reached
 * by an installed build, the app would open <appData>/<name>-dev instead of <appData>/<name>: no
 * crash, no warning, just an application that looks freshly installed, while every session the
 * user ever tracked sits orphaned in the directory next to it. There is no server and no
 * telemetry, so nobody would find out until users did - on machines the owner cannot reach.
 *
 * Three properties carry that, and each is asserted by running the module, not by reading it:
 *
 *   1. The development directory is derived from the manifest name it is given, never from a
 *      literal. A hard-coded directory name is a second source of truth that drifts from
 *      package.json the day someone touches either.
 *   2. With isPackaged true the module throws, and it throws BEFORE it touches the path setter.
 *      A throw that came after the relocation would be a crash report about damage already done.
 *   3. With isPackaged false it relocates exactly once, to exactly the derived directory.
 *
 * The module imports Electron for its type only and takes the app object as an argument, which is
 * what lets this run in plain Node - the same property src/lib/db/backup.ts was written to
 * demonstrate. The stand-ins below are plain objects with a call recorder. The electron module is
 * deliberately NOT mocked: a mock would prove the test agrees with the mock.
 *
 * Every assertion here was turned red by a deliberate mutation of the module before this file was
 * committed, and the module restored byte-identically (plan 02-02's SUMMARY records the hashes).
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    DEVELOPMENT_USER_DATA_SUFFIX,
    applyDevelopmentUserDataPath,
    devUserDataPath,
    type UserDataApp
} from '../src/main/userdata-path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODULE = 'src/main/userdata-path.ts';
const moduleSource = fs.readFileSync(path.join(repoRoot, MODULE), 'utf8');
const pkg = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')
) as Record<string, unknown>;

// The name Electron resolves at runtime, read from the manifest rather than restated here.
const MANIFEST_NAME = String(pkg['name']);

// Forward slashes on purpose: path.join normalises them on Windows and leaves them alone on the
// Linux CI runner, so the parent is compared through path.normalize rather than as a raw string.
const APP_DATA = 'C:/Users/x/AppData/Roaming';

// Deliberately NOT the manifest name, so a module that ignored its argument and used a literal
// could not pass the relocation test by coincidence.
const STUB_NAME = 'stub-app-name';

interface SetPathCall {
    name: string;
    value: string;
}

interface RecordingApp extends UserDataApp {
    readonly setPathCalls: SetPathCall[];
}

/*
 * A stand-in for Electron's app object. getPath('userData') starts where Electron would put it -
 * <appData>/<name> - and moves only if setPath is called, so the stub can also report whether the
 * production path survived untouched.
 */
function recordingApp(options: { isPackaged: boolean; name: string }): RecordingApp {
    const paths: Record<string, string> = {
        appData: APP_DATA,
        userData: path.join(APP_DATA, options.name)
    };
    const setPathCalls: SetPathCall[] = [];
    return {
        isPackaged: options.isPackaged,
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

/*
 * The module's source with block and line comments removed, for PRESENCE checks only. A comment
 * saying app.getName() must not be able to satisfy "the path is derived from app.getName()". The
 * crude stripper is adequate here because the module holds no string that contains a comment
 * marker; the absence check below reads the raw text instead, where prose can only ever make the
 * test stricter, never let it pass.
 */
const moduleCode = moduleSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

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
        // Raw text, deliberately. A literal in code is a second source of truth for the directory
        // every user's data lives in. A literal in prose is harmless but indistinguishable to a
        // text gate, and this repository's precedent (src/lib/db/backup.ts) is to write the prose
        // around such gates rather than loosen them.
        expect(
            moduleSource.includes(MANIFEST_NAME),
            MODULE + ' contains the literal "' + MANIFEST_NAME + '". Derive it from app.getName(); ' +
            'if it is only in a comment, reword the comment'
        ).toBe(false);
        expect(moduleSource.includes('workflow-timer')).toBe(false);
    });
});
