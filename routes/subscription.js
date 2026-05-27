const { Router } = require("express");
const axios = require("axios");
const { cached } = require("../lib/cache");

const router = Router();
const API_KEY = process.env.DATA_API_KEY || "";
const ODCLOUD = "https://api.odcloud.kr/api";

router.get("/api/subscriptions", async (req, res) => {
  if (!API_KEY) return res.json({ ok: false, error: "NO_KEY" });
  try {
    const data = await cached("subs2", 30 * 60 * 1000, async () => {
      const now = new Date();
      const from = new Date(now.getFullYear(), now.getMonth() - 2, 1);
      const fromStr = `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, "0")}-01`;

      const [aptRes, remndrRes, mdlRes] = await Promise.all([
        axios.get(`${ODCLOUD}/ApplyhomeInfoDetailSvc/v1/getAPTLttotPblancDetail`, {
          params: { serviceKey: API_KEY, page: 1, perPage: 100, "cond[RCRIT_PBLANC_DE::GTE]": fromStr },
          timeout: 15000,
        }),
        axios.get(`${ODCLOUD}/ApplyhomeInfoDetailSvc/v1/getRemndrLttotPblancDetail`, {
          params: { serviceKey: API_KEY, page: 1, perPage: 50, "cond[RCRIT_PBLANC_DE::GTE]": fromStr },
          timeout: 15000,
        }),
        axios.get(`${ODCLOUD}/ApplyhomeInfoDetailSvc/v1/getAPTLttotPblancMdl`, {
          params: { serviceKey: API_KEY, page: 1, perPage: 500 },
          timeout: 15000,
        }),
      ]);

      const mapItem = (i, supplyType) => ({
        name: i.HOUSE_NM, addr: i.HSSPLY_ADRES,
        region: i.SUBSCRPT_AREA_CODE_NM, units: i.TOT_SUPLY_HSHLDCO,
        startDate: i.RCEPT_BGNDE || i.GNRL_RCEPT_BGNDE || i.SUBSCRPT_RCEPT_BGNDE,
        endDate: i.RCEPT_ENDDE || i.GNRL_RCEPT_ENDDE || i.SUBSCRPT_RCEPT_ENDDE,
        spsplyStart: i.SPSPLY_RCEPT_BGNDE, spsplyEnd: i.SPSPLY_RCEPT_ENDDE,
        rank1Start: i.GNRL_RNK1_CRSPAREA_RCPTDE, rank1End: i.GNRL_RNK1_CRSPAREA_ENDDE,
        rank2Start: i.GNRL_RNK2_CRSPAREA_RCPTDE, rank2End: i.GNRL_RNK2_CRSPAREA_ENDDE,
        announceDate: i.RCRIT_PBLANC_DE, winnerDate: i.PRZWNER_PRESNATN_DE,
        moveIn: i.MVN_PREARNGE_YM, houseType: i.HOUSE_DTL_SECD_NM || "",
        rentType: i.RENT_SECD_NM || "", url: i.PBLANC_URL,
        manageNo: i.HOUSE_MANAGE_NO, pblancNo: i.PBLANC_NO,
        supplyType, homepage: i.HMPG_ADRES || "",
      });

      const aptItems = (aptRes.data.data || []).map((i) =>
        mapItem(i, (i.HOUSE_DTL_SECD_NM || "").includes("민영") ? "민영" : "공공"),
      );
      const remndrItems = (remndrRes.data.data || []).map((i) => mapItem(i, "줍줍"));
      const all = [...aptItems, ...remndrItems];

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

    let compMap = {};
    try {
      const comp = await cached("comp2", 60 * 60 * 1000, async () => {
        const { data: d } = await axios.get(
          `${ODCLOUD}/ApplyhomeInfoCmpetRtSvc/v1/getAPTLttotPblancCmpet`,
          { params: { serviceKey: API_KEY, page: 1, perPage: 500 }, timeout: 15000 },
        );
        return d.data || [];
      });
      for (const c of comp) {
        const key = c.HOUSE_MANAGE_NO;
        if (!compMap[key]) compMap[key] = [];
        compMap[key].push({
          rank: c.SUBSCRPT_RANK_CODE, region: c.RESIDE_SENM,
          rate: c.CMPET_RATE, supply: c.SUPLY_HSHLDCO,
          req: c.REQ_CNT, houseType: c.HOUSE_TY,
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
        if (r2 && r2.rate) compSummary += compSummary ? ` / 2순위 ${r2.rate}` : `2순위 ${r2.rate}`;
      }
      return { ...d, compSummary };
    });

    res.json({ ok: true, data: enriched });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

router.get("/api/competition", async (req, res) => {
  if (!API_KEY) return res.json({ ok: false, error: "NO_KEY" });
  try {
    const data = await cached("comp", 60 * 60 * 1000, async () => {
      const { data: d } = await axios.get(
        `${ODCLOUD}/ApplyhomeInfoCmpetRtSvc/v1/getAPTLttotPblancCmpet`,
        { params: { serviceKey: API_KEY, page: 1, perPage: 100 }, timeout: 15000 },
      );
      return (d.data || []).map((i) => ({
        manageNo: i.HOUSE_MANAGE_NO, houseType: i.HOUSE_TY,
        rate: i.CMPET_RATE, supply: i.SUPLY_HSHLDCO,
        reqCnt: i.REQ_CNT, rank: i.SUBSCRPT_RANK_CODE, region: i.RESIDE_SENM,
      }));
    });
    res.json({ ok: true, data });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

router.get("/api/subscription-detail", async (req, res) => {
  const { manageNo } = req.query;
  if (!manageNo || !API_KEY) return res.json({ ok: false, error: "missing params" });
  try {
    const data = await cached(`subdet_${manageNo}`, 60 * 60 * 1000, async () => {
      const [infoRes, mdlRes, compRes] = await Promise.all([
        axios.get(`${ODCLOUD}/ApplyhomeInfoDetailSvc/v1/getAPTLttotPblancDetail`, {
          params: { serviceKey: API_KEY, page: 1, perPage: 500 }, timeout: 15000,
        }),
        axios.get(`${ODCLOUD}/ApplyhomeInfoDetailSvc/v1/getAPTLttotPblancMdl`, {
          params: { serviceKey: API_KEY, page: 1, perPage: 500 }, timeout: 15000,
        }),
        axios.get(`${ODCLOUD}/ApplyhomeInfoCmpetRtSvc/v1/getAPTLttotPblancCmpet`, {
          params: { serviceKey: API_KEY, page: 1, perPage: 500 }, timeout: 15000,
        }),
      ]);
      const info = (infoRes.data.data || []).find((i) => String(i.HOUSE_MANAGE_NO) === String(manageNo));
      const models = (mdlRes.data.data || []).filter((m) => String(m.HOUSE_MANAGE_NO) === String(manageNo));
      const comps = (compRes.data.data || []).filter((c) => String(c.HOUSE_MANAGE_NO) === String(manageNo));
      return {
        info: info ? {
          name: info.HOUSE_NM, addr: info.HSSPLY_ADRES,
          builder: info.BSNS_MBY_NM, constructor: info.CNSTRCT_ENTRPS_NM,
          totalUnits: info.TOT_SUPLY_HSHLDCO, type: info.HOUSE_DTL_SECD_NM,
          rentType: info.RENT_SECD_NM, region: info.SUBSCRPT_AREA_CODE_NM,
          announceDate: info.RCRIT_PBLANC_DE, spsplyStart: info.SPSPLY_RCEPT_BGNDE,
          spsplyEnd: info.SPSPLY_RCEPT_ENDDE,
          rank1Start: info.GNRL_RNK1_CRSPAREA_RCPTDE, rank1End: info.GNRL_RNK1_CRSPAREA_ENDDE,
          rank2Start: info.GNRL_RNK2_CRSPAREA_RCPTDE, rank2End: info.GNRL_RNK2_CRSPAREA_ENDDE,
          winnerDate: info.PRZWNER_PRESNATN_DE,
          contractStart: info.CNTRCT_CNCLS_BGNDE, contractEnd: info.CNTRCT_CNCLS_ENDDE,
          moveIn: info.MVN_PREARNGE_YM, homepage: info.HMPG_ADRES, url: info.PBLANC_URL,
        } : null,
        models: models.map((m) => ({
          houseType: m.HOUSE_TY, supplyArea: m.SUPLY_AR,
          topPrice: m.LTTOT_TOP_AMOUNT, supplyCount: m.SUPLY_HSHLDCO,
          spsplyCount: m.SPSPLY_HSHLDCO, generalCount: m.SUPLY_HSHLDCO,
          newlywed: m.NWWDS_HSHLDCO, firstLife: m.LFE_FRST_HSHLDCO,
          multiChild: m.MNYCH_HSHLDCO, oldParent: m.OLD_PARNTS_SUPORT_HSHLDCO,
          institution: m.INSTT_RECOMEND_HSHLDCO,
        })),
        competition: comps.map((c) => ({
          houseType: c.HOUSE_TY, rank: c.SUBSCRPT_RANK_CODE,
          region: c.RESIDE_SENM, rate: c.CMPET_RATE,
          supply: c.SUPLY_HSHLDCO, reqCount: c.REQ_CNT,
        })),
      };
    });
    res.json({ ok: true, data });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

module.exports = router;
