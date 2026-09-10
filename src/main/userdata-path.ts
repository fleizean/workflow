// Gives an unpackaged build its own userData directory, so it never opens a real krono.db (BUILD-12, D-07).
// Electron is a type import only: every function takes the app object, so tests run it against a stand-in.

import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { App, CommandLine } from 'electron';
import { DEVELOPMENT_USER_DATA_SUFFIX, USER_DATA_DIR_SWITCH } from './config';

export { DEVELOPMENT_USER_DATA_SUFFIX, USER_DATA_DIR_SWITCH };

/** The slice of Electron's `app` this module touches. */
export type UserDataApp = Pick<App, 'isPackaged' | 'getName' | 'getPath' | 'setPath'>;

/** UserDataApp plus the command line, for the unpackaged-start policy. */
export type UnpackagedUserDataApp = UserDataApp & { readonly commandLine: Pick<CommandLine, 'hasSwitch'> };

/** `<appData>/<appName>-dev`. Throws on an empty argument, which would silently yield an unintended directory. */
export function devUserDataPath(appData: string, appName: string): string {
    if (appData.trim() === '') {
        throw new Error('devUserDataPath: appData is empty, so there is no directory to place it under.');
    }
    if (appName.trim() === '') {
        throw new Error(
            'devUserDataPath: the application name is empty. It comes from package.json `name`; ' +
            'an empty name would put development data in "' + DEVELOPMENT_USER_DATA_SUFFIX + '".'
        );
    }
    return join(appData, appName + DEVELOPMENT_USER_DATA_SUFFIX);
}

/** Points userData at the development directory. Throws when packaged (D-09): a crash is loud, an orphaned krono.db is not. */
export function applyDevelopmentUserDataPath(app: UserDataApp): string {
    if (app.isPackaged) {
        throw new Error(
            'D-09: applyDevelopmentUserDataPath was reached in a PACKAGED build. Relocating ' +
            'userData here would orphan every installed user\'s krono.db, so the app refuses to ' +
            'start instead. The caller must only apply the development directory when ' +
            'app.isPackaged is false.'
        );
    }

    const target = devUserDataPath(app.getPath('appData'), app.getName());

    // D-08: the repository's only sanctioned userData relocation - unreachable when packaged, and it can only
    // point away from the directory real users' data lives in. tests/app-identity.test.ts allowlists it.
    // eslint-disable-next-line no-restricted-properties
    app.setPath('userData', target);

    return target;
}

/** WR-06: honours an explicit --user-data-dir in an unpackaged build, but never the production directory. */
export function applyUnpackagedUserDataPath(app: UnpackagedUserDataApp): string {
    // A packaged app goes straight to the D-09 refusal, before the command line is even read.
    if (app.isPackaged || !app.commandLine.hasSwitch(USER_DATA_DIR_SWITCH)) {
        return applyDevelopmentUserDataPath(app);
    }
    const explicit = app.getPath('userData');
    const production = join(app.getPath('appData'), app.getName());
    if (isSameOrInside(production, explicit)) {
        throw new Error(
            'WR-06: --' + USER_DATA_DIR_SWITCH + ' points at the production userData directory ' + production +
            '; an unpackaged build may never run against the directory real users\' krono.db lives in.'
        );
    }
    return explicit;
}

/** Whether `child` is `parent` or inside it, case-folded where the filesystem usually ignores case. */
function isSameOrInside(parent: string, child: string): boolean {
    const fold = (p: string): string =>
        process.platform === 'win32' || process.platform === 'darwin' ? resolve(p).toLowerCase() : resolve(p);
    const rel = relative(fold(parent), fold(child));
    return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
}
