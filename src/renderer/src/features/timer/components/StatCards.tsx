/*
 * The three cards across the top of Home - legacy/pages/index.html:331-372 - with the same icons, the same accent
 * colours, the same hover wash and the same wording.
 *
 * Two differences, both deliberate:
 *  - the streak card has no click handler. v1.2.1's cycled the card through 6, 15 and 25 to demo the tier effects
 *    and wrote "(TEST)" into the label, then restored the real value three seconds later (:1474-1481). That is
 *    TIMER-09, and it is closed by deleting the handler rather than by hiding it.
 *  - cursor-pointer is on the Logged card only. v1.2.1 put it on all three while only that one did anything.
 */

import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { ROUTE_PATHS } from '@renderer/lib/routes';
import { formatDurationShort } from '@renderer/lib/format';
import StreakFireCanvas from './StreakFireCanvas';
import { streakLabel, streakTierOf } from '../timer-view';
import type { StreakTier } from '../timer-view';

const SHELL = 'flex flex-col gap-1 rounded-2xl p-4 shadow-xs transition-all duration-300 hover:scale-105 ' +
    'relative overflow-hidden group';
const SURFACE = ' bg-white dark:bg-surface-dark border border-slate-100 dark:border-slate-800 ' +
    'hover:bg-slate-50 dark:hover:bg-[#233c48]';
const WASH = 'absolute inset-0 translate-y-full group-hover:translate-y-0 transition-transform duration-300 ' +
    'ease-out rounded-2xl';
/** The three accents, whole. A hover wash whose colour is appended in the attribute is refused (SPA-11, C3). */
const TARGET_WASH = WASH + ' bg-primary/5';
const LOGGED_WASH = WASH + ' bg-emerald-500/5';
const STREAK_WASH = WASH + ' bg-orange-500/5';
const PLAIN_CARD = SHELL + SURFACE;
const LOGGED_CARD = SHELL + SURFACE + ' cursor-pointer';
const HEAD = 'flex items-center gap-1.5 mb-1 relative z-10';
const LABEL = 'text-slate-500 dark:text-slate-400 text-[10px] font-bold uppercase tracking-wider';
const VALUE = 'text-xl font-bold leading-none tracking-tight relative z-10 whitespace-nowrap';

/*
 * The three tier looks, written out in full. legacy/pages/index.html declared them as .streak-tier-1/2/3 rules in a
 * page <style> block; each gradient, background-size, border and animation is the same value, now as utilities and
 * @theme animation tokens (ARCH-05). Tiers 2 and 3 replace the plain surface rather than sitting on top of it,
 * which is what the class rules did by winning the cascade.
 */
const STREAK_CARD: Record<StreakTier, string> = {
    0: SHELL + SURFACE,
    1: SHELL + SURFACE + ' animate-streak-glow',
    2: SHELL + ' border border-slate-100 dark:border-slate-800 bg-linear-135/srgb from-[#f97316]/10 ' +
        'via-[#fb923c]/15 to-[#f97316]/10 bg-[length:200%_200%] animate-streak-shimmer',
    3: SHELL + ' border-2 border-[rgba(249,115,22,0.8)] bg-linear-135/srgb from-[#f97316]/30 via-[#fb923c]/40 ' +
        'to-[#f97316]/30 bg-[length:400%_400%] animate-streak-fire'
};

/** The fire glyph. Tier 3 flickers and fills; everything below it keeps v1.2.1's steady filled glyph and glow. */
const STREAK_ICON: Record<StreakTier, string> = {
    0: "material-symbols-outlined text-orange-500 text-lg [font-variation-settings:'FILL'_1] " +
        'drop-shadow-[0_0_8px_rgba(249,115,22,0.6)]',
    1: "material-symbols-outlined text-orange-500 text-lg [font-variation-settings:'FILL'_1] " +
        'animate-streak-pulse',
    2: "material-symbols-outlined text-orange-500 text-lg [font-variation-settings:'FILL'_1] " +
        'animate-streak-pulse-quick',
    3: "material-symbols-outlined text-orange-500 text-lg [font-variation-settings:'FILL'_1] " +
        'animate-streak-flicker'
};

interface StatCardsProps {
    readonly dailyTargetSeconds: number;
    readonly loggedSeconds: number;
    readonly streakDays: number;
}

export default function StatCards({ dailyTargetSeconds, loggedSeconds, streakDays }: StatCardsProps): ReactElement {
    const tier = streakTierOf(streakDays);

    return (
        <div className="grid grid-cols-3 gap-3">
            <div className={PLAIN_CARD}>
                <div className={TARGET_WASH} />
                <div className={HEAD}>
                    <span className="material-symbols-outlined text-primary text-lg">flag</span>
                    <p className={LABEL}>Daily Target</p>
                </div>
                <p className={VALUE}>{formatDurationShort(dailyTargetSeconds)}</p>
            </div>

            <Link to={ROUTE_PATHS.history} className={LOGGED_CARD}>
                <div className={LOGGED_WASH} />
                <div className={HEAD}>
                    <span className="material-symbols-outlined text-emerald-500 text-lg">timelapse</span>
                    <p className={LABEL}>Logged</p>
                </div>
                <p className={VALUE}>{formatDurationShort(loggedSeconds)}</p>
            </Link>

            <div className={STREAK_CARD[tier]}>
                <div className={STREAK_WASH} />
                {tier >= 2 ? <StreakFireCanvas intensity={tier === 3 ? 'high' : 'medium'} /> : null}
                <div className={HEAD}>
                    <span className={STREAK_ICON[tier]}>local_fire_department</span>
                    <p className={LABEL}>Streak</p>
                </div>
                <p className={VALUE}>{streakLabel(streakDays)}</p>
            </div>
        </div>
    );
}
