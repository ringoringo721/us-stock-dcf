# HK Smart Money seeds

Committed snapshots for Preview / cold-start without hammering HKEX / SFC.
Seeds are **not** an allowlist: unseeded `.HK` tickers live-scrape on `/api/hk-smart-money?action=stock` under the tight live rate budget (or via client `refresh=1`). Live stock rebuilds fetch a planned southbound date set (dense recent sessions + long-horizon snaps + weekly chart samples) and reuse `market-flow.json` history for market-level `net_cum_*` windows.

| File | Role |
|------|------|
| `{code}.HK.json` | Per-stock payload: southbound %, DI events, SFC short, market-flow copy |
| `market-flow.json` | Dense CSM southbound history + latest SSE/SZSE boxes (shared by every stock) |

Refresh with:

```bash
node scripts/capture_hk_smart_money.cjs
```

Sources (official): DI daily summaries, HKEXnews mutual-market southbound, HKEX CSM daily stats, SFC aggregated short CSV. Do **not** scrape public CCASS search for commercial use.
