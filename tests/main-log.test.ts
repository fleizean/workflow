/*
 * The diagnostics file. `log` was console.log, and a packaged app launched from Finder or Explorer has no stdout
 * anybody can read: the macOS lid-close investigation needed one number the clamp already logs
 * ("a tick arrived N ms after the last one") and could not retrieve it after the fact.
 *
 * mkdtemp throughout. No real profile and no real krono.db is opened anywhere in this file.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { LOG_FILE_NAME, LOG_MAX_BYTES } from '../src/main/config';
import { createFileLog } from '../src/main/log';

const dirs: string[] = [];

afterAll(() => {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(tag: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wft-log-' + tag + '-'));
    dirs.push(dir);
    return dir;
}

const contentsOf = (dir: string, name = LOG_FILE_NAME): string =>
    fs.readFileSync(path.join(dir, name), 'utf8');

describe('the main process reports somewhere a user can send back', () => {
    it('writes each line to the file, with the instant it was written', () => {
        const dir = tempDir('write');
        const log = createFileLog({ dir });
        log('timer: a tick arrived 28841103 ms after the last one, so 28839103 ms of it was not credited');

        const text = contentsOf(dir);
        expect(text, 'the line the investigation needed is not in the file').toContain('28841103 ms');
        expect(text, 'the entry does not say when it happened').toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(text.endsWith('\n')).toBe(true);
    });

    it('appends rather than replacing, across two separate logs over one directory', () => {
        const dir = tempDir('append');
        createFileLog({ dir })('first');
        createFileLog({ dir })('second');
        const lines = contentsOf(dir).trim().split('\n');
        expect(lines, 'a second run of the app truncated the first run').toHaveLength(2);
        expect(lines[0]).toContain('first');
        expect(lines[1]).toContain('second');
    });

    it('creates the directory when it is not there yet', () => {
        const dir = path.join(tempDir('mkdir'), 'nested', 'userData');
        createFileLog({ dir })('a line');
        expect(fs.existsSync(path.join(dir, LOG_FILE_NAME))).toBe(true);
    });

    it('also mirrors to the sink a developer is watching', () => {
        const dir = tempDir('mirror');
        const seen: string[] = [];
        createFileLog({ dir, mirror: (line) => seen.push(line) })('a line');
        expect(seen, 'the dev-run stdout stopped carrying the line').toEqual(['a line']);
    });
});

describe('it is bounded, so a long-running app cannot fill the disk', () => {
    it('keeps the file under its cap and keeps the most recent lines', () => {
        const dir = tempDir('bound');
        const maxBytes = 4_096;
        const log = createFileLog({ dir, maxBytes });
        for (let i = 0; i < 400; i += 1) {
            log('line ' + String(i) + ' - ' + 'x'.repeat(40));
        }

        const text = contentsOf(dir);
        expect(text.length, 'the log grew past its cap').toBeLessThanOrEqual(maxBytes);
        expect(text, 'the newest line was trimmed instead of the oldest').toContain('line 399');
        expect(text, 'the oldest lines survived a trim').not.toContain('line 0 -');
        // Trimmed at a line boundary: a half-entry at the top is unreadable and dates the file wrongly.
        expect(text.split('\n')[0]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('ships a cap that is a bound a user would accept', () => {
        expect(LOG_MAX_BYTES).toBeLessThanOrEqual(1024 * 1024);
    });
});

describe('a log that cannot be written never takes the caller down with it', () => {
    it('reports once to the mirror and goes on answering', () => {
        const dir = tempDir('refused');
        // A FILE where the directory should be: mkdirSync and appendFileSync both refuse this.
        const blocked = path.join(dir, 'blocked');
        fs.writeFileSync(blocked, 'not a directory');

        const seen: string[] = [];
        const log = createFileLog({ dir: blocked, mirror: (line) => seen.push(line) });
        expect(() => { log('first'); }).not.toThrow();
        expect(() => { log('second'); }).not.toThrow();

        expect(seen.filter((line) => line.startsWith('log: ')),
            'a refused disk said so once per line for the rest of the run').toHaveLength(1);
        expect(seen, 'the caller lost its line as well as its file').toContain('second');
    });
});
