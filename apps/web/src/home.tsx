import { Link } from '@tanstack/react-router';
import { useSession } from './auth';

export function Home() {
	const { session } = useSession();

	return (
		<>
			<h1>Timekeeper</h1>
			<p className="intro">Signed in as <strong className="email">{session.account?.email}</strong>.</p>
			<Link to="/password">Change password</Link>
		</>
	);
}
