// Every query key in one place, so an invalidation and the query it means to refresh cannot drift apart.

export const queryKeys = {
    companies: ['companies'] as const,
    sessions: ['sessions'] as const,
    settings: ['settings'] as const,
    timerSnapshot: ['timer', 'snapshot'] as const
};
