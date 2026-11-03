# Smart Money cache

Committed **demo seeds** (keep PR / Bugbot reviewable):

| Path | Purpose |
|------|---------|
| `TSM.json`, `STZ.json` | Stock holders samples (`#TSM/smart-money`, `#STZ/smart-money`) |
| `funds/[slug].json` | All curated-20 manager books (8 filing quarters; Berkshire 12) |
| `funds/index.json` | `#funds` directory summaries |
| `README.md` | This file |

Arbitrary US tickers (no seed) use live rate-limited `/api/fmp` `institutional-holders` (walks up to 6 recent quarters). Curated fund pages prefer seed, then allowlisted `institutional-extract`.

Everything else under this tree (full captures, CIK-named duplicates, mega stock books) is **gitignored**.

```bash
# Full fund capture (do not commit megabyte outputs)
FMP_API_KEY=… node scripts/capture_smart_money.cjs --funds-only 12

# Stock-only capture (does not wipe fund books)
FMP_API_KEY=… node scripts/capture_smart_money.cjs --stocks-only STZ,TSM 2 2

# Rewrite slim seeds for git
node scripts/seed_smart_money.cjs --from-cache
```

Seed holdings are capped (~22 names/quarter) so QoQ + history stay useful without a multi‑MB PR.
