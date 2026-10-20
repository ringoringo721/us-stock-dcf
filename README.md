# us-stock-dcf

## Full HKEX company expansion

`cache/hkex_universe.json` and `hkex_universe_data.js` import **2,787** ordinary-equity,
listed investment-company and REIT primary counters from HKEX's official securities
workbook. Main Board and GEM companies are included; ETPs, debt, warrants, CBBCs,
preference shares, trading-only securities, depositary receipts and temporary
Main Board counters are excluded. Verified duplicate ISINs select the HKD counter;
blank ISINs never collapse unrelated companies. Sole USD/RMB listings remain in
the catalogue, but unsupported trading currencies do not become HKD quotes.
The workbook labels itself **20 October 2026**, retrieved **19 October 2026**;
both dates and the workbook SHA-256 are retained. This is not a point-in-time
membership/backtest feed. FMP sector/industry enrichment is not official HSICS.

The previously reviewed 114-company dataset and its corrections remain unchanged.
Additional companies start with explicit unavailable financials, prices and ratings,
not zero values or template scores. The screener searches the entire catalogue
but initially renders 100 rows, with a show-more control. Completed company
snapshots load on demand from `cache/hk_companies/`; they do not duplicate all
financial histories in the initial JavaScript asset.
New-company foreign statements reference content-addressed historical HKD FX
snapshots. These retain additional supported reporting currencies without
rewriting the original 114-company FX observations or saved model evidence.

The existing **Read-only valuation source audit** workflow accepts `expand_all_hk`.
It partitions additional companies into batches of at most twenty, captures actual
FMP statements, dated prices and native model/company data, calculates supported
Piotroski tests, researches each business using attributable sources, and assesses
ten moat dimensions with bilingual comments through Vertex AI. Required source,
currency, date and share-basis guards remain active; unsupported or incomplete
inputs carry explicit limitations. A batch/job finishing is not proof of complete
ratings: each artifact's `manifest.json` records actual coverage counts.
This mode only uploads `hkex-expanded-*` artifacts: it cannot push, merge, invoke
a deployment hook or publish the captured results. `resume_run_id` reuses successful
endpoints from the same batch of a previous run when captured within seven days.
For ratings-only recovery, also set `moat_only`; this requires a saved run ID
and reuses its financials, model data, attributable research and exact captured
FX basis rather than recapturing market data. `hk_batches` restricts recovery
to selected batch indices. Research and assessments checkpoint each completed
company atomically, so a later timeout cannot erase the earlier results.
Expansion imports also check fiscal closing-date changes before treating a
provider FY row as twelve months or deriving H2. Conflicting annual/interim
dates remain flagged; they do not generate duplicate quarterly observations.

Download the artifacts to an ignored directory and explicitly integrate them with
`node scripts/build_hkex_expansion.cjs integrate <download-directory>`.
The importer validates universe/source and company identity, refuses to overwrite
the reviewed 114, and preserves newer snapshots. Build and review before publishing;
cloud artifacts alone do not update the live site.

## Hang Seng Index and gaming extension

Production builds run `node scripts/build_site.cjs` and publish only the
allowlisted browser assets and financial/price/FX caches in `public/`. Backend
programs, raw source captures and private rating inputs are not public assets.
`vercel.json` makes browsers revalidate data rather than retaining stale scores.

The shared interface has a US/HKEX selector, the same 36 screener columns and all
nine company subpages. The automatic site fair-value and its market-premium
columns are omitted from every screener view in both markets; individual
valuation models, FMP reference prices and saved target prices remain available.
The HKEX universe contains all **95 Hang Seng Index
constituents effective 7 September 2026**, verified against Appendix 1 of
[Hang Seng Indexes' 21 August 2026 review](https://www.hsi.com.hk/static/uploads/contents/en/news/pressRelease/20260821T174500.pdf).
`cache/hsi_constituents.json` saves the exact constituent codes, effective date,
source pages and official-document SHA-256. The original Tencent (00700),
Alibaba (09988), HSBC (00005), HKEX (00388), CCB (00939) and Link REIT (00823)
retain their audited data and issuer-specific corrections; 89 listings are added.
It also includes **19 separately curated gaming-related listings**, for 114
configured HK stocks, not 114 HSI constituents. `cache/hkex_gaming_universe.json`
records the 21-company gaming scope (including Galaxy and Sands), official HKEX
listing evidence and exclusions. It includes pachinko, lottery, suppliers,
equity-accounted investments and disclosed historical gaming exposures rather
than labeling every issuer a pure casino. Membership is a dated configuration,
not a live index-membership feed.
Qualified provider identities retain `.HK`; they are not US sample aliases.
US primary amounts remain USD; HKEX primary amounts, per-share values, tables,
price charts and exports use HKD. Saved models cannot reinterpret USD as HKD.

All configured listings have saved statement, actual daily-price and company/model
snapshots. Coverage starts at the actual available listing/provider date; recent
listings do not receive invented five-year histories. Banks/insurers use the
financial model, not corporate DCF. Issuer-wide equity valuation is unavailable
when mixed-class shares have not been independently verified; H-only counts
are not substituted for total issuer shares. Vendor model/currency gaps remain
explicit N/A rather than estimates. Native FMP reference values remain separately
identified as provider results. Quotes older than 14 days are not current
prices: the dated last trade is preserved separately, while current market cap,
market multiples and price comparisons remain N/A.

The prior 89-constituent expansion saved Vertex AI moat assessments and bilingual
comments across ten dimensions. The 42 initially
partial companies were reassessed using additional attributable business
research, together with the three insurers whose PF evidence changed. Scores
in this saved batch cover all 890 dimensions with bilingual explanations. They
remain qualitative judgments, not reported financial measurements.
When corrected financial evidence invalidates an assessment, its original
timestamp and report are preserved in a clearly marked archive; the current
score/grade is unavailable until reassessment. New gaming listings do not
receive fabricated research or neutral scores. Genuinely missing evidence
is not filled with neutral scores or prorated to a
complete assessment. The original six dated assessments are preserved.
Generation used explicitly authorized, artifact-only GitHub Actions runs with
existing Vertex credentials after the
local API-key route returned HTTP 403; it did not deploy or merge site changes.
Rejected outputs are retried with safe, field-specific validation feedback,
without relaxing citation or qualitative-only narrative checks. Unchanged
financial evidence, business research and assessment policy reuse the saved
reports without model requests;
partial assessments are only retried when explicitly requested.
The regular HK refresh reads every symbol from `hkex_stocks.json`, rather than
a six-symbol workflow list, and persists financial-company ROTE references.

### Reviewed gaming financial history

Galaxy's source registry and `cache/hkex_gaming_revenue_sources.json` supply
issuer-specific annual/interim corrections across all 21 gaming-related listings.
Historical revenue, operating earnings, disclosed D&A, tax, attributable earnings,
interest and genuinely reported gross profit use cited primary reports, not a
blanket gaming-tax addback. Original provider statements and native FMP models
remain separately available; reviewed fields are not an audit of every balance
or cash-flow line item.

All subpages consume the same corrected statements and recalculated supported
ratios. Actual reporting dates, currencies, month counts and compatible
accounting bases are retained. H2/TTM is reconstructed only from compatible
reported amounts; discontinued earnings cannot inflate continuing-operation
margins. Twelve-month second interims stay explicitly labeled `I2 (12M)`,
not ordinary half years or audited FY. Unsupported periods, cash-flow durations,
D&A and currency coverage remain N/A. Mixed bank/lottery AGTech and
equity-accounted Success Universe require segment valuation, not an endorsed
single corporate DCF. See [the source and limitation details](FMP_CALCULATION_MODELS.md).

### Saved financial-model ROTE references

Banks and insurers show the last ten complete fiscal years of annual ROTE below
the Excess Return on Tangible Book + DDM model. These are statement-based returns:
full-year `netIncome` divided by **beginning** shareholders' equity less goodwill
and other intangibles, using the existing ratio engine and historical currency
translation. Preferred stock is not separately deducted. These are not issuer
adjusted ROTE, current TTM, or automatically applied forecast assumptions.
Missing values remain N/A with reasons; losses/negative tangible equity are
retained with warnings. Figures display two decimal places.

`cache/rote_history/` persists annual inputs, all ten calculated references,
capture dates and input/FX hashes for all 25 financial-model stocks. Opening the
reference table needs no FMP or AI call. `node scripts/capture_rote_history.cjs`
reuses matching saved inputs; `--refresh` explicitly requests new FMP data.
Eleven year-end balance periods support ten beginning-equity returns. Older
HKD/CNY FX observations were appended from the Federal Reserve without changing
any previously saved observation.

Live technical indicators, custom FMP calculation responses and news pages also
persist in IndexedDB in the same browser and site origin. Identical requests
reuse snapshots across page reloads; changed parameters are separate keys.
Custom model keys include their underlying source snapshot. Existing saved
company-news captures seed the news cache; empty provider coverage is saved too.
Refresh controls explicitly bypass saved indicator/news responses. Capture
dates are preserved and cached data is not described as live. Storage failures
are visibly reported, and failed refreshes do not replace successful snapshots.
Browser clearing, private-session expiry, a different browser/device/origin or
previously unseen parameters can require another request. Saved Vertex headline
translations remain file-backed and are not inferred again when opening news.

### Reviewed property-FV history and market references

Link's FY2019–FY2026 annual/half-year historical overlay is independently
source-driven, not a blanket FV addback. Operating income retains other
impairments; EBIT excludes the signed consolidated property-FV movement, and
EBITDA adds FMP D&A. Attributable NPAT uses the issuer's property-FV/tax bridge;
inseparable ownership/impairment adjustments stay N/A. Unseparated JV FV can
remain in EBIT/EBITDA. Verified basic/diluted unit counts replace mis-mapped
provider counts, but adjusted diluted EPS requires a new dilution review and
is not fabricated. Other income-statement rows remain explicitly reported,
not a restated GAAP statement.

Statutory CFO already excludes noncash FV. FCF deducts cash investment-property
and PPE additions, without adding FV again; FY2026 is HKD6,527m. This is before
financing-classified interest, not distributable equity cash. Core cash totals
and the cash bridge reconcile; unreviewed breakdowns remain N/A. Original
provider statements/cadence, eight hashed official reports and period-specific
adjustment provenance are saved. The native FMP source review reads the original
archive and separately guards the reviewed historical overlay; native forecast
defaults, API valuations and reported-basis F-score are unchanged.

The 325-stock isolated-tag scan and six reviewed false-positive categories are
saved in `cache/property_fv_coverage.json` and `cache/property_fv_reviews.json`.
The 19 subsequent gaming-universe additions are explicitly `NOT_REVIEWED`,
with no response hash or claimed tag-scan evidence; all 344 listings are indexed.
ASR's apparent FV tag was verified against the SEC filing: it is an acquired
property's closing valuation component after FX, not a P&L gain. Missing tags
are never treated as zero; unsupported stocks/periods remain reported.
See [calculation/source details](FMP_CALCULATION_MODELS.md).

The company price chart supports FMP's nine daily indicators (SMA, EMA, WMA,
DEMA, TEMA, RSI, ADX, Williams %R and standard deviation), independently
selectable with 1–500-session lookbacks. Actual date and closing-price bases
must match. No interpolated history, zero-filled warmup or rescaling of
mismatched bases is allowed. Available indicator dates and saved capture times
are shown: actual FMP coverage can be shorter than the twenty-year price cache.

