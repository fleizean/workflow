/*
 * What Chromium does with the attributes these three forms actually render, in the runtime that ships.
 *
 * SCREENS BL-02 and SCREENS WR-01 are the same defect on two screens: an attribute the component carries makes the
 * browser refuse the submit BEFORE the handler runs, so the screen's own refusal is dead code and the user gets a
 * bubble naming two values the app itself would never write.
 *
 * Nothing here reads the components' behaviour. It reads their <input> ATTRIBUTES out of the TSX with the
 * TypeScript parser, rebuilds a form from exactly those, and asks a real offscreen BrowserWindow in the shipped
 * Electron whether clicking submit fires a submit event. It opens no database and touches nothing under userData.
 */

import { describe, expect, it, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
import { read, repoRoot, scriptKindFor } from './helpers/ts-imports';

const SAVE_FORM = 'src/renderer/src/features/timer/components/SaveSessionForm.tsx';
const SESSION_FORM = 'src/renderer/src/features/history/components/SessionForm.tsx';
const NUMBER_CARD = 'src/renderer/src/features/settings/components/NumberSettingCard.tsx';

/** One <input> as the component renders it: literal attributes only, which is all constraint validation reads. */
interface InputSpec {
    readonly attributes: Readonly<Record<string, string>>;
}

/*
 * `min={String(MAX_DURATION_HOURS)}` and `min={bound.min}` are not literals, so the value is resolved by name from
 * the module's own constants where it can be and reported as unknown where it cannot. An unknown bound is not a
 * failure: the point of the test is which attributes exist, and every one that exists is applied below with a value
 * the app really writes.
 */
function literalOf(node: ts.Node, constants: ReadonlyMap<string, string>): string | undefined {
    if (ts.isStringLiteral(node)) return node.text;
    if (ts.isNumericLiteral(node)) return node.text;
    if (ts.isJsxExpression(node) && node.expression !== undefined) return literalOf(node.expression, constants);
    if (ts.isIdentifier(node)) return constants.get(node.text);
    if (ts.isCallExpression(node) && node.expression.getText() === 'String' && node.arguments[0] !== undefined) {
        return literalOf(node.arguments[0], constants);
    }
    return undefined;
}

function numericConstants(source: ts.SourceFile): ReadonlyMap<string, string> {
    const found = new Map<string, string>();
    const walk = (node: ts.Node): void => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined &&
            ts.isNumericLiteral(node.initializer)) {
            found.set(node.name.text, node.initializer.text);
        }
        ts.forEachChild(node, walk);
    };
    walk(source);
    return found;
}

function inputsOf(rel: string): InputSpec[] {
    const text = read(rel);
    const source = ts.createSourceFile(rel, text, ts.ScriptTarget.ESNext, true, scriptKindFor(rel));
    const constants = numericConstants(source);
    const specs: InputSpec[] = [];
    const walk = (node: ts.Node): void => {
        const opening = ts.isJsxSelfClosingElement(node) ? node
            : ts.isJsxElement(node) ? node.openingElement : undefined;
        if (opening !== undefined && opening.tagName.getText() === 'input') {
            const attributes: Record<string, string> = {};
            for (const attribute of opening.attributes.properties) {
                if (!ts.isJsxAttribute(attribute) || attribute.initializer === undefined) continue;
                const value = literalOf(attribute.initializer, constants);
                if (value !== undefined) attributes[attribute.name.getText()] = value;
            }
            if (attributes.type !== undefined) specs.push({ attributes });
        }
        ts.forEachChild(node, walk);
    };
    walk(source);
    return specs;
}

const numberInputs = (rel: string): InputSpec[] =>
    inputsOf(rel).filter((spec) => spec.attributes.type === 'number');

/** The attribute names constraint validation acts on. `value` is supplied per case. */
const CONSTRAINT_ATTRIBUTES = ['type', 'min', 'max', 'step', 'required', 'pattern'];

interface Probe {
    readonly label: string;
    readonly spec: InputSpec;
    readonly value: string;
    readonly noValidate: boolean;
}

