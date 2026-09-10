/*
 * tests/built-manifest.test.ts
 *
 * The standing proof for D-10: the name inside the PACKAGED application's manifest is the name in
 * this repository's package.json, and nothing in the build configuration can change it.
 *
 * Why this is its own file. tests/app-identity.test.ts pins package.json's `name`. But Electron
 * does not read this repository's package.json at runtime - it reads the one electron-builder
 * WRITES into the packaged app, and electron-builder can rewrite it on the way:
 *
 *   - its metadata-injection key deep-merges arbitrary fields (a name, a productName) into the
 *     packaged manifest (app-builder-lib's modifyMainPackageJson), so the change never appears in
 *     the source manifest at all;
 *   - a top-level `name` key in the builder config is a second declaration of the identity;
 *   - `directories.app` points the build at a DIFFERENT package.json, whose name nobody checks.
 *
 * Any of these moves every installed user's krono.db to an empty directory, without a crash, a
 * warning or one failing assertion in the rest of the suite. That is the C2 catastrophe Phase 1
 * exists to prevent, arriving by a door Phase 1's guard cannot see.
 *
 * The YAML is read as text with FULL-LINE COMMENTS STRIPPED FIRST. This repository puts the reason
 * for every non-obvious choice into the file itself, so electron-builder.yml is dense with prose
 * about exactly the keys asserted on here. A bare match would be satisfied by an explanatory
 * comment (the misfire plan 01-08's module-shape gate hit), or defeated by one. Presence checks
 * therefore run on the stripped text only, where a comment cannot satisfy them.
 *
 * Each assertion was turned red by a deliberate mutation of electron-builder.yml or package.json
 * before this file was committed, and the file restored byte-identically (see plan 02-02's
 * SUMMARY for the hashes).
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const BUILDER_CONFIG = 'electron-builder.yml';
const EXPECTED_NAME = 'workflow-timer';
const EXPECTED_PRODUCT_NAME = 'Workflow';

const readText = (rel: string): string => {
    const p = path.join(repoRoot, rel);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
};

const pkg = JSON.parse(readText('package.json')) as Record<string, unknown>;
const builderRaw = readText(BUILDER_CONFIG);

/*
 * electron-builder.yml with every line whose first non-blank character is # removed. Anchored at
 * the start of the line, so a # inside a value (none exist today) is never mistaken for a comment
 * and a comment line can never contribute a key.
 */
function stripYamlCommentLines(text: string): string {
    return text
        .split(/\r?\n/)
        .filter((line) => !/^\s*#/.test(line))
        .join('\n');
}

const builder = stripYamlCommentLines(builderRaw);

/*
 * The name Electron resolves at runtime, from the manifest that ends up inside the package:
 * app.name = productName ?? name. With no injection key and no alternate app directory (asserted
 * below), that manifest is this repository's package.json, unchanged.
 */
const runtimeName = (manifest: Record<string, unknown>): unknown =>
    manifest['productName'] ?? manifest['name'];

describe('D-10: the packaged manifest carries the repository manifest\'s name', () => {
    it('electron-builder.yml exists and declares productName Workflow exactly once', () => {
        expect(builderRaw, BUILDER_CONFIG + ' is missing or empty').not.toBe('');
        const productNames = builder.split('\n').filter((line) => /^productName\s*:/.test(line));
        expect(
            productNames,
            BUILDER_CONFIG + ' must declare productName once, at top level, outside a comment'
        ).toEqual(['productName: ' + EXPECTED_PRODUCT_NAME]);
    });

    it('electron-builder.yml has no key that injects or redirects manifest metadata', () => {
        // Anywhere in the file, at any depth, in block or flow style: this key has no legitimate
        // use in this repository, so its mere presence outside a comment is the failure.
        expect(
            /extraMetadata/i.test(builder),
            BUILDER_CONFIG + ' injects metadata into the packaged manifest. Remove the key: it can ' +
            'rewrite the name every user\'s userData directory is resolved from (D-10)'
        ).toBe(false);
        // A different application directory means a different package.json, whose name is not
        // the one tests/app-identity.test.ts pins.
        expect(
            /^\s*["']?app["']?\s*:/m.test(builder),
            BUILDER_CONFIG + ' sets directories.app, so the packaged manifest would come from a ' +
            'package.json other than the one the identity guard checks'
        ).toBe(false);
    });

    it('electron-builder.yml declares no name of its own', () => {
        expect(
            /^["']?name["']?\s*:/m.test(builder),
            BUILDER_CONFIG + ' declares a top-level name. The application name belongs to ' +
            'package.json alone'
        ).toBe(false);
    });

    it('no npm script injects metadata through electron-builder\'s command line', () => {
        // The same key, passed as -c.extraMetadata.name=... on the command line, bypasses the YAML
        // entirely. The scripts are where that would be written.
        const scripts = (pkg['scripts'] ?? {}) as Record<string, string>;
        const offenders = Object.entries(scripts)
            .filter(([, command]) => /extraMetadata|directories\.app/i.test(command))
            .map(([name]) => name);
        expect(offenders, 'package.json scripts that rewrite the packaged manifest').toEqual([]);
    });

    it('package.json still has no top-level productName and no inline builder block', () => {
        expect(
            Object.prototype.hasOwnProperty.call(pkg, 'productName'),
            'package.json has a top-level productName, which Electron prefers over name'
        ).toBe(false);
        expect(
            Object.prototype.hasOwnProperty.call(pkg, 'build'),
            'package.json carries an inline builder block again, beside ' + BUILDER_CONFIG
        ).toBe(false);
    });

    it('the name Electron resolves at runtime comes from package.json alone, and is workflow-timer', () => {
        expect(pkg['name'], 'package.json name').toBe(EXPECTED_NAME);
        expect(
            runtimeName(pkg),
            'the packaged app would resolve its userData directory from a different name'
        ).toBe(EXPECTED_NAME);
        // productName is the installer/display name only and deliberately differs. It never
        // becomes app.name, because the builder never promotes it into the packaged manifest.
        expect(EXPECTED_PRODUCT_NAME).not.toBe(EXPECTED_NAME);
    });
});
