// The v1.2.1 tables in live column order (ALTER-appended columns last). drizzle-kit loads this file with its own
// loader, so it imports only drizzle-orm and drizzle-orm/sqlite-core (D-11).
import { sql } from 'drizzle-orm';
import { customType, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// DATETIME keeps NUMERIC affinity; text() would silently change it to TEXT (Pattern 11).
const datetime = customType<{ data: string; driverData: string }>({ dataType: () => 'DATETIME' });

export const companies = sqliteTable('companies', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull().unique(),
    created_at: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
    updated_at: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
    excel_column: text('excel_column'),
    note_column: text('note_column'),
    note_required: integer('note_required').default(0)
});

export const workSessions = sqliteTable('work_sessions', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    duration: integer('duration').notNull(),
    date: text('date').notNull(),
    created_at: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
    company_id: integer('company_id').references(() => companies.id, { onDelete: 'cascade' }),
    note: text('note')
}, (t) => [
    index('work_sessions_date_idx').on(t.date),
    index('work_sessions_company_id_idx').on(t.company_id)
]);

export const settings = sqliteTable('settings', {
    key: text('key').primaryKey(),
    value: text('value').notNull()
});

export const pomodoroSessions = sqliteTable('pomodoro_sessions', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    date: text('date').notNull(),
    company_id: integer('company_id').references(() => companies.id, { onDelete: 'cascade' }),
    pomodoros_completed: integer('pomodoros_completed').default(1),
    created_at: datetime('created_at').default(sql`CURRENT_TIMESTAMP`)
}, (t) => [index('pomodoro_sessions_date_idx').on(t.date)]);

// Machine state, never a user preference; preferences stay in settings (D-18).
export const appState = sqliteTable('app_state', {
    key: text('key').primaryKey(),
    value: text('value').notNull(),
    updated_at: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`)
});

export type CompanyRow = typeof companies.$inferSelect;
export type NewCompanyRow = typeof companies.$inferInsert;
export type WorkSessionRow = typeof workSessions.$inferSelect;
export type NewWorkSessionRow = typeof workSessions.$inferInsert;
export type SettingRow = typeof settings.$inferSelect;
export type NewSettingRow = typeof settings.$inferInsert;
export type PomodoroSessionRow = typeof pomodoroSessions.$inferSelect;
export type NewPomodoroSessionRow = typeof pomodoroSessions.$inferInsert;
export type AppStateRow = typeof appState.$inferSelect;
export type NewAppStateRow = typeof appState.$inferInsert;
