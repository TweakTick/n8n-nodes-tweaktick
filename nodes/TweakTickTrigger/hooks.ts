/**
 * Pure trigger logic (hook registration, signature check), unit-tested in
 * test/trigger.test.mjs. Contract: tweaktick/app/docs-internal/automation-hooks-contract.md.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

import type { IDataObject } from 'n8n-workflow';

import type { RequestFn } from '../TweakTick/shared';
import { apiErrorInfo, isNotFound } from '../TweakTick/shared';

/* ------------------------------------------------------------------ */
/* Trigger → hook body                                                 */
/* ------------------------------------------------------------------ */

export type TriggerEvent =
	| 'newComment'
	| 'commentReplied'
	| 'commentUpdated'
	| 'statusChanged'
	| 'roundApproved'
	| 'changesRequested'
	| 'newRound';

/** The contract's "Triggers" table, identical for Zapier, Make and n8n. */
export const TRIGGER_EVENTS: Record<TriggerEvent, { events: string[]; comments?: 'new' | 'replies' }> = {
	newComment: { events: ['comment.created'], comments: 'new' },
	commentReplied: { events: ['comment.created'], comments: 'replies' },
	commentUpdated: { events: ['comment.updated'] },
	statusChanged: { events: ['comment.resolved', 'comment.reopened'] },
	roundApproved: { events: ['round.approved'] },
	changesRequested: { events: ['round.changes_requested'] },
	newRound: { events: ['round.created'] },
};

export interface HookBody extends IDataObject {
	url: string;
	events: string[];
	comments?: 'new' | 'replies';
	projectIds?: string[];
}

export function buildHookBody(event: string, url: string, projectId?: string): HookBody {
	const mapping = TRIGGER_EVENTS[event as TriggerEvent];
	if (!mapping) throw new Error(`Unknown TweakTick trigger event "${event}"`);
	const body: HookBody = { url, events: [...mapping.events] };
	if (mapping.comments) body.comments = mapping.comments;
	const project = typeof projectId === 'string' ? projectId.trim() : '';
	if (project !== '') body.projectIds = [project];
	return body;
}

/* ------------------------------------------------------------------ */
/* Hook lifecycle                                                      */
/* ------------------------------------------------------------------ */

export const PUBLIC_URL_HINT =
	'TweakTick only delivers to a public https URL on port 443 (no http, localhost, IP address or custom port). ' +
	'Use n8n Cloud, or run self-hosted n8n behind an https tunnel or reverse proxy and set WEBHOOK_URL to that public address.';

export type CreateHookResult =
	| { ok: true; hookId: string; secret: string }
	/** `description` is shown under the message in n8n. */
	| { ok: false; message: string; description?: string; status?: number };

export async function createHook(
	request: RequestFn,
	event: string,
	webhookUrl: string,
	projectId?: string,
): Promise<CreateHookResult> {
	const body = buildHookBody(event, webhookUrl, projectId);
	let response: unknown;
	try {
		response = await request({ method: 'POST', path: '/hooks', body });
	} catch (error) {
		const info = apiErrorInfo(error);
		const reason = (info.message ?? (error as Error).message ?? 'request failed').replace(/^TweakTick:\s*/, '');
		const urlProblem = info.status === 400 || !/^https:\/\//i.test(webhookUrl);
		return {
			ok: false,
			message: `TweakTick refused to register the webhook ${webhookUrl}: ${reason}`,
			description: urlProblem ? PUBLIC_URL_HINT : info.code ? `Error code: ${info.code}` : undefined,
			status: info.status,
		};
	}
	const r = (response ?? {}) as { hook?: { id?: unknown }; secret?: unknown };
	if (typeof r.hook?.id !== 'string' || typeof r.secret !== 'string') {
		return { ok: false, message: 'TweakTick returned an unexpected answer when registering the webhook' };
	}
	return { ok: true, hookId: r.hook.id, secret: r.secret };
}

export type DeleteHookResult = { status: 'deleted' | 'already_gone' } | { status: 'failed'; error: unknown };

