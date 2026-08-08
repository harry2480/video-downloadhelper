import { GenerateJokeUseCase } from '../../application/usecases/generate-joke.usecase';
import { ListJokesUseCase } from '../../application/usecases/list-jokes.usecase';
import type { AiGateway } from '../../domain/gateways/ai.gateway';
import { AnthropicAiGateway } from '../../infrastructure/adapters/anthropic-ai.adapter';
import { StubAiGateway } from '../../infrastructure/adapters/stub-ai.adapter';
import { PrismaJokeRepository } from '../../infrastructure/repositories/prisma-joke.repository';

function createAiGateway(): AiGateway {
	const apiKey = process.env.ANTHROPIC_API_KEY;
	if (apiKey) {
		return new AnthropicAiGateway(apiKey);
	}
	return new StubAiGateway();
}

const jokeRepository = new PrismaJokeRepository();
const aiGateway = createAiGateway();

export const generateJokeUseCase = new GenerateJokeUseCase(aiGateway, jokeRepository);
export const listJokesUseCase = new ListJokesUseCase(jokeRepository);
