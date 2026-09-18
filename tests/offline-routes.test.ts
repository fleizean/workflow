/*
 * The judgement behind Phase 10 criterion 7, and a staleness guard over what it recorded.
 *
 * `npm run offline:check` is the gate and it needs a packaged build; what runs in the ordinary suite is the part
 * that decides what counts as "the icons are glyphs" and "the font resolved", exercised with the failures it is
 * supposed to catch. The S4 failure has a shape - the ligature NAME renders as literal text - so the control here
 * is a probe carrying exactly that.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot } from './helpers/ts-imports';
import {
    BUNDLED_FONTS, FILL_ON, MAX_GLYPH_EMS, MIN_NAME_EMS, insideThePackage, judgeRouteOffline, judgeSound
} from '../tools/offline-routes.mjs';
import type { OfflineCheck } from '../tools/offline-routes.mjs';
import { SMOKE_BUNDLED_FONTS, SMOKE_ICON_MAX_WIDTH_PX, SMOKE_ICON_FONT_SIZE_PX } from '../src/main/config';

const REPORT = path.join(repoRoot, 'baselines', 'v2', 'OFFLINE-ROUTES.md');
const report = fs.readFileSync(REPORT, 'utf8');

const icon = (name: string, fontSize: number, ems: number, variation = 'normal'): Record<string, unknown> => ({
    name, fontSize, ems, width: fontSize * ems, fontFamily: '"Material Symbols Outlined"', variation
});

/** A route on which everything worked, so each control below changes exactly one thing. */
const healthy = (): Record<string, unknown> => ({
    fonts: { 'Inter Variable': true, 'Material Symbols Outlined': true },
    icons: [
        icon('home', 24, 1),
        icon('local_fire_department', 18, 1, '"FILL" 1, "wght" 400'),
        icon('play_arrow', 48, 1)
    ],
    longestName: 'local_fire_department',
    nameAsTextEms: 9.8,
    bodyFont: '"Inter Variable", Inter, sans-serif',
    headingFont: '"Inter Variable", Inter, sans-serif',
    shellBackground: 'rgb(16, 28, 34)',
    violations: []
});

const failedFor = (probe: Record<string, unknown>): string[] =>
    judgeRouteOffline('index', probe).filter((check: OfflineCheck) => !check.pass)
        .map((check: OfflineCheck) => check.label.replace('index: ', ''));

describe('the per-route offline verdict', () => {
    it('passes a route that rendered from inside the bundle', () => {
        expect(failedFor(healthy())).toEqual([]);
    });

    /*
     * S4, exactly: the font never arrives, so every ligature renders as its own name in the fallback face. The
     * glyphs go from one em to many, and this is the failure the whole check exists for.
     */
    it('fails a route where the icons rendered as literal text', () => {
        const asText = {
            ...healthy(),
            fonts: { 'Inter Variable': true, 'Material Symbols Outlined': false },
            icons: [
                icon('home', 24, 2.4, 'normal'),
                icon('local_fire_department', 18, 9.8, 'normal')
            ]
        };
        const failures = failedFor(asText);
        expect(failures).toContain('Material Symbols Outlined resolved from inside the bundle');
        expect(failures).toContain('every icon measures as a glyph, not as its own name in text');
        expect(failures).toContain('the icons that ask to be filled are filled');
    });

    it('fails a route whose text is not drawn in Inter', () => {
        expect(failedFor({ ...healthy(), headingFont: 'system-ui', bodyFont: 'system-ui' }))
            .toEqual(['the text on screen is drawn in Inter']);
    });

    it('fails a route with no icons at all, rather than passing vacuously', () => {
        const failures = failedFor({ ...healthy(), icons: [], longestName: '', nameAsTextEms: 0 });
        expect(failures).toContain('the route has icons to judge');
        expect(failures).toContain('the bound separates a glyph from a name, in this document');
    });

    it('fails a route where the glyph bound would separate nothing', () => {
        // A document in which the longest icon name measures barely more than a glyph would make every width
        // comparison meaningless, so the run says so instead of reporting a pass.
        expect(failedFor({ ...healthy(), nameAsTextEms: 1.2 }))
            .toEqual(['the bound separates a glyph from a name, in this document']);
    });

    it('fails a route that reported a CSP violation, and quotes it', () => {
        const checks = judgeRouteOffline('index', { ...healthy(), violations: ['font-src <- https://fonts.gstatic.com'] });
        const failure = checks.find((check: OfflineCheck) => !check.pass);
        expect(failure?.label).toBe('index: the console reported no CSP violation');
        expect(failure?.detail).toContain('fonts.gstatic.com');
    });

    it('fails a route drawn without the palette, which is what a stylesheet that never arrived looks like', () => {
        expect(failedFor({ ...healthy(), shellBackground: 'rgba(0, 0, 0, 0)' }))
            .toEqual(['the route rendered with the palette applied']);
    });

    it('fails an icon drawn in some other family, however wide it is', () => {
        const wrongFamily = { ...healthy(), icons: [{ ...icon('home', 24, 1), fontFamily: 'system-ui' }] };
        expect(failedFor(wrongFamily)).toContain('every icon is drawn in the Material Symbols family');
    });
});

