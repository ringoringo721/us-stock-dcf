# Smart Money cache

Committed **demo seeds** so Preview works for liquid names **without** a Vercel `FMP_API_KEY`. Keep this tree small for Bugbot/PR diffs — never commit multi‑MB full 13F dumps.

| Path | Purpose |
|------|---------|
| `{TICKER}.json` | Liquid/mega US holders (~40 × **2Q**, CIKs unioned; no false −100% exits) |
| `curated-by-ticker.json` | Curated-20 invert fallback when live FMP is down |
| `funds/fund-{cik}.json` | Shortlist of non-curated books (**8Q** × ≤22 positions) + names |
| `funds/{slug}.json` | Curated-20 manager books (8Q; Berkshire 12Q; ≤22/Q) |
| `funds/holder-funds.json` | Extract **allowlist** + **names** + **partial invert** (`funds`) |
| `funds/index.json` | `#funds` (curated + committed fund-{cik}) |
| `README.md` | This file |

**Routes:** `#fund/fund-{cik}` and `#fund/{cik}` resolve to the same identity (`fund-{cik}` slug).

**Stock load:** seed → live FMP (≤8Q) → curated invert → empty.  
**Fund load:** slug / `fund-{cik}` seed → live allowlisted extract (≤8Q) → **stock-seed invert** (partial) → empty.  
**Titles:** curated / seed / `holder-funds.names` / FMP; CIK secondary only.

## `FMP_API_KEY` on Vercel (not Cursor)

Live institutional extract (`/api/fmp?action=institutional-extract`) runs on **Vercel serverless**.

- Set `FMP_API_KEY` in the **Vercel project** → Settings → Environment Variables for **Production** and **Preview**.
- Cursor Cloud Agent / GitHub Actions secrets **do not** automatically reach Vercel Preview. A green agent env does not fix empty fund pages on `*.vercel.app`.
- After adding the key, redeploy the Preview (or push an empty commit) so serverless picks it up.

```bash
FMP_API_KEY=… node scripts/capture_smart_money.cjs --stocks-only JPM,V,MA,… 6 2
FMP_API_KEY=… node scripts/capture_holder_fund_books.cjs 45 8
node scripts/seed_smart_money.cjs --from-cache
```

Seed caps (see `seed_smart_money.cjs`): stock 40×2Q; extra funds ≤28 books × 8Q × 22 holdings (priority includes BAMCO / Hapoalim / Sumitomo).
