# Video Download Helper

閲覧中の Web ページが読み込んでいる動画・音声ストリームを自動検出し、保存できる Chrome / Chromium 系ブラウザ向けの拡張機能です。

MP4 / WebM 等の直接メディアに加え、HLS（`.m3u8`）・MPEG-DASH（`.mpd`）といった分割配信ストリームをブラウザ内だけで再構成します。外部サーバー・コンパニオンアプリを必要とせず、検出から結合・保存までをすべてユーザー端末内で完結させます。

> **対象範囲について**
> 本拡張は、ユーザー自身がアクセス権限を持ち、かつダウンロードが許可されているコンテンツの保存支援を目的とします。
> DRM（Widevine / FairPlay / PlayReady）で保護されたコンテンツの復号・回避は実装しません。
> YouTube 等、利用規約および Chrome Web Store ポリシー上ダウンロードが禁止されるサイトは、ブロックリストで機能を無効化します。

## 主な機能

| 機能 | 内容 |
|---|---|
| **メディア検出** | ネットワーク監視と DOM 監視の両方から検出し、重複を排除して一覧化 |
| **複数品質の提示** | HLS Master Playlist / DASH MPD を解析し、解像度・ビットレートごとに選択可能 |
| **ストリーム結合** | 分割されたセグメントを取得・結合して単一ファイルとして保存 |
| **映像・音声の Mux** | DASH 等で分離されたトラックを ffmpeg.wasm で 1 ファイルへ結合 |
| **対応可否の明示** | DRM・再フェッチ不能・サイズ超過を検出時に理由付きで表示 |
| **ローカル完結** | 閲覧履歴もメディア URL も外部送信しない。テレメトリなし |

## 技術スタック

- Chrome Manifest V3（Background Service Worker + Offscreen Document + Content Script）
- TypeScript + React + Tailwind CSS
- Vite + `@crxjs/vite-plugin`
- ffmpeg.wasm（Offscreen Document 内で実行）
- Vitest（Unit / Integration）+ Playwright（E2E）
- Biome（lint/format）+ dependency-cruiser（依存方向の機械検証）

## セットアップ

```bash
pnpm install
pnpm dev
```

`chrome://extensions` を開き、デベロッパーモードを ON にして「パッケージ化されていない拡張機能を読み込む」から `apps/extension/dist/` を選択します。

## 開発コマンド

| コマンド | 内容 |
|---|---|
| `pnpm dev` | Vite dev server（HMR） |
| `pnpm build` | 本番ビルド → `apps/extension/dist/` |
| `pnpm package` | `dist/` を zip 化（Chrome Web Store 提出用） |
| `pnpm verify` | 品質チェック（lint → typecheck → unit test → depcruise → build） |
| `pnpm test:unit` | Unit テスト |
| `pnpm test:integration` | Integration テスト（要ビルド済み `dist/`） |
| `pnpm test:e2e` | E2E テスト（Playwright） |
| `pnpm lint:fix` | 自動フォーマット・Lint 適用 |
| `pnpm knip` | 未使用コード検出 |

## アーキテクチャ

**「実行コンテキスト層 × コアロジック層」の 2 層構造**を採ります。

```text
background ─┐
offscreen  ─┤
content    ─┼──→ processor ──→ media ──→ shared
popup      ─┘
```

コアロジック層（`shared/` `media/` `processor/`）は `chrome.*` や DOM に触れません。副作用は Port interface として宣言し、実行コンテキスト層が Adapter を注入します。これにより HLS / DASH の解析や URL 正規化といった実質的なロジックを、ブラウザを起動せず Node.js 上の高速な Unit テストで検証できます。

この依存方向は dependency-cruiser で CI 上、機械的に検証されます。

```text
apps/extension/src/
├── background/    # Service Worker（検出の集約、状態の所有）
├── offscreen/     # Offscreen Document（セグメント取得、Blob 生成、ffmpeg）
├── content/       # Content Script（DOM 監視）
├── popup/         # React UI（状態を所有しない購読者）
├── processor/     # コアロジック（純粋）
├── media/         # コアロジック（純粋）— 検出・HLS/DASH 解析
├── shared/        # コアロジック（純粋）— 型・メッセージ・ports・storage
└── manifest.json
```

## ドキュメント

| ファイル | 内容 |
|---|---|
| [docs/要件定義.md](docs/要件定義.md) | 機能要件・技術仕様・MVP スコープ・完了条件（**最上位の情報源**） |
| [docs/サービスコンセプト.md](docs/サービスコンセプト.md) | プロダクトのコンセプトと期待される効果 |
| [docs/アーキテクチャ.md](docs/アーキテクチャ.md) | 2 層構造・依存ルール・Port/Adapter・命名規約 |
| [docs/実装計画.md](docs/実装計画.md) | Phase 0〜3 の実装手順 |
| [docs/フロントエンドアーキテクチャ.md](docs/フロントエンドアーキテクチャ.md) | Popup UI 実装方針 |
| [docs/フロントエンド規約.md](docs/フロントエンド規約.md) | components/hooks の責務分離・データフロー |
| [docs/スタイルガイド.md](docs/スタイルガイド.md) | Tailwind 規約（寸法・カラー・折り返し） |
| [docs/リポジトリ層設計規約.md](docs/リポジトリ層設計規約.md) | `chrome.storage` の Repository 規約 |
| [docs/インフラストラクチャ規約.md](docs/インフラストラクチャ規約.md) | ビルド・CI・Chrome Web Store 配布 |
| [docs/品質チェック・テスト規約.md](docs/品質チェック・テスト規約.md) | verify・dependency-cruiser ルール |
| [docs/テストガイドライン.md](docs/テストガイドライン.md) | テスト種別ごとの方針 |

AI エージェント向けのルールは [CLAUDE.md](CLAUDE.md) と [AGENTS.md](AGENTS.md) にあります。

## ライセンス

[LICENSE](LICENSE) を参照してください。
