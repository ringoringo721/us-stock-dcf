/**
 * Factor catalogue for HK race scoring.
 * Each weight is relative importance in the linear ability score.
 * Features fed into the model should already be scaled ≈ [-1, +1].
 */
export const FACTOR_GROUPS = [
  {
    id: "ability",
    label: "Ability & class",
    labelZh: "實力／班次",
    factors: [
      {
        key: "ratingAdv",
        label: "Rating advantage",
        labelZh: "評分優勢",
        weight: 1.35,
        hint: "Official HKJC rating vs field average",
      },
      {
        key: "distanceFit",
        label: "Distance suitability",
        labelZh: "路程適性",
        weight: 0.85,
        hint: "Win/place record at this distance band",
      },
      {
        key: "courseFit",
        label: "Course suitability",
        labelZh: "場地適性",
        weight: 0.75,
        hint: "Sha Tin / Happy Valley / AWT split form",
      },
      {
        key: "weightLoad",
        label: "Weight load",
        labelZh: "負磅",
        weight: 0.55,
        hint: "Carried weight relative to rivals & rating",
      },
    ],
  },
  {
    id: "form",
    label: "Form / 狀態",
    labelZh: "狀態",
    factors: [
      {
        key: "form",
        label: "Recent form",
        labelZh: "近績",
        weight: 1.2,
        hint: "Last 3–5 starts: position & beaten lengths",
      },
      {
        key: "freshness",
        label: "Freshness",
        labelZh: "休養日數",
        weight: 0.45,
        hint: "Days since last race (peak ~14–35 days)",
      },
      {
        key: "gearTrial",
        label: "Gear / trial",
        labelZh: "配備／試閘",
        weight: 0.35,
        hint: "Equipment change or barrier trial signal",
      },
    ],
  },
  {
    id: "connections",
    label: "Jockey & trainer",
    labelZh: "騎師／練馬師",
    factors: [
      {
        key: "jockeySkill",
        label: "Jockey ability",
        labelZh: "騎師能力",
        weight: 1.0,
        hint: "Season win strike rate (normalized)",
      },
      {
        key: "jockeyCourse",
        label: "Jockey @ course",
        labelZh: "騎師場地",
        weight: 0.5,
        hint: "Strike rate at this venue",
      },
      {
        key: "jockeyHorse",
        label: "Jockey–horse combo",
        labelZh: "人馬組合",
        weight: 0.4,
        hint: "Prior starts together",
      },
      {
        key: "trainerSkill",
        label: "Trainer form",
        labelZh: "練馬師狀態",
        weight: 0.7,
        hint: "Yard season / recent strike rate",
      },
    ],
  },
  {
    id: "setup",
    label: "Race setup",
    labelZh: "賽事形勢",
    factors: [
      {
        key: "drawBias",
        label: "Draw bias",
        labelZh: "檔位",
        weight: 0.9,
        hint: "Barrier vs historical bias for venue×distance",
      },
      {
        key: "paceFit",
        label: "Pace / running style",
        labelZh: "步速適性",
        weight: 0.6,
        hint: "Leader / box-seat / closer vs projected pace",
      },
      {
        key: "goingFit",
        label: "Going fit",
        labelZh: "跑道狀況",
        weight: 0.4,
        hint: "Preference for today's going",
      },
    ],
  },
];

/** Flat list of all factors in catalogue order. */
export const ALL_FACTORS = FACTOR_GROUPS.flatMap((g) => g.factors);

/** Default weight map: factor key → weight. */
export function defaultWeights() {
  const w = {};
  for (const f of ALL_FACTORS) w[f.key] = f.weight;
  return w;
}

/** Human-readable factor meta by key. */
export function factorMeta(key) {
  return ALL_FACTORS.find((f) => f.key === key) || null;
}
