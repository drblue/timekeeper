import { Link } from '@tanstack/react-router';
import { useSession } from './auth';

export function Home() {
	const { session } = useSession();

	return (
		<>
			<h1>Timekeeper</h1>
			<p className="intro">Signed in as <strong className="email">{session.account?.email}</strong>.</p>
			<details className="install-help">
				<summary>Install Timekeeper</summary>
				<p>Look for Install app in your browser menu. In Safari on iPhone, open Share and choose Add to Home Screen.</p>
				<p>Timekeeper needs a connection to the server to load and save work.</p>
			</details>
			<Link to="/password">Change password</Link>
		</>
	);
}
