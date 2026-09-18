import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ESLint, type Linter } from 'eslint';

/*
 * Why this file exists (BUILD-13, D-04).
 *
 * The failure it prevents is an entire file type dropping out of lint coverage without anyone noticing. That is
 * CB-7's root cause: the ~2,750 lines of inline <script> in legacy/pages/*.html matched no lint configuration,
 * nothing ever examined them, and they accumulated the thirteen defects RESTRUCTURE-BRIEF.md catalogues as B1-B13 -
 * an undefined identifier, a call to an API that does not exist - that a linter would have flagged on the day each
 * was written.
 *
 * It then happened twice more in plain sight. eslint.config.js declared Apps Script globals for a .gs file no files
 * pattern ever named, so the deployed script was never linted; plan 02-03 wrote the repository's first .tsx files
 * and no block matched those either. None of the three produced a warning: ESLint does not complain about a file
 * nothing matches, it simply never opens it, and `eslint .` exits 0 over a tree it has half skipped.
 *
 * So this file asks the linter what it would do with each file, rather than reading the config's glob strings. A
 * glob that looks right but matches nothing is exactly the failure BUILD-13 describes, and only the linter can say
 * it matched nothing.
 *
 * Concurrency: the verdict is a pure function of the file list and the config. No lint cache is consulted and
 * nothing is written. If `--cache` is ever added to the lint script, that claim has to be re-checked.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/*
 * Git, not a filesystem walk: the question is what this repository owns, and git's standard exclusions keep out/,
 * node_modules/ and the gitignored tooling directories away for free. But not a tracked-only listing either - this
 * suite runs before the commit that adds a file, and `git ls-files` alone cannot see the very newcomer that would
 * otherwise arrive unlinted. --cached --others --exclude-standard widens what the guard SEES without widening what
 * it accepts. execFileSync with an argument array: no shell, no quoting surface.
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
 * Every other extension in the tree, each with the reason it is deliberately outside the source set. The first test
 * fails for an extension in neither list, so a new kind of file is classified by a person before a filter skips it.
 */
const NON_SOURCE: Record<string, string> = {
    '.md': 'prose documentation; nothing executes it',
    '.json': 'data and configuration - package.json, the tsconfigs, the Phase 1 computed baselines, the vendor index',
    '.yml': 'CI workflows and electron-builder.yml; configuration, not JavaScript',
    '.html': 'markup. src/renderer/index.html carries only a module entry tag under a script-src \'self\' CSP; docs/index.html is the Pages site, which is served from github.io and is not the application',
    '.css': 'stylesheets; not JavaScript',
    '.sql': 'DDL fixtures for the database tests; not JavaScript',
    '.sh': 'POSIX shell tooling under tools/baseline; not JavaScript',
    '.txt': 'Phase 1 baseline inventory output; text, not code',
    '.tsv': 'Phase 1 baseline inventory output; text, not code',
    '.webmanifest': 'the docs/ Pages site\'s JSON web-app manifest',
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
 * The expiring exclusions: directories of repository-authored code that lint deliberately does not reach, each
 * bound to the phase that deletes it.
 *
 * THE LIST IS EMPTY, and that is the tripwire below having fired as designed. Its one entry was the retired v1.2.1
 * renderer under legacy/, which SPA-14 deleted in 08-F; the ignore entry came out of eslint.config.js in the same
 * commit. Every line of repository-authored code is linted.
 *
 * A new entry is a new directory of repository code that lint does not read. It has to be argued for by editing
 * the assertion below in review, not slipped in here.
 */
const EXPIRING_EXCLUSIONS: ExpiringExclusion[] = [];

/*
 * Third-party bytes the repository carries but does not author: the Tailwind Play CDN script and the fonts plan
 * 01-05 vendored so the v1.2.1 baseline capture replays with no network. Each is pinned by SHA-256 in
 * tools/baseline/vendor/index.json and in section 3 of baselines/v1.2.1/MANIFEST.md, so linting one means editing
 * it and breaking its pin. Not an expiring exclusion, because nothing in it is repository source - and the
 * membership check is what keeps that true: hand-written code dropped here fails as unlinted like anywhere else.
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
 * Not "the rules object is non-empty". ESLint's built-in defaults match .js, .mjs and .cjs on their own, and
 * js.configs.recommended applies to every file anything matches, so a .mjs file with no block of this repository's
 * behind it still resolves the whole recommended set. Measured in plan 02-04: with the .mjs block deleted,
 * tools/baseline/capture.mjs still resolved 63 rules, none of them off. A non-empty check passes exactly the
 * configless file this guard exists to catch.
 *
 * semi and quotes are set by no default and no preset - only by this repository's own extension-specific blocks -
 * so their presence at error is the linter's proof that one of those blocks matched. The two custody rules are
 * required on every file as well: a guard that does not cover the file where the violation is plausible is not
 * defence in depth.
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

/*
 * calculateConfigForFile RETURNS UNDEFINED rather than throwing for any path ESLint would not lint -
 * an ignore pattern covers it, or no block's `files` matches it. Every reader here then took
 * `?.rules?.[rule]` as undefined and carried on, so "this rule stopped applying to this path" was
 * indistinguishable from "this rule applied and allowed it". Measured against eslint 9.39.2:
 * docs/x.ts (ignored) and src/main/x.bogusext (no matching block) both come back undefined.
 */
const computedConfig = async (rel: string): Promise<ComputedConfig> => {
    const abs = path.join(repoRoot, rel);
    const config = (await eslint.calculateConfigForFile(abs)) as ComputedConfig | undefined;
    if (config === undefined) {
        throw new Error(
            rel + ': ESLint computed no configuration for this path, so every rule read from it would ' +
            'look absent rather than applying (isPathIgnored=' + String(await eslint.isPathIgnored(abs)) + ').'
        );
    }
    return config;
};

const ruleEntry = async (rel: string, rule: string): Promise<unknown> =>
    (await computedConfig(rel)).rules?.[rule];

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
    'src/shared/utils/date.ts': { expires: 'permanent', why: 'the sanctioned home of the date constructs (D-05)' }
};

const isDateExempt = (file: string): boolean => Object.hasOwn(DATE_EXEMPTIONS, file);

// ARCH-01: SQL lives only under src/lib/db. Everything else that may still write it is named here, with the reason.
const SQL_MESSAGE = 'SQL lives only under src/lib/db; call a repository (ARCH-01, CORE-16).';
const SQL_HOME = 'src/lib/db';
const SQL_EXEMPTIONS: Record<string, { expires: string; why: string }> = {
    'src/main/database-startup.ts': {
        expires: 'permanent',
        why: 'D-32 folds the -wal back into the database with a pragma before the connection closes'
    },
    'src/main/smoke.ts': {
        expires: 'permanent',
        why: 'BUILD-06 writes and reads one row in a brand-new injected database to prove the packaged driver works'
    }
};
const isSqlExempt = (file: string): boolean => isUnder(file, SQL_HOME) || Object.hasOwn(SQL_EXEMPTIONS, file);

