import { authLoginPath } from '@timekeeper/contracts';
import type { LoginBody } from '@timekeeper/contracts';
import { Navigate } from '@tanstack/react-router';
import { useState } from 'react';
import type { SubmitEvent } from 'react';
import { authError, postAuth, readSessionResponse, useReplaceSession, useSession } from './auth';

export function Login() {
	const { session, refresh } = useSession();
	const replaceSession = useReplaceSession();
	const [pending, setPending] = useState(false);
	const [error, setError] = useState('');

	if (session.account) {
		return <Navigate to="/" replace />;
	}

	async function signIn(event: SubmitEvent<HTMLFormElement>) {
		event.preventDefault();
		if (pending) return;

		const form = event.currentTarget;
		const data = new FormData(form);
		setPending(true);
		setError('');

		try {
			const response = await postAuth(authLoginPath, session.csrfToken, {
				email: String(data.get('email')).trim(),
				password: String(data.get('password')),
			} satisfies LoginBody);
			if (response.ok) {
				await replaceSession(await readSessionResponse(response));
			} else {
				setError(await authError(response, refresh));
			}
		} catch {
			setError('Could not sign in. Check your connection and try again.');
		} finally {
			const password = form.elements.namedItem('password');
			if (password instanceof HTMLInputElement) password.value = '';
			setPending(false);
		}
	}

	return (
		<section className="account-view" aria-labelledby="sign-in-heading">
			<h1 id="sign-in-heading">Sign in</h1>
			<p className="intro">Use the account set up for you by your Timekeeper operator. Timekeeper requires a connection to the server.</p>
			<form className="panel account-form" onSubmit={signIn} aria-busy={pending}>
				{error ? <p className="feedback error" role="alert">{error}</p> : null}
				<div className="field">
					<label htmlFor="email">Email address</label>
					<input id="email" name="email" type="text" inputMode="email" autoComplete="username" maxLength={254} autoCapitalize="none" spellCheck={false} required readOnly={pending} />
				</div>
				<div className="field">
					<label htmlFor="password">Password</label>
					<input id="password" name="password" type="password" autoComplete="current-password" required readOnly={pending} />
				</div>
				<button type="submit" className="primary" disabled={pending}>{pending ? 'Signing in…' : 'Sign in'}</button>
			</form>
			<p className="recovery"><strong>Forgot your password?</strong> Ask your Timekeeper operator to reset it on the server.</p>
		</section>
	);
}
