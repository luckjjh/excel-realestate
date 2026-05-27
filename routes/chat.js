const { Router } = require("express");
const { kv } = require("../lib/cache");
const { generateNickname } = require("../lib/areas");

const router = Router();

// --------------- 접속자 추적 ---------------
const activeUsers = {};
const ACTIVE_TTL = 60000;

function trackVisitor(uid) {
  activeUsers[uid] = Date.now();
}

function getOnlineCount() {
  const now = Date.now();
  for (const uid of Object.keys(activeUsers)) {
    if (now - activeUsers[uid] > ACTIVE_TTL) delete activeUsers[uid];
  }
  return Object.keys(activeUsers).length;
}

router.post("/api/heartbeat", async (req, res) => {
  const { uid } = req.body || {};
  if (!uid) return res.json({ ok: false });
  trackVisitor(uid);
  const online = getOnlineCount();
  let today = 0;
  if (kv) {
    const dateKey = `visitors:${new Date().toISOString().slice(0, 10)}`;
    try {
      await kv.sadd(dateKey, uid);
      await kv.expire(dateKey, 172800);
      today = await kv.scard(dateKey);
    } catch {}
  }
  res.json({ ok: true, online, today });
});

// --------------- 실시간 채팅 (KV 영속) ---------------
let chatMessages = [];
let chatIdCounter = 1;
const CHAT_MAX = 200;
const chatBanMap = {};
let chatLoaded = false;

async function loadChatHistory() {
  if (chatLoaded) return;
  chatLoaded = true;
  if (!kv) return;
  try {
    const saved = await kv.get("chat:messages");
    if (Array.isArray(saved) && saved.length) {
      chatMessages = saved;
      chatIdCounter = Math.max(...saved.map((m) => m.id)) + 1;
    }
  } catch {}
}

async function saveChatToKV() {
  if (!kv) return;
  try {
    await kv.set("chat:messages", chatMessages, { ex: 604800 });
  } catch {}
}

router.get("/api/chat", async (req, res) => {
  await loadChatHistory();
  const since = parseInt(req.query.since) || 0;
  const msgs = since
    ? chatMessages.filter((m) => m.id > since)
    : chatMessages.slice(-80);
  res.json({ ok: true, messages: msgs, online: getOnlineCount() || 1 });
});

router.post("/api/chat", async (req, res) => {
  await loadChatHistory();
  const { user_id, nickname, body } = req.body || {};
  if (!body || !body.trim()) return res.json({ ok: false, error: "empty" });
  if (body.length > 280) return res.json({ ok: false, error: "too_long" });
  const nick = (nickname || "").trim().slice(0, 24) || generateNickname(user_id);
  if (chatBanMap[user_id] && Date.now() - chatBanMap[user_id] < 2000) {
    return res.json({ ok: false, error: "rate_limit" });
  }
  chatBanMap[user_id] = Date.now();
  const msg = {
    id: chatIdCounter++,
    user_id: user_id || "anon",
    nickname: nick,
    body: body.trim().slice(0, 280),
    created_at: new Date().toISOString(),
  };
  chatMessages.push(msg);
  if (chatMessages.length > CHAT_MAX)
    chatMessages.splice(0, chatMessages.length - CHAT_MAX);
  saveChatToKV();
  res.json({ ok: true, message: msg });
});

// --------------- 토론 게시판 ---------------
const DISCUSS_MAX = 100;

router.get("/api/discuss", async (req, res) => {
  if (!kv) return res.json({ ok: true, posts: [] });
  try {
    const posts = (await kv.get("discuss:posts")) || [];
    res.json({ ok: true, posts });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

router.post("/api/discuss", async (req, res) => {
  if (!kv) return res.json({ ok: false, error: "KV not configured" });
  const { user_id, nickname, title, body } = req.body || {};
  if (!title?.trim() || !body?.trim())
    return res.json({ ok: false, error: "제목과 내용을 입력하세요" });
  if (title.length > 60) return res.json({ ok: false, error: "제목 60자 이내" });
  if (body.length > 1000) return res.json({ ok: false, error: "내용 1000자 이내" });
  const nick = (nickname || "").trim().slice(0, 24) || generateNickname(user_id);
  try {
    const posts = (await kv.get("discuss:posts")) || [];
    const post = {
      id: Date.now(), user_id: user_id || "anon", nickname: nick,
      title: title.trim().slice(0, 60), body: body.trim().slice(0, 1000),
      created_at: new Date().toISOString(), replies: [],
    };
    posts.unshift(post);
    if (posts.length > DISCUSS_MAX) posts.length = DISCUSS_MAX;
    await kv.set("discuss:posts", posts, { ex: 2592000 });
    res.json({ ok: true, post });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

router.post("/api/discuss/:id/reply", async (req, res) => {
  if (!kv) return res.json({ ok: false, error: "KV not configured" });
  const postId = parseInt(req.params.id);
  const { user_id, nickname, body } = req.body || {};
  if (!body?.trim()) return res.json({ ok: false, error: "내용을 입력하세요" });
  const nick = (nickname || "").trim().slice(0, 24) || generateNickname(user_id);
  try {
    const posts = (await kv.get("discuss:posts")) || [];
    const post = posts.find((p) => p.id === postId);
    if (!post) return res.json({ ok: false, error: "게시글 없음" });
    const reply = {
      id: Date.now(), user_id: user_id || "anon", nickname: nick,
      body: body.trim().slice(0, 500), created_at: new Date().toISOString(),
    };
    post.replies = post.replies || [];
    if (post.replies.length >= 50) return res.json({ ok: false, error: "댓글 50개 제한" });
    post.replies.push(reply);
    await kv.set("discuss:posts", posts, { ex: 2592000 });
    res.json({ ok: true, reply });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

module.exports = router;
