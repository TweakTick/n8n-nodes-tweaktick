import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

import { fakeContext, httpError, sign } from './helpers.mjs';

const require = createRequire(import.meta.url);
const hooks = require('../dist/nodes/TweakTickTrigger/hooks.js');
const { TweakTickTrigger } = require('../dist/nodes/TweakTickTrigger/TweakTickTrigger.node.js');

const SECRET = 'whsec_test_secret';
const RAW = '{"id":"evt-1","type":"comment.created","comment":{"body":"Make the logo bigger."}}';
const NOW = 1_800_000_000;

describe('verifySignature', () => {
	it('accepts a good signature', () => {
		assert.deepEqual(hooks.verifySignature(sign(SECRET, RAW, NOW), RAW, SECRET, NOW), { valid: true });
	});
	it('accepts a raw Buffer body and a header array', () => {
		const r = hooks.verifySignature([sign(SECRET, RAW, NOW)], Buffer.from(RAW), SECRET, NOW);
		assert.equal(r.valid, true);
	});
	it('accepts when any of several v1 values matches (secret rotation)', () => {
		const good = sign(SECRET, RAW, NOW).split(',')[1];
		const header = `t=${NOW},v1=${'0'.repeat(64)},${good}`;
		assert.equal(hooks.verifySignature(header, RAW, SECRET, NOW).valid, true);
	});
	it('rejects a wrong secret', () => {
		const r = hooks.verifySignature(sign('whsec_other', RAW, NOW), RAW, SECRET, NOW);
		assert.deepEqual(r, { valid: false, reason: 'Signature does not match' });
	});
	it('rejects a tampered body', () => {
		const r = hooks.verifySignature(sign(SECRET, RAW, NOW), RAW.replace('bigger', 'smaller'), SECRET, NOW);
		assert.equal(r.valid, false);
	});
	it('rejects a stale timestamp (> 300 s) and a future one', () => {
		assert.equal(hooks.verifySignature(sign(SECRET, RAW, NOW - 301), RAW, SECRET, NOW).valid, false);
		assert.equal(hooks.verifySignature(sign(SECRET, RAW, NOW + 301), RAW, SECRET, NOW).valid, false);
		assert.equal(hooks.verifySignature(sign(SECRET, RAW, NOW - 300), RAW, SECRET, NOW).valid, true);
	});
	it('rejects missing and malformed headers', () => {
		assert.equal(hooks.verifySignature(undefined, RAW, SECRET, NOW).valid, false);
		assert.equal(hooks.verifySignature('', RAW, SECRET, NOW).valid, false);
		assert.equal(hooks.verifySignature('v1=abc', RAW, SECRET, NOW).valid, false);
		assert.equal(hooks.verifySignature(`t=${NOW}`, RAW, SECRET, NOW).valid, false);
		assert.equal(hooks.verifySignature(`t=${NOW},v1=zz`, RAW, SECRET, NOW).valid, false);
		assert.equal(hooks.verifySignature(`t=${NOW},v1=abcd`, RAW, SECRET, NOW).valid, false);
	});
});

