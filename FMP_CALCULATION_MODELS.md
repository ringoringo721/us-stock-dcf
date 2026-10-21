# FMP original API and ten-year calculation models

This guide and the downloadable JSON/Excel models let you check every input,
annual cash flow, discount factor and equity bridge. They do not certify FMP's
forecasts or reproduce unavailable proprietary API internals.

The full HKEX catalogue is a listing universe, not a claim of complete model or
financial coverage. New company snapshots retain the same source, currency,
period and share-basis guards as the reviewed set. Piotroski scores require
supported statement comparisons; moat scores require individually attributable
business research and bilingual evidence-based assessment. Missing inputs remain
unavailable. Native FMP model references stay distinct from site scenarios.
Additional companies use compact screener records and on-demand complete company
snapshots; cloud batch artifacts are not published automatically.

Ready-to-open captured examples:
[Link REIT](DCF_calculation_models/0823.HK-dcf-models.xlsx) and
[HKEX](DCF_calculation_models/0388.HK-dcf-models.xlsx).
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

New scenarios use the separate annual **FMP `analyst-estimates`** feed, not the
prebuilt DCF API's operating forecasts. Revenue growth derives from consecutive
consensus revenue amounts; EBITDA/revenue uses consensus amounts for that same
fiscal period. Fiscal dates must match the baseline's annual calendar within ten
days (including 52/53-week years); duplicates, missing years and missing analyst
coverage do not create forecasts. Amounts use verified model-snapshot FX after
checking historical consensus/reporting currency scale. This is current
consensus captured on the stated date, not point-in-time historical consensus;
GAAP/adjusted comparability and per-metric analyst counts are not certified.

When explicit consensus is absent, **CapEx, CFO and D&A use the latest available
complete fiscal year's respective amount/revenue ratios**, not five-year
averages, older substitute years or EBITDA-minus-EBIT estimates of D&A. The
actual-ratio source date is shown separately from the valuation baseline.
Only **change in NWC/revenue** uses an arithmetic average of five consecutive
full-year ratios. Missing actuals, incomplete five-year coverage and other
unavailable forecasts stay N/A. No revenue/margin forecasts are invented beyond
consensus coverage. The current endpoint does not provide forecast operating
tax or terminal growth, so those inputs are blank pending explicit user input.
Incomplete scenarios display no valuation and cannot overwrite saved targets;
their inputs and unavailable reasons can still be downloaded.

At the user's direction, **beta, risk-free rate, risk premium, cost of debt and
debt/capital retain their prior settings**, as does the existing equity-cost
logic. Available native forecast years supply those capital inputs; later years
hold the final native capital inputs. They are labeled retained settings,
**not** analyst forecasts. Each cell records consensus, latest-FY actual ratio,
five-year NWC ratio, retained capital setting, linked derivation, missing input
or user override. Native API rows/results remain unmodified.

Saved scenarios are not reseeded. Legacy three-component NWC assumptions are
converted in an in-memory copy to equivalent annual change/revenue ratios using
their original revenue paths. This preserves their cash flows and target
arithmetic; original component inputs/origins are retained in the audit export.
The stored target and scenario are not overwritten unless the user saves again.

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
\Delta\mathrm{NWC}_t &= R_t m_{\Delta\mathrm{NWC},t}\\
\mathrm{FCFF}_t &= \mathrm{EBIT}_t(1-T_t)+D_t+\mathrm{CapEx}_t-\Delta\mathrm{NWC}_t
\end{aligned}
$$

CapEx is a **negative** outflow, $R_t m_{\mathrm{CapEx},t}$; it is not subtracted
again. Positive NWC changes consume cash; negative changes release cash. The
single NWC input replaces receivables/revenue, inventories/revenue and
payables/revenue. Historical NWC changes are **negative** FMP cash-flow
`changeInWorkingCapital` (the latter is a cash impact), including other operating
working capital, divided by same-FY revenue. This is not merely the change in
three closing trade balances. Initial NWC is not deducted again. Legacy
unconverted JSON retains its original closing-balance-difference calculation.
The ten-year editor omits the unused cash/revenue input and
projected-cash display. Legacy saved cash ratios remain compatible but never
affect FCFF or target price. Snapshot net debt still includes cash and is
subtracted once; projected cash is not an additional equity cash add-on.

