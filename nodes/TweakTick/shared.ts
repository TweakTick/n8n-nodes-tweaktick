/**
 * Pure helpers shared by the TweakTick nodes. No n8n runtime calls here, so the
 * unit tests can import this file directly (test/*.test.mjs, against dist/).
 * The API is described in poc/app/docs-internal/automation-hooks-contract.md.
 */
import type { IDataObject } from 'n8n-workflow';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export interface ApiRequest {
	method: HttpMethod;
	/** Path under `{baseUrl}/api/v2`, starting with "/". */
	path: string;
	body?: IDataObject;
	qs?: IDataObject;
}

/** Calls the TweakTick REST API v2 and resolves with the parsed JSON body. */
export type RequestFn = (request: ApiRequest) => Promise<unknown>;

export function apiBaseUrl(baseUrl: unknown): string {
	const raw = typeof baseUrl === 'string' && baseUrl.trim() !== '' ? baseUrl.trim() : 'https://tweaktick.com';
	// The API key travels in the Authorization header: plain http only for a local dev server.
	if (!URL.canParse(raw)) throw new Error('The TweakTick Base URL is not a valid address');
	const url = new URL(raw);
	const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
	if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
		throw new Error('The TweakTick Base URL must use https (plain http only for localhost)');
	}
	if (url.username || url.password) throw new Error('Remove the user name and password from the TweakTick Base URL');
	return `${raw.replace(/\/+$/, '')}/api/v2`;
}

function idSegment(value: unknown, label: string): string {
	const id = typeof value === 'string' ? value.trim() : '';
	if (id === '') throw new Error(`${label} is required`);
	return encodeURIComponent(id);
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

export interface ApiErrorInfo {
	status?: number;
	code?: string;
	message?: string;
}

function asObject(v: unknown): Record<string, unknown> | undefined {
	return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
}

function parseBody(v: unknown): Record<string, unknown> | undefined {
	if (typeof v === 'string') {
		try {
			return asObject(JSON.parse(v));
		} catch {
			return undefined;
		}
	}
	return asObject(v);
}

function toStatus(v: unknown): number | undefined {
	const n = typeof v === 'string' ? Number.parseInt(v, 10) : typeof v === 'number' ? v : NaN;
	return Number.isInteger(n) && n >= 100 && n <= 599 ? n : undefined;
}

/**
 * Reads status, code and message from whatever n8n's HTTP helpers throw: an
 * axios-like error (`response.status`, `response.data`), a NodeApiError
 * (`httpCode`, original error in `cause`) or a plain object. TweakTick answers
 * errors as `{ error: { code, message } }`.
 */
export function apiErrorInfo(err: unknown): ApiErrorInfo {
	const info: ApiErrorInfo = {};
	const seen = new Set<unknown>();
	let cur: unknown = err;
	for (let depth = 0; depth < 5 && cur && !seen.has(cur); depth++) {
		seen.add(cur);
		const e = asObject(cur);
		if (!e) break;
		const response = asObject(e.response);
		info.status ??=
			toStatus(response?.status) ?? toStatus(e.httpCode) ?? toStatus(e.statusCode) ?? toStatus(e.status);
		for (const candidate of [response?.data, response?.body, e.error, asObject(e.context)?.data]) {
			const body = parseBody(candidate);
			const apiErr = asObject(body?.error);
			if (apiErr) {
				if (!info.code && typeof apiErr.code === 'string') info.code = apiErr.code;
				if (!info.message && typeof apiErr.message === 'string') info.message = apiErr.message;
			}
		}
		cur = e.cause;
	}
	return info;
}

export function isNotFound(err: unknown): boolean {
	return apiErrorInfo(err).status === 404;
}

/* ------------------------------------------------------------------ */
/* Action node requests                                                */
/* ------------------------------------------------------------------ */

export interface ActionParams {
	commentId?: string;
	text?: string;
	internal?: boolean;
	limit?: number;
}

/** Maps an action node resource + operation to the REST v2 request. */
export function buildActionRequest(resource: string, operation: string, p: ActionParams): ApiRequest {
	if (resource === 'comment') {
		const path = `/comments/${idSegment(p.commentId, 'Comment ID')}`;
		switch (operation) {
			case 'createReply': {
				const text = typeof p.text === 'string' ? p.text.trim() : '';
				if (text === '') throw new Error('Reply text is required');
				return { method: 'POST', path: `${path}/replies`, body: { body: text, internal: p.internal !== false } };
			}
			case 'resolve':
				return { method: 'PATCH', path, body: { status: 'resolved' } };
			case 'reopen':
				return { method: 'PATCH', path, body: { status: 'open' } };
			case 'get':
				return { method: 'GET', path };
		}
	}
	if (resource === 'project' && operation === 'getAll') {
		const limit = Math.min(200, Math.max(1, Math.trunc(Number(p.limit ?? 50)) || 50));
		return { method: 'GET', path: '/projects', qs: { limit } };
	}
	throw new Error(`Unsupported operation "${operation}" for resource "${resource}"`);
}

/** Turns an API response into the node's output items (one JSON object each). */
export function actionOutput(resource: string, operation: string, response: unknown): IDataObject[] {
	const r = asObject(response) ?? {};
	if (resource === 'project') {
		return Array.isArray(r.projects) ? (r.projects as IDataObject[]) : [];
	}
	const key = operation === 'createReply' ? 'reply' : 'comment';
	const value = asObject(r[key]);
	return [(value ?? r) as IDataObject];
}

/* ------------------------------------------------------------------ */
/* Projects dropdown                                                   */
/* ------------------------------------------------------------------ */

export function projectOptions(response: unknown): Array<{ name: string; value: string }> {
	const r = asObject(response);
	const list = Array.isArray(r?.projects) ? (r.projects as unknown[]) : [];
	const out: Array<{ name: string; value: string }> = [];
	for (const item of list) {
		const p = asObject(item);
		if (p && typeof p.id === 'string') {
			out.push({ name: typeof p.name === 'string' && p.name !== '' ? p.name : p.id, value: p.id });
		}
	}
	return out.sort((a, b) => a.name.localeCompare(b.name));
}
