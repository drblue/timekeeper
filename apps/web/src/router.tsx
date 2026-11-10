import { createRootRoute, createRoute, createRouter, Navigate, Outlet } from '@tanstack/react-router';
import { authLogoutPath } from '@timekeeper/contracts';
import { useState } from 'react';
import { authError, postAuth, SessionContext, useReplaceSession, useSession, useSessionQuery } from './auth';
import { Home } from './home';
import { Login } from './login';
import { Password } from './password';

function SignOut() {
	const { session, refresh } = useSession();
	const replaceSession = useReplaceSession();
	const [pending, setPending] = useState(false);
	const [error, setError] = useState('');

	async function signOut() {
		setPending(true);
		setError('');
		try {
			const response = await postAuth(authLogoutPath, session.csrfToken);
			if (response.ok) {
				await replaceSession(undefined);
			} else {
				setError(await authError(response, refresh));
			}
		} catch {
			setError('Could not confirm sign-out. Check your connection and try again.');
		} finally {
			setPending(false);
		}
	}

	return (
		<div className="sign-out">
			<button type="button" onClick={() => void signOut()} disabled={pending}>
				{pending ? 'Signing out…' : 'Sign out'}
			</button>
			{error ? <p className="sign-out-error feedback error" role="alert">{error}</p> : null}
		</div>
	);
}

function Layout() {
	const session = useSessionQuery();
	const content = session.isError ? (
		<section className="account-view">
			<h1>Connection unavailable</h1>
			<p className="intro" role="alert">Could not check your session. Check your connection and try again.</p>
			<button type="button" disabled={session.isFetching} onClick={() => void session.refetch()}>Try again</button>
		</section>
	) : session.data ? <Outlet /> : <p role="status">Checking your session…</p>;

	return (
		<SessionContext value={session.data ? { session: session.data, refresh: session.refetch } : null}>
			<header className="site-header">
				<div className="shell header-content">
					<div className="brand">
						<svg aria-hidden="true" viewBox="0 0 28 28" width="28" height="28">
							<rect width="28" height="28" rx="7" fill="currentColor" />
							<path d="M14 6v8l5 3" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" />
						</svg>
						<span>Timekeeper</span>
					</div>
					{!session.isError && session.data?.account ? <SignOut /> : null}
				</div>
			</header>
			<main className="shell main-content">{content}</main>
		</SessionContext>
	);
}

function RequireAccount() {
	const { session } = useSession();
	return session.account ? <Outlet /> : <Navigate to="/login" replace />;
}

const rootRoute = createRootRoute({ component: Layout });
const loginRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/login',
	component: Login,
});
const protectedRoute = createRoute({
	getParentRoute: () => rootRoute,
	id: 'protected',
	component: RequireAccount,
});
const homeRoute = createRoute({
	getParentRoute: () => protectedRoute,
	path: '/',
	component: Home,
});
const passwordRoute = createRoute({
	getParentRoute: () => protectedRoute,
	path: '/password',
	component: Password,
});

export const router = createRouter({
	routeTree: rootRoute.addChildren([loginRoute, protectedRoute.addChildren([homeRoute, passwordRoute])]),
});

declare module '@tanstack/react-router' {
	interface Register {
		router: typeof router;
	}
}
