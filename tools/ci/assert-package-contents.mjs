#!/usr/bin/env node
/*
 * BUILD-08 - RED skeleton. The contract is declared in assert-package-contents.d.mts and exercised
 * by tests/packaging.test.ts; every helper below throws until the implementation lands.
 */

function notImplemented(name) {
    return new Error('tools/ci/assert-package-contents.mjs: ' + name + ' is not implemented yet');
}

export const ALLOWED_TOP_LEVEL = Object.freeze([]);
export const UNPACKED_PACKAGE = '';
export const LARGEST_COUNT = 0;

export class PackageNotFoundError extends Error {}

export function readAsarHeader() { throw notImplemented('readAsarHeader'); }
export function readAsarFile() { throw notImplemented('readAsarFile'); }
export function matchDenied() { throw notImplemented('matchDenied'); }
export function checkTopLevel() { throw notImplemented('checkTopLevel'); }
export function checkUnpackedRegion() { throw notImplemented('checkUnpackedRegion'); }
export function resolveResourcesDir() { throw notImplemented('resolveResourcesDir'); }
export function listFilesUnder() { throw notImplemented('listFilesUnder'); }
export function inspectPackage() { throw notImplemented('inspectPackage'); }
export function formatReport() { throw notImplemented('formatReport'); }
