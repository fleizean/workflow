#!/usr/bin/env node
/*
 * CUSTODY-10 - write a deterministic v1.2.1-schema fixture database, and pin the three remote
 * hosts the running application loads at runtime.
 *
 * Two jobs, one script, because both answer the same question: what exactly is the baseline a
 * photograph OF? A screenshot is only a regression detector if everything it depends on is fixed.
 * Three things are not fixed by default:
 *
 *   1. The database. v1.2.1 renders the owner's real client names and work notes. D-03 forbids
 *      those reaching a public repository, so the capture runs against synthetic content.
 *   2. Today's date. database/db.js reads the real system clock in getTodaySessions(),
 *      getThisWeekTotal(), getLastWeekTotal() and calculateCurrentStreak(). A fixture with hard
 *      dates renders differently every day it is re-captured.
 *   3. cdn.tailwindcss.com and fonts.googleapis.com. Both are live URLs. The Play CDN currently
 *      redirects to Tailwind 3.4.17, but nothing holds it there, and it generates CSS from the
 *      live DOM at runtime rather than shipping a stylesheet.
 *
 * WHY node:sqlite AND NOT better-sqlite3: at this point in phase 01, better-sqlite3 is still 9.6.0
 * and unbuildable on this machine (MSB8020, a missing ClangCL platform toolset). D-12 gates the
 * upgrade behind plan 01-07 precisely so that waves 4-5 can still launch v1.2.1 on Electron 28.
 * node:sqlite ships inside the pinned Node 24 runtime, needs no native build and adds no
 * third-party supply-chain surface. It prints an ExperimentalWarning on stderr; that is expected.
 * This is the same choice, for the same reason, that plan 01-04 made.
 *
 * Usage:
 *   node tools/baseline/seed-baseline-db.mjs <dir>     seed <dir>/krono.db
 *   node tools/baseline/seed-baseline-db.mjs --self-test    exercise every determinism property
 *   node tools/baseline/seed-baseline-db.mjs --verify-vendor  digests on disk vs the manifest
 *   node tools/baseline/seed-baseline-db.mjs --fetch-vendor   one-off; needs network
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const SCRIPT_NAME = 'tools/baseline/seed-baseline-db.mjs';
const DB_NAME = 'krono.db';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const vendorDir = path.join(repoRoot, 'tools', 'baseline', 'vendor');
const vendorIndexPath = path.join(vendorDir, 'index.json');
const manifestPath = path.join(repoRoot, 'baselines', 'v1.2.1', 'MANIFEST.md');
const realSchemaPath = path.join(repoRoot, 'tests', 'fixtures', 'v121-real-schema.sql');

/* ---------------------------------------------------------------------------------------- */
/* The v1.2.1 schema                                                                          */
/* ---------------------------------------------------------------------------------------- */

/*
 * Reproduced in its POST-MIGRATION shape, which is what a real v1.2.1 database looks like and is
 * not what a tidy hand-written CREATE would produce. In a real installation, companies.excel_column
 * / note_column / note_required and work_sessions.company_id / note were appended by ALTER TABLE in
 * initDatabase(), so they sit LAST. A fixture with a tidier column order is not a v1.2.1 database,
 * and phase 04's PRAGMA table_info migration logic would then be tested against a lie.
 *
 * PRAGMA foreign_keys is deliberately NOT enabled here. The application never enables it
 * (database/db.js opens the database and sets only journal_mode), so every declared ON DELETE
 * CASCADE is inert in production. node:sqlite's DatabaseSync turns foreign keys ON by default,
 * which is the opposite of the application's behaviour, so the connection below switches it off
 * explicitly - see openFixture().
 */
export const V121_DDL = `
CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  excel_column TEXT,
  note_column TEXT,
  note_required INTEGER DEFAULT 0);

CREATE TABLE IF NOT EXISTS work_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  duration INTEGER NOT NULL,
  date TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  note TEXT);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS pomodoro_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  company_id INTEGER,
  pomodoros_completed INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE);
`;

export const TABLES = ['companies', 'work_sessions', 'settings', 'pomodoro_sessions'];

/* ---------------------------------------------------------------------------------------- */
/* Dates                                                                                      */
/* ---------------------------------------------------------------------------------------- */

/* Byte-for-byte the arithmetic at database/db.js:16-18. Local, never UTC: the application formats
 * local dates everywhere, so a fixture built from toISOString() would be off by one for anyone east
 * or west of Greenwich at the wrong hour. */
