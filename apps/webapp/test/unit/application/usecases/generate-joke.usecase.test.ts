import { GenerateJokeUseCase } from '@/backend/application/usecases/generate-joke.usecase';
import type { AiGateway } from '@/backend/domain/gateways/ai.gateway';
import type { JokeRepository } from '@/backend/domain/repositories/joke.repository';
import { describe, expect, it, vi } from 'vitest';

describe('GenerateJokeUseCase', () => {
	function createMocks() {
		const aiGateway: AiGateway = {
			generate: vi.fn().mockResolvedValue('面白いジョーク'),
		};
		const jokeRepository: JokeRepository = {
			save: vi.fn().mockResolvedValue(undefined),
			findAll: vi.fn().mockResolvedValue([]),
		};
		return { aiGateway, jokeRepository };
	}

	it('AIでジョークを生成し保存する', async () => {
		const { aiGateway, jokeRepository } = createMocks();
		const useCase = new GenerateJokeUseCase(aiGateway, jokeRepository);

		const joke = await useCase.execute('プログラミング');

		expect(aiGateway.generate).toHaveBeenCalledOnce();
		expect(jokeRepository.save).toHaveBeenCalledOnce();
		expect(joke.theme).toBe('プログラミング');
		expect(joke.content).toBe('面白いジョーク');
	});

	it('AIが空文字を返した場合エラーになる', async () => {
		const { aiGateway, jokeRepository } = createMocks();
		(aiGateway.generate as ReturnType<typeof vi.fn>).mockResolvedValue('  ');
		const useCase = new GenerateJokeUseCase(aiGateway, jokeRepository);

		await expect(useCase.execute('テーマ')).rejects.toThrow('Failed to create joke');
		expect(jokeRepository.save).not.toHaveBeenCalled();
	});
});
