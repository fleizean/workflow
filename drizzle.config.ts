// drizzle-kit authoring config. The project's runner applies migrations; drizzle never does (D-08).
import { defineConfig } from 'drizzle-kit';

export default defineConfig({ dialect: 'sqlite', schema: './src/lib/db/schema.ts', out: './src/lib/db/migrations' });
