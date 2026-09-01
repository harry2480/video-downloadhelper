import { describe, expect, it } from 'vitest';
import { childNamed, childrenNamed, parseXml } from './xml';

/**
 * マニフェストの中身はページ側が決められる。**壊れた入力で例外を出さず、
 * 外部実体を一切引かない**ことが最も重要な性質。
 */

function unwrap(result: ReturnType<typeof parseXml>) {
	if (!result.ok) throw new Error(`parse failed: ${JSON.stringify(result.error)}`);
	return result.value;
}

describe('parseXml', () => {
	it('要素と属性を読む', () => {
		const root = unwrap(parseXml('<MPD type="static" minBufferTime="PT2S"></MPD>'));

		expect(root.name).toBe('MPD');
		expect(root.attributes).toEqual({ type: 'static', minBufferTime: 'PT2S' });
	});

	it('入れ子を木にする', () => {
		const root = unwrap(
			parseXml('<MPD><Period id="p0"><AdaptationSet /></Period><Period id="p1" /></MPD>'),
		);

		expect(root.children).toHaveLength(2);
		expect(root.children[0]?.attributes.id).toBe('p0');
		expect(root.children[0]?.children[0]?.name).toBe('AdaptationSet');
	});

	it('自己終了タグを読む', () => {
		const root = unwrap(parseXml('<MPD><SegmentTemplate media="$Number$.m4s"/></MPD>'));

		expect(root.children[0]?.name).toBe('SegmentTemplate');
		expect(root.children[0]?.children).toEqual([]);
	});

	it('テキストを直下の要素へ結び付ける', () => {
		const root = unwrap(parseXml('<MPD><BaseURL>https://cdn.example.com/</BaseURL></MPD>'));

		expect(childNamed(root, 'BaseURL')?.text).toBe('https://cdn.example.com/');
		// 子のテキストは親へ混ざらない
		expect(root.text).toBe('');
	});

	it('名前空間の接頭辞を落とす', () => {
		// 接頭辞は配信側の裁量で変わる。ローカル名で一意に決まる
		const root = unwrap(parseXml('<mpd:MPD xmlns:mpd="urn:x"><mpd:Period /></mpd:MPD>'));

		expect(root.name).toBe('MPD');
		expect(root.children[0]?.name).toBe('Period');
	});

	it('XML 宣言とコメントを読み飛ばす', () => {
		const root = unwrap(parseXml('<?xml version="1.0"?><!-- note --><MPD><!-- x --></MPD>'));

		expect(root.name).toBe('MPD');
		expect(root.children).toEqual([]);
	});

	it('CDATA をテキストとして扱う', () => {
		const root = unwrap(parseXml('<MPD><BaseURL><![CDATA[https://a/?x=1&y=2]]></BaseURL></MPD>'));

		expect(childNamed(root, 'BaseURL')?.text).toBe('https://a/?x=1&y=2');
	});

	it('定義済み実体と数値文字参照を展開する', () => {
		const root = unwrap(parseXml('<MPD a="x&amp;y"><BaseURL>&lt;&#65;&#x42;&gt;</BaseURL></MPD>'));

		expect(root.attributes.a).toBe('x&y');
		expect(childNamed(root, 'BaseURL')?.text).toBe('<AB>');
	});

	it('知らない実体はそのまま残す', () => {
		// **独自実体を解決しない。** 引きに行く実装にすると XXE になる
		const root = unwrap(parseXml('<MPD><BaseURL>&payload;</BaseURL></MPD>'));

		expect(childNamed(root, 'BaseURL')?.text).toBe('&payload;');
	});

	it('DOCTYPE を受け取らない', () => {
		// 外部実体・実体膨張（billion laughs）の入口を閉じる
		const xml = '<!DOCTYPE MPD [<!ENTITY x "boom">]><MPD><BaseURL>&x;</BaseURL></MPD>';

		expect(parseXml(xml)).toEqual({ ok: false, error: { type: 'doctype-not-allowed' } });
	});

	it('単一引用符の属性値を読む', () => {
		expect(unwrap(parseXml("<MPD type='dynamic' />")).attributes.type).toBe('dynamic');
	});

	it('値のない属性でも読み進める', () => {
		const root = unwrap(parseXml('<MPD broken type="static" />'));

		expect(root.attributes).toEqual({ broken: '', type: 'static' });
	});

	describe('異常系', () => {
		it('タグが無ければ not-xml', () => {
			expect(parseXml('plain text')).toEqual({ ok: false, error: { type: 'not-xml' } });
			expect(parseXml('')).toEqual({ ok: false, error: { type: 'not-xml' } });
		});

		it('閉じられていない要素は malformed', () => {
			expect(parseXml('<MPD><Period></MPD>').ok).toBe(false);
			expect(parseXml('<MPD>').ok).toBe(false);
		});

		it('対応しない終了タグは malformed', () => {
			expect(parseXml('<MPD></Period>').ok).toBe(false);
		});

		it('閉じられていない属性値は malformed', () => {
			expect(parseXml('<MPD type="static><Period /></MPD>').ok).toBe(false);
		});

		it('入れ子が深すぎれば too-deep', () => {
			// 深い入れ子だけでスタックを消費させない
			const deep = `${'<a>'.repeat(200)}${'</a>'.repeat(200)}`;

			expect(parseXml(deep)).toEqual({ ok: false, error: { type: 'too-deep' } });
		});

		it('要素が多すぎれば too-deep', () => {
			const many = `<MPD>${'<S />'.repeat(100_001)}</MPD>`;

			expect(parseXml(many)).toEqual({ ok: false, error: { type: 'too-deep' } });
		});

		it('閉じられていないコメントでも例外を出さない', () => {
			expect(parseXml('<MPD><!-- unterminated').ok).toBe(false);
		});

		it('閉じられていない CDATA でも例外を出さない', () => {
			expect(parseXml('<MPD><BaseURL><![CDATA[abc').ok).toBe(false);
		});

		it('開始タグが閉じられないまま終わっても例外を出さない', () => {
			expect(parseXml('<MPD type="static"').ok).toBe(false);
			expect(parseXml('<MPD ').ok).toBe(false);
			expect(parseXml('<MPD').ok).toBe(false);
		});

		it('タグ名が無ければ malformed', () => {
			expect(parseXml('<MPD>< >x</MPD>').ok).toBe(false);
			expect(parseXml('</>').ok).toBe(false);
		});

		it('属性名が無ければ malformed', () => {
			expect(parseXml('<MPD ="x" />').ok).toBe(false);
		});

		it('引用符で囲まれていない属性値は malformed', () => {
			expect(parseXml('<MPD type=static />').ok).toBe(false);
		});

		it('閉じられていない終了タグは malformed', () => {
			expect(parseXml('<MPD></MPD').ok).toBe(false);
		});

		it('自己終了の直後が > でなければ malformed', () => {
			expect(parseXml('<MPD /x>').ok).toBe(false);
		});

		it('閉じられていない XML 宣言でも例外を出さない', () => {
			expect(parseXml('<?xml version="1.0"').ok).toBe(false);
		});

		it('ルートが 2 つあれば最初だけを採る', () => {
			expect(unwrap(parseXml('<MPD /><Other />')).name).toBe('MPD');
		});

		it('壊れた数値文字参照はそのまま残す', () => {
			const root = unwrap(parseXml('<MPD><BaseURL>&#x110000;&#zz;</BaseURL></MPD>'));

			expect(childNamed(root, 'BaseURL')?.text).toBe('&#x110000;&#zz;');
		});
	});
});

describe('childrenNamed / childNamed', () => {
	const root = unwrap(parseXml('<MPD><Period id="a" /><Period id="b" /><Other /></MPD>'));

	it('名前が一致する子をすべて返す', () => {
		expect(childrenNamed(root, 'Period').map((child) => child.attributes.id)).toEqual(['a', 'b']);
	});

	it('名前が一致する最初の子を返す', () => {
		expect(childNamed(root, 'Period')?.attributes.id).toBe('a');
	});

	it('無ければ空・undefined を返す', () => {
		expect(childrenNamed(root, 'Missing')).toEqual([]);
		expect(childNamed(root, 'Missing')).toBeUndefined();
	});
});
