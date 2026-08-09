---
description: エラーを修正する。エラーメッセージから原因を特定し、アーキテクチャルールに従って修正する
---

# エラー修正スキル

ユーザーがエラーメッセージを貼り付けて「直して」と指示したときに適用する。

## 手順

1. **エラーメッセージを解析** — エラーの種類と発生箇所を特定
2. **どの実行コンテキストのエラーか特定** — Service Worker / Offscreen / Content Script / Popup で原因も対処も変わる
3. **原因を特定** — コードを読んで根本原因を調査
4. **修正を実施** — アーキテクチャルールに違反しない形で修正
5. **検証** — `pnpm verify` で全チェックがパスすることを確認

## ログの見つけ方

エラーの出所によってコンソールが違う。ここを間違えると「ログが出ない」と誤解する。

| コンテキスト | 開き方 |
|---|---|
| Service Worker | `chrome://extensions` → 「Service Worker」リンク |
| Offscreen Document | `chrome://inspect/#other` |
| Content Script | ページの DevTools（コンソールのコンテキストを拡張機能に切り替える） |
| Popup | ポップアップを右クリック → 「検証」 |

## よくあるエラーと対処

### 型エラー（TypeScript）
- `pnpm typecheck` で確認
- 型の不一致を修正。`any` は使わない
- 外部由来のデータ（マニフェスト文字列・メッセージ）はキャストせずパースして型を確定させる

### 依存方向違反（dependency-cruiser）
- `pnpm depcruise` で確認
- 依存方向: `background/offscreen/content/popup → processor → media → shared`
- **コアロジックから実行コンテキストを import している** → ロジックを `media/` `processor/` 側へ移すか、Port interface として宣言して注入に変える
- **実行コンテキスト同士を import している** → 直接呼べない。`shared/messages.ts` にメッセージを追加して通信に置き換える

### `URL.createObjectURL is not a function` / `Blob` 関連
- Service Worker には存在しない API を呼んでいる
- Blob 生成・オブジェクト URL 発行は `offscreen/` へ委譲する

### `document is not defined` / `window is not defined`
- Service Worker またはコアロジック層で DOM API を呼んでいる
- コアロジック層なら Port として切り出す。Service Worker なら `offscreen/` へ委譲する

### ダウンロードが途中で止まる / 進捗が消える
- Service Worker が停止した可能性を最初に疑う
- 長時間処理が `background/` に残っていないか確認し、`offscreen/` へ移す
- 状態が `chrome.storage.session` に復元可能な形で保存されているか確認する
- 開発中に DevTools を開きっぱなしにしていると SW が停止せず、この不具合を見逃す

### ポップアップを開き直すと状態が消える
- Popup が状態を所有してしまっている
- 状態を `background/` へ移し、Popup は購読するだけに変える

### マニフェスト取得の失敗（403 / CORS）
- 認証付き・有効期限付き URL の再フェッチに失敗している
- 仕様上「対応外」として扱う。ユーザーに理由を表示する経路へ倒す（要件定義 2.2）

### ビルドは通るが拡張機能が動かない
- `pnpm build` は通っても manifest の記述漏れは実行時にしか出ない
- エントリが `src/manifest.json` に登録されているか確認する
- Offscreen Document の HTML が `vite.config.ts` の `build.rollupOptions.input` に登録されているか確認する（CRXJS は manifest 経由のエントリしか自動検出しない）
- `chrome://extensions` でリロードし直す

## 禁止事項

- **エラーを握りつぶさない。** `try { } catch { }` で黙らせるのではなく、`Result<T, E>` として呼び出し元へ返し、UI で理由を表示する
- **`any` や `@ts-ignore` で型エラーを回避しない**
- **depcruise の違反を設定変更で回避しない。** モジュールの配置を見直す
- **`chrome.*` をモックしてテストを通さない。** テストが書けないのは設計が間違っているサイン
