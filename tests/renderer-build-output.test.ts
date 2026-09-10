import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * Why this file reads the BUILD OUTPUT and not the source (BUILD-07, T-02-12, T-02-13).
 *
 * The roadmap criterion is about the document the app actually loads: "a production build loads no
 * remote resource - the CSP <meta> tag is present in the built HTML". A policy that is present in
 * src/renderer/index.html and dropped or rewritten by the bundler is indistinguishable, at runtime,
 * from a policy that was never written. And the renderer is loaded from a file URL, where the
 * response-header route (session.webRequest.onHeadersReceived) does not apply at all - so the
 * <meta> element in out/renderer/index.html is the ONLY thing enforcing anything. A source-only
 * assertion cannot see what the bundler emitted, which is why every check below reads out/.
 *
 * The remote-resource scan is scoped on purpose, per file type, rather than banning every scheme
 * everywhere:
 *
 *   entry document  any http: or https: at all, and any protocol-relative src/href. A plain HTML
 *                   entry has no legitimate reason to carry an absolute address.
 *   emitted CSS     a url() or @import naming a remote target. Not a blanket scheme ban: Tailwind's
 *                   licence banner names its home page in a comment, and the forms plugin's data:
 *                   SVGs carry the SVG namespace address. Neither loads anything.
 *   every file      the four hosts the v1.2.1 renderer actually loaded from. The bundled React
 *                   runtime legitimately contains namespace addresses for SVG and MathML, so a
 *                   scheme ban over JavaScript would fail on it - and a guard that misfires teaches
 *                   the next reader to disable it, which is worse than not having it.
 *
 * A missing build is loud, never a silent pass. out/ is gitignored and the verify job does not
 * build, so without a build this suite has nothing to check. It then registers one SKIPPED test
 * whose name says so and names the command that produces the build, and prints the same message.
 * Setting WORKFLOW_REQUIRE_BUILD_OUTPUT=1 turns that skip into a failure; any job that builds
 * before testing should set it, so a broken build cannot read as "skipped".
 *
 * What this does NOT prove: that no route makes a runtime request. That is a live-console
 * observation against the finished app (Phase 10: zero CSP violations on any route).
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const BUILD_SCRIPT = 'npm run build';
const REQUIRE_BUILD_ENV = 'WORKFLOW_REQUIRE_BUILD_OUTPUT';
const SOURCE_ENTRY = 'src/renderer/index.html';
const BUILT_DIR = 'out/renderer';
const BUILT_ENTRY = 'out/renderer/index.html';

// Every remote host the v1.2.1 renderer fetched from at runtime.
const V121_REMOTE_HOSTS = ['cdn.tailwindcss.com', 'fonts.googleapis.com', 'fonts.gstatic.com', 'unpkg.com'];

// The two font families the renderer must ship inside the bundle (S4).
const BUNDLED_FONT_FAMILIES = ['Inter Variable', 'Material Symbols Outlined'];

// The only source expressions a directive may carry. Anything else - a host, a scheme such as
// https: or blob:, or * - admits an origin outside the app bundle.
const ALLOWED_CSP_SOURCES = new Set(["'self'", "'none'", "'unsafe-inline'", 'data:']);

const MISSING_BUILD =
    BUILT_ENTRY + ' does not exist, so BUILD-07 has NOT been checked. Run `' + BUILD_SCRIPT +
    '` to produce it, then re-run this file. (Set ' + REQUIRE_BUILD_ENV +
    '=1 to make a missing build fail instead of skip.)';

const hasBuild = fs.existsSync(path.join(repoRoot, BUILT_ENTRY));
const buildRequired = process.env[REQUIRE_BUILD_ENV] === '1';

const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

/** Every file under an absolute directory, as sorted repo-relative forward-slash paths. */
const walk = (absDir: string): string[] => {
    const found: string[] = [];
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
        const full = path.join(absDir, entry.name);
        if (entry.isDirectory()) {
            found.push(...walk(full));
        } else if (entry.isFile()) {
            found.push(path.relative(repoRoot, full).split(path.sep).join('/'));
        }
    }
    return found.sort();
};

