const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.DATA_API_KEY || "";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

app.use(express.static(path.join(__dirname, "public")));

// --------------- Cache (L1: memory, L2: Upstash KV) ---------------
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

// --------------- News: Naver + Google RSS fallback ---------------
async function scrapeNaverNews(query) {
  const url = `https://search.naver.com/search.naver?where=news&query=${encodeURIComponent(query)}&sort=1&nso=so:dd,p:1d,a:all`;
  const { data } = await axios.get(url, {
    headers: { "User-Agent": UA, "Accept-Language": "ko-KR,ko;q=0.9" },
    timeout: 10000,
  });
  if (data.includes("captcha") || data.includes("자동입력방지"))
    throw new Error("captcha");
  const $ = cheerio.load(data);
  const items = [];
  $("div.news_area").each((_, el) => {
    const $e = $(el);
    const titleEl = $e.find("a.news_tit");
    const title = titleEl.text().trim();
    if (!title) return;
    const link = titleEl.attr("href") || "";
    const summary = $e
      .find(".news_dsc .dsc_txt_wrap, .news_dsc")
      .first()
      .text()
      .trim();
    const source = $e
      .find(".info.press")
      .first()
      .text()
      .trim()
      .replace("언론사 선정", "");
    let time = "";
    $e.find("span.info").each((__, s) => {
      const t = $(s).text().trim();
      if (t.includes("전") || t.includes(":") || /\d+\.\d+\./.test(t)) time = t;
    });
    items.push({ title, link, summary: summary.slice(0, 200), source, time });
  });
  if (items.length === 0) throw new Error("empty");
  return items;
}

async function fetchGoogleRSS(query) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=ko&gl=KR&ceid=KR:ko`;
  const { data } = await axios.get(url, {
    headers: { "User-Agent": UA },
    timeout: 10000,
    responseType: "text",
  });
  const $ = cheerio.load(data, { xmlMode: true });
  const items = [];
  $("item").each((_, el) => {
    const raw = $(el).find("title").text();
    const parts = raw.split(" - ");
    const source = parts.length > 1 ? parts.pop().trim() : "";
    const title = parts.join(" - ").trim();
    const pubDate = $(el).find("pubDate").text();
    // <link> in RSS: cheerio xmlMode may not parse it correctly, extract from raw XML
    const elHtml = $.html(el);
    const linkMatch = elHtml.match(/<link>(.*?)<\/link>/);
    const link = linkMatch ? linkMatch[1].trim() : "";
    // Extract summary from description HTML
    const descHtml = $(el).find("description").text();
    let summary = "";
    if (descHtml) {
      const $d = cheerio.load(descHtml);
      summary = $d
        .text()
        .replace(title, "")
        .replace(source, "")
        .trim()
        .slice(0, 200);
    }
    items.push({ title, source, link, time: timeAgo(pubDate), summary });
  });
  return items.slice(0, 15);
}

function timeAgo(dateStr) {
  try {
    const diff = Date.now() - new Date(dateStr).getTime();
    const min = Math.floor(diff / 60000);
    if (min < 1) return "방금";
    if (min < 60) return `${min}분 전`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}시간 전`;
    const d = new Date(dateStr);
    return `${d.getMonth() + 1}.${d.getDate()}`;
  } catch {
    return "";
  }
}

async function fetchNews(query) {
  try {
    return await scrapeNaverNews(query);
  } catch {
    return await fetchGoogleRSS(query);
  }
}

app.get("/api/news", async (req, res) => {
  try {
    const data = await cached("news", 5 * 60 * 1000, async () => {
      const cats = [
        ["policy", "부동산 정책 규제"],
        ["market", "아파트 매매 시세"],
        ["auction", "부동산 경매 낙찰"],
        ["supply", "청약 분양 입주"],
      ];
      const all = [];
      for (const [cat, q] of cats) {
        try {
          const items = await fetchNews(q);
          all.push(...items.map((n) => ({ ...n, cat })));
        } catch {}
      }
      const seen = new Set();
      return all.filter((n) => {
        if (seen.has(n.title)) return false;
        seen.add(n.title);
        return true;
      });
    });
    res.json({ ok: true, data });
  } catch (e) {
    res.json({ ok: false, error: e.message, data: [] });
  }
});

