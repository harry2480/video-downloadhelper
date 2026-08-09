# apps/extension

Video Download Helper の Chrome 拡張機能本体。

## 開発

```bash
pnpm dev
```

`chrome://extensions` を開き、デベロッパーモードを ON にして
「パッケージ化されていない拡張機能を読み込む」から `apps/extension/dist/` を選択する。

## ログの見つけ方

コンテキストごとにコンソールが分かれている。

| コンテキスト | 開き方 |
|---|---|
| Service Worker | `chrome://extensions` → 「Service Worker」リンク |
| Offscreen Document | `chrome://inspect/#other` |
| Content Script | ページの DevTools（コンソールのコンテキストを拡張機能に切り替える） |
| Popup | ポップアップを右クリック → 「検証」 |

**開発中に Service Worker の DevTools を開きっぱなしにすると SW が停止しなくなる。**
非常駐前提のバグを見逃すため、動作確認時は閉じること。

## 構成

依存方向: `background/offscreen/content/popup → processor → media → shared`

コアロジック層（`shared/` `media/` `processor/`）は `chrome.*` / DOM に触れない。
詳細は [docs/アーキテクチャ.md](../../docs/アーキテクチャ.md) を参照。
