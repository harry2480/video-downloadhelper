import type { AiGateway } from '../../domain/gateways/ai.gateway';
import { Joke } from '../../domain/models/joke.model';
import type { JokeRepository } from '../../domain/repositories/joke.repository';

export class GenerateJokeUseCase {
	constructor(
		private readonly aiGateway: AiGateway,
		private readonly jokeRepository: JokeRepository,
	) {}

	async execute(theme: string): Promise<Joke> {
		const content = await this.aiGateway.generate({
			systemPrompt:
				'あなたは面白いジョークを考えるコメディアンです。与えられたテーマに関する短いジョークを1つ日本語で生成してください。ジョークのみを返してください。',
			userPrompt: `テーマ: ${theme}`,
			maxTokens: 256,
		});

		const id = crypto.randomUUID();
		const result = Joke.create({ id, theme, content });

		if (!result.success) {
			throw new Error(`Failed to create joke: ${result.error}`);
		}

		await this.jokeRepository.save(result.value);
		return result.value;
	}
}
