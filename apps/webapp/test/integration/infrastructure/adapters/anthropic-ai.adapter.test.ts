import { describe, expect, it } from 'vitest';

// Integration テストは INTEGRATION_TEST=true の場合のみ実行
const shouldRun = process.env.INTEGRATION_TEST === 'true';

describe.skipIf(!shouldRun)('AnthropicAiGateway', () => {
	it('テキスト生成ができる', async () => {
		const { AnthropicAiGateway } = await import(
			'@/backend/infrastructure/adapters/anthropic-ai.adapter'
		);

		const gateway = new AnthropicAiGateway(process.env.ANTHROPIC_API_KEY ?? '');
		const result = await gateway.generate({
			systemPrompt: '質問に対して都市名のみを回答してください。余計な説明は不要です。',
			userPrompt: '日本の首都は？',
			maxTokens: 32,
		});

		expect(result).toContain('東京');
	});
});
