require("dotenv").config();
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { randomUUID: uuidv4 } = require("crypto");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const { WHATSAPP_TOKEN, PHONE_NUMBER_ID, VERIFY_TOKEN, GEMINI_KEY, GITHUB_TOKEN, APP_URL, PORT = 3000 } = process.env;
const DATA_FILE = path.join(__dirname, "data/weddings.json");
const GITHUB_REPO = "GUIDNY/whatsapp-bot";
const GITHUB_FILE = "data/weddings.json";

// ─── Data helpers (GitHub as persistent storage) ───────────────────────────────
async function loadData() {
  if (GITHUB_TOKEN) {
    try {
      const res = await axios.get(
        `https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_FILE}`,
        { headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: "application/vnd.github.v3+json" } }
      );
      return JSON.parse(Buffer.from(res.data.content, "base64").toString("utf8"));
    } catch {}
  }
  if (!fs.existsSync(DATA_FILE)) return { weddings: [] };
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch { return { weddings: [] }; }
}

async function saveData(data) {
  const json = JSON.stringify(data, null, 2);
  try { fs.writeFileSync(DATA_FILE, json); } catch {}
  if (GITHUB_TOKEN) {
    try {
      const fileRes = await axios.get(
        `https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_FILE}`,
        { headers: { Authorization: `token ${GITHUB_TOKEN}` } }
      );
      await axios.put(
        `https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_FILE}`,
        { message: "update weddings", content: Buffer.from(json).toString("base64"), sha: fileRes.data.sha },
        { headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: "application/vnd.github.v3+json" } }
      );
    } catch (e) { console.error("GitHub save error:", e.message); }
  }
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
      const data = await loadData();
      const wedding = data.weddings.find(w => w.id === state.weddingId);
      if (wedding) {
        if (result.correctedDate) wedding.date = result.correctedDate;
        if (result.correctedNames) wedding.names = result.correctedNames;
        await saveData(data);
      }
      await sendMessage(from, `✅ עדכנתי! ${result.reply}\n\nאז כמה אתה שם בצ'ק? 💰`);
      return;
    }

    if (result.isAmount && result.amount) {
      const data = await loadData();
      const wedding = data.weddings.find(w => w.id === state.weddingId);
      if (wedding) {
        wedding.giftAmount = result.amount;
        await saveData(data);
      }
      userStates[from] = { step: "idle" };
      const dashboardUrl = APP_URL || `http://localhost:${PORT}`;
      await sendMessage(from, `✅ שמרתי! ${result.amount.toLocaleString()} ₪ לחתונת ${wedding?.names || ""}. 🎊\n\nלוח השנה מעודכן! ${dashboardUrl}`);
      return;
    }

    await sendMessage(from, result.reply || "כמה שקלים אתה שם? 💰");
    return;
  }

  // ── Idle — handle directly without AI ─────────────────────────────
  const data0 = await loadData();
  const dashboardUrl = APP_URL || `http://localhost:${PORT}`;
  const t = text.trim().toLowerCase();

  // Questions about the website URL
  const isUrlQ = /כתובת|אתר|לינק|link|url|site|whatsapp.bot/.test(t);
  if (isUrlQ) {
    await sendMessage(from, `לוח השנה שלך נמצא כאן 👇\n\n${dashboardUrl}`);
    return;
  }

  // Questions about existing weddings
  const isListQ = /איזה חתונות|אילו חתונות|מה החתונות|רשימת חתונות|יש לי חתונות|חתונות שיש|כמה חתונות/.test(t);
  if (isListQ) {
    if (!data0.weddings.length) {
      await sendMessage(from, "אין חתונות שמורות עדיין 📭\nשלח לי הזמנה ואוסיף!");
    } else {
      const sorted = [...data0.weddings].sort((a,b) => (a.date||'') < (b.date||'') ? -1 : 1);
      const list = sorted.map((w, i) => {
        const d = w.date ? new Date(w.date).toLocaleDateString("he-IL", {day:"numeric", month:"long", year:"numeric"}) : "תאריך לא ידוע";
        return `${i+1}. 💒 ${w.names}\n   📅 ${d}${w.location ? "\n   📍 " + w.location : ""}\n   💰 ${w.giftAmount ? w.giftAmount.toLocaleString() + " ₪" : "צ'ק לא הוגדר"}`;
      }).join("\n\n");
      await sendMessage(from, `יש לך ${data0.weddings.length} חתונות:\n\n${list}\n\n📊 ${dashboardUrl}`);
    }
    return;
  }

  // ── Use Gemini only for parsing actual wedding invitations ──────────
  let result;
  try {
    result = await askGemini(
      `אתה עוזר למעקב חתונות. קבל הודעה ובדוק אם זו הזמנה לחתונה.
החזר JSON בלבד:
{"isWedding":true/false,"names":"שמות הזוג או null","date":"YYYY-MM-DD או null","location":"מיקום או null","reply":"תגובה קצרה בעברית"}`,
      text
    );
  } catch {
    await sendMessage(from, `היי! אני כאן לעזור 😊\nשלח לי הזמנה לחתונה ואוסיף ללוח השנה.\n\nהאתר שלך: ${dashboardUrl}`);
    return;
  }

  if (!result.isWedding) {
    await sendMessage(from, result.reply || `היי! שלח לי הזמנה לחתונה ואוסיף ללוח השנה 📅`);
    return;
  }

  if (!result.isWedding) {
    await sendMessage(from, result.reply || 'שלח לי הזמנה לחתונה ואוסיף אותה ללוח השנה 📅');
    return;
  }

  const data = await loadData();
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
  await saveData(data);

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
  if (!message) return;

  if (message.type === "text") {
    console.log(`📩 מ-${message.from}: ${message.text.body}`);
    await handleMessage(message.from, message.text.body);

  } else if (message.type === "image") {
    console.log(`🖼 תמונה מ-${message.from}`);
    await handleImage(message.from, message.image.id);
  }
});