describe('handleDelivery', () => {
	const body = JSON.parse(RAW);
	it('passes the event through unchanged when the signature is good', () => {
		const r = hooks.handleDelivery({ secret: SECRET, signatureHeader: sign(SECRET, RAW, NOW), rawBody: Buffer.from(RAW), body, nowSeconds: NOW });
		assert.deepEqual(r, { ok: true, event: body });
	});
	it('rejects a bad signature', () => {
		const r = hooks.handleDelivery({ secret: SECRET, signatureHeader: sign('nope', RAW, NOW), rawBody: RAW, body, nowSeconds: NOW });
		assert.equal(r.ok, false);
	});
	it('rejects a stale signature', () => {
		const r = hooks.handleDelivery({ secret: SECRET, signatureHeader: sign(SECRET, RAW, NOW - 600), rawBody: RAW, body, nowSeconds: NOW });
		assert.deepEqual(r, { ok: false, reason: 'Signature timestamp is outside the 5-minute window' });
	});
	it('without a stored secret accepts and marks verified: false', () => {
		const r = hooks.handleDelivery({ secret: undefined, signatureHeader: undefined, rawBody: undefined, body });
		assert.deepEqual(r, { ok: true, event: { ...body, verified: false } });
	});
	it('passes comment.updated with changes.stage through unchanged (plan B4)', () => {
		const raw = '{"id":"evt-2","type":"comment.updated","pin":{"id":"p1","number":1,"status":"open","url":"https://x"},"changes":{"stage":"ready"}}';
		const r = hooks.handleDelivery({ secret: SECRET, signatureHeader: sign(SECRET, raw, NOW), rawBody: raw, body: JSON.parse(raw), nowSeconds: NOW });
		assert.deepEqual(r, { ok: true, event: JSON.parse(raw) });
	});
	it('passes round.changes_requested with outcome through unchanged (29 Oct 2026)', () => {
		for (const outcome of ['changes', 'rejected']) {
			const raw = `{"id":"evt-3","type":"round.changes_requested","actor":{"type":"guest"},"round":{"id":"r1","n":1},"outcome":"${outcome}"}`;
			const r = hooks.handleDelivery({ secret: SECRET, signatureHeader: sign(SECRET, raw, NOW), rawBody: raw, body: JSON.parse(raw), nowSeconds: NOW });
			assert.deepEqual(r, { ok: true, event: JSON.parse(raw) });
		}
	});
	it('falls back to JSON.stringify(body) when rawBody is missing', () => {
		const compact = JSON.stringify(body);
		const r = hooks.handleDelivery({ secret: SECRET, signatureHeader: sign(SECRET, compact, NOW), rawBody: undefined, body, nowSeconds: NOW });
		assert.equal(r.ok, true);
	});
});

describe('buildHookBody (contract trigger table)', () => {
	const url = 'https://n8n.example.com/webhook/x/webhook';
	const expected = {
		newComment: { events: ['comment.created'], comments: 'new' },
		commentReplied: { events: ['comment.created'], comments: 'replies' },
		commentUpdated: { events: ['comment.updated'] },
		statusChanged: { events: ['comment.resolved', 'comment.reopened'] },
		roundApproved: { events: ['round.approved'] },
		changesRequested: { events: ['round.changes_requested'] },
		newRound: { events: ['round.created'] },
	};
	for (const [event, mapping] of Object.entries(expected)) {
		it(`${event} → ${mapping.events.join(' + ')}${mapping.comments ? ` (comments: ${mapping.comments})` : ''}`, () => {
			assert.deepEqual(hooks.buildHookBody(event, url), { url, ...mapping });
		});
	}
	it('covers exactly the 7 triggers', () => {
		assert.deepEqual(Object.keys(hooks.TRIGGER_EVENTS).sort(), Object.keys(expected).sort());
	});
	it('adds projectIds only when a project is chosen', () => {
		assert.deepEqual(hooks.buildHookBody('newRound', url, 'p-1').projectIds, ['p-1']);
		assert.equal('projectIds' in hooks.buildHookBody('newRound', url, ''), false);
		assert.equal('projectIds' in hooks.buildHookBody('newRound', url, '  '), false);
	});
	it('throws on an unknown event', () => {
		assert.throws(() => hooks.buildHookBody('nope', url));
	});
});

