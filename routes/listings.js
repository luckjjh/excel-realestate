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

async function fetchListings(cortarNo, realEstateType, tradeType) {
  const items = [];
  const MAX_PAGES = 5;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await axios.get(NAVER_API, {
      params: {
        cortarNo,
        realEstateType,
        tradeType,
        page,
        articleState: "R",
        order: "rank",
      },
      headers: NAVER_HEADERS,
      timeout: 10000,
      validateStatus: () => true,
    });

    if (r.status === 429) throw new Error("RATE_LIMITED");
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);

    const articles = r.data?.articleList || [];
    if (articles.length === 0) break;
    items.push(...articles.map(parseArticle));

    if (articles.length < 20) break;
    await delay(3000);
  }

  return items;
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
const CRAWL_BATCH_SIZE = 1;

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
    const areaItems = [];

    for (const reType of CRAWL_RE_TYPES) {
      for (const trType of CRAWL_TRADE_TYPES) {
        try {
          const items = await fetchListings(code, reType, trType);
          areaItems.push(...items);
          await delay(4000);
        } catch (e) {
          if (e.message === "RATE_LIMITED") {
            results[name] = `RATE_LIMITED (partial ${areaItems.length})`;
            break;
          }
        }
      }
      if (results[name]?.startsWith("RATE_LIMITED")) break;
    }

    if (!results[name]) {
      results[name] = areaItems.length;
    }

    await kv.set(`listings:${code}`, areaItems, { ex: 172800 });
    regions[name] = areaItems.length;
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
