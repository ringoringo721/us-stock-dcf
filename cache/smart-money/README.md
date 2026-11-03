# Smart Money cache

Committed **demo seeds** (Preview works without `FMP_API_KEY`):

| Path | Purpose |
|------|---------|
| `NVDA.json` `AAPL.json` `MSFT.json` `META.json` `GOOGL.json` `AMZN.json` `TSLA.json` `TSM.json` `STZ.json` | Stock holders (`#TICKER/smart-money`) — ≤45 holders × 2Q |
| `funds/[slug].json` | All curated-20 manager books (8Q; Berkshire 12Q) |
| `funds/index.json` | `#funds` directory summaries |
| `README.md` | This file |

Other US tickers use live `/api/fmp` `institutional-holders` when FMP is configured (walks up to 6 recent quarters). Curated fund pages prefer seed, then allowlisted `institutional-extract`.

Everything else under this tree (full captures, CIK duplicates, non-seed stocks) is **gitignored**.

```bash
# Stock-only capture (does not wipe fund books)
FMP_API_KEY=… node scripts/capture_smart_money.cjs --stocks-only NVDA,AAPL,MSFT,META,GOOGL,AMZN,TSLA,TSM,STZ 2 2

# Full fund capture
FMP_API_KEY=… node scripts/capture_smart_money.cjs --funds-only 12

# Rewrite slim seeds for git
node scripts/seed_smart_money.cjs --from-cache
```
