// Every tracked shebang script must check out LF: a CRLF `#!` line breaks Unix `env` and vite's hashbang strip,
// so vitest cannot import it on a fresh checkout.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './helpers/ts-imports';

const git = (args: string[]): string => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' });

function hasShebang(file: string): boolean {
    const full = path.join(repoRoot, file);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return false;
    const fd = fs.openSync(full, 'r');
    try {
        const head = Buffer.alloc(2);
        return fs.readSync(fd, head, 0, 2, 0) === 2 && head.toString('latin1') === '#!';
    } finally {
        fs.closeSync(fd);
    }
}

const shebangFiles = git(['ls-files', '-z']).split('\0').filter((f) => f !== '' && hasShebang(f));

/*
 * D-13's neighbour: a NUL byte in a text file makes git treat it as BINARY.
 *
 * It has happened here twice. The first was fixed in 08-REVIEW; the second reached this phase's
 * tools/upgrade-over-v121.mjs as a join separator, and the only reason anyone noticed was a `Bin 0 -> 16993 bytes`
 * in a diffstat. A binary-classified source file has no diff, no `git diff --check` whitespace check and no
 * end-of-line normalisation - the whole line-ending contract silently stops applying to it. So the file is scanned
 * rather than the diffstat being watched. Scoped by extension, because the repository legitimately tracks PNGs,
 * woff2 and an mp3.
 */
const TEXT_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.cjs', '.mjs', '.json', '.yml', '.yaml', '.md', '.css', '.html', '.sql', '.sh'];

describe('no tracked text file is secretly binary', () => {
    const textFiles = git(['ls-files', '-z']).split('\0')
        .filter((file) => file !== '' && TEXT_EXTENSIONS.some((extension) => file.endsWith(extension)));

    it('finds the text files to scan', () => {
        expect(textFiles.length, 'the scan found no text files, so it proves nothing').toBeGreaterThan(100);
        expect(textFiles).toEqual(expect.arrayContaining(['package.json', 'tools/upgrade-over-v121.mjs']));
    });

    it('holds no NUL byte, which would make git classify the file as binary', () => {
        const offenders: string[] = [];
        for (const file of textFiles) {
            const bytes = fs.readFileSync(path.join(repoRoot, file));
            const at = bytes.indexOf(0);
            if (at >= 0) offenders.push(file + ' at byte ' + String(at));
        }
        expect(offenders, 'a NUL byte turns a source file binary, and every diff and line-ending guard stops ' +
            'applying to it:\n  ' + offenders.join('\n  ')).toEqual([]);
    });
});

describe('shebang line endings', () => {
    it('finds the shebang scripts that tests import through vitest', () => {
        expect(shebangFiles).toEqual(expect.arrayContaining([
            'tools/ci/assert-package-contents.mjs', 'tools/ci/assert-timezone.mjs', 'tools/smoke-packaged.mjs'
        ]));
    });

    it('checks every tracked shebang script out with eol=lf', () => {
        // -z output is flat triplets: path, attribute, value.
        const fields = git(['check-attr', '-z', 'eol', '--', ...shebangFiles]).split('\0');
        const eol = new Map<string, string>();
        for (let i = 0; i + 2 < fields.length; i += 3) eol.set(fields[i] ?? '', fields[i + 2] ?? '');

        const notLf = shebangFiles.filter((f) => eol.get(f) !== 'lf').map((f) => `${f} (eol: ${eol.get(f) ?? 'missing'})`);
        expect(notLf).toEqual([]);
    });
});
