import { writeFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { homedir } from 'node:os';
import process from 'node:process';

// ============================================================================
// Constants
// ============================================================================

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
const OPENAI_DEFAULT_API_BASE = 'https://api.openai.com/v1';
const OPENAI_DEFAULT_MODEL = 'gpt-5-mini';
const FEED_FETCH_TIMEOUT_MS = 15_000;
const FEED_CONCURRENCY = 10;
const GEMINI_BATCH_SIZE = 10;
const MAX_CONCURRENT_GEMINI = 2;

// ============================================================================
// Domain Profile
// ============================================================================

export interface DomainProfile {
  id: string;
  name: string;
  description: string;

  feeds: Array<{ name: string; xmlUrl: string; htmlUrl: string }>;

  categories: Record<string, { emoji: string; label: string }>;

  prompts: {
    curatorRole: string;
    audience: string;
    relevanceRubric: {
      score10: string;
      score7to9: string;
      score4to6: string;
      score1to3: string;
    };
    categoryDescriptions: Record<string, string>;
    keywordInstruction: string;
    summaryRole: string;
    summaryDomainHint: string;
    highlightsDomain: string;
  };

  report: {
    title: string;
    subtitle: string;
    footerLines: string[];
  };
}

export async function loadProfile(profileName: string): Promise<DomainProfile> {
  const scriptDir = dirname(new URL(import.meta.url).pathname);
  const profilePath = `${scriptDir}/../profiles/${profileName}.json`;
  try {
    const raw = await readFile(profilePath, 'utf-8');
    return JSON.parse(raw) as DomainProfile;
  } catch (error) {
    const available = await listProfiles();
    throw new Error(
      `Profile "${profileName}" not found at ${profilePath}.\nAvailable profiles: ${available.join(', ') || 'none'}`
    );
  }
}

export async function listProfiles(): Promise<string[]> {
  const scriptDir = dirname(new URL(import.meta.url).pathname);
  const profilesDir = `${scriptDir}/../profiles`;
  try {
    const files = await readdir(profilesDir);
    return files
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace(/\.json$/, ''));
  } catch {
    return [];
  }
}

// ============================================================================
// Types
// ============================================================================

interface Article {
  title: string;
  link: string;
  pubDate: Date;
  description: string;
  sourceName: string;
  sourceUrl: string;
}

interface ScoredArticle extends Article {
  score: number;
  scoreBreakdown: {
    relevance: number;
    quality: number;
    timeliness: number;
  };
  category: string;
  keywords: string[];
  titleZh: string;
  summary: string;
  reason: string;
}

interface GeminiScoringResult {
  results: Array<{
    index: number;
    relevance: number;
    quality: number;
    timeliness: number;
    category: string;
    keywords: string[];
  }>;
}

interface GeminiSummaryResult {
  results: Array<{
    index: number;
    titleZh: string;
    summary: string;
    reason: string;
  }>;
}

interface FeedError {
  feedName: string;
  feedUrl: string;
  message: string;
}

interface FeedResult {
  articles: Article[];
  error?: FeedError;
}

interface FetchAllResult {
  articles: Article[];
  errors: FeedError[];
}

interface AIClient {
  call(prompt: string): Promise<string>;
}

// ============================================================================
// RSS/Atom Parsing (using Bun's built-in HTMLRewriter or manual XML parsing)
// ============================================================================

export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)))
    .trim();
}

export function extractCDATA(text: string): string {
  const cdataMatch = text.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  return cdataMatch ? cdataMatch[1] : text;
}

