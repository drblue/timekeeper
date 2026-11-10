import { createRootRoute, createRoute, createRouter, Outlet } from '@tanstack/react-router';
import { Home } from './home';

function Layout() {
	return (
		<>
			<header className="site-header">
				<div className="shell brand">
					<svg aria-hidden="true" viewBox="0 0 28 28" width="28" height="28">
						<rect width="28" height="28" rx="7" fill="currentColor" />
						<path d="M14 6v8l5 3" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" />
					</svg>
					<span>Timekeeper</span>
				</div>
			</header>
			<main className="shell main-content"><Outlet /></main>
		</>
	);
}

const rootRoute = createRootRoute({ component: Layout });
const homeRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/',
	component: Home,
});

export const router = createRouter({ routeTree: rootRoute.addChildren([homeRoute]) });

declare module '@tanstack/react-router' {
	interface Register {
		router: typeof router;
	}
}