New default operating tax is N/A: no consensus tax forecast is supplied. Neither
historical income-tax/PBT nor native-model implied tax is passed off as analyst
tax. Retained legacy scenarios keep their prior implied/explicitly normalized
tax inputs and warnings. The scenario's tax also shields debt cost; there is no
separate loss-carryforward tax engine.

The site's linked EBIT is EBITDA less D&A. Consensus EBITDA takes priority; it
is **not** a promise to preserve an inconsistent independent consensus EBIT
simultaneously. If only EBIT consensus exists, EBITDA derives from EBIT plus
the specified D&A. UI edits of EBIT update EBITDA.
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
and uses period-specific historical FX. It does not rewrite native API data.
The separately identified latest-FY ratios seed the three approved fallback
inputs in new scenarios; that year need not equal the baseline reference year.
Unknown receivable/payable splits and capital-cost/beta history remain N/A.
BRK.B's detailed annual statement cache ends in 2019,
so its FY2025 reference is explicitly unavailable in both models rather than
filled with stale figures or model-history values.
Those stale years also do not seed latest-FY forecast fallback ratios.

HKEX's five FY-end balance columns 2021-2025 and latest June 2026 balance are
restored/verified from official current/non-current columns. Each date retains
its own PDF URL, page, hash and comparative basis in
`cache/hkex_balance_classifications.json`; all subtotals and the accounting
equation reconcile. Original provider records remain archived. This is a
retrospective correction, not reconstructed point-in-time valuation history.
Other unverified interim dates are not silently certified.

### Galaxy: official revenue and operating-basis correction

The cached FY2025 FMP income statement subtracts gaming tax from revenue:
HKD49,242.325m official revenue minus HKD19,650.710m gaming tax equals its
HKD29,591.615m revenue. FY2024 provider revenue is before that tax. Comparing
those incompatible bases produces a false -31.87% decline; official growth is
**+13.3770%**. Other affected annual/interim periods cannot be left on mixed bases.

`cache/hkex_revenue_sources.json` records twelve issuer/HKEX PDFs, hashes and pages:
official FY2018-FY2025 revenue, H1 2011-H1 2026 revenue, and the complete
operating-cost categories across those periods. H1 2017 is explicitly
the restated comparative published in 2018, not a point-in-time claim.
`scripts/official_revenue.cjs` applies these values and derives H2 as annual
minus H1 only for compatible reviewed presentations. Core operating income
subtracts the disclosed operating-cost categories, including separately
expensed commissions in H1 2011-H1 2016; core EBITDA adds D&A once,
excludes other income/investee results and non-operating derivative fair-value changes, and is
**not issuer adjusted EBITDA**. No official gross-profit subtotal is reported:
gross profit/COGS/margins remain unavailable, not zero or an invented residual.
Original provider income rows and reconciliation warnings are archived.
Earlier commission presentations are not silently restated or assumed
comparable with after-commission revenue. Unavailable older H2 periods are not
invented; other financial fields are not certified.

The corrected series feeds historical revenue growth, margins, TTM and related
ratios, forward-EPS scale checks, the latest-FY CFO/CapEx/D&A denominators and
five-year working-capital ratios. New analyst scenarios use official FY2025
base revenue **HKD49,242,325,000**, while the original consensus-scale guard is
unchanged. Matching either original or subsequently fixed native historical
revenue validates the currency bridge; it does not modify API model rows.

Native FMP models/results remain unmodified, prominently labeled as **not
recalculated from the official correction**. Saved user assumptions/targets are
not overwritten; retained scenarios on an old revenue baseline carry a warning.
This is a retrospective financial-statement correction, not point-in-time
historical DCF reconstruction or a certification of all provider figures.

To regenerate **only Galaxy** from an existing recorded HK capture:
`node scripts\apply_official_revenue.cjs CAPTURE_DIRECTORY 0027.HK`.
Omitting the symbol list regenerates all configured reviewed issuers (currently
all 21 reviewed gaming-related issuers), not the whole HK universe.
The command leaves unrelated HK stocks and native company models unchanged;
existing Moat research may become stale, but is not regenerated or redated.
Regression coverage: `node --test tests\official_revenue.test.cjs`.

### Sands and the wider gaming review

