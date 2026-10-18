# FMP original API and ten-year calculation models

This guide and the downloadable JSON/Excel models let you check every input,
annual cash flow, discount factor and equity bridge. They do not certify FMP's
forecasts or reproduce unavailable proprietary API internals.

Ready-to-open captured examples:
[Link REIT](calculation_models/0823.HK-dcf-models.xlsx) and
[HKEX](calculation_models/0388.HK-dcf-models.xlsx).
Each workbook contains both native models, both ten-year formula models and
the actual-FY reference. These are dated snapshots, not automatically refreshed
forecasts or saved website targets; regenerate them from a new JSON export when
checking different/current assumptions.

## 1. Original FMP API outputs

Advanced uses `custom-discounted-cash-flow`; the CFO-based variant uses
`custom-levered-discounted-cash-flow`. The native editor sends scalar overrides
to FMP, not independent ten-year arrays. The response includes historical and
projected model years, **not point-in-time historical valuations**.

The website currently selects the response's highest model year. Its year,
source timestamp, available response rows and overrides are preserved in the audit.
Do not interpret that model-year label as a verified valuation date or assume
the vendor's precise discount-date convention.

The native result is the **returned** `equityValue`, not the site's ten-year
recalculation. Site per-share value is:

$$
P_{\mathrm{site,native}} =
\frac{\mathrm{FMP\ returned\ equityValue}}
{\mathrm{verified\ outstanding\ common\ shares}}
$$

This issued-share denominator excludes treasury shares and includes all ordinary
classes for A/H issuers. The raw FMP `equityValuePerShare` and
`dilutedSharesOutstanding` remain separate; they are not silently replaced.
Direct DCF Valuation/Levered DCF screener references are separate vendor outputs.

Native workbook tabs retain every response field and add these residual checks:

| Check | Residual |
|---|---|
| Enterprise-value bridge | `enterpriseValue - ((sumPvUfcf or sumPvLfcf) + presentTerminalValue)` |
| Equity bridge | `equityValue - (enterpriseValue - netDebt)` |
| Diluted per-share bridge | `equityValuePerShare - equityValue / dilutedSharesOutstanding` |
| Advanced EBIT identity | `ebit - (ebitda - depreciation)` |
| CFO cash-flow identity | `freeCashFlow - (operatingCashFlow + capitalExpenditure)` |

A nonzero residual is evidence for review, not permission to alter vendor data.
These identities do not establish the provider's full forecasting/discounting
engine. In particular, its EBIT/EBITDA/D&A fields need not reconcile.

## 2. Site-calculated ten-year model

The site starts **after the latest reconciled actual fiscal year**, not after
the capture's calendar year. FMP's matching actual-year model row supplies base
revenue and opening working capital. These model-basis amounts can differ from
reported financial amounts or historical-FX amounts in the reference column.

For available future years, defaults derive monetary ratios from FMP's returned
amounts/revenue, not assumptions that every `...Percentage` field shares one
unit convention. Extension years fade revenue growth linearly from the last
provider growth to terminal growth by year ten; other operating/capital ratios
hold the final provider projection. These are standard extensions, not analyst
consensus. Each cell records its source or user override.

**Units:** JSON/site percentage inputs are percentage points (`7.46` means
7.46%). Divide by 100 in the equations below. Excel scenario tabs store
fractions with two-decimal percentage formatting. Monetary amounts are in
calculation-currency units, **not millions**; shares are individual common
shares. Native Excel tabs retain original API units unchanged.

Let $t=1,\ldots,10$ and all rates below be fractions:

$$
R_t=R_{t-1}(1+\mathrm{growth}_t)
$$

### Advanced / EBITDA-based FCFF

$$
\begin{aligned}
\mathrm{EBITDA}_t &= R_t m_{\mathrm{EBITDA},t}\\
D_t &= R_t m_{D,t}\\
\mathrm{EBIT}_t &= \mathrm{EBITDA}_t-D_t\\
\mathrm{NWC}_t &= R_t(m_{\mathrm{receivables},t}+m_{\mathrm{inventory},t}-m_{\mathrm{payables},t})\\
\Delta\mathrm{NWC}_t &= \mathrm{NWC}_t-\mathrm{NWC}_{t-1}\\
\mathrm{FCFF}_t &= \mathrm{EBIT}_t(1-T_t)+D_t+\mathrm{CapEx}_t-\Delta\mathrm{NWC}_t
\end{aligned}
$$