export function getTagContent(xml: string, tagName: string): string {
  // Handle namespaced and non-namespaced tags
  const patterns = [
    new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`, 'i'),
    new RegExp(`<${tagName}[^>]*/>`, 'i'), // self-closing
  ];
  
  for (const pattern of patterns) {
    const match = xml.match(pattern);
    if (match?.[1]) {
      return extractCDATA(match[1]).trim();
    }
  }
  return '';
}

export function getAttrValue(xml: string, tagName: string, attrName: string): string {
  const pattern = new RegExp(`<${tagName}[^>]*\\s${attrName}=["']([^"']*)["'][^>]*/?>`, 'i');
  const match = xml.match(pattern);
  return match?.[1] || '';
}

export function parseDate(dateStr: string): Date | null {
  if (!dateStr) return null;
  
  const d = new Date(dateStr);
  if (!isNaN(d.getTime())) return d;
  
  // Try common RSS date formats
  // RFC 822: "Mon, 01 Jan 2024 00:00:00 GMT"
  const rfc822 = dateStr.match(/(\d{1,2})\s+(\w{3})\s+(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (rfc822) {
    const parsed = new Date(dateStr);
    if (!isNaN(parsed.getTime())) return parsed;
  }
  
  return null;
}

export function parseRSSItems(xml: string): Array<{ title: string; link: string; pubDate: string; description: string }> {
  const items: Array<{ title: string; link: string; pubDate: string; description: string }> = [];
  
  // Detect format: Atom vs RSS
  const isAtom = xml.includes('<feed') && xml.includes('xmlns="http://www.w3.org/2005/Atom"') || xml.includes('<feed ');
  
  if (isAtom) {
    // Atom format: <entry>
    const entryPattern = /<entry[\s>]([\s\S]*?)<\/entry>/gi;
    let entryMatch;
    while ((entryMatch = entryPattern.exec(xml)) !== null) {
      const entryXml = entryMatch[1];
      const title = stripHtml(getTagContent(entryXml, 'title'));
      
      // Atom link: <link href="..." rel="alternate"/>
      let link = getAttrValue(entryXml, 'link[^>]*rel="alternate"', 'href');
      if (!link) {
        link = getAttrValue(entryXml, 'link', 'href');
      }
      
      const pubDate = getTagContent(entryXml, 'published') 
        || getTagContent(entryXml, 'updated');
      
      const description = stripHtml(
        getTagContent(entryXml, 'summary') 
        || getTagContent(entryXml, 'content')
      );
      
      if (title || link) {
        items.push({ title, link, pubDate, description: description.slice(0, 500) });
      }
    }
  } else {
    // RSS format: <item>
    const itemPattern = /<item[\s>]([\s\S]*?)<\/item>/gi;
    let itemMatch;
    while ((itemMatch = itemPattern.exec(xml)) !== null) {
      const itemXml = itemMatch[1];
      const title = stripHtml(getTagContent(itemXml, 'title'));
      const link = getTagContent(itemXml, 'link') || getTagContent(itemXml, 'guid');
      const pubDate = getTagContent(itemXml, 'pubDate') 
        || getTagContent(itemXml, 'dc:date')
        || getTagContent(itemXml, 'date');
      const description = stripHtml(
        getTagContent(itemXml, 'description') 
        || getTagContent(itemXml, 'content:encoded')
      );
      
      if (title || link) {
        items.push({ title, link, pubDate, description: description.slice(0, 500) });
      }
    }
  }
  
  return items;
}

// ============================================================================
// Feed Fetching
// ============================================================================

async function fetchFeed(feed: { name: string; xmlUrl: string; htmlUrl: string }): Promise<FeedResult> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FEED_FETCH_TIMEOUT_MS);

    const response = await fetch(feed.xmlUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'AI-Daily-Digest/1.0 (RSS Reader)',
        'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      },
    });

    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const xml = await response.text();
    const items = parseRSSItems(xml);

    return {
      articles: items.map(item => ({
        title: item.title,
        link: item.link,
        pubDate: parseDate(item.pubDate) || new Date(0),
        description: item.description,
        sourceName: feed.name,
        sourceUrl: feed.htmlUrl,
      })),
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const displayMsg = msg.includes('abort') ? 'timeout' : msg;
    console.warn(`[digest] ✗ ${feed.name}: ${displayMsg}`);
    return {
      articles: [],
      error: { feedName: feed.name, feedUrl: feed.xmlUrl, message: displayMsg },
    };
  }
}

async function fetchAllFeeds(feeds: Array<{ name: string; xmlUrl: string; htmlUrl: string }>): Promise<FetchAllResult> {
  const allArticles: Article[] = [];
  const allErrors: FeedError[] = [];
  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < feeds.length; i += FEED_CONCURRENCY) {
    const batch = feeds.slice(i, i + FEED_CONCURRENCY);
    const results = await Promise.allSettled(batch.map(fetchFeed));

    for (const result of results) {
      if (result.status === 'fulfilled') {
        const { articles, error } = result.value;
        if (articles.length > 0) {
          allArticles.push(...articles);
          successCount++;
        } else if (error) {
          allErrors.push(error);
          failCount++;
        } else {
          failCount++;
        }
      } else {
        failCount++;
      }
    }

    const progress = Math.min(i + FEED_CONCURRENCY, feeds.length);
    console.log(`[digest] Progress: ${progress}/${feeds.length} feeds processed (${successCount} ok, ${failCount} failed)`);
  }

  console.log(`[digest] Fetched ${allArticles.length} articles from ${successCount} feeds (${failCount} failed)`);
  return { articles: allArticles, errors: allErrors };
}

// ============================================================================
// AI Providers (Gemini + OpenAI-compatible fallback)
// ============================================================================

async function callGemini(prompt: string, apiKey: string): Promise<string> {
  const response = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.3,
        topP: 0.8,
        topK: 40,
      },
    }),
  });
  
  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new Error(`Gemini API error (${response.status}): ${errorText}`);
  }
  
  const data = await response.json() as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
    }>;
  };
  
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

async function callOpenAICompatible(
  prompt: string,
  apiKey: string,
  apiBase: string,
  model: string
): Promise<string> {
  const normalizedBase = apiBase.replace(/\/+$/, '');
  // Models like gpt-5-mini, o1, o3 series don't support temperature
  const supportsTemperature = !/^(o[0-9]|gpt-5)/.test(model);
  const body: Record<string, unknown> = {
    model,
    messages: [{ role: 'user', content: prompt }],
  };
  if (supportsTemperature) {
    body.temperature = 0.3;
    body.top_p = 0.8;
  }
  const response = await fetch(`${normalizedBase}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new Error(`OpenAI-compatible API error (${response.status}): ${errorText}`);
  }

  const data = await response.json() as {
    choices?: Array<{
      message?: {
        content?: string | Array<{ type?: string; text?: string }>;
      };
    }>;
  };

  const content = data.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(item => item.type === 'text' && typeof item.text === 'string')
      .map(item => item.text)
      .join('\n');
  }
  return '';
}

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_DEFAULT_MODEL = 'claude-sonnet-4-5-20250929';

async function callAnthropic(prompt: string, apiKey: string, model?: string): Promise<string> {
  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: model || ANTHROPIC_DEFAULT_MODEL,
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      top_p: 0.8,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new Error(`Anthropic API error (${response.status}): ${errorText}`);
  }

  const data = await response.json() as {
    content?: Array<{ type: string; text: string }>;
  };

  return data.content?.find(c => c.type === 'text')?.text || '';
}

function inferOpenAIModel(apiBase: string): string {
  const base = apiBase.toLowerCase();
  if (base.includes('deepseek')) return 'deepseek-chat';
  return OPENAI_DEFAULT_MODEL;
}