describe('the sound verdict', () => {
    const decoded = { src: 'file:///c/app.asar/out/renderer/assets/notification-x.mp3', duration: 0.65, error: '' };
    const failed = (probe: unknown): string[] =>
        judgeSound(probe).filter((check: OfflineCheck) => !check.pass).map((check: OfflineCheck) => check.label);

    it('passes a bundled file that decoded', () => {
        expect(failed(decoded)).toEqual([]);
    });

    it('fails a remote source, which is what v1.2.1 would have had offline', () => {
        expect(failed({ ...decoded, src: 'https://example.com/notification.mp3' }))
            .toEqual(['the notification sound resolves to a file inside the app']);
    });

    it('fails a file that is there but will not decode', () => {
        expect(failed({ ...decoded, duration: 0, error: 'MediaError 4' }))
            .toEqual(['the notification sound decodes with the network off']);
    });
});

describe('the bounds and the committed report', () => {
    it('states the same glyph-versus-text distinction src/main/config.ts does, generalised to any size', () => {
        // The smoke draws one icon at a known size and bounds it in pixels; this bounds every icon in ems. The two
        // must agree at that size, or the app and this tool would disagree about what a glyph is.
        expect(SMOKE_ICON_MAX_WIDTH_PX / SMOKE_ICON_FONT_SIZE_PX).toBeLessThanOrEqual(MAX_GLYPH_EMS);
        expect(MIN_NAME_EMS).toBeGreaterThan(MAX_GLYPH_EMS);
        expect([...BUNDLED_FONTS].sort()).toEqual([...SMOKE_BUNDLED_FONTS].sort());
        expect(FILL_ON).toBe('"FILL" 1');
    });

    it('carries no absolute path from the machine that produced it', () => {
        expect(insideThePackage('file:///C:/Users/someone/dist/win-unpacked/resources/app.asar/out/renderer/a.mp3'))
            .toBe('app.asar/out/renderer/a.mp3');
        expect(report).not.toMatch(/file:\/\/\//);
        expect(report).not.toMatch(/Users/);
    });

    it('records four routes, no failure, no remote request and no CSP violation', () => {
        expect(report).toContain('| Routes checked | 4 |');
        expect(report).toContain('| Checks failed | **0** |');
        expect(report).toContain('| Remote requests attempted | 0 |');
        expect(report).toContain('| CSP violations reported | 0 |');
        expect(report).toContain('| Console errors | 0 |');
        for (const route of ['index', 'companies', 'work-history', 'settings']) {
            expect(report, route + ' is missing from the report').toContain('| `' + route + '` |');
        }
    });

    it('records a sound that decoded, not merely a path that exists', () => {
        expect(report).toMatch(/\| Decoded duration \| 0\.\d+s \|/);
        expect(report).toContain('| Error | none |');
    });
});
