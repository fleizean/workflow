import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
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

    it('electron-builder does not inject name/productName via build.extraMetadata', () => {
        // app-builder-lib's modifyMainPackageJson runs deepAssign(mainPackageData, extraMetadata)
        // into the PACKAGED package.json, so this vector never appears in the source manifest's
        // top level and is invisible to a plain `name` assertion.
        const build = (pkg['build'] ?? {}) as Record<string, unknown>;
        const extra = (build['extraMetadata'] ?? {}) as Record<string, unknown>;
        expect(Object.prototype.hasOwnProperty.call(extra, 'name')).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(extra, 'productName')).toBe(false);
    });

    it('build.productName is still "Workflow", and that mismatch is intentional', () => {
        // build.productName ("Workflow") deliberately differs from name ("workflow-timer").
        // It is the installer/display name only: app-builder-lib's cleanupPackageJson merely
        // DELETES properties and never promotes build.productName to the top level, so it can
        // never become app.name and can never move userData. Do not "resolve" this
        // inconsistency by aligning name to it — that is precisely the dangerous direction.
        const build = (pkg['build'] ?? {}) as Record<string, unknown>;
        expect(build['productName']).toBe('Workflow');
    });

    it('no source file calls app.setName() or app.setPath()', () => {
        // Both APIs override app.name / the userData path at runtime, which no JSON assertion
        // can see. ESLint's no-restricted-properties covers the whole tree; this covers the
        // three files that exist today even if lint is bypassed.
        for (const f of ['main.js', 'preload.js', 'database/db.js']) {
            const src = readSource(f);
            expect(src, `${f} must not call app.setName`).not.toMatch(/\bapp\s*\.\s*setName\s*\(/);
            expect(src, `${f} must not call app.setPath`).not.toMatch(/\bapp\s*\.\s*setPath\s*\(/);
        }
    });
});
