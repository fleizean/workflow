/*
 * WR-02: a click whose work is still in flight is not a second click.
 *
 * The hide button starts an IPC round trip and only then draws the one-time notice. Without this, a double-click
 * started two: the second claimed a notice that was no longer due and hid the window immediately, and the first
 * then drew the explanation on a window that was already gone - the precise failure the two-round-trip design
 * exists to prevent, with the flag spent and no way to re-arm it.
 */

export function once(task: () => Promise<void>): () => Promise<void> {
    let running: Promise<void> | null = null;
    return () => {
        running ??= task().finally(() => { running = null; });
        return running;
    };
}
