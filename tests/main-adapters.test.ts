// ARCH-01: the four ports' implementations, and the inventory of every main-process file that names electron.
// The adapters are the seam the services must never reach around, so what they promise is asserted here rather
// than inside a service that could quietly stop using them.

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { ipcEvents } from '@shared/ipc/contract';
import { createElectronNotifier } from '../src/main/adapters/electron-notifier.adapter';
import { createElectronRendererBus } from '../src/main/adapters/electron-renderer-bus.adapter';
import type { RendererTarget } from '../src/main/adapters/electron-renderer-bus.adapter';
import { createRendererSound } from '../src/main/adapters/renderer-sound.adapter';
import { createSystemClock } from '../src/main/adapters/system-clock.adapter';
import { createElectronPorts } from '../src/main/adapters';
import { eagerImports, read, repoRoot, scriptKindFor } from './helpers/ts-imports';

interface Sent {
    channel: string;
    payload: unknown;
}

const SOUND_PAYLOAD = { sound: 'goalReached' } as const;

function target(sent: Sent[], options: { destroyed?: boolean; throws?: boolean } = {}): RendererTarget {
    return {
        webContents: {
            isDestroyed: () => options.destroyed === true,
            send(channel, payload) {
                if (options.throws === true) throw new Error('render frame was disposed');
                sent.push({ channel, payload });
            }
        }
    };
}

const refuseToLog = (): never => { throw new Error('this case must log nothing'); };
const ignoreLog = (): void => undefined;

describe('the system clock keeps the two kinds of time apart (CORE-04)', () => {
    const clock = createSystemClock();

    it('names an instant with the wall clock', () => {
        expect(Math.abs(clock.now() - Date.now())).toBeLessThan(1_000);
    });

    it('measures an interval with a source that is not the wall clock', () => {
        // Wall time is epoch-based and monotonic time is process-based, so they are eras apart. A monotonicNow that
        // returned Date.now() - the mutation this exists to catch - would land within a millisecond of it.
        expect(clock.monotonicNow()).toBeLessThan(clock.now() - 1_000_000_000);
    });

    it('never goes back', () => {
        let previous = clock.monotonicNow();
        for (let i = 0; i < 10_000; i++) {
            const current = clock.monotonicNow();
            expect(current).toBeGreaterThanOrEqual(previous);
            previous = current;
        }
    });
});

describe('the renderer bus delivers to every live window and drops the rest', () => {
    it('sends the channel and payload to each live target', () => {
        const sent: Sent[] = [];
        const bus = createElectronRendererBus(refuseToLog, () => [target(sent), target(sent)]);
        bus.emit('app:playSound', SOUND_PAYLOAD);
        expect(sent).toEqual([
            { channel: 'app:playSound', payload: SOUND_PAYLOAD },
            { channel: 'app:playSound', payload: SOUND_PAYLOAD }
        ]);
    });

    it('skips a destroyed target rather than sending into it', () => {
        const sent: Sent[] = [];
        const bus = createElectronRendererBus(ignoreLog, () => [target(sent, { destroyed: true })]);
        bus.emit('app:playSound', SOUND_PAYLOAD);
        expect(sent).toEqual([]);
    });

    it('drops the event when no window is on screen', () => {
        const bus = createElectronRendererBus(ignoreLog, () => []);
        expect(() => { bus.emit('app:playSound', SOUND_PAYLOAD); }).not.toThrow();
    });

    it('logs a send that throws and still reaches the window after it', () => {
        const sent: Sent[] = [];
        const lines: string[] = [];
        const bus = createElectronRendererBus((line) => lines.push(line),
            () => [target(sent, { throws: true }), target(sent)]);
        bus.emit('app:playSound', SOUND_PAYLOAD);
        expect(sent).toHaveLength(1);
        expect(lines).toEqual(['renderer bus: app:playSound not delivered - render frame was disposed']);
    });

    it('defaults to the main windows of this process, of which a test has none', () => {
        const bus = createElectronRendererBus(refuseToLog);
        expect(() => { bus.emit('app:playSound', SOUND_PAYLOAD); }).not.toThrow();
    });
});

describe('the sound port asks the renderer, because only a document can play audio', () => {
    it('emits app:playSound with a payload the declared event schema accepts', () => {
        const sent: Sent[] = [];
        const bus = createElectronRendererBus(ignoreLog, () => [target(sent)]);
        createRendererSound(bus).play('goalReached');
        expect(sent).toHaveLength(1);
        expect(sent[0]?.channel).toBe('app:playSound');
        expect(ipcEvents['app:playSound'].safeParse(sent[0]?.payload).success).toBe(true);
    });
});

