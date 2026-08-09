import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';

/**
 * Popup のエントリ兼 Composition Root。
 * Port 実装（Adapter）の生成はここに閉じ込め、以降は interface として引き回す。
 */
const container = document.getElementById('root');
if (!container) throw new Error('#root が見つかりません');

createRoot(container).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
