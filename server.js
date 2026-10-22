import OpenAI from "openai";
import express from "express";
import path from "path";
import session from "express-session";
import mysql from "mysql2/promise";
import fs from "fs";
import { randomUUID } from 'crypto';
import multer from "multer";
import 'dotenv/config';
import { startVideoJob, getVideoJob, hasActiveJob, fetchShotImage } from "./video/videoPipeline.js";
import {
  addLibraryItem,
  saveUploadToLibrary,
  listLibrary,
  deleteLibraryItem,
  isLibraryMime,
} from "./library/libraryStore.js";
import { extractPdfText } from "./library/pdfText.js";
import { needsLiveInfo, lookUpLiveInfo } from "./live/liveSearch.js";

const app = express();
const port = process.env.PORT || 3000;
const GUEST_MESSAGE_LIMIT = 3;
// Groq retires models over time; override these in .env instead of editing code.
// (llama-3.3-70b-versatile was removed, which made every chat fail.)
const CHAT_MODEL = process.env.CHAT_MODEL || "openai/gpt-oss-120b";
// gpt-oss only accepts text, so messages with images go to a model that can see them
const VISION_MODEL = process.env.VISION_MODEL || "qwen/qwen3.8-27b";
// The page renders Markdown, so ask for easy-to-scan formatting rather than walls of text or huge tables
const FORMAT_RULES =
  "Format replies in Markdown. Short answers are plain sentences with no headings. Longer answers may use " +
  "'## ' section headings, short paragraphs, bullet points, " +
  "**bold** for key terms, and fenced code blocks with a language tag for code. Use tables only for short comparisons " +
  "(cells of a few words), never for long answers.";
// Exact answers: lead with the direct answer, keep length proportional to the question, no padding
const ANSWER_RULES =
  "Answer the user's exact question directly in the first sentence, then add only the details that help. " +
  "Match length to the question: a simple factual question gets only the answer in 1-2 sentences, with no headings or extra facts; " +
  "a normal question gets a short answer (a few sentences or bullets); " +
  "only explain at length when the user asks for detail, steps, code or a list. " +
  "Do not introduce yourself, restate the question, or add filler openings and closings. " +
  "Be accurate: if you are not sure or the information may be out of date, say so briefly instead of guessing. " +
  "If the question is unclear, give the most likely answer and ask one short clarifying question. " +
  "Write in simple, everyday English that a beginner understands: short sentences, common words, no jargon. " +
  "If a technical term is needed, explain it in a few simple words in brackets the first time.";
// Concept / topic questions are the exception to "keep it short": learners need the full picture
const CONCEPT_RULES =
  "EXCEPTION for concept or topic questions: when the user asks about a concept, topic, technology or term " +
  "(for example 'OOPs', 'oops concepts', 'what is REST API', 'explain recursion', 'SQL joins', 'closures in JS', " +
  "or just a topic name on its own), give a COMPLETE but SIMPLE explanation that a beginner fully understands. " +
  "Cover every core part, but keep each part short and easy. Use this structure: " +
  "1) a one-line definition in bold, in simple words; " +
  "2) '## Key concepts' covering EVERY core part of the topic (e.g. for OOPs: Class & Object, Encapsulation, " +
  "Inheritance, Polymorphism, Abstraction), each as a '### ' sub-heading with: a 1-2 line simple explanation, " +
  "a one-line real-life example (e.g. 'Like a TV remote...'), and a short, correct code example " +
  "(about 10 lines, with simple comments) in a fenced block; " +
  "3) '## Quick summary' as a small table or 3-5 bullets. " +
  "Only add a 'Complete example' or 'Common mistakes' section if the user asks for more detail. " +
  "Use the programming language the user mentions; if none is mentioned, pick the most common one for the topic " +
  "(PHP is a good default for web topics) and say which you used.";
const SYSTEM_PROMPT =
  "You are SK AI Assistant, a helpful AI assistant. If asked who you are, say you are SK AI Assistant. " +
  `${ANSWER_RULES} ${CONCEPT_RULES} ${FORMAT_RULES}`;

