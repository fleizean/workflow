import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/*
 * Why a JSON assertion is load-bearing here.
 *
 * Electron resolves the userData directory at startup, from package.json, like this:
 *
 *   userData  = DIR_APP_DATA + app.name
 *               (electron v28.3.3, shell/app/electron_main_delegate.cc, ElectronPathProvider)
 *   app.name  = packageJson.productName ?? packageJson.name
 *               (electron v28.3.3, lib/browser/init.ts)
 *
 * On Windows DIR_APP_DATA is %APPDATA%, so today this repository resolves to
 * %APPDATA%\workflow-timer\krono.db — the file holding every existing user's tracked time.
 *
 * Renaming `name` does not throw, does not warn, and does not fail a build. The app simply
 * launches against a different, empty directory and looks brand new. There is no server and no
 * telemetry, so a release that does this cannot be recalled from anyone already running it.
 *
 * The GitHub repository was renamed to fleizean/workflow, which makes "fixing" `name` to match
 * feel like tidying up. It is not. That is the single edit this file exists to stop (CUSTODY-02).
 *
 * Phase 2 (plan 02-01, D-10/D-11) moved two things this file guards, and every assertion moved
 * with them in the same commit - a follow-up commit would have left a window in which the guard
 * reported green while protecting nothing:
 *
 *   - The electron-builder configuration left package.json for electron-builder.yml. The two
 *     builder assertions below read that file, as text, and a third asserts package.json carries
 *     no inline builder block, so the configuration cannot silently move back.
 *   - The main process moved to src/main/**. The setName/setPath scan was a hard-coded list of the
 *     three v1.2.1 files; it is now every source file git knows about, with one annotated
 *     allowlist entry for the development userData module.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')
) as Record<string, unknown>;

const readSource = (rel: string): string => {
    const p = path.join(repoRoot, rel);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
};

const EXPECTED_NAME = 'workflow-timer';

const BUILDER_CONFIG = 'electron-builder.yml';
const builderConfig = readSource(BUILDER_CONFIG);

/*
 * Every other file name electron-builder would read its configuration from. If one of these
 * appeared beside electron-builder.yml, the assertions over the YAML would be checking a file the
 * build might not be using.
 */
const ALTERNATE_BUILDER_CONFIGS = [
    'electron-builder.yaml', 'electron-builder.json', 'electron-builder.json5',
    'electron-builder.toml', 'electron-builder.js', 'electron-builder.cjs',
    'electron-builder.mjs', 'electron-builder.ts'
];

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.cjs', '.mjs'];

/*
 * The whole source tree, as git sees it: tracked files AND files not yet committed, minus
 * everything .gitignore excludes.
 *
 * git, not a filesystem walk, for the reason tests/custody-hygiene.test.ts gives: the standard
 * exclusions keep out/, dist/, node_modules and the gitignored planning directories out for free.
 * execFileSync with an argument array: no shell, no quoting surface.
 *
 * --cached --others, NOT a tracked-only listing. This test runs before the commit that adds a
 * file exists - that is when it matters. A tracked-only listing cannot see src/main/** at that
 * moment, so it would scan nothing new and report green while covering none of the tree it was
 * just widened to protect: the same "green while protecting nothing" failure the Phase 1 handoff
 * names for this exact assertion, one step earlier.
 */
const sourceFiles = (): string[] =>
    execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
        cwd: repoRoot,
        encoding: 'utf8'
    })
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .filter((file) => SOURCE_EXTENSIONS.some((ext) => file.endsWith(ext)));

/*
 * Files allowed to relocate userData, each with its justification. Exactly one entry, and the
 * test below keeps it that way: a single narrow annotated path, never a loosened pattern.
 */
const SET_PATH_ALLOWLIST: Record<string, string> = {
    'src/main/userdata-path.ts':
        'D-07/D-08: moves a DEVELOPMENT build to <appData>/<name>-dev so npm run dev can never ' +
        'open a real krono.db. It throws when app.isPackaged is true (D-09), so no installed ' +
        'build executes the call, and it carries the matching inline ESLint exemption.'
};

