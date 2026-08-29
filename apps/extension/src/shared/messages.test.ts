import { describe, expect, it } from 'vitest';
import {
	parseAssemblyCommand,
	parseContentMessage,
	parseOffscreenMessage,
	parsePopupMessage,
} from './messages';

/**
 * Content Script はページと同じプロセスで動くため、送られてくる値は
 * 改ざんされ得る。ここは信用境界であり、異常系こそが本体。
 */

function message(candidates: unknown[]): unknown {
	return { kind: 'media-elements-detected', candidates };
}

const VALID = {
	sourceUrl: 'https://cdn.example.com/v.mp4',
	detectedBy: 'video-element',
};

describe('parseContentMessage', () => {
	it('正しいメッセージを通す', () => {
		expect(parseContentMessage(message([VALID]))).toEqual({
			kind: 'media-elements-detected',
			candidates: [VALID],
		});
	});

	it('任意項目を引き継ぐ', () => {
		const parsed = parseContentMessage(
			message([{ ...VALID, duration: 120, width: 1920, height: 1080, title: 'タイトル' }]),
		);

		expect(parsed?.candidates[0]).toEqual({
			...VALID,
			duration: 120,
			width: 1920,
			height: 1080,
			title: 'タイトル',
		});
	});

	describe('メッセージ全体の検証', () => {
		it.each([undefined, null, 0, 'text', [], true])('%s を破棄する', (raw) => {
			expect(parseContentMessage(raw)).toBeUndefined();
		});

		it('kind が違うものを破棄する', () => {
			expect(parseContentMessage({ kind: 'other', candidates: [VALID] })).toBeUndefined();
		});

		it('candidates が配列でないものを破棄する', () => {
			expect(
				parseContentMessage({ kind: 'media-elements-detected', candidates: {} }),
			).toBeUndefined();
		});

		it('有効な候補が 1 件もなければ破棄する', () => {
			expect(parseContentMessage(message([]))).toBeUndefined();
			expect(parseContentMessage(message([{ sourceUrl: 123 }]))).toBeUndefined();
		});
	});

	describe('候補ごとの検証', () => {
		it('不正な候補だけを落として残りを通す', () => {
			const parsed = parseContentMessage(
				message([{ sourceUrl: 123 }, VALID, null, { detectedBy: 'video-element' }]),
			);

			expect(parsed?.candidates).toEqual([VALID]);
		});

		it('detectedBy を列挙値に限定する', () => {
			expect(parseContentMessage(message([{ ...VALID, detectedBy: 'network' }]))).toBeUndefined();
			expect(parseContentMessage(message([{ ...VALID, detectedBy: '__proto__' }]))).toBeUndefined();
		});

		it('空の sourceUrl を破棄する', () => {
			expect(parseContentMessage(message([{ ...VALID, sourceUrl: '' }]))).toBeUndefined();
		});

		it('長すぎる sourceUrl を破棄する', () => {
			const parsed = parseContentMessage(
				message([{ ...VALID, sourceUrl: `https://a.example.com/${'x'.repeat(5_000)}` }]),
			);
			expect(parsed).toBeUndefined();
		});

		it('数値でない duration / width / height を落とす', () => {
			const parsed = parseContentMessage(
				message([{ ...VALID, duration: '120', width: null, height: {} }]),
			);

			expect(parsed?.candidates[0]).toEqual(VALID);
		});

		it('NaN / Infinity / 0 以下を落とす', () => {
			const parsed = parseContentMessage(
				message([{ ...VALID, duration: Number.NaN, width: Number.POSITIVE_INFINITY, height: -1 }]),
			);

			expect(parsed?.candidates[0]).toEqual(VALID);
		});

		it('文字列でない title を落とす', () => {
			const parsed = parseContentMessage(message([{ ...VALID, title: { toString: 'evil' } }]));

			expect(parsed?.candidates[0]).toEqual(VALID);
		});

		it('長すぎる title を切り詰める', () => {
			const parsed = parseContentMessage(message([{ ...VALID, title: 'あ'.repeat(1_000) }]));

			expect(parsed?.candidates[0]?.title).toHaveLength(200);
		});

		it('想定外のキーを取り込まない', () => {
			const parsed = parseContentMessage(
				message([{ ...VALID, tabId: 999, detectedAt: 1, evil: 'x' }]),
			);

			expect(parsed?.candidates[0]).toEqual(VALID);
		});
	});

	describe('件数の上限', () => {
		it('有効な候補を 50 件までに絞る', () => {
			const many = Array.from({ length: 500 }, (_, index) => ({
				...VALID,
				sourceUrl: `https://cdn.example.com/${index}.mp4`,
			}));

			expect(parseContentMessage(message(many))?.candidates).toHaveLength(50);
		});

		it('無効な候補が先頭に並んでも有効な候補を押し出さない', () => {
			// 「先頭 N 件を取ってから絞る」実装だと 0 件になる
			const padded = [
				...Array.from({ length: 100 }, () => ({ sourceUrl: 123 })),
				{ ...VALID, sourceUrl: 'https://cdn.example.com/real.mp4' },
			];

			const parsed = parseContentMessage(message(padded));

			expect(parsed?.candidates).toEqual([
				{ ...VALID, sourceUrl: 'https://cdn.example.com/real.mp4' },
			]);
		});

		it('巨大な配列でも走査を打ち切る', () => {
			const huge = Array.from({ length: 100_000 }, () => ({ sourceUrl: 123 }));

			expect(parseContentMessage(message(huge))).toBeUndefined();
		});
	});
});

