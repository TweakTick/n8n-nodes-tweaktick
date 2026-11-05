import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class TweakTickApi implements ICredentialType {
	name = 'tweakTickApi';

	displayName = 'TweakTick API';

	icon: Icon = { light: 'file:../icons/tweaktick.svg', dark: 'file:../icons/tweaktick.dark.svg' };

	documentationUrl = 'https://github.com/tweaktick/n8n-nodes-tweaktick?tab=readme-ov-file#credentials';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			placeholder: 'prk_…',
			description:
				'A workspace API key. In TweakTick open Settings → API, choose the "Zapier / Make / n8n" preset and copy the key (it is shown once).',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://app.tweaktick.com',
			description: 'Change only for a self-hosted or development TweakTick app',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl.replace(/\\/+$/, "")}}/api/v2',
			url: '/me',
			method: 'GET',
		},
	};
}