export function formatLocalDate(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/* The Monday of the week containing `date`, matching getThisWeekTotal()'s Sunday-is-day-7 rule. */
export function mondayOf(date) {
    const dayOfWeek = date.getDay();
    const monday = new Date(date);
    monday.setDate(date.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
    monday.setHours(0, 0, 0, 0);
    return monday;
}

export function addDays(date, days) {
    const out = new Date(date);
    out.setDate(out.getDate() + days);
    return out;
}

/*
 * THE SEEDING POLICY, and why it is shaped the way it is.
 *
 * Research offered two ways to handle "today" leaking into the rendered output: seed relative to
 * the run date, or accept the drift and mask the date strip. This takes the first.
 *
 * The naive version of "relative to the run date" - seed today, yesterday, the day before - is
 * still not deterministic, and the reason is easy to miss. getThisWeekTotal() and getLastWeekTotal()
 * do not slice by "N days ago"; they slice by CALENDAR WEEK, Monday to Sunday. Seeding today-1 and
 * today-2 puts a different number of sessions inside the current week depending on which weekday
 * the capture happens to run on: on a Monday, none of them; on a Thursday, both. The This Week
 * tile, the Last Week comparison, and the number of rows on the work-history page would all differ
 * between this capture and Phase 8's, and every one of those differences would be attributed to the
 * rewrite.
 *
 * So the seed straddles the week boundary deliberately and never crosses it by accident:
 *
 *   - ALL of the current week's work sits on TODAY. This week therefore always contains exactly
 *     three sessions totalling 30,600 s, whatever weekday the capture runs on.
 *   - The historical block sits on the PREVIOUS week's Monday, Tuesday and Wednesday - computed
 *     from this week's Monday minus 7, so it is always entirely inside "last week" and never
 *     inside "this week".
 *   - Nothing is seeded on today-1 or today-2, because those days move across the week boundary.
 *
 * The streak falls out of this: today's 30,600 s clears the 28,800 s daily target, yesterday has
 * nothing, so calculateCurrentStreak() returns exactly 1 on every run date. That is deliberately
 * far below the fire-canvas thresholds in src/pages/index.html:719-729 (`streak > 10` starts the
 * requestAnimationFrame particle animation, `streak > 5` adds a pulsing CSS tier). At 1, no tier
 * class is applied at all and no animation clock exists to photograph. The capture also masks
 * #streakFireCanvas; a fixture that never lights it is the sturdier of the two controls and using
 * both is correct.
 */
export function seedDates(now = new Date()) {
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    const lastMonday = addDays(mondayOf(today), -7);
    return {
        today: formatLocalDate(today),
        lastWeek: [0, 1, 2].map((offset) => formatLocalDate(addDays(lastMonday, offset)))
    };
}

/* ---------------------------------------------------------------------------------------- */
/* The synthetic content                                                                      */
/* ---------------------------------------------------------------------------------------- */

/*
 * Every string below is rendered into a PNG that is committed to a public repository, so every
 * string below is invented. "Northwind", "Contoso" and "Fabrikam" are the canonical fictional
 * companies from Microsoft's own sample data, suffixed with "Fixture" so that no reader can mistake
 * one for a real client of this application's owner.
 *
 * "Unassigned" is not invented - initDatabase() creates it on every launch if it is missing, and
 * re-points every company-less session at it. A fixture without it would be silently mutated by the
 * app the moment the capture launched, so the fixture would not be the thing that was photographed.
 */
export const COMPANIES = [
    { id: 1, name: 'Unassigned', excel_column: null, note_column: null, note_required: 0 },
    { id: 2, name: 'Northwind Fixture', excel_column: 'B', note_column: 'C', note_required: 0 },
    { id: 3, name: 'Contoso Fixture', excel_column: 'D', note_column: 'E', note_required: 1 },
    { id: 4, name: 'Fabrikam Fixture', excel_column: null, note_column: null, note_required: 0 }
];

const NOTE = 'Synthetic fixture note. No real work was recorded here.';

/* Today: 14400 + 10800 + 5400 = 30600 s = 8 h 30 m, clearing the 28800 s daily target. */
const TODAY_SESSIONS = [
    { name: 'Fixture task: sprint planning', duration: 14400, company_id: 2, note: NOTE },
    { name: 'Fixture task: code review', duration: 10800, company_id: 3, note: NOTE },
    { name: 'Fixture task: documentation', duration: 5400, company_id: 4, note: null }
];

/* Last week: 21600 + 23400 + 21600 = 66600 s = 18 h 30 m, on three fixed weekdays. */
const LAST_WEEK_SESSIONS = [
    [
        { name: 'Fixture task: onboarding', duration: 12600, company_id: 2, note: NOTE },
        { name: 'Fixture task: retrospective', duration: 9000, company_id: 3, note: null }
    ],
    [
        { name: 'Fixture task: bug triage', duration: 16200, company_id: 2, note: NOTE },
        { name: 'Fixture task: pairing', duration: 7200, company_id: 4, note: null }
    ],
    [
        { name: 'Fixture task: release prep', duration: 18000, company_id: 3, note: NOTE },
        { name: 'Fixture task: standup', duration: 3600, company_id: 2, note: null }
    ]
];

/*
 * Exactly initDatabase()'s defaultSettings, written explicitly rather than left to the app's
 * INSERT OR IGNORE. Two consequences worth stating: pomodoro_enabled stays 'false', which is what a
 * fresh v1.2.1 install looks like and keeps the Pomodoro surface (which this milestone rewrites
 * from scratch anyway) out of the parity baseline; and script_url is deliberately ABSENT, because
 * initDatabase() never creates it, so a fresh install has no row and the settings page renders its
 * empty state. Seeding a value there would also put a URL into a committed screenshot.
 */
export const SETTINGS = {
    daily_target: '28800',
    goal_notification: 'true',
    start_reminder: 'false',
    haptic_feedback: 'true',
    exclude_weekends_from_streak: 'false',
    pomodoro_enabled: 'false',
    pomodoro_work_duration: '1500',
    pomodoro_short_break: '300',
    pomodoro_long_break: '900',
    pomodoro_sessions_until_long_break: '4',
    pomodoro_auto_start_breaks: 'true',
    pomodoro_auto_start_work: 'false',
    export_half_hour_precision: 'false'
};

/* Today only. getWeeklyPomodoroStats() slices [today-7, today] - a rolling window, not a calendar
 * week - so anything seeded in last week would fall in or out of it depending on the weekday. */
const POMODOROS = [
    { company_id: 2, pomodoros_completed: 2 },
    { company_id: 3, pomodoros_completed: 1 }
];

/* ---------------------------------------------------------------------------------------- */
/* Seeding                                                                                    */
/* ---------------------------------------------------------------------------------------- */

function openFixture(file) {
    return new DatabaseSync(file, {
        /* The application never enables foreign keys; node:sqlite does by default. Match the app. */
        enableForeignKeyConstraints: false
    });
}

/*
 * `created_at` is passed explicitly on every single row. Leaving it to DEFAULT CURRENT_TIMESTAMP
 * would stamp the wall clock into the fixture, so two runs on the same date would produce different
 * content - which is precisely the determinism this file exists to provide.
 */
function createdAt(date, hhmmss) {
    return `${date} ${hhmmss}`;
}

export function seedDatabase(targetDir, now = new Date()) {
    fs.mkdirSync(targetDir, { recursive: true });
    const file = path.join(targetDir, DB_NAME);
    fs.rmSync(file, { force: true });
    fs.rmSync(`${file}-wal`, { force: true });
    fs.rmSync(`${file}-shm`, { force: true });

    const dates = seedDates(now);
    const db = openFixture(file);
    try {
        /* The real database is in WAL mode because database/db.js sets it on every open. */
        db.exec('PRAGMA journal_mode = WAL;');
        db.exec(V121_DDL);

        const insertCompany = db.prepare(
            'INSERT INTO companies (id, name, created_at, updated_at, excel_column, note_column, note_required) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?)'
        );
        for (const company of COMPANIES) {
            const stamp = createdAt(dates.lastWeek[0], '08:00:00');
            insertCompany.run(
                company.id, company.name, stamp, stamp,
                company.excel_column, company.note_column, company.note_required
            );
        }

        const insertSession = db.prepare(
            'INSERT INTO work_sessions (name, duration, date, created_at, company_id, note) VALUES (?, ?, ?, ?, ?, ?)'
        );
        TODAY_SESSIONS.forEach((session, index) => {
            insertSession.run(
                session.name, session.duration, dates.today,
                createdAt(dates.today, `0${9 + index}:15:00`),
                session.company_id, session.note
            );
        });
        dates.lastWeek.forEach((date, dayIndex) => {
            LAST_WEEK_SESSIONS[dayIndex].forEach((session, index) => {
                insertSession.run(
                    session.name, session.duration, date,
                    createdAt(date, `${String(9 + index * 4).padStart(2, '0')}:30:00`),
                    session.company_id, session.note
                );
            });
        });

        const insertSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
        for (const [key, value] of Object.entries(SETTINGS)) insertSetting.run(key, value);

        const insertPomodoro = db.prepare(
            'INSERT INTO pomodoro_sessions (date, company_id, pomodoros_completed, created_at) VALUES (?, ?, ?, ?)'
        );
        POMODOROS.forEach((pomodoro, index) => {
            insertPomodoro.run(
                dates.today, pomodoro.company_id, pomodoro.pomodoros_completed,
                createdAt(dates.today, `1${index}:45:00`)
            );
        });
    } finally {
        db.close();
    }
    return { file, dates };
}

/* Everything a determinism comparison needs: every row of every table, in a stable order. */
export function dumpContent(file) {
    const db = new DatabaseSync(file, { readOnly: true, enableForeignKeyConstraints: false });
    try {
        const out = {};
        for (const table of TABLES) {
            const order = table === 'settings' ? 'key' : 'id';
            out[table] = db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all();
        }
        return out;
    } finally {
        db.close();
    }
}

/* ---------------------------------------------------------------------------------------- */
/* Vendored assets                                                                            */
/* ---------------------------------------------------------------------------------------- */

/*
 * The three hosts a running v1.2.1 reaches for, verbatim from the application source:
 *   src/pages/*.html:17   https://cdn.tailwindcss.com?plugins=forms,container-queries
 *   src/styles/common.css:4-5  two fonts.googleapis.com/css2 imports
 * plus every fonts.gstatic.com woff2 those two stylesheets reference.
 */
export const VENDOR_SOURCES = [
    {
        key: 'tailwind',
        url: 'https://cdn.tailwindcss.com?plugins=forms,container-queries',
        file: 'tailwind.js',
        contentType: 'application/javascript'
    },
    {
        key: 'inter-css',
        url: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap',
        file: 'fonts-css/inter.css',
        contentType: 'text/css'
    },
    {
        key: 'material-symbols-css',
        url: 'https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap',
        file: 'fonts-css/material-symbols.css',
        contentType: 'text/css'
    }
];

/*
 * Google Fonts serves a DIFFERENT stylesheet per User-Agent - woff2 with unicode-range subsets to
 * modern Chrome, older formats to anything it does not recognise. Electron 28.3.3 embeds Chromium
 * 120, so the fetch pins a Chrome 120 UA. Change it and the vendored CSS changes, which is why it
 * is a named constant rather than a default.
 */
export const FETCH_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/120.0.0.0 Safari/537.36';

export function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function readVendorIndex() {
    if (!fs.existsSync(vendorIndexPath)) {
        throw new Error(`${vendorIndexPath} is missing - run ${SCRIPT_NAME} --fetch-vendor (needs network)`);
    }
    return JSON.parse(fs.readFileSync(vendorIndexPath, 'utf8'));
}

/* Resolve a request URL seen by the capture script to a vendored file on disk. */
export function resolveVendored(requestUrl, index = readVendorIndex()) {
    const url = new URL(requestUrl);
    if (url.hostname === 'cdn.tailwindcss.com') return index.assets.find((a) => a.key === 'tailwind');
    if (url.hostname === 'fonts.googleapis.com') {
        const family = url.searchParams.get('family') ?? '';
        const key = family.startsWith('Inter') ? 'inter-css' : 'material-symbols-css';
        return index.assets.find((a) => a.key === key);
    }
    if (url.hostname === 'fonts.gstatic.com') {
        const base = path.basename(url.pathname);
        return index.assets.find((a) => a.file.endsWith(`/${base}`));
    }
    return null;
}

async function fetchVendor() {
    const assets = [];
    const downloadedAt = new Date().toISOString().slice(0, 10);

    const get = async (url) => {
        const response = await fetch(url, { headers: { 'user-agent': FETCH_UA } });
        if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
        return Buffer.from(await response.arrayBuffer());
    };

    const write = (relative, body) => {
        const absolute = path.join(vendorDir, relative);
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.writeFileSync(absolute, body);
    };

    for (const source of VENDOR_SOURCES) {
        const body = await get(source.url);
        write(source.file, body);
        assets.push({
            key: source.key,
            url: source.url,
            file: source.file,
            contentType: source.contentType,
            bytes: body.length,
            sha256: sha256(body)
        });
        console.log(`${SCRIPT_NAME}: fetched ${source.url} -> ${source.file} (${body.length} bytes)`);

        if (!source.file.endsWith('.css')) continue;
        const css = body.toString('utf8');
        const woff2Urls = [...new Set([...css.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g)].map((m) => m[1]))];
        for (const woff2Url of woff2Urls) {
            const font = await get(woff2Url);
            const relative = `fonts/${path.basename(new URL(woff2Url).pathname)}`;
            write(relative, font);
            assets.push({
                key: `font:${path.basename(relative)}`,
                url: woff2Url,
                file: relative,
                contentType: 'font/woff2',
                bytes: font.length,
                sha256: sha256(font)
            });
        }
        console.log(`${SCRIPT_NAME}:   + ${woff2Urls.length} woff2 referenced by ${source.file}`);
    }

    fs.writeFileSync(
        vendorIndexPath,
        `${JSON.stringify({ downloadedAt, userAgent: FETCH_UA, assets }, null, 2)}\n`
    );
    console.log(`${SCRIPT_NAME}: wrote ${vendorIndexPath} (${assets.length} assets)`);
    console.log('');
    console.log('Paste into baselines/v1.2.1/MANIFEST.md section 3:');
    console.log('');
    console.log('| Asset | Source URL | Bytes | SHA-256 |');
    console.log('|---|---|---|---|');
    for (const asset of assets) {
        console.log(`| \`${asset.file}\` | <${asset.url}> | ${asset.bytes.toLocaleString('en-US')} | \`${asset.sha256}\` |`);
    }
    return assets;
}

export function verifyVendor() {
    const index = readVendorIndex();
    const manifest = fs.existsSync(manifestPath) ? fs.readFileSync(manifestPath, 'utf8') : '';
    const failures = [];
    for (const asset of index.assets) {
        const absolute = path.join(vendorDir, asset.file);
        if (!fs.existsSync(absolute)) {
            failures.push(`missing from tools/baseline/vendor/: ${asset.file}`);
            continue;
        }
        const actual = sha256(fs.readFileSync(absolute));
        if (actual !== asset.sha256) {
            failures.push(`${asset.file}: sha256 ${actual} != index.json ${asset.sha256}`);
            continue;
        }
        if (!manifest.includes(actual)) {
            failures.push(`${asset.file}: sha256 ${actual} is not recorded in baselines/v1.2.1/MANIFEST.md`);
        }
    }
    return { ok: failures.length === 0, failures, count: index.assets.length };
}

/* ---------------------------------------------------------------------------------------- */
/* Self-test                                                                                  */
/* ---------------------------------------------------------------------------------------- */

/* The committed DDL-only extract of the owner's REAL database (plan 01-04). Comparing column
 * names and order against it is the cheapest possible guard against this fixture drifting away
 * from the shape phase 04's migration runner will meet in the field. */
function realSchemaColumns() {
    if (!fs.existsSync(realSchemaPath)) return null;
    const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: false });
    try {
        /* The extract carries `CREATE TABLE sqlite_sequence(name,seq)` because it is a faithful
         * dump of the real sqlite_master, and SQLite creates that table implicitly for
         * AUTOINCREMENT. Replaying it raises "object name reserved for internal use" - plan 01-04
         * flagged exactly this. Drop those statements; the seeded fixture grows its own on the
         * first insert, which the assertion above already checks. */
        const ddl = fs.readFileSync(realSchemaPath, 'utf8')
            .split('\n')
            .filter((line) => !line.trimStart().startsWith('--'))
            .join('\n')
            .split(';')
            .filter((statement) => !/create\s+table\s+["'`[]?sqlite_sequence/i.test(statement))
            .join(';');
        db.exec(ddl);
        const out = {};
        for (const table of TABLES) {
            out[table] = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
        }
        return out;
    } finally {
        db.close();
    }
}

function selfTest() {
    const results = [];
    const check = (label, ok, detail) => {
        results.push({ label, ok, detail });
        console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` - ${detail}` : ''}`);
    };

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wft-seed-'));
    try {
        const now = new Date();
        const first = seedDatabase(path.join(root, 'a'), now);
        const second = seedDatabase(path.join(root, 'b'), now);

        const db = new DatabaseSync(first.file, { readOnly: true, enableForeignKeyConstraints: false });
        let objects;
        let sessions;
        let missingCreatedAt;
        let foreignKeys;
        let columns;
        try {
            objects = db.prepare('SELECT name FROM sqlite_master WHERE type = \'table\'').all().map((r) => r.name);
            sessions = db.prepare('SELECT count(*) AS c, SUM(duration) AS d FROM work_sessions').get();
            missingCreatedAt =
                db.prepare('SELECT count(*) AS c FROM work_sessions WHERE created_at IS NULL').get().c +
                db.prepare('SELECT count(*) AS c FROM companies WHERE created_at IS NULL').get().c +
                db.prepare('SELECT count(*) AS c FROM pomodoro_sessions WHERE created_at IS NULL').get().c;
            foreignKeys = db.prepare('PRAGMA foreign_keys').get().foreign_keys;
            columns = {};
            for (const table of TABLES) {
                columns[table] = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
            }
        } finally {
            db.close();
        }

        const present = TABLES.filter((t) => objects.includes(t));
        check('all four v1.2.1 tables present', present.length === 4, present.join(', '));
        check(
            'sqlite_sequence exists (AUTOINCREMENT creates it implicitly; a fixture that lacks it is not comparable to a real database)',
            objects.includes('sqlite_sequence')
        );
        check('at least five seeded sessions', sessions.c >= 5, `${sessions.c} sessions, ${sessions.d} s total`);
        check('foreign keys left disabled, matching the application', foreignKeys === 0, `PRAGMA foreign_keys = ${foreignKeys}`);
        check('every created_at explicitly set', missingCreatedAt === 0, `${missingCreatedAt} NULL`);

        const contentA = JSON.stringify(dumpContent(first.file));
        const contentB = JSON.stringify(dumpContent(second.file));
        check('two runs on the same date produce identical row content', contentA === contentB);

        const real = realSchemaColumns();
        if (real) {
            const mismatches = TABLES.filter((t) => real[t].join(',') !== columns[t].join(','));
            check(
                'column names and post-ALTER order match the owner\'s real schema extract (D-05)',
                mismatches.length === 0,
                mismatches.length === 0 ? 'all four tables' : `differs: ${mismatches.join(', ')}`
            );
        }

        /* The determinism properties the capture actually depends on, asserted rather than assumed. */
        const dates = seedDates(now);
        const todayTotal = TODAY_SESSIONS.reduce((sum, s) => sum + s.duration, 0);
        check(
            'today clears the daily target, so the streak is exactly 1 on every run date',
            todayTotal >= Number(SETTINGS.daily_target),
            `${todayTotal} s vs target ${SETTINGS.daily_target} s`
        );
        const thisMonday = mondayOf(new Date(now));
        const inThisWeek = dates.lastWeek.filter((d) => new Date(`${d}T00:00:00`) >= thisMonday);
        check(
            'no historical session falls inside the current calendar week',
            inThisWeek.length === 0,
            `last-week block: ${dates.lastWeek.join(', ')}`
        );

        const failed = results.filter((r) => !r.ok);
        if (failed.length > 0) {
            console.error(`${SCRIPT_NAME}: SELF_TEST_FAILED - ${failed.length} assertion(s)`);
            return 1;
        }
        console.log('SELF_TEST_OK');
        return 0;
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

/* ---------------------------------------------------------------------------------------- */
/* CLI                                                                                        */
/* ---------------------------------------------------------------------------------------- */

const invokedDirectly = process.argv[1] &&
    path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
    const argv = process.argv.slice(2);
    if (argv.includes('--self-test')) {
        process.exit(selfTest());
    } else if (argv.includes('--fetch-vendor')) {
        await fetchVendor();
        process.exit(0);
    } else if (argv.includes('--verify-vendor')) {
        const result = verifyVendor();
        if (!result.ok) {
            console.error(`${SCRIPT_NAME}: VENDOR_VERIFY_FAILED`);
            for (const failure of result.failures) console.error(`  - ${failure}`);
            process.exit(1);
        }
        console.log(`${SCRIPT_NAME}: VENDOR_OK - ${result.count} assets match their manifest digests`);
        process.exit(0);
    } else {
        const target = argv.find((a) => !a.startsWith('--'));
        if (!target) {
            console.error(`usage: node ${SCRIPT_NAME} <dir> | --self-test | --verify-vendor | --fetch-vendor`);
            process.exit(2);
        }
        const { file, dates } = seedDatabase(path.resolve(target));
        console.log(`${SCRIPT_NAME}: seeded ${file}`);
        console.log(`${SCRIPT_NAME}: today=${dates.today} lastWeek=${dates.lastWeek.join(',')}`);
        process.exit(0);
    }
}
