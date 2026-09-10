/*
 * tests/tsconfig-strict.test.ts
 *
 * The standing proof for BUILD-02: strict mode, with noImplicitAny, is on in BOTH split tsconfigs,
 * and `npm run typecheck` checks both.
 *
 * Why this matters more than a style preference. TypeScript is this restructure's load-bearing
 * decision: most of the defects the audit found in v1.2.1 - an undefined identifier, a call to an
 * API that does not exist - are exactly what a strict compiler rejects. With strict off, or with
 * noImplicitAny off, those defects compile clean again and nothing at all reports it: no error,
 * no warning, just a gate that has quietly stopped gating. The usual way that happens is a preset:
 * @electron-toolkit/tsconfig's base sets noImplicitAny to false, which silently defeats strict for
 * every project that extends it. So both flags are stated explicitly, and redundantly, in both
 * files, and this test is what keeps them there.
 *
 * WHY THIS TEST PARSES AND DOES NOT GREP. tsconfig.node.json and tsconfig.web.json are pure JSON
 * by contract - no comments - precisely so that this file can JSON.parse them. A textual search for
 * the flag names would be satisfied by a comment that merely mentions them (a textual gate in this
 * repository has already matched prose once, in plan 01-08), and it could not tell `true` from
 * `"true"`. Parsing reads the value the compiler reads. The price is that the JSON files cannot
 * carry their own explanation, so it lives here: if someone adds a comment to either file, this
 * test fails, loudly, on the parse, and that is intended.
 *
 * Each assertion was turned red by a deliberate mutation of one of the two configs or of
 * package.json before this file was committed, and the file restored byte-identically (plan
 * 02-02's SUMMARY records the hashes).
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const NODE_CONFIG = 'tsconfig.node.json';
const WEB_CONFIG = 'tsconfig.web.json';
const SPLIT_CONFIGS = [NODE_CONFIG, WEB_CONFIG];

/*
 * The individual flags `strict` switches on. An explicit `false` for any one of them overrides
 * strict for that check alone - the same trap as the preset's noImplicitAny, one flag over.
 */
const STRICT_FAMILY = [
    'noImplicitAny', 'noImplicitThis', 'strictNullChecks', 'strictFunctionTypes',
    'strictBindCallApply', 'strictPropertyInitialization', 'strictBuiltinIteratorReturn',
    'useUnknownInCatchVariables', 'alwaysStrict'
];

interface TsConfig {
    extends?: unknown;
    compilerOptions?: Record<string, unknown>;
    include?: unknown;
}

function parseConfig(rel: string): TsConfig {
    const text = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    try {
        return JSON.parse(text) as TsConfig;
    } catch (error) {
        throw new Error(
            rel + ' is not pure JSON (' + (error instanceof Error ? error.message : String(error)) +
            '). It must stay comment-free: tests/tsconfig-strict.test.ts parses it so that no ' +
            'comment mentioning a flag can stand in for the flag itself (BUILD-02). Put the ' +
            'explanation in that test file instead.'
        );
    }
}

const optionsOf = (rel: string): Record<string, unknown> => parseConfig(rel).compilerOptions ?? {};

const scripts = (JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')
) as { scripts?: Record<string, string> }).scripts ?? {};

/*
 * A script's command with every `npm run <name>` replaced by that script's own command, split into
 * its `&&`-separated steps. Whitespace splitting only - no pattern matching on the flags.
 */
function expandScript(name: string, seen: string[] = []): string[][] {
    const body = scripts[name];
    if (body === undefined) {
        throw new Error('package.json has no "' + name + '" script');
    }
    if (seen.includes(name)) {
        throw new Error('package.json scripts recurse: ' + [...seen, name].join(' -> '));
    }
    return body.split('&&').flatMap((step) => {
        const words = step.split(' ').filter((word) => word !== '');
        const target = words[2];
        if (words[0] === 'npm' && words[1] === 'run' && target !== undefined) {
            return expandScript(target, [...seen, name]);
        }
        return [words];
    });
}

describe('BUILD-02: strict mode is on in both split tsconfigs, and typecheck checks both', () => {
    it.each(SPLIT_CONFIGS)('%s parses as pure JSON', (rel) => {
        expect(() => parseConfig(rel)).not.toThrow();
    });

    it.each(SPLIT_CONFIGS)('%s sets compilerOptions.strict to the boolean true', (rel) => {
        expect(optionsOf(rel)['strict'], rel + ': compilerOptions.strict must be the boolean true')
            .toBe(true);
    });

    it.each(SPLIT_CONFIGS)('%s sets compilerOptions.noImplicitAny to the boolean true, explicitly', (rel) => {
        expect(
            optionsOf(rel)['noImplicitAny'],
            rel + ': compilerOptions.noImplicitAny must be stated as the boolean true beside strict. ' +
            'Leaving it to strict is how a preset\'s false wins'
        ).toBe(true);
    });

    it.each(SPLIT_CONFIGS)('%s turns off no individual strict check', (rel) => {
        const options = optionsOf(rel);
        const disabled = STRICT_FAMILY.filter((flag) => options[flag] === false);
        expect(disabled, rel + ' switches these strict checks off one by one').toEqual([]);
    });

    it.each(SPLIT_CONFIGS)('%s extends nothing, so the options parsed here are all the options there are', (rel) => {
        // An extended base could set a strict-family flag to false, and a child's own strict
        // does not override an explicit flag inherited that way. This test can only vouch for
        // what it parses.
        expect(
            parseConfig(rel).extends,
            rel + ' extends another config whose options this test cannot see'
        ).toBeUndefined();
    });

    it(NODE_CONFIG + ' includes the test suite, so the tests are type-checked too', () => {
        const include = parseConfig(NODE_CONFIG).include;
        expect(Array.isArray(include), NODE_CONFIG + ' has no include array').toBe(true);
        const patterns = (include as unknown[]).filter((p): p is string => typeof p === 'string');
        expect(
            patterns.includes('tests/**/*') || patterns.includes('tests/**/*.ts'),
            NODE_CONFIG + ' does not include tests/**/*.ts; the suite would run untyped'
        ).toBe(true);
    });

    it(WEB_CONFIG + ' compiles JSX with the automatic runtime', () => {
        expect(optionsOf(WEB_CONFIG)['jsx'], WEB_CONFIG + ': compilerOptions.jsx').toBe('react-jsx');
    });

    it('npm run typecheck runs tsc against both split configs, overriding neither flag', () => {
        const tscSteps = expandScript('typecheck').filter((words) => words[0] === 'tsc');
        const projects = tscSteps.flatMap((words) =>
            words.flatMap((word, i) => (word === '-p' || word === '--project' ? [words[i + 1] ?? ''] : [])));
        expect(
            [...projects].sort(),
            'npm run typecheck must invoke tsc -p ' + NODE_CONFIG + ' and tsc -p ' + WEB_CONFIG
        ).toEqual([...SPLIT_CONFIGS].sort());

        // A command-line flag overrides the config file, so `--strict false` here would switch
        // strict off while both files still say true.
        const overrides = tscSteps.flatMap((words) =>
            words.filter((word) => word === '--strict' || STRICT_FAMILY.includes(word.replace('--', ''))));
        expect(overrides, 'npm run typecheck overrides a strict flag on the command line').toEqual([]);
    });
});
