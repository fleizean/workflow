/*
 * WR-07: what a session may say, bounded the way settings.service.ts bounds every number it takes. The wire accepted
 * a durationSeconds of 1 099 511 627 776 while a daily target above 86 400 was refused at length, for the same
 * reason: one absurd duration puts its date past every conceivable target for ever, so the streak counts it, the
 * week total reports it, and the daily goal on that day can never not be met.
 *
 * These bound what may be written, never what may be read. A v1.2.1 row can hold a duration longer than a day
 * because v1.2.1 counted time while the app was closed (B12), and refusing to show the user their own row would be
 * a worse answer than showing them a wrong one.
 */

/** A session is a block of work inside one day, so a day is the most one can honestly be. */
export const MAX_SESSION_DURATION_SECONDS = 86_400;

/** Long enough for any name a person types into a one-line field, short enough to render and to log. */
export const MAX_SESSION_NAME_LENGTH = 200;

/** A note is a sentence or two about what was done, not a document. */
export const MAX_SESSION_NOTE_LENGTH = 2_000;

/*
 * POMO-01/POMO-04: the name a completed pomodoro interval is written under, before anybody is asked which company it
 * was for. In shared rather than src/main/notifications.ts because both ends need it: main writes the row and the
 * renderer has to recognise the rows still waiting to be attributed.
 *
 * The recognition rule, which the name alone does not carry: a session is awaiting attribution when it is named
 * this, has no company, AND has a NULL note. A null note means nobody has been asked; an empty string means somebody
 * was asked and had nothing to say - which is what lets a user answer "no company, no note" once.
 *
 * v1.2.1 wrote no such row at all: completePomodoroSession (legacy/renderer/timer.js:150-186) fires a callback
 * index.html never assigns and touches the database nowhere, so a v1.2.1 database holds none to be mistaken for one.
 */
export const POMODORO_SESSION_NAME = 'Pomodoro';

/*
 * WR-02: the earliest a row this app wrote could be a pending pomodoro - 2026-09-15T00:00:00Z, the day the cycle
 * first wrote a session (Phase 8 slice D). The predicate above reads three columns a user controls, and the name is
 * an ordinary word somebody might type; this bounds it to rows that could have come from the cycle at all.
 *
 * What it does not bound, stated rather than implied: v1.2.1's Work History form wrote `value.trim() || null` and
 * demanded a note only when the company did, so a session called Pomodoro with no company and no note was routine -
 * and every such row predates this instant. lib/session-note.ts closes the other half by making v2's forms write a
 * string rather than NULL. What is left is a user still on v1.2.1 who types that exact row after this date and then
 * migrates; a durable marker would remove it, at the cost of a migration.
 */
export const POMODORO_ATTRIBUTION_EPOCH_MS = 1_789_430_400_000;
