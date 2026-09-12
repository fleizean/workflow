// D-30: the real bootstrap sequence over the real database layer, driven by recording stand-in ports on mkdtemp
// directories. No electron mock, and no real krono.db or production profile is ever opened.

import { afterAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { instantFromEpochMs } from '@shared/utils/date';
import * as realLayer from '../src/lib/db';
import { EXIT_CODES } from '../src/main/config';
import { startDatabase } from '../src/main/database-startup';
import type {
    DatabaseLayer, ReportKind, StartedDatabase, StartupEnvironment, StartupPorts
} from '../src/main/database-startup';
import type { LegacyStorageRead, LegacyStorageSession } from '../src/main/legacy-storage';

const NOW = instantFromEpochMs(Date.UTC(2026, 8, 12, 9, 0, 0));

const NO_LEGACY: LegacyStorageRead = { ok: true, timerState: null, lastGoalNotificationDate: null };

const tempRoots: string[] = [];
const openHandles: StartedDatabase[] = [];

afterAll(() => {
    for (const started of openHandles) {
        started.close();
    }
    for (const root of tempRoots) {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

function tempRoot(tag: string): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wft-startup-' + tag + '-'));
    tempRoots.push(root);
    return root;
}

const sha256 = (file: string): string => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function userVersionOf(dbPath: string): unknown {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
        return db.pragma('user_version', { simple: true });
    } finally {
        db.close();
    }
}

const backupsIn = (dir: string): string[] =>
    fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith('.bak')) : [];

/** A v1.2.1-shaped database, written by v1.2.1's own statements rather than copied from a fixture. */
function writeLegacyDatabase(dbPath: string): void {
    const db = new Database(dbPath);
    try {
        db.pragma('journal_mode = WAL');
        db.exec(`
    CREATE TABLE IF NOT EXISTS companies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
        db.exec(`
    CREATE TABLE IF NOT EXISTS work_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      duration INTEGER NOT NULL,
      date TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
        db.exec('ALTER TABLE work_sessions ADD COLUMN company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE');
        db.exec('ALTER TABLE work_sessions ADD COLUMN note TEXT');
        db.prepare<[string, string]>('INSERT INTO companies (name, created_at) VALUES (?, ?)')
            .run('Northwind Fixture', '2026-09-01 08:00:00');
        db.prepare<[string, number, string, string]>(
            'INSERT INTO work_sessions (name, duration, date, created_at) VALUES (?, ?, ?, ?)'
        ).run('Fixture session', 3600, '2026-09-11', '2026-09-11 08:00:00');
    } finally {
        db.close();
    }
}

function writeNewerDatabase(dbPath: string): void {
    writeLegacyDatabase(dbPath);
    const db = new Database(dbPath);
    try {
        db.pragma('user_version = 99');
    } finally {
        db.close();
    }
}

function writeForeignDatabase(dbPath: string): void {
    const db = new Database(dbPath);
    try {
        db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)');
    } finally {
        db.close();
    }
}

interface Recorder {
    readonly calls: string[];
    readonly reports: { kind: ReportKind; title: string; body: string }[];
    readonly exits: number[];
    readonly logs: string[];
}

interface Harness {
    readonly userDataDir: string;
    readonly dbPath: string;
    readonly backupDir: string;
    readonly env: StartupEnvironment;
    readonly ports: StartupPorts;
    readonly layer: DatabaseLayer;
    readonly recorder: Recorder;
    readonly session: { released: number };
}

interface HarnessOptions {
    readonly env?: Partial<StartupEnvironment>;
    readonly legacy?: LegacyStorageRead;
    readonly layer?: Partial<DatabaseLayer>;
    // A userData directory the harness must not create, for the fresh-install case.
    readonly userDataSubdir?: string;
}

function harness(tag: string, options: HarnessOptions = {}): Harness {
    const root = tempRoot(tag);
    const userDataDir = options.userDataSubdir === undefined ? root : path.join(root, options.userDataSubdir);
    const recorder: Recorder = { calls: [], reports: [], exits: [], logs: [] };
    const session = { released: 0 };

    const layer: DatabaseLayer = {
        ...realLayer,
        probeDatabase: (dbPath, probeOptions) => {
            recorder.calls.push('probe');
            return realLayer.probeDatabase(dbPath, probeOptions);
        },
        openDatabase: (dbPath, openOptions) => {
            recorder.calls.push('open');
            return realLayer.openDatabase(dbPath, openOptions);
        },
        migrateDatabase: async (db, migrateOptions) => {
            recorder.calls.push('migrate');
            const report = await realLayer.migrateDatabase(db, migrateOptions);
            recorder.calls.push('migrated');
            return report;
        },
        importLegacyState: (db, values, now) => {
            recorder.calls.push('importLegacyState');
            return realLayer.importLegacyState(db, values, now);
        },
        ...options.layer
    };

    const read = options.legacy ?? NO_LEGACY;
    const ports: StartupPorts = {
        report: (kind, title, body) => {
            recorder.calls.push('report:' + kind);
            recorder.reports.push({ kind, title, body });
        },
        exit: (code) => {
            recorder.calls.push('exit:' + String(code));
            recorder.exits.push(code);
        },
        log: (line) => {
            recorder.logs.push(line);
        },
        readLegacyStorage: (): Promise<LegacyStorageSession> => {
            recorder.calls.push('readLegacyStorage');
            return Promise.resolve({
                read,
                release: (): void => {
                    recorder.calls.push('release');
                    session.released += 1;
                }
            });
        },
        openMainWindow: () => {
            recorder.calls.push('openMainWindow');
        }
    };

    return {
        userDataDir,
        dbPath: path.join(userDataDir, 'krono.db'),
        backupDir: path.join(userDataDir, 'backups'),
        env: {
            userDataDir,
            productionDir: path.join(root, 'production'),
            isPackaged: false,
            smoke: false,
            doorOpen: false,
            now: NOW,
            ...options.env
        },
        ports,
        layer,
        recorder,
        session
    };
}

async function run(h: Harness): Promise<StartedDatabase | null> {
    const started = await startDatabase(h.layer, h.env, h.ports);
    if (started !== null) {
        openHandles.push(started);
    }
    return started;
}

describe('tracer: a v1.2.1 database is adopted, migrated and then the window opens', () => {
    it('reaches LATEST, leaves a verified backup, and opens the main window only afterwards', async () => {
        const h = harness('tracer');
        writeLegacyDatabase(h.dbPath);

        const started = await run(h);

        expect(started, 'startup returned no connection for a legacy database').not.toBeNull();
        expect(started?.report.dbClass).toBe('legacy');
        expect(started?.report.applied).toEqual([1, 2]);
        expect(userVersionOf(h.dbPath)).toBe(realLayer.LATEST);
        expect(backupsIn(h.backupDir), 'a legacy adoption must leave exactly one verified backup').toHaveLength(1);
        expect(started?.report.backupPath).toBe(path.join(h.backupDir, backupsIn(h.backupDir)[0] ?? ''));

        expect(h.recorder.reports, 'a successful adoption reported something to the user').toEqual([]);
        expect(h.recorder.exits).toEqual([]);
        expect(h.recorder.calls.filter((call) => call === 'openMainWindow')).toHaveLength(1);
        expect(h.recorder.calls.indexOf('openMainWindow'), 'the window opened before the migration committed')
            .toBeGreaterThan(h.recorder.calls.indexOf('migrated'));
        expect(h.recorder.logs.join('\n')).toContain('legacy 0 -> 2');
    });
});

describe('D-30/DATA-06: a database this build must not touch is refused before any window or write', () => {
    it('refuses a newer database, names it newer, exits with its own code and never opens it', async () => {
        const h = harness('newer');
        writeNewerDatabase(h.dbPath);
        const before = sha256(h.dbPath);

        const started = await run(h);

        expect(started).toBeNull();
        expect(h.recorder.reports).toHaveLength(1);
        expect(h.recorder.reports[0]?.kind).toBe('refused');
        expect(h.recorder.reports[0]?.body).toContain('newer version of Workflow');
        expect(h.recorder.reports[0]?.body).toContain(h.dbPath);
        expect(h.recorder.exits).toEqual([EXIT_CODES.refusedNewer]);
        expect(h.recorder.calls, 'a refused database was opened read-write').not.toContain('open');
        expect(h.recorder.calls, 'a window was created for a refused database').not.toContain('openMainWindow');
        expect(sha256(h.dbPath), 'the refused database changed on disk').toBe(before);
    });

    it('refuses a file that is not a Workflow database, with its own exit code', async () => {
        const h = harness('unrecognized');
        writeForeignDatabase(h.dbPath);
        const before = sha256(h.dbPath);

        const started = await run(h);

        expect(started).toBeNull();
        expect(h.recorder.reports[0]?.kind).toBe('refused');
        expect(h.recorder.reports[0]?.body).toContain('not a Workflow database');
        expect(h.recorder.exits).toEqual([EXIT_CODES.refusedUnrecognized]);
        expect(h.recorder.calls).not.toContain('open');
        expect(h.recorder.calls).not.toContain('openMainWindow');
        expect(sha256(h.dbPath)).toBe(before);
    });

    it('says nothing was changed in every refusal, and names no row data', async () => {
        const h = harness('refusal-text');
        writeNewerDatabase(h.dbPath);

        await run(h);

        const body = h.recorder.reports[0]?.body ?? '';
        expect(body).toContain('Nothing in it was changed.');
        expect(body).toContain('Install the latest version of Workflow');
        expect(body, 'a refusal quoted a row value').not.toContain('Northwind Fixture');
    });
});

describe('D-36: the production-data door closes before anything reads the database', () => {
    it('refuses a packaged, non-smoke launch on the production directory without probing', async () => {
        const root = tempRoot('door');
        const production = path.join(root, 'production');
        fs.mkdirSync(production);
        const h = harness('door-run', { env: { isPackaged: true, smoke: false, doorOpen: false } });
        const env: StartupEnvironment = { ...h.env, userDataDir: production, productionDir: production };

        const started = await startDatabase(h.layer, env, h.ports);

        expect(started).toBeNull();
        expect(h.recorder.reports[0]?.kind).toBe('door');
        expect(h.recorder.reports[0]?.body).toContain(production);
        expect(h.recorder.exits).toEqual([EXIT_CODES.doorClosed]);
        expect(h.recorder.calls, 'the door let the probe run').not.toContain('probe');
        expect(fs.readdirSync(production), 'the door let something touch the directory').toEqual([]);
    });
});

describe('DATA-05: a fresh install initializes its own directory', () => {
    it('creates the missing userData directory, reaches LATEST and takes no backup', async () => {
        const h = harness('fresh', { userDataSubdir: 'userdata' });
        expect(fs.existsSync(h.userDataDir), 'the fresh case must start with no directory').toBe(false);

        const started = await run(h);

        expect(started?.report.dbClass).toBe('fresh');
        expect(started?.report.backupPath, 'a fresh install was backed up').toBeNull();
        expect(userVersionOf(h.dbPath)).toBe(realLayer.LATEST);
        expect(backupsIn(h.backupDir)).toEqual([]);
        expect(h.recorder.calls).toContain('openMainWindow');
        expect(h.recorder.reports).toEqual([]);
        expect(h.recorder.exits).toEqual([]);
    });
});