// The model's own knowledge ends mid-2024; tell it today's date and how to use live search results
function dateAndFreshnessRules() {
  const today = new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  return (
    `Today's date is ${today}. Your built-in knowledge only goes up to mid-2024. ` +
    "When 'Live search results' are provided in the user's message, treat them as more up to date than your own " +
    "knowledge, answer from them, and mention the source name briefly. Only state dates, numbers or names that are " +
    "written in the sources or that you are sure of; never work out or guess a date, and leave out details the " +
    "sources do not give. " +
    "If a question is about something that may have changed since 2024 and no live results are given, answer with " +
    "what you know and add one short line saying it may be out of date."
  );
}
// Extra instructions per chat mode (the page sends 'mode' with every message)
const MODE_PROMPTS = {
  interview:
    "You are SK AI Assistant acting as an experienced interviewer and career coach. " +
    "For a mock interview: ask exactly ONE question at a time, then wait for the candidate's answer. " +
    "After each answer, give short feedback (what was good, what to improve, a stronger sample answer), then ask the next question. " +
    "Match difficulty to the role and experience. After about 8 questions, give an overall score out of 10 with key tips. " +
    "If asked for a question list instead, use exactly this layout for each question (no tables): " +
    "'### Q<number>. <question>' on its own line, then '**Why they ask:** <one line>', then '**Sample answer:**' " +
    "followed by a short paragraph or 3-5 bullet points written at the candidate's experience level, then '**Tip:** <one line>'. " +
    "Start with a one-line intro and end with a short '## Final tips' section.",
};
const MAX_HISTORY_MESSAGES = 12;
// Large enough to carry an attached PDF's text in a follow-up turn
const MAX_HISTORY_CHARS = 10000;
// Groq's free tier allows 8,000 tokens per minute per model (~4 chars per token), so the
// whole history sent with one message is capped well below that
const MAX_HISTORY_TOTAL_CHARS = 12000;

// Reads the recent conversation the page sends, keeping only well-formed text turns,
// newest first until the total size budget is used up
function parseHistory(raw) {
  try {
    const list = JSON.parse(raw || '[]');
    if (!Array.isArray(list)) return [];
    const recent = list
      .filter((item) => ['user', 'assistant'].includes(item?.role) && typeof item.content === 'string')
      .slice(-MAX_HISTORY_MESSAGES)
      .map((item) => ({ role: item.role, content: item.content.slice(0, MAX_HISTORY_CHARS) }));

    const kept = [];
    let total = 0;
    for (let i = recent.length - 1; i >= 0; i -= 1) {
      total += recent[i].content.length;
      if (total > MAX_HISTORY_TOTAL_CHARS) break;
      kept.unshift(recent[i]);
    }
    // A conversation must not start with an assistant turn
    while (kept[0]?.role === 'assistant') kept.shift();
    return kept;
  } catch (err) {
    return [];
  }
}

// Answers with Groq's built-in web search (gpt-oss "browser_search" tool): the model searches the web,
// opens pages and answers from them. Returns { answer, sources } or null if it failed (caller falls back).
const WEB_SEARCH_RULES =
  "This question needs current information. Before answering, ALWAYS use browser search and open at least one " +
  "official or reliable page. Answer only from what those pages say: give versions, names and dates exactly as " +
  "written there, and leave out any date the pages do not state. Never answer from memory for this question. " +
  "For 'latest version' questions: list every version number the page shows as released or supported, compare " +
  "them, and answer with the HIGHEST stable one (ignore alpha, beta and RC versions, but you may mention an " +
  "upcoming one).";

