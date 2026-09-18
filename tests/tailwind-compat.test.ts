import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { compile } from '@tailwindcss/node';
import { Scanner } from '@tailwindcss/oxide';
import ts from 'typescript';
import { read, repoRoot, scriptKindFor, stripCommentsAndStrings } from './helpers/ts-imports';

/*
 * SPA-11, SPA-12 and criterion 3, checked against CSS Tailwind actually emitted (C3).
 *
 * v1.2.1 loaded the Tailwind Play CDN, which generates CSS by watching the live DOM: a class name that only exists
 * after `'bg-' + tone + '-100'` runs still got styled. Build-time Tailwind reads the SOURCE, never the DOM - so
 * those fourteen sites emit no CSS at all and the alert's icon circle loses its colour entirely. That failure is
 * invisible to typecheck, to lint and to every test that reads source text, which is why this file compiles the
 * real globals.css against the real renderer with Tailwind's own scanner and then asks the output.
 *
 * Deliberately NOT the build gate: this compiles in-process in about a second, so a concatenated class name fails
 * the ordinary test run. The negative control below is what makes the rest mean something - it shows Tailwind's
 * scanner missing a concatenated name while finding its literal neighbours.
 */

const STYLES_DIR = 'src/renderer/src/styles';
const GLOBALS = 'src/renderer/src/styles/globals.css';
const ALERT = 'src/renderer/src/components/ui/AlertDialog.tsx';
const TOASTS = 'src/renderer/src/components/ui/ToastStack.tsx';
const RENDERER_SRC = 'src/renderer/src';

// The maps criterion 3 names: four tones, each resolving to a whole class string rather than a built one.
const TONE_MAPS = ['CIRCLE_CLASS', 'GLYPH_CLASS'];
const TONES = ['info', 'success', 'warning', 'error'];

/*
 * The v3 spellings v4 kept alive as deprecated aliases that mean something else. `shadow-sm` and `rounded-sm` are
 * NOT here: those are the correct v4 spellings, and banning them would ban the sweep's own destination. What is
 * banned is the bare v3 form, which is what a block of markup copied out of legacy/ carries.
 */
const V3_SPELLINGS = ['rounded', 'shadow', 'ring', 'blur', 'drop-shadow', 'outline-none'];
const SWEPT_TO: Record<string, string> = {
    rounded: 'rounded-sm',
    shadow: 'shadow-sm',
    ring: 'ring-3',
    blur: 'blur-sm',
    'drop-shadow': 'drop-shadow-sm',
    'outline-none': 'outline-hidden'
};

interface Compiled {
    css: string;
    candidates: string[];
}

let compiled: Compiled;

/** The CSS escape Tailwind writes its selectors with: everything outside [A-Za-z0-9_-] is backslash-escaped. */
const selectorFor = (token: string): string => '.' + token.replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c);

const tracked = (...dirs: string[]): string[] =>
    execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', ...dirs], {
        cwd: repoRoot,
        encoding: 'utf8'
    })
        .split('\n')
        .map((line) => line.trim())
        .filter((file) => file !== '' && fs.existsSync(path.join(repoRoot, file)));

const rendererSources = (): string[] => tracked(RENDERER_SRC).filter((file) => /\.tsx?$/.test(file));

/** Every string literal in a file, by the parser rather than by a regex, so prose never reads as markup. */
const literalsOf = (file: string): string[] =>
    stripCommentsAndStrings(file, read(file)).strings.map((token) => token.value);

