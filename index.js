// Zoro – Newton School AI Support Bot (Slack DM)
// Stack: Slack Bolt (Socket Mode) + Google Gemini Embeddings + Google Sheets CSV

require("dotenv").config();
console.log("ENV CHECK v2 — BOT_TOKEN:", process.env.SLACK_BOT_TOKEN ? "present" : "MISSING");
console.log("ENV CHECK v2 — APP_TOKEN:", process.env.SLACK_APP_TOKEN ? "present" : "MISSING");
console.log("ENV CHECK v2 — all keys:", Object.keys(process.env).filter(k => k.startsWith("SLACK")).join(", ") || "none");
const { App } = require("@slack/bolt");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const fetch = require("node-fetch");
const Database = require("better-sqlite3");
const crypto = require("crypto");

// ─── Config ──────────────────────────────────────────────────────────────────
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN;
const GEMINI_API_KEY  = process.env.GEMINI_API_KEY;
const SHEET_CSV_URL   = process.env.SHEET_CSV_URL;
const PROGRAM_DOC_URL = process.env.PROGRAM_DOC_URL || "https://docs.google.com/document/d/e/2PACX-1vTol8n_h9Fd_eab81q78vXfa160iA3q393tkIEm7FMdxx2DxYXceNrEmlpnGRcpZ2qGJ-M-_wLMQiJy/pub";

const FALLBACK_EMAIL       = "shivangi.tiwari@newtonschool.co";
const CACHE_TTL_MS         = 30 * 60 * 1000;
const THRESHOLD_HIGH_FAQ   = 0.80;  // direct answer for FAQ matches
const THRESHOLD_HIGH_DOC   = 0.75;  // direct answer for program doc matches
const THRESHOLD_EXACT      = 0.45;  // used inside buildFAQResponse fallback only
const THRESHOLD_PARTIAL    = 0.42;  // minimum relevance for clarification options

// ─── Emotion Detection ────────────────────────────────────────────────────────
const EMOTION_TRIGGERS = {
  angry: [
    "useless", "worst", "terrible", "horrible", "pathetic", "disgusting",
    "fraud", "scam", "cheated", "lied", "waste of money", "waste of time",
    "money wasted", "fed up", "sick of", "fed up", "ridiculous", "unacceptable",
    "not acceptable", "this is bad", "very bad", "so bad", "awful",
    "unprofessional", "incompetent", "rubbish", "nonsense", "bullshit",
    "hate this", "hate you", "terrible service", "poor service", "bad service",
    "no response", "not responding", "ignoring", "no one is helping",
    "nobody helps", "escalate", "complaint", "complain", "legal action",
    "consumer court", "refund my money", "want my money back",
  ],
  frustrated: [
    "frustrated", "frustrating", "annoyed", "annoying", "irritated",
    "why is this", "why is it", "still not", "still waiting", "been waiting",
    "not working", "doesn't work", "not fixed", "still broken", "again",
    "same issue", "same problem", "keep asking", "asked multiple times",
    "no one told me", "nobody told me", "not informed", "not notified",
    "confused", "no clarity", "no update", "no communication",
    "how long", "when will", "why so long", "so slow", "taking forever",
  ],
  placement_distress: [
    "no placement", "not placed", "no job", "no interview", "no calls",
    "placement is bad", "placement sucks", "placement team", "placement issue",
    "wasted my time", "wasted my money", "no opportunities", "no referrals",
    "not getting placed", "job not coming", "no offers", "no response from placement",
    "placement promise", "promised placement", "guaranteed placement",
    "paid so much", "spent so much", "lost so much", "regret joining",
    "shouldn't have joined", "worst decision", "big mistake joining",
  ],
};

function detectEmotion(text) {
  const lower = text.toLowerCase();
  for (const [emotion, triggers] of Object.entries(EMOTION_TRIGGERS)) {
    if (triggers.some(t => lower.includes(t))) return emotion;
  }
  return null;
}