describe('parsePopupMessage', () => {
	it('再スキャン要求を通す', () => {
		expect(parsePopupMessage({ kind: 'rescan' })).toEqual({ kind: 'rescan' });
	});

	it('ダウンロード要求を通す', () => {
		expect(
			parsePopupMessage({ kind: 'start-download', request: { mediaId: '1:https://a/v.mp4' } }),
		).toEqual({ kind: 'start-download', request: { mediaId: '1:https://a/v.mp4' } });
	});

	it('選択された品質を引き継ぐ', () => {
		const parsed = parsePopupMessage({
			kind: 'start-download',
			request: { mediaId: '1:https://a/v.m3u8', variantId: 'v1', audioVariantId: 'a0' },
		});

		expect(parsed).toEqual({
			kind: 'start-download',
			request: { mediaId: '1:https://a/v.m3u8', variantId: 'v1', audioVariantId: 'a0' },
		});
	});

	it('品質の指定が壊れていても要求自体は通す', () => {
		// 品質が選べないだけで、既定の品質なら保存できる
		const parsed = parsePopupMessage({
			kind: 'start-download',
			request: { mediaId: '1:https://a/v.mp4', variantId: 42 },
		});

		expect(parsed).toEqual({ kind: 'start-download', request: { mediaId: '1:https://a/v.mp4' } });
	});

	it('中止・再試行の要求を通す', () => {
		expect(parsePopupMessage({ kind: 'cancel-download', taskId: 't1' })).toEqual({
			kind: 'cancel-download',
			taskId: 't1',
		});
		expect(parsePopupMessage({ kind: 'retry-download', taskId: 't1' })).toEqual({
			kind: 'retry-download',
			taskId: 't1',
		});
	});

	it('形が合わないものは破棄する', () => {
		expect(parsePopupMessage(undefined)).toBeUndefined();
		expect(parsePopupMessage('rescan')).toBeUndefined();
		expect(parsePopupMessage([{ kind: 'rescan' }])).toBeUndefined();
		expect(parsePopupMessage({ kind: 'unknown' })).toBeUndefined();
		expect(parsePopupMessage({ kind: 'start-download' })).toBeUndefined();
		expect(parsePopupMessage({ kind: 'start-download', request: { mediaId: '' } })).toBeUndefined();
		expect(parsePopupMessage({ kind: 'start-download', request: { mediaId: 1 } })).toBeUndefined();
		expect(parsePopupMessage({ kind: 'cancel-download' })).toBeUndefined();
		expect(parsePopupMessage({ kind: 'retry-download', taskId: 7 })).toBeUndefined();
	});

	it('長すぎる ID を弾く', () => {
		const long = 'x'.repeat(4_097);

		expect(parsePopupMessage({ kind: 'cancel-download', taskId: long })).toBeUndefined();
		expect(
			parsePopupMessage({ kind: 'start-download', request: { mediaId: long } }),
		).toBeUndefined();
	});
});

