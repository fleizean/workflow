/*
 * src/main/userdata-path.ts
 *
 * Gives a development build its own userData directory, so `npm run dev` can never open, migrate
 * or corrupt the krono.db that holds a developer's real tracked time (BUILD-12).
 *
 * Electron resolves userData as DIR_APP_DATA + app.name, and app.name comes from package.json's
 * `name` - the value tests/app-identity.test.ts pins - which is why every installed v1.2.1 keeps
 * its data in <appData>/<name>. A development build runs from the same manifest, so without this
 * module it resolves the very same directory. This module moves the development build to
 * <appData>/<name>-dev, where <name> is read from the manifest at runtime and never written here
 * as a literal: a hard-coded directory name is a second source of truth that drifts. The name is
 * not spelled even in this comment, because tests/userdata-path.test.ts asserts its absence over
 * this file's raw text - a text gate cannot tell prose from a hard-coded directory name.
 *
 * D-07 - the split is made in code, not by a launch flag. --user-data-dir is a flag a developer
 * can forget, and `npm run dev` is not the only way Electron starts: a debugger attach, an IDE run
 * configuration or a bare `electron .` all bypass it. src/main/index.ts imports this module ahead
 * of every database-touching import and applies it before the single-instance lock and before
 * app.whenReady, so how the app is started cannot matter.
 *
 * D-09 - the development branch must be unreachable in a packaged build. A shipped build that
 * reached it would silently relocate every user's database: the app would start against an empty
 * directory and look like a fresh install, on machines the owner cannot reach and with no
 * telemetry to notice. So applyDevelopmentUserDataPath THROWS when the app is packaged, rather
 * than returning quietly. A crash at launch is loud and recoverable; an orphaned krono.db is
 * neither.
 *
 * D-08 - the one relocation call carries an inline exemption from CUSTODY-02's
 * no-restricted-properties rule, following the precedent src/lib/db/backup.ts set for its one
 * sanctioned file copy. The rule is not weakened, no directory is exempted, and the path is not
 * derived some other way to dodge it: the rule exists to force exactly this written
 * justification. tests/app-identity.test.ts carries the matching single-entry allowlist.
 *
 * Electron is imported for its type only. The functions take the app object as an argument, so
 * both can be unit-tested in plain Node against a stand-in object.
 */

import { join } from 'node:path';
import type { App } from 'electron';

/** Appended to the manifest name to form the development userData directory name. */
export const DEVELOPMENT_USER_DATA_SUFFIX = '-dev';

/** The slice of Electron's `app` this module touches. */
export type UserDataApp = Pick<App, 'isPackaged' | 'getName' | 'getPath' | 'setPath'>;

/**
 * The development userData directory for an app named `appName` under `appData`.
 *
 * Pure. Throws on an empty or whitespace-only argument, because either would silently produce a
 * directory nobody intended - `<appData>/-dev`, or a `-dev` directory relative to the working
 * directory.
 */
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

/**
 * Points userData at the development directory and returns it. Must run before app.whenReady.
 *
 * Throws when `app.isPackaged` is true (D-09). src/main/index.ts only calls it for an unpackaged
 * build; the throw is the backstop that makes a mistake in that caller loud instead of silent.
 */
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

    /*
     * D-07/D-08 - sanctioned relocation of userData, and the only one in this repository.
     * CUSTODY-02 bans moving userData because moving it orphans every existing krono.db. This
     * call cannot do that: it is reached only when app.isPackaged is false (checked immediately
     * above, and it throws otherwise), so no installed build ever executes it; and the target
     * derives from the manifest name plus a fixed suffix, so it can only ever point AWAY from the
     * directory real users' data lives in, never toward some other one.
     */
    // eslint-disable-next-line no-restricted-properties
    app.setPath('userData', target);

    return target;
}