// --------------- 실거래가: 공공데이터포털 API ---------------
const AREAS = {
  11110: "종로구",
  11140: "중구",
  11170: "용산구",
  11200: "성동구",
  11215: "광진구",
  11230: "동대문구",
  11260: "중랑구",
  11290: "성북구",
  11305: "강북구",
  11320: "도봉구",
  11350: "노원구",
  11380: "은평구",
  11410: "서대문구",
  11440: "마포구",
  11470: "양천구",
  11500: "강서구",
  11530: "구로구",
  11545: "금천구",
  11560: "영등포구",
  11590: "동작구",
  11620: "관악구",
  11650: "서초구",
  11680: "강남구",
  11710: "송파구",
  11740: "강동구",
  // 수원
  41111: "수원 장안구",
  41113: "수원 권선구",
  41115: "수원 팔달구",
  41117: "수원 영통구",
  // 성남
  41131: "성남 수정구",
  41133: "성남 중원구",
  41135: "성남 분당구",
  // 의정부 / 안양
  41150: "의정부시",
  41171: "안양 만안구",
  41173: "안양 동안구",
  // 부천 / 광명 / 평택 / 동두천
  41190: "부천시",
  41210: "광명시",
  41220: "평택시",
  41250: "동두천시",
  // 안산
  41271: "안산 상록구",
  41273: "안산 단원구",
  // 고양
  41281: "고양 덕양구",
  41285: "고양 일산동구",
  41287: "고양 일산서구",
  // 과천 / 구리 / 남양주
  41290: "과천시",
  41310: "구리시",
  41360: "남양주시",
  // 오산 / 시흥 / 군포 / 의왕
  41370: "오산시",
  41390: "시흥시",
  41410: "군포시",
  41430: "의왕시",
  // 하남 / 용인
  41450: "하남시",
  41461: "용인 처인구",
  41463: "용인 기흥구",
  41465: "용인 수지구",
  // 파주 / 이천 / 안성 / 김포
  41480: "파주시",
  41500: "이천시",
  41550: "안성시",
  41570: "김포시",
  // 화성 (2024.5 일반구 분리)
  41591: "화성 남양/향남",
  41593: "화성 봉담",
  41595: "화성 병점",
  41597: "화성 동탄",
  // 광주 / 양주 / 포천 / 여주
  41610: "광주시",
  41630: "양주시",
  41650: "포천시",
  41670: "여주시",
};

app.get("/api/areas", (_, res) => res.json(AREAS));

