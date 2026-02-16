# AI Daily Digest - Claude Code Skill 適配筆記

## 資安審查摘要

- `scripts/digest.ts` 僅進行 HTTP GET (RSS) 與 POST (AI API) 請求，無檔案系統寫入（除輸出報告）
- API Key 透過環境變數傳入，不寫入程式碼
- config.json 儲存於 `~/.hn-daily-digest/config.json`，含 API Key，需設定 `chmod 600`
- 無 `eval()`、無動態 import、無 shell exec
- RSS 內容經 `stripHtml()` 清理後才使用

## 相容性分析

- 原 skill 為 OpenCode 格式，使用 `question()` 互動 API（Claude Code 不支援）
- `${SKILL_DIR}` 為 OpenCode 變數，Claude Code 需硬編碼路徑
- Bun runtime 透過 `npx -y bun` 執行，相容性良好

## 模型版本更新

| 位置 | 舊值 | 新值 |
|------|------|------|
| L9 `GEMINI_API_URL` | `gemini-2.0-flash` | `gemini-3.0-flash` |
| L11 `OPENAI_DEFAULT_MODEL` | `gpt-4o-mini` | `gpt-5-mini` |

## 修改清單

1. **SKILL.md**: OpenCode → Claude Code 格式，正體中文，移除 question()，硬編碼路徑
2. **scripts/digest.ts**: 更新模型版本，移除 L992 廣告文字
3. **CLAUDE.md**: 本文件（研究結果）
