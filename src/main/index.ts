// Main-process bootstrap: userData path, single-instance lock, whenReady, then the database layer by dynamic import -
// in that order (BUILD-03). Above the lock only the userData policy may run; the lock-ordering suite enforces it.

import { app } from 'electron';
import { mainConfig } from './config';
import { describeError } from './errors';
import { launchApplication, registerLifecycle } from './lifecycle';
import { finishSmoke, runSmoke } from './smoke';
import { applyUnpackagedUserDataPath } from './userdata-path';

// Electron keys the lock on userData, so an unpackaged build moves to its own directory first (WR-06).
if (!app.isPackaged) {
    applyUnpackagedUserDataPath(app);
}

const holdsInstanceLock = app.requestSingleInstanceLock();

if (!holdsInstanceLock) {
    // Another instance owns this userData directory and therefore its database.
    app.quit();
} else {
    registerLifecycle();
    main().catch((error: unknown) => {
        console.error('src/main/index.ts: startup failed - ' + describeError(error));
        app.exit(1);
    });
}

async function main(): Promise<void> {
    await app.whenReady();

    // Dynamic, so the database layer loads only after the lock, and only once the app is ready.
    const database = await import('../lib/db');

    if (mainConfig.smoke) {
        finishSmoke(await runSmoke(database));
        return;
    }

    await launchApplication(database);
}
