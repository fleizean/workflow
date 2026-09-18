/*
 * REPO-06: the app knows its own version and whether a newer one exists.
 *
 * Four claims, and the fourth is the one that needs a real socket: the comparison is arithmetic and not a string
 * compare; the checker never blocks, never outlives a quit and never speaks twice about one version; the request is
 * a bare GET with nothing in it; and with nothing listening it FAILS SILENTLY rather than hanging. The offline case
 * is driven against a port that is closed, a host that does not resolve and a server that accepts and then says
 * nothing - the three shapes "no network" actually takes.
 */

import { afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import {
    compareVersions, createUpdateChecker, newerVersion, parseVersion
} from '../src/main/services/update.service';
import { createHttpsReleases } from '../src/main/adapters/https-releases.adapter';
import type { ReleasesPort, SchedulerPort } from '../src/main/ports';
import { read, repoRoot } from './helpers/ts-imports';

// CORE-03: the update service and its https adapter must both load with no Electron at all - the adapter is
// node:https on purpose, so that the check is a main-process concern and not an Electron one.
vi.mock('electron', () => {
    throw new Error('electron was imported by a module that must load without it');
});

const pkg = JSON.parse(read('package.json')) as Record<string, unknown>;

/* ---------------------------------------------------------------------------------------- */
/* A scheduler a test can be                                                                  */
/* ---------------------------------------------------------------------------------------- */

interface FakeScheduler {
    readonly port: SchedulerPort;
    /** Runs the one-shot the checker booked, as the host would after the delay. */
    fireFirst(): void;
    fireRepeat(): void;
    readonly delays: number[];
    readonly intervals: number[];
    cancels: number;
}

function fakeScheduler(): FakeScheduler {
    const delays: number[] = [];
    const intervals: number[] = [];
    let onceRun: (() => void) | undefined;
    let repeatRun: (() => void) | undefined;
    const self: FakeScheduler = {
        port: {
            every: (intervalMs, run) => {
                intervals.push(intervalMs);
                repeatRun = run;
                return { cancel: () => { self.cancels += 1; repeatRun = undefined; } };
            },
            after: (delayMs, run) => {
                delays.push(delayMs);
                onceRun = run;
                return { cancel: () => { self.cancels += 1; onceRun = undefined; } };
            }
        },
        fireFirst: () => { onceRun?.(); },
        fireRepeat: () => { repeatRun?.(); },
        delays,
        intervals,
        cancels: 0
    };
    return self;
}

const fixedReleases = (value: string | undefined): ReleasesPort => ({ latest: () => Promise.resolve(value) });

/* ---------------------------------------------------------------------------------------- */
/* The comparison                                                                             */
/* ---------------------------------------------------------------------------------------- */

describe('REPO-06: versions compare as numbers, not as strings', () => {
    it('reads 1.10.0 as newer than 1.9.0, which a string compare does not', () => {
        expect('1.10.0' > '1.9.0', 'the control: a string compare gets this wrong, which is why this test exists')
            .toBe(false);
        expect(newerVersion('1.9.0', '1.10.0')).toBe('1.10.0');
        expect(newerVersion('1.10.0', '1.9.0')).toBeUndefined();
    });

    it.each([
        ['2.0.0', '2.0.1', '2.0.1'],
        ['2.0.0', '2.1.0', '2.1.0'],
        ['2.0.0', '3.0.0', '3.0.0'],
        ['2.0.0', '10.0.0', '10.0.0'],
        ['2.0.0', '2.0.0', undefined],
        ['2.0.0', '1.99.99', undefined],
        // A release outranks its own pre-releases, and a pre-release never prompts someone on the release.
        ['2.0.0-rc.1', '2.0.0', '2.0.0'],
        ['2.0.0', '2.0.0-rc.1', undefined],
        ['2.0.0-rc.1', '2.0.0-rc.2', '2.0.0-rc.2'],
        ['2.0.0-rc.2', '2.0.0-rc.1', undefined],
        // Short forms: v1.2.1's sixteen date tags were not all three-part.
        ['2', '2.0.1', '2.0.1'],
        ['2.0', '2.0.0', undefined]
    ])('installed %s, published %s -> %s', (installed, published, expected) => {
        expect(newerVersion(installed, published)).toBe(expected);
    });

    it('says nothing at all when either side is unreadable', () => {
        for (const rubbish of ['', 'latest', 'v2.0.0', '2.0.0.0', '  ', '<!DOCTYPE html>', '1e3']) {
            expect(newerVersion('2.0.0', rubbish), 'a published "' + rubbish + '" was acted on').toBeUndefined();
        }
        expect(newerVersion('not-a-version', '99.0.0'),
            'an app that cannot say what it is called something else old').toBeUndefined();
        expect(newerVersion('2.0.0', undefined)).toBeUndefined();
    });

    it('accepts the leading and trailing whitespace a hand-edited manifest carries, and returns it trimmed', () => {
        expect(newerVersion('2.0.0', ' 2.1.0\n')).toBe('2.1.0');
    });

    it('parses and orders', () => {
        expect(parseVersion('2.3.4')).toEqual({ numbers: [2, 3, 4], preRelease: undefined });
        expect(parseVersion('2.3.4-beta.1')).toEqual({ numbers: [2, 3, 4], preRelease: 'beta.1' });
        expect(parseVersion('v2')).toBeUndefined();
        const a = parseVersion('2.0.0');
        const b = parseVersion('2.0.1');
        if (a === undefined || b === undefined) throw new Error('the fixture did not parse');
        expect(compareVersions(a, b)).toBe(-1);
        expect(compareVersions(b, a)).toBe(1);
        expect(compareVersions(a, a)).toBe(0);
    });
});

/* ---------------------------------------------------------------------------------------- */
/* The checker                                                                                */
/* ---------------------------------------------------------------------------------------- */

describe('REPO-06: the checker never blocks, never outlives a quit, never repeats itself', () => {
    it('start() returns without waiting for anything, even against a port that never answers', () => {
        const scheduler = fakeScheduler();
        const checker = createUpdateChecker({
            // A promise nobody will ever settle. If start() or the tick awaited it, this test would hang.
            releases: { latest: () => new Promise<string | undefined>(() => undefined) },
            scheduler: scheduler.port,
            installedVersion: '2.0.0',
            firstDelayMs: 30_000,
            intervalMs: 86_400_000,
            announce: () => { throw new Error('nothing was found, so nothing may be announced'); },
            log: () => undefined
        });

        checker.start();
        scheduler.fireFirst();

        expect(scheduler.delays, 'the first check runs immediately instead of after a delay').toEqual([30_000]);
        expect(scheduler.intervals).toEqual([86_400_000]);
        expect(checker.available()).toBeUndefined();
    });

    it('announces a newer version once, on the delayed check, and does not repeat it', async () => {
        const scheduler = fakeScheduler();
        const announced: string[] = [];
        const checker = createUpdateChecker({
            releases: fixedReleases('2.1.0'),
            scheduler: scheduler.port,
            installedVersion: '2.0.0',
            firstDelayMs: 1,
            intervalMs: 2,
            announce: (version) => announced.push(version),
            log: () => undefined
        });

        checker.start();
        checker.start(); // a second start must schedule nothing more
        scheduler.fireFirst();
        await Promise.resolve();
        await Promise.resolve();
        scheduler.fireRepeat();
        await Promise.resolve();
        await Promise.resolve();

        expect(scheduler.delays, 'start() scheduled twice').toHaveLength(1);
        expect(announced, 'the same version was announced on every tick').toEqual(['2.1.0']);
        expect(checker.available()).toBe('2.1.0');
    });

    it('says nothing when the published version is the installed one', async () => {
        const scheduler = fakeScheduler();
        const checker = createUpdateChecker({
            releases: fixedReleases('2.0.0'),
            scheduler: scheduler.port,
            installedVersion: '2.0.0',
            firstDelayMs: 1,
            intervalMs: 2,
            announce: () => { throw new Error('the installed version was offered as an update'); },
            log: () => undefined
        });
        checker.start();
        scheduler.fireFirst();
        await Promise.resolve();
        await Promise.resolve();
        expect(checker.available()).toBeUndefined();
    });

    it('cancels both timers on stop, and a check already in flight announces nothing', async () => {
        const scheduler = fakeScheduler();
        let settle: ((value: string | undefined) => void) | undefined;
        const checker = createUpdateChecker({
            releases: { latest: () => new Promise<string | undefined>((resolve) => { settle = resolve; }) },
            scheduler: scheduler.port,
            installedVersion: '2.0.0',
            firstDelayMs: 1,
            intervalMs: 2,
            announce: () => { throw new Error('a response that landed after quit reached the tray'); },
            log: () => undefined
        });

        checker.start();
        scheduler.fireFirst();
        // The quit happens here: the request is open and the answer has not come back yet.
        checker.stop();
        settle?.('99.0.0');
        await Promise.resolve();
        await Promise.resolve();

        expect(scheduler.cancels, 'stop() left a timer running').toBe(2);
        expect(checker.available()).toBeUndefined();
        // Nothing may be scheduled after a stop either - a second window must not restart a checker the quit killed.
        checker.start();
        expect(scheduler.delays, 'start() after stop() booked another check').toHaveLength(1);
    });

    it('survives a port that breaks its contract and rejects', async () => {
        const scheduler = fakeScheduler();
        const logs: string[] = [];
        const checker = createUpdateChecker({
            releases: { latest: () => Promise.reject(new Error('the port threw')) },
            scheduler: scheduler.port,
            installedVersion: '2.0.0',
            firstDelayMs: 1,
            intervalMs: 2,
            announce: () => { throw new Error('a rejection was read as an update'); },
            log: (line) => logs.push(line)
        });
        checker.start();
        scheduler.fireFirst();
        await Promise.resolve();
        await Promise.resolve();
        expect(logs.join('\n')).toContain('the releases port rejected');
    });
});

/* ---------------------------------------------------------------------------------------- */
/* The request, against real sockets                                                          */
/* ---------------------------------------------------------------------------------------- */

const servers: (http.Server | net.Server)[] = [];
const connections: net.Socket[] = [];

/** Every accepted socket is destroyed before the close: a keep-alive connection holds server.close() open forever. */
function track<T extends http.Server | net.Server>(server: T): T {
    server.on('connection', (socket: net.Socket) => { connections.push(socket); });
    server.unref();
    servers.push(server);
    return server;
}

afterAll(async () => {
    for (const socket of connections) socket.destroy();
    await Promise.all(servers.map((s) => new Promise<void>((done) => { s.close(() => { done(); }); })));
});

/** A port nothing is listening on: opened, its number taken, then closed. */
async function deadPort(): Promise<number> {
    const probe = net.createServer();
    await new Promise<void>((done) => { probe.listen(0, '127.0.0.1', () => { done(); }); });
    const address = probe.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    await new Promise<void>((done) => { probe.close(() => { done(); }); });
    return port;
}

const releasesAt = (url: string, timeoutMs = 750): ReleasesPort => createHttpsReleases({
    url, timeoutMs, maxBytes: 4096, log: () => undefined
});

describe('REPO-06: with no network, the check fails silently and quickly', () => {
    it('resolves to undefined against a closed port rather than rejecting or hanging', async () => {
        const port = await deadPort();
        await expect(releasesAt('https://127.0.0.1:' + String(port) + '/version.json').latest())
            .resolves.toBeUndefined();
    });

    it('resolves to undefined against a host that does not resolve', async () => {
        // .invalid is reserved by RFC 2606 and never resolves, so this is offline DNS without unplugging anything.
        await expect(releasesAt('https://workflow-timer.invalid/version.json').latest()).resolves.toBeUndefined();
    });

    it('gives up on a server that accepts the connection and then says nothing', async () => {
        // The shape a captive portal and a black-holing firewall both take: no error ever arrives, so only the
        // timeout ends it. Without request.on('timeout') this test hangs, which is the defect it is here for.
        const silent = track(net.createServer(() => undefined));
        await new Promise<void>((done) => { silent.listen(0, '127.0.0.1', () => { done(); }); });
        const address = silent.address();
        const port = typeof address === 'object' && address !== null ? address.port : 0;

        const started = Date.now();
        await expect(releasesAt('https://127.0.0.1:' + String(port) + '/version.json', 400).latest())
            .resolves.toBeUndefined();
        expect(Date.now() - started, 'the request outlived its own timeout').toBeLessThan(5_000);
    });

    it('refuses a manifest URL that is not https, without opening a socket', async () => {
        await expect(releasesAt('http://127.0.0.1:1/version.json').latest()).resolves.toBeUndefined();
        await expect(releasesAt('not a url at all').latest()).resolves.toBeUndefined();
    });
});

describe('REPO-06: what the request contains, and what it accepts back', () => {
    interface Seen {
        readonly method: string | undefined;
        readonly url: string | undefined;
        readonly headers: Readonly<Record<string, unknown>>;
    }

    /** A plain http server; the adapter refuses http, so this is driven through its own parsing instead. */
    async function serve(body: string, status = 200): Promise<{ url: string; seen: () => Seen | undefined }> {
        let seen: Seen | undefined;
        const server = http.createServer((request, response) => {
            seen = { method: request.method, url: request.url, headers: { ...request.headers } };
            response.writeHead(status, { 'content-type': 'application/json' });
            response.end(body);
        });
        track(server);
        await new Promise<void>((done) => { server.listen(0, '127.0.0.1', () => { done(); }); });
        const address = server.address();
        const port = typeof address === 'object' && address !== null ? address.port : 0;
        return { url: 'http://127.0.0.1:' + String(port) + '/version.json', seen: () => seen };
    }

    /*
     * The adapter is https-only by design, so its own socket cannot reach a plain server. What is asserted here is
     * the header set node:https sends for the same options - no User-Agent, no cookie, no query string - which is
     * the claim README.md makes to the user about what leaves their machine.
     */
    it('sends a bare GET with no user agent, no cookie and no query string', async () => {
        const { url, seen } = await serve('{"version":"2.1.0"}');
        await new Promise<void>((done) => {
            http.get(url, { timeout: 750 }, (response) => { response.resume(); response.on('end', () => { done(); }); });
        });
        const request = seen();
        expect(request?.method).toBe('GET');
        expect(request?.url, 'the path carries a query string, so something about this machine is in it')
            .toBe('/version.json');
        expect(request?.headers['user-agent'],
            'a User-Agent would carry a version and a platform the user was not told about').toBeUndefined();
        expect(request?.headers['cookie']).toBeUndefined();
        expect(request?.headers['authorization']).toBeUndefined();
    });
});

/* ---------------------------------------------------------------------------------------- */
/* The wiring                                                                                 */
/* ---------------------------------------------------------------------------------------- */

describe('REPO-06: the check runs in main, and the constants agree with the repository', () => {
    const config = read('src/main/config.ts');
    const lifecycle = read('src/main/lifecycle.ts');

    it('points the manifest and the releases page at the repository package.json names', () => {
        const repository = (pkg['repository'] as Record<string, unknown> | undefined)?.['url'];
        expect(typeof repository).toBe('string');
        // fleizean/workflow-timer, from the git remote. The URLs below are built from the same slug by hand, so
        // this is what stops one of the three drifting from the other two again.
        const slug = /github\.com\/([^/]+)\/([^/.]+)/.exec(String(repository));
        const owner = slug?.[1] ?? '';
        const repo = slug?.[2] ?? '';
        // The repository was renamed workflow-timer -> workflow. github.com redirects the old name and
        // github.io does not, so the Pages manifest was a 404 and the check could never have fired.
        expect(owner + '/' + repo).toBe('fleizean/workflow');
        expect(config, 'the manifest URL is not the Pages site of the repository package.json names')
            .toContain('https://' + owner + '.github.io/' + repo + '/version.json');
        expect(config, 'the update item would send the browser to a different repository')
            .toContain('https://github.com/' + owner + '/' + repo + '/releases/latest');
    });

    it('never reaches the network from the renderer', () => {
        const rendererSources = fs.readdirSync(path.join(repoRoot, 'src/renderer/src'), { recursive: true })
            .map((entry) => String(entry))
            .filter((entry) => /\.tsx?$/.test(entry))
            .map((entry) => read(path.posix.join('src/renderer/src', entry.split(path.sep).join('/'))));
        expect(rendererSources.length, 'no renderer source was read, so this is checking nothing')
            .toBeGreaterThan(20);
        for (const source of rendererSources) {
            expect(/\bfetch\s*\(|XMLHttpRequest|EventSource|\bWebSocket\b/.test(source),
                'the renderer reaches the network; its CSP is default-src \'self\' and the update check is in main ' +
                'precisely so that it does not have to').toBe(false);
        }
    });

    it('starts the check after the window and the tray, and stops it first on the way out', () => {
        expect(lifecycle.indexOf('createAppTray(trayActions'), 'the check is started before the tray it would redraw')
            .toBeLessThan(lifecycle.indexOf('startUpdateChecks(trayActions'));
        expect(lifecycle.indexOf('stopUpdateChecks();'), 'the database closes before the check is cancelled')
            .toBeLessThan(lifecycle.indexOf('closeDatabaseNow();'));
        expect(lifecycle, 'the checker is awaited somewhere on the quit path').not.toMatch(/await\s+\w*[Uu]pdate/);
    });

    it('does not construct a client at all when the user has opted out', () => {
        expect(lifecycle, 'startUpdateChecks ignores mainConfig.updateCheck').toContain('if (!mainConfig.updateCheck');
    });

    /*
     * The manifest is written by a workflow and by nothing else. It is deliberately NOT committed here: until a
     * release is actually published there is nothing true to put in it, and a hand-written one would let the site
     * claim a version nobody can download - which is the exact failure the criterion names.
     */
    it('publishes the manifest from a release event, never from a commit and never by hand', () => {
        const workflow = read('.github/workflows/publish-version.yml');
        expect(workflow, 'the manifest is written on some trigger other than a release').toContain('release:');
        expect(workflow, 'the trigger is `published`, which fires for the pre-releases the checklist marks')
            .toContain('types: [released]');
        expect(workflow, 'the version comes from the event payload rather than from what GitHub calls latest')
            .toContain('releases/latest');
        expect(workflow, 'a tag that is not a version would be published as one').toContain('refusing to publish');
        for (const other of ['.github/workflows/verify.yml', '.github/workflows/package.yml',
            '.github/workflows/release.yml']) {
            expect(read(other), other + ' also writes docs/version.json; one writer or none')
                .not.toContain('version.json');
        }
    });

    it('holds a committed manifest, if there is one, to the shape the app parses', () => {
        const manifest = path.join(repoRoot, 'docs/version.json');
        if (!fs.existsSync(manifest)) {
            // The state before the first v2 release: the URL 404s, and a 404 is the same silence as being offline.
            expect(newerVersion('2.0.0', undefined)).toBeUndefined();
            return;
        }
        const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8')) as Record<string, unknown>;
        expect(typeof parsed['version'], 'docs/version.json carries no version string').toBe('string');
        expect(parseVersion(String(parsed['version'])),
            'docs/version.json carries something the app cannot parse, so every installed copy ignores it')
            .toBeDefined();
    });

    it('is the version package.json carries, and package.json is the only place it is written', () => {
        expect(pkg['version'], 'package.json still carries a 1.x version').toMatch(/^2\./);
        const version = String(pkg['version']);
        // Nothing may hard-code it: app.getVersion() reads the packaged manifest, and the release gate compares the
        // tag with this field. A second copy is a second thing to forget.
        for (const file of ['src/main/config.ts', 'src/main/tray.ts', 'src/main/lifecycle.ts', 'docs/index.html']) {
            expect(read(file), file + ' hard-codes the version; package.json is the one place it is written')
                .not.toContain(version);
        }
    });
});
