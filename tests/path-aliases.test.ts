// D-21: electron-vite, both split tsconfigs and vitest declare the same aliases, and every build alias is anchored
// to its own config file's directory (IN-04), so a build started from another directory resolves the same folders.

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const ELECTRON_CONFIG = 'electron.vite.config.ts';
const VITEST_CONFIG = 'vitest.config.mts';
const NODE_TSCONFIG = 'tsconfig.node.json';
const WEB_TSCONFIG = 'tsconfig.web.json';

const EXPECTED = {
    main: { '@main': 'src/main', '@lib': 'src/lib', '@shared': 'src/shared' },
    preload: { '@shared': 'src/shared' },
    renderer: { '@renderer': 'src/renderer/src', '@shared': 'src/shared' }
};
type Target = keyof typeof EXPECTED;
const TARGETS = Object.keys(EXPECTED) as Target[];

interface AliasCall {
    dir: string;
    anchor: string;
}

const propertyNameText = (name: ts.PropertyName | undefined): string | undefined =>
    name !== undefined && (ts.isIdentifier(name) || ts.isStringLiteral(name)) ? name.text : undefined;

function readAliasCalls(configFile: string, objectPath: readonly string[]): Map<string, AliasCall> {
    const sourceFile = ts.createSourceFile(configFile, read(configFile), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const unreadable = (what: string): Error =>
        new Error(configFile + ': ' + what + '; teach readAliasCalls in tests/path-aliases.test.ts this shape');

    const calls: ts.CallExpression[] = [];
    const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'defineConfig') {
            calls.push(node);
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    const config = calls[0]?.arguments[0];
    if (calls.length !== 1 || config === undefined || !ts.isObjectLiteralExpression(config)) {
        throw unreadable('expected exactly one defineConfig({ ... }) call');
    }

    let object: ts.ObjectLiteralExpression = config;
    for (const name of objectPath) {
        if (object.properties.some(ts.isSpreadAssignment)) {
            throw unreadable('a spread sits beside `' + name + '`');
        }
        const property = object.properties.find((p) => propertyNameText(p.name) === name);
        if (property === undefined || !ts.isPropertyAssignment(property) || !ts.isObjectLiteralExpression(property.initializer)) {
            throw unreadable('`' + objectPath.join('.') + '` is not a chain of plain object literals');
        }
        object = property.initializer;
    }

    const aliases = new Map<string, AliasCall>();
    for (const property of object.properties) {
        const key = propertyNameText(property.name);
        const value = ts.isPropertyAssignment(property) ? property.initializer : undefined;
        const [anchor, dir] = value !== undefined && ts.isCallExpression(value) && ts.isIdentifier(value.expression) &&
            value.expression.text === 'resolve' && value.arguments.length === 2 ? value.arguments : [];
        if (key === undefined || anchor === undefined || dir === undefined || !ts.isStringLiteral(dir)) {
            throw unreadable('alias `' + property.getText(sourceFile) + '` is not `key: resolve(anchor, \'dir\')`');
        }
        aliases.set(key, { dir: path.posix.normalize(dir.text), anchor: anchor.getText(sourceFile) });
    }
    return aliases;
}

const dirsOf = (calls: Map<string, AliasCall>): Record<string, string> =>
    Object.fromEntries([...calls].map(([key, call]) => [key, call.dir]));
const electronAliases = (target: Target): Map<string, AliasCall> =>
    readAliasCalls(ELECTRON_CONFIG, [target, 'resolve', 'alias']);
const vitestAliases = (): Map<string, AliasCall> => readAliasCalls(VITEST_CONFIG, ['resolve', 'alias']);

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
        expect(dirsOf(electronAliases(target)), ELECTRON_CONFIG + ' ' + target + '.resolve.alias drifted from D-21')
            .toEqual(EXPECTED[target]);
    });

    it(NODE_TSCONFIG + ' paths equal the electron-vite main and preload aliases', () => {
        expect(
            tsconfigPaths(NODE_TSCONFIG).aliases,
            NODE_TSCONFIG + ' paths disagree with the build, so tsc resolves a different folder than the bundle (D-21)'
        ).toEqual({ ...dirsOf(electronAliases('main')), ...dirsOf(electronAliases('preload')) });
    });

    it(WEB_TSCONFIG + ' paths equal the electron-vite renderer aliases', () => {
        expect(
            tsconfigPaths(WEB_TSCONFIG).aliases,
            WEB_TSCONFIG + ' paths disagree with the build, so tsc resolves a different folder than the bundle (D-21)'
        ).toEqual(dirsOf(electronAliases('renderer')));
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

    it(VITEST_CONFIG + ' aliases equal the electron-vite main aliases', () => {
        expect(dirsOf(vitestAliases()), VITEST_CONFIG + ' resolves aliases differently from the main build (D-21)')
            .toEqual(dirsOf(electronAliases('main')));
    });
});

describe('IN-04: every build alias is anchored to its own config file', () => {
    it.each(TARGETS)(ELECTRON_CONFIG + ' resolves every %s alias from __dirname', (target) => {
        const loose = [...electronAliases(target)].filter(([, call]) => call.anchor !== '__dirname').map(([key]) => key);
        expect(loose, ELECTRON_CONFIG + ' ' + target + ': these aliases follow the working directory (IN-04)').toEqual([]);
    });

    it(VITEST_CONFIG + ' resolves every alias from import.meta.dirname', () => {
        const loose = [...vitestAliases()].filter(([, call]) => call.anchor !== 'import.meta.dirname').map(([key]) => key);
        expect(loose, VITEST_CONFIG + ': these aliases follow the working directory (IN-04)').toEqual([]);
    });
});
