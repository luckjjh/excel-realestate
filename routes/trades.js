const { Router } = require("express");
const axios = require("axios");
const { cached } = require("../lib/cache");
const { AREAS } = require("../lib/areas");
const { UA } = require("../lib/scraper");

const router = Router();
const API_KEY = process.env.DATA_API_KEY || "";
const TRADE_API =
  "https://apis.data.go.kr/1613000/RTMSDataSvcAptTradeDev/getRTMSDataSvcAptTradeDev";

router.get("/api/areas", (_, res) => res.json(AREAS));

router.get("/api/trades", async (req, res) => {
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
        const { data: resp } = await axios.get(TRADE_API, {
          params: {
            serviceKey: API_KEY, LAWD_CD: area, DEAL_YMD: ym,
            numOfRows: PER, pageNo,
          },
          headers: { "User-Agent": UA },
          timeout: 15000,
        });
        const body = resp?.response?.body;
        const code = resp?.response?.header?.resultCode;
        if (code && code !== "000" && code !== "00")
          throw new Error(resp?.response?.header?.resultMsg || `API error: ${code}`);
        let raw = body?.items?.item || [];
        if (!Array.isArray(raw)) raw = [raw];
        all.push(...raw);
        const total = parseInt(body?.totalCount || 0);
        if (raw.length < PER || all.length >= total) break;
      }
      return all
        .map((i) => ({
          name: String(i.aptNm || ""), dong: String(i.umdNm || ""),
          area: String(i.excluUseAr || ""), floor: String(i.floor || ""),
          price: String(i.dealAmount || ""), year: String(i.dealYear || ""),
          month: String(i.dealMonth || ""), day: String(i.dealDay || ""),
          built: String(i.buildYear || ""), roadNm: String(i.roadNm || ""),
        }))
        .sort((a, b) => parseInt(b.day || 0) - parseInt(a.day || 0));
    });
    res.json({ ok: true, data, area, areaName: AREAS[area] || area, month: ym });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

router.get("/api/summary", async (req, res) => {
  if (!API_KEY) return res.json({ ok: false, error: "NO_KEY" });
  const now = new Date();
  const ym = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;
  const prev = now.getMonth() === 0
    ? `${now.getFullYear() - 1}12`
    : `${now.getFullYear()}${String(now.getMonth()).padStart(2, "0")}`;
  const keyAreas = [
    "11680", "11650", "11710", "11170", "11440",
    "11200", "11560", "11470", "11590", "11350",
  ];
  try {
    const data = await cached(`summary_${ym}`, 60 * 60 * 1000, async () => {
      const results = [];
      for (const area of keyAreas) {
        try {
          const { data: resp } = await axios.get(TRADE_API, {
            params: {
              serviceKey: API_KEY, LAWD_CD: area, DEAL_YMD: ym,
              numOfRows: 200, pageNo: 1,
            },
            headers: { "User-Agent": UA },
            timeout: 15000,
          });
          let raw = resp?.response?.body?.items?.item || [];
          if (!Array.isArray(raw)) raw = [raw];
          const items = [];
          for (const el of raw) {
            const price = parseInt(String(el.dealAmount || "").replace(/[, ]/g, "")) || 0;
            const a = parseFloat(el.excluUseAr) || 0;
            if (price > 0) items.push({ price, area: a });
          }
          const count = items.length;
          const avgPrice = count > 0 ? Math.round(items.reduce((s, i) => s + i.price, 0) / count) : 0;
          const items84 = items.filter((i) => i.area >= 80 && i.area <= 90);
          const avg84 = items84.length > 0
            ? Math.round(items84.reduce((s, i) => s + i.price, 0) / items84.length)
            : 0;
          results.push({ code: area, name: AREAS[area], count, avgPrice, avg84, month: ym });
        } catch {}
      }
      return results;
    });
    res.json({ ok: true, data, month: ym, prevMonth: prev });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

router.get("/api/price-history", async (req, res) => {
  if (!API_KEY) return res.json({ ok: false, error: "NO_KEY" });
  const { area, name } = req.query;
  if (!area || !name) return res.json({ ok: false, error: "missing params" });
  try {
    const data = await cached(
      `ph_${area}_${name}`, 60 * 60 * 1000,
      async () => {
        const now = new Date();
        const months = [];
        for (let i = 11; i >= 0; i--) {
          const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
          months.push(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`);
        }
        const results = [];
        for (const ym of months) {
          try {
            const { data: resp } = await axios.get(TRADE_API, {
              params: {
                serviceKey: API_KEY, LAWD_CD: area, DEAL_YMD: ym,
                numOfRows: 500, pageNo: 1,
              },
              headers: { "User-Agent": UA },
              timeout: 15000,
            });
            let raw = resp?.response?.body?.items?.item || [];
            if (!Array.isArray(raw)) raw = [raw];
            const matched = raw.filter(
              (i) => String(i.aptNm || "").trim() === name.trim(),
            );
            const prices = matched.map(
              (i) => parseInt(String(i.dealAmount || "").replace(/[, ]/g, "")) || 0,
            ).filter((p) => p > 0);
            if (prices.length > 0) {
              results.push({
                month: ym,
                avg: Math.round(prices.reduce((s, p) => s + p, 0) / prices.length),
                min: Math.min(...prices),
                max: Math.max(...prices),
                count: prices.length,
              });
            }
          } catch {}
        }
        return results;
      },
    );
    res.json({ ok: true, data, name, area });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

module.exports = router;