describe('createHook / deleteHook (pure)', () => {
	it('createHook posts the body and returns id + secret', async () => {
		const seen = [];
		const r = await hooks.createHook(async (req) => {
			seen.push(req);
			return { hook: { id: 'h-1' }, secret: 'whsec_1' };
		}, 'statusChanged', 'https://n8n.example.com/w', 'p-9');
		assert.deepEqual(r, { ok: true, hookId: 'h-1', secret: 'whsec_1' });
		assert.deepEqual(seen, [{ method: 'POST', path: '/hooks', body: { url: 'https://n8n.example.com/w', events: ['comment.resolved', 'comment.reopened'], projectIds: ['p-9'] } }]);
	});
	it('createHook surfaces the API message and the public-https hint on 400', async () => {
		const r = await hooks.createHook(async () => {
			throw httpError(400, 'bad_request', 'url must be https on port 443 with a public host name');
		}, 'newComment', 'http://localhost:5678/webhook/x');
		assert.equal(r.ok, false);
		assert.match(r.message, /url must be https on port 443/);
		assert.match(r.message, /http:\/\/localhost:5678/);
		assert.equal(r.description, hooks.PUBLIC_URL_HINT);
		assert.equal(r.status, 400);
	});
	it('createHook reports other errors with their code', async () => {
		const r = await hooks.createHook(async () => {
			throw httpError(409, 'too_many_hooks', 'Max 50 hooks per workspace');
		}, 'newComment', 'https://n8n.example.com/w');
		assert.equal(r.ok, false);
		assert.match(r.message, /Max 50 hooks/);
		assert.equal(r.description, 'Error code: too_many_hooks');
	});
	it('createHook rejects an unexpected answer', async () => {
		const r = await hooks.createHook(async () => ({}), 'newComment', 'https://n8n.example.com/w');
		assert.equal(r.ok, false);
	});
	it('deleteHook: 204 → deleted', async () => {
		const seen = [];
		const r = await hooks.deleteHook(async (req) => {
			seen.push(req);
			return undefined;
		}, 'h-1');
		assert.deepEqual(r, { status: 'deleted' });
		assert.deepEqual(seen, [{ method: 'DELETE', path: '/hooks/h-1' }]);
	});
	it('deleteHook: 404 → already_gone (success)', async () => {
		const r = await hooks.deleteHook(async () => {
			throw httpError(404, 'not_found', 'Not found');
		}, 'h-1');
		assert.deepEqual(r, { status: 'already_gone' });
	});
	it('deleteHook: 401 → already_gone (a revoked key\'s hooks are already deleted)', async () => {
		const r = await hooks.deleteHook(async () => {
			throw httpError(401, 'invalid_key', 'Missing, unknown or revoked API key.');
		}, 'h-1');
		assert.deepEqual(r, { status: 'already_gone' });
	});
	it('deleteHook: 500 → failed', async () => {
		const r = await hooks.deleteHook(async () => {
			throw httpError(500, 'internal', 'boom');
		}, 'h-1');
		assert.equal(r.status, 'failed');
	});
});