`cache/hkex_gaming_revenue_sources.json` records the official Sands statements
for FY2018-FY2025 and the available H1 history, with original units, PDF hashes
and pages. Its USD7,443m FY2025 net revenue already precedes gaming tax;
adding USD2,870m tax to that amount would double count. Reported operating
profit is USD1,231m and income-statement D&A is USD792m. Core operating
EBITDA is therefore USD2,023m. The native provider instead uses its USD1,299m
EBIT plus the same USD792m D&A to obtain USD2,091m: this difference is an
earnings-definition difference, **not an incorrect D&A figure**. Neither is
automatically the issuer's adjusted property EBITDA.
Reported operating profit, D&A, pretax profit, tax, attributable earnings and
separately disclosed interest are reviewed; other fields are not certified.
Sands reports expenses by nature without a gross-profit subtotal, so GP/COGS
and gross margins remain N/A, not zero.

The shared overlay supports issuer-specific HKD/USD/JPY amounts, per-period
thousand/million units and reported gross-profit subtotals. Source identity,
document hashes and exact annual amounts are checked before scenario use.
The reviewed scope now includes Galaxy, Sands, MGM China, Wynn Macau, Melco
International, SJM, NagaCorp, Dynam, Niraku, Okura, Paradise Entertainment,
Palasino, Shin Hwa World, Asia Pioneer, China Ecotourism, Emperor Entertainment
Hotel, Macau Legend, Century Entertainment, Success Universe, International
Entertainment and AGTech. These are 21 gaming-related listings, including
19 additions outside the unchanged 95-member HSI roster. The official listing
evidence, business-scope qualifications and exclusions are saved in
`cache/hkex_gaming_universe.json`.

The 19 additions use **reviewed periods only** for income history. Real primary
annual/H1 dates replace misdated provider rows, with original provider income
and balance histories archived. Each reviewed figure retains its report,
SHA-256, PDF pages, currency and units. Published EPS remains in its original
per-share units; historical share subdivisions are not silently rebased.
Missing reviewed D&A stays unavailable instead of borrowing a cash-flow
add-back on a different business basis. Genuine reported GP/COGS remains
available, including for relevant suppliers and pachinko operators.

Periods retain their actual start dates and month counts. Fifteen/eighteen-month
transitions are not normal annual growth/return denominators. H2 is annual minus
H1 only when starts and accounting/consolidation bases match; ordinary TTM
requires compatible six-month periods. Incompatible restatements remain blocked,
not filled. Three real twelve-month second interims are retained as `I2 (12M)`,
not invented half years or audited FY. Continuing-only revenue uses a separately
supported continuing attributable-profit numerator for net margin; total profit
including discontinued operations is not substituted.

Historical HKD translation uses actual period-average rates for flows and
closing-date rates for balances. The new listings use balances only at exact
reviewed report dates in matching reporting currencies, without certifying
every provider balance line. Interim cash flows without verified flow durations
remain archived/unavailable rather than being relabeled from income dates.
Uncovered financial fields, unsupported pre-IPO periods, early foreign-currency
FX coverage and unverifiable native-model currencies remain N/A.

Success Universe's associate casino turnover is not consolidated group revenue.
AGTech's banking/payment and lottery operations are not a pure casino or an
assumed pure bank. Both require segment valuation; stored native FMP outputs are
preserved but do not endorse a single corporate DCF. Historical/current gaming
exposure notes also distinguish Emperor and Macau Legend. Quotes older than
14 days retain a dated last trade, not a current price, market capitalization
or current market-multiple comparison.

All financial subpages share the corrected statements and supported recalculated
ratios. Changed financial evidence archives earlier AI Moat assessments with
their original dates until reassessment. The subsequent authorized Vertex AI
refresh reassessed the five invalidated companies and all nineteen additions
against matching financial evidence and attributable business research. It did
not redate the other assessments or overwrite saved scenarios/target prices.
Native FMP model rows and existing capital-cost settings are not rewritten by
this overlay. Dated, verified issuer-wide ordinary shares now restore affected
per-share references; the source-native diluted-share fields remain intact.

