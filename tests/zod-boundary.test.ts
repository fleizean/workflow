// D-14: zod reaches the renderer only as types. Every value import, value re-export and import() at any depth is
// followed from the renderer entry and the renderer-safe shared modules; a chain that reaches zod fails.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
import { read, readAliases, repoRoot, resolveModuleFile, scriptKindFor } from './helpers/ts-imports';

const aliases = readAliases('electron.vite.config.ts', ['renderer', 'resolve', 'alias']);
const FOLLOWED = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;
const RENDERER_ENTRY = 'src/renderer/src/main.tsx';
const RENDERER_SAFE_SHARED = ['src/shared/utils', 'src/shared/constants', 'src/shared/types'];

const isZod = (specifier: string): boolean => specifier === 'zod' || specifier.startsWith('zod/');

interface Root {
    file: string;
    source?: string;
}

// Only a statement-level `import type` is skipped: `import { type X }` still loads its module (Pitfall 5), and a
// bundler emits every import() target as a chunk wherever the call sits (Pitfall 6).
function valueSpecifiers(file: string, source: string): string[] {
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKindFor(file));
    const found: string[] = [];
    const visit = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node)) {
            if (node.importClause?.isTypeOnly !== true && ts.isStringLiteral(node.moduleSpecifier)) {
                found.push(node.moduleSpecifier.text);
            }
        } else if (ts.isExportDeclaration(node)) {
            if (!node.isTypeOnly && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
                found.push(node.moduleSpecifier.text);
            }
        } else if (ts.isImportEqualsDeclaration(node)) {
            if (!node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference) &&
                ts.isStringLiteral(node.moduleReference.expression)) {
                found.push(node.moduleReference.expression.text);
            }
        } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
            const [argument] = node.arguments;
            // A computed specifier cannot be followed, so it cannot be cleared either.
            found.push(argument !== undefined && ts.isStringLiteralLike(argument) ? argument.text : '<non-literal import()>');
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return found;
}

function valueImportChainsToZod(roots: readonly Root[]): { chains: string[]; visited: Set<string> } {
    const chains: string[] = [];
    const visited = new Set<string>();
    const walk = (file: string, source: string, trail: readonly string[]): void => {
        for (const specifier of valueSpecifiers(file, source)) {
            if (isZod(specifier) || specifier === '<non-literal import()>') {
                chains.push([...trail, file, specifier].join(' -> '));
                continue;
            }
            const target = resolveModuleFile(file, specifier, aliases);
            if (target === undefined || !FOLLOWED.test(target) || visited.has(target)) continue;
            visited.add(target);
            walk(target, read(target), [...trail, file]);
        }
    };
    for (const root of roots) {
        visited.add(root.file);
        walk(root.file, root.source ?? read(root.file), []);
    }
    return { chains, visited };
}

const sharedRoots = (): string[] =>
    execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', ...RENDERER_SAFE_SHARED], {
        cwd: repoRoot,
        encoding: 'utf8'
    })
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => FOLLOWED.test(line));

describe('D-14: zod reaches the renderer only as types', () => {
    it('resolves through the aliases the renderer build uses', () => {
        expect([...aliases.keys()].sort(), 'the renderer alias block changed; the walk would resolve nothing').toEqual(['@renderer', '@shared']);
    });

    it('finds no value-import chain to zod from the renderer entry or a renderer-safe shared module', () => {
        const { chains, visited } = valueImportChainsToZod([{ file: RENDERER_ENTRY }, ...sharedRoots().map((file) => ({ file }))]);
        expect(chains, 'value-import chains that would ship zod to the renderer:\n  ' + chains.join('\n  ')).toEqual([]);
        for (const file of ['src/renderer/src/App.tsx', 'src/shared/utils/date.ts', 'src/shared/constants/settings.ts', 'src/shared/types/index.ts']) {
            expect(visited.has(file), file + ' was never reached, so the walk proves nothing about it').toBe(true);
        }
    });

    describe('negative controls through the same walker', () => {
        const PROBE = 'src/renderer/src/__zod_probe__.tsx';
        const chainsFor = (source: string): string[] => valueImportChainsToZod([{ file: PROBE, source }]).chains;

        it('flags a value import of a schema module', () => {
            const chains = chainsFor('import { SettingsSchema } from \'@shared/schemas\';\nexport const s = SettingsSchema;\n');
            expect(
                chains.some((c) => c.includes('src/shared/schemas/index.ts') && c.endsWith(' -> zod')),
                'a value import of @shared/schemas was not traced to zod: ' + JSON.stringify(chains)
            ).toBe(true);
        });

        it('flags an import() of the contract, wherever the call sits', () => {
            const chains = chainsFor('export const load = () => import(\'@shared/ipc/contract\');\n');
            expect(
                chains.some((c) => c.includes('src/shared/ipc/contract.ts') && c.endsWith(' -> zod')),
                'a lazy import() of the contract was not traced to zod: ' + JSON.stringify(chains)
            ).toBe(true);
        });

        it('flags an inline type specifier import, which still loads zod', () => {
            expect(chainsFor('import { type ZodType } from \'zod\';\nexport type T = ZodType;\n')).toEqual([PROBE + ' -> zod']);
        });

        it('does not flag a statement-level import type', () => {
            expect(chainsFor('import type { Company } from \'@shared/types\';\nexport type C = Company;\n')).toEqual([]);
        });
    });
});
