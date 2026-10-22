// Live information for questions the model can't answer from its training data (which ends mid-2024).
// Uses Tavily web search when TAVILY_API_KEY is set, otherwise Wikipedia's free API (no key needed).

const USER_AGENT = "SK-AI-Assistant/1.0 (chat assistant; contact: site admin)";
const TIMEOUT_MS = 12000;
const MAX_CONTEXT_CHARS = 6000;

// Words that signal the answer may have changed since the model was trained
const FRESHNESS_PATTERN = new RegExp(
  [
    "\\blatest\\b", "\\bcurrent(ly)?\\b", "\\btoday\\b", "\\bnow\\b", "\\brecent(ly)?\\b", "\\bnews\\b",
    "\\bthis (year|month|week)\\b", "\\b20(2[4-9]|3\\d)\\b", "\\bprice\\b", "\\brate\\b", "\\bversion\\b",
    "\\brelease(d)?\\b", "\\bupdate(s|d)?\\b", "\\bnew(est)?\\b", "\\bupcoming\\b", "\\bscore\\b", "\\bwinner\\b",
    "\\belection\\b", "\\bwho is the (president|prime minister|chief minister|ceo|captain|governor)\\b",
  ].join("|"),
  "i"
);

// The model already knows today's date (it is in the system prompt), so date/time questions skip the search
const DATE_ONLY_PATTERN = /^\s*(what('?s| is)\s+)?(the\s+)?(today'?s\s+)?(date|day|time)(\s+(today|now))?\s*\??\s*$/i;

export function needsLiveInfo(question) {
  const text = String(question || "");
  return FRESHNESS_PATTERN.test(text) && !DATE_ONLY_PATTERN.test(text);
}

const STOP_WORDS = new Set((
  "what whats is are was were the a an of in on for to and or with about from by at as it its this that " +
  "who whom which when where why how latest current currently today now recent recently new newest news " +
  "version versions release released releases update updates updated price rate please tell me give show list " +
  "do does did can could should would will my your our their best top any there upcoming stable"
).split(" "));

// Words describing WHAT the user wants to know about the topic (used to pick relevant sentences)
const DETAIL_HINTS = {
  version: /\b(version|release[sd]?|stable|latest|launched|introduced)\b/i,
  release: /\b(version|release[sd]?|stable|latest|launched)\b/i,
  price: /\b(price[sd]?|cost[s]?|rupees?|₹|\$|usd|inr)\b/i,
  rate: /\b(rate[sd]?|percent|%)\b/i,
  president: /\b(president|elected|incumbent|sworn)\b/i,
  minister: /\b(minister|incumbent|sworn|elected|assumed office)\b/i,
  ceo: /\b(ceo|chief executive|appointed|succeeded)\b/i,
};

function topicWords(question) {
  return String(question || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}.+#\s-]/gu, " ")
    .split(/\s+/)
    .map((word) => word.replace(/^[.-]+|[.-]+$/g, ""))
    .filter((word) => word && !STOP_WORDS.has(word) && !/^20\d\d$/.test(word));
}

// Picks the article sentences most related to the question, so facts deep in a long page are found
function relevantText(extract, question, words) {
  const intro = extract.slice(0, 600);
  const hints = Object.entries(DETAIL_HINTS)
    .filter(([key]) => new RegExp(`\\b${key}`, "i").test(question))
    .map(([, pattern]) => pattern);

  const wantsLatest = /\b(latest|current(ly)?|now|today|newest|recent|incumbent)\b/i.test(question);
  const sentences = extract.slice(600).split(/(?<=[.!?])\s+/).filter((s) => s.length > 30 && s.length < 600);
  const scored = sentences.map((sentence, index) => {
    let score = 0;
    hints.forEach((pattern) => { if (pattern.test(sentence)) score += 3; });
    words.forEach((word) => { if (sentence.toLowerCase().includes(word)) score += 1; });
    if (/\b\d+\.\d+\b/.test(sentence)) score += 1; // version-like numbers

    // For "latest/current" questions, the newest facts matter most: rank by the most recent year mentioned
    const years = (sentence.match(/\b(19|20)\d\d\b/g) || []).map(Number);
    const newest = years.length ? Math.max(...years) : 0;
    if (wantsLatest) {
      if (newest >= 2024) score += 6 + (newest - 2024);
      else if (newest >= 2020) score += 1;
      else if (newest > 0) score -= 2;
      if (/\b(as of|currently|current|incumbent|since \d{4}|present)\b/i.test(sentence)) score += 3;
    } else if (newest >= 2024) {
      score += 2;
    }
    return { sentence, index, score };
  });

  const best = scored
    .filter((item) => item.score >= 3)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .sort((a, b) => a.index - b.index)
    .map((item) => `- ${item.sentence.replace(/\s+/g, " ").trim()}`);

  return `${intro}${best.length ? `\nMost relevant lines:\n${best.join("\n")}` : ""}`;
}

async function getJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "User-Agent": USER_AGENT, ...(options.headers || {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

// Wikipedia: search with the topic keywords, keep pages whose title matches, then pull the relevant lines
async function searchWikipedia(question) {
  const words = topicWords(question);
  if (words.length === 0) return [];

  const search = await getJson(
    "https://en.wikipedia.org/w/api.php?action=query&list=search&srlimit=5&format=json&utf8=1&srsearch=" +
      encodeURIComponent(words.join(" "))
  );
  // Only trust pages whose title contains one of the topic words (avoids unrelated matches)
  const hits = (search?.query?.search || [])
    .filter((hit) => words.some((word) => hit.title.toLowerCase().includes(word)))
    .slice(0, 3);
  if (hits.length === 0) return [];

  const titles = hits.map((hit) => hit.title).join("|");
  const pages = await getJson(
    "https://en.wikipedia.org/w/api.php?action=query&prop=extracts|info&inprop=url&explaintext=1" +
      "&exsectionformat=plain&redirects=1&format=json&titles=" + encodeURIComponent(titles)
  );

  const byTitle = new Map(Object.values(pages?.query?.pages || {}).map((page) => [page.title, page]));
  return hits
    .map((hit) => {
      const page = byTitle.get(hit.title);
      if (!page?.extract) return null;
      return {
        title: page.title,
        url: page.fullurl || `https://en.wikipedia.org/wiki/${encodeURIComponent(page.title)}`,
        content: relevantText(page.extract, question, words).slice(0, 2600),
      };
    })
    .filter(Boolean);
}

// Tavily: full web search with fresh results (needs a key from tavily.com)
async function searchTavily(query, apiKey) {
  const data = await getJson("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ query, max_results: 5, search_depth: "basic", include_answer: false }),
  });
  return (data?.results || []).map((result) => ({
    title: result.title,
    url: result.url,
    content: String(result.content || "").slice(0, 1500),
  }));
}

// Returns { context, sources } for the prompt, or null if nothing useful was found
export async function lookUpLiveInfo(question) {
  const query = String(question || "").slice(0, 300);
  let results = [];
  try {
    results = process.env.TAVILY_API_KEY
      ? await searchTavily(query, process.env.TAVILY_API_KEY)
      : await searchWikipedia(query);
  } catch (err) {
    console.warn("Live search failed:", err.message);
    return null;
  }
  if (results.length === 0) return null;

  let context = "";
  const sources = [];
  for (const result of results) {
    const block = `Source: ${result.title} (${result.url})\n${result.content}\n\n`;
    if (context.length + block.length > MAX_CONTEXT_CHARS) break;
    context += block;
    sources.push({ title: result.title, url: result.url });
  }
  return { context: context.trim(), sources };
}
