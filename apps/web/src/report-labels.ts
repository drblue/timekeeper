export function reportIdentityLabels<T>(
	rows: T[],
	label: (row: T) => string,
	identity: (row: T) => string,
	unassigned = 'Unassigned',
) {
	const identities = new Map<string, Set<string>>();
	for (const row of rows) {
		const name = label(row);
		let ids = identities.get(name);
		if (!ids) {
			ids = new Set();
			identities.set(name, ids);
		}
		ids.add(identity(row));
	}
	return (row: T) => {
		const name = label(row);
		const ids = identities.get(name);
		if (!ids || ids.size < 2) return name;
		const id = identity(row);
		if (!id) return name + ' · ' + unassigned;
		const short = id.slice(0, 8);
		const sharedPrefix = Array.from(ids).some((other) => other !== id && other.startsWith(short));
		return name + ' · ID ' + (sharedPrefix ? id : short);
	};
}
