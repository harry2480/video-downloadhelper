import { useCallback, useEffect, useRef, useState } from 'react';
import type { BackgroundToPopup, PopupToBackground } from '../../shared/messages';
import { POPUP_PORT_NAME } from '../../shared/messages';
import type { DetectedMedia } from '../../shared/types';

/**
 * Background が所有する検出結果を購読する。
 *
 * **Popup は状態を所有しない。** ここで持つのは描画のための派生でしかなく、
 * 真実の情報源は常に Background 側にある（要件定義 2.7）。
 */

/** Port を張る手段。テストでは Fake を注入する。 */
export type PortFactory = () => chrome.runtime.Port;

const defaultPortFactory: PortFactory = () => chrome.runtime.connect({ name: POPUP_PORT_NAME });

type MediaListState = {
	media: DetectedMedia[];
	/** 初回の状態を受け取るまで true */
	isLoading: boolean;
	/** ブロックリスト対象サイトのため機能を無効化しているか */
	isBlocked: boolean;
	rescan: () => void;
};

export function useMediaList(portFactory: PortFactory = defaultPortFactory): MediaListState {
	const [media, setMedia] = useState<DetectedMedia[]>([]);
	const [isLoading, setIsLoading] = useState(true);
	const [isBlocked, setIsBlocked] = useState(false);
	const portRef = useRef<chrome.runtime.Port | undefined>(undefined);

	useEffect(() => {
		const port = portFactory();
		portRef.current = port;

		const onMessage = (message: BackgroundToPopup) => {
			if (message?.kind !== 'media-list') return;
			setMedia(message.media);
			setIsBlocked(message.blocked);
			setIsLoading(false);
		};

		port.onMessage.addListener(onMessage);

		return () => {
			port.onMessage.removeListener(onMessage);
			portRef.current = undefined;
			port.disconnect();
		};
	}, [portFactory]);

	const rescan = useCallback(() => {
		const message: PopupToBackground = { kind: 'rescan' };
		portRef.current?.postMessage(message);
	}, []);

	return { media, isLoading, isBlocked, rescan };
}
