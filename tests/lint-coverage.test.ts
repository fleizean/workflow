import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ESLint, type Linter } from 'eslint';

/*
 * Why this file exists (BUILD-13, D-04).
 *
 * The failure it prevents is an entire file type dropping out of lint coverage without anyone
 * noticing. That is CB-7's root cause: the ~2,750 lines of inline <script> in src/pages/*.html
 * matched no lint configuration, nothing ever examined them, and they accumulated the thirteen
 * defects RESTRUCTURE-BRIEF.md catalogues as B1-B13 - an undefined identifier, a call to an API
 * that does not exist - that a linter would have flagged on the day each was written.
 *
 * It then happened twice more in plain sight. eslint.config.js declared SpreadsheetApp,
 * ContentService and Logger for google-apps-script.gs, and no files pattern ever named .gs, so the
 * deployed Apps Script was never linted. Plan 02-03 wrote the repository's first .tsx files, and
 * no block matched those either. None of the three produced a warning: ESLint does not complain
 * about a file nothing matches, it simply never opens it, and `eslint .` exits 0 over a tree it
 * has half skipped.
 *
 * So this file asks the linter what it would do with each file, rather than reading the config's
 * glob strings and reasoning about them. A glob that looks right but matches nothing is exactly
 * the failure BUILD-13 describes, and only the linter can say it matched nothing.
 *
 * Concurrency (the BUILD-13 probe row in 02-04-PLAN.md): the verdict is a pure function of the
 * file list and the config. No lint cache is consulted and nothing is written, so a partial or
 * parallel run cannot produce a different answer. If `--cache` is ever added to the lint script,
 * that claim has to be re-checked - the calls below do not read the cache, but the lint gate would.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/*
 * Git, not a filesystem walk: the question is what this repository owns, and git's standard
 * exclusions keep out/, node_modules/ and the gitignored tooling directories away for free - the
 * position tests/custody-hygiene.test.ts takes. But not a tracked-only listing either. This suite
 * runs before the commit that adds a file, and `git ls-files` alone cannot see the very newcomer
 * that would otherwise arrive unlinted: the guard would report full coverage of a set that
 * excludes it. --cached --others --exclude-standard widens what the guard sees without widening
 * what it accepts. execFileSync with an argument array: no shell, no quoting surface.
 */
const repositoryFiles = (): string[] => [
    ...new Set(
        execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
            cwd: repoRoot,
            encoding: 'utf8'
        })
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
    )
];

const extensionOf = (file: string): string => path.extname(file).toLowerCase();

const isUnder = (file: string, dir: string): boolean => file === dir || file.startsWith(dir + '/');

/* The extensions that are code. Every one must be matched by a block of eslint.config.js. */
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.cjs', '.mjs', '.gs'];

/*
 * Every other extension in the tree, each with the reason it is deliberately outside the source
 * set. The first test fails for an extension in neither list, so a new kind of file - .jsx, .vue,
 * .ps1 - is classified by a person before a filter can skip it.
 */
const NON_SOURCE: Record<string, string> = {
    '.md': 'prose documentation; nothing executes it',
    '.json': 'data and configuration - package.json, the tsconfigs, the Phase 1 computed baselines, the vendor index',
    '.yml': 'CI workflows and electron-builder.yml; configuration, not JavaScript',
    '.html': 'markup. src/pages/*.html inline scripts are the one expiring exclusion below; src/renderer/index.html carries only a module entry tag under a script-src \'self\' CSP; docs/ is the unrelated Pages site',
    '.css': 'stylesheets; not JavaScript',
    '.sql': 'DDL fixtures for the database tests; not JavaScript',
    '.sh': 'POSIX shell tooling under tools/baseline; not JavaScript',
    '.txt': 'Phase 1 baseline inventory output; text, not code',
    '.tsv': 'Phase 1 baseline inventory output; text, not code',
    '.webmanifest': 'the docs/ Pages site\'s JSON web-app manifest',
    '.svg': 'the docs/ Pages site\'s favicon; vector markup, no script',
    '.png': 'binary asset: image',
    '.ico': 'binary asset: icon',
    '.woff2': 'binary asset: font',
    '.mp3': 'binary asset: sound',
    '': 'no extension: LICENSE and dotfile configuration (.gitignore, .gitattributes, .nvmrc)'
};

