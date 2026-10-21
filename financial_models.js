(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.FinancialModels = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const US_KE_FLOOR_PCT = 9;
  const EXCESS_WEIGHT = 0.55;
  const DDM_WEIGHT = 0.45;
  const STAGE1_DPS_GROWTH = 0.065;
  const BUYBACK_CAP_MULTIPLE = 1.5;
  const FRAGILE_ROTE_ABS = 25;
  const INSURANCE_INDUSTRIES = new Set([
    'Life & Health Insurance',
    'Multi-line Insurance',
    'Property & Casualty Insurance',
    'Insurance Brokers'
  ]);

  function finite(value) {
    return typeof value === 'number' && Number.isFinite(value);
  }

  function isInsuranceIndustry(industry) {
    return INSURANCE_INDUSTRIES.has(industry);
  }

  function capmKePercent({ rf, beta, erp }) {
    if (!finite(rf) || !finite(beta)) return null;
    return rf + beta * (finite(erp) ? erp : 4.75);
  }

  function resolveKePercent(fin, stock = {}) {
    const capm = finite(fin?.ke_capm) ? fin.ke_capm : capmKePercent(stock);
    const floorPct = finite(fin?.ke_floor_pct) ? fin.ke_floor_pct : US_KE_FLOOR_PCT;
    const useFloor = stock.calculationCurrency !== 'HKD' && fin?.ke_floor_applied !== false;
    const active = useFloor && finite(capm) ? Math.max(capm, floorPct)
      : finite(fin?.ke) ? fin.ke
      : capm;
    return {
      ke: finite(active) ? active : null,
      ke_capm: finite(capm) ? capm : null,
      ke_floor_pct: floorPct,
      ke_floor_applied: !!(useFloor && finite(capm) && finite(active) && active > capm + 1e-9),
      useFloor
    };
  }

  function totalPayoutFromFlows(dividends, buybacks) {
    if (!finite(dividends) || !finite(buybacks)) return null;
    const div = Math.abs(dividends);
    const bb = Math.abs(buybacks);
    return div + Math.min(bb, div * BUYBACK_CAP_MULTIPLE);
  }

  function twoStageDdm(dps, kePercent, gPercent) {
    if (!finite(dps) || !finite(kePercent) || !finite(gPercent) || !(kePercent > gPercent) || kePercent <= 0) {
      return null;
    }
    const ke = kePercent / 100;
    const g = gPercent / 100;
    let curD = dps;
    let sum = 0;
    for (let t = 1; t <= 5; t++) {
      curD *= (1 + STAGE1_DPS_GROWTH);
      sum += curD / Math.pow(1 + ke, t);
    }
    const tv = (curD * (1 + g)) / Math.max(ke - g, 0.02);
    return sum + tv / Math.pow(1 + ke, 5);
  }

  function excessReturnFair(tbvps, rotePercent, kePercent, gPercent) {
    if (!finite(tbvps) || !(tbvps > 0) || !finite(rotePercent) || !finite(kePercent) || !finite(gPercent)
        || !(kePercent > gPercent) || kePercent <= 0) {
      return null;
    }
    const ke = kePercent / 100;
    const g = gPercent / 100;
    const spread = rotePercent / 100 - ke;
    return tbvps + (tbvps * spread) / Math.max(ke - g, 0.02);
  }

  /** Reasons that invalidate excess / 55·45 blend only (DDM may still show). */
  function excessBlockReason(fin) {
    if (!fin?.is_financial) return null;
    if (fin.unavailableReason) return fin.unavailableReason;
    if (fin.reason) return fin.reason;
    if (fin.reference?.reason) return fin.reference.reason;
    if (!finite(fin.rote) || !finite(fin.tbvps)) return 'missingParameters';
    if (!(fin.tbvps > 0)) return 'nonPositiveTangibleEquity';
    return null;
  }

  /** Reasons that also invalidate DDM (discount rate / payout / terminal spread). */
  function ddmBlockReason(fin) {
    if (!fin?.is_financial) return null;
    if (fin.unavailableReason) return fin.unavailableReason;
    if (fin.reason && fin.reason !== fin.reference?.reason) return fin.reason;
    if (!finite(fin.ke) || !finite(fin.g) || !finite(fin.dps_total)) return 'missingParameters';
    if (!(fin.ke > fin.g) || fin.ke <= 0) return 'invalidTerminalSpread';
    return null;
  }

  function insurerWarnings(industry, rotePercent) {
    if (!isInsuranceIndustry(industry)) return [];
    const warnings = ['bankStyleResidualIncomeOnInsurer'];
    if (finite(rotePercent) && Math.abs(rotePercent) >= FRAGILE_ROTE_ABS) {
      warnings.push('fragileInsurerRote');
    }
    return warnings;
  }

  function valueFinancial(fin, { industry } = {}) {
    const excessReason = excessBlockReason(fin);
    const ddmReason = ddmBlockReason(fin);
    const excess = excessReason ? null : excessReturnFair(fin.tbvps, fin.rote, fin.ke, fin.g);
    const ddm = ddmReason ? null : twoStageDdm(fin.dps_total, fin.ke, fin.g);
    const blend = excess === null || ddm === null
      ? null
      : Number((excess * EXCESS_WEIGHT + ddm * DDM_WEIGHT).toFixed(2));
    return {
      excess_return_fair: excess === null ? null : Number(excess.toFixed(2)),
      ddm_fair: ddm === null ? null : Number(ddm.toFixed(2)),
      fair_val: blend,
      excessReason,
      ddmReason,
      /** Headline N/A when blend unavailable; does not force-hide DDM. */
      blendReason: excessReason || ddmReason || (blend === null ? 'missingParameters' : null),
      insurerWarnings: insurerWarnings(industry, fin.rote),
      weights: { excess: EXCESS_WEIGHT, ddm: DDM_WEIGHT },
      buybackCapMultiple: BUYBACK_CAP_MULTIPLE,
      stage1DpsGrowth: STAGE1_DPS_GROWTH
    };
  }

  return {
    US_KE_FLOOR_PCT, EXCESS_WEIGHT, DDM_WEIGHT, STAGE1_DPS_GROWTH, BUYBACK_CAP_MULTIPLE,
    FRAGILE_ROTE_ABS, INSURANCE_INDUSTRIES,
    finite, isInsuranceIndustry, capmKePercent, resolveKePercent, totalPayoutFromFlows,
    twoStageDdm, excessReturnFair, excessBlockReason, ddmBlockReason, insurerWarnings, valueFinancial
  };
});
