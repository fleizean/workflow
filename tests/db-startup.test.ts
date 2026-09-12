// D-30: the real bootstrap sequence over the real database layer, driven by recording stand-in ports on mkdtemp
// directories. No electron mock, and no real krono.db or production profile is ever opened.

import { afterAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import ts from 'typescript';
import { instantFromEpochMs } from '@shared/utils/date';
import * as realLayer from '../src/lib/db';
import { EXIT_CODES } from '../src/main/config';
import { startDatabase } from '../src/main/database-startup';
import type {
    DatabaseLayer, ReportKind, StartedDatabase, StartupEnvironment, StartupPorts
} from '../src/main/database-startup';
import { closeDatabaseNow, registerDatabaseCloser, shouldQuitOnAllClosed } from '../src/main/lifecycle';
import type { LegacyStorageRead, LegacyStorageSession } from '../src/main/legacy-storage';
import { hasCreatedMainWindow, mainWindows } from '../src/main/window';
import { findAll, read } from './helpers/ts-imports';

const LIFECYCLE = 'src/main/lifecycle.ts';

const NOW = instantFromEpochMs(Date.UTC(2026, 8, 12, 9, 0, 0));

const NO_LEGACY: LegacyStorageRead = { ok: true, timerState: null, lastGoalNotificationDate: null };

const RUNNING_TIMER_RAW = '{"elapsed":3600,"running":true,"lastUpdated":1757062800000}';
const READ_OK: LegacyStorageRead = {
    ok: true, timerState: RUNNING_TIMER_RAW, lastGoalNotificationDate: '2026-09-12'
};
const READ_FAILED: LegacyStorageRead = { ok: false, reason: 'timeout after 5000 ms' };

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

function journalModeOf(dbPath: string): string {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
        return String(db.pragma('journal_mode', { simple: true })).toLowerCase();
    } finally {
        db.close();
    }
}

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
function writeLegacyDatabase(dbPath: string, journalMode: string = 'WAL'): void {
    const db = new Database(dbPath);
    try {
        db.pragma('journal_mode = ' + journalMode);
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
    // Every write connection startup opened, and whether any was still open when it reported (D-31).
    readonly handles: Database.Database[];
    readonly handleOpenAtReport: boolean[];
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
    // An existing userData directory, so a second start runs against the first one's database.
    readonly userDataDir?: string;
}

function harness(tag: string, options: HarnessOptions = {}): Harness {
    const root = tempRoot(tag);
    const userDataDir = options.userDataDir ??
        (options.userDataSubdir === undefined ? root : path.join(root, options.userDataSubdir));
    const recorder: Recorder = { calls: [], reports: [], exits: [], logs: [], handles: [], handleOpenAtReport: [] };
    const session = { released: 0 };

    const layer: DatabaseLayer = {
        ...realLayer,
        probeDatabase: (dbPath, probeOptions) => {
            recorder.calls.push('probe');
            return realLayer.probeDatabase(dbPath, probeOptions);
        },
        openDatabase: (dbPath, openOptions) => {
            recorder.calls.push('open');
            const db = realLayer.openDatabase(dbPath, openOptions);
            recorder.handles.push(db);
            return db;
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
            recorder.handleOpenAtReport.push(recorder.handles.some((db) => db.open));
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
        const h = harness('door-run', { env: { isPackaged: true, doorOpen: false } });
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

/** The same connection with every wal_checkpoint pragma throwing; getters and methods still reach the real handle. */
function refusesToCheckpoint(db: Database.Database): Database.Database {
    const handler: ProxyHandler<Database.Database> = {
        get: (target, key) => {
            if (key === 'pragma') {
                return (source: string, options?: Database.PragmaOptions): unknown => {
                    if (source.includes('wal_checkpoint')) {
                        throw new Error('injected SQLITE_FULL at checkpoint');
                    }
                    return options === undefined ? target.pragma(source) : target.pragma(source, options);
                };
            }
            const value: unknown = Reflect.get(target, key, target);
            return typeof value === 'function' ? (value as (...args: never[]) => unknown).bind(target) : value;
        }
    };
    return new Proxy(db, handler);
}

describe('D-31: a failure closes the connection, says where things are, and changes nothing', () => {
    it('reports a file it cannot read without ever opening it read-write, and changes no byte', async () => {
        const h = harness('unreadable');
        fs.writeFileSync(h.dbPath, Buffer.from('not a database, just bytes that look like nothing'));
        const before = sha256(h.dbPath);

        const started = await run(h);

        expect(started).toBeNull();
        expect(h.recorder.reports).toHaveLength(1);
        expect(h.recorder.reports[0]?.kind).toBe('failed');
        expect(h.recorder.reports[0]?.body).toContain(h.dbPath);
        expect(h.recorder.reports[0]?.body).toContain('No backup was taken.');
        expect(h.recorder.exits).toEqual([EXIT_CODES.databaseFailed]);
        expect(h.recorder.calls, 'an unreadable file was opened read-write').not.toContain('open');
        expect(h.recorder.calls).not.toContain('openMainWindow');
        expect(sha256(h.dbPath), 'the unreadable file changed on disk').toBe(before);
    });

    it('closes the connection before reporting a failed migration, and names the verified backup', async () => {
        const h = harness('migration-failure', {
            layer: {
                migrateDatabase: (db, options) => realLayer.migrateDatabase(db, {
                    ...options,
                    applyBaseline: () => { throw new Error('injected migration failure'); }
                })
            }
        });
        writeLegacyDatabase(h.dbPath);

        const started = await run(h);

        expect(started).toBeNull();
        expect(h.recorder.handles, 'no connection was opened, so this proves nothing').toHaveLength(1);
        expect(h.recorder.handleOpenAtReport, 'the connection was still open when the dialog was shown')
            .toEqual([false]);
        expect(h.recorder.exits).toEqual([EXIT_CODES.databaseFailed]);

        const backups = backupsIn(h.backupDir);
        expect(backups, 'a legacy database was migrated without a backup').toHaveLength(1);
        expect(h.recorder.reports[0]?.body).toContain(h.dbPath);
        expect(h.recorder.reports[0]?.body).toContain(path.join(h.backupDir, backups[0] ?? ''));
        expect(userVersionOf(h.dbPath), 'the file moved past its pre-migration version').toBe(0);
        expect(h.recorder.calls).not.toContain('openMainWindow');

        const strays = fs.readdirSync(h.userDataDir)
            .filter((name) => name !== 'backups' && !name.startsWith('krono.db'));
        expect(strays, 'the failure created, renamed or replaced a file').toEqual([]);
    });

    // CR-01: the checkpoint in the closer runs on the failure path, where a full disk is both a likely cause of
    // the migration failure and of the checkpoint failure. A throw there must not take the dialog with it.
    it('still reports and exits with its own code when the closing checkpoint throws', async () => {
        const opened: Database.Database[] = [];
        const h = harness('checkpoint-throws', {
            layer: {
                openDatabase: (dbPath, openOptions) => {
                    const db = realLayer.openDatabase(dbPath, openOptions);
                    opened.push(db);
                    return refusesToCheckpoint(db);
                },
                migrateDatabase: (db, options) => realLayer.migrateDatabase(db, {
                    ...options,
                    applyBaseline: () => { throw new Error('injected migration failure'); }
                })
            }
        });
        writeLegacyDatabase(h.dbPath);

        const started = await run(h);

        expect(started).toBeNull();
        expect(opened, 'no connection was opened, so this proves nothing').toHaveLength(1);
        expect(opened[0]?.open, 'a failed checkpoint left the connection open').toBe(false);
        expect(h.recorder.reports, 'a throwing checkpoint swallowed the failure dialog').toHaveLength(1);
        expect(h.recorder.reports[0]?.kind).toBe('failed');
        expect(h.recorder.reports[0]?.body).toContain('injected migration failure');
        expect(h.recorder.reports[0]?.body, 'the dialog hid the checkpoint that failed with it')
            .toContain('the -wal could not be flushed');
        expect(h.recorder.exits, 'a throwing checkpoint cost the database-failed exit code')
            .toEqual([EXIT_CODES.databaseFailed]);
        expect(userVersionOf(h.dbPath), 'the file moved past its pre-migration version').toBe(0);
    });

    // CR-01, second half: the checkpoint was guarded but the close was not, so the throw simply moved. A close
    // that fails - SQLITE_BUSY on a live statement, a full disk during the final journal cleanup - must cost the
    // user neither the dialog nor the exit code.
    it('still reports and exits with its own code when closing the connection throws', async () => {
        const closed: Database.Database[] = [];
        const h = harness('close-throws', {
            layer: {
                closeDatabase: (db) => {
                    closed.push(db);
                    realLayer.closeDatabase(db);
                    throw new Error('injected SQLITE_BUSY at close');
                },
                migrateDatabase: (db, options) => realLayer.migrateDatabase(db, {
                    ...options,
                    applyBaseline: () => { throw new Error('injected migration failure'); }
                })
            }
        });
        writeLegacyDatabase(h.dbPath);

        const started = await run(h);

        expect(started).toBeNull();
        expect(closed, 'the close was never attempted, so this proves nothing').toHaveLength(1);
        expect(h.recorder.reports, 'a throwing close swallowed the failure dialog').toHaveLength(1);
        expect(h.recorder.reports[0]?.kind).toBe('failed');
        expect(h.recorder.reports[0]?.body).toContain('injected migration failure');
        expect(h.recorder.reports[0]?.body, 'the dialog hid the close that failed with it')
            .toContain('the connection would not close');
        expect(h.recorder.exits, 'a throwing close cost the database-failed exit code')
            .toEqual([EXIT_CODES.databaseFailed]);
        expect(userVersionOf(h.dbPath), 'the file moved past its pre-migration version').toBe(0);
    });

    // CR-02: a step that commits and a later step that fails leaves the file at a version it never had before.
    // Saying "still there as it was" and "No backup was taken" to that user describes someone else's file.
    it('says the database was changed when a step had already committed, and names the backup', async () => {
        const h = harness('partial-commit', {
            layer: {
                migrateDatabase: (db, options) => realLayer.migrateDatabase(db, {
                    ...options,
                    steps: [
                        { version: 1, tag: '0000_v121_baseline', kind: 'baseline' },
                        { version: 2, tag: 'injected_failure', kind: 'sql', sql: 'INSERT INTO t_missing VALUES (1)' }
                    ]
                })
            }
        });
        writeLegacyDatabase(h.dbPath);

        const started = await run(h);

        expect(started).toBeNull();
        expect(userVersionOf(h.dbPath), 'no step committed, so this case proves nothing about a partial one').toBe(1);
        const backups = backupsIn(h.backupDir);
        expect(backups, 'a legacy adoption ran without a backup').toHaveLength(1);

        const body = h.recorder.reports[0]?.body ?? '';
        expect(h.recorder.reports[0]?.kind).toBe('failed');
        expect(body, 'the dialog denied a change the file carries').not.toContain('still there as it was');
        expect(body, 'the dialog hid the backup the user was told did not exist').toContain(path.join(h.backupDir, backups[0] ?? ''));
        expect(body).not.toContain('No backup was taken.');
        expect(h.recorder.exits).toEqual([EXIT_CODES.databaseFailed]);
    });

    // CR-02: setJournalModeWal runs after every step has committed. It used to sit inside the migration try, so a
    // WAL conversion that did not take refused to start a database that was migrated, backed up and usable.
    it('starts anyway when the post-migration journal-mode conversion fails, and logs it', async () => {
        const h = harness('journal-mode-throws', {
            layer: {
                setJournalModeWal: () => { throw new Error('injected WAL conversion failure'); }
            }
        });
        writeLegacyDatabase(h.dbPath, 'delete');

        const started = await run(h);

        expect(started, 'a migrated database was refused over its journal mode').not.toBeNull();
        expect(started?.report.applied).toEqual([1, 2]);
        expect(userVersionOf(h.dbPath)).toBe(realLayer.LATEST);
        expect(h.recorder.reports, 'a committed migration still reported a failure').toEqual([]);
        expect(h.recorder.exits).toEqual([]);
        expect(h.recorder.calls).toContain('openMainWindow');
        expect(h.recorder.logs.join('\n')).toContain('still in its previous journal mode');
    });

    it('reports a backup that could not be taken, and leaves the version where it was', async () => {
        const h = harness('backup-failure');
        writeLegacyDatabase(h.dbPath);
        // The backups path is occupied by a regular file, so the directory cannot be created.
        fs.writeFileSync(h.backupDir, 'not a directory');

        const started = await run(h);

        expect(started).toBeNull();
        expect(h.recorder.reports[0]?.kind).toBe('failed');
        expect(h.recorder.reports[0]?.body).toContain(h.dbPath);
        expect(h.recorder.reports[0]?.body).toContain('No backup was taken.');
        expect(h.recorder.exits).toEqual([EXIT_CODES.databaseFailed]);
        expect(h.recorder.handleOpenAtReport).toEqual([false]);
        expect(userVersionOf(h.dbPath), 'a failed backup still let a migration run').toBe(0);
    });
});

describe('D-32: quit flushes the WAL into the database and closes it', () => {
    it('is a no-op before any database was opened, and safe to call twice', () => {
        expect(() => { closeDatabaseNow(); closeDatabaseNow(); }).not.toThrow();
    });

    it('checkpoints the -wal and closes the connection, and a second call does nothing', async () => {
        const h = harness('quit');
        const started = await startDatabase(h.layer, h.env, h.ports);
        if (started === null) {
            throw new Error('startup returned no connection for a fresh database');
        }
        registerDatabaseCloser(started.close);

        // A second connection keeps the -wal on disk, so its size proves the checkpoint and not the close.
        const reader = new Database(h.dbPath, { readonly: true, fileMustExist: true });
        try {
            const wal = h.dbPath + '-wal';
            expect(fs.existsSync(wal) && fs.statSync(wal).size > 0, 'there is no -wal to flush, so this proves nothing')
                .toBe(true);

            closeDatabaseNow();

            expect(started.db.open, 'the quit handler left the database open').toBe(false);
            expect(!fs.existsSync(wal) || fs.statSync(wal).size === 0, 'the -wal was not checkpointed at quit')
                .toBe(true);
            expect(() => { closeDatabaseNow(); }).not.toThrow();
        } finally {
            reader.close();
        }
    });
});

function lifecycleSource(): ts.SourceFile {
    return ts.createSourceFile(LIFECYCLE, read(LIFECYCLE), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function registrationsOf(source: ts.Node, event: string): ts.CallExpression[] {
    return findAll(source, (node): node is ts.CallExpression => {
        if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false;
        const [first] = node.arguments;
        return node.expression.name.text === 'on' && first !== undefined && ts.isStringLiteral(first) &&
            first.text === event;
    });
}

// The call names inside the handler app.on('<event>', ...) registers, read from the source rather than run.
function handlerCalls(event: string): string[] {
    const registrations = registrationsOf(lifecycleSource(), event);
    const [registration] = registrations;
    if (registration === undefined) {
        throw new Error(LIFECYCLE + ' no longer registers a handler for ' + event);
    }
    const handler = registration.arguments[1];
    if (handler === undefined) {
        throw new Error(LIFECYCLE + ': the ' + event + ' registration has no handler');
    }
    return findAll(handler, (node): node is ts.CallExpression => ts.isCallExpression(node))
        .map((call) => ts.isIdentifier(call.expression) ? call.expression.text
            : ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : '(computed)');
}

describe('Pitfall 4: a hidden window can neither quit the app nor be surfaced', () => {
    it('quits on window-all-closed only once a main window has existed, and never on macOS', () => {
        expect(hasCreatedMainWindow(), 'no main window was created in this process').toBe(false);
        expect(mainWindows()).toEqual([]);
        expect(shouldQuitOnAllClosed(false, 'win32'), 'the extractor window could quit the app during startup')
            .toBe(false);
        expect(shouldQuitOnAllClosed(true, 'win32')).toBe(true);
        expect(shouldQuitOnAllClosed(true, 'darwin'), 'macOS keeps the app running with no window').toBe(false);
        expect(shouldQuitOnAllClosed(false, 'darwin')).toBe(false);
    });

    it('wires the lifecycle handlers to those guards and to the database closer', () => {
        expect(handlerCalls('window-all-closed'))
            .toEqual(expect.arrayContaining(['shouldQuitOnAllClosed', 'hasCreatedMainWindow']));
        expect(handlerCalls('will-quit'), 'will-quit no longer closes the database (D-32)')
            .toContain('closeDatabaseNow');
        const secondInstance = handlerCalls('second-instance');
        expect(secondInstance, 'second-instance no longer surfaces a window createMainWindow made')
            .toContain('mainWindows');
        expect(secondInstance, 'second-instance may surface only a main window, never any window')
            .not.toContain('getAllWindows');
    });

    // WR-07: the registration used to sit inside openMainWindow, so a second call would double the handler and
    // one dock click would open two main windows. Nothing enforced that openMainWindow ran once.
    it('registers activate exactly once, inside registerLifecycle rather than inside openMainWindow', () => {
        const source = lifecycleSource();
        expect(registrationsOf(source, 'activate'), 'activate is registered more than once').toHaveLength(1);

        const opener = findAll(source, (node): node is ts.FunctionDeclaration =>
            ts.isFunctionDeclaration(node) && node.name?.text === 'openMainWindow');
        expect(opener, 'openMainWindow is gone, so this proves nothing').toHaveLength(1);
        expect(registrationsOf(opener[0] as ts.FunctionDeclaration, 'activate'),
            'openMainWindow registers activate again on every call').toEqual([]);

        const registrar = findAll(source, (node): node is ts.FunctionDeclaration =>
            ts.isFunctionDeclaration(node) && node.name?.text === 'registerLifecycle');
        expect(registrationsOf(registrar[0] as ts.FunctionDeclaration, 'activate'),
            'registerLifecycle does not register activate').toHaveLength(1);

        // A dock click before startup has opened its first window must not race D-30's sequence.
        expect(handlerCalls('activate')).toEqual(expect.arrayContaining(['hasCreatedMainWindow', 'mainWindows']));
    });
});

const appStateCount = (db: Database.Database): number =>
    db.prepare<[], { c: number }>('SELECT count(*) AS c FROM app_state').get()?.c ?? 0;

describe('D-33/DATA-10: the legacy timer import runs after the migration and before the window', () => {
    it('imports both keys on the open connection, then releases the extractor only after the window opens', async () => {
        const h = harness('legacy-import', { legacy: READ_OK });

        const started = await run(h);

        if (started === null) {
            throw new Error('startup returned no connection');
        }
        const stored = realLayer.readAppState(started.db, realLayer.APP_STATE_KEYS.legacyTimerState);
        expect(stored?.elapsedSeconds, 'the running v1.2.1 timer never reached app_state').toBe(3600);
        expect(stored?.raw).toBe(RUNNING_TIMER_RAW);
        expect(stored?.importedAt, 'the import used a clock of its own instead of the injected one')
            .toBe('2026-09-12T09:00:00.000Z');
        expect(realLayer.readAppState(started.db, realLayer.APP_STATE_KEYS.legacyGoalDate)?.raw).toBe('2026-09-12');

        const ordered = ['migrated', 'readLegacyStorage', 'importLegacyState', 'openMainWindow', 'release'];
        expect(h.recorder.calls.filter((call) => ordered.includes(call)), 'the startup steps ran out of order')
            .toEqual(ordered);
        expect(h.session.released, 'the extractor window was not released exactly once').toBe(1);
    });

    it('still opens the window when the read fails, logging the reason and writing nothing', async () => {
        const h = harness('legacy-failed', { legacy: READ_FAILED });

        const started = await run(h);

        if (started === null) {
            throw new Error('startup returned no connection');
        }
        expect(h.recorder.calls).toContain('readLegacyStorage');
        expect(h.recorder.calls, 'a failed read still imported something').not.toContain('importLegacyState');
        expect(h.recorder.calls, 'a failed read blocked the main window').toContain('openMainWindow');
        expect(h.recorder.logs.join('\n')).toContain('timeout after 5000 ms');
        expect(appStateCount(started.db), 'a failed read wrote to app_state').toBe(0);
        expect(h.session.released).toBe(1);
    });

    it('retries the read on the next start', async () => {
        const first = harness('legacy-retry', { legacy: READ_FAILED });
        const firstStart = await startDatabase(first.layer, first.env, first.ports);
        if (firstStart === null) {
            throw new Error('the first start returned no connection');
        }
        expect(appStateCount(firstStart.db)).toBe(0);
        firstStart.close();

        const second = harness('legacy-retry-again', { legacy: READ_OK, userDataDir: first.userDataDir });
        const secondStart = await run(second);

        if (secondStart === null) {
            throw new Error('the second start returned no connection');
        }
        expect(secondStart.report.dbClass, 'the second start did not find the database current').toBe('current');
        expect(realLayer.readAppState(secondStart.db, realLayer.APP_STATE_KEYS.legacyTimerState)?.elapsedSeconds,
            'the next start did not retry the read').toBe(3600);
    });

    it('never reads the extractor for a refused or unreadable database, and never logs the timer string', async () => {
        const refused = harness('legacy-refused', { legacy: READ_OK });
        writeNewerDatabase(refused.dbPath);
        await run(refused);
        expect(refused.recorder.calls, 'a refused database reached the extractor').not.toContain('readLegacyStorage');

        const unreadable = harness('legacy-unreadable', { legacy: READ_OK });
        fs.writeFileSync(unreadable.dbPath, Buffer.from('not a database'));
        await run(unreadable);
        expect(unreadable.recorder.calls, 'an unreadable database reached the extractor')
            .not.toContain('readLegacyStorage');

        const imported = harness('legacy-quiet', { legacy: READ_OK });
        await run(imported);
        const logs = imported.recorder.logs.join('\n');
        expect(logs, 'the log names the import, so the absence checks below are not vacuous').toContain('legacy timer');
        expect(logs, 'the log carried the raw timerState string').not.toContain(RUNNING_TIMER_RAW);
        expect(logs, 'the log carried a saved timer value').not.toContain('3600');
    });
});

describe('WR-08: a main window that never opens leaves nothing running behind it', () => {
    it('releases the offscreen extractor and closes the connection when openMainWindow throws', async () => {
        const h = harness('window-throws', { legacy: READ_OK });
        const ports: StartupPorts = {
            ...h.ports,
            openMainWindow: () => { throw new Error('injected display failure'); }
        };

        await expect(startDatabase(h.layer, h.env, ports)).rejects.toThrow('injected display failure');

        expect(h.session.released, 'the offscreen extractor window was left undestroyed').toBe(1);
        expect(h.recorder.handles, 'no connection was opened, so this proves nothing').toHaveLength(1);
        expect(h.recorder.handles[0]?.open, 'the connection outlived the window that never opened').toBe(false);
    });
});

describe('WR-04: an adopted database that already carries a v2 object name is still migrated', () => {
    it('adopts a legacy database holding work_sessions_date_idx instead of failing on every launch', async () => {
        const h = harness('name-collision');
        writeLegacyDatabase(h.dbPath);
        const db = new Database(h.dbPath);
        try {
            // What a user with a SQLite browser, or a future third-party tool, leaves behind. classify
            // fingerprints columns only, so this file is accepted and then has to survive the v2 step.
            db.exec('CREATE INDEX work_sessions_date_idx ON work_sessions (date)');
        } finally {
            db.close();
        }

        const started = await run(h);

        expect(h.recorder.reports, 'a pre-existing index name failed the whole v2 transaction').toEqual([]);
        expect(started?.report.applied).toEqual([1, 2]);
        expect(userVersionOf(h.dbPath)).toBe(realLayer.LATEST);
    });
});

describe('WR-01: nothing writes to the user\'s file before the backup of it exists', () => {
    it('leaves a delete-journal database byte-identical until migrateDatabase has it, then puts it in WAL',
        async () => {
            let hashAtMigrate = '';
            const h = harness('untouched-until-backed-up', {
                layer: {
                    migrateDatabase: (db, migrateOptions) => {
                        // The connection is open and the backup has not been taken yet: the last moment the
                        // user's file must still be exactly what the probe saw.
                        hashAtMigrate = sha256(migrateOptions.dbPath);
                        return realLayer.migrateDatabase(db, migrateOptions);
                    }
                }
            });
            writeLegacyDatabase(h.dbPath, 'delete');
            expect(journalModeOf(h.dbPath), 'the fixture is already in WAL, so this proves nothing').toBe('delete');
            const before = sha256(h.dbPath);

            const started = await run(h);

            expect(started?.report.dbClass).toBe('legacy');
            expect(hashAtMigrate, 'opening the database read-write rewrote it before any backup existed')
                .toBe(before);
            expect(backupsIn(h.backupDir), 'a legacy adoption must leave exactly one verified backup')
                .toHaveLength(1);
            started?.close();
            expect(journalModeOf(h.dbPath), 'the adopted database was left outside v1.2.1\'s journal mode')
                .toBe('wal');
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