interface ExpiringExclusion {
    dir: string;
    expires: string;
    why: string;
}

/*
 * The expiring exclusions: directories of repository-authored code that lint deliberately does not
 * reach, each bound to the phase that deletes it. There is exactly one. A second is a second
 * silent exclusion in the making, and has to be argued for by editing the exactly-one assertion
 * below in review - not slipped in here.
 */
const EXPIRING_EXCLUSIONS: ExpiringExclusion[] = [
    {
        dir: 'src/pages',
        expires: 'Phase 7',
        why: 'inline scripts whose defects are catalogued as B1-B13; deleted in the atomic cutover (D-01, D-04)'
    }
];

/*
 * Third-party bytes the repository carries but does not author: the Tailwind Play CDN script and
 * the fonts plan 01-05 vendored so the v1.2.1 baseline capture replays with no network. Each is
 * pinned by SHA-256 in tools/baseline/vendor/index.json and in section 3 of
 * baselines/v1.2.1/MANIFEST.md (tests/custody-hygiene.test.ts holds the two equal), so linting one
 * means editing it and breaking its pin.
 *
 * This is not an expiring exclusion, because nothing in it is repository source - and the
 * membership check is what keeps that true. An ignored file under this directory passes only if
 * the index pins it, so hand-written code dropped here fails as unlinted like anywhere else.
 */
const VENDOR_DIR = 'tools/baseline/vendor';
const VENDOR_INDEX = 'tools/baseline/vendor/index.json';

const pinnedVendorFiles = (): Set<string> => {
    const indexPath = path.join(repoRoot, VENDOR_INDEX);
    if (!fs.existsSync(indexPath)) return new Set();
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as { assets: { file: string }[] };
    return new Set(index.assets.map((asset) => VENDOR_DIR + '/' + asset.file));
};

/*
 * What "covered" means, asked of the linter's computed configuration for the file.
 *
 * Not "the rules object is non-empty". ESLint's built-in defaults match .js, .mjs and .cjs on
 * their own, and js.configs.recommended applies to every file anything matches, so a .mjs file
 * with no block of this repository's behind it still resolves the whole recommended set.
 * Measured in plan 02-04: with the .mjs block deleted, tools/baseline/capture.mjs still resolved
 * 63 rules, none of them off. A non-empty check passes exactly the configless file this guard
 * exists to catch.
 *
 * semi and quotes are set by no default and no preset - only by this repository's own
 * extension-specific blocks - so their presence at error is the linter's proof that one of those
 * blocks matched. The two custody rules are required on every file as well: a guard that does not
 * cover the file where the violation is plausible is not defence in depth (eslint.config.js,
 * plan 01-04).
 */
const REQUIRED_RULES = ['semi', 'quotes', 'no-restricted-properties', 'no-restricted-syntax'];

const ERROR = 2;
const SEVERITY: Record<string, number> = { off: 0, warn: 1, error: 2 };

const severityOf = (entry: unknown): number => {
    const level: unknown = Array.isArray(entry) ? entry[0] : entry;
    if (typeof level === 'number') return level;
    if (typeof level === 'string') return SEVERITY[level] ?? 0;
    return 0;
};

/* The slice of ESLint's computed configuration this file reads. */
interface ComputedConfig {
    rules?: Record<string, unknown>;
}

const eslint = new ESLint({ cwd: repoRoot });

const computedConfig = async (rel: string): Promise<ComputedConfig | undefined> =>
    (await eslint.calculateConfigForFile(path.join(repoRoot, rel))) as ComputedConfig | undefined;

const ruleEntry = async (rel: string, rule: string): Promise<unknown> =>
    (await computedConfig(rel))?.rules?.[rule];

