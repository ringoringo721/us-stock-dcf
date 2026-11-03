# Smart Money cache

Committed **demo seeds** (Preview works without `FMP_API_KEY` for liquid names). Keep this tree small for Bugbot/PR diffs — never commit multi‑MB full 13F dumps.

| Path | Purpose |
|------|---------|
| `{TICKER}.json` | Liquid/mega US holders (~40 × **2Q**, CIKs unioned; no false −100% exits) |
| `curated-by-ticker.json` | Curated-20 invert fallback when live FMP is down |
| `funds/fund-{cik}.json` | Shortlist of non-curated books (**8Q** × ≤22 positions) + names |
| `funds/{slug}.json` | Curated-20 manager books (8Q; Berkshire 12Q; ≤22/Q) |
| `funds/holder-funds.json` | Extract **allowlist** + **names** (titles never bare CIK) |
| `funds/index.json` | `#funds` (curated + committed fund-{cik}) |
| `README.md` | This file |

**Stock load:** seed → live FMP (≤8Q) → curated invert → empty.  
**Fund load:** slug / `fund-{cik}` seed → live allowlisted extract (≤8Q) → empty.  
**Titles:** curated / seed / `holder-funds.names` / FMP; CIK secondary only.

```bash
FMP_API_KEY=… node scripts/capture_smart_money.cjs --stocks-only JPM,V,MA,… 6 2
FMP_API_KEY=… node scripts/capture_holder_fund_books.cjs 45 8
node scripts/seed_smart_money.cjs --from-cache
```

Seed caps (see `seed_smart_money.cjs`): stock 40×2Q; extra funds ≤28 books × 8Q × 22 holdings.