US screener P/B, current ratio, cash/assets, liabilities/assets, ROE and ROA are
rebuilt from the same saved, dated statements used in company analysis, for all
230 listings including USD reporters. Missing or zero denominators remain N/A,
never an assumed one-dollar equity/liability balance or a capped outlier.
P/B uses market capitalization over closing reported parent equity; ROE/ROA use
the shared TTM/beginning-balance return engine. Historical FX applies where
required. `node scripts/usd_financials.cjs --market-ratios` refreshes only these
six ratios and their provenance, without rebuilding DCF assumptions, forecasts,
saved scenarios or native FMP models. The main generation pipeline runs it
before publishing its outputs.

Empty HK news coverage is explicit. Users can separately select six verified
same-issuer US/OTC listings; articles retain their original FMP symbols and are
not relabelled as dedicated HK feeds. The selection survives language changes;
saved headline translations and response caches are reused. Fair Value, FMP
DCF and FMP Levered DCF each have an adjacent `(price / valuation − 1) × 100%`
market-premium column, matching the saved-target comparison: red
`Overvalued +X.X%` or green `Undervalued -X.X%`, with Traditional Chinese labels
`高估` / `低估`. Display uses one decimal; sorting retains full precision.
Missing or nonpositive valuations/prices show N/A, not a misleading premium
against zero/negative equity values. The redundant standalone Fair Spread %
column is removed; company-model premiums and under/overvaluation filters remain.
Banks/insurers retain financial
fair values while corporate DCF references/differences are Not applicable.

`scripts/build_hkex.cjs` compiles genuine protected FMP captures into separate
`hk_market_dcf.json`, `hk_market_data.js`, `hk_fcff_data.js` and per-company
statement/price caches without rebuilding the US universe. The isolated
`cache/fx/hkd_rates.json` contains official USD-per-unit observations for the
pilot currencies: source-to-HKD rates are constructed from matching daily
observations, then averaged for flows; balances use closing rates. A quotient of
period-average USD rates or a fixed USD/HKD peg is not used. Original currencies,
periods, derivations and FX provenance remain available for audit.

Actual quarterly reporters retain quarters. Link's reported H1 and full-year
statements produce a separately identified H2 by subtraction in original
currency before translation; no Q1/Q3 or half-year EPS/share counts are invented.
Matching reported annual EPS remains available at fiscal-year-end TTM.
Incomplete or all-zero provider cash-flow constructions are archived for audit,
not presented as actual quarterly/TTM cash flows; genuine annual cash flows
remain available. Annual/interim reconciliation differences are disclosed.
HKEX also offers a separate half-year view in financial statements, key ratios,
FCF/return ratios, balance analysis and per-share trends. Quarterly flows are
summed **after** each quarter's historical FX conversion; balances use the
half-year closing report. Derived half-year diluted counts are explicitly simple
averages, not issued shares or reported half-year counts. Nonadditive half-year
EPS is unavailable; genuine four-quarter TTM EPS remains available. Missing
quarters, annual-only cash flows and FX gaps are never filled.

For HKEX and HSBC, `cache/hkex_cashflow_sources.json` preserves reviewed official
FY2025/H1 2025/H1 2026 disclosures, original currency, PDF pages and SHA-256
hashes. These replace invalid FMP cash-flow rows without overwriting raw FMP
model forecasts. H2 is official FY minus official H1 in original currency;
TTM is H2 2025 plus H1 2026. Income remains quarterly while cash flow is
semiannual. Numerators, denominators and per-share trends respect each
statement's cadence. Missing breakdowns stay unavailable: pre-tax starting
profit is not net income, combined D&A/impairment is not pure D&A, and HSBC's
net PPE/intangible investment is not gross purchases or distributable bank FCF.
Cash opening/closing balances are not summed. HSBC flows use each half-year's
historical average FX and cash balances use their own closing FX; translated
HKD cash totals need not reconcile without additional translation differences.
Earlier FMP years remain identified separately, not silently certified.
HSBC's ordinary cash dividends are separately verified from the dividend notes
(FY2025 PDF p.304, H1 2025 p.88, H1 2026 p.90), excluding equity-capital coupons
and noncontrolling distributions. This preserves the existing bank valuation
method without substituting the larger group distribution for ordinary payouts.
FY2025 gross ordinary cash issuance is separately verified as zero for F-score
criterion 7: the USD4,096m combined issuance cash flow equals capital securities
issued entirely in other equity instruments (annual report PDF pp.267/270);
employee-plan shares are a noncash transfer within equity. Note 32 and footnote 6
(PDF pp.269/342/343) identify the ordinary-share movements and AT1 issues.
This does not imply zero issuance in other periods or a current-TTM score.

`cache/hkex_balance_classifications.json` records HKEX's official current and
non-current classification for all five year ends 2021-2025 plus 2026-06-30.
Each period cites its own official report/comparative: Annual Report 2022
(2021, PDF p.137), Annual Report 2023 (2022/2023, PDF p.139), Annual Report 2025
(2024, PDF p.145), and Interim Report 2026 (2025/2026-06, PDF p.58).
All component subtotals and the accounting equation
must reconcile; changed provider total assets/liabilities/parent equity block
reuse pending review. The original provider rows are archived. Financial assets,
derivatives, participant deposits and Clearing House Funds retain their actual
classifications. Borrowings and lease liabilities are separate and counted once;
combined receivables/prepayments/deposits and goodwill/intangibles are not
invented trade-receivable or goodwill splits. The financial table uses source
categories, links each report, restores all verified 2021-2024 detail, labels the
latest balance as a closing snapshot instead of TTM, and withholds only
unverified dates while retaining original data and overall totals. These are retrospective source corrections,
not point-in-time historical snapshots. Evidence changes invalidate prior AI
assessment freshness; retained narratives are not relabelled as newly assessed.

Both screeners show FCF / equity attributable to equity holders of the Company
between FCF/EV and FCF/market cap. This percentage uses actual TTM free cash flow
and closing `totalStockholdersEquity`, excluding noncontrolling interests,
independently of DCF model availability. The profitability table shows the same
ratio immediately after FCF growth, using each displayed period's cash flow and
closing parent equity. Missing cash flows, FX gaps and zero equity remain N/A;
negative equity is not treated as a positive-return signal. Full-year cash flow
is not substituted for missing TTM or interim cash flow.

HKEX forward P/E is independent of DCF availability. It uses the next fiscal
year-end analyst consensus EPS, converted from the reporting currency to HKD
using a common-date official closing FX observation no older than 14 days.
Historical consensus/reporting scale and implied ordinary-share scale are
checked before use; a missing FY1, loss forecast, ambiguous estimate, ADR-unit
mismatch or missing FX remains unavailable. The source record and bilingual
tooltips preserve the fiscal year, EPS, FX date and analyst basis across the
screener, overview and peer table. Analyst EPS definitions (basic/diluted and
adjusted/GAAP) are not independently certified and must not be confused with
the issued-share denominator used for DCF.

HKEX Piotroski diagnostics compare nine actual statement-based criteria,
including CFO (not FCF), changes in ROA/leverage/liquidity/margin/turnover and
cash common-equity issuance. Comparable TTM is preferred; otherwise the last
comparable full fiscal year is explicitly identified. Missing tests remain
unknown and the overall score is N/A, not a neutral score or automatic point.
Comparisons use original reporting currency to avoid spurious FX signals;
displayed monetary diagnostics are HKD. Standard PF tests have reduced
comparability for banks, which is disclosed.

AIA (1299.HK), Ping An (2318.HK) and China Life (2628.HK) have a separately
labeled **applicable-items score**, respectively **5/8, 6/8 and 7/8** in the
current cache, not a standard nine-test Piotroski score. Their official
consolidated statements do not supply current/non-current totals suitable for
the liquidity-improvement test. `cache/pf_applicability.json` records the
reviewed statement-date window, official PDF pages and document hashes.
Criterion six is **Not applicable**, not an automatic pass, zero or missing
extraction to be estimated. No normalization to /9 or standard health band is
applied; the leverage-category denominator is two. Other genuinely missing
criteria still prevent a complete applicable-items score. The exclusion does
not automatically extend to other insurers or unreviewed future statements.

