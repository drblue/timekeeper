import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi, Link } from '@tanstack/react-router';
import {
	csrfHeader, maxReportBusinessNameLength, maxReportLogoBytes, maxReportLogoDimension,
	parseReportSettingsResponse, reportLogoPath, reportPreviewPath, reportSettingsPath,
} from '@timekeeper/contracts';
import type { ReportSettingsResponse } from '@timekeeper/contracts';
import { useLayoutEffect, useRef, useState } from 'react';
import type { SubmitEvent } from 'react';
import { ApiRequestError, readApi, requestError, writeApi } from './api';
import { authError, useSession } from './auth';
import { ReportLogo } from './report-logo';

const settingsRoute = getRouteApi('/protected/settings/report');
const settingsKey = [reportSettingsPath];

type Change = 'name' | 'upload' | 'remove';

function brandingError(error: unknown, change: Change) {
	if (error instanceof ApiRequestError) {
		if (error.code === 'REPORT_LOGO_DIMENSIONS') return 'Choose a PNG no larger than 1600 × 1600 pixels.';
		if (error.code === 'REPORT_LOGO_TOO_LARGE' || error.response.status === 413) return 'Choose a PNG of 1 MiB or less.';
		if (error.code === 'INVALID_REPORT_LOGO' || error.code === 'UNSUPPORTED_REPORT_LOGO_TYPE' || error.response.status === 415) {
			return 'Choose a valid 8-bit non-interlaced PNG image.';
		}
		if (error.response.status === 400 || error.response.status === 422) return change === 'name' ? 'Check the business name and try again.' : 'Could not change the logo. Check the saved logo and try again.';
	}
	return 'Could not confirm the branding change. Check your connection and try again.';
}