function createAIClient(config: {
  anthropicApiKey?: string;
  anthropicModel?: string;
  geminiApiKey?: string;
  openaiApiKey?: string;
  openaiApiBase?: string;
  openaiModel?: string;
}): AIClient {
  const state = {
    anthropicApiKey: config.anthropicApiKey?.trim() || '',
    anthropicModel: config.anthropicModel?.trim() || '',
    anthropicEnabled: Boolean(config.anthropicApiKey?.trim()),
    geminiApiKey: config.geminiApiKey?.trim() || '',
    openaiApiKey: config.openaiApiKey?.trim() || '',
    openaiApiBase: (config.openaiApiBase?.trim() || OPENAI_DEFAULT_API_BASE).replace(/\/+$/, ''),
    openaiModel: config.openaiModel?.trim() || '',
    geminiEnabled: Boolean(config.geminiApiKey?.trim()),
    fallbackLogged: false,
  };

  if (!state.openaiModel) {
    state.openaiModel = inferOpenAIModel(state.openaiApiBase);
  }

  return {
    async call(prompt: string): Promise<string> {
      // 1. Try Anthropic first (highest priority)
      if (state.anthropicEnabled && state.anthropicApiKey) {
        try {
          return await callAnthropic(prompt, state.anthropicApiKey, state.anthropicModel || undefined);
        } catch (error) {
          if (state.geminiApiKey || state.openaiApiKey) {
            if (!state.fallbackLogged) {
              console.warn(`[digest] Anthropic failed, falling back. Reason: ${error instanceof Error ? error.message : String(error)}`);
              state.fallbackLogged = true;
            }
            state.anthropicEnabled = false;
            // fall through to Gemini or OpenAI
          } else {
            throw error;
          }
        }
      }

      // 2. Try Gemini
      if (state.geminiEnabled && state.geminiApiKey) {
        try {
          return await callGemini(prompt, state.geminiApiKey);
        } catch (error) {
          if (state.openaiApiKey) {
            if (!state.fallbackLogged) {
              const reason = error instanceof Error ? error.message : String(error);
              console.warn(`[digest] Gemini failed, switching to OpenAI-compatible fallback (${state.openaiApiBase}, model=${state.openaiModel}). Reason: ${reason}`);
              state.fallbackLogged = true;
            }
            state.geminiEnabled = false;
            return callOpenAICompatible(prompt, state.openaiApiKey, state.openaiApiBase, state.openaiModel);
          }
          throw error;
        }
      }

      // 3. Try OpenAI-compatible
      if (state.openaiApiKey) {
        return callOpenAICompatible(prompt, state.openaiApiKey, state.openaiApiBase, state.openaiModel);
      }

      throw new Error('No AI API key configured. Set ANTHROPIC_API_KEY, GEMINI_API_KEY, and/or OPENAI_API_KEY.');
    },
  };
}

function parseJsonResponse<T>(text: string): T {
  let jsonText = text.trim();
  // Strip markdown code blocks if present
  if (jsonText.startsWith('```')) {
    jsonText = jsonText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }
  return JSON.parse(jsonText) as T;
}

// ============================================================================
// AI Scoring
// ============================================================================

export function buildScoringPrompt(
  articles: Array<{ index: number; title: string; description: string; sourceName: string }>,
  profile: DomainProfile
): string {
  const articlesList = articles.map(a =>
    `Index ${a.index}: [${a.sourceName}] ${a.title}\n${a.description.slice(0, 300)}`
  ).join('\n\n---\n\n');

  const p = profile.prompts;
  const categoryList = Object.entries(profile.prompts.categoryDescriptions)
    .map(([id, desc]) => `- ${id}: ${desc}`)
    .join('\n');

  return `${p.curatorRole}

請對以下文章進行三個維度的評分（1-10 整數，10 分最高），並為每篇文章分配一個分類標籤和提取 2-4 個關鍵詞。

## 評分維度

### 1. 相關性 (relevance) - ${p.audience}
- 10: ${p.relevanceRubric.score10}
- 7-9: ${p.relevanceRubric.score7to9}
- 4-6: ${p.relevanceRubric.score4to6}
- 1-3: ${p.relevanceRubric.score1to3}

### 2. 品質 (quality) - 文章本身的深度和寫作品質
- 10: 深度分析，原創洞見，引用豐富
- 7-9: 有深度，觀點獨到
- 4-6: 資訊準確，表達清晰
- 1-3: 淺嘗輒止或純轉述

### 3. 時效性 (timeliness) - 當前是否值得閱讀
- 10: 正在發生的重大事件/剛發佈的重要工具
- 7-9: 近期熱點相關
- 4-6: 常青內容，不過時
- 1-3: 過時或無時效價值

## 分類標籤（必須從以下選一個）
${categoryList}

## 關鍵詞提取
提取 2-4 個最能代表文章主題的關鍵詞（${p.keywordInstruction}）

## 待評分文章

${articlesList}

請嚴格按 JSON 格式返回，不要包含 markdown 程式碼區塊或其他文字：
{
  "results": [
    {
      "index": 0,
      "relevance": 8,
      "quality": 7,
      "timeliness": 9,
      "category": "${Object.keys(profile.categories)[0] || 'other'}",
      "keywords": ["keyword1", "keyword2", "keyword3"]
    }
  ]
}`;
}

