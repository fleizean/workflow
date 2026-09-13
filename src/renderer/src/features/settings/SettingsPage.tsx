// The Phase 7 shell of Settings: the real data path, a placeholder presentation. SET-01..05 build the screen in
// Phase 8. It is also the packaged smoke's second route - the proof that a screen change loads no file.

import type { ReactElement } from 'react';
import { useSettings } from './api/useSettings';

export default function SettingsPage(): ReactElement {
    const settings = useSettings();

    return (
        <section className="px-6 pt-4 pb-28">
            <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
            {settings.isPending ? <p className="mt-4 text-sm text-gray-400">Loading...</p> : null}
            {settings.isError ? <p className="mt-4 text-sm text-red-400">{settings.error.message}</p> : null}
            {settings.isSuccess ? (
                <p className="mt-4 text-sm text-gray-400">
                    Daily target: {settings.data.dailyTargetSeconds} seconds
                </p>
            ) : null}
        </section>
    );
}
