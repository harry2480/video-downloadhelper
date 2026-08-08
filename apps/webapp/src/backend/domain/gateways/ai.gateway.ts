/**
 * LLM プロバイダーへの汎用テキスト生成 Gateway interface。
 * プロンプト生成・レスポンスパースは呼び出し元の責務。
 * この interface は LLM API 呼び出しのみを抽象化する。
 */
export interface AiGateway {
	generate(params: {
		systemPrompt: string;
		userPrompt: string;
		maxTokens: number;
	}): Promise<string>;
}
