const { Router } = require("express");
const axios = require("axios");
const { kv, cached } = require("../lib/cache");
const { AUCTION_SIDO_MAP, AUCTION_SIDO_REVERSE } = require("../lib/areas");
const { UA } = require("../lib/scraper");

const router = Router();

const CRAWL_INDEX_URL = "https://www.courtauction.go.kr/pgj/index.on";
const CRAWL_SEARCH_URL =
  "https://www.courtauction.go.kr/pgj/pgjsearch/searchControllerMain.on";

async function fetchAuctionFromKV(sidoFilter) {
  if (!kv) return null;
  if (sidoFilter) {
    const code = AUCTION_SIDO_REVERSE[sidoFilter] || sidoFilter;
    const items = await kv.get(`auction:${code}`);
    if (!items) return null;
    const meta = await kv.get("auction:meta");
    return { items, meta };
  }
  const items = await kv.get("auction:all");
  if (!items) return null;
  const meta = await kv.get("auction:meta");
  return { items, meta };
}

async function fetchCourtAuctionFallback() {
  const baseHeaders = { "User-Agent": UA, "Accept-Language": "ko-KR,ko;q=0.9" };
  const r1 = await axios.get(CRAWL_INDEX_URL, {
    headers: baseHeaders, timeout: 15000, maxRedirects: 0,
    validateStatus: (s) => s < 400,
  });
  const setCookies = r1.headers["set-cookie"] || [];
  const cookieHeader = setCookies.map((c) => c.split(";")[0]).filter(Boolean).join("; ");
  if (!cookieHeader.includes("JSESSIONID")) throw new Error("JSESSIONID not issued");
  const r2 = await axios.post(
    "https://www.courtauction.go.kr/pgj/pgj111/selectRletYrDspslStats.on",
    { dma_nonData: {} },
    {
      headers: {
        ...baseHeaders, "Content-Type": "application/json;charset=UTF-8",
        Accept: "application/json", Referer: CRAWL_INDEX_URL,
        Origin: "https://www.courtauction.go.kr",
        "X-Requested-With": "XMLHttpRequest", Cookie: cookieHeader,
      },
      timeout: 20000,
    },
  );
  if (r2.data?.message && r2.data.message !== "정상") throw new Error(r2.data.message);
  const items = r2.data?.data?.result?.mjrtyItrtGds || [];
  return items.map((x) => {
    const ymd = String(x.maeGiil || "");
    const saleDate = ymd.length === 8 ? `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}` : "";
    const yuchal = parseInt(x.yuchalCnt || "0", 10);
    return {
      caseNo: String(x.srnSaNo || ""), court: String(x.jiwonNm || ""),
      dept: String(x.jpDeptNm || ""), address: String(x.printSt || ""),
      sido: String(x.hjguSido || ""), sigu: String(x.hjguSigu || ""),
      usage: String(x.dspslUsgNm || ""), buldNm: String(x.buldNm || ""),
      area: String(x.pjbBuldList || ""), appraisal: String(x.gamevalAmt || ""),
      minPrice: String(x.minmaePrice || ""), saleDate,
      saleHour: String(x.maeHh1 || ""), yuchalCnt: yuchal,
      status: yuchal > 0 ? `${yuchal}회 유찰` : "진행",
      detailUrl: `https://www.courtauction.go.kr/pgj/index.on?w2xPath=/pgj/ui/pgj100/PGJ152F00.xml&srnSaNo=${encodeURIComponent(x.srnSaNo || "")}`,
    };
  });
}

