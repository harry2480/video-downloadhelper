import { err, ok, type Result } from '../../shared/utils';
import { getPathExtension, resolveUrl } from '../url';
import type {
	HlsAudioRendition,
	HlsByteRange,
	HlsEncryption,
	HlsInitSegment,
	HlsParseError,
	HlsPlaylistKind,
	HlsSegment,
	HlsSegmentFormat,
	HlsSegmentKey,
	HlsVariantStream,
	ParsedMasterPlaylist,
	ParsedMediaPlaylist,
} from './types';

/**
 * HLS プレイリストのパーサー（RFC 8216）。
 *
 * **副作用を持たない。** マニフェストの取得は行わず、取得済みの文字列を受け取る。
 * 再フェッチは MediaFetcherPort の実装が担い、Composition Root で注入する。
 */

/** DRM とみなす KEYFORMAT / METHOD（要件定義 6.4）。復号・回避は実装しない。 */
const DRM_KEYFORMAT_MARKERS = [
	'com.widevine',
	'com.microsoft.playready',
	'com.apple.streamingkeydelivery',
	'urn:uuid:edef8ba9', // Widevine System ID
	'urn:uuid:9a04f079', // PlayReady System ID
];

const FMP4_EXTENSIONS = new Set(['mp4', 'm4s', 'm4v', 'm4a', 'cmfv', 'cmfa', 'fmp4']);
const TS_EXTENSIONS = new Set(['ts', 'tsv', 'tsa', 'mts', 'm2ts']);

/**
 * HLS の属性リストを解析する。
 *
 * `KEY=VALUE,KEY="quoted,value"` 形式で、引用符の中にはカンマが入り得る。
 * 単純な split(',') では CODECS="avc1.64001f,mp4a.40.2" が壊れる。
 */
export function parseAttributeList(input: string): Record<string, string> {
	const attributes: Record<string, string> = {};
	let cursor = 0;

	while (cursor < input.length) {
		const equalsIndex = input.indexOf('=', cursor);
		if (equalsIndex === -1) break;

		const key = input.slice(cursor, equalsIndex).trim().toUpperCase();
		cursor = equalsIndex + 1;

		if (input[cursor] === '"') {
			const closingIndex = input.indexOf('"', cursor + 1);
			if (closingIndex === -1) {
				// 閉じ引用符がない壊れた属性。残り全部を値として拾って打ち切る
				attributes[key] = input.slice(cursor + 1);
				break;
			}
			attributes[key] = input.slice(cursor + 1, closingIndex);
			const commaIndex = input.indexOf(',', closingIndex + 1);
			cursor = commaIndex === -1 ? input.length : commaIndex + 1;
		} else {
			const commaIndex = input.indexOf(',', cursor);
			const end = commaIndex === -1 ? input.length : commaIndex;
			attributes[key] = input.slice(cursor, end).trim();
			cursor = commaIndex === -1 ? input.length : commaIndex + 1;
		}
	}

	return attributes;
}

/** `#EXT-X-BYTERANGE:<length>[@<offset>]` を解析する。 */
export function parseByteRange(
	value: string,
	previousEnd: number | undefined,
): HlsByteRange | undefined {
	const [lengthPart, offsetPart] = value.trim().split('@');

	const length = Number(lengthPart);
	if (!Number.isFinite(length) || length < 0) return undefined;

	if (offsetPart !== undefined) {
		const offset = Number(offsetPart);
		if (!Number.isFinite(offset) || offset < 0) return undefined;
		return { length, offset };
	}

	// オフセット省略時は「同一 URI の直前のセグメントの終端」から続く（RFC 8216 4.3.2.2）。
	// 直前がなければ範囲を決められないため未指定として扱う。
	if (previousEnd === undefined) return undefined;
	return { length, offset: previousEnd };
}

/** `1920x1080` 形式の RESOLUTION を解析する。 */
function parseResolution(value: string | undefined): { width: number; height: number } | undefined {
	if (!value) return undefined;
	const match = /^(\d+)x(\d+)$/i.exec(value.trim());
	if (!match) return undefined;

	const width = Number(match[1]);
	const height = Number(match[2]);
	if (!Number.isFinite(width) || !Number.isFinite(height)) return undefined;

	return { width, height };
}

function parseNumber(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number(value.trim());
	return Number.isFinite(parsed) ? parsed : undefined;
}

/** 有効な行だけを返す（空行を落とし、行末の CR を除去する）。 */
function toLines(content: string): string[] {
	return content
		.split('\n')
		.map((line) => line.replace(/\r$/, '').trim())
		.filter((line) => line.length > 0);
}

function isPlaylist(lines: string[]): boolean {
	return lines[0] === '#EXTM3U';
}