async function scoreArticlesWithAI(
  articles: Article[],
  aiClient: AIClient,
  profile: DomainProfile
): Promise<Map<number, { relevance: number; quality: number; timeliness: number; category: string; keywords: string[] }>> {
  const allScores = new Map<number, { relevance: number; quality: number; timeliness: number; category: string; keywords: string[] }>();
  
  const indexed = articles.map((article, index) => ({
    index,
    title: article.title,
    description: article.description,
    sourceName: article.sourceName,
  }));
  
  const batches: typeof indexed[] = [];
  for (let i = 0; i < indexed.length; i += GEMINI_BATCH_SIZE) {
    batches.push(indexed.slice(i, i + GEMINI_BATCH_SIZE));
  }
  
  console.log(`[digest] AI scoring: ${articles.length} articles in ${batches.length} batches`);
  
  const validCategories = new Set<string>(Object.keys(profile.categories));

  for (let i = 0; i < batches.length; i += MAX_CONCURRENT_GEMINI) {
    const batchGroup = batches.slice(i, i + MAX_CONCURRENT_GEMINI);
    const promises = batchGroup.map(async (batch) => {
      try {
        const prompt = buildScoringPrompt(batch, profile);
        const responseText = await aiClient.call(prompt);
        const parsed = parseJsonResponse<GeminiScoringResult>(responseText);

        if (parsed.results && Array.isArray(parsed.results)) {
          for (const result of parsed.results) {
            const clamp = (v: number) => Math.min(10, Math.max(1, Math.round(v)));
            const cat = validCategories.has(result.category) ? result.category : 'other';
            allScores.set(result.index, {
              relevance: clamp(result.relevance),
              quality: clamp(result.quality),
              timeliness: clamp(result.timeliness),
              category: cat,
              keywords: Array.isArray(result.keywords) ? result.keywords.slice(0, 4) : [],
            });
          }
        }
      } catch (error) {
        console.warn(`[digest] Scoring batch failed: ${error instanceof Error ? error.message : String(error)}`);
        for (const item of batch) {
          allScores.set(item.index, { relevance: 5, quality: 5, timeliness: 5, category: 'other', keywords: [] });
        }
      }
    });
    
    await Promise.all(promises);
    console.log(`[digest] Scoring progress: ${Math.min(i + MAX_CONCURRENT_GEMINI, batches.length)}/${batches.length} batches`);
  }
  
  return allScores;
}

// ============================================================================
// AI Summarization
// ============================================================================

export function buildSummaryPrompt(
  articles: Array<{ index: number; title: string; description: string; sourceName: string; link: string }>,
  lang: 'zh' | 'en',
  profile: DomainProfile
): string {
  const articlesList = articles.map(a =>
    `Index ${a.index}: [${a.sourceName}] ${a.title}\nURL: ${a.link}\n${a.description.slice(0, 800)}`
  ).join('\n\n---\n\n');

  const langInstruction = lang === 'zh'
    ? '請用繁體中文撰寫摘要和推薦理由。如果原文是英文，請翻譯為繁體中文。標題翻譯也用繁體中文。'
    : 'Write summaries, reasons, and title translations in English.';

  const p = profile.prompts;

  return `${p.summaryRole}請為以下文章完成三件事：

1. **中文標題** (titleZh): 將英文標題翻譯成自然的繁體中文。如果原標題已經是中文則保持不變。
2. **摘要** (summary): 4-6 句話的結構化摘要，讓讀者不點進原文也能了解核心內容。包含：
   - 文章討論的核心問題或主題（1 句）
   - 關鍵論點、技術方案或發現（2-3 句）
   - 結論或作者的核心觀點（1 句）
3. **推薦理由** (reason): 1 句話說明「為什麼值得讀」，區別於摘要（摘要說「是什麼」，推薦理由說「為什麼」）。

${langInstruction}

摘要要求：
- 直接說重點，不要用「本文討論了...」、「這篇文章介紹了...」這種開頭
- 包含具體的${p.summaryDomainHint}
- 保留關鍵數字和指標（如效能提升百分比、使用者數、版本號等）
- 如果文章涉及對比或選型，要點出比較對象和結論
- 目標：讀者花 30 秒讀完摘要，就能決定是否值得花 10 分鐘讀原文

## 待摘要文章

${articlesList}

請嚴格按 JSON 格式返回：
{
  "results": [
    {
      "index": 0,
      "titleZh": "繁體中文翻譯的標題",
      "summary": "摘要內容...",
      "reason": "推薦理由..."
    }
  ]
}`;
}

async function summarizeArticles(
  articles: Array<Article & { index: number }>,
  aiClient: AIClient,
  lang: 'zh' | 'en',
  profile: DomainProfile
): Promise<Map<number, { titleZh: string; summary: string; reason: string }>> {
  const summaries = new Map<number, { titleZh: string; summary: string; reason: string }>();
  
  const indexed = articles.map(a => ({
    index: a.index,
    title: a.title,
    description: a.description,
    sourceName: a.sourceName,
    link: a.link,
  }));
  
  const batches: typeof indexed[] = [];
  for (let i = 0; i < indexed.length; i += GEMINI_BATCH_SIZE) {
    batches.push(indexed.slice(i, i + GEMINI_BATCH_SIZE));
  }
  
  console.log(`[digest] Generating summaries for ${articles.length} articles in ${batches.length} batches`);
  
  for (let i = 0; i < batches.length; i += MAX_CONCURRENT_GEMINI) {
    const batchGroup = batches.slice(i, i + MAX_CONCURRENT_GEMINI);
    const promises = batchGroup.map(async (batch) => {
      try {
        const prompt = buildSummaryPrompt(batch, lang, profile);
        const responseText = await aiClient.call(prompt);
        const parsed = parseJsonResponse<GeminiSummaryResult>(responseText);
        
        if (parsed.results && Array.isArray(parsed.results)) {
          for (const result of parsed.results) {
            summaries.set(result.index, {
              titleZh: result.titleZh || '',
              summary: result.summary || '',
              reason: result.reason || '',
            });
          }
        }
      } catch (error) {
        console.warn(`[digest] Summary batch failed: ${error instanceof Error ? error.message : String(error)}`);
        for (const item of batch) {
          summaries.set(item.index, { titleZh: item.title, summary: item.title, reason: '' });
        }
      }
    });
    
    await Promise.all(promises);
    console.log(`[digest] Summary progress: ${Math.min(i + MAX_CONCURRENT_GEMINI, batches.length)}/${batches.length} batches`);
  }
  
  return summaries;
}