CapEx is a **negative** outflow, $R_t m_{\mathrm{CapEx},t}$; it is not subtracted
again. Initial NWC is the actual-year **vendor-model** receivables plus inventories
less payable. Cash/short-term investment projections are disclosure only; they
are not a working-capital deduction or an additional equity cash add-on.

Default operating tax is `1 - FMP ebiat / FMP ebit`. An implied tax outside the
supported -100% to 100% range is explicitly flagged and replaced with a valid
stated FMP tax rate (0% to 100%); otherwise unavailable. Historical effective
income tax/PBT is only a reference, not a forecast tax default. The same scenario
tax shields debt cost; there is no separate loss-carryforward tax engine.

The site's linked EBIT is EBITDA less D&A. It is **not** a promise to preserve
an inconsistent vendor EBIT simultaneously. UI edits of EBIT update EBITDA.
The workbook derives EBIT from EBITDA/D&A; enter desired EBIT plus D&A in the
EBITDA assumption if editing from an EBIT view.

### CFO-based vendor-style scenario

$$
\mathrm{CFO}_t=R_t m_{\mathrm{CFO},t},\qquad
\mathrm{CashFlow}_t=\mathrm{CFO}_t+\mathrm{CapEx}_t
$$

Do **not** add D&A or deduct working capital again. For comparison with the
vendor's returned bridge, this scenario retains WACC discounting and EV less
net debt. It is **not** an independently defined FCFE model discounted at Ke;
CFO classifications, interest and property investment still require review.

### Annual discounting and per-share bridge

$$
\begin{aligned}
\mathrm{WACC}_t &= K_{e,t}(1-w_{D,t})+K_{d,t}(1-T_t)w_{D,t}\\
DF_t &= \prod_{j=1}^{t}(1+\mathrm{WACC}_j)\\
PV_t &= \mathrm{CashFlow}_t/DF_t\\
TV_{10} &= \frac{\mathrm{CashFlow}_{10}(1+g)}{\mathrm{WACC}_{10}-g}\\
PVTV &= TV_{10}/DF_{10}\\
EV &= \sum_{t=1}^{10}PV_t+PVTV\\
\mathrm{Equity} &= EV-\mathrm{snapshot\ netDebt}\\
P_{\mathrm{scenario}} &= \mathrm{Equity}/\mathrm{issuedShares}
\end{aligned}
$$

Year-ten WACC must exceed terminal growth. WACC must be positive and below 100%
each year. Discounting uses year-end timing and no stub-year adjustment; year-ten
WACC is **not** applied retrospectively to all ten years. Net debt must be a
consistent source snapshot before constructing defaults and is deducted once.

Initial Ke retains the vendor input. UI edits of risk-free rate, beta or premium
set `Ke = rf + beta * ERP`; direct Ke edits are allowed. Excel retains initial
Ke while those drivers remain unchanged, then uses CAPM. Its separate blank
Ke-override row lets an explicit override take precedence.

Percentages **display** two decimals but retain full source/entered precision.
Tooltips, JSON and Excel preserve those values, avoiding calculation drift on
rendering, language changes, save or reload. Changing terminal growth does not
silently replace the ten populated annual growth rates.

## 3. Actual-reference column and HKEX historical restoration

The reference column is the exact baseline **full fiscal year, not TTM**.
Flows cover that FY; balances are at the same FY end. It shows actual monetary
amounts and ratios, identifies standardized FMP vs reviewed official sources,
and uses period-specific historical FX. It does not rewrite model defaults.
Unknown receivable/payable splits and capital-cost/beta history remain N/A.
At this snapshot, 428 of the 430 supported company/model pairs have matching
actual-year references. BRK.B's detailed annual statement cache ends in 2019,
so its FY2025 reference is explicitly unavailable in both models rather than
filled with stale figures or model-history values.

HKEX's five FY-end balance columns 2021-2025 and latest June 2026 balance are
restored/verified from official current/non-current columns. Each date retains
its own PDF URL, page, hash and comparative basis in
`cache/hkex_balance_classifications.json`; all subtotals and the accounting
equation reconcile. Original provider records remain archived. This is a
retrospective correction, not reconstructed point-in-time valuation history.
Other unverified interim dates are not silently certified.

## 4. Link REIT: why the pictured Advanced flows are negative

With the captured default inputs, FY2027 has HKD:

