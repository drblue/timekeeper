import {
	ApiErrorResponse,
	CatalogIdParams,
	CatalogLifecycleBody,
	CatalogListQuery,
	ClientListResponse,
	ClientResponse,
	clientsPath,
	CreateClientBody,
	CreateProjectBody,
	ProjectListResponse,
	ProjectResponse,
	projectsPath,
	UpdateClientBody,
	UpdateProjectBody,
} from '@timekeeper/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { CatalogError } from './store.ts';
import type { CatalogStore } from './store.ts';

const listErrors = { 400: ApiErrorResponse, 401: ApiErrorResponse, 500: ApiErrorResponse };
const mutationErrors = {
	...listErrors,
	403: ApiErrorResponse,
	404: ApiErrorResponse,
	409: ApiErrorResponse,
	413: ApiErrorResponse,
	422: ApiErrorResponse,
};

async function respondWithRecord(
	request: FastifyRequest,
	reply: FastifyReply,
	status: 200 | 201,
	write: (accountId: string) => Promise<ClientResponse | ProjectResponse>,
) {
	try {
		const result = await write(request.accountSession!.accountId);
		return reply.code(status).send(result);
	} catch (error) {
		if (!(error instanceof CatalogError)) {
			throw error;
		}
		return reply.code(error.status).send({
			code: error.code,
			message: error.message,
			requestId: request.id,
			...(error.field ? { fieldErrors: [{ field: `body/${error.field}`, message: error.message }] } : {}),
		} satisfies ApiErrorResponse);
	}
}

export function registerCatalog(app: FastifyInstance, store: CatalogStore) {
	app.get<{ Querystring: CatalogListQuery }>(clientsPath, {
		schema: {
			operationId: 'listClients',
			querystring: CatalogListQuery,
			response: { 200: ClientListResponse, ...listErrors },
		},
	}, (request) => store.listClients(request.accountSession!.accountId, request.query.view));

	app.get<{ Querystring: CatalogListQuery }>(projectsPath, {
		schema: {
			operationId: 'listProjects',
			querystring: CatalogListQuery,
			response: { 200: ProjectListResponse, ...listErrors },
		},
	}, (request) => store.listProjects(request.accountSession!.accountId, request.query.view));

	app.post<{ Body: CreateClientBody }>(clientsPath, {
		bodyLimit: 32_768,
		schema: {
			operationId: 'createClient',
			body: CreateClientBody,
			response: { 201: ClientResponse, ...mutationErrors },
		},
	}, (request, reply) => respondWithRecord(request, reply, 201, (accountId) => store.createClient(accountId, request.body)));

	app.post<{ Body: CreateProjectBody }>(projectsPath, {
		bodyLimit: 32_768,
		schema: {
			operationId: 'createProject',
			body: CreateProjectBody,
			response: { 201: ProjectResponse, ...mutationErrors },
		},
	}, (request, reply) => respondWithRecord(request, reply, 201, (accountId) => store.createProject(accountId, request.body)));

	app.put<{ Params: CatalogIdParams; Body: UpdateClientBody }>(`${clientsPath}/:id`, {
		bodyLimit: 32_768,
		schema: {
			operationId: 'updateClient',
			params: CatalogIdParams,
			body: UpdateClientBody,
			response: { 200: ClientResponse, ...mutationErrors },
		},
	}, (request, reply) => respondWithRecord(request, reply, 200, (accountId) => store.updateClient(accountId, request.params.id, request.body)));

	app.put<{ Params: CatalogIdParams; Body: UpdateProjectBody }>(`${projectsPath}/:id`, {
		bodyLimit: 32_768,
		schema: {
			operationId: 'updateProject',
			params: CatalogIdParams,
			body: UpdateProjectBody,
			response: { 200: ProjectResponse, ...mutationErrors },
		},
	}, (request, reply) => respondWithRecord(request, reply, 200, (accountId) => store.updateProject(accountId, request.params.id, request.body)));

	for (const action of ['archive', 'restore'] as const) {
		app.post<{ Params: CatalogIdParams; Body: CatalogLifecycleBody }>(`${clientsPath}/:id/${action}`, {
			bodyLimit: 1_024,
			schema: {
				operationId: `${action}Client`,
				params: CatalogIdParams,
				body: CatalogLifecycleBody,
				response: { 200: ClientResponse, ...mutationErrors },
			},
		}, (request, reply) => respondWithRecord(request, reply, 200, (accountId) =>
			store.setClientArchived(accountId, request.params.id, request.body.revision, action === 'archive')));

		app.post<{ Params: CatalogIdParams; Body: CatalogLifecycleBody }>(`${projectsPath}/:id/${action}`, {
			bodyLimit: 1_024,
			schema: {
				operationId: `${action}Project`,
				params: CatalogIdParams,
				body: CatalogLifecycleBody,
				response: { 200: ProjectResponse, ...mutationErrors },
			},
		}, (request, reply) => respondWithRecord(request, reply, 200, (accountId) =>
			store.setProjectArchived(accountId, request.params.id, request.body.revision, action === 'archive')));
	}
}
