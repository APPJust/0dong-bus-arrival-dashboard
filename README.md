# 0東公車到站看板

臺北市公車 0東去程與返程的即時到站儀表板，直接讀取臺北市公共運輸處公開資料。

## 功能

- 以瀏覽器直接讀取 gzip JSON，約每 1 分鐘自動更新，亦可手動更新。
- 顯示資料提供時間、頁面抓取時間及距下次更新倒數。
- 依有效秒數顯示全線最久等待、平均等待、站牌數及最久等待前三名。
- 提供等待時間長條圖、開啟本頁後的趨勢折線、站名搜尋、方向篩選與排序。
- 排除未發車、交管不停靠、末班已過、今日未營運等狀態碼，不將它們當成等待秒數。
- 網路更新失敗時保留最近一次成功資料；資料時間超過 30 分鐘時顯示延遲提示。
- 站名對照缺漏時以站牌代碼保留資料，不隱藏來源紀錄。
- 支援窄螢幕瀏覽，無外部執行期套件或第三方 CDN。

## 資料來源與授權

- 提供機關：臺北市公共運輸處。
- 到站預估：<https://tcgbusfs.blob.core.windows.net/blobbus/GetEstimateTime.gz>
- 路線對照：<https://tcgbusfs.blob.core.windows.net/blobbus/GetRoute.gz>
- 站牌對照：<https://tcgbusfs.blob.core.windows.net/blobbus/GetStop.gz>
- 資料集頁面：<https://data.gov.tw/dataset/129025>
- 授權：政府資料開放授權條款－第 1 版；請以資料集頁面與授權頁當下說明為準。
- 署名：資通系 李振偉老師。

本儀表板的趨勢線只記錄目前頁面工作階段成功取得的資料，不會補造過去資料。

## 本機預覽

以任何靜態 HTTP 伺服器從本目錄提供 index.html 即可。直接以 file:// 開啟可能受到瀏覽器 CORS 規則限制。

## GitHub Pages

此儲存庫包含 GitHub Actions 工作流程。將程式推送至 main 分支後，工作流程會將 index.html、styles.css 與 app.js 封裝至 dist 並部署到 GitHub Pages。首次使用時，請在儲存庫 Settings > Pages 將 Build and deployment 的 Source 設為 GitHub Actions。

## 重要限制

即時資料直接由訪客瀏覽器連線至公開資料端點；資料端點、瀏覽器或網路中斷時會保留最後一次成功資料，並明確顯示更新失敗。若官方資料格式改變，需更新解析程式。


