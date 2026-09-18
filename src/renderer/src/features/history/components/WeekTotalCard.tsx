/*
 * legacy/pages/work-history.html:44-63, carried over: the primary-coloured card, its two blurred decorations, the
 * label, the total and the trending_up badge. v1.2.1 also computed a percentage change against last week and wrote
 * it into an element selected as `.flex.items-center.gap-1.rounded-full span:nth-child(2)`, which does not exist in
 * this header's markup - so nothing ever rendered, and the parity reference is what v1.2.1 showed.
 */

import type { ReactElement } from 'react';
import { formatDurationShort } from '@renderer/lib/format';

const CARD_CLASS = 'flex w-full flex-col gap-2 rounded-2xl bg-primary p-6 text-white shadow-lg ' +
    'shadow-primary/20 relative overflow-hidden';
const BADGE_CLASS = 'flex h-12 w-12 items-center justify-center rounded-full bg-white/20 backdrop-blur-xs';

export default function WeekTotalCard({ thisWeekSeconds }: { readonly thisWeekSeconds: number }): ReactElement {
    return (
        <section className="mt-2 mb-6">
            <div className={CARD_CLASS}>
                <div className="absolute -right-4 -top-4 h-24 w-24 rounded-full bg-white/10 blur-2xl" />
                <div className="absolute -left-4 -bottom-4 h-20 w-20 rounded-full bg-black/10 blur-xl" />
                <div className="relative z-10 flex items-center justify-between">
                    <div>
                        <p className="text-white/80 text-sm font-medium leading-normal mb-1">Total This Week</p>
                        <p className="text-3xl font-bold leading-tight tracking-tight">
                            {formatDurationShort(thisWeekSeconds)}
                        </p>
                    </div>
                    <div className={BADGE_CLASS}>
                        <span className="material-symbols-outlined text-[28px]">trending_up</span>
                    </div>
                </div>
            </div>
        </section>
    );
}
