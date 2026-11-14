import { createRootRoute, createRoute, createRouter, lazyRouteComponent, Link, Navigate, Outlet } from '@tanstack/react-router';
import { authLogoutPath } from '@timekeeper/contracts';
import { useState } from 'react';
import { Clients, Projects } from './catalog-page';
import { authError, postAuth, SessionContext, useReplaceSession, useSession, useSessionQuery } from './auth';
import { Home } from './home';
import { Login } from './login';
import { Password } from './password';
import { writeBulkOperation } from './bulk-operation';
import { writeTimerOperation } from './timer-operation';
import { writeReportPdf } from './report-pdf-state';
import { validateReportSearch } from './report-search';
import { validateWorkListLocation } from './work-list-search';
import { WorkspaceTimer } from './workspace-timer';

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
				if (session.account) {
					writeTimerOperation(session.account.email, null);
					writeBulkOperation(session.account.email, null);
					writeReportPdf(session.account.email, null);
				}
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
	const signedIn = !session.isError && !!session.data?.account;
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
					{signedIn ? (
						<>
							<nav className="workspace-nav" aria-label="Workspace">
								<Link to="/" activeOptions={{ exact: true }}>Home</Link>
								<Link to="/entries">Entries</Link>
								<Link to="/clients">Clients</Link>
								<Link to="/projects">Projects</Link>
							</nav>
							<SignOut />
						</>
					) : null}
				</div>
			</header>
			<main className="shell main-content">
				{session.data?.account ? (
					<WorkspaceTimer key={session.data.account.email} account={session.data.account.email} sessionUnavailable={session.isError}>
						{content}
					</WorkspaceTimer>
				) : content}
			</main>
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
const clientsRoute = createRoute({
	getParentRoute: () => protectedRoute,
	path: '/clients',
	component: Clients,
});
const projectsRoute = createRoute({
	getParentRoute: () => protectedRoute,
	path: '/projects',
	component: Projects,
});
const entriesRoute = createRoute({
	getParentRoute: () => protectedRoute,
	path: '/entries',
	validateSearch: validateWorkListLocation,
	component: lazyRouteComponent(() => import('./entries'), 'Entries'),
});
const entryDetailRoute = createRoute({
	getParentRoute: () => protectedRoute,
	path: '/entries/$entryId',
	validateSearch: validateWorkListLocation,
	component: lazyRouteComponent(() => import('./entries'), 'EntryDetail'),
});

const entryTrashRoute = createRoute({
	getParentRoute: () => protectedRoute,
	path: '/entries/trash',
	validateSearch: validateWorkListLocation,
	component: lazyRouteComponent(() => import('./entry-trash'), 'EntryTrash'),
});

const reportPreviewRoute = createRoute({
	getParentRoute: () => protectedRoute,
	path: '/reports/preview',
	validateSearch: validateReportSearch,
	component: lazyRouteComponent(() => import('./report-preview'), 'ReportPreview'),
});

const reportSettingsRoute = createRoute({
	getParentRoute: () => protectedRoute,
	path: '/settings/report',
	validateSearch: validateReportSearch,
	component: lazyRouteComponent(() => import('./report-settings'), 'ReportSettings'),
});

const clockifyRoute = createRoute({
	getParentRoute: () => protectedRoute,
	path: '/imports/clockify',
	validateSearch: validateWorkListLocation,
	component: lazyRouteComponent(() => import('./clockify-inspection'), 'ClockifyInspection'),
});

export const router = createRouter({
	parseSearch: (search) => Object.fromEntries(new URLSearchParams(search)),
	stringifySearch: (search) => {
		const params = new URLSearchParams();
		for (const [name, value] of Object.entries(search)) {
			if (value !== undefined) params.set(name, String(value));
		}
		const query = params.toString();
		return query ? '?' + query : '';
	},
	routeTree: rootRoute.addChildren([
		loginRoute,
		protectedRoute.addChildren([homeRoute, passwordRoute, clientsRoute, projectsRoute, entriesRoute, entryDetailRoute, entryTrashRoute, reportPreviewRoute, reportSettingsRoute, clockifyRoute]),
	]),
});

declare module '@tanstack/react-router' {
	interface HistoryState {
		entryMovedToTrash?: boolean;
		reportPreviewReturned?: boolean;
		clockifyInspectionReturned?: boolean;
	}

	interface Register {
		router: typeof router;
	}
}
