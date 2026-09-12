// Criterion 8: the difference between closing the window and quitting the app. v1.2.1 kept this in an `isQuiting`
// variable in main.js and read it inside the close handler; the decision is the same and is written here as a
// function, so what the window does with a close is something a test can ask rather than something only a user can.

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

/**
 * Hide, unless the app is on its way out. Hiding on close is what puts the app in the tray and keeps the timer
 * counting; doing it while quitting is what made v1.2.1's window refuse to go away.
 */
export function decideWindowClose(state: { readonly quitting: boolean }): CloseDecision {
    return state.quitting ? 'close' : 'hide';
}
