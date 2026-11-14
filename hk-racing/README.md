# HK Racing — Win Probability Analyzer

Analyse Hong Kong Jockey Club (HKJC) race cards with historical horse, jockey, and
trainer form. Each runner gets a transparent factor score that is converted into a
**race-normalized win probability** (all horses in a race sum to 100%).

This is an analysis tool for personal research. It does not place bets, scrape the
HKJC site, or guarantee outcomes. Racing is uncertain; use at your own risk.

## Quick start

Open `index.html` in a browser, or from this folder:

```bash
python3 -m http.server 8765 --bind 127.0.0.1
```

Then visit `http://127.0.0.1:8765`.

Run model unit tests:

```bash
node --test tests/model.test.js
```

## What the model does

1. Scores every runner on weighted factors (ability, 狀態/form, 騎師, trainer,
   draw/course, distance, weight, going, pace fit).
2. Converts scores to win probabilities with a softmax so the field always sums
   to 100%.
3. Compares model probability to market-implied probability from win odds to
   surface a simple **edge** (positive = model likes the horse more than the tote).

## Data you will need for production

Official / commercial HK feeds (examples):

| Source | Use |
|--------|-----|
| HKJC race results & racecards | Official results, ratings, draws, going |
| Renavon / Racing Pass Pro | Sectionals, beaten lengths, steward comments |
| HRDB HK API | Horse/jockey/trainer profiles, venue-split stats |

The prototype ships with **synthetic but realistic** Sha Tin / Happy Valley cards
so the UI and math work without an API key. Replace `js/data.js` with a loader
that maps your feed into the `RaceCard` schema documented in `DESIGN.md`.

## Folder layout

```
hk-racing/
  DESIGN.md          # factors, math, data schema
  index.html
  css/app.css
  js/factors.js      # factor catalogue + default weights
  js/model.js        # scoring + softmax + edge
  js/data.js         # sample cards
  js/app.js          # UI
  tests/model.test.js
```