async function answerWithWebSearch(messages) {
  if (process.env.DISABLE_WEB_SEARCH === 'true') return null;
  const request = () => openai.chat.completions.create(
    {
      model: CHAT_MODEL,
      temperature: 0.3,
      // 'low' keeps token use inside the free tier's 8k tokens/minute; higher effort used ~23k
      reasoning_effort: 'low',
      tools: [{ type: 'browser_search' }],
      messages: [...messages.slice(0, -1), { role: 'system', content: WEB_SEARCH_RULES }, messages[messages.length - 1]],
    },
    { maxRetries: 0, timeout: 45000 }
  );

  try {
    let completion;
    try {
      completion = await request();
    } catch (err) {
      // Groq's search tool sometimes returns a temporary 500; one retry usually works
      if (err?.status !== 500) throw err;
      completion = await request();
    }
    const message = completion.choices?.[0]?.message;
    const answer = String(message?.content || '')
      // The tool adds citation markers like 【1†L10-L13】; the page shows sources separately
      .replace(/\s*【[^】]*】/g, '')
      .trim();
    if (!answer) return null;

    // Prefer pages the model actually opened, then its top search results
    const tools = message.executed_tools || [];
    // An answer given without searching is just the model's (2024) memory, so let the caller fall back
    if (!tools.some((t) => t.type === 'browser_search')) return null;
    const opened = tools.filter((t) => t.type !== 'browser_search').flatMap((t) => t.search_results?.results || []);
    const searched = tools.filter((t) => t.type === 'browser_search').flatMap((t) => t.search_results?.results || []);
    const seen = new Set();
    const sources = [...opened, ...searched]
      .filter((r) => /^https?:\/\//.test(r?.url || '') && !/exa\.ai\/search/.test(r.url))
      .filter((r) => {
        const key = r.url.split('#')[0];
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 4)
      .map((r) => ({
        title: String(r.title || '').replace(/\s*-\s*viewing lines.*$/i, '').trim() || new URL(r.url).hostname,
        url: r.url,
      }));

    return { answer, sources };
  } catch (err) {
    console.warn('Web search unavailable, using Wikipedia fallback:', err?.status || '', err?.message || err);
    return null;
  }
}

// Text model used when the main one is rate-limited (Groq limits are per model)
const FALLBACK_CHAT_MODEL = process.env.FALLBACK_CHAT_MODEL || "openai/gpt-oss-20b";
const MAX_RATE_LIMIT_WAIT_SECONDS = 12;

function retryAfterSeconds(err) {
  const header = Number(err?.headers?.get?.('retry-after'));
  if (Number.isFinite(header) && header > 0) return header;
  const match = String(err?.message || '').match(/try again in ([\d.]+)s/i);
  return match ? Math.ceil(Number(match[1])) : 10;
}

// Calls the chat model; on a rate limit (429) switches to the fallback text model,
// then waits for the limit to reset once before giving up
async function createChatCompletion(params) {
  const isRateLimit = (err) => err?.status === 429;
  // The SDK's own retries silently wait up to ~35s on a 429; turn them off so we can switch models at once
  const noSdkRetries = { maxRetries: 0 };
  try {
    return await openai.chat.completions.create(params, noSdkRetries);
  } catch (err) {
    if (!isRateLimit(err)) throw err;

    const textOnly = params.model !== VISION_MODEL;
    if (textOnly && params.model !== FALLBACK_CHAT_MODEL) {
      try {
        console.warn(`Rate limited on ${params.model}; using ${FALLBACK_CHAT_MODEL}`);
        return await openai.chat.completions.create({ ...params, model: FALLBACK_CHAT_MODEL }, noSdkRetries);
      } catch (fallbackErr) {
        if (!isRateLimit(fallbackErr)) throw fallbackErr;
      }
    }

    const wait = retryAfterSeconds(err);
    if (wait > MAX_RATE_LIMIT_WAIT_SECONDS) throw err;
    console.warn(`Rate limited; retrying in ${wait}s`);
    await new Promise((resolve) => setTimeout(resolve, wait * 1000));
    return openai.chat.completions.create(params, noSdkRetries);
  }
}

// Guests get a few free general chat messages; returns false after replying 401
function allowGuestRequest(req, res) {
  if (req.session.user) return true;

  req.session.guestMessageCount = req.session.guestMessageCount || 0;
  if (req.session.guestMessageCount >= GUEST_MESSAGE_LIMIT) {
    res.status(401).json({
      error: `Login required after ${GUEST_MESSAGE_LIMIT} messages.`,
      code: "LOGIN_REQUIRED",
    });
    return false;
  }

  req.session.guestMessageCount += 1;
  return true;
}

// Tools (interview prep, image creator, video creator) are for logged-in users only
function requireUser(req, res) {
  if (req.session.user) return true;
  res.status(401).json({ error: "Please log in to use this tool.", code: "LOGIN_REQUIRED" });
  return false;
}

// The chat form posts multipart FormData (text + attachments); keep files in memory
const CHAT_FILE_LIMIT_MB = 10;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: CHAT_FILE_LIMIT_MB * 1024 * 1024, files: 5 },
});

// Runs a multer middleware but answers upload problems (too big, too many) as JSON the page can show
function chatUpload(req, res, next) {
  upload.array('attachments', 5)(req, res, (err) => {
    if (!err) return next();
    const message = err.code === 'LIMIT_FILE_SIZE'
      ? `Each file must be ${CHAT_FILE_LIMIT_MB} MB or smaller.`
      : err.code === 'LIMIT_FILE_COUNT'
        ? 'You can attach up to 5 files at a time.'
        : 'The file could not be uploaded.';
    return res.status(400).json({ error: message });
  });
}