function buildEmotionalResponse(emotion, userQuery) {
  const q = userQuery.toLowerCase();

  if (emotion === "placement_distress") {
    return (
      `I hear you, and I genuinely understand how stressful and disappointing this feels. 💙\n\n` +
      `Job searching is hard, and when things aren't moving as expected, it can feel really overwhelming. Your concerns are completely valid and deserve proper attention — not just an automated reply.\n\n` +
      `I'm not able to make any commitments on behalf of the team, but I want to make sure the right people hear you. Please write to *${FALLBACK_EMAIL}* with your details and a brief description of your concern — this will be escalated to the team who can actually look into your situation personally.\n\n` +
      `You deserve a proper response, and I hope things turn around for you soon. 🙏`
    );
  }

  if (emotion === "angry") {
    return (
      `I'm really sorry you're feeling this way — and I completely understand your frustration. 😔\n\n` +
      `You shouldn't have to feel like this, and your concern absolutely deserves to be heard by a real person who can take action.\n\n` +
      `I'm an AI assistant and I don't want to give you a response that feels dismissive — so I'm going to connect you directly with the support team who can look into this properly.\n\n` +
      `Please reach out to *${FALLBACK_EMAIL}* and share what's been happening. Make sure to include any relevant details so they can help you as quickly as possible. 🙏\n\n` +
      `I'm sorry I couldn't resolve this myself — I hope the team gets back to you very soon.`
    );
  }

  if (emotion === "frustrated") {
    return (
      `I'm sorry this has been frustrating — that's the last thing you should feel when you're trying to get help. 😔\n\n` +
      `It sounds like this has been going on for a while, and I don't want to keep you going in circles. ` +
      `Let me connect you with someone who can actually get to the bottom of this.\n\n` +
      `Please drop a message to *${FALLBACK_EMAIL}* with your concern and any previous context — the team will be able to look into it and follow up with you directly. 🙏\n\n` +
      `I hope this gets sorted out for you quickly!`
    );
  }

  return null;
}


// ─── Greeting detection ───────────────────────────────────────────────────────
const GREETINGS = ["hi", "hello", "hey", "hii", "helo", "howdy", "good morning", "good evening", "good afternoon", "yo", "sup"];

function isGreeting(text) {
  return GREETINGS.some(g => text.toLowerCase().trim().startsWith(g) && text.trim().length < 20);
}

// ─── Clients ─────────────────────────────────────────────────────────────────
const app = new App({
  token: SLACK_BOT_TOKEN,
  appToken: SLACK_APP_TOKEN,
  socketMode: true,
});

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const embedModel = genAI.getGenerativeModel({ model: "gemini-embedding-001" });

const generativeModel = genAI.getGenerativeModel({ model: "gemini-2.0-flash-lite" });

// ─── SQLite DB ────────────────────────────────────────────────────────────────
const db = new Database("./faq_store.db");
db.exec(`
  CREATE TABLE IF NOT EXISTS faqs (
    question TEXT PRIMARY KEY,
    category TEXT,
    answer   TEXT NOT NULL,
    hash     TEXT NOT NULL,
    embedding TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS doc_chunks (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    section   TEXT NOT NULL,
    content   TEXT NOT NULL,
    hash      TEXT NOT NULL,
    embedding TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS curated_chunks (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    section   TEXT NOT NULL,
    content   TEXT NOT NULL,
    hash      TEXT NOT NULL,
    embedding TEXT NOT NULL
  );
`);

function rowHash(question, answer) {
  return crypto.createHash("sha256").update(question + "|||" + answer).digest("hex");
}

// ─── Curated Knowledge Chunks ─────────────────────────────────────────────────
// Manually maintained high-precision knowledge that supplements the program doc
const CURATED_KNOWLEDGE = [
  {
    section: "Learning Components — Overview",
    content: "Every module has 5 learning components: Lectures, Assignments, Projects, Contests, and Mentor Sessions. A student must complete at least 80% of each component across all modules to be eligible for placement referrals and certification.",
  },
  {
    section: "Lecture Attendance Criteria",
    content: "Lecture attendance is tracked for both live and recorded sessions on the Newton School portal. For a session to count as attended, the watch time must be more than 70% of the session duration. Both live and recorded watches are counted.",
  },
  {
    section: "Project Score Requirement",
    content: "Projects must score a minimum of 8 out of 10 to be considered passing. Feedback is provided within 42 hours of submission. If a student scores below 8, they can resubmit after addressing the feedback.",
  },
  {
    section: "Contest Score Requirement",
    content: "Contests require a minimum score of 65% to pass. Students must achieve this across two consecutive Sunday attempts to be counted as cleared for that module.",
  },
  {
    section: "Placement Eligibility Criteria",
    content: "To be eligible for placement referrals, a student must: complete 80% of all learning components (lectures, assignments, projects, contests, mentor sessions) across all modules, score at least 8/10 on projects, score at least 65% in contests, and maintain required attendance.",
  },
  {
    section: "Program Overview",
    content: "Newton School's Data Science program is a 13-month course with 4 phases. Phase 1 Data Analyst covers Excel (5 weeks), SQL (8 weeks), and Power BI (3 weeks). Phase 2 Business Analyst covers Python, EDA 1, and EDA 2 (4 months total). Phase 3 Data Science covers ML1, ML2, MLOPS, and Deep Learning. After each phase there is a 2-week Placement Phase for eligible students. Live classes run Monday, Wednesday, Friday 9–11 PM IST. 80% completion of all components is required for placement and certification.",
  },
  {
    section: "Finance and EMI Issues",
    content: "For EMI payment problems, inability to pay EMI, payment reminders, wrong EMI amounts, requests to pause EMI, portal access blocked due to pending fees, or loan document issues — contact admissions-success@newtonschool.co. For EMI date changes or general finance queries, email support@newtonschool.co. Once pending fees are paid, the team will restore portal access.",
  },
  {
    section: "Support Contacts",
    content: "General queries: support@newtonschool.co. Finance and EMI issues: admissions-success@newtonschool.co. Placement queries: placements.ds@newtonschool.co. Technical bugs: raise a ticket with a screenshot or video and a short description. Referral bonus: contact your success manager or email support@newtonschool.co.",
  },
  {
    section: "Certificates — Where to Get and How to Download",
    content: "There are three types of certificates. Course Completion Certificate: sent via email after full course completion. Module Completion Certificate: available on the Feed section of the Newton School portal. Phase Completion Certificate: available on request from the support team at support@newtonschool.co, sent via email after processing. Certificate eligibility requires 80% attendance, 80% assignment completion, and project scores of 8 out of 10 or above.",
  },
];

