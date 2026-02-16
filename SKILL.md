---
name: ai-daily-digest
description: "Fetches RSS feeds from 90 top Hacker News blogs (curated by Karpathy), uses AI to score and filter articles, and generates a daily digest in Markdown with Chinese-translated titles, category grouping, trend highlights, and visual statistics (Mermaid charts + tag cloud). Use when user mentions 'daily digest', 'RSS digest', 'blog digest', 'AI blogs', 'tech news summary', or asks to run /digest command. Trigger command: /digest."
---

# AI Daily Digest

從 Karpathy 推薦的 90 個熱門技術部落格抓取最新文章，透過 AI 評分篩選，產生每日精選摘要。

## 指令

### `/digest`

執行每日摘要產生器。

**使用方式**：輸入 `/digest`，Agent 透過互動引導收集參數後執行。

---

## 腳本目錄

**重要**：所有腳本位於 `~/.claude/skills/ai-daily-digest/scripts/`。

| 腳本 | 用途 |
|------|------|
| `scripts/digest.ts` | 主腳本 — RSS 抓取、AI 評分、產生摘要 |

---

## 設定持久化

設定檔路徑：`~/.hn-daily-digest/config.json`

Agent 在執行前**必須檢查**此檔案是否存在：
1. 若存在，讀取並解析 JSON
2. 詢問使用者是否使用已儲存的設定
3. 執行完成後儲存目前設定到此檔案，並設定 `chmod 600 ~/.hn-daily-digest/config.json` 保護 API Key

**設定檔結構**：
```json
{
  "geminiApiKey": "",
  "timeRange": 48,
  "topN": 15,
  "language": "zh",
  "lastUsed": "2026-02-16T12:00:00Z"
}
```

---

## 互動流程

### Step 0：檢查已儲存設定

```bash
cat ~/.hn-daily-digest/config.json 2>/dev/null || echo "NO_CONFIG"
```

若設定存在且有 `geminiApiKey`，詢問使用者：

> 偵測到上次使用的設定：
> - 時間範圍：{timeRange} 小時
> - 精選數量：{topN} 篇
> - 輸出語言：{language === 'zh' ? '中文' : 'English'}
>
> 請問要使用上次設定直接執行，還是重新設定？

### Step 1：收集參數

依序詢問使用者以下三個設定（若使用者選擇沿用上次設定則跳過）：

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

### Step 1b：AI API Key（Gemini 優先，支援備援）

若設定中沒有已儲存的 API Key，請告知使用者：

> 請提供 Gemini API Key 作為主模型（可選再設定 OPENAI_API_KEY 備援）。
> 取得方式：前往 https://aistudio.google.com/apikey 建立免費 API Key。

若 `config.geminiApiKey` 已存在，跳過此步。

### Step 2：執行腳本

```bash
mkdir -p ./output

export GEMINI_API_KEY="<key>"
# 可選：OpenAI 相容備援（DeepSeek/OpenAI 等）
export OPENAI_API_KEY="<fallback-key>"
export OPENAI_API_BASE="https://api.deepseek.com/v1"
export OPENAI_MODEL="deepseek-chat"

npx -y bun ~/.claude/skills/ai-daily-digest/scripts/digest.ts \
  --hours <timeRange> \
  --top-n <topN> \
  --lang <zh|en> \
  --output ./output/digest-$(date +%Y%m%d).md
```

### Step 2b：儲存設定

```bash
mkdir -p ~/.hn-daily-digest
cat > ~/.hn-daily-digest/config.json << 'EOF'
{
  "geminiApiKey": "<key>",
  "timeRange": <hours>,
  "topN": <topN>,
  "language": "<zh|en>",
  "lastUsed": "<ISO timestamp>"
}
EOF
chmod 600 ~/.hn-daily-digest/config.json
```

### Step 3：結果展示

**成功時**：
- 報告檔案路徑
- 簡要摘要：掃描源數、抓取文章數、精選文章數
- **今日精選 Top 3 預覽**：中文標題 + 一句話摘要

**報告結構**（產生的 Markdown 檔案包含以下區塊）：
1. **今日看點** — AI 歸納的 3-5 句宏觀趨勢總結
2. **今日必讀 Top 3** — 中英雙語標題、摘要、推薦理由、關鍵詞標籤
3. **數據概覽** — 統計表格 + Mermaid 分類圓餅圖 + 高頻關鍵詞柱狀圖 + ASCII 純文字圖 + 話題標籤雲
4. **分類文章列表** — 按 6 大分類（AI/ML、安全、工程、工具/開源、觀點/雜談、其他）分組展示

**失敗時**：
- 顯示錯誤訊息
- 常見問題：API Key 無效、網路問題、RSS 來源無法存取

---

## 參數對應

| 互動選項 | 腳本參數 |
|----------|----------|
| 24 小時 | `--hours 24` |
| 48 小時 | `--hours 48` |
| 72 小時 | `--hours 72` |
| 7 天 | `--hours 168` |
| 10 篇 | `--top-n 10` |
| 15 篇 | `--top-n 15` |
| 20 篇 | `--top-n 20` |
| 中文 | `--lang zh` |
| English | `--lang en` |

---

## 環境需求

- `bun` 執行環境（透過 `npx -y bun` 自動安裝）
- 至少一個 AI API Key（`GEMINI_API_KEY` 或 `OPENAI_API_KEY`）
- 可選：`OPENAI_API_BASE`、`OPENAI_MODEL`（用於 OpenAI 相容介面）
- 網路存取（需能存取 RSS 來源和 AI API）

---

## 資訊來源

90 個 RSS 來源取自 [Hacker News Popularity Contest 2025](https://refactoringenglish.com/tools/hn-popularity/)，由 [Andrej Karpathy](https://x.com/karpathy) 推薦。

包括：simonwillison.net、paulgraham.com、overreacted.io、gwern.net、krebsonsecurity.com、antirez.com、daringfireball.net 等頂級技術部落格。

完整列表內嵌於腳本中。

---

## 疑難排解

### "GEMINI_API_KEY not set"
需要提供 Gemini API Key，可在 https://aistudio.google.com/apikey 免費取得。

### "Gemini 配額超限或請求失敗"
腳本會自動降級到 OpenAI 相容介面（需提供 `OPENAI_API_KEY`，可選 `OPENAI_API_BASE`）。

### "Failed to fetch N feeds"
部分 RSS 來源可能暫時無法存取，腳本會跳過失敗的來源並繼續處理。

### "No articles found in time range"
嘗試擴大時間範圍（如從 24 小時改為 48 小時）。
