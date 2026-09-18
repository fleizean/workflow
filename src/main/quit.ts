// Criterion 8: the difference between closing the window and quitting the app. v1.2.1 kept this in an `isQuiting`
// variable read inside the close handler; written as a function, it is something a test can ask.

export type CloseDecision = 'hide' | 'close';

let quitting = false;

/** Set from app.on('before-quit'), whatever started the quit - the tray menu, the installer, a system shutdown. */
export function markQuitting(): void {
    quitting = true;
}

export function isQuitting(): boolean {
    return quitting;
}

/** Only for tests: the flag is process-wide, and a quit is not something a process comes back from. */
export function resetQuittingForTests(): void {
    quitting = false;
}

export interface WindowCloseState {
    readonly quitting: boolean;
    /** Whether there is a tray icon to hide to. new Tray() does fail - on Windows while Explorer is restarting. */
    readonly hasTray: boolean;
}

/**
 * Hide, unless the app is on its way out, or unless there is nowhere to hide to. Hiding while quitting is what made
 * v1.2.1's window refuse to go away; hiding with no tray leaves a process only Task Manager can end, which costs the
 * user the seconds the timer was holding (WR-03).
 */
export function decideWindowClose(state: WindowCloseState): CloseDecision {
    return state.quitting || !state.hasTray ? 'close' : 'hide';
}
