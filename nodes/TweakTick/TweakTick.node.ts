import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import type { ApiRequest } from './shared';
import { actionOutput, buildActionRequest, listProjects } from './shared';
import { getProjects, tweakTickRequester } from './transport';

/*
 * Programmatic style (not declarative): the request builder is shared with the
 * trigger and unit-tested on its own, and error messages come from TweakTick's
 * `{ error: { code, message } }` body.
 */
export class TweakTick implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'TweakTick',
		name: 'tweakTick',
		icon: { light: 'file:../../icons/tweaktick.svg', dark: 'file:../../icons/tweaktick.dark.svg' },
		group: ['transform'],
		version: [1],
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Reply to, resolve and reopen TweakTick client feedback, and list projects',
		defaults: {
			name: 'TweakTick',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		credentials: [
			{
				name: 'tweakTickApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Comment', value: 'comment' },
					{ name: 'Project', value: 'project' },
				],
				default: 'comment',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['comment'] } },
				options: [
					{
						name: 'Create Reply',
						value: 'createReply',
						description: 'Add a reply to a comment thread',
						action: 'Create a reply',
					},
					{
						name: 'Get',
						value: 'get',
						description: 'Get a comment thread with its replies',
						action: 'Get a comment',
					},
					{
						name: 'Reopen',
						value: 'reopen',
						description: 'Reopen a resolved comment thread',
						action: 'Reopen a comment',
					},
					{
						name: 'Resolve',
						value: 'resolve',
						description: 'Mark a comment thread as resolved',
						action: 'Resolve a comment',
					},
				],
				default: 'createReply',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['project'] } },
				options: [
					{
						name: 'Get Many',
						value: 'getAll',
						description: 'List the workspace’s review projects, newest first',
						action: 'Get many projects',
					},
				],
				default: 'getAll',
			},
			{
				displayName: 'Comment ID',
				name: 'commentId',
				type: 'string',
				required: true,
				default: '',
				description:
					'The comment thread ID. From the TweakTick Trigger, use the pin ID field (the thread), not the comment ID.',
				displayOptions: { show: { resource: ['comment'] } },
			},
			{
				displayName: 'Text',
				name: 'text',
				type: 'string',
				typeOptions: { rows: 4 },
				required: true,
				default: '',
				description: 'The reply text (1–5000 characters)',
				displayOptions: { show: { resource: ['comment'], operation: ['createReply'] } },
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add option',
				default: {},
				displayOptions: { show: { resource: ['comment'], operation: ['createReply'] } },
				options: [
					{
						displayName: 'Internal (Agency Only)',
						name: 'internal',
						type: 'boolean',
						default: true,
						description:
							'Whether the reply is internal. Internal replies are seen only by your team; turn this off to reply to the client.',
					},
				],
			},
			{
				displayName: 'Return All',
				name: 'returnAll',
				type: 'boolean',
				default: false,
				description: 'Whether to return all results or only up to a given limit',
				displayOptions: { show: { resource: ['project'], operation: ['getAll'] } },
			},
			{
				displayName: 'Limit',
				name: 'limit',
				type: 'number',
				typeOptions: { minValue: 1 },
				default: 50,
				description: 'Max number of results to return',
				displayOptions: { show: { resource: ['project'], operation: ['getAll'], returnAll: [false] } },
			},
		],
	};

	methods = {
		loadOptions: { getProjects },
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const request = await tweakTickRequester(this);

		for (let i = 0; i < items.length; i++) {
			try {
				const resource = this.getNodeParameter('resource', i) as string;
				const operation = this.getNodeParameter('operation', i) as string;

				if (resource === 'project' && operation === 'getAll') {
					const returnAll = this.getNodeParameter('returnAll', i, false) as boolean;
					const limit = returnAll ? undefined : (this.getNodeParameter('limit', i, 50) as number);
					for (const json of await listProjects(request, { returnAll, limit })) {
						returnData.push({ json, pairedItem: { item: i } });
					}
					continue;
				}

				let apiRequest: ApiRequest;
				try {
					const options =
						operation === 'createReply'
							? (this.getNodeParameter('options', i, {}) as { internal?: boolean })
							: {};
					apiRequest = buildActionRequest(resource, operation, {
						commentId: resource === 'comment' ? (this.getNodeParameter('commentId', i) as string) : undefined,
						text:
							operation === 'createReply' ? (this.getNodeParameter('text', i) as string) : undefined,
						internal: operation === 'createReply' ? options.internal ?? true : undefined,
					});
				} catch (error) {
					throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
				}

				const response = await request(apiRequest);
				for (const json of actionOutput(resource, operation, response)) {
					returnData.push({ json, pairedItem: { item: i } });
				}
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
					continue;
				}
				if (error instanceof NodeApiError) {
					error.context.itemIndex = i;
					throw new NodeApiError(this.getNode(), error as unknown as JsonObject, { itemIndex: i });
				}
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
			}
		}

		return [returnData];
	}
}
