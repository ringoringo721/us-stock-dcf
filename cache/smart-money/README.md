# Smart Money cache

Committed **demo seeds only** (keep PR / Bugbot small):

| Path | Purpose |
|------|---------|
| `TSM.json` | Stock holders sample for `#TSM/smart-money` |
| `funds/berkshire-hathaway.json` | Fund book for `#fund/berkshire-hathaway` |
| `funds/index.json` | `#funds` directory summaries (curated 20) |

Everything else under this tree is **generated locally** and gitignored.

```bash
# Full capture (do not commit megabyte outputs)
FMP_API_KEY=… node scripts/capture_smart_money.cjs TSM,AAPL 3 5

# Rewrite slim seeds for git
FMP_API_KEY=… node scripts/seed_smart_money.cjs
# or from an existing local capture:
node scripts/seed_smart_money.cjs --from-cache
```

UI prefers seed/cache, then live rate-limited `/api/fmp` (`institutional-holders` / `institutional-extract`).
