/*
 * What a form writes into a session's note, and the one thing a NULL there means.
 *
 * POMO-04 carries "awaiting attribution" in user data: a session named Pomodoro, with no company, with a NULL note,
 * is one nobody has been asked about yet; an empty string is one that was asked and had nothing to say.
 *
 * 08-REVIEW-TIMER WR-01 is what happens when a second feature does not know the rule. History's edit form wrote
 * `note: trimmedNote === '' ? null : trimmedNote`, so opening an attributed pomodoro to correct its duration and
 * pressing Save widened its empty note back to NULL and re-armed the prompt for ever - reproduced against the real
 * repository. WR-02 is the other end: the save form wrote NULL for an empty note too, so the app itself could
 * create a row indistinguishable from a pending one.
 *
 * The rule, in one place both features read:
 *
 *  - a form that SHOWED the note field has asked, so it writes a string. Only the pomodoro cycle writes NULL.
 *  - except on an edit of a row whose note is already NULL: that row is still one nobody has answered, and saving a
 *    change to its duration is not an answer. A field nobody typed into is never written.
 */

export type NoteMode = 'create' | 'edit';

export function noteToWrite(typed: string, storedNote: string | null, mode: NoteMode): string | null {
    const trimmed = typed.trim();
    if (trimmed !== '') {
        return trimmed;
    }
    return mode === 'edit' && storedNote === null ? null : '';
}