/** `const NAME: Record<Tone, string> = { info: '...', ... }` -> the four values, keyed by tone. */
function toneMap(name: string): Map<string, string> {
    const source = ts.createSourceFile(ALERT, read(ALERT), ts.ScriptTarget.Latest, true, scriptKindFor(ALERT));
    const found = new Map<string, string>();
    const visit = (node: ts.Node): void => {
        if (
            ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name &&
            node.initializer !== undefined && ts.isObjectLiteralExpression(node.initializer)
        ) {
            for (const property of node.initializer.properties) {
                if (ts.isPropertyAssignment(property) && ts.isStringLiteral(property.initializer)) {
                    found.set(property.name.getText(source), property.initializer.text);
                }
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
}

beforeAll(async () => {
    const base = path.join(repoRoot, STYLES_DIR);
    const compiler = await compile(read(GLOBALS), { base, onDependency: () => undefined });
    const candidates = new Scanner({ sources: compiler.sources }).scan();
    compiled = { css: compiler.build(candidates), candidates };
}, 60_000);

describe('C3: the classes the alert draws its icon circle with exist in the emitted CSS', () => {
    it('compiled something, so nothing below passes over an empty stylesheet', () => {
        expect(compiled.css.length, GLOBALS + ' compiled to nothing').toBeGreaterThan(10_000);
        expect(compiled.candidates.length, 'the scanner found no class names in ' + RENDERER_SRC)
            .toBeGreaterThan(100);
    });

    it.each(TONE_MAPS)('%s covers all four tones', (name) => {
        expect([...toneMap(name).keys()].sort(), ALERT + ' does not map every tone to a whole class string')
            .toEqual([...TONES].sort());
    });

    it.each(TONE_MAPS.flatMap((name) => TONES.map((tone) => ({ name, tone }))))(
        '$name.$tone is scanned and emitted, class by class',
        ({ name, tone }) => {
            const classes = (toneMap(name).get(tone) ?? '').split(/\s+/).filter((token) => token !== '');
            expect(classes.length, name + '.' + tone + ' is empty').toBeGreaterThan(0);

            const unscanned = classes.filter((token) => !compiled.candidates.includes(token));
            expect(
                unscanned,
                'Tailwind never saw these class names in the source, so they will have no CSS at runtime. That is ' +
                'C3: a name assembled at run time is a name the build cannot see.'
            ).toEqual([]);

            const unstyled = classes.filter((token) => !compiled.css.includes(selectorFor(token)));
            expect(
                unstyled,
                'these were scanned but no rule was emitted for them - a misspelt utility styles nothing and ' +
                'reports nothing'
            ).toEqual([]);
        }
    );

    it('draws the four circles in four different colours', () => {
        const circles = toneMap('CIRCLE_CLASS');
        const backgrounds = TONES.map((tone) => /\bbg-[a-z]+-\d+\b/.exec(circles.get(tone) ?? '')?.[0] ?? '');
        expect(backgrounds, 'a tone with no background colour has no icon circle').not.toContain('');
        expect(new Set(backgrounds).size, 'two tones share a colour, so the circle says less than it claims')
            .toBe(TONES.length);
    });
});

/*
 * Criterion 4, and the one class of failure this screen can have that nothing else here would see. The switch on
 * Settings is drawn by `peer-checked:` utilities rather than v1.2.1's `has-[:checked]:`, because the input has to
 * be the switch's own sibling for the row to be one label. A utility that emits no CSS leaves a switch that never
 * moves, with a checkbox behind it that works perfectly - the C3 failure wearing a different hat.
 */
describe('C3: the settings switch is styled in the state it has to show', () => {
    const TOGGLE = 'src/renderer/src/features/settings/components/SettingsToggle.tsx';
    /** `const NAME = 'a ' + 'b';` -> `a b`. Class lists here are written as adjacent literals over two lines. */
    const classConstant = (name: string): string => {
        const declaration = new RegExp(String.raw`const ${name}\s*=\s*([^;]+);`).exec(read(TOGGLE))?.[1] ?? '';
        return [...declaration.matchAll(/'([^']*)'/g)].map((match) => match[1] ?? '').join('');
    };
    // `peer` is a marker for the variants below it; it has no rule of its own and never had one.
    const tokensOf = (value: string): string[] =>
        value.split(/\s+/).filter((token) => token !== '' && token !== 'peer');

    it.each(['SWITCH_CLASS', 'KNOB_CLASS'])('%s is scanned and emitted, class by class', (name) => {
        const classes = tokensOf(classConstant(name));
        expect(classes.length, TOGGLE + ' no longer declares ' + name + ' as a class string').toBeGreaterThan(3);

        const unscanned = classes.filter((token) => !compiled.candidates.includes(token));
        expect(unscanned, 'Tailwind never saw these in the source, so they have no CSS at runtime').toEqual([]);

        const unstyled = classes.filter((token) => !compiled.css.includes(selectorFor(token)));
        expect(unstyled, 'these were scanned and no rule was emitted - a misspelt utility styles nothing').toEqual([]);
    });

    it('makes the knob move and the track colour depend on the checkbox, not on a class the app toggles', () => {
        const checked = tokensOf(classConstant('SWITCH_CLASS')).filter((token) => token.startsWith('peer-checked:'));
        expect(checked.length, 'the switch has no checked state at all').toBe(2);
        for (const token of checked) {
            const selector = compiled.css.split('\n').find((line) => line.includes(selectorFor(token))) ?? '';
            expect(
                selector,
                token + ' is emitted without a :checked selector, so the switch would never move'
            ).toContain(':checked');
        }
    });
});

/*
 * The control. If Tailwind's scanner returned every identifier it saw, every assertion above would pass whether or
 * not the maps existed - so the bug is reproduced here, in a directory nothing else reads, and shown to be missed.
 */
describe('C3: the same scanner misses a class name that is built rather than written', () => {
    it('finds the literal neighbours and not the concatenated name', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-c3-'));
        try {
            fs.writeFileSync(
                path.join(dir, 'Probe.tsx'),
                'const tone = \'fuchsia\';\n' +
                'export const built = <div className={`mx-auto bg-${tone}-100`} />;\n' +
                'export const joined = <div className={\'rounded-full bg-\' + tone + \'-100\'} />;\n'
            );
            const found = new Scanner({ sources: [{ base: dir, pattern: '**/*.tsx', negated: false }] }).scan();

            expect(found, 'the scanner read nothing at all, so this control proves nothing').toContain('mx-auto');
            expect(found).toContain('rounded-full');
            expect(
                found,
                'the scanner resolved a concatenated class name, which it cannot do - if this ever passes, the ' +
                'control has stopped controlling and the assertions above are worth less than they look.'
            ).not.toContain('bg-fuchsia-100');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    /*
     * WR-03: this used to restate the previous test and then assert that a scanner with no sources finds nothing,
     * which is a tautology. Neither line compiled bg-fuchsia-100, so 07-C-SUMMARY.md's claim - that the same name
     * written out literally WOULD have been styled - was not made anywhere. It compiles it now.
     */
    it('would style that name if it were written out, so the miss is about scanning and not about the colour', async () => {
        expect(compiled.css.includes(selectorFor('bg-fuchsia-100')),
            'the scanned build already carries the name, so the control below proves nothing').toBe(false);

        const compiler = await compile(read(GLOBALS), {
            base: path.join(repoRoot, STYLES_DIR),
            onDependency: () => undefined
        });
        const written = compiler.build(['bg-fuchsia-100']);

        expect(written, 'the colour is not in the palette at all, so the miss above was never about scanning')
            .toContain(selectorFor('bg-fuchsia-100'));
    }, 60_000);
});

/*
 * IN-02. dismissToast marks a row leaving and removeToast drops it EXIT_MS later, so if the constant and the
 * token's duration drift the toast either vanishes mid-animation or lingers as a transparent row that still holds
 * its slot in the stack. 07-E-SUMMARY.md names this as agreed by comment and untested; it is tested now.
 */
describe('the toast leaves exactly when its animation ends', () => {
    // tsconfig.node.json carries no jsx and no DOM lib, so a node test cannot import a .tsx - the value is read
    // out of the source, which is the same thing tone maps are read out of above.
    const constantOf = (name: string): number => {
        const raw = new RegExp('const ' + name + '\\s*=\\s*([0-9_]+)').exec(read(TOASTS))?.[1];
        expect(raw, TOASTS + ' no longer declares ' + name + ' as a plain number').toBeDefined();
        return Number((raw ?? '').replace(/_/g, ''));
    };

    it('holds EXIT_MS equal to the --animate-toast-out duration', () => {
        const token = /--animate-toast-out:\s*toast-out\s+(\d+)ms/.exec(read(GLOBALS))?.[1];
        expect(token, GLOBALS + ' no longer declares --animate-toast-out in ms').toBeDefined();
        const exit = constantOf('EXIT_MS');
        expect(
            exit,
            'ToastStack.tsx drops the row ' + String(exit) + ' ms after dismissal while the animation runs for ' +
            String(token) + ' ms - the row either vanishes mid-animation or lingers holding its slot'
        ).toBe(Number(token));
    });

    it('auto-dismisses after the dwell v1.2.1 used (IN-01)', () => {
        expect(constantOf('AUTO_DISMISS_MS'), 'legacy/renderer/shared.js:99 defaults duration to 3000').toBe(3_000);
    });
});

describe('SPA-12: the v4 compatibility layer restores what v3 rendered', () => {
    /*
     * Every @layer base block, not the first one. Tailwind emits Preflight in one and anything the stylesheet adds
     * to the layer in another, further down than the utilities - so a scan that stops at the first block reads
     * Preflight alone and reports that none of these restorations exist.
     */
    const baseLayer = (): string => {
        const bodies: string[] = [];
        for (const opening of compiled.css.matchAll(/@layer base\s*\{/g)) {
            let depth = 1;
            let i = (opening.index ?? 0) + opening[0].length;
            const start = i;
            while (i < compiled.css.length && depth > 0) {
                const ch = compiled.css[i];
                depth += ch === '{' ? 1 : ch === '}' ? -1 : 0;
                i += 1;
            }
            bodies.push(compiled.css.slice(start, i - 1));
        }
        expect(bodies.length, 'no base layer was emitted').toBeGreaterThan(0);
        return bodies.join('\n');
    };

    it('puts the border colour back to gray-200 instead of currentColor', () => {
        expect(
            baseLayer(),
            'v4 Preflight resets borders to currentColor. Every v1.2.1 border was drawn in gray-200, so without ' +
            'this every divider takes the colour of the text beside it.'
        ).toMatch(/border-color:\s*var\(--color-gray-200/);
        expect(compiled.css, '--color-gray-200 is referenced but never declared').toContain('--color-gray-200:');
    });

    it('puts the pointer cursor back on buttons', () => {
        expect(baseLayer(), 'v4 gives buttons the default arrow cursor').toMatch(/cursor:\s*pointer/);
    });

    it('puts the placeholder colour back to gray-400 at full opacity', () => {
        const base = baseLayer();
        expect(
            base,
            'v4 draws placeholders as the current text colour at 50%; v1.2.1 drew them in gray-400.'
        ).toMatch(/::placeholder\s*\{[^}]*color:\s*var\(--color-gray-400/);
        expect(base).toMatch(/::placeholder\s*\{[^}]*opacity:\s*1/);
        expect(compiled.css, '--color-gray-400 is referenced but never declared').toContain('--color-gray-400:');
    });

    it('draws ring-3 exactly as v3 drew ring: 3px of blue-500 at half opacity', async () => {
        const base = path.join(repoRoot, STYLES_DIR);
        const compiler = await compile(read(GLOBALS), { base, onDependency: () => undefined });
        const css = compiler.build(['ring-3']);
        expect(css, 'the width half of the sweep: v4 ring is 1px, v3 ring was 3px').toContain('calc(3px');
        expect(
            css,
            'the colour half: v4 defaults the ring to currentcolor. --default-ring-color in @theme is what puts ' +
            'v3\'s blue back, and it is the one of the four restorations that is not a Preflight rule.'
        ).toContain('rgb(59 130 246 / 0.5)');
    });
});

describe('SPA-12: the renamed utility scales are swept, and stay swept', () => {
    it.each(V3_SPELLINGS)('no class in the renderer is spelt %s', (spelling) => {
        const offenders: string[] = [];
        for (const file of rendererSources()) {
            for (const value of literalsOf(file)) {
                for (const token of value.split(/\s+/)) {
                    // Variants are part of the spelling: dark:shadow is the same mistake as shadow.
                    const utility = token.replace(/^(?:[^\s:]+:)*/, '');
                    if (utility === spelling) {
                        offenders.push(file + ': ' + token);
                    }
                }
            }
        }
        expect(
            offenders,
            'v4 kept ' + spelling + ' as a deprecated alias, so this renders without complaint and renders ' +
            'something else. Write ' + SWEPT_TO[spelling] + ' instead.'
        ).toEqual([]);
    });

    /*
     * The fifth rename, and the one with no wrong-looking output to give it away. v3's bg-gradient-to-* interpolated
     * in sRGB; v4 kept the spelling as an alias that interpolates in oklab, so a block of markup copied out of
     * legacy/ renders a visibly different gradient and nothing complains. The /srgb modifier on bg-linear-to-<dir>
     * is v4's way of asking for what v3 drew, and it is what every gradient in this renderer is written with.
     */
    it('asks for a gradient the way v3 drew one, not the way v4 renamed it', () => {
        const offenders: string[] = [];
        for (const file of rendererSources()) {
            for (const value of literalsOf(file)) {
                for (const token of value.split(/\s+/)) {
                    const utility = token.replace(/^(?:[^\s:]+:)*/, '');
                    if (/^bg-gradient-to-/.test(utility)) offenders.push(file + ': ' + token);
                }
            }
        }
        expect(
            offenders,
            'v4 keeps bg-gradient-to-* alive and interpolates it in oklab; v3 interpolated in sRGB. Write ' +
            'bg-linear-to-<dir>/srgb, which is the same gradient v1.2.1 rendered.'
        ).toEqual([]);
    });

    it('emits sRGB interpolation for the spelling the renderer uses, and oklab for the one it does not', async () => {
        const base = path.join(repoRoot, STYLES_DIR);
        const compiler = await compile(read(GLOBALS), { base, onDependency: () => undefined });
        const css = compiler.build(['bg-linear-to-br/srgb', 'bg-gradient-to-br']);
        expect(css, 'the /srgb modifier no longer asks for sRGB, so the parity claim above is empty')
            .toContain('in srgb');
        expect(css, 'bg-gradient-to-br no longer means oklab, so the ban above guards nothing')
            .toContain('in oklab');
    }, 60_000);

    /*
     * The half of the rename table the ban above cannot express, found while porting Home (08-C).
     *
     * v4 renamed the BOTTOM of four scales as well as the bare spelling: v3's `shadow-sm` is v4's `shadow-xs`, v3's
     * `rounded-sm` is v4's `rounded-xs`, and the same for blur and backdrop-blur. So markup copied out of legacy/
     * that already said `shadow-sm` renders one step LARGER, with nothing to catch it - `shadow-sm` is also where
     * the sweep sends the bare `shadow`, so it cannot be banned. It is swept by hand and pinned here: the values
     * are read out of real Tailwind. Legacy carried 26 `shadow-sm` and 14 `backdrop-blur-sm`; six had reached v2.
     */
    it('knows that v4 renamed the bottom of the shadow, blur and radius scales too', async () => {
        const base = path.join(repoRoot, STYLES_DIR);
        const compiler = await compile(read(GLOBALS), { base, onDependency: () => undefined });
        const pairs = [['shadow-xs', 'shadow-sm'], ['rounded-xs', 'rounded-sm'], ['backdrop-blur-xs', 'backdrop-blur-sm']];
        const css = compiler.build(pairs.flat());

        for (const [v4, v3] of pairs) {
            const emitted = (token: string): string =>
                css.split(selectorFor(String(token)) + ' {')[1]?.split('}')[0] ?? '';
            expect(emitted(String(v4)), String(v4) + ' emitted nothing, so the sweep sent these classes nowhere')
                .not.toBe('');
            expect(
                emitted(String(v4)),
                String(v3) + ' and ' + String(v4) + ' render the same, so copying ' + String(v3) +
                ' out of legacy/ would be harmless and this sweep would be pointless'
            ).not.toBe(emitted(String(v3)));
        }
    }, 60_000);

    it('keeps the swept spellings in the renderer, so a later copy-paste cannot quietly undo it', () => {
        const tokens = rendererSources().flatMap((file) => literalsOf(file).flatMap((value) => value.split(/\s+/)));
        for (const spelling of ['shadow-xs', 'backdrop-blur-xs']) {
            expect(tokens, spelling + ' is gone from the renderer, so a v3 spelling has come back').toContain(spelling);
        }
    });

    it('scans files that actually carry class names, so the sweep is not vacuous', () => {
        const withClasses = rendererSources()
            .filter((file) => literalsOf(file).some((value) => /\b(?:flex|text-|bg-|rounded-)/.test(value)));
        expect(withClasses.length, 'no renderer source carries a class name at all').toBeGreaterThan(3);
    });
});

/*
 * ARCH-05's third clause. The first two - one .css file, no CSS module - are asserted in
 * tests/renderer-structure.test.ts against the tree. This one is about what is INSIDE the one stylesheet: a
 * per-component class rule there is the same thing as a second stylesheet, only harder to find.
 */
/*
 * The category of regression the deleted global stylesheet left behind.
 *
 * legacy/styles/common.css:8-15 hid scrollbars for the WHOLE document, so nothing in v1.2.1 ever drew one and no
 * page had to ask. ARCH-05 deleted that file and the cutover replaced it in exactly one place - AppShell's content
 * area - which left every dialog drawing a raw Windows scrollbar down a dark panel, and the filter panel's inner
 * company list doing the same inside it. Two of the three scroll containers in the renderer, from one deleted rule.
 *
 * So the replacement is not "remember to add the pair": it is this, which fails on the next scroll container that
 * forgets. Adjacent string literals are collapsed first, or a constant split across two lines reads as two lists.
 */
describe('ARCH-05: a scroll container hides its scrollbar, as the deleted global rule did', () => {
    const SCROLLS = /(?:^|\s)overflow(?:-[xy])?-(?:auto|scroll)(?:\s|$)/;
    const HIDES = ['[scrollbar-width:none]', '[&::-webkit-scrollbar]:hidden'];
    /** `'a ' + 'b'` is one class list written on two lines; the source says so and the scanner reads it that way. */
    const CLASS_JOIN = /'\s*\+\s*'/g;

    const classListsOf = (file: string): string[] =>
        stripCommentsAndStrings(file, read(file).replace(CLASS_JOIN, '')).strings.map((token) => token.value);

    it('leaves no scroll container in the renderer without both hiding utilities', () => {
        const offenders: string[] = [];
        let containers = 0;
        for (const file of rendererSources()) {
            for (const classes of classListsOf(file)) {
                if (!SCROLLS.test(classes)) continue;
                containers += 1;
                const missing = HIDES.filter((utility) => !classes.includes(utility));
                if (missing.length > 0) offenders.push(file + ': ' + classes.trim() + ' (missing ' + missing.join(' ') + ')');
            }
        }
        expect(containers, 'no scroll container was found at all, so this scan proves nothing').toBeGreaterThan(2);
        expect(
            offenders,
            'v1.2.1 hid every scrollbar from one global rule in legacy/styles/common.css. ARCH-05 deleted that ' +
            'file, so each scroll container carries the pair itself - or the user gets a bright native scrollbar ' +
            'down a dark panel.'
        ).toEqual([]);
    });

    it('would see one that forgot, so the scan is not passing on a pattern that never matches', () => {
        expect(SCROLLS.test('max-h-40 overflow-y-auto pr-2')).toBe(true);
        expect(SCROLLS.test('flex-1 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden')).toBe(true);
        expect(SCROLLS.test('overflow-hidden flex flex-col'), 'overflow-hidden does not scroll').toBe(false);
        expect(SCROLLS.test('truncate overflow-ellipsis')).toBe(false);
    });
});

describe('ARCH-05: globals.css declares tokens, not components', () => {
    /** The file with comments removed, so a rule quoted in prose is not read as a rule. */
    const css = (): string => read(GLOBALS).replace(/\/\*[\s\S]*?\*\//g, '');
    /** And with quoted strings blanked, so @import "@fontsource-variable/inter" is not read as an at-rule. */
    const statements = (): string => css().replace(/"[^"]*"|'[^']*'/g, '""');

    it('defines no class of its own', () => {
        const selectors = [...css().matchAll(/(^|[},])\s*(\.[A-Za-z][^{;]*)\{/g)].map((m) => (m[2] ?? '').trim());
        expect(
            selectors,
            'a class rule here is a per-component class. Values Tailwind cannot express become @theme tokens; ' +
            'everything else is a utility on the component (ARCH-05).'
        ).toEqual([]);
    });

    it('uses no @apply', () => {
        expect(
            css(),
            '@apply is how a utility framework grows a second vocabulary of component classes.'
        ).not.toContain('@apply');
    });

    it('carries only the at-rules ARCH-05 allows it', () => {
        const ALLOWED = new Set(['import', 'plugin', 'source', 'custom-variant', 'theme', 'keyframes', 'layer']);
        const used = [...statements().matchAll(/@([a-z-]+)/g)].map((m) => m[1] ?? '');
        expect([...new Set(used)].filter((name) => !ALLOWED.has(name))).toEqual([]);
    });

    it('styles nothing with an inline style attribute', () => {
        const offenders = rendererSources()
            .filter((file) => /\bstyle\s*=\s*\{/.test(stripCommentsAndStrings(file, read(file)).code));
        expect(
            offenders,
            'an inline style is a per-component rule with no stylesheet to put it in. If Tailwind cannot express ' +
            'the value, it becomes an @theme token (ARCH-05).'
        ).toEqual([]);
    });
});
