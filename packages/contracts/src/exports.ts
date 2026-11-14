import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';
import { WorkListSort, workScopeFields } from './work-list.js';

export const entriesCsvExportPath = '/api/v1/exports/entries.csv';
export const portableExportPath = '/api/v1/exports/portable';

export const EntriesCsvExportQuery = Type.Object({
	...workScopeFields,
	sort: Type.Optional(WorkListSort),
}, { additionalProperties: false });

export type EntriesCsvExportQuery = Static<typeof EntriesCsvExportQuery>;
