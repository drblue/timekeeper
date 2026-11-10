import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { defineConfig } from 'prisma/config';
import { databaseUrl } from '../../apps/server/src/auth/database-location.ts';

if (existsSync('.env')) {
	loadEnvFile('.env');
}

export default defineConfig({
	schema: 'schema.prisma',
	migrations: { path: 'migrations' },
	datasource: { url: databaseUrl() },
});