const CUSTODY_03_TEXT = 'copyFileSync|cp|cpSync|rename|renameSync';
const DATE_MESSAGE = 'Calendar dates go through src/shared/utils/date.ts (SHARED-03).';
const TS_PROBE_FILE = 'src/main/index.ts';
// Never written to disk; any .mjs path lints without a TypeScript program.
const JS_PROBE_FILE = 'tools/ci/__date_ban_probe__.mjs';

interface DateExemption {
    expires: string;
    why: string;
}

// Rule-level exemptions from the date bans (D-13), kept apart from EXPIRING_EXCLUSIONS, which lists ignored code.
const DATE_EXEMPTIONS: Record<string, DateExemption> = {
    'src/shared/utils/date.ts': { expires: 'permanent', why: 'the sanctioned home of the date constructs (D-05)' },
    'main.js': { expires: 'Phase 7', why: 'legacy v1.2.1 file that Phase 2 D-01 forbids editing' },
    'database/db.js': { expires: 'Phase 7', why: 'legacy v1.2.1 file that Phase 2 D-01 forbids editing' },
    'src/renderer/shared.js': { expires: 'Phase 7', why: 'legacy v1.2.1 file that Phase 2 D-01 forbids editing' },
    'src/renderer/timer.js': { expires: 'Phase 7', why: 'legacy v1.2.1 file that Phase 2 D-01 forbids editing' }
};

const isDateExempt = (file: string): boolean => Object.hasOwn(DATE_EXEMPTIONS, file);

const isConfigBypass = (m: Linter.LintMessage): boolean =>
    m.ruleId === 'no-restricted-properties' && m.message.endsWith('from src/main/config.ts (D-23).');

const byRule = (...ruleIds: string[]) => (m: Linter.LintMessage): boolean => m.ruleId !== null && ruleIds.includes(m.ruleId);

interface ProbeVerdict {
    missed: string[];
    flagged: string[];
}

// Lints in-memory text under an existing path, so typed linting finds the file in its program (Pitfall 9).
async function probe(
    file: string,
    header: readonly string[],
    banned: readonly string[],
    allowed: readonly string[],
    matches: (m: Linter.LintMessage) => boolean
): Promise<ProbeVerdict> {
    const lines = [...header, ...banned, ...allowed];
    const [result] = await eslint.lintText(lines.join('\n') + '\n', { filePath: path.join(repoRoot, file) });
    const messages = result?.messages ?? [];
    const fatal = messages.filter((m) => m.fatal === true);
    if (fatal.length > 0) {
        throw new Error(file + ': the probe did not parse - ' + fatal.map((m) => m.message).join('; '));
    }
    const hit = new Set(messages.filter(matches).map((m) => m.line));
    const lineOf = (i: number): number => header.length + i + 1;
    return {
        missed: banned.filter((_, i) => !hit.has(lineOf(i))),
        flagged: allowed.filter((_, i) => hit.has(lineOf(banned.length + i)))
    };
}

const isDateBan = (m: Linter.LintMessage): boolean => m.message === DATE_MESSAGE;

const BANNED_DATE_SHAPES = [
    'd.toISOString();',
    'd?.toISOString();',
    'd[\'toISOString\']();',
    'Date.parse(s);',
    'Date[\'parse\'](s);',
    'new Date(s);',
    'new Date(...parts);',
    'd.getUTCFullYear();',
    'd.getUTCMonth();',
    'd.getUTCDate();',
    'd.getUTCDay();',
    'const { toISOString } = d;',
    'const { parse } = Date;',
    // WR-03: toJSON() is toISOString() under another name.
    'd.toJSON();',
    'd?.toJSON();',
    'd[\'toJSON\']();',
    'const { toJSON } = d;'
];
const ALLOWED_DATE_SHAPES = ['new Date();', 'new Date(2026, 8, 10);', 'Date.UTC(2026, 8, 10);', 'Date.now();', 'd.getUTCHours();'];

interface KnownGap {
    file: string;
    header: string[];
    code: string;
    matches: (m: Linter.LintMessage) => boolean;
    why: string;
}

