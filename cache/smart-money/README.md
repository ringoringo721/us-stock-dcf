# Smart Money cache

Committed **demo seeds** (Preview works without `FMP_API_KEY`):

| Path | Purpose |
|------|---------|
| `curated-by-ticker.json` | Curated-20 fund books inverted → US tickers they hold (`#TICKER/smart-money` fallback) |
| `NVDA.json` … `STZ.json` | Richer broad-holder demos (≤45 holders × 2Q; CIKs **unioned** across quarters; no false −100% exits) |
| `funds/holder-funds.json` | Stock-seed invert → partial `#fund/{CIK}` books so **every** holder row is clickable |
| `funds/[slug].json` | Curated-20 manager books (8Q; Berkshire 12Q) |
| `funds/index.json` | `#funds` directory summaries |
| `README.md` | This file |

**Preview without FMP — stock page:** seed → live → curated invert → honest empty (`無策展／無機構申報`). Never leave common names on dim `FMP_NOT_CONFIGURED` alone.

**Preview without FMP — fund page:** dedicated slug seed → live extract (allowlisted) → **holder-funds invert** (partial) → honest empty. Extract allowlist = curated-20 ∪ CIKs in `holder-funds.json` (no open arbitrary CIK scrape).

Everything else under this tree (full captures, CIK duplicates, non-seed stocks) is **gitignored**.

```bash
FMP_API_KEY=… node scripts/capture_smart_money.cjs --stocks-only NVDA,AAPL,MSFT,META,GOOGL,AMZN,TSLA,TSM,STZ 2 2
FMP_API_KEY=… node scripts/capture_smart_money.cjs --funds-only 12
node scripts/seed_smart_money.cjs --from-cache
```