// Library uploads allow bigger files (short videos); only images, videos and PDFs are accepted
const libraryUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 10 },
  fileFilter: (req, file, cb) => cb(null, isLibraryMime(file.mimetype)),
});

const dbConfig = {
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "Sathish AI",
};

const pool = mysql.createPool({
  ...dbConfig,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

async function ensureRegistrationTable() {
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS registration (
      id INT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(255) NOT NULL UNIQUE,
      email VARCHAR(255) NOT NULL UNIQUE,
      password VARCHAR(255) NOT NULL,
      cpassword VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

// Creates the default account from .env (DEFAULT_LOGIN_*) the first time the server starts
async function ensureDefaultUser() {
  const email = process.env.DEFAULT_LOGIN_EMAIL;
  const password = process.env.DEFAULT_LOGIN_PASSWORD;
  if (!email || !password) return;

  const username = process.env.DEFAULT_LOGIN_USERNAME || email.split("@")[0];
  const [rows] = await pool.execute(
    "SELECT id FROM registration WHERE email = ? OR username = ? LIMIT 1",
    [email, username]
  );
  if (rows.length > 0) return;

  await pool.execute(
    "INSERT INTO registration (username, password, cpassword, email) VALUES (?, ?, ?, ?)",
    [username, password, password, email]
  );
  console.log(`Created default login ${email}`);
}

async function ensureChatHistoryTable() {
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS chat_history (
      id INT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(255) NOT NULL,
      question TEXT NOT NULL,
      answer LONGTEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_chat_history_username_created_at (username, created_at)
    )
  `);
}

const CHAT_LOG_FILE = path.join(process.cwd(), 'public', 'data', 'chat_messages.json');
// Deleted chats are hidden right away but only removed from the file after this period
const DELETED_CHAT_RETENTION_MS = 10 * 24 * 60 * 60 * 1000;
const PURGE_INTERVAL_MS = 60 * 60 * 1000;

async function readChatLog() {
  try {
    const text = await fs.promises.readFile(CHAT_LOG_FILE, 'utf8');
    const arr = JSON.parse(text || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch (err) {
    return [];
  }
}

// Serialize read-modify-write cycles so concurrent requests don't overwrite each other
let chatLogQueue = Promise.resolve();

function updateChatLog(mutate) {
  const run = chatLogQueue.then(async () => {
    await fs.promises.mkdir(path.dirname(CHAT_LOG_FILE), { recursive: true });
    const arr = await readChatLog();
    const result = mutate(arr);
    await fs.promises.writeFile(CHAT_LOG_FILE, JSON.stringify(arr, null, 2), 'utf8');
    return result;
  });
  chatLogQueue = run.catch(() => {});
  return run;
}

async function appendToChatLog(entry) {
  try {
    await updateChatLog((arr) => {
      arr.push(entry);
    });
  } catch (err) {
    console.error('Failed to append to chat log:', err);
  }
}

// Who a chat log entry belongs to: the logged-in username, or a per-session id for guests
// so guests never see each other's chats
function chatOwner(req) {
  return req.session.user?.username || `guest:${req.sessionID}`;
}

async function purgeDeletedChats() {
  try {
    const removed = await updateChatLog((arr) => {
      const cutoff = Date.now() - DELETED_CHAT_RETENTION_MS;
      const before = arr.length;
      const kept = arr.filter((entry) => !entry.deletedAt || new Date(entry.deletedAt).getTime() > cutoff);
      arr.splice(0, arr.length, ...kept);
      return before - kept.length;
    });
    if (removed > 0) {
      console.log(`Purged ${removed} chat log entries deleted more than 10 days ago.`);
    }
  } catch (err) {
    console.error('Failed to purge deleted chats:', err);
  }
}

// The raw log includes soft-deleted chats; only expose it through /chat-log
app.use("/data/chat_messages.json", (req, res) => res.status(404).end());
app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));
// Browser libraries for rendering AI answers (Markdown -> sanitized HTML), served locally
app.get("/vendor/marked.min.js", (req, res) => res.sendFile(path.join(process.cwd(), "node_modules", "marked", "marked.min.js")));
app.get("/vendor/purify.min.js", (req, res) => res.sendFile(path.join(process.cwd(), "node_modules", "dompurify", "dist", "purify.min.js")));
app.use(express.static(path.join(process.cwd(), "public")));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || "sathish-ai-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 24,
    },
  })
);

// CONFIGURATION
const openai = new OpenAI({
  apiKey: process.env.AI_API_KEY || process.env.OPENAI_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

// Home page
app.get('/', (req, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
});

app.get("/api/session", (req, res) => {
  return res.json({
    authenticated: Boolean(req.session.user),
    username: req.session.user?.username || "",
    email: req.session.user?.email || "",
    guestMessageCount: req.session.guestMessageCount || 0,
    guestMessageLimit: GUEST_MESSAGE_LIMIT,
  });
});

app.get("/api/profile", (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: "Not logged in." });
  }

  return res.json({
    username: req.session.user.username,
    email: req.session.user.email,
  });
});

app.post("/api/register", async (req, res) => {
  const { username, email, password, cpassword } = req.body;

  if (!username || !email || !password || !cpassword) {
    return res.status(400).json({ error: "All fields are required." });
  }

  if (password !== cpassword) {
    return res.status(400).json({ error: "Password and confirm password must match." });
  }

  try {
    const [existingUsers] = await pool.execute(
      "SELECT username FROM registration WHERE username = ? OR email = ? LIMIT 1",
      [username, email]
    );

    if (existingUsers.length > 0) {
      return res.status(409).json({ error: "Username or email already exists." });
    }

    await pool.execute(
      "INSERT INTO registration (username, password, cpassword, email) VALUES (?, ?, ?, ?)",
      [username, password, cpassword, email]
    );

    req.session.user = { username, email };
    req.session.guestMessageCount = GUEST_MESSAGE_LIMIT;

    return res.status(201).json({
      message: "Registration successful.",
      user: { username, email },
    });
  } catch (error) {
    console.error("Register error:", error);
    return res.status(500).json({ error: "Unable to register right now." });
  }
});

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: "Username or email and password are required." });
  }

  try {
    // The login field accepts either a username or an email address
    const [rows] = await pool.execute(
      "SELECT username, email FROM registration WHERE (username = ? OR email = ?) AND password = ? LIMIT 1",
      [username, username, password]
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: "Invalid username or password." });
    }

    const user = rows[0];
    req.session.user = { username: user.username, email: user.email };
    req.session.guestMessageCount = GUEST_MESSAGE_LIMIT;

    return res.json({
      message: "Login successful.",
      user: req.session.user,
    });
  } catch (error) {
    console.error("Login error:", error);
    return res.status(500).json({ error: "Unable to login right now." });
  }
});

app.post("/api/logout", (req, res) => {
  req.session.destroy((error) => {
    if (error) {
      console.error("Logout error:", error);
      return res.status(500).json({ error: "Unable to logout right now." });
    }

    res.clearCookie("connect.sid");
    return res.json({ message: "Logged out successfully." });
  });
});

app.get("/api/history", async (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: "Not logged in." });
  }

  try {
    const [rows] = await pool.execute(
      `
        SELECT id, question, answer, created_at AS createdAt
        FROM chat_history
        WHERE username = ?
        ORDER BY created_at DESC
        LIMIT 50
      `,
      [req.session.user.username]
    );

    return res.json({ history: rows });
  } catch (error) {
    console.error("History fetch error:", error);
    return res.status(500).json({ error: "Unable to load history right now." });
  }
});

// Serve the combined chat log file (all messages)
app.get('/chat-log', async (req, res) => {
  try {
    // Guests have no saved chats, so their Recents stays empty
    if (!req.session.user) {
      return res.json([]);
    }

    const owner = chatOwner(req);
    const entries = await readChatLog();
    return res.json(entries.filter((entry) => entry.username === owner && !entry.deletedAt));
  } catch (err) {
    console.error('Chat log serve error:', err);
    return res.status(500).json({ error: 'Unable to load chat log.' });
  }
});

// Create a new conversation and return its id
app.post('/api/conversation', async (req, res) => {
  try {
    const id = randomUUID ? randomUUID() : `c_${Date.now()}_${Math.floor(Math.random()*1000)}`;
    // Do not persist empty conversation metadata. Only messages should be stored.
    return res.json({ conversationId: id });
  } catch (err) {
    console.error('Create conversation error:', err);
    return res.status(500).json({ error: 'Unable to create conversation' });
  }
});

// Soft-delete a conversation: hidden immediately, purged from the log after 10 days
app.delete('/api/conversation/:id', async (req, res) => {
  const conversationId = req.params.id;
  const owner = chatOwner(req);

  try {
    const marked = await updateChatLog((arr) => {
      const deletedAt = new Date().toISOString();
      let count = 0;
      arr.forEach((entry) => {
        if (entry.conversationId === conversationId && entry.username === owner && !entry.deletedAt) {
          entry.deletedAt = deletedAt;
          count += 1;
        }
      });
      return count;
    });

    if (marked === 0) {
      return res.status(404).json({ error: 'Conversation not found.' });
    }

    return res.json({ deleted: true, conversationId });
  } catch (err) {
    console.error('Delete conversation error:', err);
    return res.status(500).json({ error: 'Unable to delete conversation.' });
  }
});

// Handle AJAX chat requests
app.post('/api/chat', chatUpload, async (req, res) => {
  try {
    const body = req.body || {};
    const userQuestion = body.question || "Please read the attached file and summarise the key points.";
    const conversationId = body.conversationId && body.conversationId !== 'null' ? body.conversationId : null;
    const files = req.files || [];
    const images = files.filter((file) => file.mimetype.startsWith('image/'));
    const otherFiles = files.filter((file) => !file.mimetype.startsWith('image/'));

    // A logged-in user asking about interviews in normal chat is switched to interview mode,
    // so the chat gets the coach instructions and is listed under the Interview prep menu
    const requestedMode = MODE_PROMPTS[body.mode] ? body.mode : 'chat';
    const mode = requestedMode === 'chat' && req.session.user && /\binterview/i.test(userQuestion)
      ? 'interview'
      : requestedMode;
    const history = parseHistory(body.history);

    // Guests only get general chat; special modes like interview prep need an account
    if (mode !== 'chat' && !requireUser(req, res)) return;
    if (!allowGuestRequest(req, res)) return;

    // Logged-in users' chat attachments (images, PDFs) are kept in their Library
    if (req.session.user) {
      const owner = req.session.user.username;
      await Promise.all(
        files
          .filter((file) => isLibraryMime(file.mimetype))
          .map((file) => saveUploadToLibrary(owner, file, 'chat').catch((err) => {
            console.error('Library save error:', err);
          }))
      );
    }

    // PDFs are turned into text so the model can read them; other file types are only named
    const documentParts = await Promise.all(otherFiles.map(async (file) => {
      if (file.mimetype !== 'application/pdf') {
        return `[Attached file "${file.originalname}" could not be read: only PDFs and images are supported.]`;
      }
      try {
        const { text, pages, truncated } = await extractPdfText(file.buffer);
        if (!text) {
          return `[Attached PDF "${file.originalname}" has no readable text (it may be a scanned image). Tell the user and suggest uploading a text-based PDF or a screenshot.]`;
        }
        return `--- Attached PDF "${file.originalname}" (${pages} page${pages === 1 ? '' : 's'}${truncated ? ', shortened' : ''}) ---\n${text}\n--- End of PDF ---`;
      } catch (pdfErr) {
        console.error('PDF read error:', pdfErr.message);
        return `[Attached PDF "${file.originalname}" could not be opened (it may be damaged or password-protected). Tell the user.]`;
      }
    }));

    const baseQuestion = documentParts.length > 0
      ? `${userQuestion}\n\n${documentParts.join('\n\n')}\n\nAnswer using the attached document content above. ` +
        'Organise the reply with clear headings and bullet points.'
      : userQuestion;

    const systemMessage = {
      role: "system",
      content: [SYSTEM_PROMPT, dateAndFreshnessRules(), MODE_PROMPTS[mode]].filter(Boolean).join(' '),
    };
    let aiResponse = null;
    let sources = [];

    // Questions about recent things ("latest", "current", "2025"...) need up-to-date information.
    // 1st choice: Groq's built-in web search (reads real pages). It can fail or hit the free-tier
    // token limit, so 2nd choice is our own Wikipedia lookup added to the prompt.
    const wantsLive = needsLiveInfo(userQuestion) && images.length === 0;
    if (wantsLive) {
      const web = await answerWithWebSearch([systemMessage, ...history.slice(-4), { role: "user", content: baseQuestion }]);
      if (web) {
        aiResponse = web.answer;
        sources = web.sources;
      }
    }

    if (aiResponse === null) {
      const live = wantsLive ? await lookUpLiveInfo(userQuestion) : null;
      if (live) sources = live.sources;
      const questionText = live
        ? `${baseQuestion}\n\nLive search results (fetched ${new Date().toISOString().slice(0, 10)}):\n${live.context}`
        : baseQuestion;

      const userContent = images.length > 0
        ? [
            { type: "text", text: questionText },
            ...images.map((file) => ({
              type: "image_url",
              image_url: { url: `data:${file.mimetype};base64,${file.buffer.toString('base64')}` },
            })),
          ]
        : questionText;

      const completion = await createChatCompletion({
        model: images.length > 0 ? VISION_MODEL : CHAT_MODEL,
        // Low temperature keeps answers precise and consistent rather than creative
        temperature: 0.3,
        messages: [systemMessage, ...history, { role: "user", content: userContent }],
      });
      aiResponse = completion.choices[0].message.content;
    }

    if (req.session.user) {
      try {
        await pool.execute(
          "INSERT INTO chat_history (username, question, answer) VALUES (?, ?, ?)",
          [req.session.user.username, userQuestion, aiResponse]
        );
      } catch (historyError) {
        console.error("History save error:", historyError);
      }
    }

    // Append to a single JSON log file for all messages (per user or guest)
    try {
      // Only logged-in users get saved chats; guest messages are answered but not kept
      if (conversationId && req.session.user) {
        const entry = {
          username: chatOwner(req),
          conversationId,
          question: userQuestion,
          answer: aiResponse,
          mode,
          createdAt: new Date().toISOString(),
        };
        await appendToChatLog(entry);
      }
    } catch (logErr) {
      console.error('Chat log append error:', logErr);
    }

    // Extracted PDF text goes back to the page so follow-up questions can include it
    const documentContext = documentParts.length > 0 ? documentParts.join('\n\n').slice(0, 8000) : undefined;
    return res.json({ answer: aiResponse, mode, documentContext, sources });
  } catch (error) {
    console.error("Chat error:", error?.status || '', error?.message || error);
    // The page reads this response as JSON and shows `error` to the user, so explain what happened
    if (error?.status === 429) {
      const wait = retryAfterSeconds(error);
      return res.status(429).json({
        error: `SK AI Assistant is getting too many requests right now. Please wait about ${wait} seconds and try again.`,
      });
    }
    if (error?.status === 413) {
      return res.status(413).json({
        error: "This message is too long for the AI. Try a shorter message, a smaller PDF, or start a New chat.",
      });
    }
    if (error?.status === 401 || error?.status === 403) {
      return res.status(502).json({ error: "The AI service rejected the API key. Please check AI_API_KEY in the .env file." });
    }
    if (error?.status === 404) {
      return res.status(502).json({ error: "The AI model is no longer available. Please update CHAT_MODEL in the .env file." });
    }
    return res.status(500).json({ error: "SK AI Assistant could not answer right now. Please try again." });
  }
});

// ---------- Library: the user's images, videos and files ----------
app.get('/api/library', async (req, res) => {
  if (!requireUser(req, res)) return;
  try {
    const items = await listLibrary(req.session.user.username, req.query.type);
    return res.json({ items });
  } catch (err) {
    console.error('Library list error:', err);
    return res.status(500).json({ error: 'Unable to load your library.' });
  }
});

app.post('/api/library', (req, res) => {
  if (!requireUser(req, res)) return;

  libraryUpload.array('files', 10)(req, res, async (err) => {
    if (err) {
      const tooBig = err.code === 'LIMIT_FILE_SIZE';
      return res.status(400).json({ error: tooBig ? 'Each file must be 25 MB or smaller.' : 'Upload failed.' });
    }

    const files = req.files || [];
    if (files.length === 0) {
      return res.status(400).json({ error: 'Choose images, videos or PDF files to upload.' });
    }

    try {
      const owner = req.session.user.username;
      const items = await Promise.all(files.map((file) => saveUploadToLibrary(owner, file, 'upload')));
      return res.status(201).json({ items: items.map(({ owner: _owner, ...item }) => item) });
    } catch (saveErr) {
      console.error('Library upload error:', saveErr);
      return res.status(500).json({ error: 'Unable to save your files.' });
    }
  });
});

app.delete('/api/library/:id', async (req, res) => {
  if (!requireUser(req, res)) return;
  try {
    const deleted = await deleteLibraryItem(req.session.user.username, req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Item not found.' });
    return res.json({ deleted: true });
  } catch (err) {
    console.error('Library delete error:', err);
    return res.status(500).json({ error: 'Unable to delete this item.' });
  }
});

// Image creator: a few styled images from one prompt, saved under /uploads/images
const IMAGE_DIR = path.join(process.cwd(), 'uploads', 'images');

app.post('/api/image', async (req, res) => {
  const prompt = String(req.body?.prompt || '').trim().slice(0, 600);
  const style = String(req.body?.style || '').trim().slice(0, 200);
  const count = [1, 2, 4].includes(Number(req.body?.count)) ? Number(req.body.count) : 1;

  if (!requireUser(req, res)) return;
  if (!prompt) {
    return res.status(400).json({ error: 'Describe the image you want.' });
  }

  try {
    await fs.promises.mkdir(IMAGE_DIR, { recursive: true });
    const fullPrompt = [style, prompt].filter(Boolean).join('. ');
    const urls = [];

    // One at a time: the free image service rejects parallel requests
    for (let i = 0; i < count; i += 1) {
      const name = `${randomUUID()}.jpg`;
      const seed = Math.floor(Math.random() * 1_000_000);
      const saved = await fetchShotImage(fullPrompt, seed, path.join(IMAGE_DIR, name), 1024, 1024);
      if (saved) {
        const url = `/uploads/images/${name}`;
        urls.push(url);
        const { size } = await fs.promises.stat(saved);
        await addLibraryItem({
          owner: req.session.user.username,
          type: 'image',
          name: `${prompt.slice(0, 60)}${i > 0 ? ` (${i + 1})` : ''}.jpg`,
          url,
          mime: 'image/jpeg',
          size,
          source: 'image-creator',
        });
      }
    }

    if (urls.length === 0) {
      return res.status(503).json({
        error: process.env.POLLINATIONS_TOKEN
          ? 'The image service is busy right now. Please try again in a minute.'
          : 'The free image service limit is used up. Add POLLINATIONS_TOKEN to the .env file to keep creating images.',
      });
    }

    return res.json({ images: urls });
  } catch (err) {
    console.error('Image create error:', err);
    return res.status(500).json({ error: 'Unable to create images right now.' });
  }
});

// Start a long video job: one prompt -> narrated, animated video of 1-5 minutes
app.post('/api/video', async (req, res) => {
  const prompt = String(req.body?.prompt || '').trim();
  const minutes = Math.min(5, Math.max(1, Number(req.body?.minutes) || 1));
  const voice = req.body?.voice !== false;
  const owner = chatOwner(req);

  if (!requireUser(req, res)) return;
  if (!prompt) {
    return res.status(400).json({ error: 'Describe the video you want.' });
  }

  if (hasActiveJob(owner)) {
    return res.status(429).json({ error: 'A video is already being made. Please wait for it to finish.' });
  }

  req.session.videoJobs = req.session.videoJobs || [];
  // Finished videos are added to the user's Library
  const onDone = async (finished) => {
    const filePath = path.join(process.cwd(), `.${finished.videoUrl}`);
    const { size } = await fs.promises.stat(filePath);
    await addLibraryItem({
      owner,
      type: 'video',
      name: `${finished.title || 'Video'}.mp4`,
      url: finished.videoUrl,
      mime: 'video/mp4',
      size,
      source: 'video-creator',
    });
  };

  const job = startVideoJob({ openai, model: CHAT_MODEL, prompt, minutes, voice, owner, onDone });
  req.session.videoJobs.push(job.id);

  return res.status(202).json({ jobId: job.id });
});

app.get('/api/video/:id', (req, res) => {
  const job = getVideoJob(req.params.id);
  const owner = chatOwner(req);

  if (!job || job.owner !== owner) {
    return res.status(404).json({ error: 'Video not found.' });
  }

  const { id, status, step, done, total, title, videoUrl, error } = job;
  return res.json({ id, status, step, done, total, title, videoUrl, error });
});
// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send('Something broke!');
});

async function startServer() {
  try {
    await ensureRegistrationTable();
    await ensureDefaultUser();
    await ensureChatHistoryTable();
    await purgeDeletedChats();
    setInterval(purgeDeletedChats, PURGE_INTERVAL_MS);
    app.listen(port, () => {
      console.log(`🚀 App running at http://localhost:${port}`);
    });
  } catch (error) {
    console.error("Startup error:", error);
    process.exit(1);
  }
}

startServer();
