// Zone-sweep child: runs date.ts invariants in the zone its spawn environment sets and prints one JSON report.
// Usage: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON tests/fixtures/date-sweep-child.mjs ZONE

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { JANUARY_INSTANT, JULY_INSTANT } from '../../tools/ci/assert-timezone.mjs';

const zone = process.argv[2];
if (!zone) {
    console.error('date-sweep-child: usage: node date-sweep-child.mjs ZONE');
    process.exit(2);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const date = await import(pathToFileURL(path.join(repoRoot, 'src', 'shared', 'utils', 'date.ts')).href);
const {
    addDays, diffDays, epochMsFromSqlTimestamp, formatLocalDate, instantFromEpochMs, isLocalDate, isoWeekday,
    parseLocalDate, weekBucketOf
} = date;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const FAILURE_LIMIT = 20;
const pad = (value, width) => String(value).padStart(width, '0');
const note = (list, entry) => {
    if (list.length < FAILURE_LIMIT) list.push(entry);
};

// Days per month come from the multi-argument constructor, an oracle independent of date.ts.
function enumerateDays(firstYear, lastYear) {
    const days = [];
    for (let year = firstYear; year <= lastYear; year++) {
        for (let month = 1; month <= 12; month++) {
            const length = new Date(year, month, 0).getDate();
            for (let day = 1; day <= length; day++) {
                days.push(pad(year, 4) + '-' + pad(month, 2) + '-' + pad(day, 2));
            }
        }
    }
    return days;
}

// 2019 and 2031 only supply neighbours; the checked range is 2020-01-01..2030-12-31.
const days = enumerateDays(2019, 2031);
const first = days.indexOf('2020-01-01');
const last = days.indexOf('2030-12-31');
const midnights = days.map((s) => parseLocalDate(s).getTime());

const roundTripFailures = [];
const arithmeticFailures = [];
const weekdayFailures = [];
const transitions = [];
let skippedMidnights = 0;
for (let i = first; i <= last; i++) {
    const s = days[i];
    const local = parseLocalDate(s);
    if (!isLocalDate(s) || formatLocalDate(local) !== s) note(roundTripFailures, s);
    if (addDays(s, 1) !== days[i + 1] || diffDays(days[i + 1], s) !== 1) note(arithmeticFailures, s);
    if (isoWeekday(s) !== ((local.getDay() + 6) % 7) + 1) note(weekdayFailures, s);
    if (local.getHours() !== 0) skippedMidnights++;
    if (midnights[i + 1] - midnights[i] !== DAY_MS) transitions.push(i);
}

// Oracle for the hourly walk: Intl with the zone named explicitly, independent of the local getters.
let oracle = null;
let oracleError = null;
try {
    oracle = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' });
} catch (error) {
    oracleError = String(error);
}

const walked = new Set();
for (const i of transitions) {
    walked.add(i - 1);
    walked.add(i);
    walked.add(i + 1);
}
let hourlyChecks = 0;
const hourlyFailures = [];
for (const i of [...walked].sort((a, b) => a - b)) {
    for (let t = midnights[i]; t < midnights[i + 1]; t += HOUR_MS) {
        const instant = instantFromEpochMs(t);
        const expected = oracle === null ? 'no oracle: ' + oracleError : oracle.format(instant);
        const actual = formatLocalDate(instant);
        hourlyChecks++;
        if (actual !== expected) note(hourlyFailures, days[i] + ' +' + ((t - midnights[i]) / HOUR_MS) + 'h: ' + actual + ' != ' + expected);
    }
}

// D-09: the epoch-millisecond week that date.ts replaces. It must be wrong in a DST zone.
const naiveAddDays = (d, n) => formatLocalDate(instantFromEpochMs(parseLocalDate(d).getTime() + n * DAY_MS));
const naiveLastMonday = parseLocalDate('2026-11-02').getTime() - 7 * DAY_MS;

process.stdout.write(JSON.stringify({
    zone,
    resolved: Intl.DateTimeFormat().resolvedOptions().timeZone,
    january: instantFromEpochMs(JANUARY_INSTANT).getTimezoneOffset(),
    july: instantFromEpochMs(JULY_INSTANT).getTimezoneOffset(),
    daysChecked: last - first + 1,
    roundTripFailures,
    arithmeticFailures,
    weekdayFailures,
    transitionDays: transitions.length,
    skippedMidnights,
    hourlyChecks,
    hourlyFailures,
    oracleError,
    naive: {
        fall: naiveAddDays('2026-10-26', 7),
        spring: naiveAddDays('2026-03-09', -7),
        fallBucket: parseLocalDate('2026-10-26').getTime() >= naiveLastMonday ? 'lastWeek' : 'older'
    },
    // A stored created_at is UTC: the same text must yield the same instant in every zone.
    sqlTimestamp: epochMsFromSqlTimestamp('2026-10-26 00:30:00'),
    correct: {
        fall: addDays('2026-10-26', 7),
        spring: addDays('2026-03-09', -7),
        fallBucket: weekBucketOf('2026-10-26', '2026-11-04'),
        springBucket: weekBucketOf('2026-03-02', '2026-03-11')
    }
}) + '\n');