let curatedChunksCache = [];

async function syncCuratedChunks() {
  const upsert = db.prepare(`
    INSERT INTO curated_chunks (section, content, hash, embedding)
    VALUES (@section, @content, @hash, @embedding)
    ON CONFLICT(id) DO UPDATE SET
      section = excluded.section, content = excluded.content,
      hash = excluded.hash, embedding = excluded.embedding
  `);
  const existing = db.prepare("SELECT * FROM curated_chunks").all();
  const existingMap = new Map(existing.map(r => [r.section, r]));

  const toEmbed = CURATED_KNOWLEDGE.filter(chunk => {
    const h = crypto.createHash("sha256").update(chunk.section + chunk.content).digest("hex");
    const stored = existingMap.get(chunk.section);
    return !stored || stored.hash !== h;
  });

  if (toEmbed.length === 0) {
    console.log("✅ Curated knowledge unchanged — loading from DB");
  } else {
    console.log(`🔁 Embedding ${toEmbed.length} curated knowledge chunk(s)…`);
    for (const chunk of toEmbed) {
      const h = crypto.createHash("sha256").update(chunk.section + chunk.content).digest("hex");
      const embedding = await embed(chunk.section + ': ' + chunk.content);
      upsert.run({ section: chunk.section, content: chunk.content, hash: h, embedding: JSON.stringify(embedding) });
      await new Promise(r => setTimeout(r, 700));
    }
  }

  curatedChunksCache = db.prepare("SELECT * FROM curated_chunks").all().map(r => ({
    source: 'curated',
    question: r.section,
    answer: r.content,
    category: 'Program Knowledge',
    embedding: JSON.parse(r.embedding),
  }));
  console.log(`✅ ${curatedChunksCache.length} curated knowledge chunks ready`);
}

function loadCacheFromDB() {
  return db.prepare("SELECT * FROM faqs").all().map(r => ({
    category:  r.category,
    question:  r.question,
    answer:    r.answer,
    embedding: JSON.parse(r.embedding),
  }));
}

// ─── Proper CSV Parser ────────────────────────────────────────────────────────
function parseCSV(text) {
  const rows = [];
  let col = '';
  let cols = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === '"') {
      if (inQuotes && next === '"') { col += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      cols.push(col.trim()); col = '';
    } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (ch === '\r' && next === '\n') i++;
      cols.push(col.trim());
      if (cols.some(c => c)) rows.push(cols);
      cols = []; col = '';
    } else {
      col += ch;
    }
  }
  if (col || cols.length) {
    cols.push(col.trim());
    if (cols.some(c => c)) rows.push(cols);
  }
  return rows;
}

// ─── Cosine Similarity ────────────────────────────────────────────────────────
function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ─── Embed with retry ─────────────────────────────────────────────────────────
async function embed(text, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const result = await embedModel.embedContent(text);
      return result.embedding.values;
    } catch (err) {
      if (err.status === 429 && i < retries - 1) {
        console.log(`Rate limited. Waiting 65s before retry ${i + 1}...`);
        await new Promise((r) => setTimeout(r, 65000));
      } else throw err;
    }
  }
}

// ─── Query embedding cache ────────────────────────────────────────────────────
const queryEmbedCache = new Map();

async function embedQuery(text) {
  const key = text.toLowerCase().trim();
  if (queryEmbedCache.has(key)) return queryEmbedCache.get(key);
  const vec = await embed(key);
  queryEmbedCache.set(key, vec);
  return vec;
}