interface ProbeResult {
    readonly label: string;
    readonly valid: boolean;
    readonly stepMismatch: boolean;
    readonly rangeOverflow: boolean;
    readonly rangeUnderflow: boolean;
    readonly formValid: boolean;
    readonly submitFired: boolean;
}

const escapeAttribute = (text: string): string =>
    text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function formHtml(probes: readonly Probe[]): string {
    const forms = probes.map((probe, index) => {
        const attributes = CONSTRAINT_ATTRIBUTES
            .filter((name) => probe.spec.attributes[name] !== undefined)
            .map((name) => name + '="' + escapeAttribute(probe.spec.attributes[name] as string) + '"')
            .join(' ');
        return '<form id="f' + String(index) + '"' + (probe.noValidate ? ' novalidate' : '') + '>' +
            '<input id="i' + String(index) + '" ' + attributes +
            ' value="' + escapeAttribute(probe.value) + '">' +
            '<button id="b' + String(index) + '" type="submit">Save</button></form>';
    }).join('');
    return '<!doctype html><html><head><meta charset="utf-8"></head><body>' + forms + '</body></html>';
}

/** The page's own answer, read in the renderer where constraint validation lives. */
const PROBE_SCRIPT = `(() => {
    const out = [];
    const forms = document.querySelectorAll('form');
    for (let index = 0; index < forms.length; index += 1) {
        const form = forms[index];
        const input = document.getElementById('i' + index);
        let submitFired = false;
        form.addEventListener('submit', (event) => { event.preventDefault(); submitFired = true; });
        document.getElementById('b' + index).click();
        out.push({
            valid: input.validity.valid,
            stepMismatch: input.validity.stepMismatch,
            rangeOverflow: input.validity.rangeOverflow,
            rangeUnderflow: input.validity.rangeUnderflow,
            formValid: form.checkValidity(),
            submitFired
        });
    }
    return JSON.stringify(out);
})()`;

const electronBinary = (): string => {
    const dist = path.join(repoRoot, 'node_modules', 'electron', 'dist');
    const name = fs.readFileSync(path.join(repoRoot, 'node_modules', 'electron', 'path.txt'), 'utf8').trim();
    return path.join(dist, name);
};

/** A main process that opens one hidden window, asks the page, prints the answer and quits. */
const MAIN_SCRIPT = `
const { app, BrowserWindow } = require('electron');
const PAGE = process.argv[process.argv.length - 1];
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, width: 448, height: 800, webPreferences: { sandbox: true } });
    await win.loadFile(PAGE);
    const answer = await win.webContents.executeJavaScript(process.env.WORKFLOW_PROBE);
    process.stdout.write('<<<' + answer + '>>>');
    win.destroy();
    app.exit(0);
}).catch((error) => { process.stderr.write(String(error && error.message)); app.exit(1); });
`;