/**
 * Deletes a hook. A 404 (unknown or already deleted) counts as success, as the
 * contract asks; any other error comes back as `failed` for the node to throw.
 */
export async function deleteHook(request: RequestFn, hookId: string): Promise<DeleteHookResult> {
	try {
		await request({ method: 'DELETE', path: `/hooks/${encodeURIComponent(hookId)}` });
		return { status: 'deleted' };
	} catch (error) {
		// 404: unknown or already deleted. 401: the key was revoked, and TweakTick deletes a revoked
		// key's hooks with it, so there is nothing left to remove.
		if (isNotFound(error) || apiErrorInfo(error).status === 401) return { status: 'already_gone' };
		return { status: 'failed', error };
	}
}

/* ------------------------------------------------------------------ */
/* Deliveries                                                          */
/* ------------------------------------------------------------------ */

export const SIGNATURE_TOLERANCE_SECONDS = 300;

export type SignatureResult = { valid: true } | { valid: false; reason: string };

/**
 * Checks `X-TweakTick-Signature: t=<unix>,v1=<hex>` where
 * v1 = HMAC-SHA256(secret, `${t}.${rawBody}`), within ±300 s, in constant time.
 */
export function verifySignature(
	header: unknown,
	rawBody: string | Buffer,
	secret: string,
	nowSeconds: number = Math.floor(Date.now() / 1000),
	toleranceSeconds: number = SIGNATURE_TOLERANCE_SECONDS,
): SignatureResult {
	const value = Array.isArray(header) ? header[0] : header;
	if (typeof value !== 'string' || value.trim() === '') {
		return { valid: false, reason: 'Missing X-TweakTick-Signature header' };
	}
	let t: string | undefined;
	const v1: string[] = [];
	for (const part of value.split(',')) {
		const idx = part.indexOf('=');
		if (idx <= 0) continue;
		const k = part.slice(0, idx).trim();
		const v = part.slice(idx + 1).trim();
		if (k === 't') t = v;
		else if (k === 'v1') v1.push(v);
	}
	if (!t || !/^\d+$/.test(t) || v1.length === 0) {
		return { valid: false, reason: 'Malformed X-TweakTick-Signature header' };
	}
	if (Math.abs(nowSeconds - Number(t)) > toleranceSeconds) {
		return { valid: false, reason: 'Signature timestamp is outside the 5-minute window' };
	}
	const raw = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8');
	const expected = createHmac('sha256', secret)
		.update(Buffer.concat([Buffer.from(`${t}.`, 'utf8'), raw]))
		.digest();
	for (const candidate of v1) {
		if (!/^[0-9a-f]+$/i.test(candidate) || candidate.length !== expected.length * 2) continue;
		if (timingSafeEqual(expected, Buffer.from(candidate, 'hex'))) return { valid: true };
	}
	return { valid: false, reason: 'Signature does not match' };
}

export type DeliveryResult = { ok: true; event: IDataObject } | { ok: false; reason: string };

/**
 * Decides what the trigger does with one delivery. With a stored secret the
 * signature must verify. Without one (n8n can lose node static data in manual
 * test runs) the event is accepted and marked `verified: false`.
 */
export function handleDelivery(input: {
	secret: unknown;
	signatureHeader: unknown;
	rawBody: unknown;
	body: unknown;
	nowSeconds?: number;
}): DeliveryResult {
	const body = (input.body !== null && typeof input.body === 'object' ? input.body : {}) as IDataObject;
	const secret = typeof input.secret === 'string' ? input.secret : '';
	if (secret === '') return { ok: true, event: { ...body, verified: false } };

	const raw =
		Buffer.isBuffer(input.rawBody) || typeof input.rawBody === 'string'
			? input.rawBody
			: JSON.stringify(input.body ?? {});
	const check = verifySignature(input.signatureHeader, raw, secret, input.nowSeconds);
	if (!check.valid) return { ok: false, reason: check.reason };
	return { ok: true, event: body };
}
