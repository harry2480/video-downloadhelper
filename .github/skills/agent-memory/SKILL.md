---
name: agent-memory
description: "ユーザーが記憶の保存、記憶、想起、または整理を求めた場合に使用するスキルです。トリガー：'remember this'（これを覚えて）、'save this'（これを保存して）、'note this'（これをメモして）、'what did we discuss about...'（...について何を話したっけ）、'check your notes'（メモを確認して）、'clean up memories'（記憶を整理して）。また、保存する価値のある発見をした際に能動的に使用します。"
---

# Agent Memory (エージェントメモリ)

会話をまたいで知識を保存するための永続的なメモリスペースです。

**場所:** `.github/skills/agent-memory/memories/`

## 能動的な使用法

保存する価値のある何かを発見した際にメモリを保存します：
- 明らかにするのに労力を要した調査結果
- コードベース内の自明ではないパターンや落とし穴
- 厄介な問題への解決策
- アーキテクチャ上の決定とその根拠
- 後で再開する可能性のある進行中の作業

関連作業を開始する際にメモリを確認します：
- 問題領域を調査する前
-以前触れたことのある機能に取り組む際
- 会話の中断後に作業を再開する際

必要に応じてメモリを整理します：
- 同じトピックに関する散らばったメモリを統合する
- 古くなった、または取って代わられた情報を削除する
- 作業が完了、ブロック、または放棄された際にステータスフィールドを更新する

## フォルダ構造

可能な場合は、メモリをカテゴリフォルダに整理してください。事前に定義された構造はありません。コンテンツにとって意味のあるカテゴリを作成してください。

## `ideas/daily` から Issue 化候補を提案する（新機能）

- 概要: `ideas/daily/*-summary.md` をスキャンして「Issueにできそうなアイデア」を抽出・提案する軽量エージェント機能を追加しました。
- 実装ファイル: `scripts/suggest_issues_from_summaries.py` とスキルラッパー `.github/skills/agent-memory/run_skill.sh`。
- 使用例:
  - 最新の要約から提案（デフォルト90日）:
    ```bash
    .github/skills/agent-memory/run_skill.sh
    ```
  - 直近30日で絞る:
    ```bash
    .github/skills/agent-memory/run_skill.sh --since 30
    ```
  - キーワードで絞る（例: BMSG）:
    ```bash
    .github/skills/agent-memory/run_skill.sh --query BMSG
    ```
- 出力: 各候補に対して「推奨Issueタイトル」「推奨ラベル」「簡易理由」「ソースURL」を Markdown で表示します（作成は行いません）。
- 目的: 日々蓄積した `summary.md` を活用して、開発タスク（Issue）へ素早く繋げるための補助。

ガイドライン：
- フォルダ名とファイル名にはケバブケース（kebab-case）を使用する
- ナレッジベースの進化に合わせて統合または再編成する

例：
```text
memories/
├── file-processing/
│   └── large-file-memory-issue.md
├── dependencies/
│   └── iconv-esm-problem.md
└── project-context/
    └── december-2025-work.md
```
これは単なる例です。実際のコンテンツに基づいて自由に構造化してください。

## フロントマター (Frontmatter)

すべてのメモリには、`summary`（要約）フィールドを持つフロントマターを含める必要があります。要約は、全コンテンツを読むべきかどうかを判断できるほど簡潔であるべきです。

**要約は判断ポイントです**: エージェントは `rg "^summary:"` を介して要約をスキャンし、どのメモリを完全に読むかを決定します。この決定を下すのに十分なコンテキスト（メモリの内容、主要な問題やトピック、なぜそれが重要なのか）を含む要約を書いてください。

**必須:**
```yaml
---
summary: "このメモリに含まれる内容の1-2行の説明"
created: 2025-01-15 # YYYY-MM-DD 形式
---
```

**オプション:**
```yaml
---
summary: "大容量ファイル処理中のワーカースレッドのメモリリーク - 原因と解決策"
created: 2025-01-15
updated: 2025-01-20
status: in-progress # in-progress (進行中) | resolved (解決済み) | blocked (ブロック中) | abandoned (放棄)
tags: [performance, worker, memory-leak]
related: [src/core/file/fileProcessor.ts]
---
```

## 検索ワークフロー

関連するメモリを効率的に見つけるために、要約ファースト（summary-first）のアプローチを使用します：

```bash
# 1. カテゴリを一覧表示
ls .github/skills/agent-memory/memories/

# 2. すべての要約を表示
rg "^summary:" .github/skills/agent-memory/memories/ --no-ignore --hidden

# 3. キーワードで要約を検索
rg "^summary:.*keyword" .github/skills/agent-memory/memories/ --no-ignore --hidden -i

# 4. タグで検索
rg "^tags:.*keyword" .github/skills/agent-memory/memories/ --no-ignore --hidden -i

# 5. 全文検索（要約検索で不十分な場合）
rg "keyword" .github/skills/agent-memory/memories/ --no-ignore --hidden -i

# 6. 関連する場合は特定のメモリファイルを読む
```

**注意:** メモリファイルは gitignore されているため、ripgrep では `--no-ignore` および `--hidden` フラグを使用してください。

