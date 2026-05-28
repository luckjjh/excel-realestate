const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.DATA_API_KEY || "";

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Routes
app.use(require("./routes/news"));
app.use(require("./routes/trades"));
app.use(require("./routes/subscription"));
app.use(require("./routes/chat"));
app.use(require("./routes/auction"));
app.use(require("./routes/listings"));

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