// ============================================================================
// AI Highlights (Today's Trends)
// ============================================================================

async function generateHighlights(
  articles: ScoredArticle[],
  aiClient: AIClient,
  lang: 'zh' | 'en',
  profile: DomainProfile
): Promise<string> {
  const articleList = articles.slice(0, 10).map((a, i) =>
    `${i + 1}. [${a.category}] ${a.titleZh || a.title} — ${a.summary.slice(0, 100)}`
  ).join('\n');

  const langNote = lang === 'zh' ? '用繁體中文回答。' : 'Write in English.';
  const domain = profile.prompts.highlightsDomain;

  const prompt = `根據以下今日精選文章列表，寫一段 3-5 句話的「今日看點」總結。
要求：
- 提煉出今天${domain}的 2-3 個主要趨勢或話題
- 不要逐篇列舉，要做宏觀歸納
- 風格簡潔有力，像新聞導語
${langNote}

文章列表：
${articleList}

直接返回純文字總結，不要 JSON，不要 markdown 格式。`;

  try {
    const text = await aiClient.call(prompt);
    return text.trim();
  } catch (error) {
    console.warn(`[digest] Highlights generation failed: ${error instanceof Error ? error.message : String(error)}`);
    return '';
  }
}

// ============================================================================
// Visualization Helpers
// ============================================================================

function humanizeTime(pubDate: Date): string {
  const diffMs = Date.now() - pubDate.getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);

  if (diffMins < 60) return `${diffMins} 分鐘前`;
  if (diffHours < 24) return `${diffHours} 小時前`;
  if (diffDays < 7) return `${diffDays} 天前`;
  return pubDate.toISOString().slice(0, 10);
}

function generateKeywordBarChart(articles: ScoredArticle[]): string {
  const kwCount = new Map<string, number>();
  for (const a of articles) {
    for (const kw of a.keywords) {
      const normalized = kw.toLowerCase();
      kwCount.set(normalized, (kwCount.get(normalized) || 0) + 1);
    }
  }

  const sorted = Array.from(kwCount.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12);

  if (sorted.length === 0) return '';

  const labels = sorted.map(([k]) => `"${k}"`).join(', ');
  const values = sorted.map(([, v]) => v).join(', ');
  const maxVal = sorted[0][1];

  let chart = '```mermaid\n';
  chart += `xychart-beta\n`;
  chart += `    title "高頻關鍵詞"\n`;
  chart += `    x-axis [${labels}]\n`;
  chart += `    y-axis "出現次數" 0 --> ${maxVal + 2}\n`;
  chart += `    bar [${values}]\n`;
  chart += '```\n';

  return chart;
}

function generateCategoryPieChart(articles: ScoredArticle[], categories: Record<string, { emoji: string; label: string }>): string {
  const catCount = new Map<string, number>();
  for (const a of articles) {
    catCount.set(a.category, (catCount.get(a.category) || 0) + 1);
  }

  if (catCount.size === 0) return '';

  const sorted = Array.from(catCount.entries()).sort((a, b) => b[1] - a[1]);

  let chart = '```mermaid\n';
  chart += `pie showData\n`;
  chart += `    title "文章分類分布"\n`;
  for (const [cat, count] of sorted) {
    const meta = categories[cat] || { emoji: '📝', label: cat };
    chart += `    "${meta.emoji} ${meta.label}" : ${count}\n`;
  }
  chart += '```\n';

  return chart;
}

