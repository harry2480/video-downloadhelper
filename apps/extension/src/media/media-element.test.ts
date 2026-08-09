import { describe, expect, it } from 'vitest';
import { type MediaElementSnapshot, toDetectionCandidates } from './media-element';

function snapshot(overrides: Partial<MediaElementSnapshot> = {}): MediaElementSnapshot {
	return {
		kind: 'video',
		src: null,
		currentSrc: null,
		sourceUrls: [],
		duration: null,
		width: null,
		height: null,
		label: null,
		...overrides,
	};
}

describe('toDetectionCandidates', () => {
	it('currentSrc を候補にする', () => {
		const candidates = toDetectionCandidates(
			snapshot({ currentSrc: 'https://cdn.example.com/v.mp4' }),
		);

		expect(candidates).toEqual([
			{ sourceUrl: 'https://cdn.example.com/v.mp4', detectedBy: 'video-element' },
		]);
	});

	it('audio 要素は audio-element として扱う', () => {
		const candidates = toDetectionCandidates(
			snapshot({ kind: 'audio', currentSrc: 'https://cdn.example.com/a.mp3' }),
		);

		expect(candidates[0]?.detectedBy).toBe('audio-element');
	});

	it('src と <source> をすべて候補にする', () => {
		const candidates = toDetectionCandidates(
			snapshot({
				src: 'https://cdn.example.com/a.mp4',
				sourceUrls: ['https://cdn.example.com/b.webm', 'https://cdn.example.com/c.mp4'],
			}),
		);

		expect(candidates.map((candidate) => candidate.sourceUrl)).toEqual([
			'https://cdn.example.com/a.mp4',
			'https://cdn.example.com/b.webm',
			'https://cdn.example.com/c.mp4',
		]);
	});

	it('同じ URL を重複させない', () => {
		const candidates = toDetectionCandidates(
			snapshot({
				src: 'https://cdn.example.com/v.mp4',
				currentSrc: 'https://cdn.example.com/v.mp4',
				sourceUrls: ['https://cdn.example.com/v.mp4'],
			}),
		);

		expect(candidates).toHaveLength(1);
	});

	describe('再取得できないスキーム', () => {
		it('MSE の blob URL を候補にしない', () => {
			// 元ストリームはネットワーク検出が拾う（要件定義 2.2）
			const candidates = toDetectionCandidates(
				snapshot({ currentSrc: 'blob:https://example.com/8f3a-1234' }),
			);

			expect(candidates).toEqual([]);
		});

		it.each(['data:video/mp4;base64,AAAA', 'filesystem:https://a.example.com/temporary/v.mp4'])(
			'%s を候補にしない',
			(url) => {
				expect(toDetectionCandidates(snapshot({ currentSrc: url }))).toEqual([]);
			},
		);

		it('blob を除いた他の候補は残す', () => {
			const candidates = toDetectionCandidates(
				snapshot({
					currentSrc: 'blob:https://example.com/8f3a',
					sourceUrls: ['https://cdn.example.com/v.mp4'],
				}),
			);

			expect(candidates.map((candidate) => candidate.sourceUrl)).toEqual([
				'https://cdn.example.com/v.mp4',
			]);
		});
	});

	describe('再生時間・解像度', () => {
		it('ブラウザが選択した URL にのみ付与する', () => {
			// 選ばれなかった <source> に付けると誤った情報になる
			const candidates = toDetectionCandidates(
				snapshot({
					currentSrc: 'https://cdn.example.com/selected.mp4',
					sourceUrls: [
						'https://cdn.example.com/selected.mp4',
						'https://cdn.example.com/other.webm',
					],
					duration: 120,
					width: 1920,
					height: 1080,
				}),
			);

			expect(candidates[0]).toMatchObject({ duration: 120, width: 1920, height: 1080 });
			expect(candidates[1]).toEqual({
				sourceUrl: 'https://cdn.example.com/other.webm',
				detectedBy: 'video-element',
			});
		});

		it('メタデータ未読み込み（null）では付与しない', () => {
			const candidates = toDetectionCandidates(
				snapshot({ currentSrc: 'https://cdn.example.com/v.mp4', duration: null }),
			);

			expect(candidates[0]).not.toHaveProperty('duration');
		});

		it('0 や負の値を付与しない', () => {
			const candidates = toDetectionCandidates(
				snapshot({
					currentSrc: 'https://cdn.example.com/v.mp4',
					duration: 0,
					width: -1,
					height: 0,
				}),
			);

			expect(candidates[0]).toEqual({
				sourceUrl: 'https://cdn.example.com/v.mp4',
				detectedBy: 'video-element',
			});
		});

		it('Infinity（ライブストリーム）を付与しない', () => {
			const candidates = toDetectionCandidates(
				snapshot({
					currentSrc: 'https://cdn.example.com/live.m3u8',
					duration: Number.POSITIVE_INFINITY,
				}),
			);

			expect(candidates[0]).not.toHaveProperty('duration');
		});
	});

	describe('ラベル', () => {
		it('すべての候補へ付与する', () => {
			const candidates = toDetectionCandidates(
				snapshot({
					src: 'https://cdn.example.com/a.mp4',
					sourceUrls: ['https://cdn.example.com/b.mp4'],
					label: '動画タイトル',
				}),
			);

			expect(candidates.every((candidate) => candidate.title === '動画タイトル')).toBe(true);
		});

		it('前後の空白を落とす', () => {
			const candidates = toDetectionCandidates(
				snapshot({ currentSrc: 'https://cdn.example.com/v.mp4', label: '  タイトル  ' }),
			);

			expect(candidates[0]?.title).toBe('タイトル');
		});

		it('空白のみのラベルを付与しない', () => {
			const candidates = toDetectionCandidates(
				snapshot({ currentSrc: 'https://cdn.example.com/v.mp4', label: '   ' }),
			);

			expect(candidates[0]).not.toHaveProperty('title');
		});

		it('長すぎるラベルを切り詰める', () => {
			// ページ由来の文字列をそのまま持ち回らない
			const candidates = toDetectionCandidates(
				snapshot({ currentSrc: 'https://cdn.example.com/v.mp4', label: 'あ'.repeat(1_000) }),
			);

			expect(candidates[0]?.title).toHaveLength(200);
		});
	});

	it('URL が 1 つもなければ候補を返さない', () => {
		expect(toDetectionCandidates(snapshot())).toEqual([]);
	});
});
