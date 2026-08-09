---
description: Popup UIコンポーネントを作成・修正する。React + Tailwindで拡張機能のポップアップを実装する
---

# UI デザインスキル

ユーザーが「〇〇な画面を作って」「デザインを変えて」と指示したときに適用する。

本拡張の UI は **Popup 単一画面のみ**。ページもルーティングも存在しない。

## 使用するUIスタック

- **React**: `src/popup/` に配置
- **Tailwind CSS**: スタイリング（`darkMode: 'media'`）
- **自前の最小プリミティブ**: `src/popup/components/ui/`

**shadcn/ui・UI ライブラリを導入しない。** 拡張機能のバンドルサイズと CSP 制約のため、必要なプリミティブ（Button / Badge / ProgressBar 等）は自前で最小限に作る。アイコンも外部パッケージではなくインライン SVG を使う。

## コンポーネント配置

| 種類 | 配置先 |
|---|---|
| 機能コンポーネント（MediaList, QualitySelector 等） | `src/popup/components/` |
| 汎用プリミティブ（Button, Badge, ProgressBar） | `src/popup/components/ui/` |
| 購読・メッセージ送信のロジック | `src/popup/hooks/` |
| 表示用の整形関数（バイト数、解像度ラベル等） | `src/popup/utils/` または `src/shared/utils.ts` |

## 必ず守るスタイルルール

詳細は `docs/スタイルガイド.md` を参照。特に以下は違反しやすい。

1. **ビューポート単位（`vh` / `dvh` / `h-screen`）を使わない。** ポップアップでは値が確定せず壊れる。ルートは `w-[420px] max-h-[600px]` の固定 px、スクロールは一覧の内側に `flex-1 overflow-y-auto` で持たせる
2. **直値カラー（`bg-[#1a73e8]`）を使わない。** セマンティックトークン（`bg-primary` / `text-muted` / `text-danger`）を使い、ダークモードは CSS 変数の切り替えで対応する
3. **ページ由来テキストに折り返しを必ず指定する。** タイトルは `truncate` / `line-clamp-2`、URL は `break-all`、親に `min-w-0`

## 必ず守る実装ルール

- **`chrome.*` をコンポーネントから直接呼ばない。** hooks に閉じる
- **`dangerouslySetInnerHTML` を使わない。** 表示する文字列はすべてページ由来の信頼できない入力
- **状態を持たない。** 検出結果・ダウンロード進捗は Background が所有する。Popup は購読して描画するだけ
- **外部ホストのリソースを読み込まない。** 画像・フォント・アイコンはすべて同梱する（CSP 制約）
- アイコンボタンには必ず `aria-label` を付ける。品質選択は `radiogroup` セマンティクスを使う
- 状態を色だけで伝えない。テキストまたはアイコンを併記する

## 確認

実装後は `pnpm build` して `chrome://extensions` から読み込み、実際のポップアップで確認する。
幅 420px・長大なタイトル・ダークモードの 3 条件で崩れないことを見ること。
