import { onlineManager, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
	idempotencyKeyHeader, longRunningTimerSeconds, maxEntryDescriptionLength, parseStopTimerResponse,
	parseTimerStateResponse, timerPath, timerStartPath, timerStopPath,
} from '@timekeeper/contracts';
import type { EntryResponse, StartTimerBody, TimerStateResponse } from '@timekeeper/contracts';
import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import type { SubmitEvent } from 'react';
import { ApiRequestError, readApi, writeApi } from './api';
import { authError, useSession } from './auth';
import { EntryBillingFields, useEntryBilling } from './entry-billing-fields';
import { formatDurationInput } from './entry-time';
import { entriesKey } from './entry-query';
import { formatSek, parseHourlyRate } from './money';
import { readTimerOperation, timerOperationKey, writeTimerOperation } from './timer-operation';
import type { TimerOperation } from './timer-operation';

const timerKey = [timerPath] as const;
const defaultStart: StartTimerBody = { projectId: null, directClientId: null, rateOverrideOrePerHour: null };
const subscribeOnline = (listener: () => void) => onlineManager.subscribe(listener);
const isOnline = () => onlineManager.isOnline();

type ClockSnapshot = { state: TimerStateResponse; measuredAt: number; serverMs: number };

function snapshot(state: TimerStateResponse): ClockSnapshot {
	return { state, measuredAt: performance.now(), serverMs: Date.parse(state.serverNow) };
}

function elapsed(clock: ClockSnapshot) {
	const start = clock.state.timer?.startAt;
	if (!start) return 0;
	const estimatedNow = clock.serverMs + Math.max(0, performance.now() - clock.measuredAt);
	return Math.max(0, Math.floor((estimatedNow - Date.parse(start)) / 1_000));
}

function RunningTime({ clock }: { clock: ClockSnapshot }) {
	const [, setTick] = useState(0);
	useEffect(() => {
		const interval = window.setInterval(() => setTick(performance.now()), 1_000);
		return () => window.clearInterval(interval);
	}, []);
	const seconds = elapsed(clock);
	return (
		<>
			<span className="timer-elapsed" aria-label="Elapsed time" role="timer" aria-live="off">{formatDurationInput(seconds)}</span>
			{seconds >= longRunningTimerSeconds ? (
				<p className="feedback warning timer-warning" role="status">This timer has been running for at least 12 hours.</p>
			) : null}
		</>
	);
}

function TimerStartDetails({ disabled, onStart }: { disabled: boolean; onStart: (body: StartTimerBody) => void }) {
	const billing = useEntryBilling();
	const id = useId();
	const [error, setError] = useState('');

	function submit(event: SubmitEvent<HTMLFormElement>) {
		event.preventDefault();
		if (disabled || !billing.canChoose) return;
		if (billing.unavailable) {
			setError('Choose an active project or client, or leave the timer unassigned.');
			return;
		}
		const form = new FormData(event.currentTarget);
		const description = String(form.get('description')).trim();
		if (Array.from(description).length > maxEntryDescriptionLength) {
			setError(`Enter a description up to ${maxEntryDescriptionLength.toLocaleString('en')} characters.`);
			return;
		}
		try {
			const rateOverrideOrePerHour = parseHourlyRate(String(form.get('rate')));
			setError('');
			onStart({
				...(description ? { description } : {}),
				projectId: billing.projectId,
				directClientId: billing.directClientId,
				rateOverrideOrePerHour,
				...(billing.billability ? { billable: billing.billability === 'billable' } : {}),
			});
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : 'Check the hourly rate.');
		}
	}

	return (
		<form className="record-editor timer-start-form" onSubmit={submit}>
			{error ? <p className="feedback error" role="alert">{error}</p> : null}
			<fieldset className="record-fields" disabled={disabled}>
				<div className="field">
					<label htmlFor={id}>Description (optional)</label>
					<textarea id={id} name="description" rows={2} />
				</div>
				<EntryBillingFields billing={billing} />
				<button className="primary" type="submit" disabled={!billing.canChoose}>Start with details</button>
			</fieldset>
		</form>
	);
}

