import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const directory = await mkdtemp(join(tmpdir(), 'timekeeper-browser-'));

try {
	const env = {
		...process.env,
		NODE_ENV: 'development',
		TIMEKEEPER_DATABASE_URL: pathToFileURL(join(directory, 'test.sqlite')).href,
	};

	execFileSync('npm', ['run', 'db:migrate'], { env, stdio: 'inherit' });
	execFileSync('npm', ['run', 'account', '--', 'provision', 'operator@example.test'], {
		env,
		input: 'Browser test initial password\n',
		stdio: ['pipe', 'inherit', 'inherit'],
	});

	const server = spawn(process.execPath, ['apps/server/dist/index.js'], { env, stdio: 'inherit' });
	const stop = () => server.kill('SIGTERM');
	process.once('SIGTERM', stop);
	process.once('SIGINT', stop);

	try {
		process.exitCode = await new Promise<number>((resolve, reject) => {
			server.once('error', reject);
			server.once('exit', (code) => resolve(code ?? 1));
		});
	} finally {
		process.removeListener('SIGTERM', stop);
		process.removeListener('SIGINT', stop);
	}
} finally {
	await rm(directory, { recursive: true, force: true });
}
