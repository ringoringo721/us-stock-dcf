"""Independent Decimal audit and formula-based XLSX export; Python standard library only."""
import argparse
import json
from decimal import Decimal, localcontext
from pathlib import Path
from xml.sax.saxutils import escape
from zipfile import ZipFile, ZIP_DEFLATED


def number(value):
    return Decimal(str(value))


def calculate(scenario):
    with localcontext() as context:
        context.prec = 50
        revenue = number(scenario["baseRevenue"])
        nwc = None if scenario.get("workingCapitalMethod") == "cash-change-to-revenue" else number(scenario["openingNwc"])
        discount, present_flows = Decimal(1), Decimal(0)
        rows = []
        for year in scenario["years"]:
            v = {key: number(value) for key, value in year["values"].items() if value is not None}
            revenue *= 1 + v["growth"] / 100
            wacc = ((1 - v["debtWeight"] / 100) * v["ke"]
                    + v["debtWeight"] / 100 * v["kd"] * (1 - v["tax"] / 100)) / 100
            discount *= 1 + wacc
            capex = revenue * v["capex"] / 100
            row = {"revenue": revenue, "capex": capex, "wacc": wacc, "discount": discount}
            if scenario["kind"] == "advanced":
                row["ebitda"] = revenue * v["ebitda"] / 100
                row["da"] = revenue * v["da"] / 100
                row["ebit"] = row["ebitda"] - row["da"]
                row["nopat"] = row["ebit"] * (1 - v["tax"] / 100)
                if scenario.get("workingCapitalMethod") == "cash-change-to-revenue":
                    row["changeNwc"] = revenue * v["nwcChange"] / 100
                else:
                    row["nwc"] = revenue * (v["receivables"] + v["inventories"] - v["payables"]) / 100
                    row["changeNwc"] = row["nwc"] - nwc
                    nwc = row["nwc"]
                if "cash" in v:
                    row["projectedCash"] = revenue * v["cash"] / 100
                cash_flow = row["nopat"] + row["da"] + capex - row["changeNwc"]
            else:
                row["cfo"] = revenue * v["cfo"] / 100
                cash_flow = row["cfo"] + capex
            row["cashFlow"] = cash_flow
            row["pv"] = cash_flow / discount
            present_flows += row["pv"]
            rows.append(row)
        g = number(scenario["terminalGrowth"]) / 100
        if wacc <= g:
            raise ValueError("SCENARIO_INVALID_TERMINAL_SPREAD")
        terminal = cash_flow * (1 + g) / (wacc - g)
        pv_terminal = terminal / discount
        ev = present_flows + pv_terminal
        equity = ev - number(scenario["netDebt"])
        return {"rows": rows, "presentFlows": present_flows, "terminalValue": terminal,
                "presentTerminalValue": pv_terminal, "enterpriseValue": ev, "equityValue": equity,
                "netDebt": number(scenario["netDebt"]), "targetPrice": equity / number(scenario["shares"])}


def audit(packets):
    count, max_money, max_price = 0, Decimal(0), Decimal(0)
    unavailable = []
    for packet in packets:
        if not packet.get("tenYear"):
            continue
        if not packet["tenYear"].get("result"):
            if not packet["tenYear"].get("reason"):
                raise ValueError("Missing ten-year result without an unavailable reason")
            unavailable.append({"symbol": packet["symbol"], "kind": packet["kind"], "reason": packet["tenYear"]["reason"]})
            continue
        calculated = calculate(packet["tenYear"]["input"])
        actual = packet["tenYear"]["result"]
        if len(actual["rows"]) != 10:
            raise AssertionError("Expected exactly ten annual result rows")
        comparisons = [(key, value, actual[key]) for key, value in calculated.items() if key != "rows"]
        for expected, row in zip(calculated["rows"], actual["rows"]):
            comparisons.extend((key, value, row[key]) for key, value in expected.items() if key in row)
        for key, expected, value in comparisons:
            delta = abs(expected - number(value))
            tolerance = Decimal("0.00000001") if key == "targetPrice" else Decimal("0.000000000001") if key in ["wacc", "discount"] else Decimal("0.01")
            if delta > tolerance:
                raise AssertionError(f'{packet["symbol"]} {packet["kind"]} {key}: difference {delta} > {tolerance}')
            if key == "targetPrice":
                max_price = max(max_price, delta)
            elif key not in ["wacc", "discount"]:
                max_money = max(max_money, delta)
        count += 1
    return {"auditedScenarios": count, "maxMonetaryDifference": str(max_money),
            "unavailableScenarios": unavailable,
            "maxPerShareDifference": str(max_price),
            "tolerance": "0.01 currency units; 1e-8 per share; 1e-12 WACC/discount factor"}


