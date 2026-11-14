export class ApiRequestError extends Error {
	readonly status: 401 | 404 | 409 | 410 | 422 | 429;
	readonly code: string;
	readonly field?: string;

	constructor(status: ApiRequestError['status'], code: string, message: string, field?: string) {
		super(message);
		this.status = status;
		this.code = code;
		this.field = field;
	}
}
