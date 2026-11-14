import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

export * from './catalog.js';
export * from './entries.js';
export * from './bulk-entries.js';
export * from './stockholm-time.js';
export * from './timer.js';
export * from './work-list.js';
export * from './report.js';
export * from './report-jobs.js';
export * from './report-labels.js';
export * from './report-settings.js';
export * from './clockify-import.js';
export * from './exports.js';

export const healthPath = '/api/v1/health';
export const readinessPath = '/api/v1/ready';
export const authSessionPath = '/api/v1/auth/session';
export const authLoginPath = '/api/v1/auth/login';
export const authLogoutPath = '/api/v1/auth/logout';
export const authPasswordPath = '/api/v1/auth/password';
export const accountPath = '/api/v1/account';
export const csrfHeader = 'x-csrf-token';
export const minPasswordLength = 15;
export const maxPasswordLength = 128;

export const HealthQuery = Type.Object({}, { additionalProperties: false });

export const HealthResponse = Type.Object({
	status: Type.Literal('ok'),
}, { additionalProperties: false });

export const ReadinessResponse = Type.Object({
	status: Type.Union([Type.Literal('ready'), Type.Literal('not-ready')]),
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

export const AccountResponse = Type.Object({
	email: Type.String(),
}, { additionalProperties: false });

export const AuthSessionResponse = Type.Object({
	account: Type.Union([AccountResponse, Type.Null()]),
	csrfToken: Type.String({ pattern: '^[A-Za-z0-9_-]{43}$' }),
}, { additionalProperties: false });

export const LoginBody = Type.Object({
	email: Type.String({ minLength: 1, maxLength: 254 }),
	password: Type.String({ minLength: 1, maxLength: maxPasswordLength }),
}, { additionalProperties: false });

export const ChangePasswordBody = Type.Object({
	currentPassword: Type.String({ minLength: 1, maxLength: maxPasswordLength }),
	newPassword: Type.String({ maxLength: maxPasswordLength }),
}, { additionalProperties: false });

export type HealthResponse = Static<typeof HealthResponse>;
export type ReadinessResponse = Static<typeof ReadinessResponse>;
export type ApiErrorResponse = Static<typeof ApiErrorResponse>;
export type AccountResponse = Static<typeof AccountResponse>;
export type AuthSessionResponse = Static<typeof AuthSessionResponse>;
export type LoginBody = Static<typeof LoginBody>;
export type ChangePasswordBody = Static<typeof ChangePasswordBody>;

export function parseHealthResponse(value: unknown): HealthResponse {
	if (!Value.Check(HealthResponse, value)) {
		throw new Error('Invalid liveness response');
	}

	return value;
}

export function parseAuthSessionResponse(value: unknown): AuthSessionResponse {
	if (!Value.Check(AuthSessionResponse, value)) {
		throw new Error('Invalid account session response');
	}

	return value;
}