class Formula:
    def __init__(self, text, cached):
        self.text, self.cached = text, cached


def column(index):
    result = ""
    while index:
        index, remainder = divmod(index - 1, 26)
        result = chr(65 + remainder) + result
    return result


def write_xlsx(output, sheets):
    ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
    with ZipFile(output, "w", ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml",
                         '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                         '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                         '<Default Extension="xml" ContentType="application/xml"/>'
                         '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
                         '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
                         + "".join(f'<Override PartName="/xl/worksheets/sheet{i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' for i in range(1, len(sheets) + 1)) + "</Types>")
        archive.writestr("_rels/.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')
        archive.writestr("xl/workbook.xml", f'<workbook xmlns="{ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
                         + "".join(f'<sheet name="{escape(name)}" sheetId="{i}" r:id="rId{i}"/>' for i, (name, _) in enumerate(sheets, 1))
                         + '</sheets><calcPr calcId="0" fullCalcOnLoad="1" forceFullCalc="1"/></workbook>')
        archive.writestr("xl/_rels/workbook.xml.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                         + "".join(f'<Relationship Id="rId{i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{i}.xml"/>' for i in range(1, len(sheets) + 1))
                         + '<Relationship Id="styles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>')
        archive.writestr("xl/styles.xml", f'<styleSheet xmlns="{ns}"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="10" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>')
        for i, (_, rows) in enumerate(sheets, 1):
            body = []
            for r, row in enumerate(rows, 1):
                cells = []
                for c, item in enumerate(row, 1):
                    style = 0
                    if isinstance(item, tuple):
                        item, style = item
                    if item is None:
                        continue
                    ref = f"{column(c)}{r}"
                    if isinstance(item, Formula):
                        cells.append(f'<c r="{ref}" s="{style}"><f>{escape(item.text)}</f><v>{item.cached}</v></c>')
                    elif isinstance(item, (int, float, Decimal)):
                        cells.append(f'<c r="{ref}" s="{style}"><v>{item}</v></c>')
                    else:
                        cells.append(f'<c r="{ref}" s="{style}" t="inlineStr"><is><t xml:space="preserve">{escape(str(item))}</t></is></c>')
                body.append(f'<row r="{r}">{"".join(cells)}</row>')
            archive.writestr(f"xl/worksheets/sheet{i}.xml", f'<worksheet xmlns="{ns}"><sheetViews><sheetView workbookViewId="0"><pane xSplit="1" ySplit="4" topLeftCell="B5" activePane="bottomRight" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="1" width="54" customWidth="1"/><col min="2" max="30" width="22" customWidth="1"/></cols><sheetData>{"".join(body)}</sheetData></worksheet>')


def scenario_sheet(packet):
    s = packet["tenYear"]["input"]
    if not packet["tenYear"].get("result"):
        return [
            [f'{packet["symbol"]}: incomplete ten-year {s["kind"]} inputs'],
            ["Status", packet["tenYear"].get("reason")],
            ["Valuation", "N/A: no price or formula result is fabricated. Complete inputs on the site and export again for a formula model."],
            ["Assumption policy", s.get("assumptionPolicy", "legacy")],
            ["Consensus captured", s["sourceCapturedAt"]],
            ["Actual-ratio source FY end", s.get("actualRatioDate")],
            ["Working-capital FYs", json.dumps(s.get("workingCapitalYears"))],
            ["Missing inputs", json.dumps(packet["tenYear"].get("missingInputs"))],
            ["Projected FY"] + [year["year"] for year in s["years"]],
            *[[key] + [year["values"].get(key) for year in s["years"]] for key in s["years"][0]["values"]],
            ["Input units", "Percentage points; blank cells are unavailable, NOT zero."],
            ["Per-field origins"] + [json.dumps(year["origins"]) for year in s["years"]]
        ]
    result = calculate(s)
    advanced = s["kind"] == "advanced"
    rows = [
        [f'{packet["symbol"]}: site-calculated ten-year {s["kind"]} scenario'],
        ["Amounts: currency units, NOT millions. Numeric assumption cells editable; formula cells recalculate."],
        ["Currency", s["currency"]], ["Source captured", s["sourceCapturedAt"]],
        ["Actual baseline FY", s["baseYear"]], ["Base revenue (FMP model basis)", s["baseRevenue"]],
        ["Opening NWC (FMP model basis)", s["openingNwc"]], ["Snapshot net debt (subtracted once)", s["netDebt"]],
        ["Issued common shares (individual shares)", s["shares"]], ["Terminal growth", (number(s["terminalGrowth"]) / 100, 1)],
        ["Negative CapEx inputs. EBIT is linked to EBITDA less DA. Ke override takes precedence over CAPM."],
        ["Full precision retained. Percent display 2dp. Year-end discounting; no stub-year adjustment."],
        ["Projected fiscal year"] + [year["year"] for year in s["years"]],
        ["Year source (see per-field origins)"] + [
            "Analyst / latest FY / user inputs" if s.get("assumptionPolicy") == "analyst-consensus-v1"
            else "FMP model projection" if year["year"] in s["providerYears"] else "Legacy extension"
            for year in s["years"]]
    ]
    keys = list(s["years"][0]["values"])
    locations = {}
    for key in keys:
        locations[key] = len(rows) + 1
        rows.append([key] + [(number(year["values"][key]) / (1 if key == "beta" else 100), 0 if key == "beta" else 1) for year in s["years"]])
    rows.append(["Per-field input provenance"] + [json.dumps(year["origins"], ensure_ascii=False) for year in s["years"]])
    override = len(rows) + 1
    rows.append(["ke override (blank = initial Ke / changed CAPM)"])
    for i, year in enumerate(s["years"]):
        c = column(i + 2)
        if advanced:
            rows[locations["ebit"] - 1][i + 1] = (Formula(f'{c}{locations["ebitda"]}-{c}{locations["da"]}', number(year["values"]["ebit"]) / 100), 1)
        v = year["values"]
        conditions = ",".join(f'{c}{locations[key]}={number(v[key]) / (1 if key == "beta" else 100)}' for key in ["rf", "beta", "erp"])
        formula = f'IF(ISNUMBER({c}{override}),{c}{override},IF(AND({conditions}),{number(v["ke"]) / 100},{c}{locations["rf"]}+{c}{locations["beta"]}*{c}{locations["erp"]}))'
        rows[locations["ke"] - 1][i + 1] = (Formula(formula, number(v["ke"]) / 100), 1)
    rows.append(["Calculated outputs"])
    outputs = {}
    for key in ["revenue", "ebitda", "da", "ebit", "nopat", "cfo", "capex", "nwc", "changeNwc", "projectedCash", "wacc", "discount", "cashFlow", "pv"]:
        outputs[key] = len(rows) + 1
        rows.append([key])
    for i, expected in enumerate(result["rows"]):
        c, previous = column(i + 2), column(i + 1)
        get = lambda key: f"{c}{locations[key]}"
        out = lambda key: f"{c}{outputs[key]}"
        formulae = {
            "revenue": f'{"$B$6" if i == 0 else previous + str(outputs["revenue"])}*(1+{get("growth")})',
            "capex": f'{out("revenue")}*{get("capex")}',
            "wacc": f'{get("ke")}*(1-{get("debtWeight")})+{get("kd")}*(1-{get("tax")})*{get("debtWeight")}',
            "discount": f'(1+{out("wacc")})*{"1" if i == 0 else previous + str(outputs["discount"])}',
            "pv": f'{out("cashFlow")}/{out("discount")}'
        }
        if advanced:
            formulae.update({
                "ebitda": f'{out("revenue")}*{get("ebitda")}', "da": f'{out("revenue")}*{get("da")}',
                "ebit": f'{out("ebitda")}-{out("da")}', "nopat": f'{out("ebit")}*(1-{get("tax")})',
                "cashFlow": f'{out("nopat")}+{out("da")}+{out("capex")}-{out("changeNwc")}'
            })
            if s.get("workingCapitalMethod") == "cash-change-to-revenue":
                formulae["changeNwc"] = f'{out("revenue")}*{get("nwcChange")}'
            else:
                formulae["nwc"] = f'{out("revenue")}*({get("receivables")}+{get("inventories")}-{get("payables")})'
                formulae["changeNwc"] = f'{out("nwc")}-{"$B$7" if i == 0 else previous + str(outputs["nwc"])}'
            if "cash" in locations and "projectedCash" in expected:
                formulae["projectedCash"] = f'{out("revenue")}*{get("cash")}'
        else:
            formulae.update({"cfo": f'{out("revenue")}*{get("cfo")}', "cashFlow": f'{out("cfo")}+{out("capex")}'})
        for key in outputs:
            rows[outputs[key] - 1].append((Formula(formulae[key], expected[key]), 1 if key == "wacc" else 0) if key in formulae else None)
    rows.append(["Valuation bridge"])
    bridge = {}
    for key in ["presentFlows", "terminalValue", "presentTerminalValue", "enterpriseValue", "netDebt", "equityValue", "targetPrice"]:
        bridge[key] = len(rows) + 1
        formula = {
            "presentFlows": f'SUM(B{outputs["pv"]}:K{outputs["pv"]})',
            "terminalValue": f'IF(K{outputs["wacc"]}<=$B$10,NA(),K{outputs["cashFlow"]}*(1+$B$10)/(K{outputs["wacc"]}-$B$10))',
            "presentTerminalValue": f'B{bridge.get("terminalValue")}/K{outputs["discount"]}',
            "enterpriseValue": f'B{bridge.get("presentFlows")}+B{bridge.get("presentTerminalValue")}',
            "netDebt": "$B$8",
            "equityValue": f'B{bridge.get("enterpriseValue")}-$B$8',
            "targetPrice": f'B{bridge.get("equityValue")}/$B$9'
        }[key]
        rows.append([key, Formula(formula, result[key])])
    rows.append(["Interpretation", "Negative equity/terminal cash flow is retained for review, not a tradable negative share price."])
    return rows


def native_sheet(packet):
    data = sorted(packet["native"]["rows"], key=lambda row: int(row["year"]))
    rows = [[f'{packet["symbol"]}: ORIGINAL FMP API {packet["kind"]}'],
            ["Raw API units retained. WACC/rate fields are percentage points; amount ratio fields retain API units."],
            ["Source captured", packet["sourceCapturedAt"]], ["Model year (NOT point-in-time history)"] + [row["year"] for row in data]]
    fields = list(dict.fromkeys(key for row in data for key in row if key != "year"))
    locations = {}
    for key in fields:
        locations[key] = len(rows) + 1
        rows.append([key] + [row.get(key) for row in data])
    rows.append(["Checks below are candidate identities, not a reproduced FMP engine. Residuals do not alter raw vendor outputs."])
    for name in ["EV residual", "Equity residual", "EBIT identity residual" if packet["kind"] == "advanced" else "CFO cash-flow residual", "Original diluted-price residual", "Site issued-share rebase"]:
        values = [name]
        for i, row in enumerate(data):
            c = column(i + 2)
            ref = lambda key: f'{c}{locations[key]}'
            n = lambda key: number(row[key])
            if name == "EV residual":
                pv = "sumPvUfcf" if packet["kind"] == "advanced" else "sumPvLfcf"
                f = f'{ref("enterpriseValue")}-({ref(pv)}+{ref("presentTerminalValue")})'
                value = n("enterpriseValue") - n(pv) - n("presentTerminalValue")
            elif name == "Equity residual":
                f = f'{ref("equityValue")}-({ref("enterpriseValue")}-{ref("netDebt")})'
                value = n("equityValue") - n("enterpriseValue") + n("netDebt")
            elif name == "EBIT identity residual":
                f = f'{ref("ebit")}-({ref("ebitda")}-{ref("depreciation")})'
                value = n("ebit") - n("ebitda") + n("depreciation")
            elif name == "CFO cash-flow residual":
                f = f'{ref("freeCashFlow")}-({ref("operatingCashFlow")}+{ref("capitalExpenditure")})'
                value = n("freeCashFlow") - n("operatingCashFlow") - n("capitalExpenditure")
            elif name == "Original diluted-price residual":
                f = f'{ref("equityValuePerShare")}-{ref("equityValue")}/{ref("dilutedSharesOutstanding")}'
                value = n("equityValuePerShare") - n("equityValue") / n("dilutedSharesOutstanding")
            else:
                shares = packet["native"]["issuedShares"]
                f, value = f'{ref("equityValue")}/{shares}', n("equityValue") / number(shares)
            values.append(Formula(f, value))
        rows.append(values)
    rows.append(["Website selected native row", packet["native"]["selectedYear"]])
    rows.append(["Available row coverage", packet["native"].get("rowCoverage", "Available API rows; reloaded saved models may contain a selected summary only")])
    rows.append(["Site issued shares", packet["native"]["issuedShares"]])
    rows.append(["Native scalar API overrides (not ten-year arrays)", json.dumps(packet["native"]["params"], ensure_ascii=False)])
    return rows


def workbook(packets, output):
    sheets = [("Read me", [
        ["FMP original API vs site ten-year calculation workbook"],
        ["Native tabs", "Unmodified API data and explicit reconciliation checks. FMP internals/discount dates are not independently certified."],
        ["Scenario tabs", "Site formula-based ten-year models. Change numeric assumptions; Excel recalculates formulas on opening."],
        ["Precision", "Full source precision retained. Percentages format to 2dp without rounding calculations. Rates are stored as fractions in scenario tabs."],
        ["CAPM", "Initial Ke retained until rf/beta/erp change. Optional Ke override has precedence. EBIT derives from EBITDA less DA."],
        ["Forecast origin", "New defaults distinguish analyst consensus, latest-FY CFO/CapEx/DA ratios, five-year working-capital ratios, missing inputs and user edits. Legacy scenarios retain their origins. Incomplete inputs have no valuation/formula result."],
        ["Actual reference", "Reference only; exact annual financial period, not fabricated TTM. Actual balances are FY-end snapshots. Capital costs/beta unavailable as reported actuals."],
        ["Currency", "Financial actuals use historical FX; FMP model baseline may use spot FX. Do not mix annual actual values into model baseline without review."],
        ["CFO method", "CFO+negative CapEx with vendor-style WACC/EV less debt, NOT independently defined FCFE discounted at Ke."],
        ["Limitations", "Gordon growth uses year-ten cash flow, WACC and annual growth; negative terminal cash flow/equity is retained for review, not a reliable positive going-concern price."],
        ["Tax", "Historical effective tax is not forecast operating tax. Scenario operating tax is also used in the debt tax shield. No separate loss-carryforward engine."],
        ["Editing limits", "Use valid numeric assumptions. The workbook is a transparent calculation template, not the website's full input-validation UI. Terminal WACC <= growth returns #N/A."],
        ["Save/deployment", "Workbook editing does not save website targets or deploy any changes. JSON preserves full provenance and assumptions."],
        ["Audit", json.dumps(audit(packets))]
    ])]
    for packet in packets:
        kind = "Advanced" if packet["kind"] == "advanced" else "CFO"
        sheets.append((f"Native {kind}", native_sheet(packet)))
        if packet.get("tenYear"):
            sheets.append((f"10Y {kind}", scenario_sheet(packet)))
    actual = next((packet["actualReference"] for packet in packets if not packet["actualReference"]["reason"]), packets[0]["actualReference"])
    reference = [["Actual annual reference (not TTM)"], ["Period", actual.get("date")],
                 ["Currency", actual.get("currency")], ["Status", actual.get("reason") or "Available"],
                 ["Field", "Amount (currency units)", "Ratio", "Source", "Basis", "Provenance"]]
    for key, item in actual["items"].items():
        reference.append([key, item["amount"], (number(item["percent"]) / 100, 1) if item["percent"] is not None else None,
                          item["source"], item["basis"], json.dumps(item.get("document") or item.get("provenance"), ensure_ascii=False)])
    reference.append(["Financing parameters", "Beta, rf, ERP, Kd, Ke and debt weight are assumptions, not invented financial-statement actuals."])
    reference.append(["FX provenance", json.dumps(actual.get("fxBasis"), ensure_ascii=False)])
    sheets.append(("Actual FY reference", reference))
    write_xlsx(output, sheets)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True)
    parser.add_argument("--ticker")
    parser.add_argument("--output")
    args = parser.parse_args()
    document = json.loads(Path(args.input).read_text(encoding="utf-8"))
    packets = document.get("packets", [document])
    print(json.dumps(audit(packets)))
    if args.output:
        selected = [packet for packet in packets if not args.ticker or packet["symbol"] == args.ticker]
        if not selected or len({packet["symbol"] for packet in selected}) != 1:
            parser.error("Select exactly one available ticker for each workbook")
        workbook(selected, args.output)
        print(f"Saved {args.output}")


if __name__ == "__main__":
    main()