// Syntactic rules cannot resolve globalThis aliases; asserting the gap means a change in either direction is noticed.
const KNOWN_GAPS: KnownGap[] = [
    {
        file: TS_PROBE_FILE,
        header: ['declare const s: string;'],
        code: 'new globalThis.Date(s);',
        matches: isDateBan,
        why: 'a syntactic rule cannot see through globalThis to the Date constructor'
    },
    {
        file: TS_PROBE_FILE,
        header: ['declare const d: Date;'],
        code: 'JSON.stringify(d);',
        matches: isDateBan,
        why: 'a syntactic rule cannot know the argument is a Date'
    },
    {
        file: 'src/main/window.ts',
        header: [],
        code: 'void globalThis.process.env.PATH;',
        matches: isConfigBypass,
        why: 'no-restricted-properties matches the object name process, not a property chain ending in it'
    }
];

describe('BUILD-13 / D-04: lint reaches every source file this repository owns', () => {
    it('enumerates the set it claims to: git-known files, this file included, no build output', () => {
        const files = repositoryFiles();
        const source = files.filter((file) => SOURCE_EXTENSIONS.includes(extensionOf(file)));

        expect(source.length, 'The enumeration found no source files at all - it is wrong.').toBeGreaterThan(0);
        expect(
            files.includes('tests/lint-coverage.test.ts'),
            'The enumeration does not contain this test file. Run before its first commit it is ' +
            'untracked, so its absence means untracked files are invisible - and the newcomer the ' +
            'guard exists to catch would be invisible with them.'
        ).toBe(true);
        expect(
            source.some((file) => extensionOf(file) === '.tsx'),
            'No .tsx file in the enumeration - coverage of that extension would be verified vacuously.'
        ).toBe(true);
        expect(
            files.filter((file) => isUnder(file, 'out') || isUnder(file, 'node_modules')),
            'Build output or dependencies leaked into the enumeration.'
        ).toEqual([]);
    });

    it('classifies every extension in the tree as source or as a named non-source kind', () => {
        const unclassified = [
            ...new Set(
                repositoryFiles()
                    .map(extensionOf)
                    .filter((ext) => !SOURCE_EXTENSIONS.includes(ext) && !(ext in NON_SOURCE))
            )
        ];
        expect(
            unclassified,
            'These extensions are in the repository and in neither SOURCE_EXTENSIONS nor ' +
            'NON_SOURCE: ' + unclassified.join(', ') + '\nIf they are code, add them to ' +
            'SOURCE_EXTENSIONS and give eslint.config.js a block that matches them. If they are ' +
            'not, add them to NON_SOURCE with the one-line reason.'
        ).toEqual([]);
    });

    it('lints every source file with a block of this repository, unless it is a named exclusion', async () => {
        const pinned = pinnedVendorFiles();
        const source = repositoryFiles().filter((file) => SOURCE_EXTENSIONS.includes(extensionOf(file)));
        const offenders: string[] = [];

        for (const file of source) {
            /*
             * ESLint 9 implements isPathIgnored as calculateConfigForFile(...) === undefined. A file
             * no block matches and a file an ignore pattern removes are the same answer, and both
             * have to be justified, so both land in this branch.
             */
            if (await eslint.isPathIgnored(path.join(repoRoot, file))) {
                const expiring = EXPIRING_EXCLUSIONS.some((ex) => isUnder(file, ex.dir));
                const vendored = isUnder(file, VENDOR_DIR) && pinned.has(file);
                if (!expiring && !vendored) {
                    offenders.push(file + ' - matched by no config block, or ignored with no EXPIRING_EXCLUSIONS entry');
                }
                continue;
            }

            const rules = (await computedConfig(file))?.rules ?? {};
            const missing = REQUIRED_RULES.filter((rule) => severityOf(rules[rule]) !== ERROR);
            if (missing.length > 0) {
                offenders.push(
                    file + ' - linted, but without ' + missing.join(', ') + ' at error: no block ' +
                    'of this repository matched it, or one of its rules was switched off'
                );
            }
        }

        expect(
            offenders,
            'These source files are outside lint coverage:\n  ' + offenders.join('\n  ') +
            '\nAdd a block to eslint.config.js whose files pattern matches them. If one genuinely ' +
            'must not be linted, it needs an ignore entry in the config that names the phase which ' +
            'ends it, and an EXPIRING_EXCLUSIONS entry here - an exclusion nobody can see the end ' +
            'of is the silent exclusion BUILD-13 forbids.'
        ).toEqual([]);
    });
});

