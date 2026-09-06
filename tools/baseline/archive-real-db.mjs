#!/usr/bin/env node
/*
 * CUSTODY-07 - archive the owner's real, populated krono.db somewhere safe, and commit its
 * schema and nothing else.
 *
 * D-03 is a hard constraint, not a preference: this repository is public and the database holds
 * real client names and real work notes. A committed database cannot be un-published - a history
 * rewrite does not reach the clones already taken. So the real file goes to a dated folder on the
 * owner's machine, outside %APPDATA%\workflow-timer\ and outside this working tree, and the only
 * thing that lands in git is the DDL from sqlite_master.
 *
 * The "outside this working tree" part is enforced by resolved-absolute-path containment rather
 * than by care, and the refusal is exercised by --self-test rather than trusted. An ignore rule is
 * a convention; a containment check that has been observed to fire is a guarantee.
 *
 * Why node:sqlite and not better-sqlite3: at this point in phase 01, better-sqlite3 is still
 * 9.6.0 and its better_sqlite3.node is unbuildable here (D-12 gates the upgrade behind plan
 * 01-07, because waves 4-5 must capture the parity baseline against v1.2.1 on Electron 28).
 * node:sqlite ships inside the pinned Node 24 runtime, needs no native build, and adds no
 * third-party supply-chain surface. It prints an ExperimentalWarning on stderr; that is expected
 * and is not an error.
 *
 * Usage:
 *   node tools/baseline/archive-real-db.mjs              archive the real triple + extract schema
 *   node tools/baseline/archive-real-db.mjs --self-test  exercise both guards on synthetic data
 *
 * Environment:
 *   WFT_ARCHIVE_SOURCE  userData directory to read   (default: %APPDATA%\workflow-timer)
 *   WFT_ARCHIVE_DIR     archive root to write under  (default: ~/workflow-timer-archive)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const SCRIPT_NAME = 'tools/baseline/archive-real-db.mjs';
const DB_NAME = 'krono.db';
const SIDECARS = ['krono.db-wal', 'krono.db-shm'];

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/* ---------------------------------------------------------------------------------------- */
/* Path containment                                                                          */
/* ---------------------------------------------------------------------------------------- */

/*
 * Resolve a path to its real location even when it does not exist yet, by realpath-ing the
 * deepest ancestor that does. A raw string prefix test is not good enough here: on Windows
 * `~/workflow-timer-archive` and the repository can both sit under C:\Users\<name>, symlinks and
 * junctions are common, and `..` segments in an env var would defeat a prefix comparison
 * entirely. The whole point of this guard is that it cannot be talked around.
 */
function resolveDeep(target) {
    let current = path.resolve(target);
    const trailing = [];
    for (;;) {
        if (fs.existsSync(current)) {
            return path.join(fs.realpathSync(current), ...trailing);
        }
        const parent = path.dirname(current);
        if (parent === current) {
            return path.resolve(target);
        }
        trailing.unshift(path.basename(current));
        current = parent;
    }
}

function isInside(child, parent) {
    const rel = path.relative(resolveDeep(parent), resolveDeep(child));
    return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

/*
 * The D-03 guard. Called before anything is created, read or written.
 */
function assertDestinationIsSafe(destDir, sourceDir, guardRepoRoot) {
    if (isInside(destDir, guardRepoRoot)) {
        throw new Error(
            'D-03 REFUSAL: the archive destination ' + resolveDeep(destDir) +
            ' is inside the repository working tree ' + resolveDeep(guardRepoRoot) + '.\n' +
            'The real krono.db holds real client names and work notes and this repository is ' +
            'public. A committed database cannot be un-published. Set WFT_ARCHIVE_DIR to a path ' +
            'outside the repository.'
        );
    }
    if (isInside(destDir, sourceDir)) {
        throw new Error(
            'D-03 REFUSAL: the archive destination ' + resolveDeep(destDir) +
            ' is inside the source userData directory ' + resolveDeep(sourceDir) + '.\n' +
            'An archive kept inside the directory it protects against is not an archive. ' +
            'Set WFT_ARCHIVE_DIR to a path outside userData.'
        );
    }
}

/* ---------------------------------------------------------------------------------------- */
/* Schema extraction                                                                         */
/* ---------------------------------------------------------------------------------------- */

/*
 * Reads ONLY type, name and sql from sqlite_master. No user table is ever queried. This is the
 * single place in the whole restructure where a statement runs against real user data, and it is
 * deliberately incapable of returning a row of it.
 */
function readSchema(dbPath) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
        return db
            .prepare(
                'SELECT type, name, sql FROM sqlite_master ' +
                'WHERE sql IS NOT NULL ORDER BY type, name'
            )
            .all();
    } finally {
        db.close();
    }
}

