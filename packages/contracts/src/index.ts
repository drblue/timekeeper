import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

export const healthPath = '/api/v1/health';

export const HealthQuery = Type.Object({}, { additionalProperties: false });

export const HealthResponse = Type.Object({
	status: Type.Literal('ok'),
}, { additionalProperties: false });

export const ApiErrorResponse = Type.Object({
	code: Type.String(),
	message: Type.String(),
	requestId: Type.String(),
	fieldErrors: Type.Optional(Type.Array(Type.Object({
		field: Type.String(),
		message: Type.String(),
	}, { additionalProperties: false }))),
}, { additionalProperties: false });

export type HealthResponse = Static<typeof HealthResponse>;
export type ApiErrorResponse = Static<typeof ApiErrorResponse>;

export function parseHealthResponse(value: unknown): HealthResponse {
	if (!Value.Check(HealthResponse, value)) {
		throw new Error('Invalid liveness response');
	}

	return value;
}
