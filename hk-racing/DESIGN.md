# HK Racing Win Probability — Design

## Goal

For each upcoming HKJC race, estimate **P(horse i wins | field, conditions)** from
historical horse, jockey (騎師), trainer, and race-setup data, and show which
factors drove the estimate.

## Factors that move HK race results

Grouped by how often they matter in Sha Tin / Happy Valley racing.

### A. Horse ability & class (largest long-run signal)

| Factor | Why it matters in HK |
|--------|----------------------|
| Official rating | HK is a tightly handicapped system; rating ≈ class |
| Career / recent speed or sectional figures | True ability beyond finishing position |
| Class move (up/down) | Droppers often improve; risers face harder rivals |
| Distance suitability | Many horses are 1200m specialists or stay 1800m+ |
| Course suitability | Sha Tin turf ≠ Happy Valley ≠ AWT (all-weather) |
| Weight vs rating | Carrying more kg relative to rivals hurts |

### B. 狀態 (current form / condition)

| Factor | Why it matters |
|--------|----------------|
| Last 3–5 finishes + beaten lengths | Recent competitive level |
| Days since last start | Too fresh / too stale both hurt; ~14–35d often ideal |
| Gear change | Blinkers, tongue-tie, etc. can unlock or dull |
| Trial / barrier trial | Fitness signal when returning from spell |
| Vet / steward notes | Lame, bled, unsatisfactory — hard negatives |

### C. 騎師 (jockey) ability

| Factor | Why it matters |
|--------|----------------|
| Season win strike rate | Top jockeys get better rides *and* extract more |
| Course-specific strike | Some riders dominate HV rails or ST straight |
| Horse–jockey combo | Continuity / understanding |
| Apprentice claim | Weight allowance vs inexperience trade-off |
| Recent 14-day form | Hot / cold streaks are real but noisy |

### D. Trainer

| Factor | Why it matters |
|--------|----------------|
| Season strike rate | Preparation quality |
| First-up / second-up stats | Some yards peak first start |
| Target race pattern | Classic “set for this race” campaigns |

### E. Draw, pace & race shape (especially Happy Valley)

| Factor | Why it matters |
|--------|----------------|
| Barrier / draw | HV short races: inside draws huge; ST 1000m straight different |
| Likely pace map | Leaders vs sit-closers vs deep closers |
| Field size | More runners → lower win probs, more traffic |
| Rail position | HV rail out changes bias |

### F. Going & conditions

| Factor | Why it matters |
|--------|----------------|
| Going (Good / Yielding / Soft / Wet Fast) | Some horses prefer give |
| Weather / rain | Softens turf, changes bias |
| Night racing (HV) | Different visibility / tempo patterns |

### G. Market (optional blend)

Win odds embed collective information. A good production model often uses:

`final = (1 − λ) · model + λ · market_implied`

with λ tuned on historical log-loss. The prototype exposes edge vs odds without
forcing a blend so you can see model opinion alone.

## Probability math

For horse \(i\) in a race with feature vector \(x_i\):

\[
s_i = w^\top x_i + b
\]

\[
P_i = \frac{e^{s_i / \tau}}{\sum_j e^{s_j / \tau}}
\]

- \(s_i\): ability score (logit)
- \(\tau\): temperature (higher → flatter probabilities; default `1.8`)
- Softmax guarantees \(\sum_i P_i = 1\)

**Place / quinella** (later): simulate finishing orders from multinomial logits
(Harville / Henery) rather than ad-hoc “place ≈ 3 × win”.

**Calibration**: after you have real results, fit weights with logistic /
gradient boosting on historical runners, then recalibrate with temperature
scaling so predicted 25% horses win ~25% of the time.

## Feature scaling in the prototype

Each factor is mapped to roughly \([-1, +1]\) before weighting so weights are
comparable. Example: rating advantage of +10 points → strong positive; draw 12
at HV 1200m → strong negative.

## Data schema (`RaceCard`)

```json
{
  "id": "2026-11-16-ST-R5",
  "date": "2026-11-16",
  "venue": "ST",
  "venueName": "Sha Tin",
  "raceNo": 5,
  "name": "Class 3 — 1400m Turf",
  "distance": 1400,
  "surface": "turf",
  "going": "Good",
  "rail": "A",
  "runners": [
    {
      "no": 1,
      "horse": "Example Star",
      "horseZh": "例證之星",
      "draw": 3,
      "weight": 126,
      "jockey": "Z Purton",
      "jockeyZh": "潘頓",
      "trainer": "J Size",
      "rating": 72,
      "winOdds": 4.5,
      "features": {
        "ratingAdv": 0.4,
        "form": 0.55,
        "freshness": 0.2,
        "distanceFit": 0.7,
        "courseFit": 0.5,
        "drawBias": 0.3,
        "weightLoad": -0.1,
        "goingFit": 0.2,
        "paceFit": 0.1,
        "jockeySkill": 0.85,
        "jockeyCourse": 0.6,
        "jockeyHorse": 0.4,
        "trainerSkill": 0.7,
        "gearTrial": 0.0
      }
    }
  ]
}
```

Populate `features` from your historical warehouse (last-N starts, venue splits,
sectional final-200m ranks, draw bias tables by venue×distance, etc.).

## Suggested build order

1. **Ingest** — race results + racecards into a local DB (horse, jockey, trainer ids).
2. **Feature store** — nightly job computing the factor vector per runner.
3. **Model** — start with weighted logistic / LightGBM; keep a transparent linear
   baseline for explanation (what this app shows).
4. **UI** — race card → ranked win % → factor breakdown → edge vs tote.
5. **Bankroll rules** — optional Kelly-fraction display; never auto-bet.

## Legal / responsible use

HKJC wagering is legal for eligible customers under HKJC rules. This project is
for analysis only. Do not scrape sites that forbid it; prefer licensed data APIs.
Never present probabilities as certainties.
