---
description: 外部APIとの連携を追加する。Gateway interface + 本番実装 + Stub実装を生成する
---

# 外部API連携追加スキル

ユーザーが「〇〇APIと連携して」「〇〇サービスを使いたい」と指示したときに適用する。

## 生成するファイル（3ファイルセット）

1. **Gateway Interface** (`src/backend/domain/gateways/{name}.gateway.ts`)
   - 汎用メソッドで構成
   - ドメイン固有のメソッド名ではなく、操作を抽象化した名前にする

2. **本番実装** (`src/backend/infrastructure/adapters/{provider}-{name}.adapter.ts`)
   - 外部 API SDK を使用した実装
   - API呼び出し・リトライ・タイムアウトを担当

3. **Stub 実装** (`src/backend/infrastructure/adapters/stub-{name}.adapter.ts`)
   - テスト可能な固定値を返す
   - コンストラクタでレスポンスをカスタマイズ可能にする

4. **Composition の更新** (`src/backend/presentation/composition/{name}.composition.ts`)
   - 環境変数で本番/Stub を切り替え
   ```typescript
   const apiKey = process.env.{SERVICE}_API_KEY;
   const gateway = apiKey ? new RealGateway(apiKey) : new StubGateway();
   ```

## ルール

- Gateway interface は domain 層に配置（外部依存なし）
- 実装は infrastructure/adapters に配置
- プロンプト生成・レスポンスパースは application 層（UseCase）の責務
- 必要な環境変数は `.env.local` に追加（Git にコミットしない）
- 必要なパッケージは `pnpm --filter webapp add {package}` でインストール
