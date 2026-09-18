// D-21: electron-vite, both split tsconfigs and vitest declare the same aliases, and every build alias is anchored
// to its own config file's directory (IN-04), so a build started from another directory resolves the same folders.

import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { aliasAnchors, read, readAliases } from './helpers/ts-imports';

const ELECTRON_CONFIG = 'electron.vite.config.ts';
const VITEST_CONFIG = 'vitest.config.mts';
const NODE_TSCONFIG = 'tsconfig.node.json';
const WEB_TSCONFIG = 'tsconfig.web.json';

const EXPECTED = {
    main: { '@main': 'src/main', '@lib': 'src/lib', '@shared': 'src/shared' },
    preload: { '@shared': 'src/shared' },
    renderer: { '@renderer': 'src/renderer/src', '@assets': 'src/assets', '@shared': 'src/shared' }
};
type Target = keyof typeof EXPECTED;
const TARGETS = Object.keys(EXPECTED) as Target[];

const electronAliases = (target: Target): Record<string, string> =>
    Object.fromEntries(readAliases(ELECTRON_CONFIG, [target, 'resolve', 'alias']));
const vitestAliases = (): Record<string, string> => Object.fromEntries(readAliases(VITEST_CONFIG, ['resolve', 'alias']));

interface TsconfigPaths {
    aliases: Record<string, string>;
    multiTarget: string[];
    options: Record<string, unknown>;
}

// `"@x/*": ["./src/x/*"]` becomes `@x -> src/x`, the form the build aliases are compared in.
function tsconfigPaths(rel: string): TsconfigPaths {
    const options = (JSON.parse(read(rel)) as { compilerOptions?: Record<string, unknown> }).compilerOptions ?? {};
    const paths = (options['paths'] ?? {}) as Record<string, string[]>;
    const aliases: Record<string, string> = {};
    const multiTarget: string[] = [];
    for (const [key, targets] of Object.entries(paths)) {
        if (targets.length !== 1) {
            multiTarget.push(key);
        }
        const target = (targets[0] ?? '').replace(/\/\*$/, '').replace(/^\.\//, '');
        aliases[key.replace(/\/\*$/, '')] = path.posix.normalize(target);
    }
    return { aliases, multiTarget, options };
}

describe('D-21: one alias set, declared for electron-vite, both tsconfigs and vitest', () => {
    it.each(TARGETS)(ELECTRON_CONFIG + ' declares exactly the D-21 aliases for the %s target', (target) => {
        expect(electronAliases(target), ELECTRON_CONFIG + ' ' + target + '.resolve.alias drifted from D-21')
            .toEqual(EXPECTED[target]);
    });

    /*
     * The node config covers tests/ as well as main and preload, and the suite now loads renderer modules too
     * (SPA-05 is proved by running the renderer's query objects, not by reading them). So it resolves every alias
     * the build declares - the same union vitest does, since the two have to agree about what a specifier means.
     */
    it(NODE_TSCONFIG + ' paths equal the union of the electron-vite aliases', () => {
        expect(
            tsconfigPaths(NODE_TSCONFIG).aliases,
            NODE_TSCONFIG + ' paths disagree with the build, so tsc resolves a different folder than the bundle (D-21)'
        ).toEqual({ ...electronAliases('main'), ...electronAliases('preload'), ...electronAliases('renderer') });
    });

    it(NODE_TSCONFIG + ' and ' + VITEST_CONFIG + ' resolve the same set', () => {
        expect(
            vitestAliases(),
            'vitest and tsc must agree, or a specifier typechecks against one folder and runs against another'
        ).toEqual(tsconfigPaths(NODE_TSCONFIG).aliases);
    });

    it(WEB_TSCONFIG + ' paths equal the electron-vite renderer aliases', () => {
        expect(
            tsconfigPaths(WEB_TSCONFIG).aliases,
            WEB_TSCONFIG + ' paths disagree with the build, so tsc resolves a different folder than the bundle (D-21)'
        ).toEqual(electronAliases('renderer'));
    });

    it.each([NODE_TSCONFIG, WEB_TSCONFIG])('%s gives every alias one target and sets no baseUrl or verbatimModuleSyntax', (rel) => {
        const { multiTarget, options } = tsconfigPaths(rel);
        expect(multiTarget, rel + ': a paths entry with fallback targets can resolve where the build does not (D-21)')
            .toEqual([]);
        expect('baseUrl' in options, rel + ': baseUrl is unneeded and widens bare-specifier resolution (D-21)').toBe(false);
        expect(
            'verbatimModuleSyntax' in options,
            rel + ': verbatimModuleSyntax compiles an all-inline type import into a runtime import (D-21)'
        ).toBe(false);
    });

    /*
     * Every target's aliases, not main's alone. Until SPA-05 the suite only ever loaded main and shared modules; it
     * now runs the renderer's query objects through a real QueryClient, and those import @renderer. The union is
     * stated as a rule rather than as a list so it cannot drift: whatever the build resolves, vitest resolves.
     */
    it(VITEST_CONFIG + ' aliases equal the union of the electron-vite aliases', () => {
        expect(vitestAliases(), VITEST_CONFIG + ' resolves aliases differently from the build (D-21)')
            .toEqual({ ...electronAliases('main'), ...electronAliases('preload'), ...electronAliases('renderer') });
    });
});

describe('IN-04: every build alias is anchored to its own config file', () => {
    it.each(TARGETS)(ELECTRON_CONFIG + ' resolves every %s alias from __dirname', (target) => {
        expect(
            aliasAnchors(ELECTRON_CONFIG, [target, 'resolve', 'alias']),
            ELECTRON_CONFIG + ' ' + target + ': an alias not anchored at __dirname follows the working directory (IN-04)'
        ).toEqual(Object.keys(EXPECTED[target]).map(() => '__dirname'));
    });

    it(VITEST_CONFIG + ' resolves every alias from import.meta.dirname', () => {
        const anchors = aliasAnchors(VITEST_CONFIG, ['resolve', 'alias']);
        expect(anchors.length, VITEST_CONFIG + ' declares no aliases at all').toBeGreaterThan(0);
        expect(
            anchors,
            VITEST_CONFIG + ': an alias not anchored at import.meta.dirname follows the working directory (IN-04)'
        ).toEqual(anchors.map(() => 'import.meta.dirname'));
    });
});