| Component | Amount |
|---|---:|
| Revenue | 13,866,141,191 |
| EBITDA | 2,984,067,940 |
| D&A | 94,845,652 |
| Site linked EBIT | 2,889,222,288 |
| Operating tax | 3.209576875786291% |
| CapEx | -4,956,042,061 |
| Increase in NWC | 271,739,973 |
| Site FCFF | -2,336,445,904.4457116 |
| Annual WACC | 7.464695153412826% |

Negative FCFF is primarily driven by projected CapEx at **35.74204238030393% of
revenue**, not double-counted D&A or a flipped discount sign.
The vendor's FY2027 EBIT is 2,910,347,364, which exceeds EBITDA less D&A by
21,125,076. The site deliberately uses a coherent linked EBIT; native API rows
and their own UFCF remain unmodified and separately visible.

The reported FY2026 reference also differs from FMP model history: official CFO
8,461m vs reclassified FMP 6,816m; property plus PPE cash additions 1,934m vs
FMP's PPE-only CapEx 39m. The actual reference shows the reviewed official
amounts without silently normalizing forecasts. EBIT/EBITDA still retain
property valuation effects and are not certified rental-business earnings.

The captured ten-year default equity outputs per issued share are approximately
**HKD -33.2171156433 (Advanced)** and **HKD -4.2315021844 (CFO)**.
These are negative model-equity outcomes, **not tradable negative share prices**.
A negative terminal cash flow makes the Gordon going-concern interpretation
economically unreliable even when its arithmetic is correct. A different,
normalized business forecast requires explicit assumptions, not a forced
positive target.

## 5. Download, independent check and editable Excel

Use **Download calculation model and full-precision inputs (JSON)** under either
model mode. Pending edits are calculated first; a failed calculation cannot
export an apparently successful new result. Exporting does not save the target.
In ten-year mode, the file includes both source API material and the actual
edited local scenario.
Reloaded native saved targets retain a selected summary rather than every row
of the earlier custom response. The audit identifies partial row coverage
relative to cached source models and keeps the untouched cached source rows
separately; it does not fabricate missing custom-response years.

Export all cached supported scenarios, or select one ticker:

```powershell
node scripts\export_fmp_calculations.cjs --output C:\audit\fmp-calculations.json
node scripts\export_fmp_calculations.cjs --ticker 0823.HK --output C:\audit\link.json
```

Use Python's **standard library only** to independently recompute using
50-digit Decimal arithmetic and optionally create an Excel workbook:

```powershell
python scripts\fmp_calculation_workbook.py --input C:\audit\fmp-calculations.json
python scripts\fmp_calculation_workbook.py --input C:\audit\fmp-calculations.json --ticker 0823.HK --output C:\audit\link.xlsx
```

The same Python script accepts a single downloaded UI JSON, including user
overrides. Native-only JSON produces native tabs without inventing a ten-year
scenario. Workbooks contain source-native tabs, formula-based ten-year tabs,
actual-reference provenance and limitations. Excel recalculates on opening;
cached initial values are independently computed, not zero placeholders.
Column/per-field origins distinguish vendor projection years, extensions and
user overrides. Excel is a transparent calculation template, not a reproduction
of every web-form validation rule; use valid numeric inputs and do not overwrite
calculation formulas. Invalid terminal spreads return `#N/A`.
No macros, external data connections or API credentials are embedded.

The Decimal checker compares every annual cash flow, amount, WACC, discount
factor and valuation bridge against JavaScript. Monetary tolerance is 0.01
currency units, per-share tolerance 1e-8, WACC/discount-factor tolerance 1e-12.
It reports measured maximum differences; passing arithmetic does not certify
forecast quality, native API internals or economic suitability.

Regression commands:

```powershell
node --test tests\fmp_scenario.test.cjs tests\official_statements.test.cjs
python -m unittest discover -s tests -p test_fmp_calculation_workbook.py
node tests\fmp_models.browser.cjs
node tests\official_statements.browser.cjs
node tests\fmp_workbook.formulas.cjs
```

Browser checks require Playwright/a browser. The optional formula-engine check
requires `xlsx` and `xlsx-calc` in the validation environment, not in the website
runtime; it recalculates the generated spreadsheets for Link, HKEX and Apple,
including edits to growth, D&A/CFO, CAPM, terminal growth, debt and explicit Ke.
The validator supplies standard Excel lazy-IF, numeric-type ISNUMBER and NA
error semantics where the test library differs from Excel. The exported workbook
uses ordinary Excel functions and has no dependency on that test library.
