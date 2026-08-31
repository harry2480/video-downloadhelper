import { type Result, err, ok } from '../../shared/utils';
import { resolveUrl } from '../url';
import type {
	DashAdaptationSet,
	DashContentType,
	DashRepresentation,
	DashSegment,
	MpdParseError,
	ParsedMpd,
} from './types';
import { type XmlElement, childNamed, childrenNamed, parseXml } from './xml';

/**
 * MPD のパーサー（ISO/IEC 23009-1）。
 *
 * **副作用を持たない。** マニフェストの取得は行わず、取得済みの文字列を受け取る。
 *
 * 対応するセグメント指定は SegmentTemplate（$Number$ / $Time$）・SegmentList・
 * SegmentBase の 3 つ。いずれも「初期化セグメント + メディアセグメントの並び」
 * へ落とし込み、HLS の fMP4 と同じ経路で保存できる形にする。
 */

/**
 * 1 つの Representation が持てるセグメント数の上限。
 *
 * MPD の中身はページ側が決められる。SegmentTemplate は
 * `duration` と全体長から本数が決まるため、値によっては無限に近い数になる。
 */
const MAX_SEGMENTS_PER_REPRESENTATION = 20_000;

/** DRM を示す ContentProtection の schemeIdUri。 */
const DRM_SCHEMES: { pattern: RegExp; label: string }[] = [
	{ pattern: /edef8ba9-79d6-4ace-a3c8-27dcd51d21ed/i, label: 'Widevine' },
	{ pattern: /9a04f079-9840-4286-ab92-e65be0885f95/i, label: 'PlayReady' },
	{ pattern: /94ce86fb-07ff-4f43-adb8-93d2fa968ca2/i, label: 'FairPlay' },
	{ pattern: /urn:mpeg:dash:mp4protection/i, label: 'MP4 Protection' },
];

