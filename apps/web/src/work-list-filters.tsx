import { useQuery } from '@tanstack/react-query';
import { parseClientListResponse, parseProjectListResponse } from '@timekeeper/contracts';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { SubmitEvent } from 'react';
import { useSession } from './auth';
import { catalogKey, catalogPaths, readCatalog } from './catalog';
import { billabilityChoices, datePresets, invoiceChoices, validateWorkListSearch, workSortChoices } from './work-list-search';
import type { WorkListSearch } from './work-list-search';

type DateRange = { from: string; to: string };

export function WorkListFilters({ search, range, onApply, showSort = true }: {
	search: WorkListSearch;
	range?: DateRange;
	onApply: (search: WorkListSearch) => void;
	showSort?: boolean;
}) {
	const { refresh } = useSession();
	const id = useId();
	const [open, setOpen] = useState(false);
	const [custom, setCustom] = useState(search.preset === 'custom');
	const [dateError, setDateError] = useState('');
	const customFrom = useRef<HTMLInputElement>(null);
	const filters = useRef<HTMLButtonElement>(null);
	const focusCustom = useRef(false);
	const preset = search.preset ?? 'this-week';

	useLayoutEffect(() => {
		if (open && custom && focusCustom.current) {
			focusCustom.current = false;
			customFrom.current?.focus();
		}
	}, [open, custom]);
	const clients = useQuery({
		queryKey: [...catalogKey, 'client'],
		queryFn: ({ signal }) => readCatalog(catalogPaths.client, parseClientListResponse, signal, refresh),
		enabled: open || !!search.clientId || !!search.projectId,
		retry: false,
	});
	const projects = useQuery({
		queryKey: [...catalogKey, 'project'],
		queryFn: ({ signal }) => readCatalog(catalogPaths.project, parseProjectListResponse, signal, refresh),
		enabled: open || !!search.projectId,
		retry: false,
	});
	const clientById = new Map(clients.data?.map((item) => [item.id, item]));
	const clientName = search.clientId ? clientById.get(search.clientId)?.name ?? 'Selected client' : undefined;
	const projectName = search.projectId ? projects.data?.find((item) => item.id === search.projectId)?.name ?? 'Selected project' : undefined;
	const active = [
		clientName,
		projectName,
		search.invoice && invoiceChoices[search.invoice],
		search.billability && billabilityChoices[search.billability],
		search.description && `Description “${search.description}”`,
		search.invoiceNumber && `Invoice number “${search.invoiceNumber}”`,
		search.sort && workSortChoices[search.sort],
	].filter(Boolean);

	function pickPreset(next: keyof typeof datePresets) {
		setDateError('');
		setCustom(next === 'custom');
		if (next === 'custom') {
			if (open && custom) customFrom.current?.focus();
			else focusCustom.current = true;
			setOpen(true);
		} else {
			onApply({ ...search, preset: next === 'this-week' ? undefined : next, from: undefined, to: undefined, page: undefined });
		}
	}

	function submit(event: SubmitEvent<HTMLFormElement>) {
		event.preventDefault();
		const form = new FormData(event.currentTarget);
		const from = String(form.get('from') ?? '');
		const to = String(form.get('to') ?? '');
		if (custom && (!from || !to || from > to)) {
			setDateError('Enter a start and end date in order.');
			customFrom.current?.focus();
			return;
		}
		setDateError('');
		onApply(validateWorkListSearch({
			...Object.fromEntries(form), preset: custom ? 'custom' : preset,
		}));
		setOpen(false);
		filters.current?.focus();
	}

	function clear() {
		setCustom(false);
		setOpen(false);
		setDateError('');
		onApply({});
		filters.current?.focus();
	}

	return (
		<div className="panel work-list-controls">
			<div className="work-list-control-heading">
				<div>
					<h2>Date range</h2>
					{range ? <p className="field-hint"><time dateTime={range.from}>{range.from}</time> to <time dateTime={range.to}>{range.to}</time></p> : null}
				</div>
				<button type="button" ref={filters} aria-expanded={open} aria-controls={id + '-filters'}
					onClick={() => { setCustom(preset === 'custom'); setDateError(''); setOpen(!open); }}>
					{open ? 'Hide filters' : 'Filters'}{!open && active.length ? ` (${active.length})` : ''}
				</button>
			</div>
			<div className="work-list-presets" role="group" aria-label="Date shortcuts">
				{Object.entries(datePresets).map(([value, label]) => (
					<button key={value} type="button" aria-pressed={custom ? value === 'custom' : preset === value}
						onClick={() => pickPreset(value as keyof typeof datePresets)}>{label}</button>
				))}
			</div>
			{active.length ? <p className="field-hint work-list-active">Filters: {active.join(' · ')}</p> : null}
			<div id={id + '-filters'} hidden={!open}>
				{open ? (
					<form className="record-editor work-list-filter-form" onSubmit={submit}
						key={[search.from, search.to, search.clientId, search.projectId, search.invoice, search.billability, search.description, search.invoiceNumber].join('|')}>
						<div className="work-list-filter-grid">
							{custom ? (
								<>
									<div className="field">
										<label htmlFor={id + '-from'}>From date</label>
										<input ref={customFrom} id={id + '-from'} type="date" name="from" defaultValue={search.from ?? range?.from}
											aria-invalid={dateError ? true : undefined} aria-describedby={dateError ? id + '-date-error' : undefined} />
									</div>
									<div className="field">
										<label htmlFor={id + '-to'}>To date</label>
										<input id={id + '-to'} type="date" name="to" defaultValue={search.to ?? range?.to} />
									</div>
								</>
							) : null}
							{dateError ? <p className="entry-field-error work-list-span" id={id + '-date-error'} role="alert">{dateError}</p> : null}
							<div className="field">
								<label htmlFor={id + '-description'}>Search description</label>
								<input id={id + '-description'} type="search" name="description" maxLength={256} defaultValue={search.description} />
							</div>
							<div className="field">
								<label htmlFor={id + '-number'}>Search invoice number</label>
								<input id={id + '-number'} type="search" name="invoiceNumber" maxLength={256} defaultValue={search.invoiceNumber} />
							</div>
							<div className="field">
								<label htmlFor={id + '-client'}>Client</label>
								<select id={id + '-client'} name="clientId" defaultValue={search.clientId ?? ''}>
									<option value="">All clients</option>
									{search.clientId && !clientById.has(search.clientId) ? <option value={search.clientId}>Selected client</option> : null}
									{clients.data?.map((client) => <option key={client.id} value={client.id}>
										{client.name}{client.archivedAt ? ' (archived)' : ''}
									</option>)}
								</select>
							</div>
							<div className="field">
								<label htmlFor={id + '-project'}>Project</label>
								<select id={id + '-project'} name="projectId" defaultValue={search.projectId ?? ''}>
									<option value="">All projects</option>
									{search.projectId && !projects.data?.some((project) => project.id === search.projectId)
										? <option value={search.projectId}>Selected project</option> : null}
									{projects.data?.map((project) => <option key={project.id} value={project.id}>
										{project.name}{project.clientId ? ` (${clientById.get(project.clientId)?.name ?? 'Client'})` : ''}
										{project.archivedAt ? ' (archived)' : ''}
									</option>)}
								</select>
							</div>
							<div className="field">
								<label htmlFor={id + '-invoice'}>Invoice status</label>
								<select id={id + '-invoice'} name="invoice" defaultValue={search.invoice ?? 'all'}>
									{Object.entries(invoiceChoices).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
								</select>
							</div>
							<div className="field">
								<label htmlFor={id + '-billability'}>Billability</label>
								<select id={id + '-billability'} name="billability" defaultValue={search.billability ?? 'all'}>
									{Object.entries(billabilityChoices).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
								</select>
							</div>
							{showSort ? (
								<div className="field">
									<label htmlFor={id + '-sort'}>Sort</label>
									<select id={id + '-sort'} name="sort" defaultValue={search.sort ?? 'newest'}>
										{Object.entries(workSortChoices).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
									</select>
								</div>
							) : null}
						</div>
						{clients.isPending || projects.isPending ? <p className="field-hint" role="status">Loading clients and projects…</p> : null}
						{clients.isError || projects.isError ? (
							<div className="feedback error catalog-load-error">
								<p role="alert">Could not load client and project choices.</p>
								<button type="button" onClick={() => { void clients.refetch(); void projects.refetch(); }}>Try again</button>
							</div>
						) : null}
						<div className="form-actions">
							<button className="primary" type="submit">Apply filters</button>
							<button type="button" onClick={clear}>Reset filters</button>
						</div>
					</form>
				) : null}
			</div>
		</div>
	);
}