Economic Moat is a separately labeled AI qualitative assessment, anchored to
dated financial evidence and the latest available earnings-call transcript.
Every numeric assessment must cite supplied evidence IDs. Narratives are
qualitative only: generated numerical/currency claims are rejected; verified
financial amounts and dates are shown separately by the financial interface.
Missing analysis
does not produce neutral 5/10 scores. Financial/call content hashes, original
assessment timestamps and separate check timestamps distinguish new evidence,
unchanged evidence and retained stale/error states. Transcript dates alone do
not count as transcript analysis.
Partial assessments display earned points over the assessed maximum, with the
dimension coverage: e.g. `72 / 90`, not `N/A pt`, zero-filled `/100`, a normalized
percentage or a complete overall moat grade. PF health comments use the same
strong/moderate/weak/unavailable categories in both markets; statement freshness
and annual fallback provenance are separate from financial-health labels.
An unknown dimension is labeled **Not assessed**, without a zero-score bar.
Category subtotals retain assessed dimensions and their coverage instead of
discarding the category or assigning missing dimensions zero points. The
diagnostic table scrolls horizontally on narrow screens. These presentation
changes do not regenerate assessments or alter their source timestamps.

### FMP company data and editable valuations

Non-bank/non-insurer companies default to FMP Custom DCF Advanced, with a
separate Custom DCF Levered model. Defaults and model rows come from FMP, not
invented analyst forecasts. They are vendor projections/extrapolations, not
necessarily issuer guidance or analyst consensus. Site custom per-share values
divide vendor equity value by verified outstanding common shares, excluding
treasury shares; A/H companies use all ordinary classes. Vendor diluted-share
values remain separately identified. The two additional screener references,
DCF Valuation and Levered DCF, retain the vendor's direct per-share values.
Existing bank/insurance models are preserved. The old non-FMP FCFF workspace is
no longer exposed; its calculation/source modules remain for audit and regression
coverage. Missing coverage, unverified currency and missing issued
shares remain explicitly unavailable.

FMP's native ten-row response includes historical and projected rows; it does
not support independent ten-year arrays through the scalar override API.
The separate, explicitly labelled **ten-year custom scenario** uses the annual
FMP `analyst-estimates` feed for available consensus revenue/EBITDA, rather than
the prebuilt DCF model's historical-average operating forecasts. Missing
consensus CapEx, CFO and D&A use their **latest complete FY amount/revenue
ratios**, explicitly labeled actual-ratio carry-forwards, not analyst forecasts.
Only **change in NWC/revenue** uses a five-consecutive-FY arithmetic average.
This single input replaces the three receivables/inventory/payables ratios.
Positive NWC increases consume cash; historical amounts reverse the sign of
FMP's cash-flow working-capital cash impact, including other operating working
capital. The CFO model does not deduct working capital again.

Beta, risk-free rate, risk premium, debt cost, debt/capital and existing
equity-cost settings are unchanged; later years retain the last native capital
inputs. These settings are not labeled analyst consensus. Other missing
forecasts, operating tax and terminal growth remain N/A, with no invented
ten-year revenue/margin extension. Incomplete assumptions cannot produce or
save a new valuation, but their full inputs/reasons remain downloadable.
Consensus security identity, fiscal dates, reporting-currency scale and FX
are checked before use; per-metric analyst coverage/adjusted-GAAP definitions
are not independently certified. Each field distinguishes consensus, actual
ratio, working-capital average, retained capital setting, derivation, missing
input and user override. EBIT,
EBITDA and D&A stay linked; Advanced uses after-tax EBIT plus D&A once, whereas
the CFO model never adds D&A again. Annual capital costs produce annual WACC and
compound discount factors. Net debt is a separately editable snapshot deducted
once; projected cash is disclosure, not an extra terminal-value add-on.
The snapshot must agree across native source years; a varying/absent net-debt
basis blocks default construction pending review, rather than treating year-ten
debt as current debt. Negative terminal cash flows/equity are retained for audit
with an explicit economic-interpretation warning, not claimed to be tradable
negative prices.

Galaxy's reviewed FY2018-FY2025 and H1 2011-H1 2026 revenues use issuer
consolidated revenue **before gaming tax**, correcting incompatible FMP
classifications. FY2025 revenue is HKD49,242.325m, not HKD29,591.615m; official
growth is +13.3770%. Reviewed operating-cost lines across those periods
also support consistent core operating income/EBITDA, not adjusted EBITDA.
H1 2017 is the published restated comparative; H1 2011-H1 2016 commissions
remain a separately deducted expense rather than being silently netted against
revenue. These accounting presentations are not automatically like-for-like.
Unreported gross profit remains N/A. Original provider income is
archived; native FMP models and saved user targets are not rewritten.
New site scenarios use the corrected official revenue baseline and actual
ratios. See `FMP_CALCULATION_MODELS.md` and `cache/hkex_revenue_sources.json`
for sources, scope and targeted cache regeneration.

Sands China's reviewed FY2018-FY2025 and available H1 history also use official
consolidated income statements, recorded in `cache/hkex_gaming_revenue_sources.json`.
Its reported net revenue is already **before gaming tax**; that tax is not added
again. FY2025 income-statement D&A is USD792m and reported operating profit is
USD1,231m, giving core operating EBITDA of USD2,023m, **not adjusted property
EBITDA**. Officially unreported gross profit remains N/A. USD historical flows
and Japanese gaming-company evidence can use dated HKD cross rates from 2010,
including JPY; existing cached HKD/CNY observations are preserved.
The wider HK gaming-universe review and additional listings are still pending;
captured primary reports alone do not certify a company's figures.

Ten-year percentage inputs display two decimal places without rounding the
underlying source/entered precision; tooltips and the JSON calculation download
retain exact values. A separate actual full-year reference column uses the
exact baseline financial period, not a historical vendor-model row or fabricated
TTM. It shows ratios and monetary amounts, with FY-end balances, actual-source
labels and historical FX. Missing breakdowns/capital-cost history stay N/A.
Historical effective tax is distinguished from forecast operating tax.
Reviewed Link references use the report's CFO and full property/PPE cash additions,
without silently rewriting FMP forecasts or the calculation baseline.

Both model modes provide a JSON calculation download containing vendor rows,
override parameters, denominator/source metadata, native identity residuals,
and (in ten-year mode) all annual inputs, formulas and results.
[FMP calculation models](FMP_CALCULATION_MODELS.md) explains the separate methods,
known source discrepancies, independent Decimal audit, and an editable
formula-based Excel export requiring only Node and Python's standard library.

Legacy saved scenarios retain their operating forecasts and tax assumptions.
Their three NWC component ratios convert to mathematically equivalent annual
change/revenue inputs in memory, with originals retained in the download and
no automatic changes to stored targets. The local model is not an original
FMP API result.

Save recalculates pending native overrides first and persists only a successful
result; failures cannot overwrite an existing target. Native and local scenario
edits are isolated. Saved local models retain all ten-year inputs and provenance,
reload in their original mode, and supply the homepage target, including zero.

Run `node scripts/capture_company_data.cjs` with `FMP_API_KEY` to refresh the
325-company snapshot, or pass comma-separated symbols for a limited refresh.
This also refreshes separate annual analyst estimates and approved actual-ratio
defaults for supported nonfinancial companies. Existing captured valuation
sources can be imported without credentials or new financial/API-model calls:
`node scripts/import_analyst_sources.cjs CAPTURE_DIRECTORY [CAPTURE_DIRECTORY ...]`.
Only analyst/forecast-actual metadata is added to detailed company caches;
native model data and financial statements remain unchanged.
`fmp_model_data.js` contains only screener model summaries; detailed models,
dated news and supported ownership disclosures load from `cache/company/`.
13F holdings are not a complete HK share register. Missing holders, insiders,
news or split coverage are not fabricated.

The same server-side key must be configured in the Vercel environment for
`api/fmp.js` to calculate custom scenarios and paginate company news. Never put
keys in browser assets. For local use, place credentials in ignored
`.env.local`, build with `node scripts/build_site.cjs`, then run
`node scripts/serve_preview.cjs` (loopback port 57102). A static-only preview
cannot execute the API.

Chinese company-news headlines use saved exact-title matches in
`cache/news_translations.json`. The original headline and article link remain
available; translations are labelled AI Traditional Chinese, not official
Chinese articles. Untranslated titles and cache failures remain explicitly
original-language. Browsing and language switching never call Vertex. The manual
read-only `translate_news` audit job uses Gemini 2.5 Flash-Lite, skips saved
titles, atomically preserves completed batches and exports token usage.
`scripts/apply_news_translations.cjs` validates and imports its artifact; it
cannot change source headlines or overwrite a different saved translation.
No automatic translation schedule or deployment is enabled by this path.

### Vertex AI reassessment

`scripts/refresh_hkex_moat.py` uses Vertex AI. It accepts the existing
`GCP_SA_KEY` environment secret, or standard Application Default Credentials via
`GOOGLE_APPLICATION_CREDENTIALS` / `GOOGLE_CLOUD_PROJECT`. The latter also
supports local user ADC without creating a service-account private key;
authentication and appropriate project permissions must already be configured.
`GOOGLE_CLOUD_LOCATION` defaults to `us-central1` for ADC. Credential files must
remain outside the repository and published assets.

An assessment-policy change triggers reassessment even if financial evidence
has not changed. `--retry-incomplete` additionally retries partial reports.
All new scores still require cited evidence and bilingual qualitative comments;
insufficient evidence may legitimately remain unassessed. Failed authorization
does not count as a successful refresh or replace prior reports with invented
scores. A Vertex Express API key is a separate authorization path; a blocked key
is not silently rerouted to the Gemini Developer API.

