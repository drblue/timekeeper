import { catalogNameKey } from '@timekeeper/contracts';
import type { ClientResponse, ProjectResponse } from '@timekeeper/contracts';

export interface ClockifyCatalog {
	clients: ClientResponse[];
	projects: ProjectResponse[];
}

export function suggestClockifyMatch<T extends { name: string; id: string }>(name: string, items: T[]) {
	const key = catalogNameKey(name);
	const matches = key ? items.filter((item) => catalogNameKey(item.name) === key) : [];
	return matches.length === 1 ? matches[0]?.id : undefined;
}

export function clockifyCatalogLabels(items: readonly { name: string; id: string }[]) {
	const byName = new Map<string, Set<string>>();
	for (const { name, id } of items) {
		const key = catalogNameKey(name);
		const ids = byName.get(key);
		if (ids) ids.add(id);
		else byName.set(key, new Set([id]));
	}
	return (name: string, id: string) => {
		const peers = byName.get(catalogNameKey(name));
		if (!peers || peers.size < 2) return name;
		const short = id.slice(0, 8);
		const sharesPrefix = [...peers].some((other) => other !== id && other.startsWith(short));
		return name + ' · ID ' + (sharesPrefix ? id : short);
	};
}
