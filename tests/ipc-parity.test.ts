// Criterion 6: every entry on the Phase 1 window.api inventory has a counterpart in the new typed bridge, and a grep
// proves navigate is not a channel anywhere in the v2 source. The inventory is read from the committed artifact
// tests/inventory.test.ts holds equal to v1.2.1's preload.js, so this cannot pass against a stale list.

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ipcContract, ipcEvents } from '../src/shared/ipc/contract';
import { read, repoRoot, stripCommentsAndStrings } from './helpers/ts-imports';
import type { IpcChannel } from '../src/shared/types';

type Disposition =
    | { readonly channel: IpcChannel }
    /** Removed with the Google Sheets export by the owner on 2026-09-11; the columns stay in krono.db unread. */
    | { readonly removed: 'owner-removed'; readonly why: string }
    /** Deleted on purpose, not overlooked. */
    | { readonly removed: 'deleted'; readonly why: string }
    | { readonly removed: 'not-ported'; readonly why: string };

// One row per name in baselines/v1.2.1/preload-surface.txt. A name with no row fails the totality check below.
const DISPOSITIONS: Readonly<Record<string, Disposition>> = {
    // It hid the window rather than closing it, so window:hide is the capability it actually provided. What changed
    // on 2026-09-13 is which button asks for it: the titlebar X asks app:quit now.
    closeWindow: { channel: 'window:hide' },
    createCompany: { channel: 'companies:create' },
    deleteAllSessions: { channel: 'sessions:deleteAll' },
    deleteCompany: { channel: 'companies:delete' },
    deleteSession: { channel: 'sessions:delete' },
    exportDayEnd: { removed: 'owner-removed', why: 'the Google Sheets export the owner removed on 2026-09-11' },
    getCompanies: { channel: 'companies:list' },
    getCompany: { channel: 'companies:get' },
    getCurrentStreak: { channel: 'stats:streak' },
    getSessions: { channel: 'sessions:list' },
    getSessionsByDate: { channel: 'sessions:listByDateRange' },
    getSessionsByDateCompany: { channel: 'sessions:listByDateAndCompany' },
    getSessionsGrouped: {
        removed: 'not-ported',
        why: 'exposed but never called (SPA-15). Work History groups the sessions a date range returns, in the ' +
            'renderer, rather than asking the database for a grouping it then flattens'
    },
    getSetting: { channel: 'settings:get' },
    getTodaySessions: { channel: 'sessions:listByDateRange' },
    getTodaysSessionsSummary: { channel: 'stats:dayProgress' },
    getWeekTotal: { channel: 'stats:weekTotals' },
    minimizeWindow: { channel: 'window:hide' },
    navigateTo: {
        removed: 'deleted',
        why: 'S1: an unvalidated page argument reached loadFile. HashRouter needs no server to rewrite a path ' +
            'under file://, so the channel is deleted rather than validated'
    },
    previewDayEnd: { removed: 'owner-removed', why: 'the Google Sheets export the owner removed on 2026-09-11' },
    saveSession: { channel: 'sessions:create' },
    setSetting: { channel: 'settings:update' },
    updateCompany: { channel: 'companies:update' },
    updateCompanyExcelConfig: {
        removed: 'owner-removed',
        why: 'the per-company sheet columns; excel_column and note_column stay in krono.db and no service reads them'
    },
    updateSession: { channel: 'sessions:update' }
};

// B4: the UI called window.api.saveSetting, which preload.js never exposed, so two pomodoro_enabled writes were lost.
const UNEXPOSED_CALL: Readonly<Record<string, IpcChannel>> = { saveSetting: 'settings:update' };

// Channels with no v1.2.1 counterpart, each with the capability that earned it. Stated so the map is total in both
// directions: a channel added without a reason shows up here as an unexplained newcomer.
const NEW_IN_V2: Readonly<Record<string, string>> = {
    'timer:getSnapshot': 'the clock moved into main (X1); v1.2.1 kept it in the renderer and persisted a startTime',
    'timer:start': 'the clock moved into main',
    'timer:pause': 'the clock moved into main',
    'timer:reset': 'the clock moved into main',
    'timer:setMode': 'CORE-14: changing the mode no longer resets what was counted (CB-1)',
    'timer:stopAndSave':
        'WR-06: saving a session and clearing the accumulator is one transaction, because two invokes cannot be ' +
        'atomic - one order duplicates the work on the next launch, the other destroys it',
    'pomodoro:getSnapshot': 'the cycle is a main-process state machine, not renderer variables (CORE-11)',
    'pomodoro:start': 'the cycle is a main-process state machine',
    'pomodoro:pause': 'the cycle is a main-process state machine',
    'pomodoro:abort': 'POMO-04: an abandoned interval records nothing and advances no counter',
    'pomodoro:skipBreak': 'POMO-05: a break can be ended from the UI',
    'pomodoro:counts': 'POMO-09: the daily and weekly pomodoro counts, which v1.2.1 never showed',
    'window:claimHideNotice':
        'owner decision 2026-09-13: the hide button explains once where the window went, and the flag is a row in ' +
        'app_state rather than a localStorage key the renderer may not have (ARCH-03)',
    'app:quit':
        'owner decision 2026-09-13: v1.2.1 had no way to end the app from the window at all - closeWindow hid it, ' +
        'and only the tray menu could quit'
};