function runProbes(probes: readonly Probe[]): ProbeResult[] {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-forms-'));
    try {
        const page = path.join(dir, 'page.html');
        const main = path.join(dir, 'main.cjs');
        fs.writeFileSync(page, formHtml(probes), 'utf8');
        fs.writeFileSync(main, MAIN_SCRIPT, 'utf8');
        // Scrubbed for the reason every other Electron launch in this repository scrubs them: either turns the
        // binary into a bare Node process and the window never opens.
        const environment: NodeJS.ProcessEnv = { ...process.env, WORKFLOW_PROBE: PROBE_SCRIPT };
        delete environment.ELECTRON_RUN_AS_NODE;
        delete environment.NODE_OPTIONS;
        /*
         * --no-sandbox, which every other Electron launch in this repository already passes (tools/**, and
         * baselines/v1.2.1/MANIFEST.md pins it as the v1.2.1 launch arg). The npm-installed chrome-sandbox is not
         * setuid root on a CI runner, and Chromium treats that as FATAL at startup rather than falling back, so
         * without this the probe window never opens on Linux. The flag precedes the app path so that `page` stays
         * the last argv entry, which is how MAIN_SCRIPT finds it.
         */
        const stdout = execFileSync(electronBinary(), ['--no-sandbox', main, page], {
            encoding: 'utf8',
            timeout: 90_000,
            env: environment,
            windowsHide: true
        });
        const body = /<<<([\s\S]*)>>>/.exec(stdout);
        if (body === null) throw new Error('the probe window printed nothing: ' + stdout);
        const parsed = JSON.parse(body[1] as string) as Omit<ProbeResult, 'label'>[];
        return parsed.map((result, index) => ({ label: probes[index]?.label ?? '?', ...result }));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

const SETTINGS_FORM = 'src/renderer/src/features/settings/components/SettingsForm.tsx';

/*
 * Values the two session forms really hold. `1.4` and `0.4` are what the pre-fix decimal-hours field seeded for a
 * 1h23m session and a 25-minute pomodoro; the rest are what the hours/minutes pair seeds. Every number input on
 * these screens is probed with all of them, because the property being asserted is not about a shape: it is that
 * the screen's own refusal is always the one the user meets.
 */
const FORM_VALUES = ['1.4', '0.4', '1', '23', '59', '8', '0'];

/** Which form a component's inputs are submitted inside, and whether that form defers to the screen (WR-01). */
const OWNERS: readonly { readonly component: string; readonly form: string; readonly name: string }[] = [
    { component: SESSION_FORM, form: SESSION_FORM, name: 'history' },
    { component: SAVE_FORM, form: SAVE_FORM, name: 'save' },
    { component: NUMBER_CARD, form: SETTINGS_FORM, name: 'settings' }
];

const defersToTheScreen = (formFile: string): boolean => read(formFile).includes('noValidate');

describe('constraint validation over the attributes these forms render', () => {
    let results: ProbeResult[] = [];

    beforeAll(() => {
        const probes: Probe[] = [];
        for (const owner of OWNERS) {
            const noValidate = defersToTheScreen(owner.form);
            numberInputs(owner.component).forEach((spec, position) => {
                for (const value of FORM_VALUES) {
                    probes.push({ label: owner.name + ' #' + String(position) + ' = ' + value, spec, value, noValidate });
                }
            });
        }
        results = runProbes(probes);
    }, 120_000);

    it('types a duration as two whole-number boxes, and states a step it enforces', () => {
        expect(numberInputs(SESSION_FORM)).toHaveLength(2);
        expect(numberInputs(SAVE_FORM)).toHaveLength(2);
        for (const spec of [...numberInputs(SESSION_FORM), ...numberInputs(SAVE_FORM)]) {
            // A step that is not 1 is a step that refuses values the app itself writes - the whole of BL-02.
            expect(spec.attributes.step).toBe('1');
        }
    });

    it('lets the submit through for every value these screens can hold', () => {
        expect(results.length).toBeGreaterThan(0);
        const refused = results.filter((result) => !result.submitFired);
        expect(refused.map((result) => result.label)).toEqual([]);
    });

    it('still lets the submit through when Chromium considers the value invalid', () => {
        // BL-02 and WR-01 in one sentence: the browser's opinion must not replace the screen's explanation.
        const rejectedByChromium = results.filter((result) => !result.formValid);
        expect(rejectedByChromium.length).toBeGreaterThan(0);
        for (const result of rejectedByChromium) {
            expect(result.submitFired).toBe(true);
        }
    });

    it('proves the harness can fail, by refusing the exact field v1.2.1 step="0.5" produced', () => {
        const control = runProbes([{
            label: 'control',
            spec: { attributes: { type: 'number', min: '0', step: '0.5' } },
            value: '1.4',
            noValidate: false
        }]);
        expect(control[0]?.stepMismatch).toBe(true);
        expect(control[0]?.submitFired).toBe(false);
    }, 120_000);

    it('holds all three forms to letting their own review answer', () => {
        for (const owner of OWNERS) {
            expect(defersToTheScreen(owner.form)).toBe(true);
        }
    });
});
