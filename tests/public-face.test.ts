/*
 * Phase 11 criteria 2 and 3: what a stranger reads describes the application that exists.
 *
 * tests/sheets-retirement.test.ts proved the export is gone from src/. Nothing looked at README.md or at the
 * published site, and both went on advertising it - "Google Sheets" four times on the front page, with a copyable
 * Apps Script and a "New in v1.2.1" badge over it - for the six months after the owner removed the feature. A
 * retirement guard that stops at the source is a guard over the half nobody reads.
 *
 * Every claim here is one a reader could act on: a feature that does not exist, a file that is not there, a
 * download that is not offered, a command that is not a script.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { read, repoRoot } from './helpers/ts-imports';

/** The documents a stranger arriving at the repository or the site actually reads. */
const PUBLIC_FACE = ['README.md', 'CONTRIBUTING.md', 'docs/index.html'];

/*
 * Vocabulary that is false of v2. The Sheets export left the app on 2026-09-11 and its two columns and two
 * settings rows left the database on 2026-09-13, so none of this describes anything a user can do.
 */
const RETIRED_CLAIMS = [
    'Google Sheet', 'Apps Script', 'Excelsheet', 'Excel/Sheet', 'spreadsheet', 'Day End Summary',
    'Confirm & Export', 'script_url', 'Script URL'
];

/*
 * The v1.2.1 file tree. A README that tells a contributor to edit database/db.js is telling them to create a
 * file, and 08-F deleted every one of these.
 */
const DEAD_PATHS = ['database/db.js', 'src/pages/', 'src/renderer/timer.js', 'src/renderer/shared.js',
    'legacy/', 'dist_output', 'screenshots/'];

const pkg = JSON.parse(read('package.json')) as Record<string, unknown>;
const scripts = Object.keys(pkg['scripts'] ?? {});

describe('criterion 2 and 3: no document claims a feature that was removed', () => {
    it.each(PUBLIC_FACE)('%s says nothing about the export', (file) => {
        const text = read(file);
        const found = RETIRED_CLAIMS.filter((claim) => text.toLowerCase().includes(claim.toLowerCase()));
        expect(found, file + ' advertises the Google Sheets export, which no version of v2 has').toEqual([]);
    });

    it('finds a planted claim (negative control)', () => {
        const planted = 'Export straight to your Google Sheet.';
        expect(RETIRED_CLAIMS.filter((claim) => planted.toLowerCase().includes(claim.toLowerCase())))
            .toEqual(['Google Sheet']);
    });

    it.each(PUBLIC_FACE)('%s names no file the restructure deleted', (file) => {
        const text = read(file);
        const found = DEAD_PATHS.filter((dead) => text.includes(dead));
        expect(found, file + ' points a reader at part of the v1.2.1 tree').toEqual([]);
    });

    it.each(PUBLIC_FACE)('%s does not offer v1.2.1 as the thing to download', (file) => {
        // The recovery instructions in README.md are ABOUT v1.2.1 and must keep saying so; what must not survive
        // is a version number presented as the current one.
        expect(read(file), file + ' offers a version this milestone replaces').not.toMatch(/Download v?1\.\d/);
        expect(read(file), file + ' calls a v1.x release new').not.toMatch(/New in v?1\.\d/);
    });
});