// ─── FAQ Cache ────────────────────────────────────────────────────────────────
let faqCache = [];
let refreshPromise = null;

const upsertStmt = db.prepare(`
  INSERT INTO faqs (question, category, answer, hash, embedding, updated_at)
  VALUES (@question, @category, @answer, @hash, @embedding, @updated_at)
  ON CONFLICT(question) DO UPDATE SET
    category   = excluded.category,
    answer     = excluded.answer,
    hash       = excluded.hash,
    embedding  = excluded.embedding,
    updated_at = excluded.updated_at
`);
const deleteStmt = db.prepare(`DELETE FROM faqs WHERE question = ?`);

async function fetchFAQs() {
  if (faqCache.length) return faqCache;
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    try {
      return await _doSyncFAQs();
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

async function _doSyncFAQs() {
  // Always serve from DB first so bot is ready instantly on restarts
  const existing = db.prepare("SELECT * FROM faqs").all();
  const dbMap = new Map(existing.map(r => [r.question, r]));

  console.log("🔄 Checking Google Sheet for FAQ changes…");
  const res = await fetch(SHEET_CSV_URL);
  const csv = await res.text();

  const allRows = parseCSV(csv);
  const sheetRows = allRows
    .slice(1)
    .filter(cols => cols.length >= 4)
    .map(cols => ({
      category: cols[0] || '',
      question: cols[2] || '',
      answer:   cols[3] || '',
    }))
    .filter(r => r.question && r.answer);

  console.log(`📋 Found ${sheetRows.length} FAQ rows in sheet`);

  // Determine what needs re-embedding
  const toEmbed = sheetRows.filter(r => {
    const h = rowHash(r.question, r.answer);
    const stored = dbMap.get(r.question);
    return !stored || stored.hash !== h;
  });

  // Remove FAQs deleted from the sheet
  const sheetQuestions = new Set(sheetRows.map(r => r.question));
  const toDelete = [...dbMap.keys()].filter(q => !sheetQuestions.has(q));
  if (toDelete.length) {
    toDelete.forEach(q => deleteStmt.run(q));
    console.log(`🗑️  Removed ${toDelete.length} deleted FAQ(s)`);
  }

  if (toEmbed.length === 0) {
    console.log("✅ No changes detected — loading from database");
    faqCache = loadCacheFromDB();
    return faqCache;
  }

  console.log(`🔁 ${toEmbed.length} FAQ(s) changed — re-embedding…`);
  toEmbed.forEach(r => console.log(`  ↳ "${r.question.slice(0, 80)}"`));
  const batchSize = 10;
  for (let i = 0; i < toEmbed.length; i += batchSize) {
    const batch = toEmbed.slice(i, i + batchSize);
    console.log(`Embedding ${i + 1}–${Math.min(i + batchSize, toEmbed.length)} of ${toEmbed.length}…`);
    for (const row of batch) {
      const embedding = await embed(row.question);
      upsertStmt.run({
        question:   row.question,
        category:   row.category,
        answer:     row.answer,
        hash:       rowHash(row.question, row.answer),
        embedding:  JSON.stringify(embedding),
        updated_at: Date.now(),
      });
      await new Promise((r) => setTimeout(r, 700));
    }
    if (i + batchSize < toEmbed.length) {
      console.log("Pausing 5s between batches…");
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  faqCache = loadCacheFromDB();
  console.log(`✅ DB synced — ${faqCache.length} FAQs ready`);
  return faqCache;
}

// Periodic sync — FAQs (changed rows only) + program document (hash check)
setInterval(() => {
  faqCache = [];
  refreshPromise = (async () => {
    try {
      return await _doSyncFAQs();
    } catch (err) {
      console.log("⚠️ FAQ sync skipped (network error):", err.message);
      // Restore from DB so bot keeps serving answers during network outages
      if (!faqCache.length) faqCache = loadCacheFromDB();
    } finally {
      refreshPromise = null;
    }
  })();

  docChunksCache = [];
  syncDocChunks().catch(err => {
    console.log("⚠️ Doc sync skipped (network error):", err.message);
    if (!docChunksCache.length) {
      docChunksCache = db.prepare("SELECT * FROM doc_chunks").all().map(r => ({
        source: 'doc', section: r.section, content: r.content,
        embedding: JSON.parse(r.embedding),
      }));
    }
  });

  syncCuratedChunks().catch(err => console.log("⚠️ Curated sync skipped:", err.message));
}, CACHE_TTL_MS);

// ─── Program Document RAG ─────────────────────────────────────────────────────
let docChunksCache = [];
let docRefreshPromise = null;

function decodeHTML(str) {
  return str
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseHTMLToChunks(html) {
  // Google Docs published HTML uses flat <p> tags — extract each paragraph as a chunk
  const chunks = [];
  const paraMatches = html.match(/<p [^>]*>[\s\S]*?<\/p>/gi) || [];

  const paragraphs = paraMatches
    .map(p => decodeHTML(p))
    .filter(t => t.length > 30);

  // Each paragraph is its own chunk (for specific queries)
  paragraphs.forEach((text, i) => {
    // Use the first few words as the section label
    const label = text.split(/[:\-–]/)[0].trim().substring(0, 60) || `Section ${i + 1}`;
    chunks.push({ section: label, content: text });
  });

  // Also add a full-document chunk (for broad questions like "what does the program cover?")
  if (paragraphs.length > 1) {
    chunks.push({
      section: 'Program Overview',
      content: paragraphs.join(' | '),
    });
  }

  return chunks;
}

async function syncDocChunks() {
  if (docRefreshPromise) return docRefreshPromise;
  docRefreshPromise = (async () => {
    try {
      return await _doSyncDocChunks();
    } finally {
      docRefreshPromise = null;
    }
  })();
  return docRefreshPromise;
}

async function _doSyncDocChunks() {
  console.log("📄 Fetching program document…");
  const res = await fetch(PROGRAM_DOC_URL);
  const html = await res.text();
  const chunks = parseHTMLToChunks(html);
  console.log(`📄 Found ${chunks.length} document chunks`);

  // Guard against partial/corrupt fetches — require at least 4 chunks
  if (chunks.length < 4) {
    console.log(`⚠️ Doc fetch returned only ${chunks.length} chunk(s) — likely a partial response. Skipping re-embed, restoring from DB.`);
    const existing = db.prepare("SELECT * FROM doc_chunks").all();
    if (existing.length) {
      docChunksCache = existing.map(r => ({
        source: 'doc', section: r.section, content: r.content,
        embedding: JSON.parse(r.embedding),
      }));
    }
    return docChunksCache;
  }

  // Hash only the extracted text content (not the full HTML which has dynamic tokens)
  const contentFingerprint = chunks.map(c => c.section + c.content).join("||");
  const docHash = crypto.createHash("sha256").update(contentFingerprint).digest("hex");
  const storedHash = db.prepare("SELECT hash FROM doc_chunks LIMIT 1").get();

  if (storedHash && storedHash.hash === docHash) {
    console.log("✅ Program document unchanged — loading from DB");
    docChunksCache = db.prepare("SELECT * FROM doc_chunks").all().map(r => ({
      source: 'doc',
      section: r.section,
      content: r.content,
      embedding: JSON.parse(r.embedding),
    }));
    return docChunksCache;
  }

  console.log(`🔁 Program document changed — re-embedding ${chunks.length} chunks…`);
  db.prepare("DELETE FROM doc_chunks").run();

  const insertChunk = db.prepare(`
    INSERT INTO doc_chunks (section, content, hash, embedding, updated_at)
    VALUES (@section, @content, @hash, @embedding, @updated_at)
  `);

  const batchSize = 10;
  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    console.log(`Embedding doc chunks ${i + 1}–${Math.min(i + batchSize, chunks.length)} of ${chunks.length}…`);
    for (const chunk of batch) {
      const embedding = await embed(chunk.section + ': ' + chunk.content);
      insertChunk.run({
        section:    chunk.section,
        content:    chunk.content,
        hash:       docHash,
        embedding:  JSON.stringify(embedding),
        updated_at: Date.now(),
      });
      await new Promise(r => setTimeout(r, 700));
    }
    if (i + batchSize < chunks.length) {
      console.log("Pausing 5s between batches…");
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  docChunksCache = db.prepare("SELECT * FROM doc_chunks").all().map(r => ({
    source: 'doc',
    section: r.section,
    content: r.content,
    embedding: JSON.parse(r.embedding),
  }));
  console.log(`✅ Program document synced — ${docChunksCache.length} chunks ready`);
  return docChunksCache;
}

// ─── Semantic Search ──────────────────────────────────────────────────────────
async function findTopMatches(userQuery, topN = 4) {
  const faqs = await fetchFAQs();
  const docs = docChunksCache.length ? docChunksCache : await syncDocChunks();
  const queryVec = await embedQuery(userQuery);

  const faqScored = faqs.map(faq => ({
    source:    'faq',
    question:  faq.question,
    answer:    faq.answer,
    category:  faq.category,
    embedding: faq.embedding,
    score:     cosineSimilarity(queryVec, faq.embedding),
  }));

  const docScored = docs.map(chunk => ({
    source:    'doc',
    question:  chunk.section,
    answer:    chunk.content,
    category:  'Program Info',
    embedding: chunk.embedding,
    score:     cosineSimilarity(queryVec, chunk.embedding),
  }));

  const curatedScored = curatedChunksCache.map(chunk => ({
    ...chunk,
    score: cosineSimilarity(queryVec, chunk.embedding),
  }));

  const all = [...faqScored, ...docScored, ...curatedScored];
  all.sort((a, b) => b.score - a.score);
  return all.slice(0, topN);
}

// ─── Pending clarification state (per user) ───────────────────────────────────
// Map<userId, { options: FAQ[], originalQuery: string }>
const pendingClarification = new Map();

// ─── Generative Response Builder ─────────────────────────────────────────────
async function buildFAQResponse(match, score, userQuery) {
  let prompt;

  if (score >= THRESHOLD_EXACT) {
    prompt = `You are Zoro, Newton School's friendly and empathetic AI support assistant on Slack.

A student asked: "${userQuery}"

You found a highly relevant FAQ:
Q: ${match.question}
A: ${match.answer}

Using the FAQ answer as your source of truth, write a warm, helpful, well-formatted Slack message that:
- Directly answers the student's question
- Uses Slack markdown (*bold*, _italic_)
- Uses relevant emojis (🟢 ✅ 📌 etc.) to structure key points as a list where appropriate
- Adds brief helpful context or next steps if relevant
- Ends with a friendly closing line inviting follow-up questions
- Keeps it concise — no unnecessary filler

Only output the message text, no preamble.`;
  } else if (score >= THRESHOLD_PARTIAL) {
    prompt = `You are Zoro, Newton School's friendly AI support assistant on Slack.

A student asked: "${userQuery}"

You found a partially relevant FAQ:
Q: ${match.question}
A: ${match.answer}

Write a warm Slack message that:
- Gently checks if this is what they meant (e.g. "Are you asking about...?")
- If yes, presents the FAQ answer in a well-formatted way with emojis and bullet points
- Invites them to clarify if it's not quite right
- Uses Slack markdown and emojis naturally

Only output the message text, no preamble.`;
  } else {
    prompt = `You are Zoro, Newton School's friendly AI support assistant on Slack.

A student asked: "${userQuery}"

You don't have a confident answer for this. Write a warm Slack message that:
- Acknowledges their question with empathy
- Asks 3–4 specific clarifying questions formatted as a list with 🟢 bullet points to understand what they need
- Each option should be a plausible topic related to their query (e.g. attendance, payments, placements, portal, mentorship, certificates, assignments)
- Mentions they can email *${FALLBACK_EMAIL}* if it's urgent
- Uses Slack markdown and emojis naturally

Only output the message text, no preamble.`;
  }

  try {
    const result = await generativeModel.generateContent(prompt);
    return result.response.text().trim();
  } catch (err) {
    console.error("Generative model error:", err.message);
    // Fallback to raw FAQ answer if generation fails
    if (score >= THRESHOLD_EXACT) return `*Here's what I found:*\n\n${match.answer}\n\nLet me know if you need anything else! 😊`;
    if (score >= THRESHOLD_PARTIAL) return `Are you asking about *"${match.question}"*?\n\n${match.answer}\n\nIf not, could you share more details? 😊`;
    return `I'd love to help! Could you share a bit more detail so I can point you in the right direction? 😊\n\nOr reach out at *${FALLBACK_EMAIL}* and the team will sort it out!`;
  }
}

// ─── Track unmatched queries ──────────────────────────────────────────────────
const unseenQueries = new Map();

function trackUnseen(query, score) {
  if (score < THRESHOLD_PARTIAL) {
    const key = query.toLowerCase().trim();
    unseenQueries.set(key, (unseenQueries.get(key) || 0) + 1);
  }
}

app.command("/zoro-stats", async ({ ack, respond }) => {
  await ack();
  if (unseenQueries.size === 0) { await respond("No unmatched queries yet 🎉"); return; }
  const sorted = [...unseenQueries.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([q, c]) => `• "${q}" — asked *${c}* time(s)`)
    .join("\n");
  await respond(`*Top unmatched queries (add these to your Sheet!):*\n${sorted}`);
});

// ─── Handle DMs ───────────────────────────────────────────────────────────────
app.event("message", async ({ event, client, logger }) => {
  if (event.channel_type !== "im" || event.bot_id || event.subtype) return;

  const userQuery = event.text?.trim();
  if (!userQuery) return;

  try {
    console.log(`📩 Query received: "${userQuery}"`);

    // 1. Handle greetings
    if (isGreeting(userQuery)) {
      await client.chat.postMessage({
        channel: event.channel,
        text: "Hey there! 👋 I'm Zoro, Newton School's support assistant. How can I help you today? Feel free to ask me anything about your course, attendance, assignments, payments, or placements! 😊",
      });
      return;
    }

    // 2. Check for emotional distress FIRST — before FAQ search
    const emotion = detectEmotion(userQuery);
    if (emotion) {
      console.log(`💛 Emotion detected: ${emotion}`);
      const emotionalReply = buildEmotionalResponse(emotion, userQuery);
      if (emotionalReply) {
        await client.chat.postMessage({
          channel: event.channel,
          text: emotionalReply,
          blocks: [
            {
              type: "section",
              text: { type: "mrkdwn", text: emotionalReply },
            },
            {
              type: "context",
              elements: [{ type: "mrkdwn", text: `_Zoro – Newton School's support assistant_` }],
            },
          ],
        });
        return;
      }
    }

    // 3. Check if user is replying to a clarification prompt
    const pending = pendingClarification.get(event.user);
    if (pending) {
      const choice = parseInt(userQuery.trim());
      if (choice >= 1 && choice <= pending.options.length) {
        pendingClarification.delete(event.user);
        const chosen = pending.options[choice - 1];
        console.log(`✅ User picked option ${choice}: "${chosen.question}"`);
        const replyText = await buildFAQResponse(chosen, 1.0, pending.originalQuery);
        await client.chat.postMessage({
          channel: event.channel,
          text: replyText,
          blocks: [
            { type: "section", text: { type: "mrkdwn", text: replyText } },
            { type: "context", elements: [{ type: "mrkdwn", text: `_Zoro – Newton School's support assistant_` }] },
          ],
        });
        return;
      } else {
        pendingClarification.delete(event.user);
        // If the reply looks like a new question (>15 chars or contains a question word),
        // treat it as a fresh query instead of escalating
        const looksLikeQuestion = userQuery.length > 15 ||
          /\b(what|when|where|how|why|who|which|can|is|are|do|does|will|my|i)\b/i.test(userQuery);
        if (looksLikeQuestion) {
          console.log(`🔁 User asked new question while in pending state — treating as fresh query`);
          // Fall through to normal FAQ search below (don't return)
        } else {
          // Short non-informative reply like "none", "no", "not helpful" — escalate
          console.log(`🔀 User rejected options — escalating to support`);
          const escalationText =
            `No worries at all! 😊 It sounds like your question needs a more personalised response.\n\n` +
            `Please reach out directly to our support team and they'll be happy to help you out:\n\n` +
            `✅ *Email:* ${FALLBACK_EMAIL}\n\n` +
            `Make sure to include a brief description of your query so they can assist you quickly! 🙏`;
          await client.chat.postMessage({
            channel: event.channel,
            text: escalationText,
            blocks: [
              { type: "section", text: { type: "mrkdwn", text: escalationText } },
              { type: "context", elements: [{ type: "mrkdwn", text: `_Zoro – Newton School's support assistant_` }] },
            ],
          });
          return;
        }
      }
    }

    // 4. Normal FAQ search
    const topMatches = await findTopMatches(userQuery);
    const best = topMatches[0];

    // Prefer FAQ over doc/curated when scores are close — FAQs are more specific
    const bestFAQ = topMatches.find(m => m.source === 'faq');
    const chosen = (best.source !== 'faq' && bestFAQ && bestFAQ.score >= THRESHOLD_PARTIAL && (best.score - bestFAQ.score) < 0.15)
      ? bestFAQ
      : best;

    console.log(`🎯 Best match: ${Math.round(best.score * 100)}% [${best.source}] — "${best.question}"`);
    if (chosen !== best) console.log(`🔀 Preferring FAQ: ${Math.round(chosen.score * 100)}% — "${chosen.question}"`);
    trackUnseen(userQuery, chosen.score);

    const threshold = (chosen.source === 'doc' || chosen.source === 'curated') ? THRESHOLD_HIGH_DOC : THRESHOLD_HIGH_FAQ;
    if (chosen.score >= threshold) {
      // High confidence — answer directly
      const replyText = await buildFAQResponse(chosen, chosen.score, userQuery);
      await client.chat.postMessage({
        channel: event.channel,
        text: replyText,
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: replyText } },
          { type: "context", elements: [{ type: "mrkdwn", text: `_Zoro – Newton School's support assistant_ • Confidence: ${Math.round(chosen.score * 100)}%` }] },
        ],
      });
    } else {
      // Below threshold — ask user to pick the most relevant option
      // Prefer FAQ matches in clarification — they are more specific than doc/curated chunks
      const allRelevant = topMatches.filter(m => m.score >= THRESHOLD_PARTIAL);
      const faqRelevant = allRelevant.filter(m => m.source === 'faq');
      const relevantOptions = faqRelevant.length >= 2 ? faqRelevant : allRelevant;
      if (relevantOptions.length === 0) {
        // Nothing relevant at all — generic fallback
        const replyText = await buildFAQResponse(best, best.score, userQuery);
        await client.chat.postMessage({
          channel: event.channel,
          text: replyText,
          blocks: [
            { type: "section", text: { type: "mrkdwn", text: replyText } },
            { type: "context", elements: [{ type: "mrkdwn", text: `_Zoro – Newton School's support assistant_` }] },
          ],
        });
        return;
      }

      pendingClarification.set(event.user, { options: relevantOptions, originalQuery: userQuery });

      const optionLines = relevantOptions
        .map((m, i) => `*${i + 1}.* ${m.question}`)
        .join("\n");

      const clarifyText =
        `I want to make sure I give you the right answer! 🤔\n\n` +
        `Could you tell me which of these best matches what you're looking for?\n\n` +
        optionLines +
        `\n\nJust reply with the number (e.g. *1*, *2*...) and I'll get you the answer right away! 😊`;

      await client.chat.postMessage({
        channel: event.channel,
        text: clarifyText,
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: clarifyText } },
          { type: "context", elements: [{ type: "mrkdwn", text: `_Zoro – Newton School's support assistant_` }] },
        ],
      });
    }
  } catch (err) {
    logger.error(err);
    console.error("FULL ERROR:", err.message);
    await client.chat.postMessage({
      channel: event.channel,
      text: `Oops, something went wrong on my end! 😅 Please mail *${FALLBACK_EMAIL}* and the team will help you out right away!`,
    });
  }
});