/**
 * Master Playlist か Media Playlist かを判定する。
 *
 * 再フェッチしたマニフェストがどちらか分からない状態で呼ばれるため、
 * 内容から判定する必要がある。
 */
export function detectPlaylistKind(content: string): HlsPlaylistKind | undefined {
	const lines = toLines(content);
	if (!isPlaylist(lines)) return undefined;

	for (const line of lines) {
		if (line.startsWith('#EXT-X-STREAM-INF')) return 'master';
		if (line.startsWith('#EXTINF')) return 'media';
	}

	// Variant も Segment もない。#EXT-X-MEDIA だけの Master もあり得る
	if (lines.some((line) => line.startsWith('#EXT-X-MEDIA'))) return 'master';

	return undefined;
}

function detectDrmFromAttributes(attributes: Record<string, string>): string | undefined {
	const method = attributes.METHOD?.toUpperCase();
	const keyFormat = attributes.KEYFORMAT?.toLowerCase() ?? '';

	if (DRM_KEYFORMAT_MARKERS.some((marker) => keyFormat.includes(marker))) {
		return `KEYFORMAT=${attributes.KEYFORMAT}`;
	}
	// SAMPLE-AES は FairPlay 等で使われる。標準的な再構成では復号できない
	if (method?.startsWith('SAMPLE-AES')) {
		return `METHOD=${method}`;
	}

	return undefined;
}

/**
 * Master Playlist を解析して Variant Stream 一覧を返す。
 *
 * baseUrl はマニフェスト自身の URL。相対 URL の解決に使う。
 */
export function parseMasterPlaylist(
	content: string,
	baseUrl: string,
): Result<ParsedMasterPlaylist, HlsParseError> {
	const lines = toLines(content);
	if (lines.length === 0) return err({ type: 'empty-playlist' });
	if (!isPlaylist(lines)) return err({ type: 'not-a-playlist' });

	const variants: HlsVariantStream[] = [];
	const audioRenditions: HlsAudioRendition[] = [];
	let drmReason: string | undefined;
	let pendingVariant: Record<string, string> | undefined;

	for (const line of lines) {
		if (line.startsWith('#EXT-X-STREAM-INF:')) {
			pendingVariant = parseAttributeList(line.slice('#EXT-X-STREAM-INF:'.length));
			continue;
		}

		if (line.startsWith('#EXT-X-MEDIA:')) {
			const attributes = parseAttributeList(line.slice('#EXT-X-MEDIA:'.length));
			if (attributes.TYPE?.toUpperCase() !== 'AUDIO') continue;

			const groupId = attributes['GROUP-ID'];
			const name = attributes.NAME;
			if (!groupId || !name) continue;

			let resolvedUri: string | undefined;
			if (attributes.URI) {
				const resolved = resolveUrl(attributes.URI, baseUrl);
				if (!resolved.ok) return err({ type: 'invalid-uri', input: attributes.URI });
				resolvedUri = resolved.value;
			}

			audioRenditions.push({
				groupId,
				name,
				...(attributes.LANGUAGE !== undefined && { language: attributes.LANGUAGE }),
				...(resolvedUri !== undefined && { uri: resolvedUri }),
				isDefault: attributes.DEFAULT?.toUpperCase() === 'YES',
				...(attributes.CHANNELS !== undefined && { channels: attributes.CHANNELS }),
			});
			continue;
		}

		if (line.startsWith('#EXT-X-SESSION-KEY:')) {
			const attributes = parseAttributeList(line.slice('#EXT-X-SESSION-KEY:'.length));
			drmReason ??= detectDrmFromAttributes(attributes);
			continue;
		}

		if (line.startsWith('#')) continue;

		// タグ以外の行は直前の #EXT-X-STREAM-INF に対応する URI
		if (!pendingVariant) continue;

		const resolved = resolveUrl(line, baseUrl);
		if (!resolved.ok) return err({ type: 'invalid-uri', input: line });

		// BANDWIDTH は必須属性。欠けている Variant は品質を比較できないため採用しない
		const bandwidth = parseNumber(pendingVariant.BANDWIDTH);
		if (bandwidth === undefined) {
			pendingVariant = undefined;
			continue;
		}

		const resolution = parseResolution(pendingVariant.RESOLUTION);
		const codecs = pendingVariant.CODECS?.split(',')
			.map((codec) => codec.trim())
			.filter((codec) => codec.length > 0);

		variants.push({
			uri: resolved.value,
			bandwidth,
			...(parseNumber(pendingVariant['AVERAGE-BANDWIDTH']) !== undefined && {
				averageBandwidth: parseNumber(pendingVariant['AVERAGE-BANDWIDTH']),
			}),
			...(resolution && { width: resolution.width, height: resolution.height }),
			...(codecs && codecs.length > 0 && { codecs }),
			...(parseNumber(pendingVariant['FRAME-RATE']) !== undefined && {
				frameRate: parseNumber(pendingVariant['FRAME-RATE']),
			}),
			...(pendingVariant.AUDIO !== undefined && { audioGroupId: pendingVariant.AUDIO }),
		});

		pendingVariant = undefined;
	}

	if (variants.length === 0) return err({ type: 'no-variants' });

	return ok({
		kind: 'master',
		variants,
		audioRenditions,
		...(drmReason !== undefined && { drmReason }),
	});
}