router.get("/api/auction", async (req, res) => {
  const sido = req.query.sido || "";
  try {
    const kvResult = await fetchAuctionFromKV(sido);
    if (kvResult) {
      const { items, meta } = kvResult;
      return res.json({
        ok: true, data: items, total: items.length, filtered: items.length,
        sido, source: "crawl", crawledAt: meta?.crawledAt || null,
        regions: meta?.regions || null,
      });
    }
    const all = await cached("auction_main", 12 * 60 * 60 * 1000, fetchCourtAuctionFallback);
    const data = sido
      ? all.filter((x) => x.sido === sido || x.sido.startsWith(sido))
      : all;
    res.json({
      ok: true, data, total: all.length, filtered: data.length, sido,
      source: "fallback",
      note: "KV 데이터 없음 — 메인페이지 '주요 관심물건'만 제공.",
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

router.get("/api/auction/regions", (_, res) => {
  res.json({ ok: true, regions: AUCTION_SIDO_MAP });
});

router.get("/api/auction/meta", async (_, res) => {
  if (!kv) return res.json({ ok: false, error: "KV not configured" });
  try {
    const meta = await kv.get("auction:meta");
    res.json({ ok: true, meta });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// --------------- 경매 크롤링 (Vercel Cron) ---------------
function makeCrawlBody(sidoCode, page = 1) {
  return {
    dma_pageInfo: {
      pageNo: String(page), pageSize: "20", totalCnt: "", totalYn: "Y",
      startRowNo: "", groupTotalCount: "",
    },
    dma_srchGdsDtlSrchInfo: {
      cortAuctnSrchCondCd: "0004601", cortStDvs: "2",
      rprsAdongSdCd: sidoCode, rprsAdongSggCd: "", rprsAdongEmdCd: "",
      cortOfcCd: "", jdbnCd: "", lclDspslGdsLstUsgCd: "",
      mclDspslGdsLstUsgCd: "", sclDspslGdsLstUsgCd: "",
      aeeEvlAmtMin: "", aeeEvlAmtMax: "", lwsDspslPrcMin: "", lwsDspslPrcMax: "",
      lwsDspslPrcRateMin: "", lwsDspslPrcRateMax: "",
      flbdNcntMin: "", flbdNcntMax: "", objctArDtsMin: "", objctArDtsMax: "",
      bidBgngYmd: "", bidEndYmd: "", bidDvsCd: "", mvprpRletDvsCd: "",
      csNo: "", lafjOrderBy: "", pgmId: "PGJ151M01", notifyLoc: "",
      rletDspslSpcCondCd: "", dspslDxdyYmd: "",
      rdnmSdCd: "", rdnmSggCd: "", rdnmNo: "", cortAuctnMbrsId: "",
    },
  };
}

function parseCrawlItem(x) {
  const ymd = String(x.maeGiil || "");
  const saleDate = ymd.length === 8
    ? `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}` : "";
  const yuchal = parseInt(x.yuchalCnt || "0", 10);
  return {
    caseNo: String(x.srnSaNo || ""), court: String(x.jiwonNm || ""),
    dept: String(x.jpDeptNm || ""), address: String(x.printSt || ""),
    sido: String(x.hjguSido || x.sdNm || ""),
    sigu: String(x.hjguSigu || x.sggNm || ""),
    usage: String(x.dspslUsgNm || ""), buldNm: String(x.buldNm || ""),
    area: String(x.pjbBuldList || x.objctArDts || ""),
    appraisal: String(x.gamevalAmt || ""), minPrice: String(x.minmaePrice || ""),
    saleDate, saleHour: String(x.maeHh1 || ""),
    yuchalCnt: yuchal, status: yuchal > 0 ? `${yuchal}회 유찰` : "진행",
    detailUrl: `https://www.courtauction.go.kr/pgj/index.on?w2xPath=/pgj/ui/pgj100/PGJ152F00.xml&srnSaNo=${encodeURIComponent(x.srnSaNo || "")}`,
  };
}

const CRAWL_BATCH_SIZE = 5;

router.get("/api/crawl-auction", async (req, res) => {
  if (!kv) return res.json({ ok: false, error: "KV not configured" });

  const sidoCodes = Object.keys(AUCTION_SIDO_MAP);
  const startIdx = parseInt(await kv.get("auction:nextIdx") || "0", 10) % sidoCodes.length;

  try {
    const r1 = await axios.get(CRAWL_INDEX_URL, {
      headers: { "User-Agent": UA, "Accept-Language": "ko-KR,ko;q=0.9" },
      timeout: 5000, maxRedirects: 0, validateStatus: (s) => s < 400,
    });
    const cookies = (r1.headers["set-cookie"] || [])
      .map((c) => c.split(";")[0]).filter(Boolean).join("; ");

    const hdrs = {
      "User-Agent": UA, "Accept-Language": "ko-KR,ko;q=0.9",
      "Content-Type": "application/json;charset=UTF-8",
      Accept: "application/json", Referer: CRAWL_INDEX_URL,
      Origin: "https://www.courtauction.go.kr",
      "X-Requested-With": "XMLHttpRequest", Cookie: cookies,
    };

    const meta = await kv.get("auction:meta") || { regions: {} };
    const regions = meta.regions || {};
    const results = {};

    for (let i = 0; i < CRAWL_BATCH_SIZE; i++) {
      const idx = (startIdx + i) % sidoCodes.length;
      const code = sidoCodes[idx];
      const name = AUCTION_SIDO_MAP[code];
      try {
        const r2 = await axios.post(CRAWL_SEARCH_URL, makeCrawlBody(code, 1), {
          headers: hdrs, timeout: 4000, validateStatus: () => true,
        });
        if (r2.status !== 200) throw new Error(`HTTP ${r2.status}`);
        const rows = r2.data?.data?.dlt_srchResult || [];
        const items = rows.map(parseCrawlItem);
        await kv.set(`auction:${code}`, items, { ex: 172800 });
        regions[name] = items.length;
        results[name] = items.length;
      } catch (e) {
        regions[name] = `ERROR: ${e.message}`;
        results[name] = `ERROR: ${e.message}`;
      }
    }

    const nextIdx = (startIdx + CRAWL_BATCH_SIZE) % sidoCodes.length;
    await kv.set("auction:nextIdx", nextIdx);

    if (nextIdx <= startIdx) {
      const allItems = [];
      for (const code of sidoCodes) {
        const regionItems = await kv.get(`auction:${code}`);
        if (Array.isArray(regionItems)) allItems.push(...regionItems);
      }
      await kv.set("auction:all", allItems, { ex: 172800 });
    }

    const newMeta = {
      crawledAt: new Date().toISOString(),
      totalItems: Object.values(regions).reduce((a, v) => a + (typeof v === "number" ? v : 0), 0),
      regions, sidoCodes, nextIdx,
    };
    await kv.set("auction:meta", newMeta, { ex: 172800 });

    res.json({ ok: true, batch: `${startIdx}-${nextIdx}`, results });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

module.exports = router;