function renderSchema(rows, provenance) {
    const header = [
        '-- v1.2.1 schema extract - DDL ONLY, ZERO ROWS.',
        '--',
        '-- Generated by ' + SCRIPT_NAME + ' on ' + provenance.date + '.',
        '-- Source: the sqlite_master table of a copy of the real, populated krono.db.',
        '--',
        '-- This file exists because D-03 forbids the database itself from entering this public',
        '-- repository: it contains real client names and real work notes. Only the schema may be',
        '-- committed. The generator selects nothing but type, name and sql from sqlite_master and',
        '-- refuses to write this file if the result carries row data or a stray string literal.',
        '--',
        '-- D-05: this is the second of two schema sources. database/db.js holds the canonical',
        '-- v1.2.1 DDL; this is what one real installation actually has. A difference between them',
        '-- is not a bug to fix here - it is a second legacy variant that plan 01-07 and Phase 4',
        '-- must migrate.',
        '--',
        '-- Do not hand-edit. Regenerate with: node ' + SCRIPT_NAME,
        '-- Objects: ' + rows.length + ' (' + rows.map((r) => r.type + ' ' + r.name).join(', ') + ')',
        ''
    ].join('\n');

    const body = rows
        .map((row) => String(row.sql).replace(/\s+$/, '') + ';')
        .join('\n\n');

    return { header: header + '\n', body: body + '\n' };
}

/*
 * Self-assertion, run against the DDL body only - not against the generated provenance header,
 * whose prose is fixed text this script controls and whose only variable parts are the script
 * name, the date and the sqlite_master object names. Checking the header would mean the check
 * fires on the words used to describe it, which is how the first run of this script failed.
 *
 * The generator is not trusted to have selected only DDL; the body is checked before it is
 * allowed to exist. DEFAULT '...' is the one legitimate string literal in a CREATE TABLE, so it
 * is scrubbed first and anything still quoted afterwards fails.
 */
function assertDdlOnly(body) {
    if (/\bINSERT\b/i.test(body)) {
        throw new Error('SCHEMA EXTRACT CARRIES ROW DATA: an insert statement is present.');
    }
    if (/\bVALUES\s*\(/i.test(body)) {
        throw new Error('SCHEMA EXTRACT CARRIES ROW DATA: a VALUES clause is present.');
    }
    const withoutDefaults = body.replace(/DEFAULT\s+'(?:[^']|'')*'/gi, 'DEFAULT <literal>');
    const stray = withoutDefaults.match(/'(?:[^']|'')*'/g);
    if (stray && stray.length > 0) {
        throw new Error(
            'SCHEMA EXTRACT CARRIES A STRING LITERAL THAT IS NOT A COLUMN DEFAULT: ' +
            stray.slice(0, 3).join(', ') + '. Refusing to write it.'
        );
    }
}

function writeSchemaExtract(dbPath, outPath, provenance) {
    const rows = readSchema(dbPath);
    const { header, body } = renderSchema(rows, provenance);

    // Check before writing, so a bad extract never reaches the filesystem at all...
    assertDdlOnly(body);

    const text = header + body;
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, text, 'utf8');

    // ...and again after, so what landed on disk is provably what was checked.
    try {
        const written = fs.readFileSync(outPath, 'utf8');
        if (written !== text) {
            throw new Error('SCHEMA EXTRACT DIFFERS FROM WHAT WAS VERIFIED. Refusing to keep it.');
        }
        assertDdlOnly(written.slice(header.length));
    } catch (err) {
        fs.rmSync(outPath, { force: true });
        throw err;
    }
    return { rows, text };
}

/* ---------------------------------------------------------------------------------------- */
/* Archive                                                                                   */
/* ---------------------------------------------------------------------------------------- */

