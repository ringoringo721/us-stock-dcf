# HK Smart Money seeds

Committed snapshots for Preview / cold-start without hammering HKEX / SFC.
Seeds are **not** an allowlist: the UI loads unseeded `.HK` tickers via `/api/hk-smart-money?action=stock&refresh=1` (full multi-horizon live rebuild under a tight per-IP live budget + per-isolate in-flight cap). Bare `action=stock` without `refresh` stays a cheap empty (`HK_SMART_MONEY_NO_SEED`) to avoid amplification. Live rebuilds plan southbound dates for Δ windows and reuse `market-flow.json` history for market-level `net_cum_*` (merging a newer CSM session into that history when present).

| File | Role |
|------|------|
| `{code}.HK.json` | Per-stock payload: southbound %, DI events, SFC short, market-flow copy |
| `market-flow.json` | Dense CSM southbound history + latest SSE/SZSE boxes (shared by every stock). Public DailyStat currently starts ~2026-04-15 (~209d span), so `net_cum_270d` / `net_cum_360d` stay honest null until retention grows; UI shows retention reason + `net_cum_available` (full span). |

Refresh with:

```bash
node scripts/capture_hk_smart_money.cjs
```

Sources (official): DI daily summaries, HKEXnews mutual-market southbound, HKEX CSM daily stats, SFC aggregated short CSV. Do **not** scrape public CCASS search for commercial use.
