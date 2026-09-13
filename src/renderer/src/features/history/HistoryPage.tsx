// The Phase 7 shell of Work History: the real data path, a placeholder presentation. HIST-01..06 build the screen
// itself in Phase 8, including the This Week / Last Week / Older grouping.

import type { ReactElement } from 'react';
import { useSessions } from './api/useSessions';

export default function HistoryPage(): ReactElement {
    const sessions = useSessions();

    return (
        <section className="px-6 pt-4 pb-28">
            <h1 className="text-2xl font-bold tracking-tight">History</h1>
            {sessions.isPending ? <p className="mt-4 text-sm text-gray-400">Loading...</p> : null}
            {sessions.isError ? <p className="mt-4 text-sm text-red-400">{sessions.error.message}</p> : null}
            {sessions.isSuccess ? (
                <p className="mt-4 text-sm text-gray-400">{sessions.data.length} recorded sessions</p>
            ) : null}
        </section>
    );
}
