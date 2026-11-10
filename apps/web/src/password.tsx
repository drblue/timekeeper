import { Link } from '@tanstack/react-router';
import { authPasswordPath, maxPasswordLength, minPasswordLength } from '@timekeeper/contracts';
import type { ChangePasswordBody } from '@timekeeper/contracts';
import { useState } from 'react';
import type { SubmitEvent } from 'react';
import { authError, postAuth, readSessionResponse, useReplaceSession, useSession } from './auth';

const passwordRequirements = `Use between ${minPasswordLength} and ${maxPasswordLength} characters.`;

export function Password() {
	const { session, refresh } = useSession();
	const replaceSession = useReplaceSession();
	const [pending, setPending] = useState(false);
	const [error, setError] = useState('');
	const [changed, setChanged] = useState(false);

	async function changePassword(event: SubmitEvent<HTMLFormElement>) {
		event.preventDefault();
		if (pending) return;

		const form = event.currentTarget;
		const data = new FormData(form);
		const currentPassword = String(data.get('currentPassword'));
		const newPassword = String(data.get('newPassword'));
		setChanged(false);

		const length = Array.from(newPassword).length;
		if (length < minPasswordLength || length > maxPasswordLength) {
			setError(passwordRequirements);
			return;
		}
		if (newPassword !== data.get('confirmPassword')) {
			setError('The new passwords do not match. Enter the same password in both fields.');
			return;
		}

		setPending(true);
		setError('');
		try {
			const response = await postAuth(authPasswordPath, session.csrfToken, {
				currentPassword,
				newPassword,
			} satisfies ChangePasswordBody);
			if (response.ok) {
				await replaceSession(await readSessionResponse(response));
				form.reset();
				setChanged(true);
			} else {
				setError(await authError(response, refresh));
			}
		} catch {
			setError('Could not confirm the password change. Check your connection and try again.');
		} finally {
			setPending(false);
		}
	}

	return (
		<section className="account-view" aria-labelledby="password-heading">
			<h1 id="password-heading">Change password</h1>
			<p className="intro">Update the password for <strong className="email">{session.account?.email}</strong>.</p>
			<form className="panel account-form" onSubmit={changePassword} aria-busy={pending}>
				<input type="hidden" name="email" autoComplete="username" value={session.account?.email} />
				{error ? <p className="feedback error" role="alert">{error}</p> : null}
				{changed ? <p className="feedback" role="status">Your password was changed.</p> : null}
				<div className="field">
					<label htmlFor="current-password">Current password</label>
					<input id="current-password" name="currentPassword" type="password" autoComplete="current-password" required readOnly={pending} />
				</div>
				<div className="field">
					<label htmlFor="new-password">New password</label>
					<p className="field-hint" id="password-requirements">{passwordRequirements}</p>
					<input id="new-password" name="newPassword" type="password" autoComplete="new-password" aria-describedby="password-requirements" required readOnly={pending} />
				</div>
				<div className="field">
					<label htmlFor="confirm-password">Confirm new password</label>
					<input id="confirm-password" name="confirmPassword" type="password" autoComplete="new-password" required readOnly={pending} />
				</div>
				<div className="form-actions">
					<button type="submit" className="primary" disabled={pending}>{pending ? 'Changing password…' : 'Change password'}</button>
					<Link to="/">Back to Timekeeper</Link>
				</div>
			</form>
		</section>
	);
}
