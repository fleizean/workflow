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