// ─── App Home tab ─────────────────────────────────────────────────────────────
app.event("app_home_opened", async ({ event, client }) => {
  await client.views.publish({
    user_id: event.user,
    view: {
      type: "home",
      blocks: [
        {
          type: "header",
          text: { type: "plain_text", text: "👋 Hi, I'm Zoro!" },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "*Newton School's AI Support Assistant*\n\nJust DM me any question about your course, payments, mentorship, or anything else. I'll do my best to help instantly!\n\nFor anything I can't answer, I'll connect you with the team at *shivangi.tiwari@newtonschool.co*.",
          },
        },
        { type: "divider" },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "💡 *Tips:*\n• Ask me anything in plain English\n• I learn from your questions over time\n• Use `/zoro-stats` to see top unanswered questions",
          },
        },
      ],
    },
  });
});

// ─── Crash recovery ───────────────────────────────────────────────────────────
process.on("unhandledRejection", (reason) => {
  const msg = reason?.message || String(reason);
  console.log("⚠️ Unhandled promise rejection (continuing):", msg);
  // Don't exit — network blips during background sync shouldn't kill the bot
});

process.on("uncaughtException", (err) => {
  const msg = err.message || "";
  // Network errors from background sync — log and continue, no restart needed
  if (
    msg.includes("ENOTFOUND") ||
    msg.includes("fetch failed") ||
    msg.includes("ECONNRESET") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("EPIPE") ||
    msg.includes("socket hang up")
  ) {
    console.log("⚠️ Network error in background task (continuing):", msg);
    return;
  }
  // Slack SDK state machine errors require a full restart (state is broken)
  console.error("💥 Uncaught exception — restarting in 3s:", msg);
  setTimeout(() => {
    process.exit(1);
  }, 3000);
});

// ─── Start ────────────────────────────────────────────────────────────────────
(async () => {
  await app.start();
  console.log("⚡ Zoro is live on Slack (Socket Mode)!");

  // Pre-load from DB immediately — bot answers queries while sync runs in background
  faqCache = loadCacheFromDB();
  docChunksCache = db.prepare("SELECT * FROM doc_chunks").all().map(r => ({
    source: 'doc', section: r.section, content: r.content,
    embedding: JSON.parse(r.embedding),
  }));
  if (faqCache.length)   console.log(`📦 Loaded ${faqCache.length} FAQs from DB (syncing in background…)`);
  if (docChunksCache.length) console.log(`📦 Loaded ${docChunksCache.length} doc chunks from DB`);

  // Background syncs — check for changes, update cache if needed
  syncCuratedChunks().catch(err => console.log("⚠️ Curated sync failed:", err.message));
  _doSyncFAQs().catch(err => console.log("⚠️ Startup FAQ sync failed:", err.message));
  syncDocChunks().catch(err => console.log("⚠️ Startup doc sync failed:", err.message));
})();
