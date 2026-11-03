import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

import { fakeContext, httpError } from './helpers.mjs';

const require = createRequire(import.meta.url);
const shared = require('../dist/nodes/TweakTick/shared.js');
const { TweakTick } = require('../dist/nodes/TweakTick/TweakTick.node.js');
const { TweakTickApi } = require('../dist/credentials/TweakTickApi.credentials.js');

describe('buildActionRequest', () => {
	it('Comment → Create Reply', () => {
		assert.deepEqual(shared.buildActionRequest('comment', 'createReply', { commentId: 'c-1', text: ' Thanks! ', internal: false }), {
			method: 'POST',
			path: '/comments/c-1/replies',
			body: { body: 'Thanks!', internal: false },
		});
	});
	it('Create Reply is internal unless turned off', () => {
		assert.equal(shared.buildActionRequest('comment', 'createReply', { commentId: 'c', text: 'x' }).body.internal, true);
	});
	it('Comment → Resolve / Reopen / Get', () => {
		assert.deepEqual(shared.buildActionRequest('comment', 'resolve', { commentId: 'c-1' }), { method: 'PATCH', path: '/comments/c-1', body: { status: 'resolved' } });
		assert.deepEqual(shared.buildActionRequest('comment', 'reopen', { commentId: 'c-1' }), { method: 'PATCH', path: '/comments/c-1', body: { status: 'open' } });
		assert.deepEqual(shared.buildActionRequest('comment', 'get', { commentId: 'c-1' }), { method: 'GET', path: '/comments/c-1' });
	});
	it('encodes the comment id', () => {
		assert.equal(shared.buildActionRequest('comment', 'get', { commentId: 'a/b?c' }).path, '/comments/a%2Fb%3Fc');
	});
	it('Project → Get Many with limit clamped to 1–200', () => {
		assert.deepEqual(shared.buildActionRequest('project', 'getAll', { limit: 25 }), { method: 'GET', path: '/projects', qs: { limit: 25 } });
		assert.equal(shared.buildActionRequest('project', 'getAll', { limit: 999 }).qs.limit, 200);
		assert.equal(shared.buildActionRequest('project', 'getAll', {}).qs.limit, 50);
	});
	it('validates required inputs and unknown operations', () => {
		assert.throws(() => shared.buildActionRequest('comment', 'get', { commentId: '' }), /Comment ID is required/);
		assert.throws(() => shared.buildActionRequest('comment', 'createReply', { commentId: 'c', text: '  ' }), /Reply text is required/);
		assert.throws(() => shared.buildActionRequest('comment', 'delete', { commentId: 'c' }), /Unsupported/);
	});
});

describe('apiErrorInfo / isNotFound', () => {
	it('reads axios-like errors', () => {
		assert.deepEqual(shared.apiErrorInfo(httpError(403, 'insufficient_scope', 'Missing scope comments:write')), {
			status: 403,
			code: 'insufficient_scope',
			message: 'Missing scope comments:write',
		});
	});
	it('reads NodeApiError-like errors (httpCode string, original in cause)', () => {
		const err = Object.assign(new Error('wrapped'), { httpCode: '404', cause: httpError(404, 'not_found', 'Hook not found') });
		assert.equal(shared.isNotFound(err), true);
		assert.equal(shared.apiErrorInfo(err).message, 'Hook not found');
	});
	it('handles a JSON string body and unrelated errors', () => {
		assert.equal(shared.apiErrorInfo({ statusCode: 429, error: '{"error":{"code":"rate_limited","message":"Slow down"}}' }).code, 'rate_limited');
		assert.equal(shared.isNotFound(new Error('socket hang up')), false);
	});
});

describe('apiBaseUrl', () => {
	it('strips trailing slashes and defaults to production', () => {
		assert.equal(shared.apiBaseUrl('http://localhost:3006/'), 'http://localhost:3006/api/v2');
		assert.equal(shared.apiBaseUrl(''), 'https://tweaktick.com/api/v2');
		assert.equal(shared.apiBaseUrl(undefined), 'https://tweaktick.com/api/v2');
		assert.throws(() => shared.apiBaseUrl('http://tweaktick.example.com'), /https/);
		assert.throws(() => shared.apiBaseUrl('https://u:p@tweaktick.com'), /user name/);
		assert.throws(() => shared.apiBaseUrl('not a url'), /valid/);
	});
});