`scripts/research_hkex_moat.py <input> <researched-input> <research-output>`
can first collect attributable issuer/business evidence through Vertex AI
Google Search grounding. It separates research from structured scoring,
preserves source links, grounding supports, search queries and the unmodified
Google Search Suggestions HTML, and validates issuer identity and the research
hash. Valid saved research is reused without another search. Researched
assessments use the distinct `researched-business-judgment-v4` policy; the
response schema limits citation IDs to actual supplied evidence. Supported weak
moats may receive low qualitative scores rather than being mislabeled unknown;
genuine essential gaps still remain unassessed. The rating page displays scores,
bilingual comments and a short AI-judgment limitation, without website citation
lists, the research-source drawer, Google Search Suggestions or the raw research
narrative. The verdict header shows only the assessment update date, without
financial-period metadata, timestamp precision or evidence hashes. Missing
update dates remain N/A rather than using the statement date as a substitute.
Source links, research, grounding metadata and provenance remain in the saved
cache for auditing; no scores or evidence are discarded. Research is explicitly dated
and may include sources published after the financial statements, not
point-in-time history.
Saved research, financial hashes and assessment policy determine cache reuse.

The read-only `valuation_audit.yml` workflow accepts `build_hkex=true` and
`force_moat=true` to regenerate all configured HKEX assessments with GitHub Secrets, without
committing data or invoking a deploy hook. Download its `hkex-pilot-data`
artifact and run `node scripts/apply_hkex_moat.cjs <assessment-json-path>` to apply
only matching reports locally. This refuses mismatched evidence hashes or failed
assessments and preserves financials, quoted prices and valuation inputs.
Applying a validated subset merges those cache entries without deleting other
companies' reports.

Link's rental FCFF scenario uses the matching official complete annual operating
components in `cache/hkex_valuation_reconciliations.json`, not the unreconciled
provider half-year cash-flow construction. Raw financial tables and historical
reported-multiple inputs are retained separately. Net property income less
corporate expenses excludes property fair-value changes, noncash impairment,
interest and joint-venture profit. Cash reinvestment includes investment-property
additions as well as PPE; disclosed new ROU assets are actually nil, not assumed
missing zeros. All disclosed operating balances, including noncurrent deposits
and provisions, form an explicit working-capital proxy; financing and cash-capex
accruals are excluded to avoid counting them again.

The financing waterfall retains the annual financing-liability rollforward,
including NCI shareholder loans and net financing derivatives at book proxies.
The approved zero NCI **equity** scenario does not cancel those loans. Only
unrestricted cash and the joint-venture book proxy are added; rental properties
are not added again. Kd uses cash interest over average book financing claims,
an adjustable historical proxy, not marginal borrowing cost. Quoted capital
separately retains total reported cash and reported NCI book equity.

Only analyst **revenue** remains a consensus anchor in this rental scenario.
EBIT and D&A use constant normalized rental margins and are explicitly labeled
model assumptions; original consensus profit measures remain in the data.
Component terminal reinvestment retains property cash capex net of D&A and
incremental operating working capital, instead of assuming property maintenance
equals accounting depreciation. This remains FCFF/WACC, not AFFO, DDM or NAV.
Rent, occupancy, reinvestment and capitalization-rate risks still require
scenario analysis; removing noncash revaluations does not remove economic risk.

Official reconciliation records include the PDF hash, page references and
approval/document-modification dates, **not** certified point-in-time publication
evidence. They apply only to the exact reviewed financial-content fingerprint
and model period. Changed statements require fresh review; unrelated source/FX
failures remain blocking. Original annual/interim discrepancy warnings are not
erased: the Link model uses independently reconciled official annual components
rather than treating those provider discrepancies as resolved.

Tencent also uses issuer-specific official components: FY2025 minus H1 2025 plus
H1 2026 reconstructs TTM. H2 is derived in CNY before each half is converted at
its own historical average FX; individual quarterly components are not invented.
Cash investment includes PPE, intangibles and land, plus actual organic ROU
additions. Acquisition ROU assets are not treated as recurring lease additions.
Lease debt remains in financing and principal is not deducted a second time.
Identified capital/financial balances are excluded from the operating-capital
proxy; disclosed noncurrent royalty balances, cash-settled employee awards and
deferred revenue are included, not mislabeled financial claims. Unclassified
long-term other balances are not certified nonoperating additions. Investment
book proxies are net of other financial
claims, not certified realizable values or tax-adjusted disposal proceeds.
Kd annualizes the latest half-year interest over matching average financing
debt; it is not TTM interest or a marginal borrowing quote.

HKEX uses complete FY2025 cash-flow components, **not current TTM**. Client margin
and clearing assets/liabilities are excluded together; participant balances and
gross derivatives are not shareholder cash or investments. The operating and
required-capital proxy includes own clearing capital and regulatory reserves.
Cash capex includes HQ payments; only actual new leases from the financing
rollforward are added, not total ROU additions. Corporate portfolio income is
excluded before adding available portfolio assets. Future portfolio income and
facility commitment fees use disclosed FY2025 proportions of analyst aggregate
revenue: explicitly labeled model adjustments, not direct analyst consensus.
Other financial claims are deducted from the investment book proxy.

Alibaba uses complete official FY ended **2026-03-31**, not current TTM assembled
from inconsistent quarterly/annual licensed-copyright amortization scopes.
Published quarters remain in the financial/history tables. Model EBIT removes
goodwill impairment and property-disposal gains but retains SBC. Noncash addbacks
use the PPE/land cost and income-statement intangible amortization/impairment
lines; broader cash-flow licensed-copyright amortization is not added again.
Related film/copyright operating balances enter operating capital while their
costs remain in EBIT. US GAAP operating rentals remain expenses; operating lease
claims are not deducted again as financing debt. Paid land-use rights retain
cash-investment/noncash-amortization treatment. Buyer-protection balances are
excluded as matched pairs. Pledged treasury funds remain required capital and
are deducted once from pooled nonoperating investment value, not again from
cash. Acquisition claims, mezzanine equity and NCI use disclosed book proxies.
Sourced June-quarter quoted capital remains separate from the March annual
model; provider TTM multiples are not rewritten as normalized annual history.

These reconciliations preserve original statement tables, supported historical
periods and provider-multiple definitions rather than restating them as official
normalized history. They do not certify point-in-time historical valuations,
all balance-sheet fair values, realization taxes or analyst profit comparability.
Exact financial-content and period gates still apply to every reconciled model.

The HKEX refresh workflow checks at 07:30 and 19:30 Hong Kong time on business
days. It refreshes sources, recomputes PF from actual comparable periods and
reanalyzes moat only when financial/call content or assessment rules change. It is not an
instantaneous exchange-release feed. A protected Vercel deploy hook requests
publication of committed data; a missing hook produces an explicit warning,
not a claim that production updated.
Historical workflow reruns also check out current `main`, preserving the last
published generated data rather than rebasing a second refresh onto an old snapshot.

