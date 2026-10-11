/*
 * Diagnostics that outlive the run. `log` was console.log, and a packaged app launched from Finder or Explorer has
 * no stdout anybody can read - so every line this app writes went nowhere retrievable. The macOS lid-close
 * investigation spent its whole length on a question the clamp already logs the exact answer to ("a tick arrived N
 * ms after the last one"), and that line was unavailable after the fact.
 *
 * A bounded file, not a logging framework: one file in userData, trimmed from the front when it reaches its cap, so
 * it can never cost a user more than LOG_MAX_BYTES and the most recent lines are always the ones that survive.
 * Electron-free - the directory arrives as an argument, so this module is not a tenth place that knows what
 * Electron is (ARCH-01).
 */

import fs from 'node:fs';
import path from 'node:path';
import { utcIsoTimestamp } from '@shared/utils/date';
import { LOG_FILE_NAME, LOG_MAX_BYTES } from './config';
import { describeError } from './errors';

export interface FileLogOptions {
    /** userData, in the packaged app. Created if it is not there. */
    readonly dir: string;
    /** Where the line also goes while somebody is watching a terminal; the packaged app has no reader for it. */
    readonly mirror?: (line: string) => void;
    readonly maxBytes?: number;
    /** Overridden only by tests that need two logs in one directory. */
    readonly fileName?: string;
}

/** The whole file, minus the oldest half, cut at a line boundary so no entry is left in pieces. */
function trimmed(existing: string): string {
    const keepFrom = Math.floor(existing.length / 2);
    const boundary = existing.indexOf('\n', keepFrom);
    return existing.slice(boundary < 0 ? keepFrom : boundary + 1);
}

/**
 * The sink the main process reports through. Never throws: every caller of it is already reporting another failure,
 * and a log that takes the process down with it is worse than one nobody reads.
 */
export function createFileLog(options: FileLogOptions): (line: string) => void {
    const maxBytes = options.maxBytes ?? LOG_MAX_BYTES;
    const file = path.join(options.dir, options.fileName ?? LOG_FILE_NAME);
    // Said once. A disk that refuses this line will refuse every line after it, and the mirror still works.
    let silenced = false;

    return (line: string): void => {
        options.mirror?.(line);
        if (silenced) {
            return;
        }
        try {
            fs.mkdirSync(options.dir, { recursive: true });
            const entry = utcIsoTimestamp(new Date()) + ' ' + line + '\n';
            if (fs.existsSync(file) && fs.statSync(file).size + entry.length > maxBytes) {
                fs.writeFileSync(file, trimmed(fs.readFileSync(file, 'utf8')) + entry);
                return;
            }
            fs.appendFileSync(file, entry);
        } catch (error) {
            silenced = true;
            options.mirror?.('log: the diagnostics file could not be written, so this run reports to stdout only - ' +
                describeError(error));
        }
    };
}
