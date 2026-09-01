import { err, ok, type Result } from '../../shared/utils';

/**
 * MPD を読むための最小の XML パーサー。
 *
 * **`DOMParser` を使わない。** Manifest V3 の Service Worker に `DOMParser` は
 * 存在せず、コアロジック層は DOM に触れない決まりでもある（アーキテクチャ.md）。
 *
 * **外部実体を一切扱わない。** DTD・`<!ENTITY>` は解釈せず、`<!DOCTYPE` が
 * 現れた時点で失敗させる。マニフェストの中身はページ側が決められるため、
 * 実体参照を展開する実装は XXE と実体膨張（billion laughs）の的になる。
 * 展開するのは XML の定義済み実体 5 種と数値文字参照だけにする。
 *
 * 名前空間は接頭辞を落としてローカル名だけを見る。MPD の要素名は
 * ローカル名で一意で、接頭辞は配信側の裁量で変わるため。
 */

export type XmlElement = {
	/** 名前空間接頭辞を除いたローカル名 */
	name: string;
	attributes: Record<string, string>;
	children: XmlElement[];
	/** 直下のテキスト（子要素のテキストは含まない）。BaseURL などで使う */
	text: string;
};

/** 解析できなかった理由。parseXml の呼び出し側でのみ使う */
type XmlParseError =
	| { type: 'not-xml' }
	/** DTD・外部実体は扱わない */
	| { type: 'doctype-not-allowed' }
	| { type: 'malformed'; at: number }
	/** 入れ子が深すぎる。ページ由来の入力に対する保険 */
	| { type: 'too-deep' };

/**
 * 入れ子の深さの上限。
 *
 * MPD の実際の深さは 6 段程度（MPD > Period > AdaptationSet >
 * Representation > SegmentTemplate > SegmentTimeline > S）。
 * 上限がないと、深い入れ子だけでスタックを消費させられる。
 */
const MAX_DEPTH = 64;

/** 要素数の上限。1 つの MPD に載る Representation は多くても数十。 */
const MAX_ELEMENTS = 100_000;

const PREDEFINED_ENTITIES: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
};

/**
 * 定義済み実体と数値文字参照だけを展開する。
 *
 * 知らない実体はそのまま残す。**独自実体を解決しない**ことが要点で、
 * ここで外部を引きに行く実装にすると XXE になる。
 */
function decodeEntities(input: string): string {
	if (!input.includes('&')) return input;

	return input.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body: string) => {
		if (body.startsWith('#')) {
			const isHex = body[1] === 'x' || body[1] === 'X';
			const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
			// 範囲を確かめてから作る。範囲外は展開せずそのまま残す
			if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
			return String.fromCodePoint(code);
		}

		return PREDEFINED_ENTITIES[body.toLowerCase()] ?? match;
	});
}

/** 名前空間接頭辞を落とす。`mpd:Period` → `Period`。 */
function localName(name: string): string {
	const colonIndex = name.indexOf(':');
	return colonIndex === -1 ? name : name.slice(colonIndex + 1);
}

type Cursor = { input: string; index: number };

function skipWhitespace(cursor: Cursor): void {
	while (cursor.index < cursor.input.length && /\s/.test(cursor.input[cursor.index] as string)) {
		cursor.index += 1;
	}
}

/** 開始タグの中の属性を読む。 */
function parseAttributes(cursor: Cursor): Record<string, string> | undefined {
	const attributes: Record<string, string> = {};

	for (;;) {
		skipWhitespace(cursor);
		const char = cursor.input[cursor.index];
		if (char === undefined) return undefined;
		if (char === '>' || char === '/') return attributes;

		const nameEnd = cursor.input.slice(cursor.index).search(/[\s=/>]/);
		if (nameEnd <= 0) return undefined;

		const name = cursor.input.slice(cursor.index, cursor.index + nameEnd);
		cursor.index += nameEnd;

		skipWhitespace(cursor);
		if (cursor.input[cursor.index] !== '=') {
			// 値のない属性。XML としては不正だが、読み飛ばして続ける
			attributes[localName(name)] = '';
			continue;
		}
		cursor.index += 1;

		skipWhitespace(cursor);
		const quote = cursor.input[cursor.index];
		if (quote !== '"' && quote !== "'") return undefined;
		cursor.index += 1;

		const closing = cursor.input.indexOf(quote, cursor.index);
		if (closing === -1) return undefined;

		attributes[localName(name)] = decodeEntities(cursor.input.slice(cursor.index, closing));
		cursor.index = closing + 1;
	}
}