describe('parseOffscreenMessage', () => {
	it('進捗を通す', () => {
		expect(
			parseOffscreenMessage({
				kind: 'assembly-progress',
				taskId: 't1',
				completed: 3,
				total: 10,
				bytes: 300,
			}),
		).toEqual({ kind: 'assembly-progress', taskId: 't1', completed: 3, total: 10, bytes: 300 });
	});

	it('完了とオブジェクト URL を通す', () => {
		expect(
			parseOffscreenMessage({
				kind: 'assembly-done',
				taskId: 't1',
				objectUrl: 'blob:chrome-extension://x/abc',
				bytes: 10,
			}),
		).toEqual({
			kind: 'assembly-done',
			taskId: 't1',
			objectUrl: 'blob:chrome-extension://x/abc',
			bytes: 10,
		});
	});

	it('失敗の理由を通す', () => {
		expect(
			parseOffscreenMessage({ kind: 'assembly-failed', taskId: 't1', reason: '取得できません' }),
		).toEqual({ kind: 'assembly-failed', taskId: 't1', reason: '取得できません' });
	});

	it('形が合わないものは破棄する', () => {
		expect(parseOffscreenMessage(undefined)).toBeUndefined();
		expect(parseOffscreenMessage({ kind: 'assembly-progress' })).toBeUndefined();
		expect(parseOffscreenMessage({ kind: 'unknown', taskId: 't1' })).toBeUndefined();
		expect(
			parseOffscreenMessage({ kind: 'assembly-progress', taskId: 't1', completed: 1, total: 2 }),
		).toBeUndefined();
		expect(
			parseOffscreenMessage({
				kind: 'assembly-progress',
				taskId: 't1',
				completed: -1,
				total: 2,
				bytes: 1,
			}),
		).toBeUndefined();
		expect(
			parseOffscreenMessage({
				kind: 'assembly-progress',
				taskId: 't1',
				completed: Number.NaN,
				total: 2,
				bytes: 1,
			}),
		).toBeUndefined();
		expect(
			parseOffscreenMessage({ kind: 'assembly-done', taskId: 't1', bytes: 1 }),
		).toBeUndefined();
		expect(
			parseOffscreenMessage({ kind: 'assembly-done', taskId: 't1', objectUrl: 'blob:x' }),
		).toBeUndefined();
		expect(parseOffscreenMessage({ kind: 'assembly-failed', taskId: 't1' })).toBeUndefined();
	});
});

describe('parseAssemblyCommand', () => {
	it('組み立ての依頼を通す', () => {
		expect(
			parseAssemblyCommand({
				kind: 'assemble-hls',
				taskId: 't1',
				playlistUrl: 'https://cdn.example.com/index.m3u8',
				maxBytes: 100,
			}),
		).toEqual({
			kind: 'assemble-hls',
			taskId: 't1',
			playlistUrl: 'https://cdn.example.com/index.m3u8',
			maxBytes: 100,
			allowPrivateHosts: false,
		});
	});

	it('中止と解放を通す', () => {
		expect(parseAssemblyCommand({ kind: 'cancel-assembly', taskId: 't1' })).toEqual({
			kind: 'cancel-assembly',
			taskId: 't1',
		});
		expect(parseAssemblyCommand({ kind: 'release-object-url', objectUrl: 'blob:x' })).toEqual({
			kind: 'release-object-url',
			objectUrl: 'blob:x',
		});
	});

	it('プライベート宛の許可を明示されたときだけ真にする', () => {
		const parsed = parseAssemblyCommand({
			kind: 'assemble-hls',
			taskId: 't1',
			playlistUrl: 'https://cdn.example.com/index.m3u8',
			maxBytes: 100,
			allowPrivateHosts: true,
		});

		expect(parsed).toMatchObject({ allowPrivateHosts: true });
	});

	it('組み立て結果はオブジェクト URL に限る', () => {
		// そのまま chrome.downloads へ渡すため、信頼境界で形を確かめる
		expect(
			parseOffscreenMessage({
				kind: 'assembly-done',
				taskId: 't1',
				objectUrl: 'https://evil.example.com/x',
				bytes: 1,
			}),
		).toBeUndefined();
	});

	it('取得できないスキームのプレイリストは受け付けない', () => {
		expect(
			parseAssemblyCommand({
				kind: 'assemble-hls',
				taskId: 't1',
				playlistUrl: 'file:///etc/passwd',
				maxBytes: 100,
			}),
		).toBeUndefined();
	});

	it('形が合わないものは破棄する', () => {
		expect(parseAssemblyCommand(undefined)).toBeUndefined();
		expect(parseAssemblyCommand({ kind: 'assemble-hls', taskId: 't1' })).toBeUndefined();
		expect(
			parseAssemblyCommand({ kind: 'assemble-hls', taskId: 't1', playlistUrl: 'https://a' }),
		).toBeUndefined();
		expect(parseAssemblyCommand({ kind: 'cancel-assembly' })).toBeUndefined();
		expect(parseAssemblyCommand({ kind: 'release-object-url' })).toBeUndefined();
		expect(parseAssemblyCommand({ kind: 'unknown' })).toBeUndefined();
	});
});