export function WorkspaceTimer({ account, sessionUnavailable }: { account: string; sessionUnavailable: boolean }) {
	const { session, refresh } = useSession();
	const queryClient = useQueryClient();
	const online = useSyncExternalStore(subscribeOnline, isOnline);
	const [details, setDetails] = useState(false);
	const [operation, setOperation] = useState(() => readTimerOperation(account));
	const [pending, setPending] = useState(false);
	const [error, setError] = useState('');
	const [stopped, setStopped] = useState<EntryResponse | null>(null);
	const writing = useRef(false);
	const priorTimer = useRef<string | null | undefined>(undefined);
	const detailId = useId();
	const titleId = useId();
	const query = useQuery({
		queryKey: timerKey,
		queryFn: async ({ signal }) => snapshot(await readApi(
			timerPath, parseTimerStateResponse, AbortSignal.any([signal, AbortSignal.timeout(10_000)]), refresh,
		)),
		retry: false,
		refetchInterval: 10_000,
		refetchOnWindowFocus: 'always',
		refetchOnReconnect: 'always',
	});
	const clock = query.data;
	const timer = clock?.state.timer;
	const timerId = timer?.id ?? (clock ? null : undefined);
	const disconnected = !online || sessionUnavailable || query.isError;
	const canAct = !!clock && !disconnected && !pending && !operation;

	useEffect(() => {
		if (timerId === undefined) return;
		const previous = priorTimer.current;
		priorTimer.current = timerId;
		if (previous && previous !== timerId) void queryClient.invalidateQueries({ queryKey: entriesKey });
	}, [timerId, queryClient]);

	async function run(request: TimerOperation) {
		if (writing.current || !online || sessionUnavailable) return;
		writing.current = true;
		setPending(true);
		setError('');
		setStopped(null);
		setOperation(request);
		writeTimerOperation(account, request);
		try {
			await queryClient.cancelQueries({ queryKey: timerKey });
			const response = await writeApi(
				request.kind === 'start' ? timerStartPath : timerStopPath, 'POST', session.csrfToken, request.body,
				{ headers: { [idempotencyKeyHeader]: request.key }, signal: AbortSignal.timeout(10_000) },
			);
			if (request.kind === 'start') {
				parseTimerStateResponse(await response.json());
				setDetails(false);
			} else {
				const result = parseStopTimerResponse(await response.json());
				setStopped(result.entry);
				void queryClient.invalidateQueries({ queryKey: entriesKey });
			}
			setOperation(null);
			writeTimerOperation(account, null);
		} catch (cause) {
			if (cause instanceof ApiRequestError && cause.response.status >= 400 && cause.response.status < 500 &&
				cause.response.status !== 408 && cause.response.status !== 429) {
				if (cause.response.status === 401 || cause.response.status === 403) {
					setError(await authError(cause.response, refresh));
				} else {
					setOperation(null);
					writeTimerOperation(account, null);
					switch (cause.code) {
						case 'TIMER_RUNNING':
						case 'TIMER_CONFLICT':
							setError('The timer changed in another session. Check the current timer before trying again.');
							break;
						case 'TIMER_CLOCK_CONFLICT':
							setError('The server clock moved back. The timer is still running. Check the server clock before stopping it again.');
							break;
						case 'IDEMPOTENCY_CONFLICT':
							setError('This request conflicts with a previous timer action. Check the current timer before trying again.');
							break;
						default:
							setError('Could not ' + request.kind + ' the timer. Check the details and try again.');
					}
				}
			} else {
				setError('Could not confirm the timer ' + request.kind + '. Retry the same request to check what happened.');
			}
		} finally {
			await queryClient.invalidateQueries({ queryKey: timerKey });
			setPending(false);
			writing.current = false;
		}
	}

	function start(body: StartTimerBody) {
		if (canAct) void run({ kind: 'start', key: timerOperationKey(), body });
	}

	function stop() {
		if (canAct && timer) {
			void run({ kind: 'stop', key: timerOperationKey(), body: { timerId: timer.id, revision: timer.revision } });
		}
	}

	const association = timer ? [timer.projectName, timer.clientName].filter(Boolean).join(' · ') : '';
	const billing = timer?.billable
		? timer.assignedRateOrePerHour === null ? 'Billable · rate missing' : `Billable · ${formatSek(timer.assignedRateOrePerHour)}/hour`
		: 'Non-billable';

	return (
		<section className="panel workspace-timer" aria-labelledby={titleId} aria-busy={pending}>
			<div className="timer-toolbar">
				<div className="timer-heading">
					<h2 id={titleId}>Timer</h2>
					{timer && clock ? <RunningTime clock={clock} /> : null}
					{clock && !timer && !disconnected ? <span className="field-hint">No timer running</span> : null}
				</div>
				<div className="form-actions">
					{timer ? <button className="primary" type="button" disabled={!canAct} onClick={stop}>Stop timer</button> : (
						<>
							{details ? null : <button className="primary" type="button" disabled={!canAct} onClick={() => start(defaultStart)}>Start timer</button>}
							{clock ? <button type="button" disabled={pending || !!operation} aria-expanded={details}
								aria-controls={detailId} onClick={() => setDetails((open) => !open)}>{details ? 'Hide details' : 'Add details'}</button> : null}
						</>
					)}
				</div>
			</div>
			{timer && (timer.description || association || timer.billable) ? (
				<div className="timer-context">
					{timer.description ? <p>{timer.description}</p> : null}
					<p className="field-hint">{[association, billing].filter(Boolean).join(' · ')}</p>
				</div>
			) : null}
			{!clock && !disconnected ? <p className="field-hint" role="status">Checking timer…</p> : null}
			{pending ? <p className="field-hint" role="status">{operation?.kind === 'stop' ? 'Stopping timer…' : 'Starting timer…'}</p> : null}
			{disconnected ? (
				<div className="feedback warning">
					<p role="status">{timer ? 'Timer status unavailable. Elapsed time is estimated from the last update.' : 'Timer status unavailable.'}</p>
					<button type="button" disabled={!online || query.isFetching || pending} onClick={() => { if (sessionUnavailable) void refresh(); void query.refetch(); }}>Check timer status</button>
				</div>
			) : null}
			{error || (operation && !pending) ? (
				<div className="feedback warning">
					<p role="alert">{error || `The previous timer ${operation?.kind} is awaiting confirmation.`}</p>
					{operation && !pending ? (
						<button type="button" disabled={!online || sessionUnavailable} onClick={() => void run(operation)}>
							{operation.kind === 'start' ? 'Retry start' : 'Retry stop'}
						</button>
					) : null}
				</div>
			) : null}
			{stopped ? (
				<p className="feedback" role="status">
					{stopped.completion === 'incomplete' ? (
						<>Time saved as incomplete. <Link to="/entries/$entryId" params={{ entryId: stopped.id }}>Complete time entry</Link></>
					) : (
						<>Time entry saved. <Link to="/entries/$entryId" params={{ entryId: stopped.id }}>View stopped entry</Link></>
					)}
				</p>
			) : null}
			<div id={detailId} hidden={!details || !!timer}>
				{details && !timer ? <TimerStartDetails disabled={!canAct} onStart={start} /> : null}
			</div>
		</section>
	);
}
