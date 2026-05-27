# excel-realestate

> **https://excel-realestate.vercel.app**

엑셀 형식으로 부동산 관련 정책, 시세, 매물, 경매 정보를 확인할 수 있는 웹 대시보드.

[excelkospi](https://excelkospi.pages.dev/)에서 영감을 받아 제작.

## 배포

Vercel에 배포되어 있으며 `main` 브랜치 push 시 자동 배포.

### 환경변수 (Vercel)

| 변수 | 용도 |
|---|---|
| `DATA_API_KEY` | 공공데이터포털 API 키 (실거래가, 청약) |
| `KV_REST_API_URL` | Upstash Redis REST URL (캐시) |
| `KV_REST_API_TOKEN` | Upstash Redis REST Token |

### GitHub Actions

| Workflow | 설명 | 스케줄 |
|---|---|---|
| `crawl-auction.yml` | 법원경매 전국 매물 크롤링 → KV 저장 | 매일 06:00, 18:00 KST |

Actions Secrets에 `KV_REST_API_URL`, `KV_REST_API_TOKEN` 등록 필요.

## 로컬 실행

```bash
# 뉴스 + 청약만 (API 키 없이)
npm start

# 실거래가 + KV 캐시 포함
DATA_API_KEY=your_key KV_REST_API_URL=... KV_REST_API_TOKEN=... npm start
```

## 데이터 소스

| 탭 | 소스 | API 키 |
|---|---|---|
| 주요지표 | 국토교통부 실거래가 API | 필요 (data.go.kr 무료) |
| 정책뉴스 | Naver/Google News 크롤링 | 불필요 |
| 실거래내역 | 국토교통부 실거래가 API | 필요 |
| 경매정보 | 법원경매정보 (courtauction.go.kr) | 불필요 (GitHub Actions 크롤링) |
| 청약정보 | 한국부동산원 청약홈 API | 동일 키 사용 |

## API 키 발급

1. [data.go.kr](https://www.data.go.kr) 회원가입
2. "국토교통부_아파트 매매 실거래가 상세 자료" 활용 신청
3. "한국부동산원_청약홈 분양정보 조회 서비스" 활용 신청
4. 발급된 키를 `DATA_API_KEY` 환경변수로 설정

## 기능

- 엑셀 UI (excelkospi 스타일 리본/탭/수식바)
- 실시간 부동산 뉴스 (정책/시세/경매/공급 카테고리)
- 아파트 실거래가 조회 + 면적/가격/정렬 필터
- 아파트 클릭 시 12개월 가격 추이 차트
- 법원경매 전국 17개 시도 매물 검색 (GitHub Actions cron 크롤링)
- 청약 일정 (민영/공공/줍줍 필터, 경쟁률)
- Upstash Redis 캐시 (L1 메모리 + L2 KV)
