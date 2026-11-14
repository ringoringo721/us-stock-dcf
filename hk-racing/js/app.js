import { SAMPLE_RACES } from "./data.js";
import { FACTOR_GROUPS, factorMeta } from "./factors.js";
import { analyseRace, pct } from "./model.js";

const state = {
  raceId: SAMPLE_RACES[0].id,
  selectedNo: null,
  temperature: 1.8,
};

function $(sel) {
  return document.querySelector(sel);
}

function currentRace() {
  return SAMPLE_RACES.find((r) => r.id === state.raceId) || SAMPLE_RACES[0];
}

function analysis() {
  const race = currentRace();
  return analyseRace({ ...race, temperature: state.temperature });
}

function formatOdds(o) {
  if (!Number.isFinite(o) || o > 999) return "—";
  return o >= 10 ? o.toFixed(0) : o.toFixed(1);
}

function renderRaceSelect() {
  const sel = $("#race-select");
  sel.innerHTML = SAMPLE_RACES.map(
    (r) =>
      `<option value="${r.id}" ${r.id === state.raceId ? "selected" : ""}>${r.venueName} · R${r.raceNo} · ${r.distance}m</option>`
  ).join("");
}

function renderMeta(result) {
  const m = result.raceMeta;
  $("#race-title").textContent = m.name;
  $("#race-sub").textContent = `${m.venueName} · ${m.date} · Race ${m.raceNo} · ${m.going} · Rail ${m.rail}`;
}

function renderTable(result) {
  const tbody = $("#prob-body");
  tbody.innerHTML = result.rows
    .map((r, idx) => {
      const edgeClass =
        r.edge > 0.03 ? "edge-pos" : r.edge < -0.03 ? "edge-neg" : "";
      const selected = state.selectedNo === r.no ? "is-selected" : "";
      return `<tr class="${selected}" data-no="${r.no}">
        <td class="rank">${idx + 1}</td>
        <td class="num">${r.no}</td>
        <td class="horse">
          <span class="horse-en">${r.horse}</span>
          <span class="horse-zh">${r.horseZh || ""}</span>
        </td>
        <td>${r.draw}</td>
        <td class="jockey">${r.jockey}</td>
        <td>${r.rating}</td>
        <td class="prob">
          <div class="prob-bar-wrap">
            <div class="prob-bar" style="width:${Math.max(4, r.winProb * 100)}%"></div>
            <span>${pct(r.winProb)}</span>
          </div>
        </td>
        <td>${formatOdds(r.winOdds)}</td>
        <td>${formatOdds(r.fairOdds)}</td>
        <td class="${edgeClass}">${r.edge >= 0 ? "+" : ""}${(100 * r.edge).toFixed(1)}pp</td>
      </tr>`;
    })
    .join("");

  tbody.querySelectorAll("tr").forEach((tr) => {
    tr.addEventListener("click", () => {
      state.selectedNo = Number(tr.dataset.no);
      render();
    });
  });
}

function ensureSelected(result) {
  const exists = result.rows.some((r) => r.no === state.selectedNo);
  if (!exists) {
    state.selectedNo = result.rows[0]?.no ?? null;
  }
}

function renderBreakdown(result) {
  const panel = $("#factor-panel");
  const row = result.rows.find((r) => r.no === state.selectedNo);
  if (!row) {
    panel.innerHTML = "";
    return;
  }

  const byGroup = FACTOR_GROUPS.map((g) => {
    const items = g.factors.map((f) => {
      const c = row.contributions.find((x) => x.key === f.key);
      return { ...f, ...(c || { value: 0, contrib: 0 }) };
    });
    const groupScore = items.reduce((s, i) => s + i.contrib, 0);
    return { ...g, items, groupScore };
  });

  panel.innerHTML = `
    <div class="factor-head">
      <div>
        <p class="eyebrow">Factor breakdown</p>
        <h3>#${row.no} ${row.horse} <span>${row.horseZh || ""}</span></h3>
        <p class="muted">${row.jockey} / ${row.trainer} · last ${row.lastStarts || "—"} · ${pct(row.winProb)} win</p>
      </div>
      <div class="score-chip">Score ${row.score.toFixed(2)}</div>
    </div>
    <div class="factor-groups">
      ${byGroup
        .map(
          (g) => `
        <section class="factor-group">
          <header>
            <h4>${g.label} <span>${g.labelZh}</span></h4>
            <span class="${g.groupScore >= 0 ? "edge-pos" : "edge-neg"}">${g.groupScore >= 0 ? "+" : ""}${g.groupScore.toFixed(2)}</span>
          </header>
          <ul>
            ${g.items
              .map((f) => {
                const width = Math.min(100, Math.abs(f.contrib) * 40);
                const side = f.contrib >= 0 ? "pos" : "neg";
                return `<li>
                  <div class="f-label">
                    <strong>${f.labelZh || f.label}</strong>
                    <span>${f.label}</span>
                  </div>
                  <div class="f-bar ${side}"><i style="width:${width}%"></i></div>
                  <div class="f-val">${f.contrib >= 0 ? "+" : ""}${f.contrib.toFixed(2)}</div>
                </li>`;
              })
              .join("")}
          </ul>
        </section>`
        )
        .join("")}
    </div>
  `;
}

function renderFactorsLegend() {
  const el = $("#factors-legend");
  el.innerHTML = FACTOR_GROUPS.map(
    (g) => `
    <article>
      <h3>${g.labelZh} <span>${g.label}</span></h3>
      <ul>
        ${g.factors
          .map((f) => {
            const meta = factorMeta(f.key);
            return `<li><strong>${meta.labelZh}</strong> — ${meta.hint}</li>`;
          })
          .join("")}
      </ul>
    </article>`
  ).join("");
}

function render() {
  const result = analysis();
  ensureSelected(result);
  renderMeta(result);
  renderTable(result);
  renderBreakdown(result);
  $("#temp-value").textContent = state.temperature.toFixed(2);
}

function bind() {
  $("#race-select").addEventListener("change", (e) => {
    state.raceId = e.target.value;
    state.selectedNo = null;
    render();
  });
  $("#temp-slider").addEventListener("input", (e) => {
    state.temperature = Number(e.target.value);
    render();
  });
  $("#scroll-live").addEventListener("click", (e) => {
    e.preventDefault();
    $("#live").scrollIntoView({ behavior: "smooth" });
  });
}

function init() {
  renderRaceSelect();
  renderFactorsLegend();
  bind();
  render();
}

init();
