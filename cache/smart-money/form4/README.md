# Form 4 / Section 16 seeds

Committed **demo seeds** so `#TICKER/smart-money` Preview shows timely Form 4 moves **without** a live Vercel `FMP_API_KEY`.

| Path | Purpose |
|------|---------|
| `{TICKER}.json` | Slim trades (≤40) from FMP `insider-trading/search` |
| `README.md` | This file |

**Load order** (`SmartMoney.loadForm4`): seed → live `/api/fmp?action=insider-trading` → Profile `insider_trades` meta → empty.

Form 4 ≠ full 13F book. Curated-20 badges use `reportingCik` (e.g. Berkshire on SIRI).

```bash
FMP_API_KEY=… node scripts/seed_form4.cjs SIRI,AAPL
```
