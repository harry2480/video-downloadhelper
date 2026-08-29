import { useCallback, useEffect, useRef } from 'react';
import type { BackgroundToPopup, PopupToBackground } from '../../shared/messages';
import { POPUP_PORT_NAME } from '../../shared/messages';

/**
 * Background との Port を 1 本だけ張り、購読と送信の口を配る。
 *
 * 購読する内容ごとに Port を張ると、Background から見て同じポップアップが
 * 複数の購読者に見え、接続時の処理が二重に走る。接続はここへ集約する。
 */

/** Port を張る手段。テストでは Fake を注入する。 */
export type PortFactory = () => chrome.runtime.Port;

const defaultPortFactory: PortFactory = () => chrome.runtime.connect({ name: POPUP_PORT_NAME });

export type PopupPort = {
	/** Background からの通知を購読する。返り値で解除する */
	subscribe: (listener: (message: BackgroundToPopup) => void) => () => void;
	send: (message: PopupToBackground) => void;
};

export function usePopupPort(portFactory: PortFactory = defaultPortFactory): PopupPort {
	const portRef = useRef<chrome.runtime.Port | undefined>(undefined);
	const listenersRef = useRef(new Set<(message: BackgroundToPopup) => void>());

	// **購読者の effect は Port 生成の後に走る。** hooks の呼び出し順が
	// そのまま effect の実行順になるため、購読側は接続完了を待たなくてよい
	useEffect(() => {
		const port = portFactory();
		portRef.current = port;

		const onMessage = (message: BackgroundToPopup) => {
			for (const listener of listenersRef.current) listener(message);
		};

		port.onMessage.addListener(onMessage);

		return () => {
			port.onMessage.removeListener(onMessage);
			portRef.current = undefined;
			port.disconnect();
		};
	}, [portFactory]);

	const subscribe = useCallback((listener: (message: BackgroundToPopup) => void) => {
		const listeners = listenersRef.current;
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
		};
	}, []);

	const send = useCallback((message: PopupToBackground) => {
		portRef.current?.postMessage(message);
	}, []);

	return { subscribe, send };
}
