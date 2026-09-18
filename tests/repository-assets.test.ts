/*
 * Phase 11 criterion 1: the repository carries each binary asset once.
 *
 * Phase 10 proved this of the BUILD OUTPUT and the packaged archive. Neither reaches the repository, which is where
 * the same 1,840,744-byte PNG sat four times - src/assets/icon.png, build/icon.png, docs/assets/workflow-timer.png,
 * assets/workflow-timer.png - and a fifth copy wearing an .svg extension, 2,454,970 bytes of base64 PNG in an SVG
 * wrapper, served as the Pages site's favicon.
 *
 * Judged on CONTENT, for the reason Phase 10 gave: the four copies had four different names, which is exactly why
 * nobody noticed. The register below holds the one duplicate pair that stays, each side with the consumer that
 * needs it there.
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot } from './helpers/ts-imports';

/** Extensions whose bytes are the asset. Text duplicates are a different question and not this one. */
const BINARY_EXTENSIONS = ['.png', '.ico', '.svg', '.woff2', '.mp3', '.jpg', '.jpeg', '.gif', '.webp'];

/**
 * The duplicate content that is allowed to stand, keyed by the sorted paths that hold it.
 *
 * One entry. Both sides are the 1024x1024 application logo and neither can be dropped: electron-builder reads
 * build/icon.png as a path in electron-builder.yml and turns it into the Windows .ico and the macOS .icns, while
 * src/main/tray.ts imports src/assets/icon.png through Vite's ?asset, which requires it under src/. Pointing one at
 * the other means either a build-tool path that escapes src/ or an icon resource resolved by a bundler that does not
 * run when electron-builder does.
 */
const ALLOWED_DUPLICATES: ReadonlyMap<string, string> = new Map([
    [
        'build/icon.png|src/assets/icon.png',
        'the 1024x1024 application logo: build/icon.png is electron-builder\'s icon resource, src/assets/icon.png is ' +
        'the tray icon Vite bundles into out/main'
    ],
    [
        'docs/assets/logo-64.png|src/assets/icon-64.png',
        'the 64x64 logo, 8,545 bytes. GitHub Pages publishes docs/ as the site root, so nothing under src/ is ' +
        'reachable from the page; this is the copy that replaced the 1,840,744-byte one the site drew at 32 px'
    ]
]);

/** Below this, a duplicated asset costs less than the indirection that would remove it. */
const DUPLICATE_FLOOR_BYTES = 4_096;

function trackedFiles(): string[] {
    return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
        cwd: repoRoot,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024
    })
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '' && fs.existsSync(path.join(repoRoot, line)));
}

interface Asset {
    readonly file: string;
    readonly bytes: number;
    readonly digest: string;
}

function binaryAssets(): Asset[] {
    return trackedFiles()
        .filter((file) => BINARY_EXTENSIONS.includes(path.extname(file).toLowerCase()))
        // Byte-exact copies of what a CDN served on one day, pinned by SHA-256 in the vendor index; two weights of
        // one font family legitimately share bytes with nothing, but the directory is not this test's to police.
        .filter((file) => !file.startsWith('tools/baseline/vendor/'))
        .map((file) => {
            const bytes = fs.readFileSync(path.join(repoRoot, file));
            return { file, bytes: bytes.length, digest: crypto.createHash('sha256').update(bytes).digest('hex') };
        });
}

function duplicateGroups(): Map<string, Asset[]> {
    const byDigest = new Map<string, Asset[]>();
    for (const asset of binaryAssets()) {
        const group = byDigest.get(asset.digest) ?? [];
        group.push(asset);
        byDigest.set(asset.digest, group);
    }
    for (const [digest, group] of byDigest) {
        if (group.length < 2 || (group[0]?.bytes ?? 0) < DUPLICATE_FLOOR_BYTES) {
            byDigest.delete(digest);
        }
    }
    return byDigest;
}

const keyOf = (group: readonly Asset[]): string => group.map((a) => a.file).sort().join('|');

