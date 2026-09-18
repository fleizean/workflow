// Runs one historical database/db.js initDatabase() with electron stubbed to a temp userData (D-14).
// argv: <dbJsPath> <userDataDir>. Exits 2 for any userData outside os.tmpdir() (T-04-05).

const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

function refuse(reason) {
    process.stderr.write('historical-init-child: ' + reason + '\n');
    process.exit(2);
}

const [dbJsPath, userDataDir] = process.argv.slice(2);
if (!dbJsPath || !userDataDir) {
    refuse('usage: historical-init-child.cjs <dbJsPath> <userDataDir>');
}
if (!path.isAbsolute(userDataDir) || !fs.existsSync(userDataDir)) {
    refuse('userData must be an existing absolute path, got ' + userDataDir);
}

const tempRoot = fs.realpathSync.native(os.tmpdir());
const userData = fs.realpathSync.native(userDataDir);
const inside = path.relative(tempRoot, userData);
if (inside === '' || inside.startsWith('..') || path.isAbsolute(inside)) {
    refuse('userData ' + userData + ' is not inside ' + tempRoot);
}

const originalLoad = Module._load;
Module._load = function (request, ...rest) {
    if (request === 'electron') {
        return {
            app: {
                getPath(name) {
                    if (name !== 'userData') {
                        throw new Error('historical-init-child: unexpected app.getPath(' + String(name) + ')');
                    }
                    return userData;
                }
            }
        };
    }
    return originalLoad.call(this, request, ...rest);
};

const legacy = require(dbJsPath);
legacy.initDatabase();
process.stdout.write(JSON.stringify({ ok: true }) + '\n');
process.exit(0);
