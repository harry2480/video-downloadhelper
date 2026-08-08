import { createAnthropic } from '@ai-sdk/anthropic';
import { generateText } from 'ai';
import type { AiGateway } from '../../domain/gateways/ai.gateway';

/**
 * Vercel AI SDK + Anthropic provider を使用した AiGateway 実装。
 * model はコンストラクタでオプション指定可能。デフォルト: claude-haiku-4-5-20251001
 */
export class AnthropicAiGateway implements AiGateway {
	private readonly provider: ReturnType<typeof createAnthropic>;

	constructor(
		private readonly apiKey: string,
		private readonly model: string = 'claude-haiku-4-5-20251001',
	) {
		this.provider = createAnthropic({ apiKey });
	}

	async generate(params: {
		systemPrompt: string;
		userPrompt: string;
		maxTokens: number;
	}): Promise<string> {
		const { text } = await generateText({
			model: this.provider(this.model),
			system: params.systemPrompt,
			messages: [{ role: 'user', content: params.userPrompt }],
			maxOutputTokens: params.maxTokens,
		});

		return text;
	}
}