describe('D-04: the one remaining exclusion expires with its subject', () => {
    it('has exactly one expiring exclusion', () => {
        expect(
            EXPIRING_EXCLUSIONS.map((ex) => ex.dir),
            'The expiring-exclusion list must hold exactly one entry, src/pages. A second entry ' +
            'is a second directory of repository code that lint does not read.'
        ).toEqual(['src/pages']);
    });

    /*
     * The tripwire. When Phase 7 deletes the legacy pages this goes red, and that is the whole
     * point: it forces the ignore entry out of eslint.config.js in the same change, instead of
     * leaving it behind as a rule about nothing that the next directory of that name inherits.
     */
    it('names a directory that still exists', () => {
        for (const ex of EXPIRING_EXCLUSIONS) {
            expect(
                fs.existsSync(path.join(repoRoot, ex.dir)),
                ex.dir + ' no longer exists - ' + ex.expires + ' has removed it. Delete its ignore ' +
                'entry from eslint.config.js and its EXPIRING_EXCLUSIONS entry here, in this ' +
                'same change.'
            ).toBe(true);
        }
    });

    /*
     * The list here and the ignore entry in the config are one decision recorded twice; this holds
     * them together. The probe is a hypothetical .js file, because .js is an extension the config
     * does match - so the only way it can come back ignored is the ignore entry itself.
     */
    it('is actually ignored by eslint.config.js', async () => {
        for (const ex of EXPIRING_EXCLUSIONS) {
            const probe = path.join(repoRoot, ex.dir, '__lint_coverage_probe__.js');
            expect(
                await eslint.isPathIgnored(probe),
                'EXPIRING_EXCLUSIONS names ' + ex.dir + ', but eslint.config.js no longer ignores ' +
                'it. Remove the entry here too, or restore the ignore.'
            ).toBe(true);
        }
    });
});