/** セグメント URL の拡張子と #EXT-X-MAP の有無から形式を判定する。 */
export function detectSegmentFormat(
	firstSegmentUri: string | undefined,
	hasInitSegment: boolean,
): HlsSegmentFormat {
	// #EXT-X-MAP があれば初期化セグメントを要する fMP4
	if (hasInitSegment) return 'fmp4';
	if (!firstSegmentUri) return 'unknown';

	const extension = getPathExtension(firstSegmentUri);
	if (!extension) return 'unknown';
	if (TS_EXTENSIONS.has(extension)) return 'ts';
	if (FMP4_EXTENSIONS.has(extension)) return 'fmp4';

	return 'unknown';
}

/**
 * Media Playlist を解析してセグメント一覧を返す。
 *
 * baseUrl はマニフェスト自身の URL。相対 URL の解決に使う。
 */
export function parseMediaPlaylist(
	content: string,
	baseUrl: string,
): Result<ParsedMediaPlaylist, HlsParseError> {
	const lines = toLines(content);
	if (lines.length === 0) return err({ type: 'empty-playlist' });
	if (!isPlaylist(lines)) return err({ type: 'not-a-playlist' });

	const segments: HlsSegment[] = [];
	let targetDuration: number | undefined;
	let hasEndList = false;
	let isVodPlaylistType = false;
	let mediaSequence = 0;

	/**
	 * 直近の #EXT-X-MAP。以降のセグメントへ適用される。
	 * 切り替わらない限り同じオブジェクトを共有する（計画側が同一性で判定する）。
	 */
	let currentInit: HlsInitSegment | undefined;

	/**
	 * 直近の #EXT-X-KEY。以降のセグメントへ適用される。
	 * METHOD=NONE で解除されるため、undefined へ戻ることもある。
	 */
	let currentKey: HlsSegmentKey | undefined;
	/** DRM を 1 度でも見たか。要約の判定に使う */
	let drmReason: string | undefined;
	/** AES-128 を 1 度でも見たか。要約の判定に使う */
	let sawAes = false;

	let pendingDuration: number | undefined;
	/**
	 * #EXT-X-BYTERANGE の生の値。この時点では対応する URI が未確定なため、
	 * オフセット省略形を解決できない。URI 行を読んだ時点で解決する。
	 */
	let pendingByteRangeValue: string | undefined;
	/** 同一 URI で BYTERANGE のオフセットが省略された場合に使う直前の終端 */
	const previousEndByUri = new Map<string, number>();

	for (const line of lines) {
		if (line.startsWith('#EXTINF:')) {
			// `#EXTINF:<duration>,[<title>]`
			const [durationPart] = line.slice('#EXTINF:'.length).split(',');
			pendingDuration = parseNumber(durationPart) ?? 0;
			continue;
		}

		if (line.startsWith('#EXT-X-BYTERANGE:')) {
			pendingByteRangeValue = line.slice('#EXT-X-BYTERANGE:'.length);
			continue;
		}

		if (line.startsWith('#EXT-X-TARGETDURATION:')) {
			targetDuration = parseNumber(line.slice('#EXT-X-TARGETDURATION:'.length));
			continue;
		}

		if (line === '#EXT-X-ENDLIST') {
			hasEndList = true;
			continue;
		}

		if (line.startsWith('#EXT-X-PLAYLIST-TYPE:')) {
			isVodPlaylistType = line.slice('#EXT-X-PLAYLIST-TYPE:'.length).trim().toUpperCase() === 'VOD';
			continue;
		}

		if (line.startsWith('#EXT-X-KEY:')) {
			const attributes = parseAttributeList(line.slice('#EXT-X-KEY:'.length));
			const drm = detectDrmFromAttributes(attributes);
			if (drm) {
				drmReason ??= drm;
				// 復号しない方式。以降のセグメントは平文ではないので鍵を立てておく
				currentKey = {};
				continue;
			}

			// **METHOD の欠落を NONE と同一視しない。** METHOD は必須属性
			// （RFC 8216 4.3.2.4）で、欠けているのは壊れたプレイリスト。
			// 平文として扱うと、暗号文をそのまま連結して保存してしまう
			const method = attributes.METHOD?.toUpperCase();
			if (method === 'NONE') {
				currentKey = undefined;
				continue;
			}

			sawAes = true;

			// KEYFORMAT の既定は identity（URI が 16 バイトの鍵そのもの）。
			// 別形式の鍵サーバーへ Cookie 付きで取りに行っても復号できない
			const keyFormat = attributes.KEYFORMAT?.toLowerCase();
			if (keyFormat !== undefined && keyFormat !== 'identity') {
				currentKey = {};
				continue;
			}

			if (method === 'AES-128' && attributes.URI !== undefined) {
				const resolved = resolveUrl(attributes.URI, baseUrl);
				if (!resolved.ok) return err({ type: 'invalid-uri', input: attributes.URI });
				currentKey = {
					keyUri: resolved.value,
					...(attributes.IV !== undefined && { iv: attributes.IV }),
				};
				continue;
			}

			// URI が欠けている、または未知の METHOD。復号できない以上は
			// 暗号化として扱う。鍵なしで通すと暗号文をそのまま保存してしまう
			currentKey = {};
			continue;
		}

		if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
			mediaSequence = parseNumber(line.slice('#EXT-X-MEDIA-SEQUENCE:'.length)) ?? 0;
			continue;
		}

		if (line.startsWith('#EXT-X-MAP:')) {
			const attributes = parseAttributeList(line.slice('#EXT-X-MAP:'.length));
			if (!attributes.URI) continue;

			const resolved = resolveUrl(attributes.URI, baseUrl);
			if (!resolved.ok) return err({ type: 'invalid-uri', input: attributes.URI });

			let range: HlsByteRange | undefined;
			if (attributes.BYTERANGE !== undefined) {
				range = parseByteRange(attributes.BYTERANGE, 0);
				// 範囲なしへ落とすと、初期化セグメントとしてファイル全体を取得する
				if (range === undefined) {
					return err({ type: 'invalid-byterange', input: attributes.BYTERANGE });
				}
				// オフセット省略形は「同一 URI の直前の終端」から続く。
				// 初期化セグメントも同じファイルを共有しうる
				previousEndByUri.set(resolved.value, range.offset + range.length);
			}

			currentInit = {
				uri: resolved.value,
				...(range && { byteRange: range }),
				// RFC 8216 は初期化セグメントにも直前の #EXT-X-KEY を適用する
				...(currentKey && { key: currentKey }),
			};
			continue;
		}

		if (line.startsWith('#')) continue;

		// タグ以外の行はセグメント URI
		const resolved = resolveUrl(line, baseUrl);
		if (!resolved.ok) return err({ type: 'invalid-uri', input: line });

		// オフセット省略形は「同一 URI の直前のセグメントの終端」から続く
		let byteRange: HlsByteRange | undefined;
		if (pendingByteRangeValue !== undefined) {
			byteRange = parseByteRange(pendingByteRangeValue, previousEndByUri.get(resolved.value));

			// **範囲なしへ落とさない。** 落とすと計画も取得も「範囲指定なし」
			// としか見えず、エラーにならないままファイル全体を取得して連結する
			if (byteRange === undefined) {
				return err({ type: 'invalid-byterange', input: pendingByteRangeValue });
			}

			previousEndByUri.set(resolved.value, byteRange.offset + byteRange.length);
		}

		segments.push({
			uri: resolved.value,
			duration: pendingDuration ?? 0,
			...(byteRange && { byteRange }),
			// 番号はループ後にまとめて割り当てる（#EXT-X-MEDIA-SEQUENCE が
			// 先頭セグメントより後ろにあっても揃うようにするため）
			sequenceNumber: 0,
			...(currentKey && { key: currentKey }),
			...(currentInit && { initSegment: currentInit }),
		});

		pendingDuration = undefined;
		pendingByteRangeValue = undefined;
	}

	if (segments.length === 0) return err({ type: 'no-segments' });

	// IV 省略時の導出に使う。ずれると復号は通るのに中身が壊れる
	for (const [index, segment] of segments.entries()) {
		segment.sequenceNumber = mediaSequence + index;
	}

	const totalDuration = segments.reduce((sum, segment) => sum + segment.duration, 0);

	// **1 つでも該当すればその方式として扱う。** 途中から暗号化される
	// プレイリストを平文扱いすると、暗号文をそのまま保存してしまう
	const encryption: HlsEncryption =
		drmReason !== undefined
			? { method: 'drm', reason: drmReason }
			: sawAes
				? { method: 'aes-128' }
				: { method: 'none' };

	return ok({
		kind: 'media',
		segments,
		...(targetDuration !== undefined && { targetDuration }),
		totalDuration,
		isLive: !hasEndList && !isVodPlaylistType,
		segmentFormat: detectSegmentFormat(
			segments[0]?.uri,
			segments.some((segment) => segment.initSegment !== undefined),
		),
		mediaSequence,
		encryption,
	});
}
