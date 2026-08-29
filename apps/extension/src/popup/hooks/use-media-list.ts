import { useCallback, useEffect, useState } from 'react';
import type { DetectedMedia } from '../../shared/types';
import type { PopupPort } from './use-popup-port';

/**
 * Background が所有する検出結果を購読する。
 *
 * **Popup は状態を所有しない。** ここで持つのは描画のための派生でしかなく、
 * 真実の情報源は常に Background 側にある（要件定義 2.7）。
 */

type MediaListState = {
	media: DetectedMedia[];
	/** 初回の状態を受け取るまで true */
	isLoading: boolean;
	/** ブロックリスト対象サイトのため機能を無効化しているか */
	isBlocked: boolean;
	rescan: () => void;
};

export function useMediaList(port: PopupPort): MediaListState {
	const [media, setMedia] = useState<DetectedMedia[]>([]);
	const [isLoading, setIsLoading] = useState(true);
	const [isBlocked, setIsBlocked] = useState(false);

	useEffect(
		() =>
			port.subscribe((message) => {
				if (message.kind !== 'media-list') return;
				setMedia(message.media);
				setIsBlocked(message.blocked);
				setIsLoading(false);
			}),
		[port],
	);

	const rescan = useCallback(() => port.send({ kind: 'rescan' }), [port]);

	return { media, isLoading, isBlocked, rescan };
}
