let kv = null;
{
  const url =
    process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token =
    process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) {
    try {
      const { Redis } = require("@upstash/redis");
      kv = new Redis({ url, token });
      console.log("[cache] Upstash KV connected");
    } catch (e) {
      console.log("[cache] KV init failed:", e.message);
    }
  } else {
    console.log("[cache] in-memory only (set KV_REST_API_URL/TOKEN to enable KV)");
  }
}

const _c = {};
async function cached(key, ttl, fn) {
  if (_c[key] && Date.now() - _c[key].t < ttl) return _c[key].d;
  if (kv) {
    try {
      const hit = await kv.get(key);
      if (hit != null) {
        _c[key] = { d: hit, t: Date.now() };
        return hit;
      }
    } catch (e) {
      console.log("[cache] KV read failed:", e.message);
    }
  }
  const d = await fn();
  _c[key] = { d, t: Date.now() };
  if (kv) {
    kv.set(key, d, { ex: Math.ceil(ttl / 1000) }).catch((e) =>
      console.log("[cache] KV write failed:", e.message),
    );
  }
  return d;
}

module.exports = { kv, cached };
