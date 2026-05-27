#!/usr/bin/env node
// 법원경매 지역별 매물 크롤러
// GitHub Actions에서 cron으로 실행 → Upstash KV에 저장
const axios = require("axios");
const { Redis } = require("@upstash/redis");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

const SIDO_CODES = {
  "11": "서울", "26": "부산", "27": "대구", "28": "인천",
  "29": "광주", "30": "대전", "31": "울산", "36": "세종",
  "41": "경기", "42": "강원", "43": "충북", "44": "충남",
  "45": "전북", "46": "전남", "47": "경북", "48": "경남",
  "50": "제주",
};

const INDEX_URL = "https://www.courtauction.go.kr/pgj/index.on";
const SEARCH_URL =
  "https://www.courtauction.go.kr/pgj/pgjsearch/searchControllerMain.on";

async function getSession() {
  const r = await axios.get(INDEX_URL, {
    headers: { "User-Agent": UA, "Accept-Language": "ko-KR,ko;q=0.9" },
    timeout: 15000,
    maxRedirects: 0,
    validateStatus: (s) => s < 400,
  });
  const cookies = (r.headers["set-cookie"] || [])
    .map((c) => c.split(";")[0])
    .filter(Boolean)
    .join("; ");
  if (!cookies.includes("JSESSIONID")) throw new Error("JSESSIONID not issued");
  return cookies;
}

function makeBody(sidoCode, page = 1, pageSize = 100) {
  return {
    dma_pageInfo: {
      pageNo: String(page),
      pageSize: String(pageSize),
      totalCnt: "",
      totalYn: "Y",
      startRowNo: "",
      groupTotalCount: "",
    },
    dma_srchGdsDtlSrchInfo: {
      cortAuctnSrchCondCd: "0004601",
      cortStDvs: "2",
      rprsAdongSdCd: sidoCode,
      rprsAdongSggCd: "",
      rprsAdongEmdCd: "",
      cortOfcCd: "",
      jdbnCd: "",
      lclDspslGdsLstUsgCd: "",
      mclDspslGdsLstUsgCd: "",
      sclDspslGdsLstUsgCd: "",
      aeeEvlAmtMin: "",
      aeeEvlAmtMax: "",
      lwsDspslPrcMin: "",
      lwsDspslPrcMax: "",
      lwsDspslPrcRateMin: "",
      lwsDspslPrcRateMax: "",
      flbdNcntMin: "",
      flbdNcntMax: "",
      objctArDtsMin: "",
      objctArDtsMax: "",
      bidBgngYmd: "",
      bidEndYmd: "",
      bidDvsCd: "",
      mvprpRletDvsCd: "",
      csNo: "",
      lafjOrderBy: "",
      pgmId: "PGJ151M01",
      notifyLoc: "",
      rletDspslSpcCondCd: "",
      dspslDxdyYmd: "",
      rdnmSdCd: "",
      rdnmSggCd: "",
      rdnmNo: "",
      cortAuctnMbrsId: "",
    },
  };
}

function parseItem(x) {
  const ymd = String(x.maeGiil || "");
  const saleDate =
    ymd.length === 8
      ? `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`
      : "";
  const yuchal = parseInt(x.yuchalCnt || "0", 10);
  return {
    caseNo: String(x.srnSaNo || ""),
    court: String(x.jiwonNm || ""),
    dept: String(x.jpDeptNm || ""),
    address: String(x.printSt || ""),
    sido: String(x.hjguSido || x.sdNm || ""),
    sigu: String(x.hjguSigu || x.sggNm || ""),
    usage: String(x.dspslUsgNm || ""),
    buldNm: String(x.buldNm || ""),
    area: String(x.pjbBuldList || x.objctArDts || ""),
    appraisal: String(x.gamevalAmt || ""),
    minPrice: String(x.minmaePrice || ""),
    saleDate,
    saleHour: String(x.maeHh1 || ""),
    yuchalCnt: yuchal,
    status: yuchal > 0 ? `${yuchal}회 유찰` : "진행",
    detailUrl: `https://www.courtauction.go.kr/pgj/index.on?w2xPath=/pgj/ui/pgj100/PGJ152F00.xml&srnSaNo=${encodeURIComponent(x.srnSaNo || "")}`,
  };
}

async function fetchRegion(cookie, headers, sidoCode, sidoName) {
  const allItems = [];
  let page = 1;
  const PAGE_SIZE = 100;
  const MAX_PAGES = 10;

  while (page <= MAX_PAGES) {
    const r = await axios.post(SEARCH_URL, makeBody(sidoCode, page, PAGE_SIZE), {
      headers: { ...headers, Cookie: cookie },
      timeout: 30000,
    });

    if (r.data?.message && r.data.message !== "정상") {
      console.error(`  [${sidoName}] API error: ${r.data.message}`);
      break;
    }

    const rows = r.data?.data?.dlt_srchResult || r.data?.dlt_srchResult || [];
    if (rows.length === 0) break;

    allItems.push(...rows.map(parseItem));

    const totalCnt = parseInt(
      r.data?.data?.dma_pageInfo?.totalCnt ||
        r.data?.dma_pageInfo?.totalCnt ||
        "0",
      10,
    );
    if (page * PAGE_SIZE >= totalCnt) break;
    page++;

    await delay(1500);
  }

  return allItems;
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const kvUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const kvToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!kvUrl || !kvToken) {
    console.error("KV_REST_API_URL / KV_REST_API_TOKEN required");
    process.exit(1);
  }
  const kv = new Redis({ url: kvUrl, token: kvToken });

  const targetSidos = process.env.AUCTION_SIDOS
    ? process.env.AUCTION_SIDOS.split(",")
    : Object.keys(SIDO_CODES);

  console.log(`[crawl-auction] targets: ${targetSidos.map((c) => SIDO_CODES[c] || c).join(", ")}`);

  const cookie = await getSession();
  console.log("[crawl-auction] session acquired");

  const headers = {
    "User-Agent": UA,
    "Accept-Language": "ko-KR,ko;q=0.9",
    "Content-Type": "application/json;charset=UTF-8",
    Accept: "application/json",
    Referer: INDEX_URL,
    Origin: "https://www.courtauction.go.kr",
    "X-Requested-With": "XMLHttpRequest",
  };

  const allItems = [];
  const summary = {};

  for (const code of targetSidos) {
    const name = SIDO_CODES[code] || code;
    try {
      const items = await fetchRegion(cookie, headers, code, name);
      console.log(`  [${name}] ${items.length}건`);
      summary[name] = items.length;

      await kv.set(`auction:${code}`, items, { ex: 86400 });
      allItems.push(...items);

      await delay(3000);
    } catch (e) {
      console.error(`  [${name}] FAILED: ${e.message}`);
      summary[name] = `ERROR: ${e.message}`;
    }
  }

  const meta = {
    crawledAt: new Date().toISOString(),
    totalItems: allItems.length,
    regions: summary,
    sidoCodes: targetSidos,
  };
  await kv.set("auction:meta", meta, { ex: 86400 });
  await kv.set("auction:all", allItems, { ex: 86400 });

  console.log(`\n[crawl-auction] done — total ${allItems.length}건`);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error("[crawl-auction] fatal:", e);
  process.exit(1);
});