async function handleImage(from, mediaId) {
  try {
    // 1. Get media URL from WhatsApp
    const mediaRes = await axios.get(
      `https://graph.facebook.com/v25.0/${mediaId}`,
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
    );
    const mediaUrl = mediaRes.data.url;

    // 2. Download image as base64
    const imgRes = await axios.get(mediaUrl, {
      responseType: "arraybuffer",
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }
    });
    const base64 = Buffer.from(imgRes.data).toString("base64");
    const mimeType = imgRes.headers["content-type"] || "image/jpeg";

    // 3. Send to Gemini Vision
    const gemRes = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
      {
        contents: [{
          parts: [
            { text: `זוהי הזמנה לחתונה. חלץ את הפרטים והחזר JSON בלבד:
{"isWedding":true/false,"names":"שמות הזוג","date":"YYYY-MM-DD","location":"מיקום"}` },
            { inline_data: { mime_type: mimeType, data: base64 } }
          ]
        }],
        generationConfig: { responseMimeType: "application/json" }
      },
      { headers: { "Content-Type": "application/json" } }
    );

    const raw = gemRes.data.candidates[0].content.parts[0].text;
    const result = JSON.parse(raw.replace(/```json\n?|\n?```/g, "").trim());

    if (!result.isWedding) {
      await sendMessage(from, "לא זיהיתי הזמנה לחתונה בתמונה 🤔\nאפשר לשלוח כטקסט?");
      return;
    }

    // Same flow as text message
    const data = await loadData();
    const wedding = {
      id: require("crypto").randomUUID(),
      names: result.names || "לא ידוע",
      date: result.date || null,
      location: result.location || null,
      giftAmount: null,
      rawMessage: "[תמונה]",
      createdAt: new Date().toISOString(),
    };
    data.weddings.push(wedding);
    await saveData(data);

    userStates[from] = { step: "waiting_gift", weddingId: wedding.id };

    const dateStr = wedding.date
      ? new Date(wedding.date).toLocaleDateString("he-IL", { day: "numeric", month: "long", year: "numeric" })
      : "תאריך לא נמצא";

    const dashboardUrl = APP_URL || `http://localhost:${PORT}`;
    await sendMessage(from,
      `📸 קראתי את ההזמנה!\n\n💒 ${wedding.names}\n📅 ${dateStr}${wedding.location ? "\n📍 " + wedding.location : ""}\n\nכמה אתה שם בצ'ק? 💰`
    );

  } catch (err) {
    console.error("Image error:", err.message);
    await sendMessage(from, "לא הצלחתי לקרוא את התמונה 😅\nנסה לשלוח את ההזמנה כטקסט.");
  }
}

// ─── Dashboard API ────────────────────────────────────────────────────────────
app.get("/api/weddings", async (req, res) => {
  const data = await loadData();
  res.json(data.weddings);
});

app.delete("/api/weddings/:id", async (req, res) => {
  const data = await loadData();
  data.weddings = data.weddings.filter(w => w.id !== req.params.id);
  await saveData(data);
  res.json({ ok: true });
});

app.put("/api/weddings/:id", async (req, res) => {
  const data = await loadData();
  const w = data.weddings.find(w => w.id === req.params.id);
  if (w) Object.assign(w, req.body);
  await saveData(data);
  res.json(w || { error: "not found" });
});

app.listen(PORT, () => console.log(`🚀 Wedding bot on http://localhost:${PORT}`));
