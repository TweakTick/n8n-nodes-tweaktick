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
	it('validates required inputs and unknown operations', () => {
		assert.throws(() => shared.buildActionRequest('comment', 'get', { commentId: '' }), /Comment ID is required/);
		assert.throws(() => shared.buildActionRequest('comment', 'createReply', { commentId: 'c', text: '  ' }), /Reply text is required/);
		assert.throws(() => shared.buildActionRequest('comment', 'delete', { commentId: 'c' }), /Unsupported/);
		assert.throws(() => shared.buildActionRequest('project', 'getAll', {}), /Unsupported/);
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

/** Scripted pages: page n answers with `size` projects and a cursor until `pages` is reached. */
function pager(pages, size = 200) {
	const calls = [];
	const request = async (req) => {
		calls.push(req);
		const n = calls.length;
		const take = Math.min(size, req.qs.limit);
		const projects = Array.from({ length: take }, (_, k) => ({ id: `p${n}-${k}` }));
		return { projects, nextCursor: n < pages ? `c${n}` : null };
	};
	return { calls, request };
}

describe('listProjects', () => {
	it('Return All follows nextCursor to the last page', async () => {
		const { calls, request } = pager(3);
		const out = await shared.listProjects(request, { returnAll: true });
		assert.equal(out.length, 600);
		assert.deepEqual(calls.map((c) => c.qs), [{ limit: 200 }, { limit: 200, cursor: 'c1' }, { limit: 200, cursor: 'c2' }]);
		assert.ok(calls.every((c) => c.method === 'GET' && c.path === '/projects'));
	});
	it('Limit above one page asks for exactly what is left', async () => {
		const { calls, request } = pager(5);
		const out = await shared.listProjects(request, { returnAll: false, limit: 250 });
		assert.equal(out.length, 250);
		assert.deepEqual(calls.map((c) => c.qs), [{ limit: 200 }, { limit: 50, cursor: 'c1' }]);
	});
	it('small Limit is one request; default Limit is 50', async () => {
		const a = pager(5);
		assert.equal((await shared.listProjects(a.request, { returnAll: false, limit: 10 })).length, 10);
		assert.equal(a.calls.length, 1);
		const b = pager(5);
		assert.equal((await shared.listProjects(b.request, { returnAll: false })).length, 50);
		assert.deepEqual(b.calls[0].qs, { limit: 50 });
	});
	it('stops early when the API has fewer projects than the Limit', async () => {
		const { calls, request } = pager(1, 3);
		assert.equal((await shared.listProjects(request, { returnAll: false, limit: 100 })).length, 3);
		assert.equal(calls.length, 1);
	});
	it('trims if the API sends more than asked', async () => {
		const request = async () => ({ projects: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], nextCursor: null });
		assert.deepEqual((await shared.listProjects(request, { returnAll: false, limit: 2 })).map((p) => p.id), ['a', 'b']);
	});
	it('stops if a cursor repeats, and at maxPages', async () => {
		let n = 0;
		const loop = async () => ({ projects: [{ id: `x${n++}` }], nextCursor: 'same' });
		assert.equal((await shared.listProjects(loop, { returnAll: true })).length, 2);
		const { calls, request } = pager(50);
		await shared.listProjects(request, { returnAll: true, maxPages: 10 });
		assert.equal(calls.length, 10);
	});
	it('handles an empty or odd response', async () => {
		assert.deepEqual(await shared.listProjects(async () => undefined, { returnAll: true }), []);
		assert.deepEqual(await shared.listProjects(async () => ({ projects: 'no', nextCursor: 5 }), { returnAll: true }), []);
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
		const { ctx, out } = await run({ resource: 'comment', operation: 'createReply', commentId: 'pin-1', text: 'On it', options: { internal: false } }, [
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

	it('Create Reply is internal when Options is empty', async () => {
		const { ctx } = await run({ resource: 'comment', operation: 'createReply', commentId: 'pin-1', text: 'Noted' }, [() => ({ reply: { id: 'r-2' } })]);
		assert.deepEqual(ctx.calls[0].body, { body: 'Noted', internal: true });
		const withEmpty = await run({ resource: 'comment', operation: 'createReply', commentId: 'pin-1', text: 'Noted', options: {} }, [() => ({ reply: { id: 'r-3' } })]);
		assert.equal(withEmpty.ctx.calls[0].body.internal, true);
	});

	it('Project Get Many returns one item per project', async () => {
		const { ctx, out } = await run({ resource: 'project', operation: 'getAll', returnAll: false, limit: 10 }, [() => ({ projects: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] })]);
		assert.equal(ctx.calls[0].url, 'https://app.tweaktick.test/api/v2/projects');
		assert.deepEqual(ctx.calls[0].qs, { limit: 10 });
		assert.deepEqual(out[0].map((i) => i.json.id), ['a', 'b']);
		assert.deepEqual(out[0][0].pairedItem, { item: 0 });
	});

	it('Project Get Many with Return All pages through and ignores Limit', async () => {
		const { ctx, out } = await run({ resource: 'project', operation: 'getAll', returnAll: true, limit: 1 }, [
			() => ({ projects: [{ id: 'a' }, { id: 'b' }], nextCursor: 'c1' }),
			() => ({ projects: [{ id: 'c' }], nextCursor: null }),
		]);
		assert.deepEqual(ctx.calls.map((c) => c.qs), [{ limit: 200 }, { limit: 200, cursor: 'c1' }]);
		assert.deepEqual(out[0].map((i) => i.json.id), ['a', 'b', 'c']);
	});

	it('Project Get Many errors go through continueOnFail', async () => {
		const { out } = await run({ resource: 'project', operation: 'getAll', returnAll: true }, [() => { throw httpError(401, 'unauthorized', 'Bad key'); }], { continueOnFail: true });
		assert.match(out[0][0].json.error, /Bad key/);
	});

	it('node form follows n8n review rules (Options, Return All + Limit)', () => {
		const props = node.description.properties;
		assert.equal(props.some((p) => p.name === 'internal'), false);
		const options = props.find((p) => p.name === 'options');
		assert.equal(options.type, 'collection');
		assert.deepEqual(options.default, {});
		assert.deepEqual(options.options.map((o) => [o.name, o.default]), [['internal', true]]);
		const returnAll = props.find((p) => p.name === 'returnAll');
		assert.equal(returnAll.default, false);
		const limit = props.find((p) => p.name === 'limit');
		assert.deepEqual(limit.displayOptions.show.returnAll, [false]);
		assert.equal(limit.typeOptions.maxValue, undefined);
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