describe('criterion 2: README.md describes v2, and every command in it is real', () => {
    const readme = read('README.md');

    it('says what the app is, where the data lives, and which platforms are supported', () => {
        for (const claim of ['%APPDATA%\\workflow-timer\\', '~/Library/Application Support/workflow-timer/',
            'SQLite', 'Windows', 'macOS', 'Pomodoro']) {
            expect(readme, 'README.md no longer says ' + claim).toContain(claim);
        }
    });

    it('names only npm scripts that exist', () => {
        const named = [...readme.matchAll(/`npm run ([a-z:0-9]+)`/g)].map((match) => match[1] ?? '');
        expect(named.length, 'no npm scripts are documented, so this checks nothing').toBeGreaterThan(5);
        const missing = [...new Set(named)].filter((name) => !scripts.includes(name)).sort();
        expect(missing, 'README.md documents scripts package.json does not define').toEqual([]);
    });

    it('asks for the Node version .nvmrc pins', () => {
        const pinned = read('.nvmrc').trim().split('.')[0] ?? '';
        expect(pinned, '.nvmrc carries no major version').not.toBe('');
        expect(readme, 'README.md asks for a different Node than .nvmrc pins')
            .toContain('Node.js ' + pinned);
    });

    it('links to the repository the git remote actually points at', () => {
        const url = (pkg['repository'] as Record<string, unknown> | undefined)?.['url'];
        const repository = typeof url === 'string' ? url : '';
        const slug = /github\.com\/([^/]+\/[^/.]+)/.exec(repository)?.[1] ?? '';
        expect(slug).toBe('fleizean/workflow-timer');
        // The clone URL in the build instructions ends .git; the trailing suffix is not a different repository.
        const links = [...readme.matchAll(/github\.com\/([^/)\s]+\/[^/)\s#]+)/g)]
            .map((match) => (match[1] ?? '').replace(/\.git$/, ''));
        expect(links.length, 'README.md links to no repository at all').toBeGreaterThan(2);
        expect([...new Set(links)].filter((link) => link !== slug && !link.startsWith('WiseLibs/')),
            'README.md links to a repository that is not this one').toEqual([]);
    });

    /*
     * REPO-06's last clause. The app contacts GitHub without being asked to, so the README has to say so in terms
     * a reader can check: the address, the schedule, what is sent, and how to stop it. Held to the constants
     * rather than to a form of words - a disclosure that drifts from the code is worse than none.
     */
    it('discloses the version check, with the address and the switch that turns it off', () => {
        const config = read('src/main/config.ts');
        const url = /UPDATE_MANIFEST_URL = '([^']+)'/.exec(config)?.[1] ?? '';
        const env = /UPDATE_CHECK_DISABLED_ENV = '([^']+)'/.exec(config)?.[1] ?? '';
        expect(url, 'src/main/config.ts no longer declares a manifest URL').not.toBe('');
        expect(env, 'src/main/config.ts no longer declares an opt-out variable').not.toBe('');

        expect(readme, 'README.md does not say which address the app contacts').toContain(url);
        expect(readme, 'README.md does not name the variable that switches the check off').toContain(env);
        expect(readme, 'README.md does not say how often the app contacts GitHub').toMatch(/once a day/i);
        expect(readme, 'README.md does not say what is sent').toMatch(/no identifier of any kind/i);
    });
});

describe('criterion 3: the site describes the shipped application', () => {
    const site = read('docs/index.html');

    it('mentions Pomodoro as a feature rather than in passing', () => {
        const mentions = (site.match(/Pomodoro/g) ?? []).length;
        // It was mentioned once, inside another feature's description, while a removed export had a whole section.
        expect(mentions, 'Pomodoro was rewritten from scratch in this milestone and the site barely says so')
            .toBeGreaterThan(2);
    });

    it('names the four screens the application has', () => {
        for (const name of ['Home', 'Companies', 'Work History', 'Settings']) {
            expect(site, 'the site does not mention the ' + name + ' screen').toContain(name);
        }
    });

    it('offers the four installers the release workflow actually produces', () => {
        const release = read('.github/workflows/release.yml');
        for (const suffix of ['x64-setup.exe', 'arm64-setup.exe', 'x64.dmg', 'arm64.dmg']) {
            expect(release, 'release.yml no longer expects ' + suffix).toContain(suffix);
            expect(site, 'the site does not offer ' + suffix + ', which every release carries').toContain(suffix);
        }
    });

    it('says the builds are unsigned, because the first launch will say so louder', () => {
        expect(site.toLowerCase()).toContain('unsigned');
        expect(site, 'the macOS quarantine command is gone, and it is the one thing a Mac user needs')
            .toContain('xattr -dr com.apple.quarantine');
    });

    it('does not claim macOS is verified, because no macOS hardware ever ran it', () => {
        expect(site, 'the site claims a runtime verification nobody performed').toContain('not runtime-verified');
    });

    it('loads nothing over plain http, on a page GitHub serves over https', () => {
        // A decorative noise texture used to be pulled from http://assets.iceable.com. Browsers block mixed
        // content, so it never rendered on the published site - it was a third-party dependency for nothing.
        const insecure = [...site.matchAll(/http:\/\/[^\s"')]+/g)].map((match) => match[0]);
        expect(insecure, 'the site references plain http, which a browser will block').toEqual([]);
    });

    it('has an internal link for every anchor it offers, and no orphan sections', () => {
        const ids = new Set([...site.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1] ?? ''));
        const anchors = [...site.matchAll(/href="#([^"]+)"/g)].map((match) => match[1] ?? '');
        expect(anchors.length, 'the site offers no internal navigation at all').toBeGreaterThan(1);
        expect(anchors.filter((anchor) => !ids.has(anchor)),
            'the navigation points at a section that no longer exists').toEqual([]);
    });

    it('carries no script that drives a removed feature', () => {
        for (const dead of ['simulateExport', 'closeMockToast', 'setupModal', 'mockToast', 'scriptCode']) {
            expect(site, 'the site still carries the ' + dead + ' handler of a deleted section').not.toContain(dead);
        }
    });

    it('is the only page in docs/, so there is nowhere else for a stale claim to hide', () => {
        const pages = fs.readdirSync(path.join(repoRoot, 'docs'))
            .filter((name) => name.toLowerCase().endsWith('.html'));
        expect(pages, 'docs/ has grown a second page that nothing above checks').toEqual(['index.html']);
    });
});
