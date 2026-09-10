import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

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
        expect(files.includes('google-apps-script.gs'), 'The Apps Script is missing from the enumeration.').toBe(true);
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
});
