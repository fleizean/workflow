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
const { formatLocalDate, instantFromEpochMs, isLocalDate, parseLocalDate } = date;

const FAILURE_LIMIT = 20;
const pad = (value, width) => String(value).padStart(width, '0');

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

const days = enumerateDays(2020, 2030);
const roundTripFailures = [];
for (const s of days) {
    if (!isLocalDate(s) || formatLocalDate(parseLocalDate(s)) !== s) {
        if (roundTripFailures.length < FAILURE_LIMIT) roundTripFailures.push(s);
    }
}

process.stdout.write(JSON.stringify({
    zone,
    resolved: Intl.DateTimeFormat().resolvedOptions().timeZone,
    january: instantFromEpochMs(JANUARY_INSTANT).getTimezoneOffset(),
    july: instantFromEpochMs(JULY_INSTANT).getTimezoneOffset(),
    daysChecked: days.length,
    roundTripFailures
}) + '\n');