/**
 * `<!-- -->` `<![CDATA[ ]]>` `<? ?>` を読み飛ばす。
 *
 * CDATA の中身はテキストとして扱う。返り値はテキストとして採用する文字列。
 */
function skipSpecial(cursor: Cursor): { skipped: true; text: string } | { skipped: false } {
	const rest = cursor.input.slice(cursor.index);

	if (rest.startsWith('<!--')) {
		const end = cursor.input.indexOf('-->', cursor.index + 4);
		cursor.index = end === -1 ? cursor.input.length : end + 3;
		return { skipped: true, text: '' };
	}

	if (rest.startsWith('<![CDATA[')) {
		const end = cursor.input.indexOf(']]>', cursor.index + 9);
		const stop = end === -1 ? cursor.input.length : end;
		const text = cursor.input.slice(cursor.index + 9, stop);
		cursor.index = end === -1 ? cursor.input.length : end + 3;
		return { skipped: true, text };
	}

	if (rest.startsWith('<?')) {
		const end = cursor.input.indexOf('?>', cursor.index + 2);
		cursor.index = end === -1 ? cursor.input.length : end + 2;
		return { skipped: true, text: '' };
	}

	return { skipped: false };
}

/**
 * XML を要素の木へ変換する。
 *
 * 検証は行わない。MPD として妥当かは `parser.ts` が判断する。
 */
export function parseXml(input: string): Result<XmlElement, XmlParseError> {
	// **DTD は受け取らない。** 外部実体・実体膨張の入口を閉じる
	if (/<!DOCTYPE/i.test(input)) return err({ type: 'doctype-not-allowed' });

	const cursor: Cursor = { input, index: 0 };
	const stack: XmlElement[] = [];
	let root: XmlElement | undefined;
	let elements = 0;

	for (;;) {
		const next = cursor.input.indexOf('<', cursor.index);
		if (next === -1) break;

		// タグの前のテキストは、いま開いている要素のものにする
		const text = decodeEntities(cursor.input.slice(cursor.index, next)).trim();
		const open = stack.at(-1);
		if (text.length > 0 && open !== undefined) open.text += text;

		cursor.index = next;

		const special = skipSpecial(cursor);
		if (special.skipped) {
			if (special.text.length > 0 && open !== undefined) open.text += special.text;
			continue;
		}

		cursor.index += 1;

		// 終了タグ
		if (cursor.input[cursor.index] === '/') {
			cursor.index += 1;
			const end = cursor.input.indexOf('>', cursor.index);
			if (end === -1) return err({ type: 'malformed', at: cursor.index });

			const name = localName(cursor.input.slice(cursor.index, end).trim());
			cursor.index = end + 1;

			const closing = stack.pop();
			// 対応しない終了タグ。木の形が決まらないため打ち切る
			if (closing === undefined || closing.name !== name) {
				return err({ type: 'malformed', at: cursor.index });
			}
			continue;
		}

		const nameEnd = cursor.input.slice(cursor.index).search(/[\s/>]/);
		if (nameEnd <= 0) return err({ type: 'malformed', at: cursor.index });

		const name = localName(cursor.input.slice(cursor.index, cursor.index + nameEnd));
		cursor.index += nameEnd;

		const attributes = parseAttributes(cursor);
		if (attributes === undefined) return err({ type: 'malformed', at: cursor.index });

		const selfClosing = cursor.input[cursor.index] === '/';
		if (selfClosing) cursor.index += 1;
		if (cursor.input[cursor.index] !== '>') return err({ type: 'malformed', at: cursor.index });
		cursor.index += 1;

		elements += 1;
		if (elements > MAX_ELEMENTS) return err({ type: 'too-deep' });

		const element: XmlElement = { name, attributes, children: [], text: '' };

		if (open === undefined) {
			// ルートは 1 つだけ。2 つ目以降は無視して読み進める
			if (root === undefined) root = element;
		} else {
			open.children.push(element);
		}

		if (!selfClosing) {
			if (stack.length >= MAX_DEPTH) return err({ type: 'too-deep' });
			stack.push(element);
		}
	}

	if (root === undefined) return err({ type: 'not-xml' });
	// 閉じられていない要素が残っている
	if (stack.length > 0) return err({ type: 'malformed', at: cursor.index });

	return ok(root);
}

/** 直下の子から、名前が一致するものをすべて返す。 */
export function childrenNamed(element: XmlElement, name: string): XmlElement[] {
	return element.children.filter((child) => child.name === name);
}

/** 直下の子から、名前が一致する最初のものを返す。 */
export function childNamed(element: XmlElement, name: string): XmlElement | undefined {
	return element.children.find((child) => child.name === name);
}
