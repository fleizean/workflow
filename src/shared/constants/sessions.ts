/*
 * WR-07: what a session may say, bounded the way settings.service.ts bounds every number it takes. The wire accepted
 * a durationSeconds of 1 099 511 627 776 and a name of nothing at all, while a daily target above 86 400 was refused
 * at length - and for the same reason. One absurd duration puts its date past every conceivable target for ever: the
 * streak counts it, the week total reports it, and the daily goal on that day can never not be met.
 *
 * These bound what may be written, never what may be read. A v1.2.1 row can hold a longer duration than a day,
 * because v1.2.1 counted time while the app was closed (B12), and refusing to show the user their own row would be
 * a worse answer than showing them a wrong one.
 */

/** A session is a block of work inside one day, so a day is the most one can honestly be. */
export const MAX_SESSION_DURATION_SECONDS = 86_400;

/** Long enough for any name a person types into a one-line field, short enough to render and to log. */
export const MAX_SESSION_NAME_LENGTH = 200;

/** A note is a sentence or two about what was done, not a document. */
export const MAX_SESSION_NOTE_LENGTH = 2_000;