const isConfigBypass = (m: Linter.LintMessage): boolean =>
    m.ruleId === 'no-restricted-properties' && m.message.endsWith('from src/main/config.ts (D-23).');

/* A message predicate that can also say which rules it depends on, so probe() can check they are on. */
interface MessageMatcher {
    (m: Linter.LintMessage): boolean;
    ruleIds?: readonly string[];
}

const byRule = (...ruleIds: string[]): MessageMatcher => {
    const matcher: MessageMatcher = (m) => m.ruleId !== null && ruleIds.includes(m.ruleId);
    matcher.ruleIds = ruleIds;
    return matcher;
};

interface ProbeVerdict {
    missed: string[];
    flagged: string[];
}

/* What the probe actually saw. A probe that fails has to explain itself without needing a second run. */
async function probeDiagnosis(rel: string, messages: readonly Linter.LintMessage[], rules: readonly string[]): Promise<string> {
    const configured = (await computedConfig(rel)).rules ?? {};
    const named = rules.length > 0 ? rules : Object.keys(configured).filter((r) => r.includes('restricted')).slice(0, 3);
    // The LENGTH is the diagnostic one: two blocks that both enable a rule are told apart by how much
    // they put in it, and a truncated dump of a 12 KB options object would hide exactly that.
    const shown = named.map((rule) => {
        const json = JSON.stringify(configured[rule]);
        return json === undefined
            ? rule + ' is absent'
            : rule + ' [' + String(json.length) + ' chars] ' + json.slice(0, 240);
    });
    return 'ESLint reported ' + JSON.stringify(messages.map((m) => m.ruleId)) + '. Computed config: ' + shown.join(' || ');
}

/*
 * THE SENTINEL, and the failure it catches, which every guard below is blind to.
 *
 * On the ubuntu runner two probes reported every banned construct as permitted, and the diagnosis
 * was that ESLint returned NO messages at all - not even the no-unused-vars that the probe's own
 * unused imports must produce - while the computed configuration was entirely correct (12,421
 * characters of it, electron and better-sqlite3 and ^node: all present). Zero messages under a
 * correct configuration is what linting a CLEAN file looks like, and the clean file in question is
 * the one on disk at the probe's path. typescript-eslint had handed the rules the on-disk source
 * instead of the text supplied here, so the bans were real, applied, and evaluated against source
 * that contains none of the constructs being probed.
 *
 * That failure is invisible to every other check: the path is not ignored, the config is right, the
 * parse succeeds, and a clean lint of the wrong file is a successful lint. So the probe plants
 * something in its own text that MUST come back. `quotes` is 'single' for every extension probed
 * here, so a double-quoted string is reported on its line or the result is not about this text.
 * `void` rather than a binding: no-unused-vars then has nothing to say about it, and the repository
 * already probes with `void process.platform;`, so the shape is known to be inert.
 */
const SENTINEL = 'void "probe sentinel";';
const SENTINEL_RULE = 'quotes';

/*
 * Why priming fixes it rather than hiding it. typescript-eslint only tells its cached program that a
 * file changed once it has seen that file as a lint target; the FIRST lint of a path reuses whatever
 * the program read from disk when it was built. That matches the runner exactly - per file, the
 * first probe failed and every later probe of the same file passed - and it is why the failure needs
 * CPU contention to appear at all. One throwaway lint per distinct path puts the file in that set,
 * so the lint that matters is the second one and gets the text it was given.
 */
const primed = new Set<string>();
async function prime(filePath: string): Promise<void> {
    if (primed.has(filePath)) return;
    primed.add(filePath);
    await eslint.lintText('', { filePath });
}

/*
 * Lints in-memory text under an existing path, so typed linting finds the file in its program (Pitfall 9).
 *
 * WHY THE GUARDS BELOW EXIST, and why `fatal` alone was not one. ESLint has four ways of answering
 * "I did not lint that", and only one of them sets `fatal`. This function used to check `fatal` only,
 * so the other three arrived as an empty message list and were reported as "every banned construct
 * was permitted" - a probe that never ran reads exactly like a ban that allows everything, which is
 * the one failure this whole file exists to make impossible. Measured against eslint 9.39.2:
 *
 *   ignored path       one message, ruleId null, fatal FALSE, severity 1, "File ignored because of
 *                      a matching ignore pattern"
 *   nothing matches    one message, ruleId null, fatal FALSE, severity 1, "File ignored because no
 *                      matching configuration was supplied"
 *   parse failure      one message, ruleId null, fatal TRUE
 *   no result at all   lintText returns [], so there is no result object to read
 *
 * The first three all carry ruleId null, so that is the guard; the fourth is checked on its own. The
 * last guard is the same argument one step further in: a probe in which not one banned construct was
 * reported has not tested the ban either, so it says so with the computed options attached rather
 * than returning a full `missed` list that reads as a permissive lint.
 */