describe('the rules the rewrite must not lose', () => {
    /*
     * Per-file coverage alone could pass with the custody rules present but emptied - an option
     * list that bans nothing still resolves at error. So the representative files are checked for
     * what the rules actually ban, on both halves of the tree.
     */
    const REPRESENTATIVE = ['src/main/index.ts', 'src/renderer/src/App.tsx', 'tools/baseline/archive-real-db.mjs', 'database/db.js'];

    it.each(REPRESENTATIVE)('CUSTODY-02 and CUSTODY-03 resolve, with their bans intact, for %s', async (file) => {
        const properties = await ruleEntry(file, 'no-restricted-properties');
        const syntax = await ruleEntry(file, 'no-restricted-syntax');

        expect(severityOf(properties), 'CUSTODY-02 no-restricted-properties is not at error for ' + file).toBe(ERROR);
        expect(severityOf(syntax), 'CUSTODY-03 no-restricted-syntax is not at error for ' + file).toBe(ERROR);

        const banned = JSON.stringify(properties);
        expect(banned, 'CUSTODY-02 no longer bans app.setPath for ' + file).toContain('"property":"setPath"');
        expect(banned, 'CUSTODY-02 no longer bans app.setName for ' + file).toContain('"property":"setName"');
        expect(
            JSON.stringify(syntax),
            'CUSTODY-03 no longer bans fs copies of a SQLite database for ' + file
        ).toContain('copyFileSync|cp|cpSync|rename|renameSync');

        if (!isDateExempt(file)) {
            const dateBans = JSON.stringify(syntax);
            expect(dateBans, 'the date bans do not resolve for ' + file).toContain(DATE_MESSAGE);
            expect(dateBans, 'toISOString is no longer banned for ' + file).toContain('property.name=\'toISOString\'');
            expect(dateBans, 'toJSON is no longer banned for ' + file).toContain('property.name=\'toJSON\'');
            expect(dateBans, 'one-argument Date construction is no longer banned for ' + file).toContain('arguments.length=1');
        }
    });

    /*
     * src/shared has no files yet. Asking about a hypothetical path in it is how the rule is shown
     * to be waiting for the first one, rather than discovered missing after it lands.
     */
    it.each(['src/lib/db/client.ts', 'src/shared/probe.ts'])('bans importing electron in %s', async (file) => {
        const entry = await ruleEntry(file, 'no-restricted-imports');
        expect(severityOf(entry), 'no-restricted-imports is not at error for ' + file).toBe(ERROR);
        expect(JSON.stringify(entry), 'no-restricted-imports does not name electron for ' + file).toContain('"name":"electron"');
    });

    it('does not ban electron in src/main, which legitimately imports it', async () => {
        expect(
            severityOf(await ruleEntry('src/main/index.ts', 'no-restricted-imports')),
            'no-restricted-imports reaches src/main. The ban belongs to src/lib and src/shared only; ' +
            'the main process is where electron is supposed to be imported.'
        ).toBe(0);
    });

    it('keeps node builtins and the driver legal in src/lib and bans them in src/shared', async () => {
        const lib = JSON.stringify(await ruleEntry('src/lib/db/client.ts', 'no-restricted-imports'));
        const shared = JSON.stringify(await ruleEntry('src/shared/probe.ts', 'no-restricted-imports'));
        expect(lib, 'the shared-layer bans reached src/lib, which must import node:* (Pitfall 2)').not.toContain('^node:');
        expect(lib, 'the shared-layer bans reached src/lib, which must import the driver (Pitfall 2)').not.toContain('"name":"better-sqlite3"');
        expect(shared, 'src/shared may import node:* builtins (D-15)').toContain('^node:');
        expect(shared, 'src/shared may import the database driver (D-15)').toContain('"name":"better-sqlite3"');
    });
});

