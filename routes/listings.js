const { Router } = require("express");
const axios = require("axios");
const { kv } = require("../lib/cache");
const { AREAS } = require("../lib/areas");
const { UA } = require("../lib/scraper");

const router = Router();

const NAVER_API = "https://new.land.naver.com/api/articles";
const NAVER_HEADERS = {
  "User-Agent": UA,
  Accept: "application/json, text/plain, */*",
  Referer: "https://new.land.naver.com/complexes",
  "sec-ch-ua": '"Google Chrome";v="125", "Chromium";v="125"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-origin",
};

const REAL_ESTATE_TYPES = {
  APT: "아파트",
  OPST: "오피스텔",
  VL: "빌라",
  ABYG: "아파트분양권",
  OR: "원룸",
};
const TRADE_TYPES = { A1: "매매", B1: "전세", B2: "월세" };

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

function parseArticle(a) {
  return {
    articleNo: a.articleNo,
    articleName: a.articleName || "",
    realEstateType: a.realEstateTypeName || "",
    tradeType: a.tradeTypeName || "",
    dealOrWarrantPrc: a.dealOrWarrantPrc || "",
    areaName: a.areaName || "",
    area1: a.area1 || "",
    area2: a.area2 || "",
    direction: a.direction || "",
    floorInfo: a.floorInfo || "",
    buildingName: a.buildingName || "",
    cpName: a.cpName || "",
    cpid: a.cpid || "",
    sameAddrMaxPrc: a.sameAddrMaxPrc || "",
    sameAddrMinPrc: a.sameAddrMinPrc || "",
    sameAddrCnt: a.sameAddrCnt || 0,
    tagList: a.tagList || [],
    realtorName: a.realtorName || "",
    cortarAddress: a.cortarAddress || "",
    detailUrl: `https://new.land.naver.com/articles/${a.articleNo}`,
  };
}

async function fetchListingPage(cortarNo, realEstateType, tradeType) {
  const r = await axios.get(NAVER_API, {
    params: {
      cortarNo, realEstateType, tradeType,
      page: 1, articleState: "R", order: "rank",
    },
    headers: NAVER_HEADERS,
    timeout: 5000,
    validateStatus: () => true,
  });
  if (r.status === 429) return { items: [], rateLimited: true };
  if (r.status !== 200) return { items: [], error: r.status };
  const articles = r.data?.articleList || [];
  return { items: articles.map(parseArticle) };
}

async function fetchRegionParallel(cortarNo) {
  const combos = [];
  for (const re of CRAWL_RE_TYPES) {
    for (const tr of CRAWL_TRADE_TYPES) combos.push({ re, tr });
  }
  const results = await Promise.allSettled(
    combos.map(({ re, tr }) => fetchListingPage(cortarNo, re, tr)),
  );
  const items = [];
  let rateLimited = false;
  for (const r of results) {
    if (r.status === "fulfilled") {
      if (r.value.rateLimited) rateLimited = true;
      items.push(...(r.value.items || []));
    }
  }
  return { items, rateLimited };
}

// --------------- 서빙 API ---------------

router.get("/api/listings", async (req, res) => {
  if (!kv) return res.json({ ok: false, error: "KV not configured" });

  const area = req.query.area || "";
  const type = req.query.type || "";
  const trade = req.query.trade || "";

  try {
    let items;

    if (area) {
      items = await kv.get(`listings:${area}`);
    } else {
      items = await kv.get("listings:all");
    }

    if (!items) return res.json({ ok: false, error: "데이터 없음 — 크롤링 대기 중" });

    let filtered = items;
    if (type) filtered = filtered.filter((i) => i.realEstateType === REAL_ESTATE_TYPES[type] || i.realEstateType === type);
    if (trade) filtered = filtered.filter((i) => i.tradeType === TRADE_TYPES[trade] || i.tradeType === trade);

    const meta = await kv.get("listings:meta");
    res.json({
      ok: true,
      data: filtered,
      total: items.length,
      filtered: filtered.length,
      area,
      crawledAt: meta?.crawledAt || null,
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

router.get("/api/listings/meta", async (_, res) => {
  if (!kv) return res.json({ ok: false, error: "KV not configured" });
  try {
    const meta = await kv.get("listings:meta");
    res.json({ ok: true, meta });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// --------------- 크롤링 (Vercel Cron) ---------------

const CRAWL_TRADE_TYPES = ["A1", "B1", "B2"];
const CRAWL_RE_TYPES = ["APT", "OPST", "VL"];
const CRAWL_BATCH_SIZE = 4;

router.get("/api/test-naver", async (req, res) => {
  const t0 = Date.now();
  try {
    const r = await axios.get(NAVER_API, {
      params: { cortarNo: "1168010100", realEstateType: "APT", tradeType: "A1", page: 1, articleState: "R", order: "rank" },
      headers: NAVER_HEADERS,
      timeout: 8000,
      validateStatus: () => true,
    });
    res.json({
      ok: true,
      status: r.status,
      elapsed: Date.now() - t0,
      bodyType: typeof r.data,
      sample: typeof r.data === "object" ? Object.keys(r.data || {}) : String(r.data).slice(0, 200),
      articleCount: r.data?.articleList?.length,
    });
  } catch (e) {
    res.json({ ok: false, error: e.message, code: e.code, elapsed: Date.now() - t0 });
  }
});

router.get("/api/crawl-listings", async (req, res) => {
  if (!kv) return res.json({ ok: false, error: "KV not configured" });

  const areaCodes = Object.keys(AREAS);
  const startIdx = parseInt(await kv.get("listings:nextIdx") || "0", 10) % areaCodes.length;

  const meta = await kv.get("listings:meta") || { regions: {} };
  const regions = meta.regions || {};
  const results = {};

  for (let i = 0; i < CRAWL_BATCH_SIZE; i++) {
    const idx = (startIdx + i) % areaCodes.length;
    const code = areaCodes[idx];
    const name = AREAS[code];

    const { items, rateLimited } = await fetchRegionParallel(code);
    await kv.set(`listings:${code}`, items, { ex: 172800 });
    regions[name] = items.length;
    results[name] = rateLimited ? `${items.length} (partial)` : items.length;

    if (i < CRAWL_BATCH_SIZE - 1) await delay(300);
  }

  const nextIdx = (startIdx + CRAWL_BATCH_SIZE) % areaCodes.length;
  await kv.set("listings:nextIdx", nextIdx);

  if (nextIdx <= startIdx) {
    const allItems = [];
    for (const code of areaCodes) {
      const regionItems = await kv.get(`listings:${code}`);
      if (Array.isArray(regionItems)) allItems.push(...regionItems);
    }
    await kv.set("listings:all", allItems, { ex: 172800 });
  }

  const newMeta = {
    crawledAt: new Date().toISOString(),
    totalItems: Object.values(regions).reduce((a, v) => a + (typeof v === "number" ? v : 0), 0),
    regions,
    nextIdx,
  };
  await kv.set("listings:meta", newMeta, { ex: 172800 });

  res.json({ ok: true, batch: `${startIdx}-${nextIdx}`, results });
});

module.exports = router;
