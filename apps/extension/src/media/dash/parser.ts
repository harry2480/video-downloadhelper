import { type Result, err, ok } from '../../shared/utils';
import { isAudioCodec, isVideoCodec } from '../codecs';
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
 * MPD 全体で展開してよいセグメント数の上限。
 *
 * MPD の中身はページ側が決められる。**Representation ごとの上限だけでは
 * 足りない。** AdaptationSet の SegmentTemplate は配下へ継承されるため、
 * `<Representation id="..."/>` を 1 行足すだけで数万本ずつ増やせる。
 * 解析は Service Worker で走るので、総量を抑えないと拡張機能ごと止まる。
 */
const MAX_SEGMENTS_PER_MPD = 50_000;

/** 1 つの MPD が持てる Representation の数。正常な配信では多くても数十。 */
const MAX_REPRESENTATIONS_PER_MPD = 200;

/**
 * テンプレートの桁指定（`%0Nd`）の上限。
 *
 * 幅は MPD が決める。制限しないと 1 本の URL で数百 MB の文字列を作られ、
 * さらに大きな値では `padStart` が RangeError を投げて Result を突き破る。
 * `$Number$` は現実的に 10 桁に収まる。
 */
const MAX_TEMPLATE_WIDTH = 16;

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

	const total =
		Number(years ?? 0) * 365 * 86_400 +
		Number(months ?? 0) * 30 * 86_400 +
		Number(days ?? 0) * 86_400 +
		Number(hours ?? 0) * 3_600 +
		Number(minutes ?? 0) * 60 +
		Number(seconds ?? 0);

	// 桁数に制限が無いため、長い数字列は Infinity になる。
	// 通すと本数の算出や推定サイズが壊れる
	return Number.isFinite(total) ? total : undefined;
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
		// **自前のキーだけを見る。** `$constructor$` のような名前で
		// Object.prototype の値を拾うと、URL が壊れた文字列になる
		if (name === undefined || !Object.hasOwn(values, name)) return match;

		// hasOwn を通っているので値は必ずある
		const text = String(values[name as keyof typeof values]);
		if (format === undefined) return text;

		// 桁指定が現実的でなければ書式を無視する。巨大な文字列を作らせない
		const width = Number.parseInt(format, 10);
		return width > MAX_TEMPLATE_WIDTH ? text : text.padStart(width, '0');
	});
}

/** `<start>-<end>`（両端を含む）を offset/length へ直す。 */
function parseRangeAttribute(value: string | undefined): DashSegment['byteRange'] | undefined {
	if (value === undefined) return undefined;

	const match = /^(\d+)-(\d+)$/.exec(value.trim());
	if (match === null) return undefined;

	const start = Number(match[1]);
	const end = Number(match[2]);
	// 桁数の制限が無いため、長い数字列は Infinity になる。
	// 通すと `Range: bytes=Infinity-NaN` を組み立ててしまう（HLS 側と揃える）
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return undefined;
	if (end < start) return undefined;

	return { offset: start, length: end - start + 1 };
}

/**
 * BaseURL を積み上げて基準 URL を決める。
 *
 * MPD / Period / AdaptationSet / Representation の各段に置ける。
 * 内側が絶対 URL なら外側を上書きする（URL の解決規則そのもの）。
 */
/**
 * 基準 URL と、**BaseURL がどこかで宣言されたか**。
 *
 * 宣言が一度も無ければ、基準 URL はマニフェスト自身を指したままになる。
 * そのまま 1 本のメディアとして扱うと、MPD の XML を保存してしまう。
 */
type ResolvedBase = { url: string; declared: boolean };

function resolveBase(
	element: XmlElement,
	parent: ResolvedBase,
): Result<ResolvedBase, MpdParseError> {
	const base = childNamed(element, 'BaseURL')?.text.trim();
	if (base === undefined || base === '') return ok(parent);

	const resolved = resolveUrl(base, parent.url);
	if (!resolved.ok) return err({ type: 'invalid-uri', input: base });
	return ok({ url: resolved.value, declared: true });
}

/**
 * AdaptationSet の種別を決める。
 *
 * **コーデックまで見る。** `contentType` も `mimeType` も無く `codecs` だけを
 * 持つ AdaptationSet は実在する。`unknown` に落とすと、音声が別立ての MPD で
 * 「映像と音声が分かれている」判定をすり抜け、無音の動画が出来上がる。
 */
