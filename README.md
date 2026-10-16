# us-stock-dcf

## DCF 自由現金流比率表

選取股票並進入 DCF 模型後，可在下方查看 FCF／股東權益、FCF／總資產、
FCF／營收、FCF／EBITDA。勾選框控制顯示項目；報表期間可選季度或完整會計年度。
季度預設 TTM，也可切換單季。資產與權益的分母預設期初，可改為期末或期初／期末簡單平均；
營收與 EBITDA 則始終使用與 FCF 相同期間的流量。

FCF 使用原始財報 `freeCashFlow`（營運現金流減資本支出），不是 FCFE。
期初指單季開始前一季、TTM 開始前四季、年度開始前一財年的期末餘額。
比率直接讀取 `cache/financials/{ticker}_statements_v2.json`，依財年季度和完整日期對齊三表，
不受 DCF 模擬輸入影響，也不以目前數值補歷史資料。這些快取檔須隨靜態網站一起發布。

現有資料通常包含五個完整年度與二十季；最早的 TTM 或期初資料不足時顯示 N/A。
缺少欄位、日期不一致、幣別不一致或零分母也會顯示 N/A，並在表下及儲存格提示原因。
負值保留算術結果，另以警示說明，不能把負權益或負 EBITDA 的正比率視為正向回報。
舊有五年歷史估值圖已移除，不再以模擬序列充當實際歷史。

驗證：`node --test tests/fcf_ratios.test.cjs`（使用 Node.js 內建測試工具，無額外相依套件）。
瀏覽器回歸腳本為 `node tests/fcf_ratios.browser.cjs`，需可用的 Playwright 與瀏覽器；
先啟動靜態伺服器，或以 `TEST_BASE_URL` 指向測試網址。可用 `BROWSER_EXECUTABLE` 指定瀏覽器路徑。