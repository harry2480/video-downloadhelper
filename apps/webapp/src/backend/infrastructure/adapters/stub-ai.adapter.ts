import type { AiGateway } from '../../domain/gateways/ai.gateway';

/**
 * テスト・開発用の Stub 実装。
 * ANTHROPIC_API_KEY が未設定の場合に自動的に使用される。
 */
export class StubAiGateway implements AiGateway {
	constructor(
		private readonly fixedResponse: string = 'これはスタブのジョークです。APIキーが設定されていないときに返されます。',
	) {}

	async generate(_params: {
		systemPrompt: string;
		userPrompt: string;
		maxTokens: number;
	}): Promise<string> {
		return this.fixedResponse;
	}
}