## 呼び出しフレーズ（チャットでの自然言語トリガー）

ユーザーがチャット内で次のフレーズを投げかけたとき、エージェントは `ideas/daily/*-summary.md` をスキャンしてラベル別のMarkdown表を返す動作を行ってください。

- 完全一致推奨: 「今まで貯めてきたアイデアの中でissueにできそうなのある？」

このフレーズを受け取ったら、リポジトリを直接変更せずに以下のコマンドを実行して出力結果をチャット上に貼り付けてください。

```bash
.github/skills/agent-memory/run_skill.sh
```

重要: 出力はユーザーのチャットに返すのみ。`CLAUDE.md` などのファイルには追記しないでください。

## 操作 (Operations)

### 保存 (Save)

1. コンテンツに適切なカテゴリを決定する
2. 既存のカテゴリが適合するか確認し、なければ新規作成する
3. 必須のフロントマターを含めてファイルを書き込む（現在の日付には `date +%Y-%m-%d` を使用）

```bash
mkdir -p .github/skills/agent-memory/memories/category-name/

# 注意: 誤って上書きしないよう、書き込む前にファイルが存在するか確認してください

cat > .github/skills/agent-memory/memories/category-name/filename.md << 'EOF'
---
summary: "このメモリの簡潔な説明"
created: 2025-01-15
---

# タイトル

ここにコンテンツ...
EOF

### セッションキャプチャ保存先（Copilot / Claude など）

- 生ログ（非公開 / gitignore）: `/.local/assistant-sessions/<source>/` に JSONL を保存します（例: `/.local/assistant-sessions/claude/*.jsonl`）。
- サニタイズ済み（コミット可）: `ideas/daily/YYYYMMDD-<source>.md` に日付ベースの Markdown を追記します。既存の `ideas/daily` フローと統合されます。
- 実装ファイル: `scripts/session_watcher.py`（`--once` / `--daemon` オプションあり）。生ログは `.gitignore` に登録済みです。
- 設定/追加: `SOURCES` 配列を編集して他のセッションパスを追加できます（例: Copilot CLI、VSCode の保存先）。

```

### 維持 (Maintain)

- **更新 (Update)**: 情報が変更された場合、コンテンツを更新し、フロントマターに `updated` フィールドを追加する
- **削除 (Delete)**: もはや関連性のないメモリを削除する
  ```bash
  trash .github/skills/agent-memory/memories/category-name/filename.md
  
  # 空のカテゴリフォルダを削除
  rmdir .github/skills/agent-memory/memories/category-name/ 2>/dev/null || true
  ```
- **統合 (Consolidate)**: 関連するメモリが増えた場合、それらをマージする
- **再編成 (Reorganize)**: ナレッジベースの進化に合わせて、メモリをより適切なカテゴリに移動する

## ガイドライン

1. **再開のために書く**: メモリは後で作業を再開するために存在します。文脈を失わずに継続するために必要なすべての重要なポイント（下された決定、その理由、現在の状態、次のステップ）を記録してください。
2. **自己完結型のメモを書く**: 読者が内容を理解し行動するために予備知識を必要としないよう、完全なコンテキストを含めてください。
3. **要約を決断の助けにする**: 要約を読めば、詳細が必要かどうかがわかるようにしてください。
4. **最新の状態を保つ**: 古い情報を更新または削除してください。
5. **実用的であれ**: すべてではなく、実際に役立つものだけを保存してください。

## コンテンツリファレンス

詳細なメモリを書く際は、以下を含めることを検討してください：

- **コンテキスト (Context)**: 目標、背景、制約事項
- **状態 (State)**: 完了したもの、進行中のもの、またはブロックされているもの
- **詳細 (Details)**: 主要なファイル、コマンド、コードスニペット
- **次のステップ (Next steps)**: 次にすべきこと、未解決の疑問

すべてのメモリにすべてのセクションが必要なわけではありません。関連するものを使用してください。
```

### 呼び出し: /agent-memory (ワンコマンドで当日のチャットを保存)

- **目的:** その日のエージェント（Claude / GitHub Copilot など）のチャットをまとめて `Documents/ChatLogs/ClaudeCode` or `Documents/ChatLogs/GithubCopilot`に保存する。
- **実装:** `scripts/save_today_agent_memory.py` とラッパー `.github/skills/agent-memory/agent-memory.sh` を追加しました。
- **保存先:** `ideas/daily/YYYYMMDD-agent-memory.md` にソースごとのヘッダと生ログ（テキスト）を追記します。
- **検出対象 (既定):** `~/Documents/ChatLogs/ClaudeCode`, `~/Documents/ChatLogs/GithubCopilot` を走査し、当日更新されたファイルを収集します。必要なら `scripts/save_today_agent_memory.py` を編集してパスを追加してください。

#### 使用例

- ワンライナーで保存:

```bash
.github/skills/agent-memory/agent-memory.sh
```

- 直接スクリプトを実行する例:

```bash
python3 scripts/save_today_agent_memory.py
```

出力ファイルの存在を確認し、必要なら `ideas/daily/` 内の該当ファイルを編集してサニタイズしてください。
