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

## アイコン

原本は `src/icons/icon.svg`。manifest が参照する PNG は SVG から生成する。

```bash
pnpm --filter extension icons   # 16 / 32 / 48 / 128 px を書き出す
```

PNG は生成物だが、ストア提出物に含めるためリポジトリへコミットしている。
**図案を変えたら必ずスクリプトを実行し、生成された PNG ごとコミットすること。**
PNG を直接編集すると次の生成で上書きされる。

## 構成

依存方向: `background/offscreen/content/popup → processor → media → shared`

コアロジック層（`shared/` `media/` `processor/`）は `chrome.*` / DOM に触れない。
詳細は [docs/アーキテクチャ.md](../../docs/アーキテクチャ.md) を参照。