function toContentType(
	value: string | undefined,
	mimeType: string | undefined,
	codecs: readonly string[] | undefined,
): DashContentType {
	const source = (value ?? mimeType ?? '').toLowerCase();
	if (source.includes('video')) return 'video';
	if (source.includes('audio')) return 'audio';
	if (source.includes('text') || source.includes('ttml') || source.includes('vtt')) return 'text';

	if (codecs !== undefined) {
		if (codecs.some(isVideoCodec)) return 'video';
		if (codecs.some(isAudioCodec)) return 'audio';
	}

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

/** 展開してよい残り本数。MPD 全体で 1 つを共有する。 */
type SegmentBudget = { remaining: number };

/** SegmentTimeline の `<S t d r>` を展開して開始時刻の並びにする。 */
function expandTimeline(timeline: XmlElement, budget: SegmentBudget): number[] | undefined {
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
			if (times.length > budget.remaining) return undefined;
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
	budget: SegmentBudget,
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

	// 仕様は unsignedInt。負値や小数をそのまま URL へ入れない
	const declaredStart = parseNumber(template.attributes.startNumber);
	const startNumber =
		declaredStart !== undefined && Number.isInteger(declaredStart) && declaredStart >= 0
			? declaredStart
			: 1;
	const timescale = parseNumber(template.attributes.timescale) ?? 1;
	const segments: DashSegment[] = [];

	const timelineElement = childNamed(template, 'SegmentTimeline');
	if (timelineElement !== undefined) {
		const times = expandTimeline(timelineElement, budget);
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
	if (count > budget.remaining) return err({ type: 'too-many-segments' });

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
function fromSegmentList(
	list: XmlElement,
	base: string,
	budget: SegmentBudget,
): Result<SegmentSource, MpdParseError> {
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
	if (entries.length > budget.remaining) return err({ type: 'too-many-segments' });

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

/**
 * 親子のセグメント指定を重ねる。子の属性が勝つ。
 *
 * 子要素（SegmentTimeline / SegmentURL 等）は、子が 1 つでも持っていれば
 * 子のものを使う。持っていなければ親から引き継ぐ。
 */
function mergeSegmentElements(
	parent: XmlElement | undefined,
	child: XmlElement | undefined,
): XmlElement | undefined {
	if (parent === undefined) return child;
	if (child === undefined) return parent;

	return {
		name: child.name,
		attributes: { ...parent.attributes, ...child.attributes },
		children: child.children.length > 0 ? child.children : parent.children,
		text: child.text,
	};
}

type SegmentDeclarations = { template?: XmlElement; list?: XmlElement; segmentBase?: XmlElement };

/** ある階層のセグメント指定を読み出す。 */
function readDeclarations(element: XmlElement): SegmentDeclarations {
	const template = childNamed(element, 'SegmentTemplate');
	const list = childNamed(element, 'SegmentList');
	const segmentBase = childNamed(element, 'SegmentBase');

	return {
		...(template !== undefined && { template }),
		...(list !== undefined && { list }),
		...(segmentBase !== undefined && { segmentBase }),
	};
}

/**
 * 親の指定へ子の指定を重ねる。
 *
 * **継承は属性ごとに効く（ISO/IEC 23009-1 5.3.9.2）。** 丸ごと置き換えると、
 * 親が media/initialization を、子が duration だけを持つ一般的な MPD で
 * セグメントが 1 本も作れなくなる。
 */
function inheritDeclarations(
	parent: SegmentDeclarations,
	child: SegmentDeclarations,
): SegmentDeclarations {
	const template = mergeSegmentElements(parent.template, child.template);
	const list = mergeSegmentElements(parent.list, child.list);
	const segmentBase = mergeSegmentElements(parent.segmentBase, child.segmentBase);

	return {
		...(template !== undefined && { template }),
		...(list !== undefined && { list }),
		...(segmentBase !== undefined && { segmentBase }),
	};
}

function parseRepresentation(
	element: XmlElement,
	parentBase: ResolvedBase,
	inherited: SegmentDeclarations,
	periodDuration: number | undefined,
	budget: SegmentBudget,
): Result<DashRepresentation, MpdParseError> {
	const base = resolveBase(element, parentBase);
	if (!base.ok) return base;

	const id = element.attributes.id ?? '';
	const bandwidth = parseNumber(element.attributes.bandwidth);

	// **自身の宣言を先に見る。** 内側の宣言が勝つため、親が SegmentTemplate、
	// 子が SegmentList を持つ MPD で子の指定を無視しない
	const own = readDeclarations(element);
	const declared = inheritDeclarations(inherited, own);
	const preferred =
		own.template !== undefined
			? 'template'
			: own.list !== undefined
				? 'list'
				: own.segmentBase !== undefined
					? 'segmentBase'
					: declared.template !== undefined
						? 'template'
						: declared.list !== undefined
							? 'list'
							: declared.segmentBase !== undefined
								? 'segmentBase'
								: undefined;

	let source: SegmentSource;
	if (preferred === 'template' && declared.template !== undefined) {
		const built = fromSegmentTemplate(
			declared.template,
			base.value.url,
			id,
			bandwidth,
			periodDuration,
			budget,
		);
		if (!built.ok) return built;
		source = built.value;
	} else if (preferred === 'list' && declared.list !== undefined) {
		const built = fromSegmentList(declared.list, base.value.url, budget);
		if (!built.ok) return built;
		source = built.value;
	} else if (base.value.declared) {
		// **BaseURL が宣言されているときだけ「全体で 1 本」とみなす。**
		// そうでないと、セグメント指定を読み損ねた Representation が
		// マニフェスト自身の URL を指し、MPD の XML を .mp4 として保存する。
		// SegmentBase（初期化部分も本体も同じ 1 ファイル）もこの経路で扱う
		source = fromSegmentBase(base.value.url);
	} else {
		source = { segments: [] };
	}

	budget.remaining -= source.segments.length;

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
	const mpdBase = resolveBase(root, { url: baseUrl, declared: false });
	if (!mpdBase.ok) return mpdBase;

	const isLive = (root.attributes.type ?? 'static').toLowerCase() === 'dynamic';
	const duration = parseIso8601Duration(root.attributes.mediaPresentationDuration);

	let drmReason = detectDrm(root);
	const adaptationSets: DashAdaptationSet[] = [];

	// **MPD 全体で 1 つの予算を共有する。** Representation ごとの上限だけでは、
	// 継承された SegmentTemplate のもとで 1 行足すたびに数万本ずつ増やせる
	const budget: SegmentBudget = { remaining: MAX_SEGMENTS_PER_MPD };
	let representationCount = 0;

	const periods = childrenNamed(root, 'Period');

	// **複数 Period は扱わない。** 平坦化すると先頭の Period だけを保存して、
	// 全長は合計を表示する（黙って切り詰めたファイルになる）
	if (periods.length > 1) return err({ type: 'multiple-periods' });

	for (const period of periods) {
		const periodBase = resolveBase(period, mpdBase.value);
		if (!periodBase.ok) return periodBase;

		const periodDuration = parseIso8601Duration(period.attributes.duration) ?? duration;
		// Period 直下にもセグメント指定を置ける（DASH-IF のライブプロファイル等）
		const periodDeclarations = readDeclarations(period);

		for (const adaptation of childrenNamed(period, 'AdaptationSet')) {
			drmReason ??= detectDrm(adaptation);

			const adaptationBase = resolveBase(adaptation, periodBase.value);
			if (!adaptationBase.ok) return adaptationBase;

			// Period → AdaptationSet の順に積み上げて Representation へ渡す
			const inherited = inheritDeclarations(periodDeclarations, readDeclarations(adaptation));

			const representations: DashRepresentation[] = [];
			for (const element of childrenNamed(adaptation, 'Representation')) {
				drmReason ??= detectDrm(element);

				representationCount += 1;
				if (representationCount > MAX_REPRESENTATIONS_PER_MPD) {
					return err({ type: 'too-many-segments' });
				}

				const parsed = parseRepresentation(
					element,
					adaptationBase.value,
					inherited,
					periodDuration,
					budget,
				);
				if (!parsed.ok) return parsed;
				representations.push(parsed.value);
			}

			if (representations.length === 0) continue;

			adaptationSets.push({
				contentType: toContentType(
					adaptation.attributes.contentType,
					adaptation.attributes.mimeType ?? representations[0]?.mimeType,
					representations[0]?.codecs,
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
