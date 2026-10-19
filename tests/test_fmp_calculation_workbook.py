import importlib.util
import tempfile
import unittest
from pathlib import Path
from zipfile import ZipFile
from xml.etree import ElementTree

MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "fmp_calculation_workbook.py"
spec = importlib.util.spec_from_file_location("fmp_calculation_workbook", MODULE_PATH)
model = importlib.util.module_from_spec(spec)
spec.loader.exec_module(model)


def flat(kind="advanced"):
    return {"kind": kind, "baseRevenue": 100, "openingNwc": 25, "netDebt": 20,
            "shares": 10, "terminalGrowth": 0, "years": [
                {"values": {"growth": 0, "ebitda": 30, "da": 5, "ebit": 25, "cfo": 30,
                            "cash": 20, "receivables": 20, "inventories": 10, "payables": 5,
                            "capex": -10, "tax": 20, "ke": 10, "kd": 5, "debtWeight": 0}}
                for _ in range(10)]}


class CalculationWorkbookTests(unittest.TestCase):
    def test_single_nwc_change_ratio_sign_and_no_extra_opening_balance_deduction(self):
        scenario = flat()
        scenario["workingCapitalMethod"] = "cash-change-to-revenue"
        scenario["openingNwc"] = None
        for year in scenario["years"]:
            year["values"]["nwcChange"] = 5
            for key in ["receivables", "inventories", "payables", "cash"]:
                del year["values"][key]
        result = model.calculate(scenario)
        self.assertEqual(result["rows"][0]["changeNwc"], 5)
        self.assertEqual(result["rows"][0]["cashFlow"], 10)
        self.assertAlmostEqual(result["targetPrice"], model.number(8), places=40)
        scenario["years"][0]["values"]["nwcChange"] = -5
        self.assertEqual(model.calculate(scenario)["rows"][0]["cashFlow"], 20)

    def test_unavailable_inputs_are_reported_not_counted_as_audited_valuations(self):
        packet = {"symbol": "TEST", "kind": "advanced",
                  "tenYear": {"input": {}, "result": None, "reason": "SCENARIO_INCOMPLETE_ASSUMPTIONS"}}
        result = model.audit([packet])
        self.assertEqual(result["auditedScenarios"], 0)
        self.assertEqual(result["unavailableScenarios"][0]["reason"], "SCENARIO_INCOMPLETE_ASSUMPTIONS")
        packet["tenYear"]["reason"] = None
        with self.assertRaisesRegex(ValueError, "without an unavailable reason"):
            model.audit([packet])

    def test_independent_known_perpetuity_and_debt_bridge(self):
        for kind, flow, ev, price in [("advanced", 15, 150, 13), ("customLevered", 20, 200, 18)]:
            result = model.calculate(flat(kind))
            self.assertEqual(result["rows"][0]["cashFlow"], flow)
            self.assertAlmostEqual(result["enterpriseValue"], model.number(ev), places=40)
            self.assertAlmostEqual(result["targetPrice"], model.number(price), places=40)

    def test_annual_discounting_and_negative_values(self):
        scenario = flat()
        scenario["years"][0]["values"]["ke"] = 20
        result = model.calculate(scenario)
        self.assertEqual(result["rows"][1]["discount"], model.number("1.32"))
        self.assertAlmostEqual(result["enterpriseValue"], model.number("137.5"), places=40)
        scenario["netDebt"] = 200
        self.assertLess(model.calculate(scenario)["targetPrice"], 0)
        scenario["terminalGrowth"] = 10
        with self.assertRaisesRegex(ValueError, "INVALID_TERMINAL_SPREAD"):
            model.calculate(scenario)

    def test_xlsx_is_parseable_preserves_precision_and_has_no_external_connections(self):
        with tempfile.TemporaryDirectory(prefix="fmp-xlsx-test-") as folder:
            output = Path(folder) / "model.xlsx"
            model.write_xlsx(output, [("Model", [["Rate", (model.number("0.07464695153412826"), 1)],
                                                ["Result", model.Formula("B1*100", model.number("7.464695153412826"))]])])
            with ZipFile(output) as archive:
                for name in archive.namelist():
                    if name.endswith((".xml", ".rels")):
                        ElementTree.fromstring(archive.read(name))
                sheet = archive.read("xl/worksheets/sheet1.xml").decode()
                self.assertIn("0.07464695153412826", sheet)
                self.assertIn("<f>B1*100</f>", sheet)
                self.assertNotIn("externalLink", "\n".join(archive.namelist()))
                self.assertNotIn("vbaProject", "\n".join(archive.namelist()))


if __name__ == "__main__":
    unittest.main()