describe('SHARED-03: calendar dates go through src/shared/utils/date.ts', () => {
    it('exempts date.ts from the date bans and keeps CUSTODY-03 there', async () => {
        const syntax = await ruleEntry('src/shared/utils/date.ts', 'no-restricted-syntax');
        expect(severityOf(syntax), 'no-restricted-syntax is not at error for date.ts').toBe(ERROR);
        expect(JSON.stringify(syntax), 'the date.ts block dropped CUSTODY-03').toContain(CUSTODY_03_TEXT);
        expect(JSON.stringify(syntax), 'date.ts is not exempt from the date bans').not.toContain(DATE_MESSAGE);
    });

    it('reports every banned shape and no allowed one in a TypeScript file', async () => {
        const header = ['declare const d: Date;', 'declare const s: string;', 'declare const parts: [number, number];'];
        const banned = [...BANNED_DATE_SHAPES, 'new Date(s as string);'];
        const { missed, flagged } = await probe(TS_PROBE_FILE, header, banned, ALLOWED_DATE_SHAPES, isDateBan);
        expect(missed, 'banned date shapes the TypeScript lint let through').toEqual([]);
        expect(flagged, 'allowed date shapes the TypeScript lint reported').toEqual([]);
    }, 60_000);

    it('reports every banned shape and no allowed one in a JavaScript file', async () => {
        const header = ['const d = new Date();', 'const s = \'2026-09-10\';', 'const parts = [2026, 8];'];
        const { missed, flagged } = await probe(JS_PROBE_FILE, header, BANNED_DATE_SHAPES, ALLOWED_DATE_SHAPES, isDateBan);
        expect(missed, 'banned date shapes the JavaScript lint let through').toEqual([]);
        expect(flagged, 'allowed date shapes the JavaScript lint reported').toEqual([]);
    }, 60_000);

    it('resolves the date bans on every linted source file except the inventoried exemptions', async () => {
        const offenders: string[] = [];
        let checked = 0;
        for (const file of repositoryFiles().filter((f) => SOURCE_EXTENSIONS.includes(extensionOf(f)))) {
            if (await eslint.isPathIgnored(path.join(repoRoot, file))) continue;
            checked++;
            const syntax = JSON.stringify(await ruleEntry(file, 'no-restricted-syntax'));
            const banned = syntax.includes(DATE_MESSAGE);
            if (!syntax.includes(CUSTODY_03_TEXT)) offenders.push(file + ' - CUSTODY-03 does not resolve');
            if (isDateExempt(file) && banned) offenders.push(file + ' - in DATE_EXEMPTIONS, yet the date bans still apply');
            if (!isDateExempt(file) && !banned) offenders.push(file + ' - not in DATE_EXEMPTIONS, yet the date bans do not apply');
        }
        expect(checked, 'no source file was checked').toBeGreaterThan(0);
        expect(offenders, 'eslint.config.js and DATE_EXEMPTIONS disagree:\n  ' + offenders.join('\n  ')).toEqual([]);
    }, 60_000);

    it.each(Object.entries(DATE_EXEMPTIONS))('the date exemption for %s names a file that still exists', (file, ex) => {
        const gone = ex.expires === 'Phase 7'
            ? file + ' no longer exists - Phase 7 removed it. Delete it from LEGACY_DATE_EXEMPT in eslint.config.js ' +
              'and from DATE_EXEMPTIONS here, in this same change.'
            : file + ' no longer exists, yet it holds a permanent date exemption (' + ex.why + ').';
        expect(fs.existsSync(path.join(repoRoot, file)), gone).toBe(true);
    });

    // One directive silences every selector on its line (Pitfall 14), so shipped code is linted with directives off.
    it('finds no date-ban hit in shipped code with inline configuration disabled', async () => {
        const strict = new ESLint({ cwd: repoRoot, allowInlineConfig: false });
        const [control] = await strict.lintText(
            '// eslint-disable-next-line no-restricted-syntax\nnew Date(process.argv[2]);\n',
            { filePath: path.join(repoRoot, JS_PROBE_FILE) }
        );
        expect(
            (control?.messages ?? []).some(isDateBan),
            'allowInlineConfig: false no longer ignores a disable directive, so this pass proves nothing'
        ).toBe(true);

        const shipped: string[] = [];
        for (const file of repositoryFiles()) {
            if (!isUnder(file, 'src') || !SOURCE_EXTENSIONS.includes(extensionOf(file)) || isDateExempt(file)) continue;
            const abs = path.join(repoRoot, file);
            if (fs.existsSync(abs) && !(await strict.isPathIgnored(abs))) shipped.push(abs);
        }
        const hits = (await strict.lintFiles(shipped)).flatMap((result) =>
            result.messages.filter(isDateBan).map((m) => path.relative(repoRoot, result.filePath) + ':' + String(m.line)));
        expect(shipped.length, 'no shipped source file was linted').toBeGreaterThan(0);
        expect(hits, 'shipped code hides a date-ban hit behind an inline directive; use a date.ts helper').toEqual([]);
    }, 180_000);
});

