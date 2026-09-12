// The database layer's public surface: the one module src/main/index.ts imports after the lock (D-10).
// Re-exports only, so loading it still opens nothing (BUILD-04).

export { closeDatabase, openDatabase, setJournalModeWal } from './client';
export type { OpenDatabaseOptions } from './client';

export { classify, V1X_TABLES } from './classify';
export type { DbClass, ObservedDatabase, V1xTable } from './classify';

export { probeDatabase } from './probe';
export type { ProbeOptions, ProbeResult } from './probe';

export { MigrationFailedError, migrateDatabase, splitStatements } from './runner';
export type { AnomalyCounts, MigrationOptions, MigrationReport, MigrationStep, RunnerHooks } from './runner';

export { LATEST, MIGRATIONS } from './migrations/registry';

export {
    APP_STATE_KEYS, importLegacyState, readAppState, readTimerState, writeAppState, writeTimerState
} from './app-state';
export type {
    AppStateKey, AppStateValue, LegacyImportResult, LegacyStorageValues, RestoredTimerState, TimerStateInput,
    TimerStateSource
} from './app-state';

export { parseLegacyTimerState } from './legacy-timer';
export type { LegacyTimerRecord } from './legacy-timer';

export { pruneBackups, readDatabaseStats } from './backup';
export type { BackupVerification, PruneOutcome } from './backup';

export { createDbHandle, transact } from './handle';
export type { DbHandle } from './handle';

export {
    RowMappingError, SETTINGS_KEY_MAP, createCompaniesRepository, createPomodoroRepository, createSessionsRepository,
    createSettingsRepository
} from './repositories';
export type {
    CompaniesRepository, CompanyInput, PomodoroRepository, RepositoryOptions, SessionInput, SessionsRepository,
    SettingsRepository, SkippedRowReport
} from './repositories';