function archive({ sourceDir, destRoot, schemaOut, guardRepoRoot, stamp }) {
    const dateStamp = stamp || new Date().toLocaleDateString('en-CA');
    const destDir = path.join(destRoot, dateStamp);

    // Guard FIRST. Nothing is created, read or copied before the destination is proven safe.
    assertDestinationIsSafe(destDir, sourceDir, guardRepoRoot);

    const sourceDb = path.join(sourceDir, DB_NAME);
    if (!fs.existsSync(sourceDb)) {
        throw new Error('No database at ' + sourceDb + '. Set WFT_ARCHIVE_SOURCE.');
    }

    fs.mkdirSync(destDir, { recursive: true });

    const copied = [];
    for (const name of [DB_NAME, ...SIDECARS]) {
        const from = path.join(sourceDir, name);
        if (!fs.existsSync(from)) {
            copied.push({ name, bytes: null, note: 'absent at source' });
            continue;
        }
        /*
         * CUSTODY-03 bans fs-copying a SQLite database, and that ban is correct everywhere
         * except here. It exists because copying a LIVE database yields a file that opens fine
         * and passes integrity_check while missing every committed-but-uncheckpointed page in
         * the -wal. None of that applies at this call site: the application is not running,
         * this is a cold archive rather than a live backup, the measured -wal is 0 bytes, and
         * the whole triple is copied together so any WAL content travels with its database.
         *
         * db.backup() is deliberately NOT used, because it would require opening the owner's
         * real database for WRITE, which is exactly what T-01-17 forbids. A read-only copy is
         * the weaker operation here, and weaker is what this task wants.
         *
         * Do not cite this site as precedent for a backup path. CUSTODY-03's backup module
         * uses db.backup().
         */
        // eslint-disable-next-line no-restricted-syntax -- cold archive, app not running, T-01-17 forbids opening the real DB for write
        fs.copyFileSync(from, path.join(destDir, name));
        copied.push({ name, bytes: fs.statSync(from).size, note: null });
    }

    // The schema is read from the COPY, never from the source. The source is touched exactly
    // once, by the read half of copyFileSync above (T-01-17).
    const { rows } = writeSchemaExtract(path.join(destDir, DB_NAME), schemaOut, { date: dateStamp });

    return { destDir, copied, schemaOut, objects: rows.map((r) => r.type + ' ' + r.name) };
}

/* ---------------------------------------------------------------------------------------- */
/* Self-test                                                                                 */
/* ---------------------------------------------------------------------------------------- */

const SECRET_ROWS = {
    company: 'ACME-SELFTEST-CLIENT-NAME',
    note: 'SELFTEST-CONFIDENTIAL-WORK-NOTE'
};

function buildSyntheticSource(dir) {
    fs.mkdirSync(dir, { recursive: true });
    const dbPath = path.join(dir, DB_NAME);
    const db = new DatabaseSync(dbPath);
    try {
        db.exec(
            'CREATE TABLE companies (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,' +
            ' created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, note_required INTEGER DEFAULT 0);' +
            'CREATE TABLE work_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,' +
            ' duration INTEGER NOT NULL, date TEXT NOT NULL, company_id INTEGER, note TEXT);' +
            'CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);' +
            'CREATE TABLE pomodoro_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL,' +
            ' company_id INTEGER, pomodoros_completed INTEGER DEFAULT 1);'
        );
        db.prepare('INSERT INTO companies (name) VALUES (?)').run(SECRET_ROWS.company);
        db.prepare(
            'INSERT INTO work_sessions (name, duration, date, company_id, note) VALUES (?, ?, ?, ?, ?)'
        ).run('selftest', 60, '2026-01-01', 1, SECRET_ROWS.note);
    } finally {
        db.close();
    }
    return dbPath;
}

