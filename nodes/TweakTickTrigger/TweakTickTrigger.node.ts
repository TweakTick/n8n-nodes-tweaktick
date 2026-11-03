import type {
	IHookFunctions,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes } from 'n8n-workflow';

import { getProjects, tweakTickRequester } from '../TweakTick/transport';
import { createHook, deleteHook, handleDelivery } from './hooks';

export class TweakTickTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'TweakTick Trigger',
		name: 'tweakTickTrigger',
		icon: { light: 'file:../../icons/tweaktick.svg', dark: 'file:../../icons/tweaktick.dark.svg' },
		group: ['trigger'],
		version: [1],
		subtitle: '={{$parameter["event"]}}',
		description: 'Starts the workflow on new client feedback, replies, status changes, approvals and rounds in TweakTick',
		defaults: {
			name: 'TweakTick Trigger',
		},
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'tweakTickApi',
				required: true,
			},
		],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				path: 'webhook',
			},
		],
		properties: [
			{
				displayName:
					'TweakTick only sends events to a public https URL. Self-hosted n8n on http or localhost needs an https tunnel or reverse proxy (set WEBHOOK_URL).',
				name: 'publicUrlNotice',
				type: 'notice',
				default: '',
			},
			{
				displayName: 'Event',
				name: 'event',
				type: 'options',
				noDataExpression: true,
				required: true,
				default: 'newComment',
				options: [
					{
						name: 'Changes Requested',
						value: 'changesRequested',
						description: 'The client asked for changes on a round, or rejected it',
					},
					{
						name: 'Comment Replied',
						value: 'commentReplied',
						description: 'Someone replied in an existing comment thread',
					},
					{
						name: 'Comment Updated',
						value: 'commentUpdated',
						description: 'A comment’s assignee, priority, due date or stage changed',
					},
					{
						name: 'New Comment',
						value: 'newComment',
						description: 'A new comment thread was started (first comment only)',
					},
					{
						name: 'New Round',
						value: 'newRound',
						description: 'A new round (version) was added to a project',
					},
					{
						name: 'Round Approved',
						value: 'roundApproved',
						description: 'The client approved a round',
					},
					{
						name: 'Status Changed',
						value: 'statusChanged',
						description: 'A comment thread was resolved or reopened',
					},
				],
			},
			{
				displayName: 'Project Name or ID',
				name: 'projectId',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getProjects' },
				default: '',
				description:
					'Only events from this project. Leave empty for all projects. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
		],
	};

	methods = {
		loadOptions: { getProjects },
	};

	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				const staticData = this.getWorkflowStaticData('node');
				return typeof staticData.hookId === 'string' && staticData.hookId !== '';
			},

			async create(this: IHookFunctions): Promise<boolean> {
				const webhookUrl = this.getNodeWebhookUrl('default') as string;
				const event = this.getNodeParameter('event') as string;
				const projectId = this.getNodeParameter('projectId', '') as string;
				const request = await tweakTickRequester(this);
				const result = await createHook(request, event, webhookUrl, projectId);
				if (!result.ok) {
					throw new NodeApiError(
						this.getNode(),
						{ message: result.message },
						{
							message: result.message,
							description: result.description,
							httpCode: result.status !== undefined ? String(result.status) : undefined,
						},
					);
				}
				const staticData = this.getWorkflowStaticData('node');
				staticData.hookId = result.hookId;
				staticData.secret = result.secret;
				return true;
			},

			async delete(this: IHookFunctions): Promise<boolean> {
				const staticData = this.getWorkflowStaticData('node');
				const hookId = staticData.hookId;
				if (typeof hookId === 'string' && hookId !== '') {
					const request = await tweakTickRequester(this);
					const outcome = await deleteHook(request, hookId);
					if (outcome.status === 'failed') {
						throw new NodeApiError(this.getNode(), outcome.error as JsonObject);
					}
					if (outcome.status === 'already_gone') {
						this.logger.debug(`TweakTick hook ${hookId} was already deleted`);
					}
				}
				delete staticData.hookId;
				delete staticData.secret;
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const req = this.getRequestObject();
		const staticData = this.getWorkflowStaticData('node');
		const result = handleDelivery({
			secret: staticData.secret,
			signatureHeader: req.headers['x-tweaktick-signature'],
			rawBody: (req as { rawBody?: unknown }).rawBody,
			body: this.getBodyData(),
		});

		if (!result.ok) {
			const res = this.getResponseObject();
			res.status(401).json({ error: { code: 'invalid_signature', message: result.reason } });
			return { noWebhookResponse: true };
		}

		return { workflowData: [this.helpers.returnJsonArray([result.event])] };
	}
}
