---
name: digest
allowed-tools: Bash(npx *)
description: "Multi-domain AI-powered RSS digest. Supports multiple profiles (ai, quant, etc.) to fetch domain-specific RSS feeds, score/filter articles with AI, and generate daily digests in Markdown. Use when user mentions 'daily digest', 'RSS digest', 'blog digest', 'AI blogs', 'quant digest', 'tech news summary', or asks to run /digest command. Trigger command: /digest."
---

# AI Daily Digest

支援多領域的 AI 每日精選摘要產生器。透過 profile 機制，可切換不同領域（AI/技術、量化金融等），抓取對應 RSS 來源並以 AI 評分篩選。

## 指令

### `/digest`

執行每日摘要產生器（預設使用 AI/技術 profile）。

### `/digest ai`

執行 AI/技術領域摘要（來自 Karpathy 推薦的 90 個頂級技術部落格）。

### `/digest quant`

執行量化金融領域摘要（量化交易、風控、市場微結構等）。

### `/digest history`

執行歷史主題摘要（古代史、中世紀、近現代、軍事、科技文化等）。

**使用方式**：輸入 `/digest` 或 `/digest <profile>`。若已有儲存設定則自動執行，否則透過互動引導收集參數。

---

## 腳本目錄

**重要**：所有腳本位於 `~/.claude/skills/digest/scripts/`。

| 檔案 | 用途 |
|------|------|
| `scripts/digest.ts` | 主腳本 — RSS 抓取、AI 評分、產生摘要 |
| `profiles/ai.json` | AI/技術領域 profile |
| `profiles/quant.json` | 量化金融領域 profile |
| `profiles/history.json` | 歷史主題領域 profile |

---

## 設定持久化

設定檔路徑：`~/.hn-daily-digest/config.json`

Agent **不要用 Read 工具讀取此檔案**（會觸發專案外權限提示）。腳本會自行讀取 config。
- 若 config 存在且有 API Key → 腳本自動使用，正常執行
- 若 config 不存在或無 API Key → 腳本報錯，Agent 再進入互動流程收集參數

**設定檔結構**：
```json
{
  "anthropicApiKey": "",
  "geminiApiKey": "",
  "openaiApiKey": "",
  "openaiApiBase": "",
  "openaiModel": "",
  "timeRange": 48,
  "topN": 15,
  "language": "zh",
  "heptabase": true,
  "lastUsed": "2026-02-16T12:00:00Z"
}
```

---

## 互動流程

### Step 0：直接執行（零前置操作）

**不要用 Read 讀取 config**（會觸發專案外檔案的權限提示）。

直接跳到 Step 2 執行 `npx` 指令。腳本會自行讀取 `~/.hn-daily-digest/config.json` 中的 API Key 和設定。

- 若使用者輸入 `/digest <profile>`（如 `/digest quant`），使用指定的 profile；否則預設 `ai`
- **不問任何問題**，不讀取任何檔案，直接執行腳本

**■ 若腳本報錯 "Missing API key" → 才進入互動模式**（Step 1 ~ Step 1c），收集 API Key 後重新執行。

### Step 1：選擇 Profile 和收集參數

若使用者輸入 `/digest` 未指定 profile，詢問：

**領域 Profile** — 要產生哪個領域的摘要？
- AI/技術（推薦，90 個技術部落格）→ `--profile ai`
- 量化金融（20 個量化金融部落格）→ `--profile quant`
- 歷史主題（32 個歷史部落格與播客）→ `--profile history`

若使用者輸入 `/digest ai`、`/digest quant` 或 `/digest history`，則直接使用指定的 profile。

依序詢問使用者以下設定（若使用者選擇沿用上次設定則跳過）：

**時間範圍** — 抓取多長時間內的文章？
- 24 小時（僅最近一天）
- 48 小時（推薦，涵蓋較全）
- 72 小時（最近三天）
- 7 天（一週內的文章）

**精選數量** — AI 篩選後保留幾篇？
- 10 篇（精簡版）
- 15 篇（推薦）
- 20 篇（擴展版）

