import { describe, expect, it } from 'vitest';

// Integration テストは INTEGRATION_TEST=true の場合のみ実行
const shouldRun = process.env.INTEGRATION_TEST === 'true';

describe.skipIf(!shouldRun)('PrismaJokeRepository', () => {
	it('Jokeの保存と取得ができる', async () => {
		const { PrismaJokeRepository } = await import(
			'@/backend/infrastructure/repositories/prisma-joke.repository'
		);
		const { Joke } = await import('@/backend/domain/models/joke.model');

		const repository = new PrismaJokeRepository();
		const result = Joke.create({
			id: `test-${Date.now()}`,
			theme: 'テスト',
			content: 'テスト用ジョーク',
		});

		if (!result.success) throw new Error('Failed to create joke');

		await repository.save(result.value);
		const jokes = await repository.findAll();
		const found = jokes.find((j) => j.id === result.value.id);
		expect(found).toBeDefined();
		expect(found?.theme).toBe('テスト');
	});
});
