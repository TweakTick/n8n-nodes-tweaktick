import type {
	IExecuteFunctions,
	IHookFunctions,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	INodePropertyOptions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';

import type { ApiRequest, RequestFn } from './shared';
import { apiBaseUrl, apiErrorInfo, listProjects, projectOptions } from './shared';

type Ctx = IExecuteFunctions | IHookFunctions | ILoadOptionsFunctions;

export const CREDENTIAL_NAME = 'tweakTickApi';

/**
 * Builds a RequestFn bound to the node's TweakTick credential. Errors come back
 * as NodeApiError carrying TweakTick's own `error.message` and the HTTP status
 * (`httpCode`), so callers can still tell a 404 apart.
 */
export async function tweakTickRequester(ctx: Ctx): Promise<RequestFn> {
	const credentials = await ctx.getCredentials(CREDENTIAL_NAME);
	const base = apiBaseUrl(credentials.baseUrl);
	return async (request: ApiRequest) => {
		const options: IHttpRequestOptions = {
			method: request.method,
			url: `${base}${request.path}`,
			json: true,
			headers: { Accept: 'application/json' },
		};
		if (request.body) options.body = request.body;
		if (request.qs) options.qs = request.qs;
		try {
			return await ctx.helpers.httpRequestWithAuthentication.call(ctx, CREDENTIAL_NAME, options);
		} catch (error) {
			const info = apiErrorInfo(error);
			const message = info.message ?? (error as Error).message ?? 'TweakTick request failed';
			const httpCode = info.status !== undefined ? String(info.status) : undefined;
			// A plain object, not `error` itself: NodeApiError returns an existing
			// NodeApiError unchanged and would drop TweakTick's message.
			const response: JsonObject = {
				message,
				...(httpCode ? { httpCode } : {}),
				error: { code: info.code ?? null, message },
			};
			throw new NodeApiError(ctx.getNode(), response, {
				message: `TweakTick: ${message}`,
				description: info.code ? `Error code: ${info.code}` : undefined,
				httpCode,
			});
		}
	};
}

/** loadOptions: the workspace's projects for the Project dropdown. */
export async function getProjects(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const request = await tweakTickRequester(this);
	// Follows nextCursor (CONTRACTS §11); at most 10 pages of 200.
	const projects = await listProjects(request, { returnAll: true, maxPages: 10 });
	return projectOptions({ projects });
}
