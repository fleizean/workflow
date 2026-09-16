/*
 * Which dialog is on top, for the one component every dialog in this app is built from.
 *
 * WR-04: Modal registered a document-level Escape handler per instance and called onDismiss with no check that it
 * was the topmost, so two mounted Modals meant two listeners and one keystroke dismissed both. The reachable case
 * is the worst one: a tick pushes the day past its target while the Save dialog is open, the goal congratulation
 * opens on top, and Escape to clear the congratulation also discards the session name, note and date the user had
 * just typed.
 *
 * A module rather than a counter inside the component, because "the topmost one answers" is a rule that can then
 * be run (tests/modal-stack.test.ts) instead of read.
 */

let nextHandle = 0;
const stack: number[] = [];

/** Registers a newly mounted dialog and returns its handle. */
export function pushModal(): number {
    nextHandle += 1;
    stack.push(nextHandle);
    return nextHandle;
}

/** Unregisters one. Out of order is fine, and closing a handle twice is not an error. */
export function popModal(handle: number): void {
    const at = stack.indexOf(handle);
    if (at >= 0) {
        stack.splice(at, 1);
    }
}

export function isTopmostModal(handle: number): boolean {
    return stack.length > 0 && stack[stack.length - 1] === handle;
}

/** How many are open. Zero is what lets the shell out of `inert` again. */
export function openModalCount(): number {
    return stack.length;
}