**輸出語言** — 摘要使用什麼語言？
- 中文（推薦）
- English

### Step 1b：AI API Key（Anthropic 優先，Gemini 備援）

若設定中沒有任何已儲存的 API Key，請告知使用者：

> 請提供 AI API Key。優先順序：Anthropic Claude → Gemini → OpenAI-compatible。
> - Anthropic：使用 `ANTHROPIC_API_KEY`（優先級最高）
> - Gemini：前往 https://aistudio.google.com/apikey 建立免費 API Key
> - OpenAI-compatible：設定 `OPENAI_API_KEY`（可搭配 `OPENAI_API_BASE` 用於 DeepSeek 等）

若 `config.anthropicApiKey` 或 `config.geminiApiKey` 已存在，跳過此步。

### Step 1c：Heptabase 輸出（預設啟用）

告知使用者：

> 摘要將自動存入 Heptabase card。若不需要，請告知跳過。

若使用者明確要求跳過，則移除 `--heptabase` 參數。

### Step 2：執行腳本

腳本會自動從 `~/.hn-daily-digest/config.json` 讀取 API Key，不需要 export 環境變數。
腳本會自動建立 output 目錄（`mkdir -p`），不需要額外的 mkdir 指令。

**自動執行模式只需要一個 Bash 指令**（匹配 `Bash(npx:*)` 權限）：
```bash
npx -y bun ~/.claude/skills/digest/scripts/digest.ts \
  --profile <ai|quant> \
  --hours <timeRange> \
  --top-n <topN> \
  --lang <zh|en> \
  --output ./output/digest-<profile>-$(date +%Y%m%d).md \
  --heptabase
```

> **重要**：自動執行模式下不需要 `mkdir`、`export`、`Write`、`chmod` 等額外操作。所有 API Key 和設定由腳本從 config.json 讀取，output 目錄由腳本自動建立。這確保整個流程只觸發一次已授權的 `Bash(npx:*)` 呼叫，零中斷。

### Step 2b：儲存設定（僅限互動模式）

**自動執行模式下跳過此步**（config 未變更，無需重新儲存）。

僅在互動模式（首次設定或重新設定）時執行：
1. `mkdir -p ~/.hn-daily-digest`
2. 用 Write 工具寫入 `~/.hn-daily-digest/config.json`：
```json
{
  "anthropicApiKey": "<anthropic-key>",
  "geminiApiKey": "<key>",
  "openaiApiKey": "",
  "openaiApiBase": "",
  "openaiModel": "",
  "timeRange": <hours>,
  "topN": <topN>,
  "language": "<zh|en>",
  "heptabase": true,
  "lastUsed": "<ISO timestamp>"
}
```
3. `chmod 600 ~/.hn-daily-digest/config.json`

### Step 3：結果展示

**成功時**：
- 報告檔案路徑
- 簡要摘要：掃描源數、抓取文章數、精選文章數
- **今日精選 Top 3 預覽**：中文標題 + 一句話摘要
- **RSS 錯誤 log**：若有 feed 抓取失敗，會產生 `digest-{profile}-YYYYMMDD-errors.log` 於 output 同目錄
- **Heptabase 儲存狀態**：若啟用 `--heptabase`，顯示是否成功存入 Heptabase card

**報告結構**（產生的 Markdown 檔案包含以下區塊）：
1. **今日看點** — AI 歸納的 3-5 句宏觀趨勢總結
2. **今日必讀 Top 3** — 中英雙語標題、摘要、推薦理由、關鍵詞標籤
3. **數據概覽** — 統計表格 + Mermaid 分類圓餅圖 + 高頻關鍵詞柱狀圖 + ASCII 純文字圖 + 話題標籤雲
4. **分類文章列表** — 按 profile 定義的分類分組展示

**失敗時**：
- 顯示錯誤訊息
- 常見問題：API Key 無效、網路問題、RSS 來源無法存取

---

## 參數對應

