/*
 * ReleasesPort over one HTTPS GET, in MAIN. It cannot live in the renderer: its CSP is `default-src 'self'` and a
 * fetch from there is a violation, which is the point of REPO-06 putting the check behind a port at all.
 *
 * What leaves this machine is a GET of a fixed URL with no query string, no body, no cookie, no User-Agent and no
 * identifier of any kind. GitHub's servers see the IP address that any web request shows them, and that this file
 * was asked for. README.md says so in those words; tests/update-check.test.ts holds the two together.
 */

import https from 'node:https';
import type { ClientRequest } from 'node:http';
import type { ReleasesPort } from '../ports/releases.port';

export interface HttpsReleasesOptions {
    /** The published manifest. Must be https: - a version read over http: is a version an attacker can choose. */
    readonly url: string;
    readonly timeoutMs: number;
    /** Anything larger is abandoned unread. The real body is well under 100 bytes. */
    readonly maxBytes: number;
    readonly log: (line: string) => void;
}

/** The one field read out of the manifest. Anything else in the file is ignored rather than rejected. */
function versionOf(body: string): string | undefined {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null) {
        return undefined;
    }
    const value = (parsed as Record<string, unknown>)['version'];
    return typeof value === 'string' && value !== '' ? value : undefined;
}

export function createHttpsReleases(options: HttpsReleasesOptions): ReleasesPort {
    const { url, timeoutMs, maxBytes, log } = options;

    return {
        latest: () =>
            new Promise<string | undefined>((resolve) => {
                // One settle, whatever happens first: a timeout that fires after an error would resolve a second time.
                let settled = false;
                const done = (value: string | undefined, why: string): void => {
                    if (settled) return;
                    settled = true;
                    if (value === undefined) log('update: no published version read - ' + why);
                    resolve(value);
                };

                if (!url.startsWith('https://')) {
                    done(undefined, 'the manifest URL is not https');
                    return;
                }

                let request: ClientRequest;
                try {
                    // Redirects are deliberately NOT followed. The manifest lives at a fixed path on a static host;
                    // a redirect there is a host answering a different question, and following one is how a check
                    // ends up reading a body from somewhere nobody chose.
                    request = https.get(url, { timeout: timeoutMs }, (response) => {
                        const status = response.statusCode ?? 0;
                        if (status !== 200) {
                            response.destroy();
                            // 404 until the first release publishes the manifest. That is the ordinary state, and
                            // it is the same silence as being offline.
                            done(undefined, 'HTTP ' + String(status));
                            return;
                        }
                        let body = '';
                        response.setEncoding('utf8');
                        response.on('data', (chunk: string) => {
                            body += chunk;
                            if (body.length > maxBytes) {
                                response.destroy();
                                done(undefined, 'the body exceeded ' + String(maxBytes) + ' bytes');
                            }
                        });
                        response.on('end', () => {
                            try {
                                done(versionOf(body), 'the body carried no version string');
                            } catch {
                                done(undefined, 'the body was not JSON');
                            }
                        });
                        response.on('error', (error: Error) => { done(undefined, error.message); });
                    });
                } catch (error) {
                    // An unparseable or non-https URL throws synchronously; it must not throw out of latest().
                    done(undefined, error instanceof Error ? error.message : String(error));
                    return;
                }

                // Covers a connection that opens and then says nothing, which no socket error reports.
                request.on('timeout', () => {
                    request.destroy();
                    done(undefined, 'no response within ' + String(timeoutMs) + ' ms');
                });
                // DNS failure, refused connection, TLS failure, a captive portal: one silence for all of them.
                request.on('error', (error: Error) => { done(undefined, error.message); });
            })
    };
}