function selfTest() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wft-selftest-'));
    const failures = [];
    try {
        const sourceDir = path.join(root, 'userData');
        buildSyntheticSource(sourceDir);

        /* Assertion 1 - the extract is DDL only and carries no row value. */
        const schemaOut = path.join(root, 'out', 'schema.sql');
        const result = archive({
            sourceDir,
            destRoot: path.join(root, 'archive'),
            schemaOut,
            guardRepoRoot: repoRoot,
            stamp: '1970-01-01'
        });
        const text = fs.readFileSync(schemaOut, 'utf8');
        const tables = ['companies', 'work_sessions', 'settings', 'pomodoro_sessions'];
        const missing = tables.filter((t) => !new RegExp('CREATE TABLE ' + t + '\\b').test(text));
        const leaked = Object.values(SECRET_ROWS).filter((v) => text.includes(v));

        if (missing.length > 0) {
            failures.push('DDL-only assertion: missing CREATE TABLE for ' + missing.join(', '));
        } else if (leaked.length > 0) {
            failures.push('DDL-only assertion: row values leaked into the extract: ' + leaked.join(', '));
        } else if (/\bINSERT\b/i.test(text)) {
            failures.push('DDL-only assertion: an INSERT reached the extract');
        } else {
            console.log(
                'PASS  DDL-only assertion: 4 CREATE TABLE statements, 0 row values, 0 INSERT.' +
                ' Archived ' + result.copied.filter((c) => c.bytes !== null).length + ' file(s).'
            );
        }

        /* Assertion 2 - a destination inside the repository is refused. */
        let refused = false;
        let refusalMessage = '';
        try {
            archive({
                sourceDir,
                destRoot: path.join(repoRoot, 'tests', 'fixtures', 'should-never-exist'),
                schemaOut: path.join(root, 'out', 'never-written.sql'),
                guardRepoRoot: repoRoot,
                stamp: '1970-01-01'
            });
        } catch (err) {
            refused = /D-03 REFUSAL/.test(String(err && err.message));
            refusalMessage = String(err && err.message).split('\n')[0];
        }
        const strayDir = path.join(repoRoot, 'tests', 'fixtures', 'should-never-exist');
        if (!refused) {
            failures.push('refused-destination assertion: an in-repo destination was NOT refused');
        } else if (fs.existsSync(strayDir)) {
            failures.push('refused-destination assertion: refused, but ' + strayDir + ' was created anyway');
        } else {
            console.log('PASS  refused-destination assertion: ' + refusalMessage);
        }

        /* Assertion 3 - a destination inside the source userData directory is refused too. */
        let refusedNested = false;
        try {
            archive({
                sourceDir,
                destRoot: path.join(sourceDir, 'archive'),
                schemaOut: path.join(root, 'out', 'never-written.sql'),
                guardRepoRoot: repoRoot,
                stamp: '1970-01-01'
            });
        } catch (err) {
            refusedNested = /D-03 REFUSAL/.test(String(err && err.message));
        }
        if (!refusedNested) {
            failures.push('refused-destination assertion: an in-userData destination was NOT refused');
        } else {
            console.log('PASS  refused-destination assertion: an in-userData destination is refused.');
        }
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }

    if (failures.length > 0) {
        for (const f of failures) {
            console.error('FAIL  ' + f);
        }
        process.exitCode = 1;
        return;
    }
    console.log('SELF_TEST_OK');
}

/* ---------------------------------------------------------------------------------------- */
/* Entry point                                                                               */
/* ---------------------------------------------------------------------------------------- */

function defaultSourceDir() {
    const appData = process.env.APPDATA;
    if (appData) {
        return path.join(appData, 'workflow-timer');
    }
    if (process.platform === 'darwin') {
        return path.join(os.homedir(), 'Library', 'Application Support', 'workflow-timer');
    }
    return path.join(os.homedir(), '.config', 'workflow-timer');
}

function main() {
    if (process.argv.includes('--self-test')) {
        selfTest();
        return;
    }

    const sourceDir = process.env.WFT_ARCHIVE_SOURCE || defaultSourceDir();
    const destRoot = process.env.WFT_ARCHIVE_DIR || path.join(os.homedir(), 'workflow-timer-archive');
    const schemaOut = path.join(repoRoot, 'tests', 'fixtures', 'v121-real-schema.sql');

    const result = archive({ sourceDir, destRoot, schemaOut, guardRepoRoot: repoRoot });

    console.log('Archived from: ' + resolveDeep(sourceDir));
    console.log('Archived to:   ' + result.destDir);
    for (const item of result.copied) {
        console.log('  ' + item.name + ': ' + (item.note ? item.note : item.bytes + ' bytes'));
    }
    console.log('Schema extract: ' + result.schemaOut);
    console.log('Objects: ' + result.objects.join(', '));
    console.log('The archive is NOT in this repository and must never be moved into it (D-03).');
}

main();