function generateAsciiBarChart(articles: ScoredArticle[]): string {
  const kwCount = new Map<string, number>();
  for (const a of articles) {
    for (const kw of a.keywords) {
      const normalized = kw.toLowerCase();
      kwCount.set(normalized, (kwCount.get(normalized) || 0) + 1);
    }
  }

  const sorted = Array.from(kwCount.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  if (sorted.length === 0) return '';

  const maxVal = sorted[0][1];
  const maxBarWidth = 20;
  const maxLabelLen = Math.max(...sorted.map(([k]) => k.length));

  let chart = '```\n';
  for (const [label, value] of sorted) {
    const barLen = Math.max(1, Math.round((value / maxVal) * maxBarWidth));
    const bar = '█'.repeat(barLen) + '░'.repeat(maxBarWidth - barLen);
    chart += `${label.padEnd(maxLabelLen)} │ ${bar} ${value}\n`;
  }
  chart += '```\n';

  return chart;
}

function generateTagCloud(articles: ScoredArticle[]): string {
  const kwCount = new Map<string, number>();
  for (const a of articles) {
    for (const kw of a.keywords) {
      const normalized = kw.toLowerCase();
      kwCount.set(normalized, (kwCount.get(normalized) || 0) + 1);
    }
  }

  const sorted = Array.from(kwCount.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20);

  if (sorted.length === 0) return '';

  return sorted
    .map(([word, count], i) => i < 3 ? `**${word}**(${count})` : `${word}(${count})`)
    .join(' · ');
}

// ============================================================================
// Report Generation
// ============================================================================

function generateDigestReport(articles: ScoredArticle[], highlights: string, stats: {
  totalFeeds: number;
  successFeeds: number;
  totalArticles: number;
  filteredArticles: number;
  hours: number;
  lang: string;
}, profile: DomainProfile): string {
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];

  const subtitle = profile.report.subtitle
    .replace('{totalFeeds}', String(stats.totalFeeds))
    .replace('{topN}', String(articles.length));

  let report = `${profile.report.title} — ${dateStr}\n\n`;
  report += `${subtitle}\n\n`;

  // ── Today's Highlights ──
  if (highlights) {
    report += `## 📝 今日看點\n\n`;
    report += `${highlights}\n\n`;
    report += `---\n\n`;
  }

  // ── Top 3 Deep Showcase ──
  if (articles.length >= 3) {
    report += `## 🏆 今日必讀\n\n`;
    for (let i = 0; i < Math.min(3, articles.length); i++) {
      const a = articles[i];
      const medal = ['🥇', '🥈', '🥉'][i];
      const catMeta = profile.categories[a.category] || { emoji: '📝', label: a.category };

      report += `${medal} **${a.titleZh || a.title}**\n\n`;
      report += `[${a.title}](${a.link}) — ${a.sourceName} · ${humanizeTime(a.pubDate)} · ${catMeta.emoji} ${catMeta.label}\n\n`;
      report += `> ${a.summary}\n\n`;
      if (a.reason) {
        report += `💡 **為什麼值得讀**: ${a.reason}\n\n`;
      }
      if (a.keywords.length > 0) {
        report += `🏷️ ${a.keywords.join(', ')}\n\n`;
      }
    }
    report += `---\n\n`;
  }

  // ── Visual Statistics ──
  report += `## 📊 數據概覽\n\n`;

  report += `| 掃描源 | 抓取文章 | 時間範圍 | 精選 |\n`;
  report += `|:---:|:---:|:---:|:---:|\n`;
  report += `| ${stats.successFeeds}/${stats.totalFeeds} | ${stats.totalArticles} 篇 → ${stats.filteredArticles} 篇 | ${stats.hours}h | **${articles.length} 篇** |\n\n`;

  const pieChart = generateCategoryPieChart(articles, profile.categories);
  if (pieChart) {
    report += `### 分類分布\n\n${pieChart}\n`;
  }

  const barChart = generateKeywordBarChart(articles);
  if (barChart) {
    report += `### 高頻關鍵詞\n\n${barChart}\n`;
  }

  const asciiChart = generateAsciiBarChart(articles);
  if (asciiChart) {
    report += `<details>\n<summary>📈 純文字關鍵詞圖（終端友好）</summary>\n\n${asciiChart}\n</details>\n\n`;
  }

  const tagCloud = generateTagCloud(articles);
  if (tagCloud) {
    report += `### 🏷️ 話題標籤\n\n${tagCloud}\n\n`;
  }

  report += `---\n\n`;

  // ── Category-Grouped Articles ──
  const categoryGroups = new Map<string, ScoredArticle[]>();
  for (const a of articles) {
    const list = categoryGroups.get(a.category) || [];
    list.push(a);
    categoryGroups.set(a.category, list);
  }

  const sortedCategories = Array.from(categoryGroups.entries())
    .sort((a, b) => b[1].length - a[1].length);

  let globalIndex = 0;
  for (const [catId, catArticles] of sortedCategories) {
    const catMeta = profile.categories[catId] || { emoji: '📝', label: catId };
    report += `## ${catMeta.emoji} ${catMeta.label}\n\n`;

    for (const a of catArticles) {
      globalIndex++;
      const scoreTotal = a.scoreBreakdown.relevance + a.scoreBreakdown.quality + a.scoreBreakdown.timeliness;

      report += `### ${globalIndex}. ${a.titleZh || a.title}\n\n`;
      report += `[${a.title}](${a.link}) — **${a.sourceName}** · ${humanizeTime(a.pubDate)} · ⭐ ${scoreTotal}/30\n\n`;
      report += `> ${a.summary}\n\n`;
      if (a.keywords.length > 0) {
        report += `🏷️ ${a.keywords.join(', ')}\n\n`;
      }
      report += `---\n\n`;
    }
  }

  // ── Footer ──
  report += `*產生於 ${dateStr} ${now.toISOString().split('T')[1]?.slice(0, 5) || ''} | 掃描 ${stats.successFeeds} 源 → 取得 ${stats.totalArticles} 篇 → 精選 ${articles.length} 篇*\n`;
  for (const line of profile.report.footerLines) {
    report += `${line}\n`;
  }

  return report;
}

// ============================================================================
// Heptabase Integration
// ============================================================================