const SET_NAME_CALL = /\bapp\s*\.\s*setName\s*\(/;
const SET_PATH_CALL = /\bapp\s*\.\s*setPath\s*\(/;
const SET_PATH_CALLS = /\bapp\s*\.\s*setPath\s*\(/g;

describe('CUSTODY-02: the userData path cannot silently move', () => {
    it('package.json has a name that is present, non-empty and not whitespace-only', () => {
        // An absent, empty or whitespace-only name makes app.name fall back to a directory
        // nobody's data lives in — the same orphaning outcome as an outright rename.
        expect(Object.prototype.hasOwnProperty.call(pkg, 'name')).toBe(true);
        const name = pkg['name'];
        expect(typeof name).toBe('string');
        expect(String(name)).not.toBe('');
        expect(String(name).trim()).not.toBe('');
    });

    it('package.json name is exactly "workflow-timer"', () => {
        expect(pkg['name']).toBe(EXPECTED_NAME);
    });

    it('package.json name is byte-exact ASCII, so whitespace and homoglyphs fail', () => {
        // toBe() above already catches these, but comparing code points states the intent:
        // a trailing space or a U+2010 HYPHEN in place of U+002D HYPHEN-MINUS is visually
        // identical in a diff and would move the directory just as completely.
        const name = String(pkg['name']);
        expect([...name].map((c) => c.codePointAt(0))).toEqual(
            [...EXPECTED_NAME].map((c) => c.codePointAt(0))
        );
        expect(name).toBe(name.trim());
    });

    it('package.json has NO top-level productName', () => {
        // app.name is `productName ?? name`, so a top-level productName silently wins over
        // name. This is the most likely scaffolding tidy-up and the one a plain name check
        // would miss entirely.
        expect(Object.prototype.hasOwnProperty.call(pkg, 'productName')).toBe(false);
    });

    it('the builder configuration lives in electron-builder.yml and nowhere else', () => {
        // Moved out of package.json in plan 02-01. If it silently moved back, or a second config
        // file appeared, the two YAML assertions below would be reading a file the build ignores.
        expect(builderConfig, BUILDER_CONFIG + ' is missing or empty').not.toBe('');
        expect(
            Object.prototype.hasOwnProperty.call(pkg, 'build'),
            'package.json carries an inline builder block again; the configuration belongs in ' +
            BUILDER_CONFIG + ' only'
        ).toBe(false);
        const alternates = ALTERNATE_BUILDER_CONFIGS.filter((f) => fs.existsSync(path.join(repoRoot, f)));
        expect(alternates, 'a second electron-builder configuration file exists').toEqual([]);
    });

    it('electron-builder does not inject name/productName into the packaged manifest', () => {
        // app-builder-lib's modifyMainPackageJson runs deepAssign(mainPackageData, extraMetadata)
        // into the PACKAGED package.json, so this vector never appears in the source manifest's
        // top level and is invisible to a plain `name` assertion (D-10). Asserted over the raw
        // text rather than a parsed key, so the key cannot hide anywhere in the file - which is
        // also why electron-builder.yml's own comments never spell the key's name.
        expect(builderConfig).not.toMatch(/extraMetadata/);
        // `extends` pulls in a preset configuration this file cannot show, which may inject it.
        expect(builderConfig).not.toMatch(/^extends\s*:/m);
    });

    it('electron-builder.yml productName is still "Workflow", and that mismatch is intentional', () => {
        // productName ("Workflow") deliberately differs from name ("workflow-timer"). It is the
        // installer/display name only: app-builder-lib's cleanupPackageJson merely DELETES
        // properties and never promotes the builder's productName to the top level, so it can
        // never become app.name and can never move userData. Do not "resolve" this
        // inconsistency by aligning name to it — that is precisely the dangerous direction.
        expect(builderConfig).toMatch(/^productName:\s*Workflow\s*$/m);
    });

    it('no source file calls app.setName or app.setPath, except one annotated allowlist entry', () => {
        // Both APIs override app.name / the userData path at runtime, which no JSON assertion
        // can see. ESLint's no-restricted-properties covers the same ground; this covers it even
        // if lint is bypassed.
        const files = sourceFiles();
        expect(
            files,
            'the scan cannot see the new main-process tree, so it would pass while covering nothing'
        ).toEqual(expect.arrayContaining(['src/main/index.ts', ...Object.keys(SET_PATH_ALLOWLIST)]));

        const offenders: string[] = [];
        for (const file of files) {
            const src = readSource(file);
            if (SET_NAME_CALL.test(src)) offenders.push(file + ' calls app.setName');
            if (SET_PATH_CALL.test(src) && !Object.hasOwn(SET_PATH_ALLOWLIST, file)) {
                offenders.push(file + ' calls app.setPath');
            }
        }
        expect(offenders).toEqual([]);
    });

    it('the setPath allowlist has exactly one entry, and it still names a real call', () => {
        // An exemption that can grow, or that outlives the code it exempts, is a loosened rule.
        const entries = Object.entries(SET_PATH_ALLOWLIST);
        expect(entries).toHaveLength(1);
        for (const [file, justification] of entries) {
            expect(justification.trim(), file + ' has no justification').not.toBe('');
            expect(fs.existsSync(path.join(repoRoot, file)), file + ' no longer exists').toBe(true);
            const calls = (readSource(file).match(SET_PATH_CALLS) ?? []).length;
            expect(calls, file + ' should make exactly the one exempted call').toBe(1);
        }
    });
});