describe('D-23: only src/main/config.ts reads process.env and process.argv', () => {
    const CONFIG_BYPASS_SHAPES = ['void process.env.PATH;', 'void process[\'env\'];', 'const { env } = process;', 'void process.argv;'];

    it('bans env and argv beside CUSTODY-02 in src/main/window.ts, and lifts only them in config.ts', async () => {
        const windowRule = JSON.stringify(await ruleEntry('src/main/window.ts', 'no-restricted-properties'));
        const configRule = JSON.stringify(await ruleEntry('src/main/config.ts', 'no-restricted-properties'));
        for (const custody of ['"property":"setPath"', '"property":"setName"']) {
            expect(windowRule, 'CUSTODY-02 lost ' + custody + ' in src/main/window.ts').toContain(custody);
            expect(configRule, 'CUSTODY-02 lost ' + custody + ' in src/main/config.ts').toContain(custody);
        }
        for (const read of ['"property":"env"', '"property":"argv"']) {
            expect(windowRule, 'src/main/window.ts may read ' + read).toContain(read);
            expect(configRule, 'src/main/config.ts is banned from ' + read).not.toContain(read);
        }
    });

    it('reports every env/argv read outside config.ts', async () => {
        const { missed, flagged } = await probe('src/main/window.ts', [], CONFIG_BYPASS_SHAPES, ['void process.platform;'], isConfigBypass);
        expect(missed, 'env/argv reads the lint let through in src/main/window.ts').toEqual([]);
        expect(flagged, 'the ban reached an unrelated process property').toEqual([]);
    }, 60_000);

    it('reports none of them in config.ts', async () => {
        const { flagged } = await probe('src/main/config.ts', [], [], CONFIG_BYPASS_SHAPES, isConfigBypass);
        expect(flagged, 'config.ts, the one sanctioned reader, is refused its reads').toEqual([]);
    }, 60_000);
});

describe('D-15 and D-14: import boundaries', () => {
    const SHARED_PROBE_FILE = 'src/shared/utils/date.ts';

    it('refuses upward, node, electron and driver imports in src/shared', async () => {
        const banned = [
            'import fs from \'node:fs\';',
            'import Database from \'better-sqlite3\';',
            'import { app } from \'electron\';',
            'import { mainConfig } from \'../../main/config\';',
            'import { openDatabase } from \'@lib/db/client\';'
        ];
        const allowed = ['import type { Settings } from \'@shared/types\';'];
        const { missed, flagged } = await probe(SHARED_PROBE_FILE, [], banned, allowed, byRule('no-restricted-imports'));
        expect(missed, 'imports src/shared was allowed to make').toEqual([]);
        expect(flagged, 'the layer ban refused an import within src/shared').toEqual([]);
    }, 60_000);

    it('refuses a value import of zod or a zod-bearing module in a renderer-safe shared module', async () => {
        const banned = [
            'import { z } from \'zod\';',
            'import { SettingsSchema } from \'@shared/schemas\';',
            'import { ipcContract } from \'../ipc/contract\';',
            'import { LocalDateSchema } from \'../schemas\';'
        ];
        const allowed = [
            'import type { ZodType } from \'zod\';',
            'import type { IpcContract } from \'../ipc/contract\';',
            'import type { CompanySchema } from \'@shared/schemas\';'
        ];
        const { missed, flagged } = await probe(SHARED_PROBE_FILE, [], banned, allowed, byRule('@typescript-eslint/no-restricted-imports'));
        expect(missed, 'WR-02: value imports that would ship zod through a renderer-safe shared module').toEqual([]);
        expect(flagged, 'type-only imports refused in src/shared/utils').toEqual([]);
    }, 60_000);

    it('lets zod and the zod-bearing shared modules into the renderer only as types', async () => {
        const banned = [
            'import { z } from \'zod\';',
            'import { SettingsSchema } from \'@shared/schemas\';',
            'import { ipcContract } from \'../../shared/ipc/contract\';',
            'import { type ZodType } from \'zod\';'
        ];
        const allowed = ['import type { ZodType } from \'zod\';', 'import type { Company } from \'@shared/types\';'];
        const { missed, flagged } = await probe(
            'src/renderer/src/App.tsx', [], banned, allowed,
            byRule('@typescript-eslint/no-restricted-imports', '@typescript-eslint/no-import-type-side-effects')
        );
        expect(missed, 'value imports that would ship zod to the renderer').toEqual([]);
        expect(flagged, 'type-only imports the renderer was refused').toEqual([]);
    }, 60_000);
});

describe('known syntactic gaps', () => {
    it.each(KNOWN_GAPS)('inventories $code', async (gap) => {
        const { flagged } = await probe(gap.file, gap.header, [], [gap.code], gap.matches);
        expect(
            flagged,
            gap.code + ' is now reported, so "' + gap.why + '" no longer holds - move it into the banned shapes'
        ).toEqual([]);
    }, 60_000);
});
