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
 * after `'bg-' + tone + '-100'` runs still got styled, because the CDN saw the element after the concatenation.
 * Build-time Tailwind does the opposite - it reads the SOURCE, never the DOM - so those fourteen sites emit no CSS
 * at all and the alert's icon circle loses its colour entirely. That failure is invisible to typecheck, to lint and
 * to every test that reads source text, which is why this file compiles the real globals.css against the real
 * renderer with Tailwind's own scanner and then asks the output.
 *
 * It is deliberately NOT the build gate. `npm run build` would prove the same thing, but only where a build has
 * run; this compiles in-process in about a second, so a concatenated class name fails the ordinary test run.
 *
 * The negative control below is the part that makes the rest mean something: it puts a concatenated class name in
 * a throwaway file and shows Tailwind's scanner missing it while finding its literal neighbours. Without it, every
 * assertion here could pass over a scanner that simply returns everything.
 */

const STYLES_DIR = 'src/renderer/src/styles';
const GLOBALS = 'src/renderer/src/styles/globals.css';
const ALERT = 'src/renderer/src/components/ui/AlertDialog.tsx';
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
     * which is a tautology. Neither line compiled bg-fuchsia-100, so the claim 07-C-SUMMARY.md made for it - that
     * the same name written out literally WOULD have been styled - was not made anywhere. It compiles it now, so
     * the day Tailwind drops a colour from its palette this control fails instead of passing while meaning
     * nothing.
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
