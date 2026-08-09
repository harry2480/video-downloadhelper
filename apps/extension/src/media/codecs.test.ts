import { describe, expect, it } from 'vitest';
import { classifyCodecs, isAudioCodec, isVideoCodec } from './codecs';

describe('isVideoCodec', () => {
	it.each(['avc1.640028', 'avc3.4d401f', 'hvc1.1.6.L93.B0', 'hev1.2.4.L120.B0', 'av01.0.05M.08'])(
		'%s を映像と判定する',
		(codec) => {
			expect(isVideoCodec(codec)).toBe(true);
		},
	);

	it.each(['vp8', 'vp9', 'vp09.00.10.08'])('%s を映像と判定する', (codec) => {
		expect(isVideoCodec(codec)).toBe(true);
	});

	it('音声コーデックを映像と判定しない', () => {
		expect(isVideoCodec('mp4a.40.2')).toBe(false);
	});

	it('大文字小文字を問わない', () => {
		expect(isVideoCodec('AVC1.640028')).toBe(true);
	});
});

describe('isAudioCodec', () => {
	it.each(['mp4a.40.2', 'ac-3', 'ec-3', 'opus', 'flac', 'alac'])('%s を音声と判定する', (codec) => {
		expect(isAudioCodec(codec)).toBe(true);
	});

	it('映像コーデックを音声と判定しない', () => {
		expect(isAudioCodec('avc1.640028')).toBe(false);
	});
});

describe('classifyCodecs', () => {
	it('映像が先でも正しく振り分ける', () => {
		expect(classifyCodecs(['avc1.640028', 'mp4a.40.2'])).toEqual({
			videoCodec: 'avc1.640028',
			audioCodec: 'mp4a.40.2',
		});
	});

	it('音声が先でも正しく振り分ける', () => {
		// CODECS は順不同（RFC 8216）。Apple のオーサリング例にも
		// 音声が先に来るものがある
		expect(classifyCodecs(['mp4a.40.2', 'avc1.4d401e'])).toEqual({
			videoCodec: 'avc1.4d401e',
			audioCodec: 'mp4a.40.2',
		});
	});

	it('音声のみなら映像を持たない', () => {
		expect(classifyCodecs(['mp4a.40.2'])).toEqual({ audioCodec: 'mp4a.40.2' });
	});

	it('映像のみなら音声を持たない', () => {
		expect(classifyCodecs(['avc1.640028'])).toEqual({ videoCodec: 'avc1.640028' });
	});

	it('判別できない識別子を無視する', () => {
		expect(classifyCodecs(['unknown.1', 'avc1.640028'])).toEqual({ videoCodec: 'avc1.640028' });
	});

	it('同種が複数ある場合は最初のものを採る', () => {
		expect(classifyCodecs(['avc1.640028', 'hvc1.1.6.L93.B0'])).toEqual({
			videoCodec: 'avc1.640028',
		});
	});

	it('未指定なら空を返す', () => {
		expect(classifyCodecs(undefined)).toEqual({});
		expect(classifyCodecs([])).toEqual({});
	});
});