For screeners and company references, trailing P/E uses supported reported
diluted TTM EPS, otherwise compatible actual TTM common earnings divided by
dated current ordinary shares, with that alternative basis disclosed. It never
adds half-year EPS or substitutes stale annual EPS for current TTM. P/B uses
quoted price over reported parent equity per verified ordinary share, before
separately deducting preference equity. All ordinary classes and explicitly
excluded treasury shares are checked against primary monthly returns for the
twenty-six mixed-class issuers, including non-A/H structures. These are dated
September references, not assertions of unchanged shares since month-end.
Missing periods, preferred-income deductions, required liquidation inputs or
current prices remain unavailable.
An explicitly reported twelve-month second interim can directly supply current
twelve-month earnings/EPS. Its overlapping first interim is not added; this
does not synthesize missing half years or relax the other historical TTM guards.

`scripts/capture_hkex_reports.py` still captures **unreviewed candidate**
extractions; a new report does not automatically become a reviewed correction.
The saved review is retrospective financial reconciliation, not point-in-time
historical DCF reconstruction or certification of all provider figures.
Focused coverage includes `tests/gaming_history_sources.test.cjs`,
`tests/gaming_expansion.test.cjs` and the HK universe browser regression.

## 4. Link REIT: why the prior vendor-seeded Advanced flows were negative

The earlier vendor-seeded scenario (not the new analyst defaults) produced the
following FY2027 HKD amounts:

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
amounts. New CFO/CapEx fallback ratios now use those reviewed actuals, explicitly
identified as actual-ratio carry-forwards rather than analyst forecasts.
Native FMP historical model
rows retain their original property-FV exposure. The separate current historical
statement/reference overlay now shows FY2026 operating income **9,357m**, EBIT
**9,609m**, EBITDA **9,699m** and attributable NPAT **6,430m**, with source-specific
limitations below. These are not certified rental-only business earnings.

### Reviewed historical property-FV overlay

`cache/property_fv_sources.json` records official Link FY2019–FY2026 annual and
half-year figures, eight report URLs/SHA-256 hashes/PDF pages and exact formulas.
`scripts/property_fv.cjs` reconstructs operating income from NPI less corporate
expenses and retained non-property impairments; EBIT is pretax + finance costs
minus the **signed consolidated property-FV gain**. EBITDA adds the original FMP
historical D&A. Unseparated JV FV can remain in JV share-of-profit: this is not
a claim to have removed every group FV effect.

Attributable NPAT uses the issuer's separate property-FV and related deferred-tax
distribution adjustments, including the disclosed JV/NCI attribution, not the
entire consolidated FV loss. FY2021 and H1 FY2021/H1 FY2024 combine FV with other
impairments without a verified attribution split; adjusted NPAT remains N/A.
H2 is actual annual minus actual H1 and preserves these gaps. Basic EPS uses
verified issuer unit counts; diluted EPS and derived trailing P/E are unavailable
because changing earnings requires a new convertible-dilution assessment.

CFO is the statutory reported figure, **already excluding noncash FV**, without
a second addback. FCF deducts cash investment-property and PPE additions; FY2026
is **8,461 − 1,895 − 39 = 6,527m** and FY2025 is **7,811m**. This measure is before
financing-classified interest, not distributable equity cash. Investing,
financing, FX, cash positions and the FY2026 **−45m** held-for-sale cash movement
reconcile independently. Unverified component breakdowns are N/A, not invented
zeroes or totals forced into an “other” residual.

Original provider income/balance/cash-flow rows and cadence remain in
`propertyFvOriginal`. Reviewed display rows carry their own source hash and
fingerprint; native source-review checks validate that overlay separately and
read **original** provider rows for vendor reconciliations. Reported-basis
F-score, native forecasts and API valuations are not rewritten. New scenario
defaults separately apply the analyst/approved-actual-ratio policy above.
Pretax/tax/other unadjusted income rows remain labelled reported;
the mixed reference table is **not** a restated GAAP income statement. Earlier
unreviewed columns are explicitly identified. New periods require reviewed
source evidence, not automatic tag/AI estimates.

The saved 325-stock FMP isolated-tag scan is `cache/property_fv_coverage.json`;
the 19 subsequent gaming additions are indexed as `NOT_REVIEWED`, without
invented response hashes or a claim that their original tags were inspected.
missing tags do not prove zero FV. `cache/property_fv_reviews.json` explains all
six false-positive candidates. In particular, ASR's MXN2,824,478,000 tag is an
acquired property's closing IAS40 balance after FX, verified in the original
SEC filing, **not** a P&L gain; discount-rate sensitivities are not actual flows.
Other stocks remain reported unless independently supported adjustments exist.

