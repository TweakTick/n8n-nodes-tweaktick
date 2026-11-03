// Fake n8n contexts for unit tests. No network: httpRequestWithAuthentication is
// replaced by a function that records the request and answers from a script.
import { createHmac } from 'node:crypto';

export const CREDS = { apiKey: 'prk_test', baseUrl: 'https://app.tweaktick.test/' };

/** An axios-like error, the shape n8n's HTTP helper throws for non-2xx answers. */
export function httpError(status, code, message) {
	const err = new Error(`Request failed with status code ${status}`);
	err.response = { status, data: { error: { code, message } } };
	return err;
}

export function sign(secret, rawBody, t = Math.floor(Date.now() / 1000)) {
	const v1 = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
	return `t=${t},v1=${v1}`;
}

/**
 * Builds a fake `this` for node methods. `answers` is a list of functions
 * (request) => response | throws, consumed in order.
 */
export function fakeContext({ params = {}, staticData = {}, answers = [], items = [{ json: {} }], continueOnFail = false, request } = {}) {
	const calls = [];
	const node = { name: 'TweakTick', type: 'n8n-nodes-tweaktick.tweakTick', typeVersion: 1, parameters: {} };
	const response = { statusCode: 200, body: undefined };
	const ctx = {
		calls,
		staticData,
		response,
		getNode: () => node,
		getCredentials: async (name) => {
			if (name !== 'tweakTickApi') throw new Error(`unexpected credential ${name}`);
			return CREDS;
		},
		getNodeParameter: (name, a, b) => {
			// Execute: (name, itemIndex, fallback); hooks: (name, fallback)
			const fallback = typeof a === 'number' ? b : a;
			return name in params ? params[name] : fallback;
		},
		getInputData: () => items,
		continueOnFail: () => continueOnFail,
		getNodeWebhookUrl: () => params.__webhookUrl ?? 'https://n8n.example.com/webhook/abc/webhook',
		getWorkflowStaticData: () => staticData,
		getRequestObject: () => request,
		getBodyData: () => request?.body ?? {},
		getResponseObject: () => ({
			status(code) {
				response.statusCode = code;
				return this;
			},
			json(body) {
				response.body = body;
				return this;
			},
		}),
		logger: { debug() {}, info() {}, warn() {}, error() {} },
		helpers: {
			httpRequestWithAuthentication: async function (credentialName, options) {
				calls.push({ credentialName, ...options });
				const answer = answers.shift();
				if (!answer) throw new Error(`no scripted answer for ${options.method} ${options.url}`);
				return answer(options);
			},
			returnJsonArray: (arr) => (Array.isArray(arr) ? arr : [arr]).map((json) => ({ json })),
		},
	};
	return ctx;
}
