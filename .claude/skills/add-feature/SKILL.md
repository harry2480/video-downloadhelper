---
description: 新しい機能を追加する。ユーザーが機能の説明をしたとき、2層構造に従って必要なレイヤーのファイルを生成する
---

# 機能追加スキル

ユーザーが「〇〇な機能を作って」と指示したときに適用する。
`docs/アーキテクチャ.md` の 2 層構造（実行コンテキスト層 × コアロジック層）に従ってファイルを生成する。

## 最初に判断すること

**その機能に副作用が必要か。** ここを取り違えると層の配置が破綻する。

| 機能の性質 | 生成先 |
|---|---|
| 解析・判定・変換のみ（マニフェスト解析、URL 正規化、ファイル名生成など） | コアロジック層のみ |
| ブラウザ API が必要（検出、保存、storage、DOM 監視） | コアロジック層 + 実行コンテキスト層 + Port |
| 表示のみ | `popup/` のみ |

## 生成するファイル

### 1. コアロジック（必須）

**`src/media/` または `src/processor/` に純粋関数として実装する。**

- `chrome.*` / `document` / `window` / `Blob` を**参照しない**
- 副作用が必要なら Port interface として宣言し、引数で受け取る
- 失敗は例外ではなく `Result<T, E>` 型で返す
- 同階層に `*.test.ts` を必ず作る

```typescript
// src/media/hls/parser.ts
export function parseMasterPlaylist(
  content: string,      // 取得済みの文字列を受け取る。自分で fetch しない
  baseUrl: string,
): Result<ParsedMasterPlaylist, HlsParseError> { }
```

### 2. 型・メッセージ（必要な場合）

- 型: `src/shared/types.ts`
- コンテキスト間通信: `src/shared/messages.ts` の判別可能ユニオンに追加
- Port interface: `src/shared/ports/{name}.port.ts`

### 3. 実行コンテキスト（副作用がある場合）

どのコンテキストに置くかを間違えないこと。

| 副作用 | 置き場所 |
|---|---|
| webRequest 監視、タブ管理、状態の所有 | `src/background/` |
| セグメント取得、Blob 生成、`URL.createObjectURL`、ffmpeg | `src/offscreen/` |
| DOM 監視、`<video>` / `<audio>` 検出 | `src/content/` |
| 表示 | `src/popup/` |

- Port の実装（Adapter）は各エントリ（`index.ts` / `main.tsx`）で生成し、以降は interface として引き回す
- **長時間処理を `background/` に置かない。** Service Worker は停止する。`offscreen/` へ委譲する
- **状態を `popup/` に置かない。** ポップアップは閉じられる。`background/` が所有する

### 4. 永続化（必要な場合）

`src/shared/storage/{name}.repository.ts` に追加する。`chrome.storage` を他から直接呼ばない。
詳細は `docs/リポジトリ層設計規約.md` を参照。

### 5. UI（必要な場合）

`src/popup/components/` に追加する。詳細は design-ui スキルを参照。

## ルール

- ファイル命名: kebab-case + 役割サフィックス（`.parser.ts` / `.port.ts` / `.adapter.ts` / `.repository.ts`）
- コアロジック層は関数エクスポート。状態と依存を持つオーケストレーターのみクラス + コンストラクタ DI
- `index.ts` バレルエクスポート禁止
- 実行コンテキスト同士の import 禁止。通信はメッセージ経由のみ
- `any` 禁止。外部由来のデータは境界でパースして型を確定させる
- 生成後は必ず `pnpm verify` を実行する（依存方向違反は depcruise が検出する）

## 実装順序

**必ずコアロジック層から書く。** 先に純粋関数とテストを作れば、ブラウザを起動せずに正しさを確認できる。
実行コンテキストは、検証済みのコアロジックを繋ぐ配線として最後に書く。