The supplied Excel files retain their original snapshot and have not been
overwritten after their directory move. For current actual-reference
provenance, use the page's calculation JSON export or regenerate using the
commands below; native forecast outputs remain the same.

The earlier vendor-seeded ten-year equity outputs per issued share were approximately
**HKD -33.2171156433 (Advanced)** and **HKD -4.2315021844 (CFO)**.
These are negative model-equity outcomes, **not tradable negative share prices**.
A negative terminal cash flow makes the Gordon going-concern interpretation
economically unreliable even when its arithmetic is correct. A different,
normalized business forecast requires explicit assumptions, not a forced
positive target.

## HK reported trading multiples

Nonfinancial HK `reportedMultiples` are built independently from canonical
dated statements, not from DCF eligibility, analyst forecasts or saved model
scenarios. TTM EBITDA uses compatible actual income periods with their own
historical currency conversion; CFO/CapEx coverage is not a prerequisite.
The reviewed gaming periods retain operating profit plus disclosed D&A, not
issuer-adjusted EBITDA. Missing actual EBITDA is not inferred from forecasts.
A latest explicitly reported twelve-month second interim is counted once;
its overlapping six-month first interim is not added.

Quoted EV retains market cap plus reported debt less cash/short-term
investments plus preferred/noncontrolling book proxies. Missing claims do not
default to zero. Debt includes reported leases and is not reduced by a DCF
lease exclusion. Market and balance-sheet dates are disclosed separately.
Positive EBITDA supports the three trading multiples even if DCF is blocked.
Zero/negative EBITDA is not a meaningful denominator and remains N/A with a
specific bilingual reason. Negative net debt or EV with positive EBITDA is
preserved, not clamped. An unavailable current quote blocks EV only; supported
dated debt/EBITDA and net-debt/EBITDA remain available. No DCF defaults,
forecasts, capital costs, native FMP models or saved scenarios are reseeded.

## HK full-fiscal-year peer comparisons

The HK peer-comparison page is separate from the market TTM references above:
it uses each issuer's latest **reported full twelve-month fiscal year**, not
a twelve-month interim report relabeled as an annual report. Each column
discloses its own FY-end date. All financial flows, margins, growth rates and
valuation/leverage denominators use that FY, with matching FY-end balances.
Growth uses consecutive comparable full years; ROE/ROA retain beginning
balances. The labeled ROIC proxy retains its existing 21% tax assumption.
Share price, market cap and Moat remain current references, and annual EV
combines current market cap with FY-end reported capital. Annual P/E uses
reported diluted FY EPS, or explicitly identifiable common FY earnings and
verified dated shares; P/B uses FY-end parent equity and the same share guard.
Forecast P/E/P/B rows are omitted rather than mixed into this annual view.
Missing annual inputs remain unavailable, with no older-year or TTM fill.
This display-only projection does not mutate the screener, current DCF
assumptions, source statements, native models or saved scenarios. US peers
retain their existing TTM behavior.

## Bank and insurer annual ROTE references

The bank/insurer valuation page places ten full fiscal years of ROTE below its
Excess Return on Tangible Book + DDM model. Annual `netIncome` is divided by
the preceding fiscal year-end's tangible shareholders' equity and multiplied
by 100. Tangible equity deducts goodwill and other intangibles once, without
separately deducting preferred stock. The shared ratio engine and historical
currency translation are unchanged. This is statement-based ROTE, not the
issuer's adjusted ROTE or the model's latest TTM reference.

All 18 financial-model stocks have file-backed inputs and ten calculated
annual observations in `cache/rote_history/`, with capture dates and source/FX
hashes. Opening the table makes no FMP or AI requests. Historical references do
not overwrite forecast sliders or saved targets. Missing periods, fields or
opening equity remain N/A with their reason; negative values retain their sign
and warnings. Display precision is two decimals, not calculation precision.

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
Incomplete scenarios export input-only tabs with explicit N/A status/reasons,
not invented formula results, and are listed as unavailable rather than audited
valuations. Complete scenarios export formula tabs; per-field origins
distinguish analyst forecasts, actual ratios, retained capital settings,
legacy assumptions and user overrides. Excel is a transparent calculation template, not a reproduction
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
node --test tests\analyst_sources.test.cjs tests\fmp_scenario.test.cjs tests\official_statements.test.cjs
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
