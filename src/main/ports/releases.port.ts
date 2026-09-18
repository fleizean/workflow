// REPO-06: the published version of this application, from wherever it is published. A port because the thing it
// wraps is a network request, and the decision that hangs off it - is this newer than what is installed - has to be
// testable without one, and has to be testable when the request fails, which is the ordinary case offline.

export interface ReleasesPort {
    /**
     * The newest version that has actually been released, or undefined.
     *
     * Undefined covers every failure with no distinction on purpose: no network, DNS refused, a proxy, a 404 before
     * the first release, a body that is not the expected shape. The caller has the same response to all of them -
     * say nothing - so a richer result would only invite a caller to act on one of them.
     *
     * NEVER rejects. A rejected promise here is an unhandled rejection in the main process.
     */
    latest(): Promise<string | undefined>;
}