describe('TweakTick action node execute', () => {
	const node = new TweakTick();

	async function run(params, answers, opts = {}) {
		const ctx = fakeContext({ params, answers, ...opts });
		const out = await node.execute.call(ctx);
		return { ctx, out };
	}

	it('Create Reply POSTs to /comments/{id}/replies and returns the reply', async () => {
		const { ctx, out } = await run({ resource: 'comment', operation: 'createReply', commentId: 'pin-1', text: 'On it', internal: false }, [
			() => ({ reply: { id: 'r-1', internal: false, createdAt: '2026-10-27T09:00:00.000Z' } }),
		]);
		assert.equal(ctx.calls[0].method, 'POST');
		assert.equal(ctx.calls[0].url, 'https://app.tweaktick.test/api/v2/comments/pin-1/replies');
		assert.deepEqual(ctx.calls[0].body, { body: 'On it', internal: false });
		assert.equal(ctx.calls[0].credentialName, 'tweakTickApi');
		assert.deepEqual(out, [[{ json: { id: 'r-1', internal: false, createdAt: '2026-10-27T09:00:00.000Z' }, pairedItem: { item: 0 } }]]);
	});

	it('Resolve and Reopen PATCH the status', async () => {
		const resolved = await run({ resource: 'comment', operation: 'resolve', commentId: 'pin-1' }, [() => ({ comment: { id: 'pin-1', number: 3, status: 'resolved' } })]);
		assert.equal(resolved.ctx.calls[0].method, 'PATCH');
		assert.deepEqual(resolved.ctx.calls[0].body, { status: 'resolved' });
		assert.equal(resolved.out[0][0].json.status, 'resolved');
		const reopened = await run({ resource: 'comment', operation: 'reopen', commentId: 'pin-1' }, [() => ({ comment: { id: 'pin-1', number: 3, status: 'open' } })]);
		assert.deepEqual(reopened.ctx.calls[0].body, { status: 'open' });
	});

	it('Get returns the thread', async () => {
		const { ctx, out } = await run({ resource: 'comment', operation: 'get', commentId: 'pin-1' }, [() => ({ comment: { id: 'pin-1', comments: [] } })]);
		assert.equal(ctx.calls[0].method, 'GET');
		assert.equal(ctx.calls[0].body, undefined);
		assert.deepEqual(out[0][0].json, { id: 'pin-1', comments: [] });
	});

	it('Project Get Many returns one item per project', async () => {
		const { ctx, out } = await run({ resource: 'project', operation: 'getAll', limit: 10 }, [() => ({ projects: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] })]);
		assert.equal(ctx.calls[0].url, 'https://app.tweaktick.test/api/v2/projects');
		assert.deepEqual(ctx.calls[0].qs, { limit: 10 });
		assert.deepEqual(out[0].map((i) => i.json.id), ['a', 'b']);
	});

	it('runs once per input item with pairedItem', async () => {
		const { ctx, out } = await run({ resource: 'comment', operation: 'resolve', commentId: 'pin-1' }, [
			() => ({ comment: { id: 'pin-1' } }),
			() => ({ comment: { id: 'pin-1' } }),
		], { items: [{ json: {} }, { json: {} }] });
		assert.equal(ctx.calls.length, 2);
		assert.deepEqual(out[0].map((i) => i.pairedItem), [{ item: 0 }, { item: 1 }]);
	});

	it('API errors surface TweakTick’s message', async () => {
		await assert.rejects(
			run({ resource: 'comment', operation: 'resolve', commentId: 'pin-1' }, [() => { throw httpError(403, 'insufficient_scope', 'This key lacks comments:write'); }]),
			(err) => {
				assert.equal(err.constructor.name, 'NodeApiError');
				assert.match(err.message, /This key lacks comments:write/);
				assert.equal(err.httpCode, '403');
				return true;
			},
		);
	});

	it('continueOnFail returns the error as an item', async () => {
		const { out } = await run({ resource: 'comment', operation: 'get', commentId: '' }, [], { continueOnFail: true });
		assert.match(out[0][0].json.error, /Comment ID is required/);
	});
});

describe('TweakTickApi credentials', () => {
	const cred = new TweakTickApi();
	it('sends a Bearer header and tests GET /api/v2/me', () => {
		assert.equal(cred.name, 'tweakTickApi');
		assert.equal(cred.authenticate.properties.headers.Authorization, '=Bearer {{$credentials.apiKey}}');
		assert.equal(cred.test.request.url, '/me');
		assert.match(cred.test.request.baseURL, /\/api\/v2$/);
	});
	it('has a password apiKey and an https default base URL', () => {
		const apiKey = cred.properties.find((p) => p.name === 'apiKey');
		assert.equal(apiKey.typeOptions.password, true);
		assert.equal(cred.properties.find((p) => p.name === 'baseUrl').default, 'https://tweaktick.com');
	});
});
