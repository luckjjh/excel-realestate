const axios = require("axios");
const cheerio = require("cheerio");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

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
    const elHtml = $.html(el);
    const linkMatch = elHtml.match(/<link>(.*?)<\/link>/);
    const link = linkMatch ? linkMatch[1].trim() : "";
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

async function scrapeDaumNews(query) {
  const url = `https://search.daum.net/search?w=news&q=${encodeURIComponent(query)}&sort=recency`;
  const { data } = await axios.get(url, {
    headers: { "User-Agent": UA, "Accept-Language": "ko-KR,ko;q=0.9" },
    timeout: 10000,
  });
  const $ = cheerio.load(data);
  const items = [];
  $(".cont_thumb .wrap_tit, .news_cont .tit_item, .cont_item .tit_item").each((_, el) => {
    const $a = $(el).find("a").first();
    if (!$a.length) return;
    const title = $a.text().trim();
    if (!title) return;
    const link = $a.attr("href") || "";
    items.push({ title, link, summary: "", source: "다음", time: "" });
  });
  if (!items.length) {
    $("a.f_link_b, a.tit_main").each((_, el) => {
      const title = $(el).text().trim();
      const link = $(el).attr("href") || "";
      if (title) items.push({ title, link, summary: "", source: "다음", time: "" });
    });
  }
  if (items.length === 0) throw new Error("empty");
  return items.slice(0, 10);
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
  const results = [];
  const all = await Promise.all([
    scrapeNaverNews(query).catch(() => []),
    fetchGoogleRSS(query).catch(() => []),
    scrapeDaumNews(query).catch(() => []),
  ]);
  for (const items of all) {
    if (Array.isArray(items)) results.push(...items);
  }
  if (results.length === 0) throw new Error("no news");
  return results;
}

module.exports = { fetchNews, UA };
