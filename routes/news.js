const { Router } = require("express");
const { cached } = require("../lib/cache");
const { fetchNews } = require("../lib/scraper");

const router = Router();

router.get("/api/news", async (req, res) => {
  try {
    const data = await cached("news", 5 * 60 * 1000, async () => {
      const cats = [
        ["policy", "부동산 정책 규제"],
        ["policy", "부동산 대출 금리"],
        ["market", "아파트 매매 시세"],
        ["market", "부동산 전세 시세 동향"],
        ["auction", "부동산 경매 낙찰"],
        ["supply", "청약 분양 입주"],
        ["supply", "재건축 재개발 정비사업"],
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

module.exports = router;
