import { describe, expect, it } from 'vitest';
import { BLOCKED_SITE_MESSAGE, isBlockedHostname, isBlockedUrl } from './blocklist';

describe('isBlockedHostname', () => {
	it.each(['youtube.com', 'youtu.be', 'youtube-nocookie.com', 'googlevideo.com'])(
		'%s をブロックする',
		(hostname) => {
			expect(isBlockedHostname(hostname)).toBe(true);
		},
	);

	it.each(['www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'r1---sn-abc.googlevideo.com'])(
		'サブドメイン %s をブロックする',
		(hostname) => {
			expect(isBlockedHostname(hostname)).toBe(true);
		},
	);

	it('大文字小文字を問わずブロックする', () => {
		expect(isBlockedHostname('WWW.YouTube.COM')).toBe(true);
	});

	it('末尾のドット（絶対 FQDN 表記）を吸収する', () => {
		expect(isBlockedHostname('www.youtube.com.')).toBe(true);
	});

	it.each(['notyoutube.com', 'youtube.com.evil.example', 'myyoutu.be', 'example.com', 'vimeo.com'])(
		'部分一致の %s はブロックしない',
		(hostname) => {
			expect(isBlockedHostname(hostname)).toBe(false);
		},
	);

	it('空文字をブロックしない', () => {
		expect(isBlockedHostname('')).toBe(false);
	});
});

describe('isBlockedUrl', () => {
	it('ブロック対象サイトの URL を判別する', () => {
		expect(isBlockedUrl('https://www.youtube.com/watch?v=abc')).toBe(true);
		expect(isBlockedUrl('https://youtu.be/abc')).toBe(true);
	});

	it('対象外サイトはブロックしない', () => {
		expect(isBlockedUrl('https://example.com/video')).toBe(false);
	});

	it('パースできない URL はブロックしない（誤検知は機能欠損になるため）', () => {
		expect(isBlockedUrl('not a url')).toBe(false);
		expect(isBlockedUrl('')).toBe(false);
	});
});

describe('BLOCKED_SITE_MESSAGE', () => {
	it('ユーザーへ表示する理由を持つ', () => {
		expect(BLOCKED_SITE_MESSAGE.length).toBeGreaterThan(0);
	});
});