function parseNumber(value: string | undefined): number | undefined {
	if (value === undefined || value.trim() === '') return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * ISO 8601 の期間を秒へ直す（`PT1H2M3.5S`）。
 *
 * MPD が使うのは日付部分を含まない形がほとんどだが、`P1DT2H` のような
 * 表記も妥当なので日・月・年も読む。月と年は日数が一定でないため、
 * 30 日・365 日として扱う（表示と推定にしか使わない）。
 */
export function parseIso8601Duration(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;

	const match =
		/^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(
			value.trim(),
		);
	if (match === null) return undefined;

	const [, years, months, days, hours, minutes, seconds] = match;
	// すべて省略された `P` / `PT` は期間として意味を成さない
	if ([years, months, days, hours, minutes, seconds].every((part) => part === undefined)) {
		return undefined;
	}

	return (
		Number(years ?? 0) * 365 * 86_400 +
		Number(months ?? 0) * 30 * 86_400 +
		Number(days ?? 0) * 86_400 +
		Number(hours ?? 0) * 3_600 +
		Number(minutes ?? 0) * 60 +
		Number(seconds ?? 0)
	);
}

/** `30/1` 形式にも対応した frameRate の解析。 */
function parseFrameRate(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;

	const [numerator, denominator] = value.split('/');
	const top = parseNumber(numerator);
	if (top === undefined) return undefined;
	if (denominator === undefined) return top;

	const bottom = parseNumber(denominator);
	if (bottom === undefined || bottom === 0) return undefined;
	return top / bottom;
}

/**
 * `$Number$` 等のテンプレート変数を埋める（ISO/IEC 23009-1 5.3.9.4.4）。
 *
 * `$$` は `$` そのもの。`%0Nd` のような書式指定にも従う。
 */
export function fillTemplate(
	template: string,
	values: { RepresentationID?: string; Number?: number; Time?: number; Bandwidth?: number },
): string {
	// `$$` は 2 文字でドル記号そのもの。変数の形（`$Name$`）より先に見る
	return template.replace(/\$\$|\$([A-Za-z]+(?:%0\d+d)?)\$/g, (match, body: string | undefined) => {
		if (body === undefined) return '$';

		const [name, format] = body.split('%0');
		const raw = values[name as keyof typeof values];
		if (raw === undefined) return match;

		const text = String(raw);
		// 幅は正規表現で数字に限っているので、ここでの解析は必ず成功する
		return format === undefined ? text : text.padStart(Number.parseInt(format, 10), '0');
	});
}

/** `<start>-<end>`（両端を含む）を offset/length へ直す。 */
function parseRangeAttribute(value: string | undefined): DashSegment['byteRange'] | undefined {
	if (value === undefined) return undefined;

	const match = /^(\d+)-(\d+)$/.exec(value.trim());
	if (match === null) return undefined;

	const start = Number(match[1]);
	const end = Number(match[2]);
	if (end < start) return undefined;

	return { offset: start, length: end - start + 1 };
}

/**
 * BaseURL を積み上げて基準 URL を決める。
 *
 * MPD / Period / AdaptationSet / Representation の各段に置ける。
 * 内側が絶対 URL なら外側を上書きする（URL の解決規則そのもの）。
 */
function resolveBase(element: XmlElement, parentBase: string): Result<string, MpdParseError> {
	const base = childNamed(element, 'BaseURL')?.text.trim();
	if (base === undefined || base === '') return ok(parentBase);

	const resolved = resolveUrl(base, parentBase);
	if (!resolved.ok) return err({ type: 'invalid-uri', input: base });
	return ok(resolved.value);
}

function toContentType(value: string | undefined, mimeType: string | undefined): DashContentType {
	const source = (value ?? mimeType ?? '').toLowerCase();
	if (source.includes('video')) return 'video';
	if (source.includes('audio')) return 'audio';
	if (source.includes('text') || source.includes('ttml') || source.includes('vtt')) return 'text';
	return 'unknown';
}

function detectDrm(element: XmlElement): string | undefined {
	for (const protection of childrenNamed(element, 'ContentProtection')) {
		const scheme = protection.attributes.schemeIdUri ?? '';
		const matched = DRM_SCHEMES.find((entry) => entry.pattern.test(scheme));
		if (matched !== undefined) return matched.label;
	}
	return undefined;
}

/** SegmentTimeline の `<S t d r>` を展開して開始時刻の並びにする。 */
function expandTimeline(timeline: XmlElement): number[] | undefined {
	const times: number[] = [];
	let current = 0;

	for (const entry of childrenNamed(timeline, 'S')) {
		const start = parseNumber(entry.attributes.t);
		const duration = parseNumber(entry.attributes.d);
		if (duration === undefined || duration <= 0) return undefined;

		if (start !== undefined) current = start;

		// r は「追加の繰り返し回数」。負値は「Period の終わりまで」を意味するが、
		// 本数が決まらないため扱わない
		const repeat = parseNumber(entry.attributes.r) ?? 0;
		if (repeat < 0) return undefined;

		for (let index = 0; index <= repeat; index += 1) {
			times.push(current);
			current += duration;
			if (times.length > MAX_SEGMENTS_PER_REPRESENTATION) return undefined;
		}
	}

	return times;
}

type SegmentSource = {
	initSegment?: DashSegment;
	segments: DashSegment[];
};

/** SegmentTemplate からセグメントの並びを組み立てる。 */
function fromSegmentTemplate(
	template: XmlElement,
	base: string,
	representationId: string,
	bandwidth: number | undefined,
	periodDuration: number | undefined,
): Result<SegmentSource, MpdParseError> {
	const values = {
		RepresentationID: representationId,
		...(bandwidth !== undefined && { Bandwidth: bandwidth }),
	};

	let initSegment: DashSegment | undefined;
	const initialization = template.attributes.initialization;
	if (initialization !== undefined) {
		const resolved = resolveUrl(fillTemplate(initialization, values), base);
		if (!resolved.ok) return err({ type: 'invalid-uri', input: initialization });
		initSegment = { uri: resolved.value };
	}

	const media = template.attributes.media;
	if (media === undefined) return ok({ ...(initSegment && { initSegment }), segments: [] });

	const startNumber = parseNumber(template.attributes.startNumber) ?? 1;
	const timescale = parseNumber(template.attributes.timescale) ?? 1;
	const segments: DashSegment[] = [];

	const timelineElement = childNamed(template, 'SegmentTimeline');
	if (timelineElement !== undefined) {
		const times = expandTimeline(timelineElement);
		if (times === undefined) return err({ type: 'too-many-segments' });

		for (const [index, time] of times.entries()) {
			const resolved = resolveUrl(
				fillTemplate(media, { ...values, Number: startNumber + index, Time: time }),
				base,
			);
			if (!resolved.ok) return err({ type: 'invalid-uri', input: media });
			segments.push({ uri: resolved.value });
		}

		return ok({ ...(initSegment && { initSegment }), segments });
	}

	// SegmentTimeline が無ければ duration から本数を割り出す
	const duration = parseNumber(template.attributes.duration);
	if (duration === undefined || duration <= 0 || periodDuration === undefined) {
		return ok({ ...(initSegment && { initSegment }), segments: [] });
	}

	// duration は正、periodDuration は有限と確かめてあるので count は有限
	const count = Math.ceil(periodDuration / (duration / timescale));
	if (count <= 0) return ok({ ...(initSegment && { initSegment }), segments: [] });
	if (count > MAX_SEGMENTS_PER_REPRESENTATION) return err({ type: 'too-many-segments' });

	for (let index = 0; index < count; index += 1) {
		const resolved = resolveUrl(
			fillTemplate(media, { ...values, Number: startNumber + index, Time: index * duration }),
			base,
		);
		if (!resolved.ok) return err({ type: 'invalid-uri', input: media });
		segments.push({ uri: resolved.value });
	}

	return ok({ ...(initSegment && { initSegment }), segments });
}

/** SegmentList からセグメントの並びを組み立てる。 */
function fromSegmentList(list: XmlElement, base: string): Result<SegmentSource, MpdParseError> {
	let initSegment: DashSegment | undefined;

	const initialization = childNamed(list, 'Initialization');
	const initSource = initialization?.attributes.sourceURL;
	if (initialization !== undefined) {
		// sourceURL が無ければ BaseURL 自体を範囲付きで指す
		const target = initSource ?? '';
		const resolved = resolveUrl(target, base);
		if (!resolved.ok) return err({ type: 'invalid-uri', input: target });

		const range = parseRangeAttribute(initialization.attributes.range);
		initSegment = { uri: resolved.value, ...(range && { byteRange: range }) };
	}

	const entries = childrenNamed(list, 'SegmentURL');
	if (entries.length > MAX_SEGMENTS_PER_REPRESENTATION) {
		return err({ type: 'too-many-segments' });
	}

	const segments: DashSegment[] = [];
	for (const entry of entries) {
		const target = entry.attributes.media ?? '';
		const resolved = resolveUrl(target, base);
		if (!resolved.ok) return err({ type: 'invalid-uri', input: target });

		const range = parseRangeAttribute(entry.attributes.mediaRange);
		segments.push({ uri: resolved.value, ...(range && { byteRange: range }) });
	}

	return ok({ ...(initSegment && { initSegment }), segments });
}

/**
 * SegmentBase の場合の並び。
 *
 * 初期化部分も本体も同じ 1 ファイルに入っており、`Initialization@range` は
 * その中の位置を示すだけ。**全体を 1 本として取れば完成する**ので、
 * 範囲で切り出さない（切り出すと sidx の解釈まで必要になる）。
 */
function fromSegmentBase(base: string): SegmentSource {
	return { segments: [{ uri: base }] };
}

function parseRepresentation(
	element: XmlElement,
	parentBase: string,
	inherited: { template?: XmlElement; list?: XmlElement; segmentBase?: XmlElement },
	periodDuration: number | undefined,
): Result<DashRepresentation, MpdParseError> {
	const base = resolveBase(element, parentBase);
	if (!base.ok) return base;

	const id = element.attributes.id ?? '';
	const bandwidth = parseNumber(element.attributes.bandwidth);

	const template = childNamed(element, 'SegmentTemplate') ?? inherited.template;
	const list = childNamed(element, 'SegmentList') ?? inherited.list;
	const segmentBase = childNamed(element, 'SegmentBase') ?? inherited.segmentBase;

	let source: SegmentSource;
	if (template !== undefined) {
		const built = fromSegmentTemplate(template, base.value, id, bandwidth, periodDuration);
		if (!built.ok) return built;
		source = built.value;
	} else if (list !== undefined) {
		const built = fromSegmentList(list, base.value);
		if (!built.ok) return built;
		source = built.value;
	} else if (segmentBase !== undefined) {
		source = fromSegmentBase(base.value);
	} else {
		// どの指定も無ければ BaseURL 自体が 1 本のファイル
		source = { segments: [{ uri: base.value }] };
	}

	const codecs = element.attributes.codecs
		?.split(',')
		.map((codec) => codec.trim())
		.filter((codec) => codec.length > 0);

	const width = parseNumber(element.attributes.width);
	const height = parseNumber(element.attributes.height);
	const frameRate = parseFrameRate(element.attributes.frameRate);

	return ok({
		id,
		...(bandwidth !== undefined && { bandwidth }),
		...(width !== undefined && { width }),
		...(height !== undefined && { height }),
		...(frameRate !== undefined && { frameRate }),
		...(element.attributes.mimeType !== undefined && { mimeType: element.attributes.mimeType }),
		...(codecs !== undefined && codecs.length > 0 && { codecs }),
		...(source.initSegment && { initSegment: source.initSegment }),
		segments: source.segments,
	});
}

/** MPD 文字列を解析する。 */
export function parseMpd(content: string, baseUrl: string): Result<ParsedMpd, MpdParseError> {
	const document = parseXml(content);
	if (!document.ok) {
		return err(document.error.type === 'not-xml' ? { type: 'not-an-mpd' } : { type: 'unparsable' });
	}
	if (document.value.name !== 'MPD') return err({ type: 'not-an-mpd' });

	const root = document.value;
	const mpdBase = resolveBase(root, baseUrl);
	if (!mpdBase.ok) return mpdBase;

	const isLive = (root.attributes.type ?? 'static').toLowerCase() === 'dynamic';
	const duration = parseIso8601Duration(root.attributes.mediaPresentationDuration);

	let drmReason = detectDrm(root);
	const adaptationSets: DashAdaptationSet[] = [];

	for (const period of childrenNamed(root, 'Period')) {
		const periodBase = resolveBase(period, mpdBase.value);
		if (!periodBase.ok) return periodBase;

		const periodDuration = parseIso8601Duration(period.attributes.duration) ?? duration;

		for (const adaptation of childrenNamed(period, 'AdaptationSet')) {
			drmReason ??= detectDrm(adaptation);

			const adaptationBase = resolveBase(adaptation, periodBase.value);
			if (!adaptationBase.ok) return adaptationBase;

			// AdaptationSet 側の指定は配下の Representation へ引き継がれる
			const inheritedTemplate = childNamed(adaptation, 'SegmentTemplate');
			const inheritedList = childNamed(adaptation, 'SegmentList');
			const inheritedBase = childNamed(adaptation, 'SegmentBase');
			const inherited = {
				...(inheritedTemplate !== undefined && { template: inheritedTemplate }),
				...(inheritedList !== undefined && { list: inheritedList }),
				...(inheritedBase !== undefined && { segmentBase: inheritedBase }),
			};

			const representations: DashRepresentation[] = [];
			for (const element of childrenNamed(adaptation, 'Representation')) {
				drmReason ??= detectDrm(element);

				const parsed = parseRepresentation(
					element,
					adaptationBase.value,
					inherited,
					periodDuration,
				);
				if (!parsed.ok) return parsed;
				representations.push(parsed.value);
			}

			if (representations.length === 0) continue;

			adaptationSets.push({
				contentType: toContentType(
					adaptation.attributes.contentType,
					adaptation.attributes.mimeType ?? representations[0]?.mimeType,
				),
				...(adaptation.attributes.lang !== undefined && { lang: adaptation.attributes.lang }),
				representations,
			});
		}
	}

	if (adaptationSets.length === 0) return err({ type: 'no-representations' });

	return ok({
		isLive,
		...(duration !== undefined && { duration }),
		adaptationSets,
		...(drmReason !== undefined && { drmReason }),
	});
}
