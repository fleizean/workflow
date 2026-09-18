/*
 * One date and one company: legacy/pages/work-history.html:601-696, carried over with its date badge, Goal pill,
 * note marker, fold-out session list and the hairline it drew where the date changed.
 *
 * Two deliberate differences:
 *  - the header is a real <button>, so the card opens from the keyboard and announces aria-expanded. v1.2.1 put a
 *    click handler on a <div> and guarded it with e.target.closest('button');
 *  - the chevron is shown on every card rather than only on cards with more than one session. v1.2.1 expanded any
 *    card that was clicked but only advertised it on some, and the edit and delete buttons live inside the fold.
 *
 * The chevron's rotation is a class rather than the inline style.transform v1.2.1 assigned (ARCH-05).
 */

import { useState } from 'react';
import type { ReactElement } from 'react';
import { formatClockTime, formatDayBadge, formatDurationShort } from '@renderer/lib/format';
import { describeSessionCount } from '@renderer/features/companies';
import type { SessionGroup } from '../grouping';
import type { WorkSession } from '@shared/types';

const CARD_CLASS = 'group flex flex-col rounded-xl bg-white dark:bg-card-dark p-4 shadow-xs transition-all ' +
    'hover:shadow-md border border-transparent dark:border-slate-800/50';
const HEADER_CLASS = 'flex items-center gap-4 w-full text-left';
const BADGE_CLASS = 'flex shrink-0 flex-col items-center justify-center rounded-lg bg-slate-100 ' +
    'dark:bg-[#233c48] h-14 w-14';
const GOAL_PILL_CLASS = 'flex items-center gap-1 rounded-full bg-green-500/10 dark:bg-green-400/10 px-1.5 py-0.5';
const DETAIL_ROW_CLASS = 'flex items-start gap-3 p-3 rounded-xl bg-slate-50 dark:bg-white/5 ' +
    'border border-slate-100 dark:border-white/5';
const EDIT_CLASS = 'flex items-center justify-center w-7 h-7 rounded-lg bg-blue-500/10 dark:bg-blue-400/10 ' +
    'hover:bg-blue-500/20 dark:hover:bg-blue-400/20 text-blue-600 dark:text-blue-400 transition-colors';
const DELETE_CLASS = 'flex items-center justify-center w-7 h-7 rounded-lg bg-red-500/10 dark:bg-red-400/10 ' +
    'hover:bg-red-500/20 dark:hover:bg-red-400/20 text-red-600 dark:text-red-400 transition-colors';

const TOTAL_CLASS: Record<'met' | 'unmet', string> = {
    met: 'text-base font-bold text-primary',
    unmet: 'text-base font-bold text-slate-700 dark:text-slate-300'
};
const CHEVRON_CLASS: Record<'open' | 'closed', string> = {
    open: 'material-symbols-outlined text-primary text-sm transition-transform rotate-180',
    closed: 'material-symbols-outlined text-primary text-sm transition-transform'
};

interface SessionGroupCardProps {
    readonly group: SessionGroup;
    readonly onEdit: (session: WorkSession) => void;
    readonly onDelete: (session: WorkSession) => void;
}

export default function SessionGroupCard({ group, onEdit, onDelete }: SessionGroupCardProps): ReactElement {
    const [open, setOpen] = useState(false);
    const badge = formatDayBadge(group.date);
    const only = group.sessions.length === 1 ? group.sessions[0] : undefined;

    return (
        <>
            {group.startsNewDay ? (
                <div className="flex items-center gap-4 my-2 px-2 opacity-50">
                    <div className="h-px bg-slate-300 dark:bg-slate-700 flex-1" />
                    <div className="h-px bg-slate-300 dark:bg-slate-700 flex-1" />
                </div>
            ) : null}
            <div className={CARD_CLASS}>
                <button
                    type="button"
                    className={HEADER_CLASS}
                    aria-expanded={open}
                    onClick={() => { setOpen(!open); }}
                >
                    <div className={BADGE_CLASS}>
                        <span className="text-[10px] font-bold uppercase text-slate-500 dark:text-slate-400">
                            {badge.weekday}
                        </span>
                        <span className="text-xl font-bold text-slate-900 dark:text-white">{badge.day}</span>
                    </div>
                    <div className="flex flex-1 flex-col justify-center overflow-hidden">
                        <div className="flex items-center gap-2">
                            <p className="truncate text-base font-semibold text-slate-900 dark:text-white">
                                {group.companyName}
                            </p>
                            {group.hasNotes ? (
                                <span className="material-symbols-outlined text-slate-400 text-sm">sticky_note_2</span>
                            ) : null}
                            <span className={CHEVRON_CLASS[open ? 'open' : 'closed']}>expand_more</span>
                        </div>
                        <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                            <span className="material-symbols-outlined text-[14px]">schedule</span>
                            <span>{describeSessionCount(group.sessions.length)}</span>
                            {only === undefined ? null : <span className="text-slate-400">&bull;</span>}
                            {only === undefined ? null : <span className="truncate">{only.name}</span>}
                        </div>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                        <p className={TOTAL_CLASS[group.goalMet ? 'met' : 'unmet']}>
                            {formatDurationShort(group.totalSeconds)}
                        </p>
                        {group.goalMet ? (
                            <div className={GOAL_PILL_CLASS}>
                                <span className="material-symbols-outlined text-[12px] text-green-600 dark:text-green-400 font-bold">
                                    check
                                </span>
                                <span className="text-[10px] font-bold text-green-600 dark:text-green-400 uppercase tracking-wider">
                                    Goal
                                </span>
                            </div>
                        ) : null}
                    </div>
                </button>
                {open ? (
                    <div className="mt-4 pt-4 border-t border-slate-200 dark:border-white/10">
                        <div className="flex flex-col gap-3">
                            {group.sessions.map((session) => (
                                <div key={session.id} className={DETAIL_ROW_CLASS}>
                                    <div className="flex-1 overflow-hidden">
                                        <div className="flex items-center gap-2 mb-1">
                                            <p className="text-sm font-semibold text-slate-900 dark:text-white truncate">
                                                {session.name}
                                            </p>
                                            {(session.note ?? '').trim() === '' ? null : (
                                                <span className="material-symbols-outlined text-slate-400 text-xs">
                                                    sticky_note_2
                                                </span>
                                            )}
                                        </div>
                                        <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                                            <span className="material-symbols-outlined text-[12px]">schedule</span>
                                            <span>{formatClockTime(session.createdAt)}</span>
                                            <span className="text-slate-400">&bull;</span>
                                            <span className="font-medium text-primary">
                                                {formatDurationShort(session.durationSeconds)}
                                            </span>
                                        </div>
                                        {(session.note ?? '').trim() === '' ? null : (
                                            <div className="mt-2 pt-2 border-t border-slate-200 dark:border-white/5">
                                                <p className="text-xs text-slate-500 dark:text-slate-400 italic">
                                                    {session.note}
                                                </p>
                                            </div>
                                        )}
                                    </div>
                                    <div className="flex items-center gap-1">
                                        <button
                                            type="button"
                                            aria-label={'Edit ' + session.name}
                                            className={EDIT_CLASS}
                                            onClick={() => { onEdit(session); }}
                                        >
                                            <span className="material-symbols-outlined text-[16px]">edit</span>
                                        </button>
                                        <button
                                            type="button"
                                            aria-label={'Delete ' + session.name}
                                            className={DELETE_CLASS}
                                            onClick={() => { onDelete(session); }}
                                        >
                                            <span className="material-symbols-outlined text-[16px]">delete</span>
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                ) : null}
            </div>
        </>
    );
}
