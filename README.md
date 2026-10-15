# 美國股票 DCF：歷史圖表資料修復

## 修正內容

舊版 `index.html` 在沒有歷史價格時，會依目前報價製造平日價格走勢；季度公允價值也會由目前估值倒推。兩者都不是歷史觀測值或歷史季度 DCF。本次移除這些補值：只有來源資料與日期基準可驗證時才畫線，否則以中英文說明資料不可用。

歷史價格由伺服器端透過 FMP Stable API 擷取並快取，不在瀏覽器呼叫 API，也不把金鑰寫入 JSON 或 JavaScript。使用 `close`，不用包含股息調整的 `adjClose`；依 FMP 拆股日期與比例，將歷史收盤價換算至相同的拆股後每股基準。報價與最後一個日收盤價分別保存其日期與標籤。失敗時保留 last-good 資料及原始更新時間，並明確標示 stale/error。

歷史估值使用季度財報的實際期間結束日與申報可得日期，按完整期間日期連接報表，並以四季 FCFF（CFO − 資本支出 + 稅後利息）作重建模型輸入。固定重建假設為 5 年 5% 成長、10% 折現率、2.5% 終值成長、21% 稅率；每點保存輸入、單位、假設與限制。這不是同期分析師共識、point-in-time 回測或客觀正確價格。

**重要限制：** FMP 歷史稀釋股數是否已因拆股回溯調整，尚無可確認的官方欄位語義。本版不假設可直接再調整、也不重複調整；在股數基準獲得確認前，季度模型點會標為 unavailable。非美元/ADR 比例無法確認、資料不足及金融業亦不顯示一般 DCF 估值。負現金流不會被市值比例替換。現行 DCF 只在來源輸入、股數、匯率與折現條件可用時估值。

## FMP 官方文件與方案限制

- [Historical Price EOD Full（Stable）](https://site.financialmodelingprep.com/developer/docs/stable/historical-price-eod-full)：本程式使用 `/stable/historical-price-eod/full`，以 `symbol`、`from`、`to` 取五個日曆年資料。官方文件區分 `close` 與 `adjClose`；後者包含拆股及股息調整，因此不適合直接與一般 DCF 每股價值比較。
- [Stock Split Details（Stable）](https://site.financialmodelingprep.com/developer/docs/stable/splits-company)：`/stable/splits?symbol=...` 的拆股日期、`numerator`、`denominator` 用於換算股價基準。
- [Stock Symbol Search（Stable）](https://site.financialmodelingprep.com/developer/docs/stable/search-symbol)：按供應商符號明確映射；例如 `BRK.B` 保留 FMP 點號格式，不盲目刪除標點。
- [FMP 方案與定價](https://site.financialmodelingprep.com/pricing-plans)：歷史 EOD 的可用年份、呼叫次數與方案權限可能依帳戶及方案改變。官方方案頁列出的免費每日呼叫額不足以假設完整 DCF 更新（230 檔股票另有其他財報/報價請求）；使用前請在自己的 FMP 帳戶確認權限與額度。五年每日資料約 1,250 個交易日，低於文件列示的單次 5,000 筆上限。

## 測試與覆蓋率

在 repository 根目錄執行：

```sh
python -m unittest discover -s tests -p 'test_*.py' -v
node --test tests/test_historical_chart.js
python validate_market_data.py --data full_market_dcf.json --report /tmp/historical-coverage.json
```

Fixture 測試不需要即時 API 金鑰，涵蓋錯誤/空回應、重試與 last-good、日期排序/重複、週末前一交易日、拆股換算、TTM 對齊、申報時間防前視、負 FCF、FX/ADR/金融業拒絕，以及圖表切換。資料驗證逐檔列出 230 個設定標的的價格日期/筆數、狀態與模型缺失原因。

本次未使用即時 FMP/Gemini 金鑰，亦未執行全市場重新估值。驗證 checkout 內既有資料得到 **230/230 檔有資料列，但 230/230 檔歷史價格狀態皆為 missing**；這是如實標示資料缺口，不代表已即時驗證所有股票。CI 的覆蓋率報告會寫入 `cache/historical_prices/coverage_report.json`。

## 安全刷新與部署

1. 先在 FMP 帳戶確認 Stable 歷史價格及拆股端點的方案權限與額度，並將有效金鑰放入 repository 的 GitHub Actions secret `FMP_API_KEY`。金鑰曾經以硬編碼方式存在舊版原始碼；請撤銷並輪替該金鑰，僅刪除目前檔案不能清除 Git 歷史。
2. GitHub Actions → **Daily US Stock Market DCF Auto-Refresh** → **Run workflow**，選取 `chart_only: true`。此模式只刷新圖表資料，不執行 DCF 或 Gemini；它會更新 `full_market_dcf.json`、由同一份資料產生 `market_data.js`，並產生每股覆蓋率報告。首次建立拆股快取可能每檔另需一次 API 呼叫；遇到方案限制時會保留舊資料並標示 stale/error。
3. `chart_only: false` 是既有全市場 DCF/AI 流程，不需要更新圖表時不要選用。CI 會先跑 fixture 測試，再驗證生成資料；測試或驗證失敗不會提交。
4. 本次只更新 PR 分支，未合併、未直接推送 production，也未觸發部署。請先在 PR 檢視程式差異、測試與 coverage report；由 repository 維護者決定是否合併。若 Vercel 已連接 `main`，合併後才會依該專案設定部署。

本圖表修正保證不把合成數字當成歷史價格或估值；不保證任何模型的經濟結果必然正確。
