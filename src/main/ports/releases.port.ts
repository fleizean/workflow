// REPO-06: the published version of this application, from wherever it is published. A port because the thing it
// wraps is a network request, and the decision that hangs off it - is this newer than what is installed - has to be
// testable without one, and has to be testable when the request fails, which is the ordinary case offline.

export interface ReleasesPort {
    /**
     * The newest version that has actually been released, or undefined. Undefined covers every failure with no
     * distinction on purpose - no network, DNS refused, a proxy, a 404 before the first release, a body of the wrong
     * shape. The caller says nothing to all of them. NEVER rejects: that would be an unhandled rejection in main.
     */
    latest(): Promise<string | undefined>;
}
