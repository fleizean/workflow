// WR-06: every BrowserWindow this app constructs must carry the same three webPreferences, pinned from the source
// rather than from behaviour. The packaged smoke checks what a page can do, and window.open and navigation stay
// blocked with nodeIntegration: true - so only a source-level assertion can catch that regression.

import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { findAll, read, scriptKindFor } from './helpers/ts-imports';

// The extractor is the sharper of the two risks: it loads a page in the v1.2.1 file:// origin and runs
// executeJavaScript against it, so a regression there hands Node and fs to whatever that origin contains.
const WINDOW_SOURCES: readonly string[] = [
    'src/main/window.ts',
    'src/main/legacy-storage.ts',
    'src/main/smoke.ts'
];

const REQUIRED: Readonly<Record<string, boolean>> = {
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false
};

interface WindowLiteral {
    readonly file: string;
    readonly line: number;
    readonly preferences: ts.ObjectLiteralExpression | null;
}

function booleanProperty(literal: ts.ObjectLiteralExpression, name: string): boolean | null {
    for (const property of literal.properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        const key = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : '';
        if (key !== name) continue;
        if (property.initializer.kind === ts.SyntaxKind.TrueKeyword) return true;
        if (property.initializer.kind === ts.SyntaxKind.FalseKeyword) return false;
        return null;
    }
    return null;
}

function windowLiterals(file: string): WindowLiteral[] {
    const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, scriptKindFor(file));
    const constructions = findAll(source, (node): node is ts.NewExpression =>
        ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'BrowserWindow');

    return constructions.map((construction) => {
        const [argument] = construction.arguments ?? [];
        const options = argument !== undefined && ts.isObjectLiteralExpression(argument) ? argument : null;
        const preferences = options === null ? null : options.properties.find(
            (property) => ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) &&
                property.name.text === 'webPreferences'
        );
        const initializer = preferences !== undefined && preferences !== null && ts.isPropertyAssignment(preferences) &&
            ts.isObjectLiteralExpression(preferences.initializer) ? preferences.initializer : null;
        return {
            file,
            line: source.getLineAndCharacterOfPosition(construction.getStart(source)).line + 1,
            preferences: initializer
        };
    });
}

const literals = WINDOW_SOURCES.flatMap(windowLiterals);

describe('WR-06/T-02-04: every window this app opens is sandboxed, isolated and Node-free', () => {
    it('finds a BrowserWindow in each source that opens one, so the checks below are not vacuous', () => {
        expect(literals.length, 'no BrowserWindow literal was found at all').toBeGreaterThanOrEqual(3);
        for (const file of WINDOW_SOURCES) {
            expect(literals.filter((literal) => literal.file === file).length, file + ' constructs no BrowserWindow')
                .toBeGreaterThan(0);
        }
    });

    it('pins sandbox, contextIsolation and nodeIntegration on every one of them', () => {
        for (const literal of literals) {
            const where = literal.file + ':' + String(literal.line);
            expect(literal.preferences, where + ' constructs a BrowserWindow with no webPreferences literal')
                .not.toBeNull();
            if (literal.preferences === null) continue;
            for (const [key, expected] of Object.entries(REQUIRED)) {
                expect(booleanProperty(literal.preferences, key), where + ': ' + key).toBe(expected);
            }
        }
    });
});