app.get("/api/trades", async (req, res) => {
  if (!API_KEY) return res.json({ ok: false, error: "NO_KEY" });
  const area = req.query.area || "11680";
  const now = new Date();
  const ym =
    req.query.month ||
    `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;
  try {
    const data = await cached(`tx_${area}_${ym}`, 30 * 60 * 1000, async () => {
      const all = [];
      const PER = 1000;
      for (let pageNo = 1; pageNo <= 10; pageNo++) {
        const { data: resp } = await axios.get(
          "https://apis.data.go.kr/1613000/RTMSDataSvcAptTradeDev/getRTMSDataSvcAptTradeDev",
          {
            params: {
              serviceKey: API_KEY,
              LAWD_CD: area,
              DEAL_YMD: ym,
              numOfRows: PER,
              pageNo,
            },
            headers: { "User-Agent": UA },
            timeout: 15000,
          },
        );
        const body = resp?.response?.body;
        const code = resp?.response?.header?.resultCode;
        if (code && code !== "000" && code !== "00")
          throw new Error(
            resp?.response?.header?.resultMsg || `API error: ${code}`,
          );
        let raw = body?.items?.item || [];
        if (!Array.isArray(raw)) raw = [raw];
        all.push(...raw);
        const total = parseInt(body?.totalCount || 0);
        if (raw.length < PER || all.length >= total) break;
      }
      return all
        .map((i) => ({
          name: String(i.aptNm || ""),
          dong: String(i.umdNm || ""),
          area: String(i.excluUseAr || ""),
          floor: String(i.floor || ""),
          price: String(i.dealAmount || ""),
          year: String(i.dealYear || ""),
          month: String(i.dealMonth || ""),
          day: String(i.dealDay || ""),
          built: String(i.buildYear || ""),
          roadNm: String(i.roadNm || ""),
        }))
        .sort((a, b) => parseInt(b.day || 0) - parseInt(a.day || 0));
    });
    res.json({
      ok: true,
      data,
      area,
      areaName: AREAS[area] || area,
      month: ym,
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// --------------- 실거래 요약 (주요지표 탭용) ---------------
app.get("/api/summary", async (req, res) => {
  if (!API_KEY) return res.json({ ok: false, error: "NO_KEY" });
  const now = new Date();
  const ym = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;
  const prev =
    now.getMonth() === 0
      ? `${now.getFullYear() - 1}12`
      : `${now.getFullYear()}${String(now.getMonth()).padStart(2, "0")}`;
  const keyAreas = [
    "11680",
    "11650",
    "11710",
    "11170",
    "11440",
    "11200",
    "11560",
    "11470",
    "11590",
    "11350",
  ];
  try {
    const data = await cached(`summary_${ym}`, 60 * 60 * 1000, async () => {
      const results = [];
      for (const area of keyAreas) {
        try {
          const { data: resp } = await axios.get(
            "https://apis.data.go.kr/1613000/RTMSDataSvcAptTradeDev/getRTMSDataSvcAptTradeDev",
            {
              params: {
                serviceKey: API_KEY,
                LAWD_CD: area,
                DEAL_YMD: ym,
                numOfRows: 200,
                pageNo: 1,
              },
              headers: { "User-Agent": UA },
              timeout: 15000,
            },
          );
          let raw = resp?.response?.body?.items?.item || [];
          if (!Array.isArray(raw)) raw = [raw];
          const items = [];
          for (const el of raw) {
            const price =
              parseInt(String(el.dealAmount || "").replace(/[, ]/g, "")) || 0;
            const a = parseFloat(el.excluUseAr) || 0;
            if (price > 0) items.push({ price, area: a });
          }
          const count = items.length;
          const avgPrice =
            count > 0
              ? Math.round(items.reduce((s, i) => s + i.price, 0) / count)
              : 0;
          const items84 = items.filter((i) => i.area >= 80 && i.area <= 90);
          const avg84 =
            items84.length > 0
              ? Math.round(
                  items84.reduce((s, i) => s + i.price, 0) / items84.length,
                )
              : 0;
          results.push({
            code: area,
            name: AREAS[area],
            count,
            avgPrice,
            avg84,
            month: ym,
          });
        } catch {}
      }
      return results;
    });
    res.json({ ok: true, data, month: ym, prevMonth: prev });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// --------------- 청약홈 분양정보 (odcloud API) ---------------
const ODCLOUD = "https://api.odcloud.kr/api";

app.get("/api/subscriptions", async (req, res) => {
  if (!API_KEY) return res.json({ ok: false, error: "NO_KEY" });
  try {
    const data = await cached("subs2", 30 * 60 * 1000, async () => {
      const now = new Date();
      const from = new Date(now.getFullYear(), now.getMonth() - 2, 1);
      const fromStr = `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, "0")}-01`;

      // 일반 APT 분양정보
      const [aptRes, remndrRes, mdlRes] = await Promise.all([
        axios.get(
          `${ODCLOUD}/ApplyhomeInfoDetailSvc/v1/getAPTLttotPblancDetail`,
          {
            params: {
              serviceKey: API_KEY,
              page: 1,
              perPage: 100,
              "cond[RCRIT_PBLANC_DE::GTE]": fromStr,
            },
            timeout: 15000,
          },
        ),
        // 잔여세대(줍줍)
        axios.get(
          `${ODCLOUD}/ApplyhomeInfoDetailSvc/v1/getRemndrLttotPblancDetail`,
          {
            params: {
              serviceKey: API_KEY,
              page: 1,
              perPage: 50,
              "cond[RCRIT_PBLANC_DE::GTE]": fromStr,
            },
            timeout: 15000,
          },
        ),
        // 주택형별 분양가
        axios.get(`${ODCLOUD}/ApplyhomeInfoDetailSvc/v1/getAPTLttotPblancMdl`, {
          params: { serviceKey: API_KEY, page: 1, perPage: 500 },
          timeout: 15000,
        }),
      ]);

      const mapItem = (i, supplyType) => ({
        name: i.HOUSE_NM,
        addr: i.HSSPLY_ADRES,
        region: i.SUBSCRPT_AREA_CODE_NM,
        units: i.TOT_SUPLY_HSHLDCO,
        startDate:
          i.RCEPT_BGNDE || i.GNRL_RCEPT_BGNDE || i.SUBSCRPT_RCEPT_BGNDE,
        endDate: i.RCEPT_ENDDE || i.GNRL_RCEPT_ENDDE || i.SUBSCRPT_RCEPT_ENDDE,
        spsplyStart: i.SPSPLY_RCEPT_BGNDE,
        spsplyEnd: i.SPSPLY_RCEPT_ENDDE,
        rank1Start: i.GNRL_RNK1_CRSPAREA_RCPTDE,
        rank1End: i.GNRL_RNK1_CRSPAREA_ENDDE,
        rank2Start: i.GNRL_RNK2_CRSPAREA_RCPTDE,
        rank2End: i.GNRL_RNK2_CRSPAREA_ENDDE,
        announceDate: i.RCRIT_PBLANC_DE,
        winnerDate: i.PRZWNER_PRESNATN_DE,
        moveIn: i.MVN_PREARNGE_YM,
        houseType: i.HOUSE_DTL_SECD_NM || "",
        rentType: i.RENT_SECD_NM || "",
        url: i.PBLANC_URL,
        manageNo: i.HOUSE_MANAGE_NO,
        pblancNo: i.PBLANC_NO,
        supplyType,
        homepage: i.HMPG_ADRES || "",
      });

      const aptItems = (aptRes.data.data || []).map((i) =>
        mapItem(
          i,
          (i.HOUSE_DTL_SECD_NM || "").includes("민영") ? "민영" : "공공",
        ),
      );
      const remndrItems = (remndrRes.data.data || []).map((i) =>
        mapItem(i, "줍줍"),
      );
      const all = [...aptItems, ...remndrItems];

      // 분양가 매핑
      const priceMap = {};
      for (const m of mdlRes.data.data || []) {
        const no = m.HOUSE_MANAGE_NO;
        const price = parseInt(m.LTTOT_TOP_AMOUNT) || 0;
        if (!priceMap[no] || price > priceMap[no]) priceMap[no] = price;
      }

      return all
        .map((i) => ({ ...i, topPrice: priceMap[i.manageNo] || null }))
        .sort((a, b) => (b.startDate || "").localeCompare(a.startDate || ""));
    });

    // 경쟁률 데이터 (별도 캐시, 자주 변경됨)
    let compMap = {};
    try {
      const comp = await cached("comp2", 60 * 60 * 1000, async () => {
        const { data: d } = await axios.get(
          `${ODCLOUD}/ApplyhomeInfoCmpetRtSvc/v1/getAPTLttotPblancCmpet`,
          {
            params: { serviceKey: API_KEY, page: 1, perPage: 500 },
            timeout: 15000,
          },
        );
        return d.data || [];
      });
      for (const c of comp) {
        const key = c.HOUSE_MANAGE_NO;
        if (!compMap[key]) compMap[key] = [];
        compMap[key].push({
          rank: c.SUBSCRPT_RANK_CODE,
          region: c.RESIDE_SENM,
          rate: c.CMPET_RATE,
          supply: c.SUPLY_HSHLDCO,
          req: c.REQ_CNT,
          houseType: c.HOUSE_TY,
        });
      }
    } catch {}

    const enriched = data.map((d) => {
      const comp = compMap[d.manageNo];
      let compSummary = "";
      if (comp && comp.length > 0) {
        const r1 = comp.find((c) => c.rank == 1 && c.region === "해당지역");
        const r2 = comp.find((c) => c.rank == 2 && c.region === "해당지역");
        if (r1 && r1.rate) compSummary = `1순위 ${r1.rate}`;
        if (r2 && r2.rate)
          compSummary += compSummary
            ? ` / 2순위 ${r2.rate}`
            : `2순위 ${r2.rate}`;
      }
      return { ...d, compSummary };
    });

    res.json({ ok: true, data: enriched });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.get("/api/competition", async (req, res) => {
  if (!API_KEY) return res.json({ ok: false, error: "NO_KEY" });
  try {
    const data = await cached("comp", 60 * 60 * 1000, async () => {
      const { data: d } = await axios.get(
        `${ODCLOUD}/ApplyhomeInfoCmpetRtSvc/v1/getAPTLttotPblancCmpet`,
        {
          params: { serviceKey: API_KEY, page: 1, perPage: 100 },
          timeout: 15000,
        },
      );
      return (d.data || []).map((i) => ({
        manageNo: i.HOUSE_MANAGE_NO,
        houseType: i.HOUSE_TY,
        rate: i.CMPET_RATE,
        supply: i.SUPLY_HSHLDCO,
        reqCnt: i.REQ_CNT,
        rank: i.SUBSCRPT_RANK_CODE,
        region: i.RESIDE_SENM,
      }));
    });
    res.json({ ok: true, data });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// --------------- 실시간 채팅 ---------------
const chatMessages = [];
let chatIdCounter = 1;
const CHAT_MAX = 200;
const chatBanMap = {};

app.use(express.json());

app.get("/api/chat", (req, res) => {
  const since = parseInt(req.query.since) || 0;
  const msgs = since
    ? chatMessages.filter((m) => m.id > since)
    : chatMessages.slice(-80);
  res.json({
    ok: true,
    messages: msgs,
    online:
      Object.keys(chatBanMap).length || Math.floor(Math.random() * 20) + 5,
  });
});

app.post("/api/chat", (req, res) => {
  const { user_id, nickname, body } = req.body || {};
  if (!body || !body.trim()) return res.json({ ok: false, error: "empty" });
  if (body.length > 280) return res.json({ ok: false, error: "too_long" });
  const nick =
    (nickname || "").trim().slice(0, 24) ||
    `부동산러버_${(user_id || "").slice(-3)}`;
  // rate limit: 1 msg per 2s per user
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
  res.json({ ok: true, message: msg });
});

// --------------- 청약 상세조회 ---------------
app.get("/api/subscription-detail", async (req, res) => {
  const { manageNo } = req.query;
  if (!manageNo || !API_KEY)
    return res.json({ ok: false, error: "missing params" });
  try {
    const data = await cached(
      `subdet_${manageNo}`,
      60 * 60 * 1000,
      async () => {
        const [infoRes, mdlRes, compRes] = await Promise.all([
          axios.get(
            `${ODCLOUD}/ApplyhomeInfoDetailSvc/v1/getAPTLttotPblancDetail`,
            {
              params: { serviceKey: API_KEY, page: 1, perPage: 500 },
              timeout: 15000,
            },
          ),
          axios.get(
            `${ODCLOUD}/ApplyhomeInfoDetailSvc/v1/getAPTLttotPblancMdl`,
            {
              params: { serviceKey: API_KEY, page: 1, perPage: 500 },
              timeout: 15000,
            },
          ),
          axios.get(
            `${ODCLOUD}/ApplyhomeInfoCmpetRtSvc/v1/getAPTLttotPblancCmpet`,
            {
              params: { serviceKey: API_KEY, page: 1, perPage: 500 },
              timeout: 15000,
            },
          ),
        ]);
        const info = (infoRes.data.data || []).find(
          (i) => String(i.HOUSE_MANAGE_NO) === String(manageNo),
        );
        const models = (mdlRes.data.data || []).filter(
          (m) => String(m.HOUSE_MANAGE_NO) === String(manageNo),
        );
        const comps = (compRes.data.data || []).filter(
          (c) => String(c.HOUSE_MANAGE_NO) === String(manageNo),
        );
        return {
          info: info
            ? {
                name: info.HOUSE_NM,
                addr: info.HSSPLY_ADRES,
                builder: info.BSNS_MBY_NM,
                constructor: info.CNSTRCT_ENTRPS_NM,
                totalUnits: info.TOT_SUPLY_HSHLDCO,
                type: info.HOUSE_DTL_SECD_NM,
                rentType: info.RENT_SECD_NM,
                region: info.SUBSCRPT_AREA_CODE_NM,
                announceDate: info.RCRIT_PBLANC_DE,
                spsplyStart: info.SPSPLY_RCEPT_BGNDE,
                spsplyEnd: info.SPSPLY_RCEPT_ENDDE,
                rank1Start: info.GNRL_RNK1_CRSPAREA_RCPTDE,
                rank1End: info.GNRL_RNK1_CRSPAREA_ENDDE,
                rank2Start: info.GNRL_RNK2_CRSPAREA_RCPTDE,
                rank2End: info.GNRL_RNK2_CRSPAREA_ENDDE,
                winnerDate: info.PRZWNER_PRESNATN_DE,
                contractStart: info.CNTRCT_CNCLS_BGNDE,
                contractEnd: info.CNTRCT_CNCLS_ENDDE,
                moveIn: info.MVN_PREARNGE_YM,
                homepage: info.HMPG_ADRES,
                url: info.PBLANC_URL,
              }
            : null,
          models: models.map((m) => ({
            houseType: m.HOUSE_TY,
            supplyArea: m.SUPLY_AR,
            topPrice: m.LTTOT_TOP_AMOUNT,
            supplyCount: m.SUPLY_HSHLDCO,
            spsplyCount: m.SPSPLY_HSHLDCO,
            generalCount: m.SUPLY_HSHLDCO,
            newlywed: m.NWWDS_HSHLDCO,
            firstLife: m.LFE_FRST_HSHLDCO,
            multiChild: m.MNYCH_HSHLDCO,
            oldParent: m.OLD_PARNTS_SUPORT_HSHLDCO,
            institution: m.INSTT_RECOMEND_HSHLDCO,
          })),
          competition: comps.map((c) => ({
            houseType: c.HOUSE_TY,
            rank: c.SUBSCRPT_RANK_CODE,
            region: c.RESIDE_SENM,
            rate: c.CMPET_RATE,
            supply: c.SUPLY_HSHLDCO,
            reqCount: c.REQ_CNT,
          })),
        };
      },
    );
    res.json({ ok: true, data });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// --------------- (경매: 추후 CODEF API 연동 예정) ---------------

// --------------- 아파트 가격 히스토리 (최근 12개월) ---------------
app.get("/api/price-history", async (req, res) => {
  if (!API_KEY) return res.json({ ok: false, error: "NO_KEY" });
  const { area, name } = req.query;
  if (!area || !name)
    return res.json({ ok: false, error: "area and name required" });
  try {
    const data = await cached(
      `ph_${area}_${name}`,
      60 * 60 * 1000,
      async () => {
        const now = new Date();
        const months = [];
        for (let i = 0; i < 12; i++) {
          const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
          months.push(
            `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`,
          );
        }
        const results = [];
        for (const ym of months) {
          try {
            const { data: resp } = await axios.get(
              "https://apis.data.go.kr/1613000/RTMSDataSvcAptTradeDev/getRTMSDataSvcAptTradeDev",
              {
                params: {
                  serviceKey: API_KEY,
                  LAWD_CD: area,
                  DEAL_YMD: ym,
                  numOfRows: 300,
                  pageNo: 1,
                },
                headers: { "User-Agent": UA },
                timeout: 15000,
              },
            );
            let raw = resp?.response?.body?.items?.item || [];
            if (!Array.isArray(raw)) raw = [raw];
            const matched = raw.filter((i) =>
              String(i.aptNm || "").includes(name),
            );
            for (const m of matched) {
              results.push({
                price:
                  parseInt(String(m.dealAmount || "").replace(/[, ]/g, "")) ||
                  0,
                area: parseFloat(m.excluUseAr) || 0,
                floor: String(m.floor || ""),
                date: `${m.dealYear}-${String(m.dealMonth).padStart(2, "0")}-${String(m.dealDay).padStart(2, "0")}`,
                ym,
              });
            }
          } catch {}
        }
        return results.sort((a, b) => a.date.localeCompare(b.date));
      },
    );
    res.json({ ok: true, data, name, area });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// --------------- 법원경매 (courtauction.go.kr) ---------------
// GitHub Actions(scripts/crawl-auction.js)에서 지역별 크롤링 → Upstash KV 저장.
// 서버는 KV에서 캐시된 결과를 서빙. IP 차단 회피.
// fallback: KV 미설정 시 메인페이지 "주요 관심물건"만 제공.

const AUCTION_SIDO_MAP = {
  "11": "서울", "26": "부산", "27": "대구", "28": "인천",
  "29": "광주", "30": "대전", "31": "울산", "36": "세종",
  "41": "경기", "42": "강원", "43": "충북", "44": "충남",
  "45": "전북", "46": "전남", "47": "경북", "48": "경남",
  "50": "제주",
};
const AUCTION_SIDO_REVERSE = Object.fromEntries(
  Object.entries(AUCTION_SIDO_MAP).map(([k, v]) => [v, k]),
);

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
  const indexUrl = "https://www.courtauction.go.kr/pgj/index.on";
  const apiUrl =
    "https://www.courtauction.go.kr/pgj/pgj111/selectRletYrDspslStats.on";
  const baseHeaders = {
    "User-Agent": UA,
    "Accept-Language": "ko-KR,ko;q=0.9",
  };
  const r1 = await axios.get(indexUrl, {
    headers: baseHeaders,
    timeout: 15000,
    maxRedirects: 0,
    validateStatus: (s) => s < 400,
  });
  const setCookies = r1.headers["set-cookie"] || [];
  const cookieHeader = setCookies
    .map((c) => c.split(";")[0])
    .filter(Boolean)
    .join("; ");
  if (!cookieHeader.includes("JSESSIONID")) {
    throw new Error("JSESSIONID not issued");
  }
  const r2 = await axios.post(
    apiUrl,
    { dma_nonData: {} },
    {
      headers: {
        ...baseHeaders,
        "Content-Type": "application/json;charset=UTF-8",
        Accept: "application/json",
        Referer: indexUrl,
        Origin: "https://www.courtauction.go.kr",
        "X-Requested-With": "XMLHttpRequest",
        Cookie: cookieHeader,
      },
      timeout: 20000,
    },
  );
  if (r2.data?.message && r2.data.message !== "정상") {
    throw new Error(r2.data.message);
  }
  const items = r2.data?.data?.result?.mjrtyItrtGds || [];
  return items.map((x) => {
    const ymd = String(x.maeGiil || "");
    const saleDate =
      ymd.length === 8 ? `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}` : "";
    const yuchal = parseInt(x.yuchalCnt || "0", 10);
    return {
      caseNo: String(x.srnSaNo || ""),
      court: String(x.jiwonNm || ""),
      dept: String(x.jpDeptNm || ""),
      address: String(x.printSt || ""),
      sido: String(x.hjguSido || ""),
      sigu: String(x.hjguSigu || ""),
      usage: String(x.dspslUsgNm || ""),
      buldNm: String(x.buldNm || ""),
      area: String(x.pjbBuldList || ""),
      appraisal: String(x.gamevalAmt || ""),
      minPrice: String(x.minmaePrice || ""),
      saleDate,
      saleHour: String(x.maeHh1 || ""),
      yuchalCnt: yuchal,
      status: yuchal > 0 ? `${yuchal}회 유찰` : "진행",
      detailUrl: `https://www.courtauction.go.kr/pgj/index.on?w2xPath=/pgj/ui/pgj100/PGJ152F00.xml&srnSaNo=${encodeURIComponent(
        x.srnSaNo || "",
      )}`,
    };
  });
}

app.get("/api/auction", async (req, res) => {
  const sido = req.query.sido || "";
  try {
    const kvResult = await fetchAuctionFromKV(sido);
    if (kvResult) {
      const { items, meta } = kvResult;
      return res.json({
        ok: true,
        data: items,
        total: items.length,
        filtered: items.length,
        sido,
        source: "crawl",
        crawledAt: meta?.crawledAt || null,
        regions: meta?.regions || null,
      });
    }
    const all = await cached("auction_main", 12 * 60 * 60 * 1000, fetchCourtAuctionFallback);
    const data = sido
      ? all.filter((x) => x.sido === sido || x.sido.startsWith(sido))
      : all;
    res.json({
      ok: true,
      data,
      total: all.length,
      filtered: data.length,
      sido,
      source: "fallback",
      note: "KV 데이터 없음 — 메인페이지 '주요 관심물건'만 제공. GitHub Actions 크롤러 설정 필요.",
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.get("/api/auction/regions", (_, res) => {
  res.json({ ok: true, regions: AUCTION_SIDO_MAP });
});

app.get("/api/auction/meta", async (_, res) => {
  if (!kv) return res.json({ ok: false, error: "KV not configured" });
  try {
    const meta = await kv.get("auction:meta");
    res.json({ ok: true, meta });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// --------------- 경매 크롤링 (Vercel Cron) ---------------
const CRAWL_INDEX_URL = "https://www.courtauction.go.kr/pgj/index.on";
const CRAWL_SEARCH_URL =
  "https://www.courtauction.go.kr/pgj/pgjsearch/searchControllerMain.on";

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

// 한 번 호출에 BATCH_SIZE개 지역을 크롤링, 라운드로빈으로 순환.
// Hobby 플랜 10초 타임아웃: 세션 ~2초 + 지역당 ~1초 = 5~6개 가능.
const CRAWL_BATCH_SIZE = 5;

app.get("/api/crawl-auction", async (req, res) => {
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

    // 한 바퀴 돌았으면 auction:all 갱신
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

app.get("/api/config", (_, res) => res.json({ hasApiKey: !!API_KEY }));

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`\n  부동산 엑셀 서버: http://localhost:${PORT}\n`);
    if (!API_KEY) {
      console.log("  DATA_API_KEY 미설정 - 실거래가 데이터 비활성");
      console.log("  설정 방법:");
      console.log("    1. https://www.data.go.kr 회원가입 (무료)");
      console.log('    2. "국토교통부_아파트매매 실거래 상세 자료" 활용 신청');
      console.log("    3. DATA_API_KEY=발급키 node server.js 로 실행\n");
    }
  });
}

module.exports = app;