async function saveToHeptabase(reportPath: string): Promise<void> {
  // 1. Check CLI exists
  const which = Bun.which('heptabase');
  if (!which) {
    console.warn('[digest] Heptabase CLI not found, skipping.');
    return;
  }

  // 2. Check auth status
  const authProc = Bun.spawn(['heptabase', 'auth', 'status'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const authOut = await new Response(authProc.stdout).text();
  const authExit = await authProc.exited;

  if (authExit !== 0) {
    console.warn('[digest] Heptabase auth invalid (not logged in), skipping.');
    return;
  }

  try {
    const parsed = JSON.parse(authOut) as { hasToken?: boolean; isValid?: boolean };
    if (!parsed.hasToken || !parsed.isValid) {
      console.warn('[digest] Heptabase token expired or missing, skipping. Run: heptabase auth login');
      return;
    }
  } catch {
    // If stdout is not JSON, check exit code was 0 (already verified above)
  }

  // 3. Save card — read file content and pass as argument
  const reportContent = await Bun.file(reportPath).text();
  const saveProc = Bun.spawn(['heptabase', 'save', reportContent], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timeoutMs = 30_000;
  const exitCode = await Promise.race([
    saveProc.exited,
    new Promise<number>(resolve => setTimeout(() => { saveProc.kill(); resolve(-1); }, timeoutMs)),
  ]);
  const saveOut = await new Response(saveProc.stdout).text();

  if (saveOut.includes('Card created successfully')) {
    console.log('[digest] ✅ Saved digest to Heptabase card');
  } else if (exitCode !== 0) {
    const errText = await new Response(saveProc.stderr).text();
    console.warn(`[digest] Failed to save to Heptabase: ${errText || saveOut}`);
  } else {
    console.log('[digest] ✅ Saved digest to Heptabase card');
  }
}

// ============================================================================
// CLI
// ============================================================================

function printUsage(): never {
  console.log(`AI Daily Digest - AI-powered RSS digest with multi-domain profiles

Usage:
  bun scripts/digest.ts [options]

Options:
  --profile <name>  Domain profile to use (default: ai). Available: ai, quant
  --hours <n>       Time range in hours (default: 48)
  --top-n <n>       Number of top articles to include (default: 15)
  --feeds <n>       Limit number of RSS feeds to fetch (default: all)
  --lang <lang>     Summary language: zh or en (default: zh)
  --output <path>   Output file path (default: ./digest-{profile}-YYYYMMDD.md)
  --heptabase       Save digest to Heptabase as a note card (requires heptabase CLI)
  --help            Show this help

Environment:
  ANTHROPIC_API_KEY Anthropic Claude API key (highest priority)
  GEMINI_API_KEY   Gemini API key. Get one at https://aistudio.google.com/apikey
  OPENAI_API_KEY   Optional fallback key for OpenAI-compatible APIs
  OPENAI_API_BASE  Optional fallback base URL (default: https://api.openai.com/v1)
  OPENAI_MODEL     Optional fallback model (default: deepseek-chat for DeepSeek base, else gpt-4o-mini)

  API keys can also be set in ~/.hn-daily-digest/config.json (env vars take priority).

Examples:
  bun scripts/digest.ts --profile ai --hours 24 --top-n 10 --lang zh
  bun scripts/digest.ts --profile quant --hours 72 --top-n 10
  bun scripts/digest.ts --feeds 3 --hours 72 --top-n 3
  bun scripts/digest.ts --hours 72 --top-n 20 --lang en --output ./my-digest.md
`);
  process.exit(0);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) printUsage();
  
  let profileName = 'ai';
  let hours = 48;
  let topN = 15;
  let feedLimit = 0;
  let lang: 'zh' | 'en' = 'zh';
  let outputPath = '';
  let heptabaseEnabled = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--profile' && args[i + 1]) {
      profileName = args[++i]!;
    } else if (arg === '--hours' && args[i + 1]) {
      hours = parseInt(args[++i]!, 10);
    } else if (arg === '--top-n' && args[i + 1]) {
      topN = parseInt(args[++i]!, 10);
    } else if (arg === '--feeds' && args[i + 1]) {
      feedLimit = parseInt(args[++i]!, 10);
    } else if (arg === '--lang' && args[i + 1]) {
      lang = args[++i] as 'zh' | 'en';
    } else if (arg === '--output' && args[i + 1]) {
      outputPath = args[++i]!;
    } else if (arg === '--heptabase') {
      heptabaseEnabled = true;
    }
  }

  // ── Load profile ──
  const profile = await loadProfile(profileName);
  
  // ── Load config.json ──
  const CONFIG_PATH = `${homedir()}/.hn-daily-digest/config.json`;

  interface DigestConfig {
    anthropicApiKey?: string;
    geminiApiKey?: string;
    openaiApiKey?: string;
    openaiApiBase?: string;
    openaiModel?: string;
    timeRange?: number;
    topN?: number;
    language?: string;
    lastUsed?: string;
  }

  let savedConfig: DigestConfig = {};
  try {
    const raw = await readFile(CONFIG_PATH, 'utf-8');
    savedConfig = JSON.parse(raw) as DigestConfig;
    console.log(`[digest] Loaded config from ${CONFIG_PATH}`);
  } catch {
    // config doesn't exist or unreadable, continue with env vars
  }

  // env vars take priority over config.json
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY || savedConfig.anthropicApiKey || '';
  const geminiApiKey = process.env.GEMINI_API_KEY || savedConfig.geminiApiKey || '';
  const openaiApiKey = process.env.OPENAI_API_KEY || savedConfig.openaiApiKey || '';
  const openaiApiBase = process.env.OPENAI_API_BASE || savedConfig.openaiApiBase || '';
  const openaiModel = process.env.OPENAI_MODEL || savedConfig.openaiModel || '';

  if (!anthropicApiKey && !geminiApiKey && !openaiApiKey) {
    console.error('[digest] Error: Missing API key. Set ANTHROPIC_API_KEY, GEMINI_API_KEY, and/or OPENAI_API_KEY.');
    console.error('[digest] Gemini key: https://aistudio.google.com/apikey');
    process.exit(1);
  }

  const aiClient = createAIClient({
    anthropicApiKey,
    geminiApiKey,
    openaiApiKey,
    openaiApiBase,
    openaiModel,
  });
  
  if (!outputPath) {
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    outputPath = `./digest-${profileName}-${dateStr}.md`;
  }

  console.log(`[digest] === ${profile.name} ===`);
  console.log(`[digest] Profile: ${profileName}`);
  console.log(`[digest] Time range: ${hours} hours`);
  console.log(`[digest] Top N: ${topN}`);
  console.log(`[digest] Language: ${lang}`);
  console.log(`[digest] Output: ${outputPath}`);
  console.log(`[digest] AI provider: ${anthropicApiKey ? 'Anthropic (primary)' : geminiApiKey ? 'Gemini (primary)' : 'OpenAI-compatible (primary)'}`);
  if (openaiApiKey) {
    const resolvedBase = (openaiApiBase?.trim() || OPENAI_DEFAULT_API_BASE).replace(/\/+$/, '');
    const resolvedModel = openaiModel?.trim() || inferOpenAIModel(resolvedBase);
    console.log(`[digest] Fallback: ${resolvedBase} (model=${resolvedModel})`);
  }
  console.log('');
  
  const feeds = feedLimit > 0 ? profile.feeds.slice(0, feedLimit) : profile.feeds;
  if (feedLimit > 0) {
    console.log(`[digest] Feed limit: ${feedLimit} (of ${profile.feeds.length} total)`);
  }
  console.log(`[digest] Step 1/5: Fetching ${feeds.length} RSS feeds...`);
  const { articles: allArticles, errors: feedErrors } = await fetchAllFeeds(feeds);

  if (allArticles.length === 0) {
    console.error('[digest] Error: No articles fetched from any feed. Check network connection.');
    process.exit(1);
  }
  
  console.log(`[digest] Step 2/5: Filtering by time range (${hours} hours)...`);
  const cutoffTime = new Date(Date.now() - hours * 60 * 60 * 1000);
  const recentArticles = allArticles.filter(a => a.pubDate.getTime() > cutoffTime.getTime());
  
  console.log(`[digest] Found ${recentArticles.length} articles within last ${hours} hours`);
  
  if (recentArticles.length === 0) {
    console.error(`[digest] Error: No articles found within the last ${hours} hours.`);
    console.error(`[digest] Try increasing --hours (e.g., --hours 168 for one week)`);
    process.exit(1);
  }
  
  console.log(`[digest] Step 3/5: AI scoring ${recentArticles.length} articles...`);
  const scores = await scoreArticlesWithAI(recentArticles, aiClient, profile);
  
  const scoredArticles = recentArticles.map((article, index) => {
    const score = scores.get(index) || { relevance: 5, quality: 5, timeliness: 5, category: 'other', keywords: [] };
    return {
      ...article,
      totalScore: score.relevance + score.quality + score.timeliness,
      breakdown: score,
    };
  });
  
  scoredArticles.sort((a, b) => b.totalScore - a.totalScore);
  const topArticles = scoredArticles.slice(0, topN);
  
  console.log(`[digest] Top ${topN} articles selected (score range: ${topArticles[topArticles.length - 1]?.totalScore || 0} - ${topArticles[0]?.totalScore || 0})`);
  
  console.log(`[digest] Step 4/5: Generating AI summaries...`);
  const indexedTopArticles = topArticles.map((a, i) => ({ ...a, index: i }));
  const summaries = await summarizeArticles(indexedTopArticles, aiClient, lang, profile);
  
  const finalArticles: ScoredArticle[] = topArticles.map((a, i) => {
    const sm = summaries.get(i) || { titleZh: a.title, summary: a.description.slice(0, 200), reason: '' };
    return {
      title: a.title,
      link: a.link,
      pubDate: a.pubDate,
      description: a.description,
      sourceName: a.sourceName,
      sourceUrl: a.sourceUrl,
      score: a.totalScore,
      scoreBreakdown: {
        relevance: a.breakdown.relevance,
        quality: a.breakdown.quality,
        timeliness: a.breakdown.timeliness,
      },
      category: a.breakdown.category,
      keywords: a.breakdown.keywords,
      titleZh: sm.titleZh,
      summary: sm.summary,
      reason: sm.reason,
    };
  });
  
  console.log(`[digest] Step 5/5: Generating today's highlights...`);
  const highlights = await generateHighlights(finalArticles, aiClient, lang, profile);
  
  const successfulSources = new Set(allArticles.map(a => a.sourceName));
  
  const report = generateDigestReport(finalArticles, highlights, {
    totalFeeds: feeds.length,
    successFeeds: successfulSources.size,
    totalArticles: allArticles.length,
    filteredArticles: recentArticles.length,
    hours,
    lang,
  }, profile);
  
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, report);

  // ── Error log ──
  if (feedErrors.length > 0) {
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const errorLogPath = `${dirname(outputPath)}/digest-${profileName}-${dateStr}-errors.log`;
    const errorLogContent = feedErrors
      .map(e => `[${e.feedName}] ${e.feedUrl} — ${e.message}`)
      .join('\n');
    await writeFile(errorLogPath, errorLogContent + '\n');
    console.log(`[digest] ⚠ ${feedErrors.length} feeds failed. Error log: ${errorLogPath}`);
  }

  // ── Heptabase integration ──
  if (heptabaseEnabled) {
    try {
      await saveToHeptabase(outputPath);
    } catch (error) {
      console.warn(`[digest] Heptabase integration error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log('');
  console.log(`[digest] ✅ Done!`);
  console.log(`[digest] 📁 Report: ${outputPath}`);
  console.log(`[digest] 📊 Stats: ${successfulSources.size} sources → ${allArticles.length} articles → ${recentArticles.length} recent → ${finalArticles.length} selected`);

  if (finalArticles.length > 0) {
    console.log('');
    console.log(`[digest] 🏆 Top 3 Preview:`);
    for (let i = 0; i < Math.min(3, finalArticles.length); i++) {
      const a = finalArticles[i];
      console.log(`  ${i + 1}. ${a.titleZh || a.title}`);
      console.log(`     ${a.summary.slice(0, 80)}...`);
    }
  }
}

if (import.meta.main) {
  await main().catch((err) => {
    console.error(`[digest] Fatal error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
