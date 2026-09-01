# Video Download Helper

Chrome / Chromium 系ブラウザ向けの動画ダウンロード支援拡張機能（Manifest V3）。

## 使い方（利用者向け）

- `pnpm dev` で開発ビルドを起動し、`chrome://extensions` から `apps/extension/dist/` を読み込む
- `pnpm verify` で品質チェック（変更後に実行）
- 機能を追加したいときは Claude Code に「〇〇な機能を作って」と指示するだけでOK
- UIを作りたいときは「〇〇な画面を作って」と指示
- エラーが出たらエラーメッセージを貼り付けて「直して」と指示

### コマンド一覧

```sh
pnpm dev               # Vite dev server（HMR）
pnpm build             # 本番ビルド → apps/extension/dist/
pnpm package           # dist/ を zip 化（Chrome Web Store 提出用）
pnpm verify            # lint → typecheck → unit test → depcruise → build
pnpm test:unit         # Unit テスト（コアロジック層）
pnpm test:integration  # Integration テスト（要 Chrome 起動、要 pnpm build 済み）
pnpm test:e2e          # E2E テスト（Playwright）
pnpm lint:fix          # 自動フォーマット
pnpm knip              # 未使用コード検出
```

---

## Claude Code への指示（利用者は読まなくてOK）

### アーキテクチャ

pnpm workspace monorepo。`apps/extension/` に Vite + `@crxjs/vite-plugin` + React の拡張機能。
バックエンド・データベースは存在しない。永続化は `chrome.storage`。

**DDD 4層ではなく「実行コンテキスト層 × コアロジック層」の2層構造。**

```
依存方向: background/offscreen/content/popup → processor → media → shared
```

- **shared** — 型・メッセージ定義・Port interface・純粋 util。最内層。他への依存禁止
- **media** — 形式判定・HLS/DASH 解析・URL 正規化・ブロックリスト。shared のみ依存
- **processor** — セグメント取得制御・Mux・ファイル名生成。media, shared に依存
- **background / offscreen / content / popup** — 実行コンテキスト。`chrome.*`・DOM・ffmpeg.wasm の副作用を担い、各エントリが Composition Root を兼ねる

### ファイル配置ルール

```
apps/extension/src/
├── background/          # Service Worker（service-worker.ts が Composition Root）
│   ├── request-detector.ts
│   ├── media-registry.ts
│   ├── download-manager.ts
│   └── tab-manager.ts
├── offscreen/           # Offscreen Document（Blob 生成・ffmpeg 実行）
│   ├── segment-fetcher.ts
│   ├── blob-assembler.ts
│   └── ffmpeg-runner.ts
├── content/             # Content Script（DOM 監視）
├── popup/               # React UI（main.tsx が Composition Root）
│   ├── components/
│   └── hooks/
├── processor/           # コアロジック（純粋）
├── media/               # コアロジック（純粋）— hls/ dash/ direct/
├── shared/              # コアロジック（純粋）— messages.ts, ports/, storage/, utils.ts
└── manifest.json
```

### Key Rules

- ファイル命名: kebab-case + 役割サフィックス（`.parser.ts` / `.port.ts` / `.adapter.ts` / `.repository.ts` / `.model.ts`）。React コンポーネントのみ PascalCase
- **コアロジック層（shared/media/processor）で `chrome.*` / `document` / `window` / `Blob` を参照禁止。** 副作用は Port interface として宣言し、実行コンテキスト層から Adapter を注入する
- **実行コンテキスト同士の import 禁止。** 別バンドルであり、通信は `shared/messages.ts` の判別可能ユニオン経由のみ
- Rich Domain Model 必須。URL 正規化・重複判定・DRM 判定はモデル/`media/` に閉じる
- 解析失敗は `Result<T, E>` 型で返す。実行コンテキスト層でユーザー向けメッセージへ変換
- `chrome.storage` へのアクセスは `shared/storage/*.repository.ts` に集約。他から直接呼ばない
- `index.ts` バレルエクスポート禁止。**エントリのファイル名は全コンテキストで一意にする**（すべて `index.ts` にすると CRXJS が SW ローダーを別バンドルへ紐づけ、静かに壊れる）
- **Popup は状態を所有しない。** 検出結果・進捗は Background が所有し、Popup は購読して描画するだけ
- **Service Worker は常駐しない前提で書く。** 長時間処理は Offscreen Document へ委譲し、状態は storage から復元可能な形で保持する
- 拡張機能内部メッセージは `sender.id !== chrome.runtime.id` を破棄して送信元を検証する
- ページ由来の文字列を `dangerouslySetInnerHTML` へ渡さない
- リモートコードを実行しない（ffmpeg.wasm も同梱する）

### テスト

- Unit: `shared/` `media/` `processor/`（副作用なし。`chrome.*` のモック禁止 — 必要なら設計が間違っている）
- Component: `popup/`（Testing Library + Fake port）
- Integration: `test/integration/`（実 Chrome に拡張機能をロード。storage 状態と SW 停止時の復元を検証）
- E2E: `test/e2e/`（Playwright。検出→バッジ→ポップアップ→ダウンロード完了）
- Unit/Component は実装ファイルと同階層に `*.test.ts(x)` を配置

### 品質チェック

`pnpm verify` は lint → typecheck → unit test → depcruise → build を順に実行する。
コード変更後は必ず `pnpm verify` を実行して全パスすることを確認する。
build を含めるのは manifest 由来のエラー（エントリ記述漏れ等）が型チェックでは検出できないため。

### 詳細ルール

詳細な設計ルールは必要に応じて docs/ を読むこと:

- docs/要件定義.md — 機能要件・技術仕様・MVP スコープ・完了条件（**最上位の情報源**）
- docs/アーキテクチャ.md — 2層構造・依存ルール・Port/Adapter・命名規約
- docs/フロントエンドアーキテクチャ.md — Popup UI 実装方針
- docs/フロントエンド規約.md — components/hooks の責務分離・データフロー
- docs/スタイルガイド.md — Tailwind 規約（寸法・カラー・折り返し）
- docs/リポジトリ層設計規約.md — `chrome.storage` の Repository 規約
- docs/インフラストラクチャ規約.md — ビルド・CI・Chrome Web Store 配布
- docs/品質チェック・テスト規約.md — verify・dependency-cruiser ルール
- docs/テストガイドライン.md — テスト種別ごとの方針
- docs/実装計画.md — Phase 0〜3 の実装手順
- docs/残作業.md — 未着手・未解決の具体項目。**新しい作業に着手する前に読むこと**