async function probe(
    file: string,
    header: readonly string[],
    banned: readonly string[],
    allowed: readonly string[],
    matches: MessageMatcher
): Promise<ProbeVerdict> {
    const lines = [...header, ...banned, ...allowed, SENTINEL];
    const filePath = path.join(repoRoot, file);
    await prime(filePath);
    const [result] = await eslint.lintText(lines.join('\n') + '\n', { filePath });
    if (result === undefined) {
        throw new Error(file + ': ESLint returned no result at all, so the probe text was never linted.');
    }
    const messages = result.messages;
    const notLinted = messages.filter((m) => m.ruleId === null);
    if (notLinted.length > 0) {
        throw new Error(
            file + ': ESLint did not lint the probe text - ' + notLinted.map((m) => m.message).join('; ') +
            ' (isPathIgnored=' + String(await eslint.isPathIgnored(filePath)) + ').'
        );
    }
    const required = matches.ruleIds ?? [];
    const configuredRules = (await computedConfig(file)).rules ?? {};
    // Only meaningful where `quotes` is on; it is, for every extension probed here, but a probe of some
    // future file type must fail as "the sentinel cannot speak here" rather than as a silent pass.
    if (severityOf(configuredRules[SENTINEL_RULE]) === 0) {
        throw new Error(
            file + ': ' + SENTINEL_RULE + ' is not enabled for this path, so the probe cannot confirm that ' +
            'ESLint linted the text it was given. Give probe() a sentinel this path would report.'
        );
    }
    if (!messages.some((m) => m.ruleId === SENTINEL_RULE && m.line === lines.length)) {
        throw new Error(
            file + ': the probe sentinel on line ' + String(lines.length) + ' was not reported, so ESLint did ' +
            'not lint the text this probe supplied - the result describes other source, almost certainly the ' +
            'file on disk at this path, whose bans would all read as permitted. ' +
            await probeDiagnosis(file, messages, required)
        );
    }
    if (required.length > 0) {
        const configured = configuredRules;
        if (required.every((rule) => severityOf(configured[rule]) === 0)) {
            throw new Error(
                file + ': none of ' + required.join(', ') + ' is enabled in the computed configuration for ' +
                'this path, so every banned line would read as permitted. ' +
                await probeDiagnosis(file, messages, required)
            );
        }
    }
    const hit = new Set(messages.filter(matches).map((m) => m.line));
    if (banned.length > 0 && hit.size === 0) {
        throw new Error(
            file + ': not one of the ' + String(banned.length) + ' banned constructs was reported, so this ' +
            'probe tested nothing rather than finding a permissive lint. ' +
            await probeDiagnosis(file, messages, required)
        );
    }
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
             * ESLint 9 implements isPathIgnored as calculateConfigForFile(...) === undefined. A file no block
             * matches and a file an ignore pattern removes are the same answer, and both have to be justified.
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
    it('has no expiring exclusion left', () => {
        expect(
            EXPIRING_EXCLUSIONS.map((ex) => ex.dir),
            'The expiring-exclusion list is empty since SPA-14 deleted legacy/. A new entry is a ' +
            'directory of repository code that lint does not read, and needs arguing for here.'
        ).toEqual([]);
    });

    /*
     * The tripwire. When Phase 8 deletes the legacy tree this goes red, and that is the point: it forces the ignore
     * entry out of eslint.config.js in the same change, instead of leaving it behind as a rule about nothing.
     */
    it('names a directory that still exists', () => {
        expect(EXPIRING_EXCLUSIONS.length, 'nothing to check: the list is empty, which is the expected state since SPA-14').toBe(0);
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
     * The list here and the ignore entry in the config are one decision recorded twice; this holds them together.
     * The probe is a hypothetical .js file, because .js is an extension the config does match - so the only way it
     * can come back ignored is the ignore entry itself.
     */
    it('is actually ignored by eslint.config.js', async () => {
        expect(EXPIRING_EXCLUSIONS.length, 'nothing to check: the list is empty, which is the expected state since SPA-14').toBe(0);
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
     * Per-file coverage alone could pass with the custody rules present but emptied - an option list that bans
     * nothing still resolves at error. So the representative files are checked for what the rules actually ban.
     */
    const REPRESENTATIVE = ['src/main/index.ts', 'src/renderer/src/app/App.tsx', 'tools/baseline/archive-real-db.mjs', 'eslint.config.js'];

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
     * src/shared has no files yet. Asking about a hypothetical path in it is how the rule is shown to be waiting
     * for the first one, rather than discovered missing after it lands.
     */
    it.each(['src/lib/db/client.ts', 'src/shared/probe.ts'])('bans importing electron in %s', async (file) => {
        const entry = await ruleEntry(file, 'no-restricted-imports');
        expect(severityOf(entry), 'no-restricted-imports is not at error for ' + file).toBe(ERROR);
        expect(JSON.stringify(entry), 'no-restricted-imports does not name electron for ' + file).toContain('"name":"electron"');
    });

    /*
     * ARCH-01's fourth clause. This used to assert the opposite - that src/main was free to import electron - which
     * was true of the shell but left the clause enforced by nobody: the phase-5 verifier found three modules outside
     * the named list importing electron and nothing that would fail when a fourth did. It is an allowlist now.
     */
    it.each([
        'src/main/index.ts', 'src/main/window.ts', 'src/main/lifecycle.ts', 'src/main/tray.ts',
        'src/main/ipc/register.ts', 'src/main/adapters/electron-notifier.adapter.ts'
    ])('leaves electron legal in %s, where the shell is supposed to name it', async (file) => {
        const entry = JSON.stringify(await ruleEntry(file, 'no-restricted-imports') ?? null);
        expect(entry, 'no-restricted-imports names electron for ' + file).not.toContain('"name":"electron"');
    });

    it.each(['src/main/container.ts', 'src/main/notifications.ts', 'src/main/database-startup.ts'])(
        'bans electron in %s, which must take a port instead', async (file) => {
            const entry = await ruleEntry(file, 'no-restricted-imports');
            expect(severityOf(entry), 'no-restricted-imports is not at error for ' + file).toBe(ERROR);
            expect(JSON.stringify(entry), 'no-restricted-imports does not name electron for ' + file)
                .toContain('"name":"electron"');
        });

    // The weaker src/main allowlist must not become the last match for services, whose own block bans more.
    it('keeps the service block stricter than the src/main allowlist', async () => {
        const entry = JSON.stringify(await ruleEntry('src/main/services/stats.service.ts', 'no-restricted-imports'));
        expect(entry, 'the src/main electron allowlist replaced the service layer rule').toContain('"name":"better-sqlite3"');
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
            'src/renderer/src/app/App.tsx', [], banned, allowed,
            byRule('@typescript-eslint/no-restricted-imports', '@typescript-eslint/no-import-type-side-effects')
        );
        expect(missed, 'value imports that would ship zod to the renderer').toEqual([]);
        expect(flagged, 'type-only imports the renderer was refused').toEqual([]);
    }, 60_000);

    describe('D-08: drizzle tooling is banned everywhere under src/', () => {
        const banned = [
            'import { defineConfig } from \'drizzle-kit\';',
            'import { migrate } from \'drizzle-orm/better-sqlite3/migrator\';',
            'import { migrate as migrateCore } from \'drizzle-orm/migrator\';',
            'import * as kitApi from \'drizzle-kit/api\';'
        ];
        const allowed = ['import { sqliteTable } from \'drizzle-orm/sqlite-core\';'];

        it.each(['src/main/index.ts', 'src/lib/db/client.ts'])('refuses drizzle-kit and the migrators, and allows sqlite-core, in %s', async (file) => {
            const { missed, flagged } = await probe(file, [], banned, allowed, byRule('no-restricted-imports'));
            expect(missed, 'drizzle tooling imports the lint let through in ' + file).toEqual([]);
            expect(flagged, 'the D-08 ban refused drizzle-orm/sqlite-core in ' + file).toEqual([]);
        }, 60_000);

        // Flat config replaces a rule's options wholesale, so each block that sets either rule must restate the ban.
        it.each([
            { file: SHARED_PROBE_FILE, rule: 'no-restricted-imports' },
            { file: SHARED_PROBE_FILE, rule: '@typescript-eslint/no-restricted-imports' },
            { file: 'src/renderer/src/app/App.tsx', rule: 'no-restricted-imports' },
            { file: 'src/renderer/src/app/App.tsx', rule: '@typescript-eslint/no-restricted-imports' }
        ])('refuses drizzle-kit and the migrators in $file through $rule', async ({ file, rule }) => {
            const { missed } = await probe(file, [], banned, [], byRule(rule));
            expect(missed, 'drizzle tooling imports ' + rule + ' let through in ' + file).toEqual([]);
        }, 60_000);
    });
});

/*
 * ARCH-01, criteria 3 and 11. A layering that is not linted is a comment, and the failure it prevents is one this
 * project has already had: a rule everybody agrees with, that nothing checks, until a service imports electron and
 * its unit tests need an Electron binary to run. Each direction is probed as code the linter judges.
 */
describe('ARCH-01: lint proves the direction of the main process', () => {
    const SERVICE_FILE = 'src/main/services/stats.service.ts';
    const HANDLER_FILE = 'src/main/ipc/handlers.ts';
    const ADAPTER_FILE = 'src/main/adapters/electron-notifier.adapter.ts';
    const CONTAINER_FILE = 'src/main/container.ts';
    const DB_FILE = 'src/lib/db/handle.ts';

    /*
     * WR-05. This probe used to list an `import type` under `allowed` and assert it was not flagged. That read as
     * coverage of the @lib/db boundary and proved nothing - the *value* import was not flagged either, and neither
     * were better-sqlite3, ../../lib/db, ../adapters, ../window or ../container. Every one is a banned probe now,
     * so deleting a line from SERVICE_LAYER_PATTERNS fails this test.
     */
    it('refuses electron, ipc/, the database and the composition root in a service', async () => {
        const banned = [
            'import { app } from \'electron\';',
            'import { Notification } from \'electron/main\';',
            'import { registerIpcHandlers } from \'../ipc\';',
            'import { registerIpcHandlers as fromAlias } from \'@main/ipc\';',
            'import { handler } from \'../../main/ipc/session.ipc\';',
            'import Database from \'better-sqlite3\';',
            'import { createSessionsRepository } from \'@lib/db\';',
            'import type { SessionsRepository } from \'@lib/db\';',
            'import { createSessionsRepository } from \'../../lib/db\';',
            'import { createElectronPorts } from \'../adapters\';',
            'import { mainWindows } from \'../window\';',
            'import { createTray } from \'../tray\';',
            'import { activeContainer } from \'../container\';',
            'import { closeDatabaseNow } from \'../lifecycle\';',
            'import { appConfig } from \'../config\';',
            'import { createDbHandle } from \'../../lib/db/handle\';'
        ];
        // The two neighbours a service may name, plus the shared vocabulary every layer shares.
        const allowed = [
            'import type { ClockPort } from \'../ports\';',
            'import { localDayOf } from \'../ports\';',
            'import type { WorkSession } from \'@shared/types\';',
            'import { TICK_MS } from \'./timer.service\';'
        ];
        const { missed, flagged } = await probe(SERVICE_FILE, [], banned, allowed, byRule('no-restricted-imports'));
        expect(missed, 'imports a service was allowed to make').toEqual([]);
        expect(flagged, 'the service ban refused a port, a sibling service or a domain type').toEqual([]);
    }, 60_000);

    it('still lets the adapters import electron, which is the whole reason they exist', async () => {
        const { flagged } = await probe(
            ADAPTER_FILE, [], [],
            ['import { Notification } from \'electron\';', 'import { BrowserWindow } from \'electron\';'],
            byRule('no-restricted-imports')
        );
        expect(flagged, 'ARCH-01 puts Electron behind adapters; an adapter that cannot import it has nowhere to go')
            .toEqual([]);
    }, 60_000);

    it('refuses the database and the adapters in a handler, and lets electron and the services through', async () => {
        const banned = [
            "import { createSessionsRepository } from '../../lib/db';",
            "import { readTimerState } from '@lib/db/app-state';",
            "import Database from 'better-sqlite3';",
            "import { createElectronPorts } from '../adapters';"
        ];
        // ipcMain is how a handler is reached at all, and the services are what a handler is for.
        const allowed = [
            "import { ipcMain } from 'electron';",
            "import { createTimerService } from '../services/timer.service';",
            "import { ipcContract } from '@shared/ipc/contract';"
        ];
        const { missed, flagged } = await probe(HANDLER_FILE, [], banned, allowed, byRule('no-restricted-imports'));
        expect(missed, 'ARCH-01: a handler was allowed to reach past the services').toEqual([]);
        expect(flagged, 'a handler was refused electron, a service or the contract').toEqual([]);
    }, 60_000);

    it('refuses a drizzle value import outside src/lib/db and allows a type import', async () => {
        const banned = [
            'import { eq } from \'drizzle-orm\';',
            'import { drizzle } from \'drizzle-orm/better-sqlite3\';',
            'import { sqliteTable } from \'drizzle-orm/sqlite-core\';'
        ];
        const allowed = ['import type { SQL } from \'drizzle-orm\';'];
        for (const file of [SERVICE_FILE, CONTAINER_FILE, 'src/main/index.ts']) {
            const { missed, flagged } = await probe(file, [], banned, allowed,
                byRule('@typescript-eslint/no-restricted-imports'));
            expect(missed, 'drizzle value imports lint let through in ' + file).toEqual([]);
            expect(flagged, 'a drizzle type import was refused in ' + file).toEqual([]);
        }
    }, 60_000);

    it('lets src/lib/db import drizzle as a value, and still refuses the authoring tooling there', async () => {
        const { flagged } = await probe(DB_FILE, [], [], [
            'import { eq } from \'drizzle-orm\';',
            'import { drizzle } from \'drizzle-orm/better-sqlite3\';'
        ], byRule('@typescript-eslint/no-restricted-imports'));
        expect(flagged, 'the one home of SQL was refused the query builder it is built on').toEqual([]);

        const { missed } = await probe(DB_FILE, [], [
            'import { defineConfig } from \'drizzle-kit\';',
            'import { migrate } from \'drizzle-orm/better-sqlite3/migrator\';'
        ], [], byRule('@typescript-eslint/no-restricted-imports'));
        expect(missed, 'D-08 lapsed in src/lib/db when the value ban was lifted there').toEqual([]);
    }, 60_000);

    it('refuses SQL in a service and allows it in its one home', async () => {
        const header = [
            'declare const db: { prepare(s: string): unknown; exec(s: string): void; pragma(s: string): unknown };',
            'declare const sql: (parts: TemplateStringsArray) => unknown;',
            'declare const pattern: RegExp;',
            'declare const value: string;'
        ];
        const banned = [
            'void db.prepare(\'SELECT 1\');',
            'void db.pragma(\'user_version\');',
            'db.exec(\'CREATE TABLE t (a TEXT)\');',
            'db.exec(`CREATE TABLE t (a TEXT)`);',
            'void sql`SELECT 1`;'
        ];
        // The shape src/shared/utils/date.ts uses; a regex exec on a variable must stay legal everywhere.
        const allowed = ['void pattern.exec(value);'];
        const isSql = (m: Linter.LintMessage): boolean => m.message === SQL_MESSAGE;

        const service = await probe(SERVICE_FILE, header, banned, allowed, isSql);
        expect(service.missed, 'SQL shapes lint let through in a service').toEqual([]);
        expect(service.flagged, 'a regex exec was mistaken for SQL in a service').toEqual([]);

        for (const file of ['src/lib/db/client.ts', ...Object.keys(SQL_EXEMPTIONS)]) {
            const { flagged } = await probe(file, header, [], banned, isSql);
            expect(flagged, 'SQL was refused in ' + file + ', which is exempt').toEqual([]);
        }
    }, 60_000);

    it('resolves the SQL bans on every linted source file except src/lib/db and the inventoried exemptions', async () => {
        const offenders: string[] = [];
        let checked = 0;
        for (const file of repositoryFiles().filter((f) => SOURCE_EXTENSIONS.includes(extensionOf(f)))) {
            if (!isUnder(file, 'src') || await eslint.isPathIgnored(path.join(repoRoot, file))) continue;
            checked++;
            const banned = JSON.stringify(await ruleEntry(file, 'no-restricted-syntax')).includes(SQL_MESSAGE);
            if (isSqlExempt(file) && banned) offenders.push(file + ' - exempt, yet the SQL bans still apply');
            if (!isSqlExempt(file) && !banned) offenders.push(file + ' - not exempt, yet the SQL bans do not apply');
        }
        expect(checked, 'no source file under src was checked').toBeGreaterThan(0);
        expect(offenders, 'eslint.config.js and SQL_EXEMPTIONS disagree:\n  ' + offenders.join('\n  ')).toEqual([]);
    }, 60_000);

    // An exemption that no longer has anything to be exempt for is a rule about nothing the next file inherits.
    it.each(Object.entries(SQL_EXEMPTIONS))('%s still holds the SQL its exemption is for', (file, ex) => {
        const source = fs.readFileSync(path.join(repoRoot, file), 'utf8');
        expect(
            /\.(prepare|exec|pragma)\(/.test(source),
            file + ' no longer writes SQL (' + ex.why + '), so remove it from SQL_BOOTSTRAP_EXEMPT in ' +
            'eslint.config.js and from SQL_EXEMPTIONS here, in this same change.'
        ).toBe(true);
    });
});

/*
 * Criterion 3's lint half (SPA-11, SPA-13), probed as code rather than read off the config.
 *
 * Both rules are here because this repository has already been bitten twice by a rule that existed only as a
 * comment, and these two guard failures invisible at every other gate: a concatenated class name typechecks,
 * renders, and is simply the wrong colour (C3); a querySelector written against utility classes typechecks,
 * renders, and silently stops finding the delete-all-data button the day someone changes its margin (Y2,
 * legacy/pages/settings.html:659).
 */
describe('SPA-11 / SPA-13: lint refuses a built class name and a query written against one', () => {
    const RENDERER_PROBE_FILE = 'src/renderer/src/components/ui/AlertDialog.tsx';
    const CLASS_BUILD_TAG = '(SPA-11, C3).';
    const CLASS_QUERY_TAG = '(SPA-13, Y2).';
    const HTML_INJECTION_TAG = '(S2).';

    const header = [
        'declare const tone: string;',
        'declare const on: boolean;',
        'declare const el: HTMLElement;',
        'declare const CIRCLE: Record<string, string>;',
        'declare const A: string;',
        'declare const B: string;',
        'declare const chosen: string;',
        'declare const id: number;',
        'declare const parts: string[];'
    ];

    const endsWith = (tag: string) => (m: Linter.LintMessage): boolean =>
        m.ruleId === 'no-restricted-syntax' && m.message.endsWith(tag);

    it('refuses a class name assembled at run time, in every spelling v1.2.1 used', async () => {
        const banned = [
            'export const p1 = <div className={`bg-${tone}-100`} />;',
            'export const p2 = <div className={\'bg-\' + tone + \'-100\'} />;',
            // Hidden one level down, which is where a conditional class usually is.
            'export const p3 = <div className={on ? `x-${tone}` : A} />;',
            'export const p4 = <span class={`y-${tone}`} />;',
            'el.className = \'bg-\' + tone;',
            'el.className = `bg-${tone}`;',
            'el.classList.add(`bg-${tone}-100`);',
            'el.classList.toggle(\'bg-\' + tone);',
            /*
             * CR-02: the five spellings the reviewer got past the rule, plus their siblings. The last pair matters
             * most - hoisting the concatenation to a local and passing the variable is the most natural refactor of
             * a banned line, and it was not merely unbanned, it was what the rule taught.
             */
            'export const a1 = <div className={[\'bg-\', tone, \'-100\'].join(\'\')} />;',
            'export const a2 = <div className={\'bg-\'.concat(tone)} />;',
            'export const a3 = <div className={parts.join(\' \')} />;',
            'el.setAttribute(\'class\', \'bg-\' + tone);',
            'el.setAttribute(\'class\', chosen);',
            'el.className = [\'a\', tone].join(\' \');',
            'el.classList.add(...[\'bg-\' + tone]);',
            'el.classList.add(...parts);',
            'const cls1 = \'bg-\' + tone;',
            'const cls2 = `text-${tone}-500`;',
            'const cls3 = [\'rounded-full bg-\', tone].join(\'\');',
            'export const a4 = <div {...{ className: \'bg-\' + tone }} />;',
            'export const a5 = <div className={\'hover:\' + tone} />;'
        ];
        // The sanctioned shapes: a literal, a typed lookup, and a choice between two whole class strings.
        const allowed = [
            'export const q1 = <div className="bg-blue-100" />;',
            'export const q2 = <div className={CIRCLE[tone]} />;',
            'export const q3 = <div className={on ? A : B} />;',
            'el.classList.add(\'bg-blue-100\');',
            // An id built from a value is how AlertDialog labels its own dialog, and how an element is reached.
            'const titleId = \'dialog-title-\' + String(id);',
            'const label = \'Workflow has counted \' + String(id) + \' seconds\';',
            'el.setAttribute(\'aria-label\', \'Close \' + String(id));'
        ];
        const { missed, flagged } = await probe(
            RENDERER_PROBE_FILE, header, banned, allowed, endsWith(CLASS_BUILD_TAG)
        );
        expect(missed, 'lint let a class name be built from parts').toEqual([]);
        expect(flagged, 'lint refused a class name that is written out in full').toEqual([]);
    }, 60_000);

    it('refuses a DOM query written against classes, and leaves ids and attributes alone', async () => {
        const banned = [
            'document.querySelector(\'.mt-8.mb-8 button\');',
            'document.querySelectorAll(\'.flex\');',
            'el.closest(\'.card-dark\');',
            'el.matches(\'.active\');',
            // Unknowable at lint time, so refused outright.
            'document.querySelector(`.${chosen}`);',
            'document.getElementsByClassName(\'flex\');',
            /*
             * WR-01: the same selector hoisted to a constant, which is what a reviewer asks for when the string is
             * long - and line one below is legacy/pages/settings.html:659, the delete-all-data button.
             */
            'document.querySelector(chosen);',
            'el.closest(chosen);',
            'el.querySelector(\'.mt-8\' + \' button\');',
            'document.querySelectorAll(\'[class~="mt-8"]\');',
            'el.matches(\'[class*="flex"]\');'
        ];
        const allowed = [
            'document.querySelector(\'#root\');',
            'document.querySelector(\'[data-testid="save"]\');',
            'el.closest(\'button\');',
            'document.getElementById(\'root\');'
        ];
        const { missed, flagged } = await probe(
            RENDERER_PROBE_FILE, header, banned, allowed, endsWith(CLASS_QUERY_TAG)
        );
        expect(missed, 'lint let an element be selected by its utility classes').toEqual([]);
        expect(flagged, 'lint refused a query that names an id or an attribute').toEqual([]);
    }, 60_000);

    /*
     * WR-04. Criterion 8 asks for a test that fails on "a second .css file under src/renderer, on a CSS module, or
     * on a per-component class rule". The third clause was enforced only for rules written INSIDE globals.css, and
     * a stylesheet does not have to be a file: the <style> element below is what legacy/renderer/shared.js:255-285
     * did for the toast transition.
     */
    it('refuses a rule injected at run time and a style set on an element', async () => {
        const banned = [
            'export const s = <style>{\'.toast-row { transition: all .3s; }\'}</style>;',
            'const tag = document.createElement(\'style\');',
            'const sheet = document.createElement(\'link\');',
            'el.style.background = \'red\';',
            'el.style.setProperty(\'color\', \'red\');',
            'el.setAttribute(\'style\', \'color: red\');',
            'el.style.cssText = \'color: red\';',
            'document.styleSheets[0]?.insertRule(\'.x { color: red }\');',
            'void document.adoptedStyleSheets;',
            'const made = new CSSStyleSheet();'
        ];
        // Reading a computed style is not writing one, and a class chosen from a typed map stays legal.
        const allowed = [
            'void getComputedStyle(el).color;',
            'export const t = <div className={CIRCLE[tone]} />;'
        ];
        const isArch05 = (m: Linter.LintMessage): boolean =>
            m.ruleId === 'no-restricted-syntax' && m.message.endsWith('(ARCH-05).');

        const { missed, flagged } = await probe(RENDERER_PROBE_FILE, header, banned, allowed, isArch05);
        expect(missed, 'a stylesheet came back into the renderer by another door').toEqual([]);
        expect(flagged, 'reading a computed style, or picking a whole class string, was refused').toEqual([]);
    }, 60_000);

    /*
     * S2, criterion 1. React escapes a JSX child, and the value of "by construction" is the number of doors left
     * open around the construction. v1.2.1 had four - two onclick= attributes built out of a company name with one
     * character escaped, and two innerHTML interpolations in shared.js that every page copied.
     */
    it('refuses every door back to rendering untrusted text as markup', async () => {
        const banned = [
            'export const d1 = <div dangerouslySetInnerHTML={{ __html: name }} />;',
            'export const d2 = <div {...{ dangerouslySetInnerHTML: { __html: name } }} />;',
            'const props = { dangerouslySetInnerHTML: { __html: name } };',
            'const html = { __html: name };',
            'el.innerHTML = \'<p>\' + name + \'</p>\';',
            'void el.innerHTML;',
            'el[\'innerHTML\'] = name;',
            'el.outerHTML = name;',
            'el.insertAdjacentHTML(\'beforeend\', name);',
            'document.write(name);',
            'document.writeln(name);',
            // legacy/pages/companies.html:141, in JSX clothing.
            'export const d3 = <button onClick="editCompany(1)" />;'
        ];
        // The sanctioned shapes: the name as a child, as an attribute value, and read back as text.
        const allowed = [
            'export const ok1 = <p>{name}</p>;',
            'export const ok2 = <button aria-label={\'Delete \' + name} onClick={() => undefined} />;',
            'export const ok3 = <input value={name} readOnly />;',
            'void el.textContent;',
            'el.textContent = name;'
        ];
        const isHtmlInjection = (m: Linter.LintMessage): boolean =>
            m.ruleId === 'no-restricted-syntax' && m.message.endsWith(HTML_INJECTION_TAG);

        const { missed, flagged } = await probe(
            RENDERER_PROBE_FILE, [...header, 'declare const name: string;'], banned, allowed, isHtmlInjection
        );
        expect(missed, 'lint let untrusted text be rendered as markup').toEqual([]);
        expect(flagged, 'lint refused text handed to React as a child or an attribute value').toEqual([]);
    }, 60_000);

    it('applies all three rules to every renderer source file, not just the one probed', async () => {
        const renderer = repositoryFiles()
            .filter((file) => isUnder(file, 'src/renderer/src') && SOURCE_EXTENSIONS.includes(extensionOf(file)));
        expect(renderer.length, 'no renderer source files, so this scan proves nothing').toBeGreaterThan(5);

        const offenders: string[] = [];
        for (const file of renderer) {
            const entry = JSON.stringify(await ruleEntry(file, 'no-restricted-syntax'));
            for (const tag of [CLASS_BUILD_TAG, CLASS_QUERY_TAG, HTML_INJECTION_TAG]) {
                if (!entry.includes(tag)) offenders.push(file + ' is missing ' + tag);
            }
        }
        expect(offenders, 'the renderer block in eslint.config.js no longer covers these files').toEqual([]);
    }, 60_000);

    // D-11: the renderer block restates every ban it does not lift, so adding these two cannot drop the others.
    it('keeps the bans src/** already carried', async () => {
        const entry = JSON.stringify(await ruleEntry(RENDERER_PROBE_FILE, 'no-restricted-syntax'));
        expect(entry, 'the renderer block dropped CUSTODY-03').toContain(CUSTODY_03_TEXT);
        expect(entry, 'the renderer block dropped the date bans').toContain(DATE_MESSAGE);
        expect(entry, 'the renderer block dropped the SQL bans').toContain(SQL_MESSAGE);
    }, 60_000);
});

/*
 * ARCH-03 / criterion 7: the renderer's direction of flow, probed as code.
 *
 * tests/renderer-structure.test.ts asserts the same directions against the tree, and that is not duplication - it
 * is the difference between "no file does this today" and "a file that does this fails".
 *
 * Every ban below is probed twice over: refused where ARCH-03 refuses it, and allowed in the one area ARCH-03 makes
 * its home. An allowlist checked in only one direction is how a rule ends up applying nowhere.
 */
describe('ARCH-03: lint proves the direction of the renderer', () => {
    const COMPONENT_FILE = 'src/renderer/src/components/ui/Modal.tsx';
    const API_FILE = 'src/renderer/src/features/history/api/useSessions.ts';
    const PROVIDER_FILE = 'src/renderer/src/app/providers/DataSyncProvider.tsx';
    const STORE_FILE = 'src/renderer/src/store/ui.store.ts';
    const FEATURE_STATE_FILE = 'src/renderer/src/features/timer/state/timer.store.ts';
    const FACADE_FILE = 'src/renderer/src/lib/ipc.ts';

    // Two bans the renderer already carried before ARCH-03; a lift must not take them with it (D-11).
    const ZOD_TYPE_ONLY_TEXT = 'zod is value-imported only in src/shared/schemas';
    const DRIZZLE_TOOLING_TEXT = 'drizzle-kit and the drizzle migrators are authoring tooling';

    const FACADE_TAG = 'lib/ipc.ts and called from features/<domain>/api or app/providers';
    const QUERY_TAG = 'Server state lives in a features/<domain>/api hook';
    const STORE_TAG = 'A Zustand store is either global UI state';
    const FEATURE_TAG = 'Import a feature through its index.ts';
    const STORAGE_TAG = 'Anything durable is a row in the database (ARCH-03).';
    const BRIDGE_TAG = 'Reach the preload bridge through invoke() or subscribe()';

    const says = (fragment: string) => (m: Linter.LintMessage): boolean => m.message.includes(fragment);

    const FACADE_IMPORTS = [
        'import { invoke } from \'@renderer/lib/ipc\';',
        'import { subscribe } from \'../../lib/ipc\';',
        'import { API_BRIDGE_KEY } from \'@shared/constants/bridge\';'
    ];
    const QUERY_IMPORTS = [
        'import { useQuery } from \'@tanstack/react-query\';',
        'import { QueryClient } from \'@tanstack/react-query/build/modern/queryClient\';'
    ];
    const STORE_IMPORTS = ['import { create } from \'zustand\';'];
    const DEEP_FEATURE_IMPORTS = [
        'import { useSessions } from \'@renderer/features/history/api/useSessions\';',
        'import { useTimerStore } from \'../../features/timer/state/timer.store\';'
    ];
    const PUBLIC_IMPORTS = [
        'import { useSessions } from \'@renderer/features/history\';',
        'import { routes } from \'@renderer/lib/routes\';'
    ];

    it('refuses the IPC facade outside features/<domain>/api and app/providers', async () => {
        const { missed } = await probe(COMPONENT_FILE, [], FACADE_IMPORTS, [], says(FACADE_TAG));
        expect(missed, 'a component reached the bridge without going through a hook').toEqual([]);

        for (const file of [API_FILE, PROVIDER_FILE]) {
            // The bridge key stays refused even here: only the facade itself may name it.
            const { flagged } = await probe(file, [], [], FACADE_IMPORTS.slice(0, 2), says(FACADE_TAG));
            expect(flagged, file + ' may call the facade and was refused').toEqual([]);
        }

        const facade = await probe(FACADE_FILE, [], [], [FACADE_IMPORTS[2] ?? ''], says(FACADE_TAG));
        expect(facade.flagged, FACADE_FILE + ' is the facade; it is the one file that may name the bridge key')
            .toEqual([]);
    }, 60_000);

    it('refuses web storage anywhere in the renderer', async () => {
        const banned = [
            'void localStorage.getItem(\'timer\');',
            'void sessionStorage;',
            'void window.localStorage;',
            'void globalThis.sessionStorage;',
            'void self.localStorage;',
            // CR-03(c): a web store reached off an object neither the globals nor the properties rule names.
            'void document.defaultView?.localStorage;',
            'void document.defaultView?.[\'sessionStorage\'];',
            'void Reflect.get(globalThis, \'localStorage\');'
        ];
        const { missed } = await probe(COMPONENT_FILE, [], banned, [], says(STORAGE_TAG));
        expect(missed, 'renderer code reached a web store, which main cannot read').toEqual([]);
    }, 60_000);

    it('refuses naming the bridge on the global object', async () => {
        const banned = [
            'void window.api;', 'void globalThis[\'api\'];', 'void self.api;',
            // CR-03(c): Reflect.get is a member expression no member-expression selector can see.
            'void Reflect.get(globalThis, \'api\');',
            /*
             * The Phase 7 verifier's evasion: a cast puts a TSAsExpression between the member expression and the
             * identifier, so object.name is undefined and every selector written against it sees nothing.
             */
            'void (globalThis as unknown as { api: unknown }).api;',
            'void (globalThis as { api: unknown }).api;',
            'void (globalThis as unknown as Record<string, unknown>)[\'api\'];',
            'void globalThis!.api;'
        ];
        const allowed = ['void (globalThis as unknown as { other: number }).other;'];
        const { missed, flagged } = await probe(COMPONENT_FILE, [], banned, allowed, says(BRIDGE_TAG));
        expect(missed, 'a file reached window.api directly instead of through the facade').toEqual([]);
        expect(flagged, 'the cast ban is so wide it refuses a cast that has nothing to do with the bridge')
            .toEqual([]);
    }, 60_000);

    /*
     * CR-03(a). no-restricted-imports inspects ImportDeclaration and the two export-from forms and nothing else, so
     * every one of the four bans above - including the cross-feature one the config marks "never lifted" - was one
     * await away from being unenforced. The syntactic rule reaches where the import rule cannot, composed from the
     * same lift set.
     */
    it('refuses the same four things asked for with a dynamic import', async () => {
        const banned: [string, string][] = [
            ['const m = await import(\'@renderer/lib/ipc\');', FACADE_TAG],
            ['const n = await import(\'../../lib/ipc\');', FACADE_TAG],
            ['const b = await import(\'@shared/constants/bridge\');', FACADE_TAG],
            ['const q = await import(\'@tanstack/react-query\');', QUERY_TAG],
            ['const z = await import(\'zustand\');', STORE_TAG],
            ['const t = await import(\'@renderer/features/timer/state/timer.store\');', FEATURE_TAG],
            ['const u = await import(\'../../features/timer/state/timer.store\');', FEATURE_TAG]
        ];
        for (const [code, tag] of banned) {
            const { missed } = await probe(
                COMPONENT_FILE, [], ['export async function f() { ' + code + ' return m; }'], [], says(tag)
            );
            expect(missed, 'a dynamic import walked past the ARCH-03 ban on ' + tag).toEqual([]);
        }

        // The public surface stays reachable dynamically, and each lifted area keeps its own lift.
        const surface = await probe(
            COMPONENT_FILE, [], [],
            ['export async function g() { return import(\'@renderer/features/history\'); }'], says(FEATURE_TAG)
        );
        expect(surface.flagged, 'a dynamic import of a feature index was refused').toEqual([]);

        for (const file of [API_FILE, PROVIDER_FILE]) {
            const lifted = await probe(
                file, [], [], ['export async function h() { return import(\'@renderer/lib/ipc\'); }'], says(FACADE_TAG)
            );
            expect(lifted.flagged, file + ' may call the facade and was refused a dynamic import of it').toEqual([]);
        }
        for (const file of [STORE_FILE, FEATURE_STATE_FILE]) {
            const lifted = await probe(
                file, [], [], ['export async function h() { return import(\'zustand\'); }'], says(STORE_TAG)
            );
            expect(lifted.flagged, file + ' is a home for state and was refused a dynamic import of zustand')
                .toEqual([]);
        }
    }, 60_000);

    it('refuses reaching past a feature index.ts, from every area including the ones with lifts', async () => {
        for (const file of [COMPONENT_FILE, API_FILE, PROVIDER_FILE, STORE_FILE, FACADE_FILE]) {
            const { missed, flagged } = await probe(file, [], DEEP_FEATURE_IMPORTS, PUBLIC_IMPORTS, says(FEATURE_TAG));
            expect(missed, file + ' reached inside another feature').toEqual([]);
            expect(flagged, file + ': importing a feature index was refused').toEqual([]);
        }
    }, 60_000);

    it('keeps server state in api/ and app/providers, and out of everything else', async () => {
        for (const file of [COMPONENT_FILE, STORE_FILE, FEATURE_STATE_FILE]) {
            const { missed } = await probe(file, [], QUERY_IMPORTS, [], says(QUERY_TAG));
            expect(missed, file + ' holds server state').toEqual([]);
        }
        // A type import is not a subscription; a page may still name UseQueryResult.
        const { flagged } = await probe(
            COMPONENT_FILE, [], [], ['import type { UseQueryResult } from \'@tanstack/react-query\';'], says(QUERY_TAG)
        );
        expect(flagged, 'a type-only import of the query types was refused').toEqual([]);

        for (const file of [API_FILE, PROVIDER_FILE, ...['src/renderer/src/lib/query-client.ts',
            'src/renderer/src/lib/data-sync.ts']]) {
            const allowed = await probe(file, [], [], [QUERY_IMPORTS[0] ?? ''], says(QUERY_TAG));
            expect(allowed.flagged, file + ' may hold a query and was refused').toEqual([]);
        }
    }, 60_000);

    it('keeps a Zustand store in store/ or in a feature state/ folder', async () => {
        for (const file of [COMPONENT_FILE, API_FILE, PROVIDER_FILE, FACADE_FILE]) {
            const { missed } = await probe(file, [], STORE_IMPORTS, [], says(STORE_TAG));
            expect(missed, file + ' declares a store outside the two places state may live').toEqual([]);
        }
        for (const file of [STORE_FILE, FEATURE_STATE_FILE]) {
            const { flagged } = await probe(file, [], [], STORE_IMPORTS, says(STORE_TAG));
            expect(flagged, file + ' is a home for state and was refused').toEqual([]);
        }
    }, 60_000);

    it('keeps every ban that is not being lifted, in each area that lifts one', async () => {
        const RULE = '@typescript-eslint/no-restricted-imports';
        const cases: [string, string[]][] = [
            // file, the tags that must still be present after its lift
            [FACADE_FILE, [QUERY_TAG, STORE_TAG, FEATURE_TAG]],
            [API_FILE, [STORE_TAG, FEATURE_TAG]],
            [PROVIDER_FILE, [STORE_TAG, FEATURE_TAG]],
            [STORE_FILE, [FACADE_TAG, QUERY_TAG, FEATURE_TAG]],
            [FEATURE_STATE_FILE, [FACADE_TAG, QUERY_TAG, FEATURE_TAG]],
            [COMPONENT_FILE, [FACADE_TAG, QUERY_TAG, STORE_TAG, FEATURE_TAG]]
        ];
        for (const [file, tags] of cases) {
            const entry = JSON.stringify(await ruleEntry(file, RULE));
            for (const tag of [...tags, ZOD_TYPE_ONLY_TEXT, DRIZZLE_TOOLING_TEXT]) {
                expect(entry.includes(tag), file + ' dropped a ban it does not lift: ' + tag).toBe(true);
            }
        }
    }, 60_000);

    it('applies the ARCH-03 bans to every renderer source file', async () => {
        const renderer = repositoryFiles()
            .filter((file) => isUnder(file, 'src/renderer/src') && SOURCE_EXTENSIONS.includes(extensionOf(file)));
        expect(renderer.length, 'no renderer source files, so this scan proves nothing').toBeGreaterThan(5);

        const offenders: string[] = [];
        for (const file of renderer) {
            const entry = JSON.stringify(await ruleEntry(file, '@typescript-eslint/no-restricted-imports'));
            if (!entry.includes(FEATURE_TAG)) offenders.push(file + ': no cross-feature ban');
            const syntax = JSON.stringify(await ruleEntry(file, 'no-restricted-syntax'));
            if (!syntax.includes(BRIDGE_TAG)) offenders.push(file + ': no bridge-access ban');
            const globals = JSON.stringify(await ruleEntry(file, 'no-restricted-globals'));
            if (!globals.includes(STORAGE_TAG)) offenders.push(file + ': no web-storage ban');
        }
        expect(offenders, 'these renderer files are outside the ARCH-03 blocks in eslint.config.js').toEqual([]);
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