| 互動選項 | 腳本參數 |
|----------|----------|
| AI/技術 | `--profile ai`（預設） |
| 量化金融 | `--profile quant` |
| 歷史主題 | `--profile history` |
| 24 小時 | `--hours 24` |
| 48 小時 | `--hours 48` |
| 72 小時 | `--hours 72` |
| 7 天 | `--hours 168` |
| 10 篇 | `--top-n 10` |
| 15 篇 | `--top-n 15` |
| 20 篇 | `--top-n 20` |
| 限制 RSS 來源數 | `--feeds <n>`（預設抓全部，測試時可用 `--feeds 3`） |
| 中文 | `--lang zh` |
| English | `--lang en` |
| 存入 Heptabase | `--heptabase`（需已安裝 heptabase CLI 並登入） |

---

## 環境需求

- `bun` 執行環境（透過 `npx -y bun` 自動安裝）
- 至少一個 AI API Key（`ANTHROPIC_API_KEY`、`GEMINI_API_KEY` 或 `OPENAI_API_KEY`）
- API Key 可透過環境變數或 `~/.hn-daily-digest/config.json` 設定（env vars 優先）
- Provider 優先順序：Anthropic Claude → Gemini → OpenAI-compatible（自動降級）
- 可選：`OPENAI_API_BASE`、`OPENAI_MODEL`（用於 OpenAI 相容介面）
- 可選：Heptabase CLI（`heptabase auth login`）— 啟用 `--heptabase` 時需要
- 網路存取（需能存取 RSS 來源和 AI API）

---

## 可用 Profiles

### `ai` — AI/技術（預設）
90 個 RSS 來源取自 [Hacker News Popularity Contest 2025](https://refactoringenglish.com/tools/hn-popularity/)，由 [Andrej Karpathy](https://x.com/karpathy) 推薦。包括：simonwillison.net、paulgraham.com、overreacted.io、gwern.net、krebsonsecurity.com 等頂級技術部落格。

分類：AI/ML、安全、工程、工具/開源、觀點/雜談、其他

### `quant` — 量化金融
20 個量化金融相關 RSS 來源，涵蓋 Quantocracy、QuantStart、Alpha Architect、AQR Insights 等。

分類：Alpha 研究、市場微結構、風控、量化工具、總經評論、其他

### `history` — 歷史主題
32 個歷史相關 RSS 來源與播客，涵蓋通史（RealClearHistory、HistoryExtra、World History Encyclopedia）、古典世界（ACOUP、Antigone Journal）、中世紀（Medievalists.net、Going Medieval）、軍事政治（HistoryNet、War on the Rocks）、科技文化史（JHI Blog、Nursing Clio）、播客（Throughline、The Rest Is History、Fall of Civilizations）等。

分類：古典世界、中世紀與近世、近現代史、軍事與政治史、科技與文化史、其他

---

## 新增自訂 Profile

在 `profiles/` 目錄下新增 `<name>.json`，結構參考 `profiles/ai.json`。主要欄位：

- `feeds` — RSS 來源列表
- `categories` — 分類定義（ID、emoji、label）
- `prompts` — AI 評分和摘要的領域用語
- `report` — 報告標題、副標題、footer

---

## 疑難排解

### "Profile not found"
確認 `profiles/<name>.json` 存在。執行 `--help` 可查看可用的 profiles。

### "Missing API key"
需要至少一個 API Key。設定 `ANTHROPIC_API_KEY`（推薦）、`GEMINI_API_KEY`（免費）或 `OPENAI_API_KEY`。
也可以在 `~/.hn-daily-digest/config.json` 中設定。

### "Anthropic/Gemini 請求失敗"
腳本會自動降級到下一個可用的 provider（Anthropic → Gemini → OpenAI-compatible）。

### "Failed to fetch N feeds"
部分 RSS 來源可能暫時無法存取，腳本會跳過失敗的來源並繼續處理。

### "No articles found in time range"
嘗試擴大時間範圍（如從 24 小時改為 48 小時）。