describe('criterion 1: one copy of each binary asset, and a register for the exception', () => {
    it('has no duplicate content beyond what the register names', () => {
        const unregistered = [...duplicateGroups().values()]
            .map((group) => keyOf(group))
            .filter((key) => !ALLOWED_DUPLICATES.has(key))
            .sort();

        expect(
            unregistered,
            'the same bytes are committed under more than one name. A fingerprinted or renamed copy is still a ' +
            'copy - that is how four copies of one 1.84 MB PNG went unnoticed until Phase 10 hashed them. Delete ' +
            'all but one and repoint its readers, or add the pair to ALLOWED_DUPLICATES with the consumer that ' +
            'forces it.'
        ).toEqual([]);
    });

    it('registers nothing that is no longer duplicated', () => {
        const live = new Set([...duplicateGroups().values()].map((group) => keyOf(group)));
        const stale = [...ALLOWED_DUPLICATES.keys()].filter((key) => !live.has(key));

        expect(stale, 'ALLOWED_DUPLICATES excuses a duplicate that no longer exists, so it excuses nothing and the ' +
            'next file to take one of those paths inherits the exemption').toEqual([]);
    });

    it('the registered pair really is the pair it claims, and both sides are read by something', () => {
        const builderIcon = 'build/icon.png';
        const trayIcon = 'src/assets/icon.png';
        for (const file of [builderIcon, trayIcon]) {
            expect(fs.existsSync(path.join(repoRoot, file)), file + ' is registered but absent').toBe(true);
        }
        expect(fs.readFileSync(path.join(repoRoot, 'electron-builder.yml'), 'utf8'))
            .toContain('icon: ' + builderIcon);
        expect(fs.readFileSync(path.join(repoRoot, 'src/main/tray.ts'), 'utf8'))
            .toContain("'../assets/icon.png?asset'");
    });

    it('the four-copy logo is down to the registered two', () => {
        const logo = fs.readFileSync(path.join(repoRoot, 'build/icon.png'));
        const digest = crypto.createHash('sha256').update(logo).digest('hex');
        const holders = binaryAssets().filter((asset) => asset.digest === digest).map((asset) => asset.file).sort();

        expect(logo.length, 'the logo is not the 1,840,744-byte file this count was taken against').toBe(1_840_744);
        expect(holders, 'Phase 10 measured four copies of this image; criterion 1 leaves two, each with a consumer')
            .toEqual(['build/icon.png', 'src/assets/icon.png']);
    });
});

describe('criterion 1: the Pages site reads only files that are in the repository', () => {
    const site = fs.readFileSync(path.join(repoRoot, 'docs/index.html'), 'utf8');

    it('every local asset docs/index.html names exists', () => {
        const referenced = [...site.matchAll(/(?:href|src)="((?!https?:|data:|#|mailto:)[^"]+)"/g)]
            .map((match) => match[1] ?? '')
            .filter((href) => href !== '');
        const missing = referenced.filter((href) => !fs.existsSync(path.join(repoRoot, 'docs', href)));

        expect(referenced.length, 'no local references were found, so this test is checking nothing')
            .toBeGreaterThan(3);
        expect(missing, 'docs/index.html points at files that are not in docs/').toEqual([]);
    });

    it('carries no asset the page never names', () => {
        const named = new Set(
            [...site.matchAll(/(?:href|src)="((?!https?:|data:|#|mailto:)[^"]+)"/g)].map((match) => match[1] ?? '')
        );
        // site.webmanifest declares the two web-app icons; the page reaches them only through it.
        const manifest = fs.readFileSync(path.join(repoRoot, 'docs/assets/site.webmanifest'), 'utf8');

        const orphans = fs.readdirSync(path.join(repoRoot, 'docs/assets'))
            .filter((name) => !named.has('assets/' + name) && !manifest.includes(name))
            .sort();

        expect(orphans, 'docs/assets carries files nothing on the site or in its manifest asks for').toEqual([]);
    });
});