const artifactLines = (rel: string): string[] =>
    fs.readFileSync(path.join(repoRoot, rel), 'utf8').split(/\r?\n/).filter((line) => line !== '');

const INVENTORY = artifactLines('baselines/v1.2.1/preload-surface.txt');
const CHANNELS = new Set<string>(Object.keys(ipcContract));

describe('criterion 6: the v1.2.1 window.api surface has a counterpart in the typed bridge', () => {
    it('has a row for every name on the inventory, and for no name that is not on it', () => {
        expect(INVENTORY.length, 'the inventory artifact is empty, so this file proves nothing').toBe(25);
        expect(Object.keys(DISPOSITIONS).sort(), 'the inventory and this map disagree').toEqual([...INVENTORY].sort());
    });

    it.each(INVENTORY)('%s', (name) => {
        const disposition = DISPOSITIONS[name];
        expect(disposition, name + ' has no disposition').toBeDefined();
        if (disposition !== undefined && 'channel' in disposition) {
            expect(CHANNELS.has(disposition.channel),
                name + ' is mapped to ' + disposition.channel + ', which the contract does not declare').toBe(true);
        } else {
            expect(disposition?.why.length, name + ' is unported with no reason given').toBeGreaterThan(20);
        }
    });

    it('ports 20 of the 25 and names the five it does not, one of them the deliberate deletion', () => {
        const unported = Object.entries(DISPOSITIONS).filter(([, d]) => 'removed' in d);
        expect(unported.map(([name]) => name).sort())
            .toEqual(['exportDayEnd', 'getSessionsGrouped', 'navigateTo', 'previewDayEnd', 'updateCompanyExcelConfig']);
        expect(unported.filter(([, d]) => 'removed' in d && d.removed === 'owner-removed')).toHaveLength(3);
        expect(Object.keys(DISPOSITIONS).length - unported.length).toBe(20);
    });

    it('closes B4: the write the UI made through a name preload never exposed now has a channel', () => {
        for (const [name, channel] of Object.entries(UNEXPOSED_CALL)) {
            expect(CHANNELS.has(channel), name + ' still has no counterpart').toBe(true);
        }
    });

    it('accounts for every channel in the other direction too', () => {
        const ported = new Set(Object.values(DISPOSITIONS).flatMap((d) => 'channel' in d ? [d.channel as string] : []));
        const unexplained = [...CHANNELS].filter((channel) => !ported.has(channel) && !(channel in NEW_IN_V2));
        expect(unexplained,
            'these channels answer to no v1.2.1 capability and no stated new one:\n  ' + unexplained.join('\n  '))
            .toEqual([]);
    });

    it('answers on at least as many channels as v1.2.1 did', () => {
        expect(CHANNELS.size).toBeGreaterThanOrEqual(artifactLines('baselines/v1.2.1/ipc-channels.txt').length);
    });
});

/*
 * The grep half of criterion 6, over the v2 tree only: main.js, database/db.js and legacy/pages/*.html are the v1.2.1
 * code this milestone replaces and Phase 7 deletes. What is asserted is stronger than "no channel is called
 * navigate" - no string literal anywhere in the new source says it, apart from Electron's own will-navigate event,
 * which is the guard that refuses navigation rather than a channel that performs it.
 */
describe('criterion 6: navigate is not a channel anywhere in the v2 source', () => {
    const V2_TREES = ['src/main', 'src/preload', 'src/shared', 'src/renderer/src'];
    // Electron's own event names. will-navigate and will-redirect are the guards that REFUSE a navigation;
    // did-navigate and did-navigate-in-page are how the packaged smoke tells a document load from a hash change.
    const ALLOWED = new Set(['will-navigate', 'did-navigate', 'did-navigate-in-page']);

    const v2Files = (): string[] =>
        execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', ...V2_TREES], {
            cwd: repoRoot,
            encoding: 'utf8'
        })
            .split('\n')
            .map((line) => line.trim())
            .filter((file) => /\.(ts|tsx)$/.test(file) && fs.existsSync(path.join(repoRoot, file)));

    it('reads the v2 source it claims to', () => {
        const files = v2Files();
        expect(files, 'the scan cannot see the modules it guards').toEqual(expect.arrayContaining([
            'src/main/window.ts', 'src/main/ipc/register.ts', 'src/preload/bridge.ts', 'src/shared/ipc/contract.ts'
        ]));
    });

    it('finds no string literal saying navigate but the will-navigate guard', () => {
        const found = v2Files().flatMap((file) =>
            stripCommentsAndStrings(file, read(file)).strings
                .filter((literal) => literal.value.includes('navigate'))
                .map((literal) => file + ' ' + JSON.stringify(literal.value)));

        const offenders = found.filter((entry) => ![...ALLOWED].some((allowed) => entry.endsWith('"' + allowed + '"')));
        expect(offenders, 'S1: navigate is back in the source:\n  ' + offenders.join('\n  ')).toEqual([]);
        expect(found.length, 'the will-navigate guard is gone, so this scan proves nothing').toBeGreaterThan(0);
    });

    it('declares no channel and no event whose name contains it', () => {
        for (const name of [...Object.keys(ipcContract), ...Object.keys(ipcEvents)]) {
            expect(name.toLowerCase()).not.toContain('navigate');
        }
    });
});