function BrandingEditor({ settings, refreshSettings }: { settings: ReportSettingsResponse; refreshSettings: () => Promise<unknown> }) {
	const { session, refresh } = useSession();
	const queryClient = useQueryClient();
	const [nameDraft, setNameDraft] = useState<string>();
	const [upload, setUpload] = useState<{ file: File; expectedLogoId: string }>();
	const file = upload?.file;
	const [removeLogoId, setRemoveLogoId] = useState<string>();
	const removing = !!removeLogoId;
	const [pending, setPending] = useState<Change>();
	const [feedback, setFeedback] = useState('');
	const [error, setError] = useState<{ field: Change; text: string }>();
	const focusAfter = useRef<'file' | 'name' | 'logo' | 'remove' | 'confirm' | undefined>(undefined);
	const nameInput = useRef<HTMLInputElement>(null);
	const fileInput = useRef<HTMLInputElement>(null);
	const logoHeading = useRef<HTMLHeadingElement>(null);
	const removeButton = useRef<HTMLButtonElement>(null);
	const removeHeading = useRef<HTMLParagraphElement>(null);
	const confirmRemove = useRef<HTMLButtonElement>(null);
	const shownName = nameDraft ?? settings.businessName ?? '';

	useLayoutEffect(() => {
		if (removing) removeHeading.current?.focus();
	}, [removing]);

	useLayoutEffect(() => {
		if (pending) return;
		const field = focusAfter.current;
		focusAfter.current = undefined;
		if (field === 'file') fileInput.current?.focus();
		if (field === 'name') nameInput.current?.focus();
		if (field === 'logo') logoHeading.current?.focus();
		if (field === 'remove') (removeButton.current ?? logoHeading.current)?.focus();
		if (field === 'confirm') confirmRemove.current?.focus();
	});

	async function save(change: Change) {
		if (pending) return;
		setError(undefined);
		setFeedback('');
		if (change === 'upload') {
			if (!file) return;
			if (file.size > maxReportLogoBytes || (file.type && file.type !== 'image/png')) {
				focusAfter.current = 'file';
				setError({ field: change, text: file.size > maxReportLogoBytes ? 'Choose a PNG of 1 MiB or less.' : 'Choose a valid PNG image.' });
				return;
			}
		}
		setPending(change);
		try {
			const signal = AbortSignal.timeout(10_000);
			const response = change === 'name'
				? await writeApi(reportSettingsPath, 'PUT', session.csrfToken, { businessName: shownName.trim() || null }, { signal })
				: await fetch(reportLogoPath + '?' + new URLSearchParams({
					expectedLogoId: change === 'upload' ? upload?.expectedLogoId ?? 'none' : removeLogoId ?? 'none',
				}), {
					method: change === 'upload' ? 'PUT' : 'DELETE',
					cache: 'no-store',
					headers: { [csrfHeader]: session.csrfToken, ...(change === 'upload' ? { 'Content-Type': 'image/png' } : {}) },
					body: change === 'upload' ? file : undefined,
					signal,
				});
			if (!response.ok) throw await requestError(response);
			const saved = parseReportSettingsResponse(await response.json());
			await queryClient.cancelQueries({ queryKey: settingsKey });
			queryClient.setQueryData(settingsKey, saved);
			void queryClient.invalidateQueries({ queryKey: [reportPreviewPath] });
			if (change === 'name') {
				setNameDraft(undefined);
				focusAfter.current = 'name';
				setFeedback('Business name saved.');
			} else {
				setUpload(undefined);
				if (fileInput.current) fileInput.current.value = '';
				setRemoveLogoId(undefined);
				focusAfter.current = 'logo';
				setFeedback(change === 'upload' ? 'Logo saved.' : 'Logo removed.');
			}
		} catch (cause) {
			if (cause instanceof ApiRequestError && cause.code === 'REPORT_LOGO_CHANGED') {
				void queryClient.invalidateQueries({ queryKey: settingsKey });
				void queryClient.invalidateQueries({ queryKey: [reportPreviewPath] });
				setUpload(undefined);
				if (fileInput.current) fileInput.current.value = '';
				setRemoveLogoId(undefined);
				focusAfter.current = 'logo';
				setError({ field: 'remove', text: 'The saved logo changed in another session. Review the current logo before trying again.' });
				return;
			}
			const text = cause instanceof ApiRequestError && [401, 403].includes(cause.response.status)
				? await authError(cause.response, refresh) : brandingError(cause, change);
			focusAfter.current = change === 'remove' ? 'confirm' : change === 'upload' ? 'file' : 'name';
			setError({ field: change, text });
		} finally {
			setPending(undefined);
		}
	}

	function submit(event: SubmitEvent<HTMLFormElement>, change: Change) {
		event.preventDefault();
		void save(change);
	}

	return (
		<>
			{feedback ? <p className="feedback" role="status">{feedback}</p> : null}
			<form className="panel record-editor" onSubmit={(event) => submit(event, 'name')} aria-busy={pending === 'name'}>
				<div className="field">
					<label htmlFor="report-business-name">Business or owner name</label>
					<input id="report-business-name" value={shownName} onChange={(event) => {
						setNameDraft(event.target.value);
						if (error?.field === 'name') setError(undefined);
					}} ref={nameInput} disabled={!!pending} maxLength={maxReportBusinessNameLength}
						aria-invalid={error?.field === 'name' ? true : undefined}
						aria-describedby={error?.field === 'name' ? 'report-name-hint report-name-error' : 'report-name-hint'} />
					<p className="field-hint" id="report-name-hint">Shown on time reports. Leave blank to omit the name.</p>
					{error?.field === 'name' ? <p className="entry-field-error" id="report-name-error" role="alert">{error.text}</p> : null}
				</div>
				<div className="form-actions">
					<button className="primary" type="submit" disabled={!!pending || shownName.trim() === (settings.businessName ?? '')}>
						{pending === 'name' ? 'Saving…' : 'Save name'}
					</button>
				</div>
			</form>
			<section className="panel report-section" aria-labelledby="report-logo-heading">
				<h2 id="report-logo-heading" ref={logoHeading} tabIndex={-1}>Report logo</h2>
				{error?.field === 'remove' ? <p className="feedback error" role="alert">{error.text}</p> : null}
				{settings.logo ? (
					<div className="report-saved-logo">
						<ReportLogo key={settings.logo.url} url={settings.logo.url} alt="Saved report logo" refresh={() => {
							logoHeading.current?.focus({ preventScroll: true });
							return refreshSettings();
						}} />
						<p className="field-hint">{settings.logo.width} × {settings.logo.height} pixels</p>
					</div>
				) : <p className="field-hint">No logo saved.</p>}
				<form className="record-editor" onSubmit={(event) => submit(event, 'upload')} aria-busy={pending === 'upload'}>
					<div className="field">
						<label htmlFor="report-logo-file">{settings.logo ? 'Choose a replacement logo' : 'Choose a logo'}</label>
						<input id="report-logo-file" ref={fileInput} type="file" accept="image/png,.png"
							disabled={!!pending || removing} onChange={(event) => {
								const selected = event.target.files?.[0];
								setUpload(selected ? { file: selected, expectedLogoId: settings.logo?.id ?? 'none' } : undefined);
								if (error?.field === 'upload') setError(undefined);
							}} aria-invalid={error?.field === 'upload' ? true : undefined}
							aria-describedby={error?.field === 'upload' ? 'report-logo-hint report-logo-error' : 'report-logo-hint'} />
						<p className="field-hint" id="report-logo-hint">8-bit non-interlaced PNG, up to 1 MiB and {maxReportLogoDimension} × {maxReportLogoDimension} pixels.</p>
						{error?.field === 'upload' ? <p className="entry-field-error" id="report-logo-error" role="alert">{error.text}</p> : null}
					</div>
					<div className="form-actions">
						<button type="submit" className="primary" disabled={!file || !!pending || removing}>
							{pending === 'upload' ? 'Uploading…' : settings.logo ? 'Replace logo' : 'Upload logo'}
						</button>
						{settings.logo ? (
							<button type="button" ref={removeButton} disabled={!!pending || removing} onClick={() => {
								setError(undefined);
								setRemoveLogoId(settings.logo?.id);
							}}>Remove logo</button>
						) : null}
					</div>
				</form>
				{removing ? (
					<div className="record-editor">
						<p ref={removeHeading} tabIndex={-1}>Remove the saved logo from future time reports?</p>
						<div className="form-actions">
							<button type="button" className="primary" ref={confirmRemove} disabled={!!pending} onClick={() => void save('remove')}>
								{pending === 'remove' ? 'Removing…' : 'Confirm removal'}
							</button>
							<button type="button" disabled={!!pending} onClick={() => {
								focusAfter.current = 'remove';
								setRemoveLogoId(undefined);
								setError(undefined);
							}}>Cancel removal</button>
						</div>
					</div>
				) : null}
			</section>
		</>
	);
}

export function ReportSettings() {
	const search = settingsRoute.useSearch();
	const { refresh } = useSession();
	const heading = useRef<HTMLHeadingElement>(null);
	const settings = useQuery({
		queryKey: settingsKey,
		queryFn: ({ signal }) => readApi(reportSettingsPath, parseReportSettingsResponse,
			AbortSignal.any([signal, AbortSignal.timeout(10_000)]), refresh),
		retry: false,
		networkMode: 'always',
	});
	useLayoutEffect(() => {
		heading.current?.focus();
	}, []);
	return (
		<section className="entry-page" aria-labelledby="report-branding-heading">
			<div><Link to="/reports/preview" search={search}>Back to report preview</Link></div>
			<h1 className="entry-heading" id="report-branding-heading" ref={heading} tabIndex={-1}>Report branding</h1>
			{settings.data ? <BrandingEditor settings={settings.data} refreshSettings={settings.refetch} /> : settings.isError ? (
				<div className="feedback error catalog-load-error">
					<p role="alert">Could not load saved branding. Check your connection and try again.</p>
					<button type="button" disabled={settings.isFetching} onClick={() => void settings.refetch()}>Try again</button>
				</div>
			) : <p role="status">Loading report branding…</p>}
		</section>
	);
}
