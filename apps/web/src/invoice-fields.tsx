import { maxInvoiceNumberLength, maxInvoiceReferenceLength } from '@timekeeper/contracts';
import type { EntryInvoiceBody } from '@timekeeper/contracts';
import { useId } from 'react';
import type { Ref } from 'react';

type InvoiceMetadata = Omit<EntryInvoiceBody, 'revision'>;

export function invoiceMetadata(form: HTMLFormElement): InvoiceMetadata {
	const data = new FormData(form);
	return {
		invoiceNumber: String(data.get('invoiceNumber') ?? '').trim() || null,
		invoiceDate: String(data.get('invoiceDate') ?? '') || null,
		invoiceReference: String(data.get('invoiceReference') ?? '').trim() || null,
	};
}

export function InvoiceFields({ values, disabled, dateError, dateInput, onDateChange }: {
	values?: InvoiceMetadata;
	disabled: boolean;
	dateError?: string;
	dateInput?: Ref<HTMLInputElement>;
	onDateChange?: () => void;
}) {
	const id = useId();
	return (
		<fieldset className="record-fields entry-invoice-fields" disabled={disabled}>
			<div className="field">
				<label htmlFor={id + '-number'}>Invoice number (optional)</label>
				<input id={id + '-number'} name="invoiceNumber" type="text"
					defaultValue={values?.invoiceNumber ?? ''} maxLength={maxInvoiceNumberLength} />
			</div>
			<div className="field">
				<label htmlFor={id + '-date'}>Invoice date (optional)</label>
				<input id={id + '-date'} name="invoiceDate" ref={dateInput} type="date" defaultValue={values?.invoiceDate ?? ''}
					min="0001-01-01" max="9999-12-31" onChange={onDateChange}
					aria-invalid={dateError ? true : undefined} aria-describedby={dateError ? id + '-date-error' : undefined} />
				{dateError ? <p className="entry-field-error" id={id + '-date-error'}>{dateError}</p> : null}
			</div>
			<div className="field entry-invoice-reference">
				<label htmlFor={id + '-reference'}>Invoice reference (optional)</label>
				<textarea id={id + '-reference'} name="invoiceReference" rows={2}
					defaultValue={values?.invoiceReference ?? ''} maxLength={maxInvoiceReferenceLength} />
			</div>
		</fieldset>
	);
}
