import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
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
// The whole build, not just the renderer: criterion 10 is about what ships, and main and preload ship too.
const BUILT_ROOT = 'out';
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

/*
 * The name of the @layer block enclosing a position in a stylesheet, or null when it is unlayered.
 * Unlayered beats layered in the cascade, which is the whole point of the assertion that uses it.
 */
const enclosingLayer = (css: string, at: number): string | null => {
    const open: (string | null)[] = [];
    for (let i = 0; i < at; i += 1) {
        if (css[i] === '{') {
            const head = css.slice(Math.max(0, i - 120), i);
            const layer = /@layer\s+([A-Za-z0-9_-]+)\s*$/.exec(head);
            open.push(layer === null ? null : layer[1] ?? null);
        } else if (css[i] === '}') {
            open.pop();
        }
    }
    for (let i = open.length - 1; i >= 0; i -= 1) {
        const name = open[i];
        if (name !== undefined && name !== null) return name;
    }
    return null;
};

/* What v1.2.1 wrote on <body>, and what #modal-root has no other way to inherit. */
const BODY_CLASSES = [
    'dark:bg-background-dark', 'font-display', 'dark:text-white', 'antialiased', 'selection:bg-primary/30'
];

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
            builtHtml.includes(declared[0] ?? '<no meta csp declared>'),
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

    /*
     * Criterion 10, said in the two shapes the criterion itself names. The scans above already forbid a remote
     * url() or @import in emitted CSS and the four v1.2.1 hosts in emitted code; these two are the same ban
     * widened to the WHOLE build and narrowed to the exact spellings that were in the shipped app, so a reader
     * checking the criterion against the suite finds it stated rather than implied.
     */
    it('no file anywhere in ' + BUILT_ROOT + ' names cdn.tailwindcss.com', () => {
        const offenders = walk(path.join(repoRoot, BUILT_ROOT))
            .filter((file) => /\.(?:m?js|css|html|json|map)$/i.test(file))
            .filter((file) => read(file).toLowerCase().includes('cdn.tailwindcss.com'));
        expect(
            offenders,
            'The Tailwind Play CDN is back in the build. It needs the network at runtime, and admitting its ' +
            'origin to script-src is what makes a meaningful CSP impossible (S3).'
        ).toEqual([]);
    });

    it('no emitted stylesheet carries an @import of an http(s) address', () => {
        const offenders = walk(path.join(repoRoot, BUILT_ROOT))
            .filter((file) => file.toLowerCase().endsWith('.css'))
            .flatMap((file) => cssImportTargets(stripCssComments(read(file)))
                .filter((target) => isRemoteTarget(target) && !target.trim().startsWith('data:'))
                .map((target) => file + ': ' + target));
        expect(
            offenders,
            "legacy/styles/common.css opened with two @import url('https://fonts.googleapis.com/...') lines. " +
            'Offline, each one silently loaded nothing and every Material Symbol rendered as its own name (S4).'
        ).toEqual([]);
    });

    it('SPA-10: the notification sound is emitted into the bundle and referenced from it', () => {
        const sounds = emittedWith('.mp3');
        expect(sounds.length, 'no .mp3 under ' + BUILT_DIR + ' - the notification sound is not in the bundle')
            .toBeGreaterThan(0);
        const names = sounds.map((file) => path.posix.basename(file));
        const referenced = emittedWith('.js').some((file) => {
            const code = read(file);
            return names.some((name) => code.includes(name));
        });
        expect(
            referenced,
            'the sound was emitted but nothing in the bundle names it, so the import that fingerprints it is gone ' +
            'and whatever plays it is back on a relative path (B3).'
        ).toBe(true);
    });

    /*
     * WR-06. 07-E-SUMMARY.md says twice that these were checked in the emitted CSS - the width token because
     * AppShell and BottomNav are supposed to read one width, the keyframes because "@keyframes inside a @theme
     * static block is the kind of thing that is easy to assume and easy to be wrong about". Nothing asserted
     * either. A @theme namespace typo - --width-app instead of --container-app, --animation-* instead of
     * --animate-* - emits no rule at all, breaks the layout and the motion, and passes the whole suite. That is
     * the C3 failure mode reappearing on the tokens slice E introduced.
     */
    it('the one width token and the motion tokens produced rules', () => {
        const css = emittedWith('.css').map(read).join('\n');
        expect(css.length, 'no CSS was emitted, so this scan would pass vacuously').toBeGreaterThan(1000);

        /*
         * `md:max-w-app` was here until 08-B: the bar centred itself at md and spanned the window below it, so
         * between 28rem and 48rem a narrow column sat above an edge-to-edge bar. It reads max-w-app at every width
         * now, and the variant that no longer exists cannot be asserted - the guard is the bare token.
         *
         * The six streak tokens are 08-C's, and they are here for the reason the three motion ones are: a @theme
         * namespace typo emits no rule at all, and a streak card that simply does not animate looks like a streak
         * below the tier threshold rather than like a bug.
         */
        const utilities = [
            'max-w-app', 'animate-toast-in', 'animate-toast-out', 'animate-modal-in',
            'animate-streak-glow', 'animate-streak-pulse', 'animate-streak-pulse-quick',
            'animate-streak-shimmer', 'animate-streak-fire', 'animate-streak-flicker'
        ];
        for (const utility of utilities) {
            expect(css, utility + ' emitted no rule - the token it reads is misspelt or missing')
                .toContain('.' + utility.replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c));
        }
        const keyframes = [
            'toast-in', 'toast-out', 'modal-in',
            'streak-pulse', 'streak-glow-pulse', 'streak-shimmer', 'fire-bg', 'fire-border', 'fire-flicker'
        ];
        for (const frames of keyframes) {
            expect(css, '@keyframes ' + frames + ' is not in the emitted CSS, so the animation names nothing')
                .toContain('@keyframes ' + frames);
        }
    });

    /*
     * 08-F, found by the Phase 1 computed-style baselines. material-symbols/outlined.css declares
     * `.material-symbols-outlined { font-size: 24px; line-height: 1; letter-spacing: normal }`. An UNLAYERED rule
     * outranks every rule in a cascade layer, so while globals.css imported it bare it beat Tailwind's utilities
     * layer and EVERY icon in the app rendered at 24px whatever its class said - the 48px streak glyph at half
     * size, the 12px and 14px list glyphs at nearly double. v1.2.1 never had this: the Play CDN generated its
     * utilities after the Google Fonts @import, so the utility won on order.
     *
     * The compat test compiles the classes and proves the CSS is emitted; that is a different claim from the CSS
     * winning. This asserts the layer, which is the thing that decides.
     */
    it('the icon stylesheet is imported into a layer, so a size utility still wins', () => {
        const sheets = emittedWith('.css').map(read);
        const css = sheets.join('\n');
        expect(css, 'the icon class is not in the emitted CSS at all').toContain('.material-symbols-outlined');

        for (const sheet of sheets) {
            const at = sheet.indexOf('.material-symbols-outlined {');
            if (at === -1) continue;
            const layer = enclosingLayer(sheet, at);
            expect(
                layer,
                'the .material-symbols-outlined rule is ' +
                (layer === null ? 'UNLAYERED' : 'in @layer ' + layer) +
                ', so it outranks Tailwind\'s utilities and every icon renders at its 24px default. ' +
                'Import it as `@import "material-symbols/outlined.css" layer(base);`'
            ).toBe('base');
        }

        /* A negative control: the reader must be able to see the check fail on the shape it is looking for. */
        expect(enclosingLayer('.material-symbols-outlined { font-size: 24px }', 0)).toBe(null);
        expect(enclosingLayer('@layer utilities { .material-symbols-outlined { font-size: 24px } }', 18)).toBe('utilities');

        /* And the utilities it has to beat are actually emitted - otherwise the layer claim is vacuous. */
        for (const size of ['28px', '22px', '18px', '12px', '10px']) {
            expect(css, 'no text-[' + size + '] rule was emitted, so nothing needs to outrank the icon default')
                .toContain('.text-' + String.fromCharCode(92) + '[' + size + String.fromCharCode(92) + ']');
        }
    });

    /*
     * 08-F. #modal-root is a SIBLING of #root, so every dialog portals outside #app-shell - and the font, text
     * colour and antialiasing that AppShell carries never reach one. Every modal in the app was rendering in
     * Chromium's default font. v1.2.1 put these on <body> (legacy/pages/*.html) and appended its modals to
     * document.body, so it never had the problem; the classes are back on <body> for the same reason.
     */
    it('the entry document carries on <body> what v1.2.1 carried there, so a portalled dialog inherits it', () => {
        for (const [label, file] of [['source', SOURCE_ENTRY], ['built', BUILT_ENTRY]] as const) {
            const body = read(file).match(/<body[^>]*class="([^"]*)"/);
            expect(body, label + ' entry has no class on <body>').not.toBeNull();
            const classes = (body?.[1] ?? '').split(/\s+/);
            for (const required of BODY_CLASSES) {
                expect(classes, label + ' <body> lost `' + required + '`, which #modal-root inherits from nowhere else')
                    .toContain(required);
            }
        }
    });


    /*
     * Phase 10 criterion 8, first half: "a CI bundle grep proves the production renderer chunk contains no zod".
     *
     * tests/zod-boundary.test.ts already walks the import graph from the renderer entry and refuses any value
     * chain that reaches zod. This is the other end of the same claim, and it is the one the criterion asks for:
     * what the BUNDLER actually emitted. A graph walk can be defeated by a resolution this project's aliases do
     * not model; the emitted bytes cannot.
     *
     * The negative control is what makes it a check rather than a hopeful grep: the same markers are REQUIRED to
     * appear in the main-process bundle, which legitimately validates every IPC payload with zod. A marker list
     * that had gone stale - a zod release that stopped emitting these strings - would fail there first, loudly,
     * instead of reporting a clean renderer forever.
     */
    const ZOD_MARKERS = ['ZodError', 'ZodRealError', 'invalid_union', 'unrecognized_keys', '$ZodType'];
    const MAIN_BUNDLE_DIR = 'out/main';

    it('the production renderer chunk contains no zod', () => {
        const scripts = emittedWith('.js');
        expect(scripts.length, 'no JavaScript was emitted, so this grep would pass vacuously').toBeGreaterThan(0);
        const found: string[] = [];
        for (const file of scripts) {
            const source = read(file);
            for (const marker of ZOD_MARKERS) {
                if (source.includes(marker)) found.push(file + ' contains ' + marker);
            }
        }
        expect(found, 'zod reached the renderer bundle:\n  ' + found.join('\n  ')).toEqual([]);
    });

    it('the same grep finds zod in the main bundle, where it belongs', () => {
        const scripts = walk(path.join(repoRoot, MAIN_BUNDLE_DIR)).filter((file) => file.endsWith('.js'));
        expect(scripts.length, 'no main-process JavaScript was emitted, so the control proves nothing')
            .toBeGreaterThan(0);
        const main = scripts.map(read).join('\n');
        for (const marker of ZOD_MARKERS) {
            expect(
                main.includes(marker),
                marker + ' is absent from the main bundle too, so the renderer grep above is meaningless - ' +
                'either zod stopped emitting it or main stopped validating'
            ).toBe(true);
        }
    });

    /*
     * Phase 10 criterion 8, second half, on the build output: no duplicate asset.
     *
     * The titlebar used to import the 1024x1024 icon.png, so Vite fingerprinted a second copy of a 1.84 MB file
     * into out/renderer beside the one out/main already needs for the tray - two identical megabytes in every
     * installer. The check is on CONTENT, not on name: a fingerprinted copy has a different name by construction,
     * which is exactly why a name-based check would not have caught it.
     */
    /*
     * One duplicate stands, with its reason, and nothing else may join it. main and renderer are separate rollup
     * builds with separate output directories, so an asset both of them import is emitted into both: the titlebar
     * draws the logo and the notification adapter passes it to Windows. 8.5 KB twice is the price of that
     * separation and it is stated here rather than waved through by a size threshold - which would also have
     * waved through the 1.84 MB copy this check was written to catch.
     */
    const PERMITTED_DUPLICATES: { files: string[]; why: string }[] = [
        {
            files: ['out/main/chunks', 'out/renderer/assets'],
            why: 'src/assets/icon-64.png: the titlebar imports it in the renderer build and the notification ' +
                'adapter imports it in the main build, and the two builds emit into separate directories'
        }
    ];
    const permits = (files: readonly string[]): boolean =>
        PERMITTED_DUPLICATES.some((entry) =>
            files.length === entry.files.length &&
            entry.files.every((dir, index) => files[index]?.startsWith(dir + '/') === true) &&
            new Set(files.map((file) => path.basename(file))).size === 1);

    it('ships no duplicate asset that is not registered with a reason', () => {
        const byDigest = new Map<string, string[]>();
        for (const file of walk(path.join(repoRoot, BUILT_ROOT))) {
            const digest = createHash('sha256').update(fs.readFileSync(path.join(repoRoot, file))).digest('hex');
            byDigest.set(digest, [...(byDigest.get(digest) ?? []), file]);
        }
        const duplicated = [...byDigest.values()].filter((files) => files.length > 1);
        const unexplained = duplicated.filter((files) => !permits(files));
        expect(unexplained, 'the same bytes are shipped more than once, with no reason given:\n  ' +
            unexplained.map((files) => files.join(' == ')).join('\n  ')).toEqual([]);

        // The register cannot outlive what it excuses: every entry must still name a duplicate that exists.
        for (const entry of PERMITTED_DUPLICATES) {
            expect(
                duplicated.some((files) => permits(files)),
                'a permitted duplicate no longer exists, so the entry is stale: ' + entry.why
            ).toBe(true);
        }
    });

    it('ships no megabyte twice, whatever the register says', () => {
        // The bound the register must never be widened past. The defect this replaced was two copies of a
        // 1.84 MB PNG; a permitted duplicate that grew to that size would still be the same defect.
        const MAX_DUPLICATED_BYTES = 64_000;
        const byDigest = new Map<string, string[]>();
        for (const file of walk(path.join(repoRoot, BUILT_ROOT))) {
            const digest = createHash('sha256').update(fs.readFileSync(path.join(repoRoot, file))).digest('hex');
            byDigest.set(digest, [...(byDigest.get(digest) ?? []), file]);
        }
        for (const files of [...byDigest.values()].filter((group) => group.length > 1)) {
            const bytes = fs.statSync(path.join(repoRoot, files[0] ?? '')).size;
            expect(bytes, files.join(' == ') + ' is duplicated at ' + bytes + ' bytes')
                .toBeLessThanOrEqual(MAX_DUPLICATED_BYTES);
        }
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
