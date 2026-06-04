require("dotenv").config();
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const { WHATSAPP_TOKEN, PHONE_NUMBER_ID, VERIFY_TOKEN, GEMINI_KEY, PORT = 3000 } = process.env;
const DATA_FILE = path.join(__dirname, "data/weddings.json");

// ─── Data helpers ─────────────────────────────────────────────────────────────
function loadData() {
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}
function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ─── Conversation state per user ──────────────────────────────────────────────
const userStates = {};

// ─── Gemini AI ────────────────────────────────────────────────────────────────
async function askGemini(systemPrompt, userMessage) {
  const res = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
    {
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ parts: [{ text: userMessage }] }],
      generationConfig: { responseMimeType: "application/json" }
    },
    { headers: { "Content-Type": "application/json" } }
  );
  const raw = res.data.candidates[0].content.parts[0].text;
  return JSON.parse(raw.replace(/```json\n?|\n?```/g, "").trim());
}

// ─── WhatsApp send ────────────────────────────────────────────────────────────
async function sendMessage(to, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: "whatsapp", to, type: "text", text: { body: text } },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Send error:", err.response?.data || err.message);
  }
}

// ─── Bot logic ────────────────────────────────────────────────────────────────
async function handleMessage(from, text) {
  const state = userStates[from] || { step: "idle" };

  // ── Waiting for gift amount ──
  if (state.step === "waiting_gift") {
    let result;
    try {
      result = await askGemini(
        `המשתמש שלח הודעה בזמן שאנחנו מחכים לסכום הצ'ק לחתונה.
החזר JSON: {"isAmount": true/false, "amount": מספר_או_null, "isCorrection": true/false, "correctedDate": "YYYY-MM-DD_או_null", "correctedNames": "או_null", "reply": "תגובה_ידידותית_בעברית"}`,
        text
      );
    } catch {
      await sendMessage(from, "לא הבנתי 😅 כמה שקלים אתה שם? (רק מספר)");
      return;
    }

    if (result.isCorrection) {
      const data = loadData();
      const wedding = data.weddings.find(w => w.id === state.weddingId);
      if (wedding) {
        if (result.correctedDate) wedding.date = result.correctedDate;
        if (result.correctedNames) wedding.names = result.correctedNames;
        saveData(data);
      }
      await sendMessage(from, `✅ עדכנתי! ${result.reply}\n\nאז כמה אתה שם בצ'ק? 💰`);
      return;
    }

    if (result.isAmount && result.amount) {
      const data = loadData();
      const wedding = data.weddings.find(w => w.id === state.weddingId);
      if (wedding) {
        wedding.giftAmount = result.amount;
        saveData(data);
      }
      userStates[from] = { step: "idle" };
      await sendMessage(from, `✅ שמרתי! ${result.amount.toLocaleString()} ₪ לחתונת ${wedding?.names || ""}. 🎊\n\nלוח השנה מעודכן! http://localhost:${PORT}`);
      return;
    }

    await sendMessage(from, result.reply || "כמה שקלים אתה שם? 💰");
    return;
  }

  // ── Idle — parse incoming message ──
  let result;
  try {
    result = await askGemini(
      `אתה עוזר חכם למעקב חתונות. נתח את ההודעה.
החזר JSON בלבד:
{
  "isWedding": true/false,
  "names": "שמות הזוג או null",
  "date": "YYYY-MM-DD או null",
  "location": "מיקום או null",
  "reply": "תגובה ידידותית בעברית"
}`,
      text
    );
  } catch {
    await sendMessage(from, 'שלח לי הזמנה לחתונה ואני אוסיף אותה ללוח השנה 📅');
    return;
  }

  if (!result.isWedding) {
    await sendMessage(from, result.reply || 'שלח לי הזמנה לחתונה ואוסיף אותה ללוח השנה 📅');
    return;
  }

  const data = loadData();
  const wedding = {
    id: uuidv4(),
    names: result.names || "לא ידוע",
    date: result.date || null,
    location: result.location || null,
    giftAmount: null,
    rawMessage: text,
    createdAt: new Date().toISOString(),
  };
  data.weddings.push(wedding);
  saveData(data);

  userStates[from] = { step: "waiting_gift", weddingId: wedding.id };

  const dateStr = wedding.date
    ? new Date(wedding.date).toLocaleDateString("he-IL", { day: "numeric", month: "long", year: "numeric" })
    : "תאריך לא נמצא";

  await sendMessage(from,
    `🎊 הוספתי ללוח השנה!\n\n👰 ${wedding.names}\n📅 ${dateStr}${wedding.location ? "\n📍 " + wedding.location : ""}\n\nכמה אתה שם בצ'ק? 💰`
  );
}

// ─── Webhook ──────────────────────────────────────────────────────────────────
app.get("/webhook", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === VERIFY_TOKEN) {
    res.status(200).send(req.query["hub.challenge"]);
  } else {
    res.sendStatus(403);
  }
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  const entry = req.body.entry?.[0]?.changes?.[0]?.value;
  const message = entry?.messages?.[0];
  if (!message || message.type !== "text") return;
  console.log(`📩 מ-${message.from}: ${message.text.body}`);
  await handleMessage(message.from, message.text.body);
});

// ─── Dashboard API ────────────────────────────────────────────────────────────
app.get("/api/weddings", (req, res) => res.json(loadData().weddings));

app.delete("/api/weddings/:id", (req, res) => {
  const data = loadData();
  data.weddings = data.weddings.filter(w => w.id !== req.params.id);
  saveData(data);
  res.json({ ok: true });
});

app.put("/api/weddings/:id", (req, res) => {
  const data = loadData();
  const w = data.weddings.find(w => w.id === req.params.id);
  if (w) Object.assign(w, req.body);
  saveData(data);
  res.json(w || { error: "not found" });
});

app.listen(PORT, () => console.log(`🚀 Wedding bot on http://localhost:${PORT}`));
