// Zoro – Newton School AI Support Bot (Slack DM)
// Stack: Slack Bolt (Socket Mode) + Google Gemini Embeddings + Google Sheets CSV

require("dotenv").config();
console.log("ENV CHECK — BOT_TOKEN:", process.env.SLACK_BOT_TOKEN ? "present" : "MISSING");
console.log("ENV CHECK — APP_TOKEN:", process.env.SLACK_APP_TOKEN ? "present" : "MISSING");
const { App } = require("@slack/bolt");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const Database = require("better-sqlite3");
const crypto = require("crypto");
const fs = require("fs");

// ─── Config ───────────────────────────────────────────────────────────────────
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN;
const GEMINI_API_KEY  = process.env.GEMINI_API_KEY;
const FAQ_CSV_PATH    = "./faq.csv";

const FALLBACK_EMAIL    = "shivangi.tiwari@newtonschool.co";
const CACHE_TTL_MS      = 30 * 60 * 1000;
const THRESHOLD_HIGH    = 0.80;  // answer directly
const THRESHOLD_PARTIAL = 0.42;  // show clarification options

// ─── Emotion Detection ────────────────────────────────────────────────────────
const EMOTION_TRIGGERS = {
  angry: [
    "useless", "worst", "terrible", "horrible", "pathetic", "disgusting",
    "fraud", "scam", "cheated", "lied", "waste of money", "waste of time",
    "money wasted", "fed up", "sick of", "ridiculous", "unacceptable",
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

function buildEmotionalResponse(emotion) {
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

// ─── Clients ──────────────────────────────────────────────────────────────────
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
    question   TEXT PRIMARY KEY,
    category   TEXT,
    answer     TEXT NOT NULL,
    hash       TEXT NOT NULL,
    embedding  TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

function rowHash(question, answer) {
  return crypto.createHash("sha256").update(question + "|||" + answer).digest("hex");
}

function cleanupCorruptedFAQs() {
  const result = db.prepare(`
    DELETE FROM faqs WHERE
      question LIKE '%{%' OR
      question LIKE '<%' OR
      question LIKE '%function%' OR
      question LIKE '%document.%' OR
      question LIKE '%addEventListener%' OR
      question LIKE '%prototype%' OR
      question LIKE '%return this%' OR
      length(question) > 300
  `).run();
  if (result.changes > 0) console.log(`🧹 Removed ${result.changes} corrupted FAQ entry(ies) from DB`);
}

// ─── CSV Parser ───────────────────────────────────────────────────────────────
function parseCSV(text) {
  const rows = [];
  let col = '', cols = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i], next = text[i + 1];
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
  if (col || cols.length) { cols.push(col.trim()); if (cols.some(c => c)) rows.push(cols); }
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
        console.log(`Rate limited — waiting 65s before retry ${i + 1}…`);
        await new Promise(r => setTimeout(r, 65000));
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

function loadCacheFromDB() {
  return db.prepare("SELECT * FROM faqs").all().map(r => ({
    category:  r.category,
    question:  r.question,
    answer:    r.answer,
    embedding: JSON.parse(r.embedding),
  }));
}

async function fetchFAQs() {
  if (faqCache.length) return faqCache;
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    try { return await _doSyncFAQs(); }
    finally { refreshPromise = null; }
  })();
  return refreshPromise;
}

async function _doSyncFAQs() {
  const existing = db.prepare("SELECT * FROM faqs").all();
  const dbMap = new Map(existing.map(r => [r.question, r]));

  console.log("🔄 Reading FAQ from local faq.csv…");
  if (!fs.existsSync(FAQ_CSV_PATH)) {
    console.log("⚠️ faq.csv not found — loading from DB");
    faqCache = loadCacheFromDB();
    return faqCache;
  }
  const csv = fs.readFileSync(FAQ_CSV_PATH, "utf8");

  const allRows = parseCSV(csv);
  const sheetRows = allRows
    .slice(1)
    .filter(cols => cols.length >= 4)
    .map(cols => ({ category: cols[0] || '', question: cols[2] || '', answer: cols[3] || '' }))
    .filter(r => r.question && r.answer);

  console.log(`📋 Found ${sheetRows.length} FAQ rows in sheet`);

  const toEmbed = sheetRows.filter(r => {
    const h = rowHash(r.question, r.answer);
    const stored = dbMap.get(r.question);
    return !stored || stored.hash !== h;
  });

  const sheetQuestions = new Set(sheetRows.map(r => r.question));
  const toDelete = [...dbMap.keys()].filter(q => !sheetQuestions.has(q));
  if (toDelete.length) {
    toDelete.forEach(q => deleteStmt.run(q));
    console.log(`🗑️  Removed ${toDelete.length} deleted FAQ(s)`);
  }

  if (toEmbed.length === 0) {
    console.log("✅ No changes — loading from database");
    faqCache = loadCacheFromDB();
    return faqCache;
  }

  console.log(`🔁 ${toEmbed.length} FAQ(s) changed — re-embedding…`);
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
      await new Promise(r => setTimeout(r, 700));
    }
    if (i + batchSize < toEmbed.length) {
      console.log("Pausing 5s between batches…");
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  faqCache = loadCacheFromDB();
  console.log(`✅ DB synced — ${faqCache.length} FAQs ready`);
  return faqCache;
}

// No periodic sync needed — FAQ is read from faq.csv on startup (redeploy to update)

// ─── Semantic Search (FAQ only) ───────────────────────────────────────────────
async function findTopMatches(userQuery, topN = 4) {
  const faqs = await fetchFAQs();
  if (!faqs.length) return [];
  const queryVec = await embedQuery(userQuery);

  return faqs
    .map(faq => ({
      question:  faq.question,
      answer:    faq.answer,
      category:  faq.category,
      score:     cosineSimilarity(queryVec, faq.embedding),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);
}

// ─── Pending clarification state (per user) ───────────────────────────────────
const pendingClarification = new Map();

// ─── Generative Response Builder ──────────────────────────────────────────────
async function buildFAQResponse(match, score, userQuery) {
  let prompt;

  if (score >= 0.45) {
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
- Asks 3–4 specific clarifying questions formatted as a list with 🟢 bullet points
- Each option should be a plausible topic related to their query (e.g. attendance, payments, placements, portal, certificates, assignments)
- Mentions they can email *${FALLBACK_EMAIL}* if it's urgent
- Uses Slack markdown and emojis naturally

Only output the message text, no preamble.`;
  }

  try {
    const result = await generativeModel.generateContent(prompt);
    return result.response.text().trim();
  } catch (err) {
    console.error("Generative model error:", err.message);
    if (score >= 0.45) return `*Here's what I found:*\n\n${match.answer}\n\nLet me know if you need anything else! 😊`;
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
    console.log(`📩 Query: "${userQuery}"`);

    // 1. Greetings
    if (isGreeting(userQuery)) {
      await client.chat.postMessage({
        channel: event.channel,
        text: "Hey there! 👋 I'm Zoro, Newton School's support assistant. How can I help you today? Feel free to ask me anything about your course, attendance, assignments, payments, or placements! 😊",
      });
      return;
    }

    // 2. Emotional distress — escalate before FAQ search
    const emotion = detectEmotion(userQuery);
    if (emotion) {
      console.log(`💛 Emotion detected: ${emotion}`);
      const emotionalReply = buildEmotionalResponse(emotion);
      if (emotionalReply) {
        await client.chat.postMessage({
          channel: event.channel,
          text: emotionalReply,
          blocks: [
            { type: "section", text: { type: "mrkdwn", text: emotionalReply } },
            { type: "context", elements: [{ type: "mrkdwn", text: `_Zoro – Newton School's support assistant_` }] },
          ],
        });
        return;
      }
    }

    // 3. Handle reply to clarification prompt
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
        const looksLikeQuestion = userQuery.length > 15 ||
          /\b(what|when|where|how|why|who|which|can|is|are|do|does|will|my|i)\b/i.test(userQuery);
        if (!looksLikeQuestion) {
          const escalationText =
            `No worries at all! 😊 It sounds like your question needs a more personalised response.\n\n` +
            `Please reach out directly to our support team:\n\n` +
            `✅ *Email:* ${FALLBACK_EMAIL}\n\n` +
            `Include a brief description of your query so they can assist you quickly! 🙏`;
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

    // 4. FAQ search
    const topMatches = await findTopMatches(userQuery);

    if (!topMatches.length) {
      await client.chat.postMessage({
        channel: event.channel,
        text: `I'm still loading my knowledge base — please try again in a moment! 😊\n\nIf it's urgent, reach out to *${FALLBACK_EMAIL}*`,
      });
      return;
    }

    const best = topMatches[0];
    console.log(`🎯 Best match: ${Math.round(best.score * 100)}% — "${best.question}"`);
    trackUnseen(userQuery, best.score);

    if (best.score >= THRESHOLD_HIGH) {
      // High confidence — answer directly
      const replyText = await buildFAQResponse(best, best.score, userQuery);
      await client.chat.postMessage({
        channel: event.channel,
        text: replyText,
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: replyText } },
          { type: "context", elements: [{ type: "mrkdwn", text: `_Zoro – Newton School's support assistant_ • Confidence: ${Math.round(best.score * 100)}%` }] },
        ],
      });
    } else {
      // Medium confidence — show clarification options (FAQ matches only)
      const relevantOptions = topMatches.filter(m => m.score >= THRESHOLD_PARTIAL);
      if (relevantOptions.length === 0) {
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
      const optionLines = relevantOptions.map((m, i) => `*${i + 1}.* ${m.question}`).join("\n");
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
        { type: "header", text: { type: "plain_text", text: "👋 Hi, I'm Zoro!" } },
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
  console.log("⚠️ Unhandled rejection (continuing):", reason?.message || String(reason));
});

process.on("uncaughtException", (err) => {
  const msg = err.message || "";
  if (["ENOTFOUND", "fetch failed", "ECONNRESET", "ETIMEDOUT", "EPIPE", "socket hang up"].some(e => msg.includes(e))) {
    console.log("⚠️ Network error in background task (continuing):", msg);
    return;
  }
  console.error("💥 Uncaught exception — restarting in 3s:", msg);
  setTimeout(() => process.exit(1), 3000);
});

// ─── Start ────────────────────────────────────────────────────────────────────
(async () => {
  await app.start();
  console.log("⚡ Zoro is live on Slack (Socket Mode)!");

  cleanupCorruptedFAQs();
  faqCache = loadCacheFromDB();
  if (faqCache.length) console.log(`📦 Loaded ${faqCache.length} FAQs from DB (syncing in background…)`);

  _doSyncFAQs().catch(err => console.log("⚠️ Startup FAQ sync failed:", err.message));
})();