Official HSICS is the selected future HK classification standard, but is **not
activated**. Existing HK sector/industry labels are not certified HSICS mappings.
The [official definition](https://www.hsi.com.hk/content/dam/wpb/hsil/index_review/en_hk/B_HSICS.pdf)
uses Industry / Sector / Subsector and excludes Chapter 18B companies.
[HKEX's HSICS dissemination notice](https://www.hkex.com.hk/eng/invest/company/HsicDisclaimer.htm)
requires a licence agreement with Hang Seng Indexes Company before further
disseminating classification results. Publicly readable definitions or HKEX
lookups do not themselves grant website redistribution rights. Integration is
pending confirmation of suitable stock-level mapping coverage, public-display
and storage rights, delivery/update arrangements and fees. No free public bulk
mapping API or applicable redistribution permission has been confirmed.
Classification must remain separate from bank/insurance valuation routing.

At the user's direction, HKEX discount rates now use a dated US 10-year Treasury
**proxy under the HKD/USD peg**, not an observed HKD risk-free yield or another
stock's WACC. Company-specific beta, equity risk premium, financing, debt cost
and tax still determine WACC; financial-company models use Ke. The proxy is
disclosed in both valuation interfaces. Actual historical HKD FX conversion is
unchanged and never uses this peg assumption.

DCF, financial-company and liquidation denominators use dated
`shares-float.outstandingShares`, excluding treasury shares, **not** diluted
weighted-average shares or float. Per-diluted-share financial trend tables
retain their original accounting denominators. US captures cover all 230
listings. Provider quoted/ADR units are not multiplied again. The
company-wide A/H denominator must include every ordinary share class, not only
the Hong Kong-listed H shares. Issuer capital returns in
`cache/hkex_share_capital.json` take precedence over class-only provider counts.
CCB's official September 2026 monthly return (PDF page 3) reports
21,183,061,579 A shares and 240,417,319,880 H shares, with no treasury shares:
261,600,381,459 ordinary shares in total as of 30 September 2026. Preference
shares are not added to the ordinary-share denominator. The source URL, filing
date, document hash and class breakdown remain attached to the valuation data.
CCB retains the existing financial-company model, rather than corporate FCFF.
A return cannot be used before its filing date; conflicting later provider
counts require review instead of silently reverting to H shares. Capital
returns require maintenance as new filings become available: their dates are
not relabeled as current quote dates. Link's corresponding denominator is
outstanding fund units. Explicit, confirmed user share scenarios remain
labeled and saved separately.

ICBC and Bank of China's September 2026 official returns now also establish
issuer-wide ordinary denominators: **356,406,257,089** for 1398.HK
(269,612,212,539 A plus 86,794,044,550 H) and **322,212,411,814** for 3988.HK
(238,590,135,419 A plus 83,622,276,395 H), with zero treasury shares. The captured
FMP counts do not reconcile to these totals or either class. A dated,
snapshot-specific provider-discrepancy review permits these documented official
counts; changed or later conflicting provider snapshots still require review.
This fixes the share-basis N/A in their existing Excess Return + DDM scenarios,
without changing the site's declared FMP shareholders-equity/ROTE proxy or
claiming an audited ordinary-common-equity valuation. Preference **share
counts/nominal capital** are excluded from the ordinary denominator; this is
distinct from the existing model's choice not to separately deduct preference
**equity** from its tangible-equity proxy, disclosed on the valuation page.
The optional custom share-count panel distinguishes source-default, active
custom-scenario and unavailable-source states. Source-default shares apply
automatically; its checkbox authorizes only a manual scenario override, not
verification or acceptance of the company's disclosed shares.

### HK market metrics and refreshed Moat coverage

All 26 configured mixed-class issuers now have reviewed September 2026 monthly
returns in `cache/hkex_share_capital.json`. Coverage follows each issuer's actual
ordinary classes, including Haier's A/D/H shares, domestic/unlisted classes and
Hong Kong/RMB classes; it does not assume every issuer is A/H. Each class's
treasury shares are explicitly excluded. The dated returns are references,
not certification that shares remained unchanged after September month-end.
Provider discrepancies are reviewed only for the exact captured count/date;
changed or later mismatches remain blocked.

Trailing P/E prefers supported reported diluted TTM EPS. When semiannual EPS
cannot legitimately be added, it uses compatible actual TTM earnings
attributable to ordinary holders divided by dated current ordinary shares,
explicitly labeled rather than misrepresented as reported diluted EPS.
Disclosed preferred distributions are required where applicable. P/B uses quoted
price divided by reported parent equity per verified ordinary share; this
existing book-equity proxy does not separately deduct preferred equity.
The same share sources feed liquidation and financial-model per-share references,
without changing native FMP projections or capital-cost assumptions.

The saved 114-company dataset has 113 trailing P/E ratios, 113 P/B ratios and all
114 liquidation I/III values. Century's stale last trade is not a current quote;
International Entertainment's explicitly reported twelve-month second interim
supplies current twelve-month earnings without adding the overlapping first interim.
HKEX liquidation II still lacks required reported inputs. These remain explicit
N/A rather than invented prices, earnings or zero balances.

Nonfinancial HK trading multiples are independent of DCF availability. Their
`reportedMultiples` source records compatible actual income dates, separately
converted TTM EBITDA, dated reported capital and per-metric gap reasons.
Reported debt includes listed leases; quoted EV includes preferred and
noncontrolling book proxies, without substituting scenario adjustments.
Missing cash-flow forecasts do not erase supported income-based multiples.
A genuine twelve-month second interim is used once, without overlapping H1.
Zero/negative EBITDA remains N/A with an explanation; negative net debt with
positive EBITDA remains a valid net-cash multiple. A stale quote blocks EV,
not independently supported dated debt/net-debt multiples. These sources are
shared by the screener and valuation reference; DCF inputs are unchanged.

HK peer comparisons instead use **each company's latest reported full
twelve-month fiscal year**, with the exact FY-end date shown in its column.
Income, cash flow and balances must match that fiscal year; no interim, TTM or
older cash-flow substitute fills a missing field. Every financial amount,
margin, growth rate, P/E, P/B, cash-dividend yield and debt multiple uses this
annual basis. ROE/ROA retain the shared beginning-balance convention; the
labeled ROIC estimate retains its 21% tax proxy. Quoted price, market cap and
the qualitative Moat assessment remain current references; EV combines current
market cap with matching FY-end reported capital. Forward P/E/P/B are omitted
from this annual-only HK view. US peer comparisons and other pages retain
their existing bases. Failed annual loads show an explicit retry state, never
a TTM fallback.
Annual cash dividends recognize the canonical `commonDividendsPaid` and
`commonStockDividendsPaid` fields as well as the existing total-payment aliases.
Explicit common-share payments take priority; total payments are used only
when reported preferred equity is zero. A reported zero distribution displays
0.00% when current market cap is available; missing payments never become zero.
Annual growth tooltips distinguish nonpositive prior bases, missing fields,
nonconsecutive periods and incompatible accounting/currency bases. A missing
gross-profit field is not mislabeled as a failed statement download.
HK annual peer growth displays "Positive to negative" / "Negative to positive"
(正轉負 / 負轉正) instead of a percentage when two verified comparable full
fiscal years strictly cross zero. This is a display-only classification; stored
growth calculations and DCF assumptions are unchanged. Zero endpoints,
negative-to-negative results and missing or incompatible source data retain
their existing growth rules.

The five financial-correction-invalidated Moat assessments and all 19 gaming
additions have now been independently reassessed with Vertex AI using matching
financial evidence and attributable business research. All 114 companies have
ten scored dimensions and bilingual comments; the other 90 assessments retain
their original dates. These scores are qualitative AI judgments, not issuer
measurements. Exact artifact-run provenance is saved with the 24 new cached
assessments. Stale-report archival safeguards remain active for future changes.
The additions' saved annual income, balance-sheet and cash-flow tables are
included in the local site build; missing compatible interim/TTM disclosures
remain unavailable, not replaced with annual amounts.

Unreconciled IFRS leases, debt composition and missing mandatory inputs still
block automatic fair values. Editing financial assumptions does not silently
certify issuer evidence. Confirmed financing scenarios may specify lease debt,
the cash-flow-matched lease exclusion and opening NWC; the source snapshot stays
unchanged and the resulting value is labeled as user-assumed. The same controls
apply to US and HKEX stocks. The general corporate FCFF model can be used for
Link with an explicit REIT warning; it is not a dedicated AFFO/NAV model, and
nonoperating asset/priority-claim assumptions require review.
When Link has no valid observed effective tax rate, its user-approved forecast
scenario starts at Hong Kong's 16.5% statutory rate. This adjustable assumption
is disclosed beside the model status and tax control; it is neither a reported
group effective rate nor a jurisdiction-weighted forecast. Existing observed
rates, historical tax tables and unrelated companies are unchanged. This tax
scenario does not clear lease, investment-property or priority-claim guards.
For Link's negative reported noncontrolling equity, a separately user-approved
zero-value claim scenario is adjustable and explicitly **not verified fair
value**. A positive actual claim would make this scenario overstate common
unitholder value. The original book balance remains in financial history and
quoted book-based multiples; the scenario applies only to model capital costs
and the common-equity waterfall. Nonnegative observed balances are not replaced.
This equity-only scenario does not waive shareholder loans or other financing
liabilities, whose source reconciliation remains separate.

When HKEX cash flow is annual-only, the valuation may use the latest complete
aligned annual dataset, explicitly **not current TTM**. Unknown interim cash
flows are not treated as reported zero; first-year unreported flows use the
existing uniform-day modeling assumption. Current trading multiples do not
borrow annual cash flow to fabricate current TTM. The forecast scale check
uses the latest matched annual revenue; older forecast/actual differences are
retained in provenance rather than automatically being called currency errors.
HSBC's payout fallback explicitly identifies its latest reported annual period.
Universe coverage does not certify an automatic numerical fair value for every stock.
No historical DCF track or score history is fabricated.

Quoted metrics are independent of fair-value eligibility. Quoted EV uses market
cap + reported total debt − cash/short-term investments + preferred and
noncontrolling book proxies. It includes reported leases and does not subtract
unverified nonoperating long-term investments. The modeled equity waterfall
separately uses FCFF-matched financing debt and adjustable nonoperating assets.
Discounting periods show dates, stub timing and elapsed years; discount factors
separately show WACC, exponents, factors, cash flow and present-value arithmetic.

Validation includes `tests/hkd_currency.test.cjs`,
`tests/statement_scores.test.cjs`, `tests/hkex_sources.test.cjs`,
`tests/hk_frontend.test.cjs`, `tests/test_hkex_moat.py` and
`tests/hk_real.browser.cjs`. The optional `build_hkex` source-audit input
produces review artifacts only; it does not merge or deploy them.

## Read-only valuation source audit

The manually dispatched `valuation_audit.yml` workflow captures dated FMP profile,
quote, eight quarterly statements, up to five annual statements, annual analyst estimates, enterprise values and
Treasury evidence using the existing protected API secret. It uploads a seven-day
artifact, records HTTP/coverage limitations explicitly, and never updates or
commits valuation datasets. This is source evidence, not certification of the
website's assumptions or financial methodology.

The annual statements support fiscal-year and analyst-forecast reconciliation.
The selected FCFF operating-ratio basis is the latest TTM, not a three-year
average. The extra balance-sheet quarter supports a period-matched opening debt
balance; no missing period is replaced with a current balance.
The optional `lease_sources_only` input captures original balance, income and
cash-flow tags to reconcile operating versus financing lease treatment, still
without changing any published valuation.

## Archived FCFF engine and explicit source limitations

This section documents the retained legacy engine and its former interface for
audit purposes, not the current valuation workspace. Nonfinancial company pages
now use the native FMP models or the separately labelled ten-year scenario
described above; legacy FCFF controls, saving and sensitivity tables are removed.

The nonfinancial valuation page, screener defaults, forecast table, sensitivity
matrix and versioned saved scenarios use `fcff.js` with the shared
`dcf_drivers.js` operating-driver engine.
`scripts/fcff_sources.cjs` reconciles source records; `scripts/build_fcff.cjs`
compiles `cache/fcff_sources.json` and `fcff_data.js` without rewriting reported
financials, financial-company models, liquidation values or price history.
These repository changes do not themselves deploy the website.

The general-company page provides seven assumption categories: revenue/EBITDA,
capex, working capital, D&A, tax, discount rate and terminal value. Full-year
amounts and ratios can be edited separately for each of ten fiscal years.
Available numeric input fields display two decimal places. Untouched source
and saved values retain their underlying precision; input display formatting
does not round the valuation, including beta and valuation share counts.
Clearing an annual override restores the source/model default for that field.
TTM is the starting operating-ratio basis. Available historical ratios can be
explicitly selected instead, with the actual number of observations disclosed.
Historical NWC ratios use each quarter's own matching LTM revenue; closing
balances are never added across quarters.

FMP `revenueAvg` / `ebitdaAvg` are consensus anchors when available. Missing
EBITDA is explicitly derived from analyst EBIT plus modeled D&A. Default D&A
uses a nonnegative analyst EBITDA-minus-EBIT spread when both are available;
otherwise it uses the TTM cash-flow D&A ratio. This is a derived assumption, not
an independent analyst D&A forecast. The ratio-only D&A option is also available.
YTD operating EBITDA is reconstructed from reported operating EBIT plus
cash-flow D&A. Analyst adjusted/accounting definitions are not independently
certified to match those actuals or Finbox. Beyond actual consensus coverage,
growth/margins fade to disclosed long-term assumptions, or the user can select
flat scale/margins. Forecast revenue growth and terminal growth are separate.
First-year growth uses aligned reported annual revenue when available;
otherwise its prior-year analyst reference is explicitly identified, not
presented as a reported actual.
No screenshot values or Finbox branding are copied into stock defaults.

Reported debt is preserved separately from the lease adjustment and valuation
financing debt. A verified lease liability whose payments remain in forecast
cash flow is not deducted again; both WACC and the equity bridge use the same
adjusted financing debt. Unreconciled lease cash flows, debt composition or
missing financial inputs return explicit reasons instead of assumed prices.
Financing treatment also requires consistent lease expense, depreciation and
new leased-asset reinvestment inputs; balance-sheet lease debt alone is not
enough to certify that reconciliation.

Missing inputs and conflicting normalized/original lease mappings produce
explicit bilingual N/A reasons, not legacy fallback prices. The source cache
records individual valuation dates and coverage outcomes; availability is not
certification of forecasts or issuer lease accounting. Some issuers require
segment valuation instead of this general FCFF model.

The horizon consists of ten fiscal-year columns, not ten calendar years plus
an extra fiscal bucket. Reported YTD revenue, EBITDA, D&A and capex are removed
from the first full-year forecast; remaining unreported flows are allocated
uniformly by day and elapsed flows are excluded. Forecasts below reported YTD
revenue/D&A/capex are rejected rather than silently clipped. Opening NWC at the
valuation date is linearly estimated from the last closing balance to the
first annual target. This is a scenario allocation, not known actual cash flow.

Actual/365.25 cash-flow discounting defaults to the midpoint of each remaining
period; period-end timing is selectable. Supporting schedules expose starts,
ends, precise UTC discount dates, years and factors. Gordon terminal value
always uses the tenth fiscal year-end factor, never the mid-year factor.
Terminal revenue already includes one year of growth: its resulting FCFF is
divided by WACC minus g without a second growth multiplier.

Terminal ROIC still defaults to WACC and can be overridden: reinvestment =
next-year NOPAT times g/ROIC. Alternatively, normalized EBITDA, D&A, capex and
incremental NWC explicitly construct next-year FCFF. Component scenarios with
positive growth but nonpositive net reinvestment are visibly flagged for
sustainability review, not independently certified. Low/base/high cases share
the same operating forecast and shift WACC by +0.5/0/-0.5 percentage points and
terminal g by -0.5/0/+0.5 points; they are not probability intervals.

The supported historical cash flows/consensus anchors remain viewable as
provisional modeling support when lease reconciliation alone blocks valuation;
no fair value, present value or saveable target is manufactured in that state.
Only actual supplied annual history is shown (the current earlier capture has
four annual periods, not five). Missing annual cash flows stay N/A. Subsequent
protected capture requests five annual periods without fabricating gaps.
Future FX is a constant latest-observed scenario. Forecast reporting currency is
inferred using historical annual revenue scale, not an explicit FMP estimate
currency field. Tax and debt costs start from historical TTM proxies, while ERP,
terminal growth, nonoperating assets and priority-claim values remain adjustable
assumptions. Blank terminal ROIC follows each sensitivity cell's WACC.
The legacy nonfinancial `fair_val` fields in the old market-generator output
are not consumed by the website's new general valuation path; the independent
FCFF cache and shared engine are authoritative for that path. Financial-company
models retain their existing methodology and limitations.

The Profile beta is the unaltered FMP Profile value, including genuine zero or
negative values. The response does not specify lookback, frequency or benchmark:
it is not labeled "5-year beta". The valuation input permits a manual scenario,
not a 3/5/10-year selector or a claim of provider-supplied period-specific betas.
Legacy FCF scenarios are not loaded into FCFF; replacing a saved legacy target
archives the old record in `M7_LEGACY_VALUATIONS` before saving `fcff-v2`.
The older `fcff-v1` calendar-year/period-end scenario is not silently reinterpreted.
Saved annual overrides use fiscal dates; a rolled-out fiscal period is rejected
explicitly rather than shifted onto another year.

Normal daily refreshes capture required dated FMP evidence with the protected
secret and compile the independent FCFF cache. Dedicated peers/prices/liquidation
refreshes do not change FCFF. Failed capture retains the original source dates
with an explicit workflow warning. To compile a separately captured audit:
`node scripts/build_fcff.cjs <source-directory> [original-lease-source-directory]`.
Validate retained arithmetic with `node --test tests/fcff*.test.cjs`.
Current valuation UI coverage uses `node tests/fmp_models.browser.cjs`
(`TEST_LIVE_FMP=1` also exercises the real provider API); official-statement
coverage uses `node tests/official_statements.browser.cjs`.

## 清算價 I／II／III

三項使用獨立的最新可用季度資產負債表，並非四季餘額的 TTM 加總。
`scripts/refresh_liquidation.py` 以既有 GitHub secret 取得 FMP stable 季度資產負債表、
美元上市報價及幣別確認，將來源與實際日期保存於 `cache/liquidation_sources.json`。
所有股票抓取及驗證成功後才取代快取；錯誤、權限不足或空資料會明確中止，不填造資料。
類股代碼使用 `BRK-B`，不使用 `BRKB`。同一季度的來源修訂亦會重新取得。

`scripts/apply_liquidation.cjs` 使用共用期末 USD 匯率轉換餘額，僅更新兩份市場資料中的
三項清算值及獨立 `liquidation` 來源資訊，不變更 DCF 參數、股價或其他財務數字。
前後端共用 `liquidation.js`：I 為流動資產減總負債；II 為現金短投加貿易應收的
80%、存貨的 50% 再減總負債；III 為現金短投減總負債。II 不混用總應收或其他應收款。
三項分母均採有日期來源、不含庫存股的流通在外普通股／報價 ADR 單位，不採市值除以
股價反推或財報稀釋加權平均股數，不補 1 股，也不額外乘 ADR 倍數。
全公司 A／H 股數未核實時保留 N/A；資產負債表、股數及報價日期分開揭露。

篩選表逐格顯示財報日期；提示包含報價日期、股數、期末匯率與擷取時間。
特別股帳面值不等於實際清算求償額，因此保留原本未扣優先權的簡化公式，
以 `*` 及中英文說明揭露有特別股／資料不完整；不宣稱為普通股可分得金額、
保證底價或正式清算鑑價。三項均未扣清算費及稅。缺少必要欄位或匯率時僅將
受影響的值列為 N/A，顯示原因，不回退到舊季度、補零或套用 DCF 現金。

每日流程及手動 `liquidation_only=true` 均更新來源與清算值。專用更新不執行
一般市場／DCF 重算、同行或歷史價格更新；匯率仍先更新以涵蓋新財報日。
專用來源更新失敗會明確失敗；一般每日流程則警告並保留已註明日期的舊清算快取，
不阻斷獨立的財務資料更新，也不將舊快取重新標成最新擷取時間。
完整市場產生器亦套用已註明日期的獨立快取，不再從永久財報快取重建清算值。
驗證：`node --test tests/liquidation.test.cjs`、
`python -m unittest discover -s tests -p test_liquidation.py`、
`node tests/liquidation.browser.cjs`。

## Profile 歷史股價與成交量

每檔股票的 Profile 最上方提供獨立的真實日收盤價與成交量圖，支援
3／6 個月、今年至今、1／3／5／10 年、全部可用、自訂日期、雙端範圍控制、
鍵盤瀏覽、所選資料 CSV 下載及瀏覽器全螢幕，並沿用中英文及深／淺色模式。
期間報酬使用區間首末實際收盤價；今年至今以可用的上年度最後收盤價為基準。
CAGR 依實際相隔日數／365.25 年化，不足 365 天或僅有一筆資料時不計算。
滑鼠提示和日期欄保留實際交易日，週末及休市日不補造價格或成交量。

獨立的 `scripts/refresh_price_charts.py` 透過現有 GitHub secret 呼叫 FMP stable
`historical-price-eod/full`，將資料寫入 `cache/price_charts/{ticker}.json`。
使用供應商拆股調整後收盤價，不包含股息再投資；成交量保留供應商口徑，
缺少成交量時仍可顯示真實股價，成交量不補零。「全部可用」最多為最近 20 年，
並非宣稱自上市日起的完整歷史；上市較短或來源涵蓋不足時，明列實際可用範圍。
美股上市報價本身為 USD，不套用財報幣別匯率，也不混入 DCF 公允價值。

每日更新及手動 `prices_only=true` 均更新價格；`peers_only=true` 不更新價格。
每檔拆成兩個最多十年的非重疊請求，避免供應商單次 5,000 筆限制。
每天重新抓取整段資料，以反映供應商拆股調整的歷史修訂。所有公司取得且驗證成功後才取代快取；
權限、格式、重複日期衝突及網路錯誤會明確中止，不將錯誤視為空資料或破壞既有歷史。
來源合法回傳空清單時顯示不可用；載入失敗可重試。價格更新不修改財報、市場快照或 DCF 參數。
價格專用更新失敗會明確失敗；一般每日流程則發出警告、保留已註明日期的價格快取，
繼續獨立的財報更新，不讓新增圖表服務中斷既有金融資料排程。

驗證：`node --test tests/price_history.test.cjs`、
`python -m unittest discover -s tests -p test_price_charts.py`。
實際瀏覽器檢查：`node tests/price_history.browser.cjs`，環境設定沿用既有瀏覽器測試。

## 統一美元與歷史匯率

美股市場的財務金額、每股數字、歷史趨勢及估值輸入統一以 USD 計算及呈現；
公司頁保留原始申報幣別提示。換匯本身不覆寫 `cache/financials/*_statements_v2.json` 的來源幣別；
另行核實的官方修正／領展物業公允值覆蓋層保留原始資料於各自來源存檔，
前端與市場資料產生器共用 `usd_currency.js`，依每一筆報告的實際日期換算。
損益及現金流量採該財務期間內每日「USD／原幣」匯率的算術平均；
資產負債表採財報日或之前最近交易日的期末匯率。
現金流量表的期初／期末現金分別採對應日期的期末匯率。
TTM 先逐季換算，再合計四季，不以最新匯率重算全部歷史。
股數、非貨幣欄位及已報比率不乘匯率；每股盈餘使用原始稀釋每股口徑換算，
每股 FCF／股息使用各期歷史稀釋股數，不額外重複套用 ADR 倍數。
已是 USD 的美股報價、市值及使用者儲存的美元情境輸入不再換匯。

匯率來源為美國聯準會官方 H.10 每日資料，隨網站發布於 `cache/fx/usd_rates.json`。
`node scripts/refresh_usd_rates.cjs` 更新匯率；`node scripts/usd_financials.cjs`
以現有原始快取重建非 USD 股票的兩份市場資料。每日更新流程先更新匯率，
再產生市場資料；無須新增 API 金鑰。資料目前自 2018 年起涵蓋 23 種貨幣；
新增股票沿用同一流程，但不保證聯準會涵蓋所有貨幣。
缺少所需貨幣、完整期間匯率、可確認的財務期初日或對齊資料時，
相關值為 N/A 並顯示原因，不使用固定匯率、1:1 或虛構歷史補值；
匯率下載失敗會明確中止更新，不發布假的成功資料。
匯率換算後的跨期成長率及報酬率會包含美元匯率變動影響，不是固定匯率成長率。

同行比較表的目前公司欄使用不透明底色，避免上下捲動時下方數字透出固定表頭；
固定指標欄、表內水平捲動與深／淺色模式均保留。

## 公司摘要、企業評分與估值模型

「基本資料 / Profile」的歷史股價圖下方提供市場與財務摘要：股價及 52 週區間定位、
市場數據、資本結構、TTM 獲利效率、估值指標與已報成長率。報價及市場快照以 USD 呈現，
不將財報幣別（例如 TSM 的 TWD）當作美股報價幣別。
52 週區間條不是歷史價格走勢；現有資料未提供可用的歷史報價時，不生成模擬折線。
毛利率、營業利益率與淨利率採四個連續季度實際損益合計後相除，不平均四個季度百分比；
ROA／ROE 共用趨勢分析的 TTM／期初口徑。摘要附最新財報日及財報幣別。
營收、營業利益與淨利成長比較八個連續季度中的前後兩組 TTM，前期基數非正數時為 N/A；
不將 DCF 預測成長率充當已報歷史成長。負值與 ROA／ROE 原有負分母警示會保留。
缺季、重複期間、日期或幣別不一致、缺值及零營收不補數字；載入失敗有重試。
基本資料不再以假電話、估算高低價、假機構股東或預設持股比例填補缺失。
英文模式使用英文拆股說明、持有人名稱與股數單位。

基本資料與企業評分沿用趨勢分析的面板、表格字體、格線與間距；
分組色條區分市場／資本／獲利／估值，評分摘要卡保留完整護城河及 PF score 明細。
配色不會更改任何評分規則。

新增「估值模型 / Valuation Model」分頁，位於趨勢分析與公司新聞之間。
原有 DCF／金融估值面板只保留一份，移入此頁，計算方法、敏感度表、儲存及重設保持不變。
同一標的切換公司頁籤或語言不會重新載入並清除尚未儲存的模型參數。
新網址為 `#NVDA/valuation`；舊 `#NVDA` 仍開啟同一模型，
公司子頁支援直接網址及瀏覽器上一頁／下一頁。「返回總表」固定回到股票列表。

## 企業評分與 EPS／FCF／股息趨勢

公司頁面第二個頁籤「企業評分 / Company Rating」集中完整經濟護城河及 PF score
（Piotroski 九項評分，僅更改顯示名稱，原評分方法不變）。首頁與 DCF 的評分連結及舊護城河／評分網址也導向此頁。
原「EPS & Dividends」頁籤已移除。

PF score 下方提供財務健康訊號等級：7–9 分較強（綠）、4–6 分中等（黃）、0–3 分較弱（紅）。
解讀卡依現有九項明細列出通過與未通過的檢驗；明細必須有九個不同項目、有效 0／1 結果，
且加總與總分一致，否則提示先核對資料，不推定逐項優劣。缺少有效總分時不分級。
此為規則式篩選解讀，不是新增財報審計、信用評等、償債保證或投資建議；評分計算不變。

「趨勢分析」的資產負債分析下方新增 EPS、FCF 與股息趨勢，沿用摘要卡、重點財報日、
趨勢圖／明細表及季度／年度控制；季度預設 TTM，也可選單季。
三項均以 USD／稀釋股呈現，圖表共用每股刻度：
每股稀釋盈餘使用換算 USD 後的 `epsDiluted`；每稀釋股 FCF 為 `freeCashFlow / weightedAverageShsOutDil`；
每稀釋股現金股息為 `-commonDividendsPaid / weightedAverageShsOutDil`。
正常現金股息支出轉為正值，退款／沖回仍保留相反方向，不取絕對值；
這是實際支付現金換算，不等於公告或除息日的每股股息，也不以現價乘股息率推算。
單季及年度採該期歷史稀釋加權平均股數；TTM 的 FCF／股息以連續四季金額合計，
除以四季稀釋加權平均股數的簡單平均，不用目前股數或將四季股數相加。
股數缺失、零或負值時，FCF／股息每股值為 N/A 並說明原因，已報 EPS 仍可顯示。
TTM EPS 合計四季已報數字；本表未另做拆股調整，可能與年度加權股數 EPS 不同。
缺值、日期錯位、不連續期間或幣別不一致顯示 N/A 並說明原因，不補值。

財務報表、關鍵比率及同行比較沿用趨勢分析的面板、說明文字、表格格線、字體與間距，
固定指標欄及兩層日期表頭，長表於面板內捲動。
財務報表與關鍵比率改用相同風格的報表／期間下拉選單，保留原有計算口徑與表格內容；
所有港股及美股歷史表的右側迷你線圖共用趨勢分析的繪圖資料及正負配色：
負值紅色、零或正值綠色，跨零的線段在零點切換顏色，缺值保留斷線。
此規則適用於財務報表、關鍵比率、FCF 及 ROA／ROE／ROTE 表格，
末端圓點依最後有效數值的正負著色；顏色不再比較首尾升跌，也不代表指標的好壞。
同行比較顯示目前標的、實際同行數目及 TTM 口徑摘要，並醒目標示目前股票欄；
不將不同公司的 TTM 充當同一報告日期。

### 同行覆蓋與相關產業參考

比較表先選同板塊、同子行業的公司（供應商名單內者優先），其次選網站已收錄的供應商同行，
不足五家時才從明確定義的同板塊相關產業群組補入參考公司；各層依市值差距及代號穩定排序。
例如 CAT 的重型建築機械與 DE 的農業機械屬相關設備產業，但不因此宣稱兩者為完全相同業務。
各欄標示「同子行業／供應商同行／相關產業參考」，摘要分開計數；沒有同子行業公司時說明
這是網站收錄範圍限制，不代表沒有競爭對手。未收錄的供應商代號不憑空生成財報。
同一公司的不同股別（例如 GOOG／GOOGL）不互列為競爭對手，也不重複計入公司數目。
未知產業沒有合適參考時明確顯示覆蓋不足，不任意補入同板塊但不相關的公司。

後端同行快取支援 FMP stable 的逐公司 `symbol` 物件陣列，以及舊 `peersList` 格式；
保留完整供應商名單，僅在與網站股票名單交集後限制顯示五家，避免先截斷而漏掉已收錄公司。
無效回應、權限或網路錯誤明確記錄，保留既有有效快取，不把錯誤存成成功的空白名單。
每日更新沿用相同解析器；也可用既有更新工作流程的 `peers_only=true` 手動刷新全站同行，
或設定 `FMP_API_KEY` 後執行 `python scripts/refresh_peers.py`，不重算其他財務數字。
此模式任一請求失敗即中止發布資料集，避免宣稱已完整刷新。

同行健康檢查：`node --test tests/peer_comparison.test.cjs` 與
`python -m unittest discover -s tests -p "test_peer_cache.py"`。

### TTM 年增率資料健康檢查

同行比較與關鍵比率年度表的最後 TTM 欄，不再把「最近 TTM」與「最新完整年度」比較；
在 MU、LRCX 等剛結束財年的公司，這兩欄可能是同一年度，會錯誤顯示整排 0%。
全站改用最近八個連續財年季度，先比較最近四季合計與前四季合計；採實際日期、
財年季度與已換算 USD 的財報，不假設季度末一定是月底，也不將預測成長當成已報成長。
此邏輯與 Profile 的 TTM 年增率共用 `profile_overview.js`。

`node scripts/reported_growth.cjs` 只重建每檔股票的 `reported_growth` 資料，
不改寫原始財報或 DCF 參數；每日產生器在 USD 正規化後執行相同程序。
同時計算營收、毛利、營業利益、淨利、EBITDA、稀釋 EPS、營運現金流與 FCF 的年增率。
缺季、重複財報、日期錯位、欄位或匯率不足，以及前期基數非正數時，顯示 N/A 並說明原因；
只有可驗證的兩期合計完全相同才顯示 0%。保留真正的負成長，不補零或推估數值。
關鍵比率最早一期缺少基期的成長率也改為 N/A，季度仍比較前一季。
回歸測試：`node --test tests/reported_growth.test.cjs`；
瀏覽器全股票健康檢查為 `node tests/peer_comparison.browser.cjs`。

## 自由現金流比率表

在首頁點選股票代號進入公司頁面，再選擇「趨勢分析（Trend Analysis）」子頁，
即可查看 FCF／股東權益、FCF／總資產、
FCF／營收、FCF／EBITDA、FCF／淨利。勾選框控制顯示項目；報表期間可選季度或完整會計年度。
季度預設 TTM，也可切換單季。資產與權益的分母預設期初，可改為期末或期初／期末簡單平均；
營收、EBITDA 與淨利則始終使用與 FCF 相同期間的流量；FCF／淨利為 FCF 除以損益表 `netIncome`，以百分比呈現。
右側「趨勢」欄以迷你折線呈現目前所選口徑的歷史比率；缺失期間保留斷點，不補零或連線。
桌面版趨勢欄固定於右側，行動版可向右捲動查看。

DCF 面板標頭的股票代號可直接切回公司基本資料。公司頁面九個頁籤會依可用寬度換行；
關鍵比率及同行比較表提供可讀欄寬、固定標頭與指標欄，並在表格內捲動。

FCF 使用原始財報 `freeCashFlow`（營運現金流減資本支出），不是 FCFE。
期初指單季開始前一季、TTM 開始前四季、年度開始前一財年的期末餘額。
比率直接讀取 `cache/financials/{ticker}_statements_v2.json`，依財年季度和完整日期對齊三表，
不受 DCF 模擬輸入影響，也不以目前數值補歷史資料。這些快取檔須隨靜態網站一起發布。

現有資料通常包含五個完整年度與二十季；最早的 TTM 或期初資料不足時顯示 N/A。
缺少欄位、日期不一致、幣別不一致或零分母也會顯示 N/A，並在表下及儲存格提示原因。
負值保留算術結果，另以警示說明，不能把負權益、負 EBITDA 或虧損分母的正比率視為正向回報。
舊有五年歷史估值圖已移除，不再以模擬序列充當實際歷史。

## 資本報酬率表

「公司頁面 → 趨勢分析」的 FCF 表下方另有 ROA、ROE、ROTE 表，暫不加入 ROIC。
各項可獨立勾選，並附歷史趨勢圖；控制獨立於 FCF 表與 DCF 模擬。
報表期間可選季度或完整年度；季度預設 TTM，也可選單季（不年化）。
分母預設期初，可選期末或期初／期末簡單平均，期初期間定義與 FCF 表一致。

ROA 使用財報 `netIncome` 除以 `totalAssets`，ROE 使用同期間淨利除以 `totalStockholdersEquity`。
ROTE 依重視有形資本的原則，使用同期間淨利除以有形股東權益，即股東權益扣除商譽及其他無形資產；
不另扣優先股，也不宣稱是巴菲特唯一或調整後盈餘公式，且不等同有形淨資產報酬率。
有形權益優先使用 `goodwillAndIntangibleAssets` 扣除一次；
該欄缺失時，只有在 `goodwill` 和 `intangibleAssets` 都存在才使用兩者合計，絕不把缺值視為零。
平均分母先分別計算期初與期末有形權益，再取簡單平均。

TTM 必須有連續四季損益表、有效淨利及一致幣別；資產／權益依財年季度和完整日期對齊。
缺少淨利、期初餘額或無形資產資料，日期錯位及零分母會顯示 N/A 並說明原因。
虧損、負股東權益及負有形權益保留算術值並附警示；負分母造成的正比率不代表正向回報。
兩張表共用原始財報載入快取，但各自保留選項、載入狀態及過期請求保護。

### 與金融股 DCF 的 ROTE 一致性

金融股 DCF 的觀測基準與趨勢分析「季度／TTM／期初」的最新 ROTE 共用同一計算函式，
不再以 ROE 代替，也不為 ROTE 或有形權益設定虛構的正值下限。
DCF 同時顯示財報日期及基準值；手動調整滑桿屬估值情境，不會改寫歷史表。
若切換歷史表的期間或分母口徑，結果本來就可能不同；重設 DCF 可還原觀測基準。

DCF 的每股有形帳面價值使用同一財報截止日的期末有形權益及現有股數，
並非把期初權益充當期末帳面價值。缺少必要資料或期末有形權益非正數時，
超額報酬與加權估值顯示 N/A 並說明原因；股利折現值仍可獨立查看。
這項限制不會把趨勢表中的負 ROTE 改成零或正數。

每日資料產生器需要 Python 及 Node.js 24（排程已設定），透過
`scripts/financial_reference.cjs --stdin` 呼叫與瀏覽器相同的計算引擎。
如僅需以現有財報快取更新金融股觀測基準，可執行 `node scripts/financial_reference.cjs`；
此命令會更新兩份市場資料，不會重新下載資料或修改非金融股。

## 字體、財報表格與色彩模式

全站表格及控制項使用統一的系統無襯線字體；數字採等寬數字排版。
財報、關鍵比率及同行比較表沿用趨勢分析的表格樣式，保留可讀欄寬與表內水平捲動；
財報分組列與一般列共用完整欄格，季度年度分隔線不再因醒目列中斷。
中英文切換保留目前公司子頁，財報標頭與分組名稱依所選語言顯示。

頁面頂部的太陽／月亮圖示按鈕可切換淺色／深色模式；保留隨中英文更新的提示與無障礙名稱，
包含圖表及 TradingView；預設深色，選擇會儲存在瀏覽器並於下次開啟時套用。
若瀏覽器禁止本機儲存，仍可在目前頁面切換，但不保證保留偏好。

## 資產與負債結構

「公司頁面 → 趨勢分析」在資本報酬率表下方提供資產負債分析；
「關鍵比率」不再重複顯示舊的 Return on Capital Metrics 圖表。
新的資產分析取代原本依目前市值、現金與債務推算的歷史圖，不改動 DCF 計算。

預設顯示季度，可選年度；「重點財報日」切換上方四張重點卡片及醒目標記。
明細表會自動捲動至所選期間，保留左側指標名稱，避免卡片顯示最新數字、表格卻停留在最早年度。
總資產、總負債與股東權益共用單一金額軸，比舊有堆疊柱／雙軸更容易比較；
圖例可隱藏數列，亦可切換「明細表」查看九項資產、負債、現金及權益餘額。
所有餘額都是原始財報日的期末數字，不做 TTM 加總，也不另增推算的 TTM 資產欄。
金額單位統一為百萬 USD，非 USD 財報以各財報日期的期末匯率換算。
圖表不把不同幣別連成同一數列；資料缺失、期間缺口、日期無效或重複財報不補數字。
明細表保留可核對的期間與日期；缺少資料顯示 N/A，並提供原因。

重點卡片附流動比率、總負債／總資產、總資產／股東權益、現金／流動負債。
倍數以 × 顯示，總負債／總資產以百分比顯示；分母為零時顯示 N/A。
現金是 `cashAndCashEquivalents`，不含另列短期投資；總負債不是僅有息債務。
負股東權益及負餘額保留原值並警示，不以最低正數代替。
本表與 FCF、報酬率表共用財報請求，但期間及日期控制獨立。

## 首頁檢視

首頁先呈現市場摘要與搜尋，預設「重點概覽」只顯示九個常用欄位，
可切換「估值與目標價」、「財務與品質」或「全部欄位」；全部 33 個原有欄位仍保留。
產業篩選收在可展開區域，啟用時顯示篩選數量；「清除篩選」一次重設搜尋、估值及產業條件。
欄位切換不會更動排序、股票數據、自選或儲存的模型，亦不會清除目前搜尋條件。
結果列顯示篩選後股票數量，沒有結果時提供提示。手機版只固定必要欄，其他資料在表內橫向捲動。

板塊與子行業採用同寬的按鈕網格，分類標籤靠上對齊；長名稱可換行，手機版使用兩欄。
首頁表頭統一成「名稱／單位或說明圖示」兩層，中英文、欄位檢視與排序切換皆保留相同位置。
清算價 L1／L2／L3 的正值以綠色、負值以紅色、零與缺值以中性色顯示，並保留原始正負號；
這僅表示清算值的方向，正值不代表市價低估，也不改變清算公式。
滑鼠移入資料列時會突出整列，包含固定欄；淺色模式的表格區另使用黑白雙色描邊游標，
拖曳時使用水平移動圖示，避免淺色背景下游標難以辨認。鍵盤聚焦亦會突出所在資料列。

驗證：`node --test tests/fcf_ratios.test.cjs tests/profile_overview.test.cjs tests/usd_currency.test.cjs`（使用 Node.js 內建測試工具，無額外相依套件）。
瀏覽器回歸腳本為 `node tests/fcf_ratios.browser.cjs`，需可用的 Playwright 與瀏覽器；
先啟動靜態伺服器，或以 `TEST_BASE_URL` 指向測試網址。可用 `BROWSER_EXECUTABLE` 指定瀏覽器路徑。