// A commented-out policy is not a policy, and a commented-out url() loads nothing.
const stripHtmlComments = (html: string): string => html.replace(/<!--[\s\S]*?-->/g, '');
const stripCssComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** The content attribute of every Content-Security-Policy meta element outside a comment. */
const cspMetaContents = (html: string): string[] => {
    const contents: string[] = [];
    for (const tag of stripHtmlComments(html).match(/<meta\b[^>]*>/gi) ?? []) {
        if (!/http-equiv\s*=\s*(["'])content-security-policy\1/i.test(tag)) continue;
        const content = /\scontent\s*=\s*(["'])([\s\S]*?)\1/i.exec(tag);
        contents.push(content?.[2] ?? '');
    }
    return contents;
};

/** directive name -> source expressions. The first occurrence of a directive wins, as in browsers. */
const parseCsp = (policy: string): Map<string, string[]> => {
    const directives = new Map<string, string[]>();
    for (const part of policy.split(';')) {
        const [name, ...sources] = part.trim().split(/\s+/).filter((token) => token !== '');
        if (name !== undefined && !directives.has(name.toLowerCase())) {
            directives.set(name.toLowerCase(), sources);
        }
    }
    return directives;
};

/** A url()/@import target that would be fetched from outside the bundle. data: is inline, not remote. */
const isRemoteTarget = (target: string): boolean => {
    const t = target.trim();
    if (t.startsWith('//')) return true;
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(t);
    return scheme !== null && scheme[1]?.toLowerCase() !== 'data';
};

const cssUrlTargets = (css: string): string[] =>
    [...css.matchAll(/url\(\s*(['"]?)([\s\S]*?)\1\s*\)/gi)].map((m) => m[2] ?? '');

const cssImportTargets = (css: string): string[] =>
    [...css.matchAll(/@import\s+(?:url\(\s*)?(['"]?)([^'")\s;]+)\1/gi)].map((m) => m[2] ?? '');

const fontFaces = (css: string): { family: string; urls: string[] }[] =>
    [...css.matchAll(/@font-face\s*\{([^}]*)\}/gi)].map((m) => {
        const body = m[1] ?? '';
        const family = /font-family\s*:\s*(['"]?)([^;'"]+)\1/i.exec(body)?.[2]?.trim() ?? '';
        return { family, urls: cssUrlTargets(body) };
    });

describe('BUILD-07: the BUILT renderer carries its Content-Security-Policy and loads nothing remote', () => {
    if (!hasBuild) {
        if (buildRequired) {
            it('the renderer build output exists', () => {
                throw new Error(MISSING_BUILD);
            });
        } else {
            console.warn('\ntests/renderer-build-output.test.ts: SKIPPED - ' + MISSING_BUILD + '\n');
            it.skip('SKIPPED - ' + MISSING_BUILD, () => undefined);
        }
        return;
    }

    const builtHtml = read(BUILT_ENTRY);
    const emitted = walk(path.join(repoRoot, BUILT_DIR));
    const emittedWith = (extension: string): string[] =>
        emitted.filter((file) => file.toLowerCase().endsWith(extension));
    const builtPolicy = (): Map<string, string[]> => parseCsp(cspMetaContents(builtHtml)[0] ?? '');

    it('the built entry carries exactly one Content-Security-Policy meta element', () => {
        expect(
            cspMetaContents(builtHtml).length,
            BUILT_ENTRY + ' has no Content-Security-Policy <meta> outside a comment. On a file URL ' +
            'that element is the only thing enforcing the policy - the response-header route does ' +
            'not apply - so without it the renderer runs with no CSP at all. Restore it in ' +
            SOURCE_ENTRY + ' and rebuild.'
        ).toBe(1);
    });

    it("the built policy pins default-src, script-src and connect-src to 'self' alone", () => {
        const policy = builtPolicy();
        for (const directive of ['default-src', 'script-src', 'connect-src']) {
            expect(
                policy.get(directive),
                directive + " must be exactly 'self'. script-src in particular may carry no " +
                "'unsafe-inline' and no 'unsafe-eval' (T-02-14), and connect-src 'self' keeps the " +
                'export HTTP call out of the renderer by construction.'
            ).toEqual(["'self'"]);
        }
    });

    it("style-src admits 'unsafe-inline' by name - Vite injects style elements and React emits inline styles", () => {
        const styleSrc = builtPolicy().get('style-src') ?? [];
        expect(styleSrc).toContain("'self'");
        expect(styleSrc).toContain("'unsafe-inline'");
    });

    it('no directive admits an origin outside the app bundle', () => {
        const offenders = [...builtPolicy()].flatMap(([directive, sources]) =>
            sources.filter((source) => !ALLOWED_CSP_SOURCES.has(source)).map((source) => directive + ' ' + source)
        );
        expect(
            offenders,
            'These CSP source expressions admit a remote origin. The app must render fully offline; ' +
            'a remote source in the policy is the first step toward a remote load.'
        ).toEqual([]);
    });

    it('the built policy is exactly the one ' + SOURCE_ENTRY + ' declares', () => {
        const declared = cspMetaContents(read(SOURCE_ENTRY));
        expect(declared.length, SOURCE_ENTRY + ' has no Content-Security-Policy <meta> element').toBe(1);
        expect(
            builtHtml.includes(declared[0] ?? ' '),
            'The policy in ' + BUILT_ENTRY + ' differs from the one in ' + SOURCE_ENTRY + '. Either ' +
            'the bundler rewrote it, or the build is stale - run `' + BUILD_SCRIPT + '` and re-run.'
        ).toBe(true);
    });

    it('the built entry carries no absolute remote address', () => {
        const schemes = builtHtml.match(/https?:[^\s"'<>]*/gi) ?? [];
        const protocolRelative = builtHtml.match(/\b(?:src|href)\s*=\s*["']\/\/[^"']*/gi) ?? [];
        expect(
            [...schemes, ...protocolRelative],
            BUILT_ENTRY + ' names a remote address. The entry document has no legitimate reason to ' +
            'carry one; offline, whatever it points at silently fails to load (S4).'
        ).toEqual([]);
    });

    it('no emitted stylesheet imports or url()s a remote resource', () => {
        const stylesheets = emittedWith('.css');
        expect(stylesheets.length, 'no CSS was emitted under ' + BUILT_DIR + ', so this scan would pass vacuously').toBeGreaterThan(0);
        const offenders = stylesheets.flatMap((file) => {
            const css = stripCssComments(read(file));
            return [...cssUrlTargets(css), ...cssImportTargets(css)]
                .filter(isRemoteTarget)
                .map((target) => file + ': ' + target);
        });
        expect(offenders, 'Emitted CSS fetches from outside the bundle.').toEqual([]);
    });

    it('no emitted file names a host the v1.2.1 renderer loaded from', () => {
        expect(emittedWith('.js').length, 'no JavaScript was emitted under ' + BUILT_DIR + ', so this scan would pass vacuously').toBeGreaterThan(0);
        const offenders = emitted
            .filter((file) => /\.(?:m?js|css|html)$/i.test(file))
            .flatMap((file) => {
                const text = read(file).toLowerCase();
                return V121_REMOTE_HOSTS.filter((host) => text.includes(host)).map((host) => file + ': ' + host);
            });
        expect(offenders, 'The bundle still references a v1.2.1 remote host.').toEqual([]);
    });

    it('the fonts are bundled: woff2 assets are emitted', () => {
        expect(emittedWith('.woff2').length, 'no .woff2 under ' + BUILT_DIR + ' - the fonts are not in the bundle').toBeGreaterThan(0);
    });

    it('Inter and Material Symbols resolve to font files inside the bundle', () => {
        const faces = emittedWith('.css').flatMap((file) =>
            fontFaces(stripCssComments(read(file))).map((face) => ({ ...face, file }))
        );
        for (const family of BUNDLED_FONT_FAMILIES) {
            const matching = faces.filter((face) => face.family === family);
            expect(matching.length, 'no @font-face for "' + family + '" in the emitted CSS').toBeGreaterThan(0);
            for (const face of matching) {
                expect(face.urls.length, '"' + family + '" has an @font-face with no url()').toBeGreaterThan(0);
                for (const target of face.urls) {
                    expect(isRemoteTarget(target), '"' + family + '" is fetched from ' + target).toBe(false);
                    if (target.startsWith('data:')) continue;
                    const onDisk = path.resolve(repoRoot, path.dirname(face.file), target.split(/[?#]/)[0] ?? '');
                    expect(fs.existsSync(onDisk), '"' + family + '" points at ' + target + ', which is not in the bundle').toBe(true);
                }
            }
        }
    });
});