describe('TweakTickTrigger node', () => {
	const trigger = new TweakTickTrigger();
	const methods = trigger.webhookMethods.default;

	it('is a trigger with no inputs and one POST webhook', () => {
		assert.deepEqual(trigger.description.inputs, []);
		assert.equal(trigger.description.webhooks[0].httpMethod, 'POST');
		assert.equal(trigger.description.credentials[0].name, 'tweakTickApi');
	});

	it('has no notice, and the project filter sits in Options', () => {
		const props = trigger.description.properties;
		assert.equal(props.some((p) => p.type === 'notice'), false);
		assert.equal(props.some((p) => p.name === 'projectId'), false);
		const options = props.find((p) => p.name === 'options');
		assert.equal(options.type, 'collection');
		assert.deepEqual(options.default, {});
		assert.deepEqual(options.options.map((o) => o.name), ['projectId']);
	});

	it('create without Options sends no project filter', async () => {
		const ctx = fakeContext({ params: { event: 'newRound' }, answers: [() => ({ hook: { id: 'h-8' }, secret: 's' })] });
		assert.equal(await methods.create.call(ctx), true);
		assert.equal('projectIds' in ctx.calls[0].body, false);
	});

	it('checkExists looks at the stored hook id', async () => {
		assert.equal(await methods.checkExists.call(fakeContext({ staticData: {} })), false);
		assert.equal(await methods.checkExists.call(fakeContext({ staticData: { hookId: 'h-1' } })), true);
	});

	it('create POSTs /api/v2/hooks with the webhook URL and stores hookId + secret', async () => {
		const ctx = fakeContext({
			params: { event: 'commentReplied', options: { projectId: 'p-1' } },
			answers: [() => ({ hook: { id: 'h-7' }, secret: 'whsec_7' })],
		});
		assert.equal(await methods.create.call(ctx), true);
		assert.equal(ctx.calls.length, 1);
		const call = ctx.calls[0];
		assert.equal(call.credentialName, 'tweakTickApi');
		assert.equal(call.method, 'POST');
		assert.equal(call.url, 'https://app.tweaktick.test/api/v2/hooks');
		assert.deepEqual(call.body, {
			url: 'https://n8n.example.com/webhook/abc/webhook',
			events: ['comment.created'],
			comments: 'replies',
			projectIds: ['p-1'],
		});
		assert.deepEqual(ctx.staticData, { hookId: 'h-7', secret: 'whsec_7' });
	});

	it('create on localhost throws a NodeApiError with the API message and the hint', async () => {
		const ctx = fakeContext({
			params: { event: 'newComment', options: {}, __webhookUrl: 'http://localhost:5678/webhook/x' },
			answers: [() => { throw httpError(400, 'bad_request', 'url must use https'); }],
		});
		await assert.rejects(methods.create.call(ctx), (err) => {
			assert.equal(err.constructor.name, 'NodeApiError');
			assert.match(err.message, /url must use https/);
			assert.match(err.description, /public https URL/);
			return true;
		});
		assert.deepEqual(ctx.staticData, {});
	});

	it('delete sends DELETE /hooks/{id} and clears static data', async () => {
		const ctx = fakeContext({ staticData: { hookId: 'h-7', secret: 'whsec_7' }, answers: [() => undefined] });
		assert.equal(await methods.delete.call(ctx), true);
		assert.equal(ctx.calls[0].method, 'DELETE');
		assert.equal(ctx.calls[0].url, 'https://app.tweaktick.test/api/v2/hooks/h-7');
		assert.deepEqual(ctx.staticData, {});
	});

	it('delete treats 404 as success (through the real transport error wrapping)', async () => {
		const ctx = fakeContext({ staticData: { hookId: 'gone', secret: 's' }, answers: [() => { throw httpError(404, 'not_found', 'Hook not found'); }] });
		assert.equal(await methods.delete.call(ctx), true);
		assert.deepEqual(ctx.staticData, {});
	});

	it('delete throws on other errors and keeps the hook id', async () => {
		const ctx = fakeContext({ staticData: { hookId: 'h-1', secret: 's' }, answers: [() => { throw httpError(500, 'internal', 'boom'); }] });
		await assert.rejects(methods.delete.call(ctx), /boom/);
		assert.equal(ctx.staticData.hookId, 'h-1');
	});

	it('delete without a stored hook makes no call', async () => {
		const ctx = fakeContext({ staticData: {} });
		assert.equal(await methods.delete.call(ctx), true);
		assert.equal(ctx.calls.length, 0);
	});

	it('webhook outputs the PublicEvent when the signature is good', async () => {
		const body = JSON.parse(RAW);
		const ctx = fakeContext({
			staticData: { hookId: 'h', secret: SECRET },
			request: { headers: { 'x-tweaktick-signature': sign(SECRET, RAW) }, rawBody: Buffer.from(RAW), body },
		});
		const out = await trigger.webhook.call(ctx);
		assert.deepEqual(out, { workflowData: [[{ json: body }]] });
	});

	it('webhook answers 401 and starts nothing on a bad signature', async () => {
		const ctx = fakeContext({
			staticData: { hookId: 'h', secret: SECRET },
			request: { headers: { 'x-tweaktick-signature': sign('wrong', RAW) }, rawBody: Buffer.from(RAW), body: JSON.parse(RAW) },
		});
		const out = await trigger.webhook.call(ctx);
		assert.deepEqual(out, { noWebhookResponse: true });
		assert.equal(ctx.response.statusCode, 401);
		assert.equal(ctx.response.body.error.code, 'invalid_signature');
	});

	it('webhook without a stored secret accepts with verified: false', async () => {
		const body = JSON.parse(RAW);
		const ctx = fakeContext({ staticData: {}, request: { headers: {}, rawBody: Buffer.from(RAW), body } });
		const out = await trigger.webhook.call(ctx);
		assert.deepEqual(out.workflowData[0][0].json, { ...body, verified: false });
	});

	it('loads projects for the dropdown, sorted by name', async () => {
		const ctx = fakeContext({ answers: [() => ({ projects: [{ id: 'b', name: 'Beta' }, { id: 'a', name: 'Alpha' }, { name: 'no id' }] })] });
		const options = await trigger.methods.loadOptions.getProjects.call(ctx);
		assert.deepEqual(options, [{ name: 'Alpha', value: 'a' }, { name: 'Beta', value: 'b' }]);
		assert.equal(ctx.calls[0].url, 'https://app.tweaktick.test/api/v2/projects');
		assert.deepEqual(ctx.calls[0].qs, { limit: 200 });
	});

	it('the dropdown follows nextCursor', async () => {
		const ctx = fakeContext({ answers: [() => ({ projects: [{ id: 'b', name: 'B' }], nextCursor: 'c1' }), () => ({ projects: [{ id: 'a', name: 'A' }], nextCursor: null })] });
		const options = await trigger.methods.loadOptions.getProjects.call(ctx);
		assert.deepEqual(options.map((o) => o.value), ['a', 'b']);
		assert.deepEqual(ctx.calls[1].qs, { limit: 200, cursor: 'c1' });
	});
});
