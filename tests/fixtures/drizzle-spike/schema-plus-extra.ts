// The real schema plus one additive table, used only by the D-05 spike in tests/db-pipeline.test.ts.
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export * from '../../../src/lib/db/schema';

export const spikeProbe = sqliteTable('spike_probe', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    label: text('label').notNull()
}, (t) => [index('spike_probe_label_idx').on(t.label)]);
