(() => {
  "use strict";

  const SOURCES = {
    estimate: "https://tcgbusfs.blob.core.windows.net/blobbus/GetEstimateTime.gz",
    routes: "https://tcgbusfs.blob.core.windows.net/blobbus/GetRoute.gz",
    stops: "https://tcgbusfs.blob.core.windows.net/blobbus/GetStop.gz"
  };
  const ROUTE_NAME = "0東";
  const FALLBACK_ROUTE_ID = 10841; // 由題目指定的 GetRoute.gz 即時對照檔取得
  const UPDATE_MS = 60_000;
  const STATIC_REFRESH_MS = 6 * 60 * 60 * 1000;
  const STORAGE_KEY = "0dong-arrival-last-success-v1";
  const PAGE_HISTORY_LIMIT = 60;
  const INITIAL_ROWS = 15;
  const PAGE_ROWS = 15;
  const STATUS_CODES = {
    "-1": "尚未發車",
    "-2": "交管不停靠",
    "-3": "末班已過",
    "-4": "今日未營運"
  };

  const el = (id) => document.getElementById(id);
  const ui = {
    liveIndicator: el("liveIndicator"), connectionLabel: el("connectionLabel"),
    updateSummary: el("updateSummary"), updateDetails: el("updateDetails"),
    countdown: el("countdown"), refreshButton: el("refreshButton"),
    errorBanner: el("errorBanner"), staleBanner: el("staleBanner"),
    coverageNote: el("coverageNote"), longestStop: el("longestStop"),
    longestSubline: el("longestSubline"), longestDirection: el("longestDirection"),
    longestTime: el("longestTime"), averageWait: el("averageWait"),
    alertCount: el("alertCount"), stopCount: el("stopCount"),
    stopCountFoot: el("stopCountFoot"), priorityList: el("priorityList"),
    priorityFootnote: el("priorityFootnote"), barChart: el("barChart"),
    barDescription: el("barDescription"), barUpdated: el("barUpdated"),
    trendChart: el("trendChart"), trendCurrent: el("trendCurrent"),
    trendPoints: el("trendPoints"), searchInput: el("searchInput"),
    directionFilter: el("directionFilter"), sortOrder: el("sortOrder"),
    resultsCount: el("resultsCount"), stopsList: el("stopsList"),
    showMoreButton: el("showMoreButton"), dataTimestamp: el("dataTimestamp"),
    fetchTimestamp: el("fetchTimestamp"), liveAnnouncement: el("liveAnnouncement")
  };

  const state = {
    route: null,
    stopMap: new Map(),
    metadataUpdatedAt: 0,
    rows: [],
    dataTime: null,
    fetchedAt: null,
    nextUpdateAt: Date.now() + UPDATE_MS,
    loading: false,
    lastError: "",
    history: [],
    visibleRows: INITIAL_ROWS,
    isCached: false,
    lastMetaError: ""
  };

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[char]);
  }

  async function fetchGzipJson(url) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(url, { cache: "no-store", mode: "cors", signal: controller.signal });
      if (!response.ok) throw new Error("HTTP " + response.status + " " + response.statusText);
      const compressedBytes = await response.arrayBuffer();
      let jsonBytes;
      try {
        const stream = new Blob([compressedBytes]).stream().pipeThrough(new DecompressionStream("gzip"));
        jsonBytes = await new Response(stream).arrayBuffer();
      } catch (error) {
        throw new Error("gzip 解壓縮失敗：" + (error.message || error));
      }
      let payload;
      try {
        payload = JSON.parse(new TextDecoder("utf-8").decode(jsonBytes));
      } catch (error) {
        throw new Error("JSON 解析失敗：" + (error.message || error));
      }
      if (!payload || !payload.EssentialInfo || !Array.isArray(payload.BusInfo)) {
        throw new Error("資料格式與預期不符（缺少 EssentialInfo 或 BusInfo）");
      }
      return payload;
    } catch (error) {
      if (error.name === "AbortError") throw new Error("資料來源連線逾時（30 秒）");
      throw error;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function findRoute(routes) {
    const candidates = routes.filter((route) => String(route?.nameZh || "").trim() === ROUTE_NAME);
    return candidates.find((route) => String(route?.pathAttributeName || "").trim() === ROUTE_NAME)
      || candidates.find((route) => !String(route?.pathAttributeName || "").includes("狗狗"))
      || candidates[0]
      || null;
  }

  async function loadStaticMetadata() {
    state.lastMetaError = "";
    const [routeResult, stopResult] = await Promise.allSettled([
      fetchGzipJson(SOURCES.routes), fetchGzipJson(SOURCES.stops)
    ]);
    if (routeResult.status === "fulfilled") {
      const route = findRoute(routeResult.value.BusInfo);
      if (route) state.route = route;
      else state.lastMetaError = "路線對照檔中找不到 0東";
    } else {
      state.lastMetaError = "路線資料讀取失敗：" + routeResult.reason.message;
    }
    const routeId = state.route?.Id ?? FALLBACK_ROUTE_ID;
    if (stopResult.status === "fulfilled") {
      const stops = stopResult.value.BusInfo.filter((stop) => String(stop.routeId) === String(routeId));
      state.stopMap = new Map(stops.map((stop) => [String(stop.Id), stop]));
      if (!stops.length) state.lastMetaError = "站牌對照檔中找不到 0東站牌";
    } else {
      state.lastMetaError = state.lastMetaError
        ? state.lastMetaError + "；站牌資料讀取失敗"
        : "站牌資料讀取失敗：" + stopResult.reason.message;
    }
    state.metadataUpdatedAt = Date.now();
  }

  function parseTaipeiTime(value) {
    if (!value) return null;
    const match = String(value).match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/);
    if (match) {
      const [, y, month, day, hour, minute, second = "0"] = match;
      return new Date(Date.UTC(Number(y), Number(month) - 1, Number(day), Number(hour) - 8, Number(minute), Number(second)));
    }
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  function formatTaipeiTime(date, seconds = true) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "時間無法辨識";
    return new Intl.DateTimeFormat("zh-TW", {
      timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}), hour12: false
    }).format(date).replaceAll("/", "-");
  }

  function directionFor(stop, eta) {
    if (stop) {
      const value = String(stop.goBack);
      if (value === "0") return "go";
      if (value === "1") return "back";
    }
    return String(eta?.GoBack) === "0" ? "go" : "back";
  }

  function normalizeEstimate(eta) {
    const raw = String(eta?.EstimateTime ?? "").trim();
    if (Object.hasOwn(STATUS_CODES, raw)) return { waitSeconds: null, statusCode: raw, statusText: STATUS_CODES[raw] };
    if (raw === "") return { waitSeconds: null, statusCode: "", statusText: "沒有預估時間" };
    const number = Number(raw);
    if (Number.isFinite(number) && number >= 0) return { waitSeconds: number, statusCode: "", statusText: number === 0 ? "即將進站" : "倒數中" };
    return { waitSeconds: null, statusCode: raw, statusText: "資料狀態未定義" };
  }

  function buildRows(estimatePayload, routeId) {
    const estimates = estimatePayload.BusInfo.filter((item) => String(item.RouteID) === String(routeId));
    const estimateByStop = new Map();
    for (const estimate of estimates) {
      const key = String(estimate.StopID);
      const current = estimateByStop.get(key);
      if (!current) estimateByStop.set(key, estimate);
      else {
        const next = normalizeEstimate(estimate);
        const old = normalizeEstimate(current);
        if (next.waitSeconds !== null && (old.waitSeconds === null || next.waitSeconds < old.waitSeconds)) estimateByStop.set(key, estimate);
      }
    }

    const usedEstimateIds = new Set();
    const rows = [];
    for (const [stopId, stop] of state.stopMap) {
      const eta = estimateByStop.get(stopId) || null;
      if (eta) usedEstimateIds.add(stopId);
      rows.push(makeRow(stop, eta, stopId));
    }
    for (const [stopId, eta] of estimateByStop) {
      if (!usedEstimateIds.has(stopId)) rows.push(makeRow(null, eta, stopId));
    }
    rows.sort((a, b) => {
      if (a.direction !== b.direction) return a.direction === "go" ? -1 : 1;
      if (a.sequence !== b.sequence) return a.sequence - b.sequence;
      return a.name.localeCompare(b.name, "zh-Hant");
    });
    const stopPosition = { go: 0, back: 0 };
    for (const row of rows) row.displaySequence = ++stopPosition[row.direction];
    return rows;
  }

  function makeRow(stop, eta, stopId) {
    const estimate = normalizeEstimate(eta);
    return {
      key: directionFor(stop, eta) + ":" + stopId,
      stopId: String(stopId),
      name: String(stop?.nameZh || "站牌 " + stopId),
      sequence: Number.isFinite(Number(stop?.seqNo)) ? Number(stop.seqNo) : Number.MAX_SAFE_INTEGER,
      direction: directionFor(stop, eta),
      waitSeconds: estimate.waitSeconds,
      statusCode: estimate.statusCode,
      statusText: eta ? estimate.statusText : "尚無到站資料",
      hasEstimate: Boolean(eta),
      unmapped: !stop
    };
  }

  function formatWait(seconds, compact = false) {
    if (!Number.isFinite(seconds)) return "—";
    const whole = Math.max(0, Math.round(seconds));
    if (whole === 0) return "即將進站";
    const hours = Math.floor(whole / 3600);
    const minutes = Math.floor((whole % 3600) / 60);
    const rest = whole % 60;
    if (hours > 0) return compact ? hours + "小時" + minutes + "分" : hours + " 小時 " + minutes + " 分";
    if (minutes > 0) return compact ? minutes + "分" + String(rest).padStart(2,"0") + "秒" : minutes + " 分 " + String(rest).padStart(2,"0") + " 秒";
    return rest + " 秒";
  }

  function directionName(direction) {
    return direction === "back" ? "返程" : "去程";
  }

  function directionDescription(direction) {
    return direction === "back" ? "臺北車站往內湖" : "內湖往臺北車站";
  }

  function validRows(rows = state.rows) {
    return rows.filter((row) => Number.isFinite(row.waitSeconds) && row.waitSeconds >= 0);
  }

  function setLoading(loading) {
    state.loading = loading;
    ui.refreshButton.disabled = loading;
    ui.refreshButton.innerHTML = loading ? '<span aria-hidden="true">↻</span> 更新中…' : '<span aria-hidden="true">↻</span> 立即更新';
    ui.liveIndicator.classList.toggle("is-loading", loading);
    if (loading) ui.connectionLabel.textContent = "資料更新中";
    else if (!state.lastError && state.rows.length) ui.connectionLabel.textContent = state.isCached ? "保留上次資料" : "即時資料";
  }

  function storeSnapshot() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        rows: state.rows, dataTime: state.dataTime?.toISOString() || null,
        fetchedAt: state.fetchedAt?.toISOString() || null, routeId: state.route?.Id || FALLBACK_ROUTE_ID
      }));
    } catch { /* 私密瀏覽或儲存空間關閉時，仍可在本頁正常顯示。 */ }
  }

  function restoreSnapshot() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (!saved || !Array.isArray(saved.rows) || !saved.rows.length) return false;
      state.rows = saved.rows;
      state.dataTime = saved.dataTime ? new Date(saved.dataTime) : null;
      state.fetchedAt = saved.fetchedAt ? new Date(saved.fetchedAt) : null;
      state.isCached = true;
      renderAll();
      ui.updateSummary.textContent = "暫時顯示上次成功讀取的資料";
      ui.updateDetails.textContent = state.fetchedAt ? "上次成功抓取：" + formatTaipeiTime(state.fetchedAt) : "正在重新連線官方即時資料";
      ui.connectionLabel.textContent = "保留上次資料";
      return true;
    } catch { return false; }
  }

  async function refreshNow() {
    if (state.loading) return;
    setLoading(true);
    ui.errorBanner.hidden = true;
    const needsMetadata = !state.metadataUpdatedAt || Date.now() - state.metadataUpdatedAt >= STATIC_REFRESH_MS;
    try {
      const metadataPromise = needsMetadata ? loadStaticMetadata() : Promise.resolve();
      const estimatePromise = fetchGzipJson(SOURCES.estimate);
      const [estimatePayload] = await Promise.all([estimatePromise, metadataPromise]);
      const routeId = state.route?.Id ?? FALLBACK_ROUTE_ID;
      const routeRows = buildRows(estimatePayload, routeId);
      if (!routeRows.length) throw new Error("即時資料內找不到路線代碼 " + routeId + " 的到站紀錄");
      state.rows = routeRows;
      state.dataTime = parseTaipeiTime(estimatePayload.EssentialInfo.UpdateTime);
      state.fetchedAt = new Date();
      state.isCached = false;
      state.lastError = "";
      state.nextUpdateAt = Date.now() + UPDATE_MS;
      state.history.push({ time: state.fetchedAt.getTime(), seconds: maxWait(routeRows)?.waitSeconds ?? null });
      if (state.history.length > PAGE_HISTORY_LIMIT) state.history.shift();
      storeSnapshot();
      ui.updateSummary.textContent = "已連上臺北市公共運輸處";
      ui.updateDetails.textContent = state.lastMetaError
        ? "到站資料已更新；" + state.lastMetaError
        : "最新資料時間 " + (state.dataTime ? formatTaipeiTime(state.dataTime) : "未提供");
      ui.connectionLabel.textContent = "即時資料";
      ui.liveIndicator.classList.remove("is-error");
      ui.errorBanner.hidden = true;
      ui.liveAnnouncement.textContent = "資料更新成功，" + formatTaipeiTime(state.fetchedAt) + "。";
    } catch (error) {
      state.lastError = error?.message || String(error);
      state.nextUpdateAt = Date.now() + UPDATE_MS;
      ui.updateSummary.textContent = state.rows.length ? "更新失敗，保留上次成功資料" : "目前無法取得即時資料";
      ui.updateDetails.textContent = state.rows.length && state.fetchedAt
        ? "畫面保留 " + formatTaipeiTime(state.fetchedAt) + " 的成功資料" : "請檢查網路，系統會在倒數後自動重試";
      ui.connectionLabel.textContent = state.rows.length ? "暫時離線" : "連線失敗";
      ui.liveIndicator.classList.remove("is-loading");
      ui.liveIndicator.classList.add("is-error");
      ui.errorBanner.hidden = false;
      ui.errorBanner.textContent = "更新失敗，稍後自動重試。" + (state.rows.length ? "目前仍顯示上一次成功的資料。" : "尚無可保留的成功資料。") + "（" + state.lastError + "）";
      ui.liveAnnouncement.textContent = "即時資料更新失敗，系統會稍後自動重試。";
    } finally {
      setLoading(false);
      renderAll();
    }
  }

  function maxWait(rows = state.rows) {
    return validRows(rows).sort((a, b) => b.waitSeconds - a.waitSeconds || a.sequence - b.sequence)[0] || null;
  }

  function sortedRows(rows, order) {
    const copy = [...rows];
    if (order === "wait-asc") return copy.sort((a,b) => {
      const av = Number.isFinite(a.waitSeconds) ? a.waitSeconds : Number.POSITIVE_INFINITY;
      const bv = Number.isFinite(b.waitSeconds) ? b.waitSeconds : Number.POSITIVE_INFINITY;
      return av - bv || a.sequence - b.sequence;
    });
    if (order === "sequence") return copy.sort((a,b) =>
      (a.direction === "go" ? 0 : 1) - (b.direction === "go" ? 0 : 1) || a.sequence - b.sequence
    );
    return copy.sort((a,b) => {
      const av = Number.isFinite(a.waitSeconds) ? a.waitSeconds : -1;
      const bv = Number.isFinite(b.waitSeconds) ? b.waitSeconds : -1;
      return bv - av || a.sequence - b.sequence;
    });
  }

  function filteredRows() {
    const query = ui.searchInput.value.trim().toLocaleLowerCase("zh-Hant");
    const direction = ui.directionFilter.value;
    const rows = state.rows.filter((row) => {
      const directionMatch = direction === "all" || row.direction === direction;
      const textMatch = !query || row.name.toLocaleLowerCase("zh-Hant").includes(query) || row.stopId.includes(query);
      return directionMatch && textMatch;
    });
    return sortedRows(rows, ui.sortOrder.value);
  }

  function renderSummary() {
    const valid = validRows();
    const longest = maxWait();
    const topThree = [...valid].sort((a,b) => b.waitSeconds - a.waitSeconds || a.sequence - b.sequence).slice(0,3);
    const average = valid.length ? valid.reduce((sum,row) => sum + row.waitSeconds, 0) / valid.length : null;
    const mapped = state.rows.filter((row) => !row.unmapped).length;
    ui.coverageNote.textContent = state.rows.length ? valid.length + " 站有有效倒數 · " + state.rows.filter((row) => row.unmapped).length + " 筆缺站名對照" : "資料載入中";
    ui.longestStop.textContent = longest ? longest.name : (state.rows.length ? "目前沒有有效倒數" : "正在讀取站牌…");
    ui.longestSubline.textContent = longest
      ? directionName(longest.direction) + " · " + directionDescription(longest.direction) + (longest.unmapped ? " · 站名待對照" : "")
      : state.rows.length ? "尚未取得可計算的預估到站時間" : "請稍候，正在連接臺北市公共運輸處";
    ui.longestDirection.textContent = longest ? directionName(longest.direction) : "等待資料";
    ui.longestTime.textContent = longest ? formatWait(longest.waitSeconds, true) : "—";
    ui.averageWait.innerHTML = average === null ? "—" : formatAverage(average);
    ui.alertCount.innerHTML = topThree.length + "<small> 站</small>";
    ui.stopCount.innerHTML = (state.rows.length || "—") + "<small> 站</small>";
    ui.stopCountFoot.textContent = state.rows.length ? "站牌對照 " + mapped + " 筆 · 去程與返程" : "去程與返程合併統計";
    ui.priorityList.innerHTML = topThree.length ? topThree.map((row,index) =>
      '<li class="priority-item">' +
        '<span class="priority-rank">' + String(index+1).padStart(2,"0") + '</span>' +
        '<span class="priority-main"><span class="priority-name">' + escapeHtml(row.name) + (row.unmapped ? " · 站名待對照" : "") + '</span>' +
        '<span class="priority-meta">' + directionName(row.direction) + " · " + directionDescription(row.direction) + " · 站牌 " + escapeHtml(row.stopId) + '</span></span>' +
        '<strong class="priority-wait">' + escapeHtml(formatWait(row.waitSeconds,true)) + '</strong>' +
      '</li>'
    ).join("") : '<li class="empty-row">目前沒有可計算的預估到站時間。</li>';
    ui.priorityFootnote.textContent = "共 " + topThree.length + " 個有效站牌進入目前提醒排行；未發車、交管不停靠、末班已過、今日未營運等狀態不列入等待時間排行。";
    ui.dataTimestamp.textContent = state.dataTime ? formatTaipeiTime(state.dataTime) : "來源未提供";
    ui.fetchTimestamp.textContent = state.fetchedAt ? formatTaipeiTime(state.fetchedAt) : "—";
    const stale = state.dataTime && (Date.now() - state.dataTime.getTime() > 30 * 60_000);
    ui.staleBanner.hidden = !stale;
    ui.barUpdated.textContent = state.fetchedAt ? "抓取 " + formatTaipeiTime(state.fetchedAt,false) : "每分鐘更新";
    if (longest) {
      ui.trendCurrent.textContent = formatWait(longest.waitSeconds,true);
      ui.trendCurrent.title = longest.name;
    } else ui.trendCurrent.textContent = "—";
  }

  function formatAverage(seconds) {
    if (seconds >= 3600) return (seconds/3600).toFixed(1) + "<small> 小時</small>";
    const mins = seconds / 60;
    return (mins < 10 ? mins.toFixed(1) : Math.round(mins)) + "<small> 分</small>";
  }

  function renderPriorityChart(rows) {
    const ranking = [...validRows(rows)].sort((a,b) => b.waitSeconds - a.waitSeconds).slice(0,7);
    ui.barDescription.textContent = ui.searchInput.value || ui.directionFilter.value !== "all"
      ? "目前篩選結果中，等待時間較長的 " + ranking.length + " 個站牌" : "全線目前等待時間較長的 " + ranking.length + " 個站牌";
    if (!ranking.length) {
      ui.barChart.innerHTML = '<div class="chart-empty">目前篩選範圍沒有可比較的預估時間。</div>';
      ui.barChart.setAttribute("aria-label", "目前沒有可比較的等待時間");
      return;
    }
    const max = Math.max(...ranking.map((row) => row.waitSeconds), 1);
    ui.barChart.innerHTML = ranking.map((row) => {
      const width = Math.max(2, row.waitSeconds / max * 100);
      return '<div class="bar-row"><span class="bar-name" title="' + escapeHtml(row.name) + " · " + directionName(row.direction) + '">' +
        escapeHtml(row.name) + '</span><span class="bar-track"><span class="bar-fill" style="width:' + width.toFixed(1) +
        '%"></span></span><strong class="bar-value">' + escapeHtml(formatWait(row.waitSeconds,true)) + '</strong></div>';
    }).join("");
    ui.barChart.setAttribute("aria-label", "目前篩選範圍最長等待為 " + ranking[0].name + "，" + formatWait(ranking[0].waitSeconds));
  }

  function renderTrend() {
    const history = state.history.filter((point) => Number.isFinite(point.seconds));
    if (!history.length) {
      ui.trendChart.innerHTML = '<div class="chart-empty">第一次資料讀取成功後，開始記錄折線。</div>';
      ui.trendPoints.textContent = "成功更新後會新增一個資料點";
      return;
    }
    const width = 980, height = 124, pad = { left: 16, right: 18, top: 14, bottom: 25 };
    const plotW = width - pad.left - pad.right, plotH = height - pad.top - pad.bottom;
    const values = history.map((point) => point.seconds / 60);
    let min = Math.min(...values), max = Math.max(...values);
    if (min === max) { min = Math.max(0, min - 1); max += 1; }
    const spread = max - min; min = Math.max(0, min - spread * .18); max += spread * .18;
    const points = history.map((point,index) => {
      const x = history.length === 1 ? pad.left + plotW / 2 : pad.left + index / (history.length - 1) * plotW;
      const y = pad.top + (max - point.seconds / 60) / (max - min) * plotH;
      return { x, y, point, value: point.seconds / 60 };
    });
    const polyline = points.map((p) => p.x.toFixed(1) + "," + p.y.toFixed(1)).join(" ");
    const area = pad.left + "," + (height-pad.bottom) + " " + polyline + " " + (pad.left+plotW) + "," + (height-pad.bottom);
    const tickYs = [pad.top + 4, pad.top + plotH / 2, pad.top + plotH];
    const first = points[0], last = points.at(-1);
    const tickLines = tickYs.map((y) => '<line class="trend-gridline" x1="' + pad.left + '" x2="' + (width-pad.right) + '" y1="' + y + '" y2="' + y + '"/>').join("");
    const dots = points.map((point,index) => '<circle class="trend-point" cx="' + point.x.toFixed(1) + '" cy="' + point.y.toFixed(1) +
      '" r="' + (index===points.length-1 ? 5 : 3) + '"/>').join("");
    ui.trendChart.innerHTML =
      '<svg viewBox="0 0 ' + width + " " + height + '" preserveAspectRatio="none" role="img" aria-label="最長等待時間趨勢，目前 ' +
      escapeHtml(formatWait(last.point.seconds,true)) + "，" + history.length + ' 個資料點">' +
      '<defs><linearGradient id="trendFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="#75a784" stop-opacity=".22"/><stop offset="100%" stop-color="#75a784" stop-opacity="0"/></linearGradient></defs>' +
      tickLines + '<polygon class="trend-area" points="' + area + '"/><polyline class="trend-path" points="' + polyline + '"/>' +
      dots + '<text class="trend-axis-label" x="' + pad.left + '" y="' + (height-5) + '">' + formatTaipeiTime(new Date(first.point.time),false).slice(-5) + '</text>' +
      '<text class="trend-axis-label" text-anchor="end" x="' + (width-pad.right) + '" y="' + (height-5) + '">' + formatTaipeiTime(new Date(last.point.time),false).slice(-5) + '</text></svg>';
    ui.trendPoints.textContent = "本頁成功抓取 " + history.length + " 次 · 最長等待由 " + formatWait(history[0].seconds,true) + " 變為 " + formatWait(last.point.seconds,true);
  }

  function arrivalPresentation(row) {
    if (Number.isFinite(row.waitSeconds)) {
      const cls = row.waitSeconds <= 180 ? "urgent" : row.waitSeconds <= 600 ? "soon" : "";
      return { time: formatWait(row.waitSeconds,true), status: row.waitSeconds === 0 ? "即將進站" : "預估到站", cls };
    }
    return { time: row.statusText || "尚無到站資料", status: row.statusCode ? "代碼 " + row.statusCode : "等待下一筆預估", cls: "no-estimate" };
  }

  function renderStops() {
    const rows = filteredRows();
    ui.resultsCount.textContent = state.rows.length ? "顯示 " + rows.length + " / 全線 " + state.rows.length + " 站" : "等待資料";
    const visible = rows.slice(0, state.visibleRows);
    ui.showMoreButton.hidden = rows.length <= visible.length;
    ui.showMoreButton.textContent = "再顯示 " + Math.min(PAGE_ROWS, rows.length-visible.length) + " 站";
    if (!visible.length) {
      ui.stopsList.innerHTML = '<div class="no-results">' +
        (state.rows.length ? "找不到符合條件的站牌，試試其他關鍵字或方向。" : "資料載入後會顯示全線站牌。") + '</div>';
      return;
    }
    ui.stopsList.innerHTML = visible.map((row) => {
      const arrival = arrivalPresentation(row);
      const seq = Number.isFinite(row.displaySequence) ? "第 " + row.displaySequence + " 站" : "站序未提供";
      return '<article class="stop-row ' + (row.unmapped ? "unknown-stop" : "") + '">' +
        '<div class="stop-title"><span class="stop-sequence">' + (Number.isFinite(row.displaySequence) ? row.displaySequence : "?") +
        '</span><span class="stop-name-wrap"><strong class="stop-name">' + escapeHtml(row.name) + '</strong><small class="stop-id">' +
        seq + " · 站牌代碼 " + escapeHtml(row.stopId) + '</small></span></div>' +
        '<span class="direction-label ' + (row.direction === "back" ? "back" : "") + '">' + directionName(row.direction) +
        '<span class="sr-only">，' + directionDescription(row.direction) + '</span></span>' +
        '<span class="arrival-cell"><strong class="arrival-time ' + arrival.cls + '">' + escapeHtml(arrival.time) +
        '</strong><small class="arrival-status">' + escapeHtml(arrival.status) + '</small></span></article>';
    }).join("");
  }

  function renderAll() {
    renderSummary();
    renderPriorityChart(filteredRows());
    renderTrend();
    renderStops();
  }

  function updateCountdown() {
    const seconds = Math.max(0, Math.ceil((state.nextUpdateAt - Date.now()) / 1000));
    const minutes = Math.floor(seconds / 60);
    ui.countdown.textContent = String(minutes).padStart(2,"0") + ":" + String(seconds % 60).padStart(2,"0");
  }

  ui.refreshButton.addEventListener("click", () => refreshNow());
  ui.searchInput.addEventListener("input", () => { state.visibleRows = INITIAL_ROWS; renderPriorityChart(filteredRows()); renderStops(); });
  ui.directionFilter.addEventListener("change", () => { state.visibleRows = INITIAL_ROWS; renderPriorityChart(filteredRows()); renderStops(); });
  ui.sortOrder.addEventListener("change", () => { state.visibleRows = INITIAL_ROWS; renderStops(); });
  ui.showMoreButton.addEventListener("click", () => { state.visibleRows += PAGE_ROWS; renderStops(); });
  window.setInterval(updateCountdown, 1000);
  window.setInterval(() => refreshNow(), UPDATE_MS);

  restoreSnapshot();
  refreshNow();
})();