describe('the notifier is best effort', () => {
    // Outside an Electron process require('electron') yields the binary path, so Notification is undefined here -
    // the same shape as a platform that cannot notify, and exactly the case a service must not have to handle.
    it('reports rather than throws when the platform cannot notify, and quotes no notification text', () => {
        const lines: string[] = [];
        const notifier = createElectronNotifier((line) => lines.push(line));
        expect(() => { notifier.notify({ title: 'Daily goal reached', body: 'Acme Ltd - 8h 00m' }); }).not.toThrow();
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatch(/^notification: not shown - /);
        expect(lines[0]).not.toContain('Daily goal reached');
        expect(lines[0]).not.toContain('Acme Ltd');
    });
});

describe('createElectronPorts builds the whole port surface once', () => {
    it('returns exactly the four ports AppPorts declares', () => {
        const ports = createElectronPorts(ignoreLog);
        expect(Object.keys(ports).sort()).toEqual(['bus', 'clock', 'notifier', 'sound']);
        expect(ports.clock.monotonicNow()).toBeGreaterThan(0);
    });

    it('routes the sound port through a bus rather than through a window of its own', () => {
        const sent: Sent[] = [];
        const bus = createElectronRendererBus(ignoreLog, () => [target(sent)]);
        createRendererSound(bus).play('goalReached');
        expect(sent.map((s) => s.channel)).toEqual(['app:playSound']);
    });
});

/*
 * ARCH-01, criterion 11: Electron APIs live in the bootstrap, window, lifecycle, tray and ipc/ modules, and
 * everywhere else behind ports/ + adapters/. This inventory is how a new electron import in src/main announces
 * itself: adding one without a line here fails, and so does removing a file this list still names.
 */
const ELECTRON_IMPORTERS: Readonly<Record<string, string>> = {
    'src/main/index.ts': 'the bootstrap',
    'src/main/lifecycle.ts': 'app lifecycle handlers',
    'src/main/window.ts': 'the main window factory and its navigation guards',
    'src/main/smoke.ts': 'the --smoke bootstrap, which is the packaged proof of the one above',
    'src/main/legacy-storage.ts': 'the offscreen extractor window that reads v1.2.1 localStorage',
    'src/main/adapters/electron-notifier.adapter.ts': 'the NotifierPort implementation'
};

// The bus adapter names no electron module: it sends on the webContents of the windows window.ts already owns.
const BUS_ADAPTER = 'src/main/adapters/electron-renderer-bus.adapter.ts';

function filesUnder(dir: string): string[] {
    return fs.readdirSync(path.join(repoRoot, dir), { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
            ? filesUnder(dir + '/' + entry.name)
            : (entry.name.endsWith('.ts') ? [dir + '/' + entry.name] : []));
}

/** Runtime imports only: userdata-path.ts takes App and CommandLine as types, which erase and reach no API. */
function importsElectronAtRuntime(file: string): boolean {
    const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, scriptKindFor(file));
    return eagerImports(source, true).some(({ specifier }) => specifier === 'electron' || specifier.startsWith('electron/'));
}

describe('ARCH-01: the inventory of main-process files that touch Electron', () => {
    const importers = filesUnder('src/main').filter(importsElectronAtRuntime);

    it('holds exactly the files this list names', () => {
        expect(importers.sort()).toEqual(Object.keys(ELECTRON_IMPORTERS).sort());
    });

    it('finds no electron import under src/main/services, src/main/ports or the composition root', () => {
        const forbidden = importers.filter((file) =>
            file.startsWith('src/main/services/') || file.startsWith('src/main/ports/') ||
            file === 'src/main/container.ts');
        expect(forbidden).toEqual([]);
    });

    it('reaches windows from the bus adapter only through src/main/window.ts', () => {
        const source = ts.createSourceFile(BUS_ADAPTER, read(BUS_ADAPTER), ts.ScriptTarget.Latest, true,
            scriptKindFor(BUS_ADAPTER));
        const specifiers = eagerImports(source, true).map((i) => i.specifier);
        expect(specifiers).toContain('../window');
        expect(specifiers.filter((s) => s.startsWith('electron'))).toEqual([]);
    });
});
