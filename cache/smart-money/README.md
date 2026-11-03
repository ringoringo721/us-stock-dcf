# Smart Money cache

Committed **demo seeds** (Preview works without `FMP_API_KEY` for liquid names):

| Path | Purpose |
|------|---------|
| `{TICKER}.json` | Liquid/mega US holder tables (~65 holders × **4Q**, CIKs unioned; no false −100% exits) |
| `curated-by-ticker.json` | Curated-20 invert fallback for other US tickers when live FMP is down |
| `funds/fund-{cik}.json` | **Full** 13F books (**8Q**, ≤100 positions) for non-curated managers linked from stock tables |
| `funds/{slug}.json` | Curated-20 manager books (8Q; Berkshire 12Q) |
| `funds/holder-funds.json` | Extract **allowlist** (CIKs) + **names** map — titles never bare CIK |
| `funds/index.json` | `#funds` directory (curated 20 + committed fund-{cik} books) |
| `README.md` | This file |

**Stock page load order:** per-ticker seed → live FMP (≤8Q) → curated invert → bright empty.  
**Fund page load order:** slug / `fund-{cik}` seed → live allowlisted extract (≤8Q) → bright empty (no 1-stock stub books).  
**Titles:** resolve from curated / seed / `holder-funds.names` / FMP; CIK is secondary only.

Extract allowlist = curated-20 ∪ seed-holder CIKs ∪ `fund-*` books. Arbitrary CIKs stay 403.

```bash
FMP_API_KEY=… node scripts/capture_smart_money.cjs --stocks-only JPM,V,MA,… 6 2
FMP_API_KEY=… node scripts/capture_holder_fund_books.cjs 40 8
node scripts/seed_smart_money.cjs --from-cache
```

For **all** screener US names beyond liquid seeds, set `FMP_API_KEY` on Vercel so live institutional-holders / extract fill full books.
