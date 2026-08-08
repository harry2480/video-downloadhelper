import { Joke } from '@/backend/domain/models/joke.model';
import { describe, expect, it } from 'vitest';

describe('Joke.create', () => {
	it('正常にJokeを生成できる', () => {
		const result = Joke.create({
			id: 'test-id',
			theme: 'プログラミング',
			content: 'なぜプログラマーは暗い部屋が好きなのか？バグが寄ってこないから。',
		});

		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.value.id).toBe('test-id');
			expect(result.value.theme).toBe('プログラミング');
			expect(result.value.content).toBe(
				'なぜプログラマーは暗い部屋が好きなのか？バグが寄ってこないから。',
			);
		}
	});

	it('テーマが空の場合エラーを返す', () => {
		const result = Joke.create({
			id: 'test-id',
			theme: '  ',
			content: '面白いジョーク',
		});

		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error).toBe('THEME_EMPTY');
		}
	});

	it('コンテンツが空の場合エラーを返す', () => {
		const result = Joke.create({
			id: 'test-id',
			theme: 'テーマ',
			content: '  ',
		});

		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error).toBe('CONTENT_EMPTY');
		}
	});

	it('前後の空白をトリムする', () => {
		const result = Joke.create({
			id: 'test-id',
			theme: '  プログラミング  ',
			content: '  ジョーク  ',
		});

		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.value.theme).toBe('プログラミング');
			expect(result.value.content).toBe('ジョーク');
		}
	});
});

describe('Joke.reconstruct', () => {
	it('DBレコードからJokeを復元できる', () => {
		const date = new Date('2025-01-01');
		const joke = Joke.reconstruct({
			id: 'test-id',
			theme: 'テーマ',
			content: 'コンテンツ',
			createdAt: date,
		});

		expect(joke.id).toBe('test-id');
		expect(joke.createdAt).toBe(date);
	});
});
