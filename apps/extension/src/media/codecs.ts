/**
 * コーデック識別子の種別判定。
 *
 * HLS の `CODECS` 属性（RFC 8216）も DASH の `@codecs` も、
 * **順不同のフォーマット識別子リスト**であり位置に契約はない。
 * `CODECS="mp4a.40.2,avc1.4d401e"` のように音声が先に来る manifest は
 * 実在するため、並び順で映像・音声を決めてはならない。
 */

/** RFC 6381 のサンプルエントリ。先頭 4 文字（一部は 3 文字）で判別できる。 */
const VIDEO_PREFIXES = [
	'avc1',
	'avc2',
	'avc3',
	'avc4',
	'hev1',
	'hvc1',
	'dvh1',
	'dvhe',
	'vp08',
	'vp09',
	'av01',
	'vp8',
	'vp9',
	'mp4v',
];

const AUDIO_PREFIXES = [
	'mp4a',
	'ac-3',
	'ec-3',
	'ac-4',
	'opus',
	'flac',
	'alac',
	'vorbis',
	'dtsc',
	'dtse',
	'mp3',
];

function startsWithAny(codec: string, prefixes: string[]): boolean {
	const lowered = codec.toLowerCase();
	return prefixes.some((prefix) => lowered.startsWith(prefix));
}

export function isVideoCodec(codec: string): boolean {
	return startsWithAny(codec, VIDEO_PREFIXES);
}

export function isAudioCodec(codec: string): boolean {
	return startsWithAny(codec, AUDIO_PREFIXES);
}

/**
 * コーデック一覧から映像・音声を取り出す。
 *
 * 判別できない識別子は無視する。同種が複数ある場合は最初のものを採る。
 */
export function classifyCodecs(codecs: readonly string[] | undefined): {
	videoCodec?: string;
	audioCodec?: string;
} {
	if (codecs === undefined) return {};

	const videoCodec = codecs.find(isVideoCodec);
	const audioCodec = codecs.find(isAudioCodec);

	return {
		...(videoCodec !== undefined && { videoCodec }),
		...(audioCodec !== undefined && { audioCodec }),
	};
}
