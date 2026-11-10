import { stdin, stderr } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { databaseUrl } from './database-location.ts';
import { openDatabase } from './database.ts';
import { normalizeEmail, passwordLengthMessage, validEmail, validNewPassword } from './passwords.ts';
import { provisionAccount, resetAccount } from './store.ts';

async function readPassword(): Promise<string> {
	if (!stdin.isTTY) {
		stdin.setEncoding('utf8');
		let password = '';
		for await (const chunk of stdin) {
			password += chunk;
			if (password.length > 1_024) {
				throw new Error('Password input is too long.');
			}
		}
		return password.replace(/\r?\n$/, '');
	}

	const mutedOutput = new Writable({
		write(_chunk, _encoding, callback) { callback(); },
	});
	const prompt = createInterface({ input: stdin, output: mutedOutput, terminal: true, historySize: 0 });
	const interrupted = new AbortController();
	prompt.on('SIGINT', () => interrupted.abort());
	try {
		stderr.write('New password: ');
		const password = await prompt.question('', { signal: interrupted.signal });
		stderr.write('\nConfirm new password: ');
		const confirmation = await prompt.question('', { signal: interrupted.signal });
		if (confirmation !== password) {
			throw new Error('Passwords did not match.');
		}
		return password;
	} finally {
		prompt.close();
		stderr.write('\n');
	}
}

async function run() {
	const [action, argument, ...extra] = process.argv.slice(2);
	if (extra.length || (action !== 'provision' && action !== 'reset') ||
		(action === 'provision' ? argument === undefined : argument !== undefined)) {
		throw new Error('Usage: npm run account -- provision <email> or npm run account -- reset.');
	}
	const email = argument === undefined ? undefined : normalizeEmail(argument);
	if (email !== undefined && !validEmail(email)) {
		throw new Error('Enter a valid account email address.');
	}

	const password = await readPassword();
	if (!validNewPassword(password)) {
		throw new Error(passwordLengthMessage);
	}

	const database = await openDatabase(databaseUrl());
	let changed: boolean;
	try {
		changed = email === undefined
			? await resetAccount(database, password)
			: await provisionAccount(database, email, password);
	} catch {
		throw new Error('Could not update the account.');
	} finally {
		await database.$disconnect();
	}

	if (!changed) {
		throw new Error(email === undefined ? 'No account exists. Run the provision command first.' :
			'An account already exists. Use the reset command to restore access.');
	}
	console.log(email === undefined ? 'Password reset. Existing sessions have been revoked.' : 'Account created.');
}

try {
	await run();
} catch (error) {
	console.error(error instanceof Error ? error.message : 'The account command failed.');
	process.exitCode = 1;
}
