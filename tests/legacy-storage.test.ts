// D-33: the extractor runs exactly the two getItem reads, never writes a key, never blocks, and waits for its
// caller to release it. No electron mock: every case injects a recording stand-in (tests/userdata-path.test.ts style).

import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { LEGACY_STORAGE_TIMEOUT_MS } from '../src/main/config';
import { LEGACY_STORAGE_PAGE, readLegacyStorage, type ExtractorWindow } from '../src/main/legacy-storage';

// Restated here on purpose: a changed script must fail this test rather than silently read something else.
const TIMER_SCRIPT = 'localStorage.getItem("timerState")';
const GOAL_SCRIPT = 'localStorage.getItem("lastGoalNotificationDate")';

const TIMER_RAW = '{"elapsed":3600,"running":true,"lastUpdated":1757062800000}';

interface RecordingWindow extends ExtractorWindow {
    readonly scripts: string[];
    readonly loaded: string[];
    destroyCount: number;
}

interface StandInOptions {
    values?: Record<string, unknown>;
    loadFile?: () => Promise<void>;
    executeJavaScript?: (code: string) => Promise<unknown>;
}

function recordingWindow(options: StandInOptions = {}): RecordingWindow {
    const scripts: string[] = [];
    const loaded: string[] = [];
    let destroyed = false;
    const win: RecordingWindow = {
        scripts,
        loaded,
        destroyCount: 0,
        loadFile: (target: string): Promise<void> => {
            loaded.push(target);
            return options.loadFile === undefined ? Promise.resolve() : options.loadFile();
        },
        webContents: {
            executeJavaScript: (code: string): Promise<unknown> => {
                scripts.push(code);
                if (options.executeJavaScript !== undefined) {
                    return options.executeJavaScript(code);
                }
                const values = options.values ?? {};
                return Promise.resolve(code in values ? values[code] : null);
            }
        },
        destroy: (): void => {
            destroyed = true;
            win.destroyCount += 1;
        },
        isDestroyed: (): boolean => destroyed
    };
    return win;
}

const session = async (win: RecordingWindow, timeoutMs = 1_000): Promise<Awaited<ReturnType<typeof readLegacyStorage>>> =>
    readLegacyStorage({ factory: () => win, timeoutMs, pagePath: '/fixture/legacy-storage.html' });

describe('D-33: the extractor reads exactly the two v1.2.1 keys', () => {
    it('runs the two getItem scripts, in order, and loads only the page it was given', async () => {
        const win = recordingWindow({ values: { [TIMER_SCRIPT]: TIMER_RAW, [GOAL_SCRIPT]: '2026-09-12' } });

        const { read } = await session(win);

        expect(win.scripts, 'the extractor executed something other than the two reads')
            .toEqual([TIMER_SCRIPT, GOAL_SCRIPT]);
        expect(win.loaded).toEqual(['/fixture/legacy-storage.html']);
        expect(read).toEqual({ ok: true, timerState: TIMER_RAW, lastGoalNotificationDate: '2026-09-12' });
    });

    it('never executes a script that could write or clear a key (T-04-40)', async () => {
        const win = recordingWindow({ values: { [TIMER_SCRIPT]: TIMER_RAW, [GOAL_SCRIPT]: '2026-09-12' } });

        await session(win);

        for (const script of win.scripts) {
            for (const mutator of ['setItem', 'removeItem', 'clear', '=']) {
                expect(script.includes(mutator), 'a mutating script reached the v1.2.1 profile: ' + script).toBe(false);
            }
        }
    });

    it('passes a missing key through as null rather than failing the read', async () => {
        const win = recordingWindow({ values: { [TIMER_SCRIPT]: null, [GOAL_SCRIPT]: null } });

        expect((await session(win)).read).toEqual({ ok: true, timerState: null, lastGoalNotificationDate: null });
    });

    it('refuses a value that is neither a string nor null, naming the type and not the value', async () => {
        const win = recordingWindow({ values: { [TIMER_SCRIPT]: 42, [GOAL_SCRIPT]: '2026-09-12' } });

        const { read } = await session(win);

        expect(read.ok).toBe(false);
        if (read.ok) return;
        expect(read.reason).toContain('timerState');
        expect(read.reason).toContain('number');
        expect(read.reason, 'the refusal quoted the value itself').not.toContain('42');
    });
});

describe('D-33: a failure or a hang never blocks startup', () => {
    it('reports a timeout instead of waiting for a load that never resolves', async () => {
        const win = recordingWindow({ loadFile: () => new Promise<void>(() => undefined) });

        const { read } = await session(win, 20);

        expect(read.ok).toBe(false);
        if (read.ok) return;
        expect(read.reason).toContain('timeout');
    });

    it('reports a throwing executeJavaScript as a failed read', async () => {
        const win = recordingWindow({
            executeJavaScript: () => Promise.reject(new Error('Script failed to execute'))
        });

        const { read } = await session(win);

        expect(read.ok).toBe(false);
        if (read.ok) return;
        expect(read.reason).toContain('Script failed to execute');
    });

    it('reports a window it could not even construct, and still returns a safe release', async () => {
        const { read, release } = await readLegacyStorage({
            factory: () => { throw new Error('offscreen unavailable'); },
            timeoutMs: 1_000
        });

        expect(read.ok).toBe(false);
        if (!read.ok) {
            expect(read.reason).toContain('offscreen unavailable');
        }
        expect(() => { release(); }).not.toThrow();
    });
});

describe('Pitfall 4: the window is released by its caller, never by the read', () => {
    it('leaves the window alive until release() is called, and release() is idempotent', async () => {
        const win = recordingWindow({ values: { [TIMER_SCRIPT]: TIMER_RAW, [GOAL_SCRIPT]: '2026-09-12' } });

        const { release } = await session(win);

        expect(win.isDestroyed(), 'the read destroyed the extractor, which would fire window-all-closed').toBe(false);
        expect(win.destroyCount).toBe(0);

        release();
        release();

        expect(win.isDestroyed()).toBe(true);
        expect(win.destroyCount, 'release() destroyed the window more than once').toBe(1);
    });

    it('leaves the window alive even when the read failed', async () => {
        const win = recordingWindow({ executeJavaScript: () => Promise.reject(new Error('nope')) });

        const { read, release } = await session(win);

        expect(read.ok).toBe(false);
        expect(win.isDestroyed()).toBe(false);
        release();
        expect(win.isDestroyed()).toBe(true);
    });
});

describe('Y8: the page is resolved from the module, not the working directory', () => {
    it('is an absolute path to legacy-storage.html beside the renderer bundle', () => {
        const normalized = LEGACY_STORAGE_PAGE.split(path.sep).join('/');

        expect(path.isAbsolute(LEGACY_STORAGE_PAGE), LEGACY_STORAGE_PAGE + ' is not absolute').toBe(true);
        expect(path.basename(LEGACY_STORAGE_PAGE)).toBe('legacy-storage.html');
        expect(path.basename(path.dirname(LEGACY_STORAGE_PAGE)), 'the page left the renderer directory').toBe('renderer');
        expect(normalized.endsWith('/renderer/legacy-storage.html')).toBe(true);
    });

    it('takes its deadline from the one main config module', () => {
        expect(Number.isFinite(LEGACY_STORAGE_TIMEOUT_MS)).toBe(true);
        expect(LEGACY_STORAGE_TIMEOUT_MS).toBeGreaterThan(0);
    });
});
