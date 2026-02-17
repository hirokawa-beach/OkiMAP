// https://github.com/hirokawa-beach/OkiMAP/blob/main/map_interaction.js
// --- 設定 ---
const MIN_ZOOM_TO_SHOW = 8; // グリッド／オーバーレイを描画する最小ズーム

// 固定値
const TILE_SIZE = 256;
const NATIVE_MAX = 7;
const DISPLAY_MAX = 12;
const RENDER_MODE = "smooth"; // 固定

// 内部固定の元画像サイズ
const IMG_W = 12000;
const IMG_H = 10000;

// --- タイムスタンプリスト設定 ---
const TIMESTAMPS_URL = "https://hb-raspi1.wplaceoki.com/okimap/timestamps.txt";
const DEFAULT_TIMESTAMP = "202508192059";
const STORAGE_KEY = "okimap_state_v1";

// --- 状態とキャッシュ ---
let map;
let activeTileLayer = null; // 現在表示中の tile layer（ダブルバッファ用）
let loadingSwitch = null; // 進行中の切替操作の参照（中断用）
let tileFetchController = null; // fetch() 中断用（タイル取得）
let tileFetchQueue = [];
let tileFetchInFlight = 0;
const MAX_TILE_FETCH_INFLIGHT = 6;
const tileCache = new Map(); // キャッシュ: "timestamp/z/x/y" -> ImageBitmap
const tilePixelCache = new Map(); // キャッシュ: "timestamp/z/x/y" -> {w,h,data}
const MAX_TILE_CACHE = 800; // 画像タイルキャッシュ上限
const MAX_TILE_PIXEL_CACHE = 120; // ピクセルキャッシュ上限（重いので小さめ）
const MAX_SAMPLES = 1000000; // 最大サンプル数（自動間引きの閾値）
let isInteracting = false;
let redrawTimer = null;
let isSnappingZoom = false;
let isMapReady = false;
let savedState = null;
let initialLoading = true;
let preloadController = null;
let preloadQueue = [];
let preloadInFlight = 0;
let isPreloading = false;
let preloadRunId = 0;
const MAX_PRELOAD_INFLIGHT = 2;
const MAX_PRELOAD_TASKS = 4000;

// 表示用タイル座標系（pixel: 0,0 を 1791,901,0,0 に対応）
const DISPLAY_TILE_BASE_X = 1791;
const DISPLAY_TILE_BASE_Y = 901;
const DISPLAY_TILE_SIZE = 1000;

// タイムスタンプデータ構造
const timestampsByDate = new Map();
let timestampLines = []; // ファイルの行順を保持（上から順に）
let currentTimestampFull = null; // 'YYYYMMDDhhmm' or null
let uniqueDates = []; // ['YYYY-MM-DD', ...] for select

// ----- UI 要素参照 -----
const ctrl = {
  dateSelect: document.getElementById("dateSelect"),
  prevDate: document.getElementById("prevDate"),
  nextDate: document.getElementById("nextDate"),
  zoomSnap: document.getElementById("zoomSnap"),
  sampleStep: document.getElementById("sampleStep"),
  overlayOpacity: document.getElementById("overlayOpacity"),
  pixelOutput: document.getElementById("pixelOutput"),
  colorSwatch: document.getElementById("colorSwatch"),
  pixelText: document.getElementById("pixelText"),
  copyColor: document.getElementById("copyColor"),
  clearCache: document.getElementById("clearCache"),
  pixelPickerToggle: document.getElementById("pixelPickerToggle"),
  pixelGridToggle: document.getElementById("pixelGridToggle"),
  colorizeToggle: document.getElementById("colorizeToggle"),
  applyBtn: document.getElementById("applyBtn"),
  undoBtn: document.getElementById("undoBtn"),
  fitBtn: document.getElementById("fitBtn"),
  zoomInfo: document.getElementById("zoomInfo"),
  coordsInfo: document.getElementById("coordsInfo"),
  settingsBtn: document.getElementById("settingsBtn"),
  infoBtn: document.getElementById("infoBtn"),
  updatesBtn: document.getElementById("updatesBtn"),
  controlPanel: document.getElementById("controlPanel"),
  infoPanel: document.getElementById("infoPanel"),
  updatesPanel: document.getElementById("updatesPanel"),
  gridMinScreen: document.getElementById("gridMinScreen"),
  preloadRange: document.getElementById("preloadRange"),
  timeLabel: document.getElementById("timeLabel"),
  dateSlider: document.getElementById("dateSlider"),
  dateSliderInfo: document.getElementById("dateSliderInfo"),
  dateSliderBar: document.getElementById("dateSliderBar"),
  preloadBtn: document.getElementById("preloadBtn"),
  preloadInfo: document.getElementById("preloadInfo"),
};

const canvas = document.getElementById("pixelGridCanvas");
const ctx = canvas.getContext("2d");
const pixelMarker = document.getElementById("pixelMarker");

let appliedSettings = null;
let settingsDirty = false;
let isSettingsPanelOpen = false;
let panelSnapshot = null;
let panelBaseline = null;

function getSettingsFromControls() {
  return {
    zoomSnap: ctrl.zoomSnap?.value ?? "",
    sampleStep: ctrl.sampleStep?.value ?? "",
    overlayOpacity: ctrl.overlayOpacity?.value ?? "",
    gridMinScreen: ctrl.gridMinScreen?.value ?? "",
    preloadRange: ctrl.preloadRange?.value ?? "",
    pixelPicker: !!ctrl.pixelPickerToggle?.checked,
    pixelGrid: !!ctrl.pixelGridToggle?.checked,
    colorize: !!ctrl.colorizeToggle?.checked,
  };
}

function setControlsFromSettings(s) {
  if (!s) return;
  if (ctrl.zoomSnap && s.zoomSnap != null)
    ctrl.zoomSnap.value = String(s.zoomSnap);
  if (ctrl.sampleStep && s.sampleStep != null)
    ctrl.sampleStep.value = String(s.sampleStep);
  if (ctrl.overlayOpacity && s.overlayOpacity != null)
    ctrl.overlayOpacity.value = String(s.overlayOpacity);
  if (ctrl.gridMinScreen && s.gridMinScreen != null)
    ctrl.gridMinScreen.value = String(s.gridMinScreen);
  if (ctrl.preloadRange && s.preloadRange != null)
    ctrl.preloadRange.value = String(s.preloadRange);
  if (ctrl.pixelPickerToggle && typeof s.pixelPicker === "boolean")
    ctrl.pixelPickerToggle.checked = s.pixelPicker;
  if (ctrl.pixelGridToggle && typeof s.pixelGrid === "boolean")
    ctrl.pixelGridToggle.checked = s.pixelGrid;
  if (ctrl.colorizeToggle && typeof s.colorize === "boolean")
    ctrl.colorizeToggle.checked = s.colorize;
}

function areSettingsEqual(a, b) {
  if (!a || !b) return false;
  return (
    a.zoomSnap === b.zoomSnap &&
    a.sampleStep === b.sampleStep &&
    a.overlayOpacity === b.overlayOpacity &&
    a.gridMinScreen === b.gridMinScreen &&
    a.preloadRange === b.preloadRange &&
    a.pixelPicker === b.pixelPicker &&
    a.pixelGrid === b.pixelGrid &&
    a.colorize === b.colorize
  );
}

function updateSettingsDirtyState() {
  if (!isSettingsPanelOpen || !panelBaseline) {
    settingsDirty = false;
  } else {
    settingsDirty = !areSettingsEqual(getSettingsFromControls(), panelBaseline);
  }
  if (ctrl.applyBtn) ctrl.applyBtn.dataset.dirty = settingsDirty ? "1" : "";
  if (ctrl.controlPanel)
    ctrl.controlPanel.classList.toggle("has-dirty", settingsDirty);
  if (ctrl.undoBtn)
    ctrl.undoBtn.disabled =
      !panelSnapshot ||
      areSettingsEqual(getSettingsFromControls(), panelSnapshot);
}

// ベース URL
const BASE_TILE_HOST = "https://hb-raspi1.wplaceoki.com/okimap/img";

// タイル URL 組み立て（12桁のタイムスタンプのみ許可）
function normalizeStamp(stamp) {
  return /^\d{12}$/.test(stamp || "") ? stamp : null;
}

function buildTileUrlForStamp(stamp, z, x, y) {
  const stampPart =
    normalizeStamp(stamp) || normalizeStamp(currentTimestampFull);
  if (!stampPart) return null;
  return `${BASE_TILE_HOST}/${stampPart}/${z}/${x}/${y}.png?native=${z}`;
}

// LRU 風の簡易キャッシュ制御
function setCacheWithLimit(mapObj, key, value, limit) {
  if (mapObj.has(key)) mapObj.delete(key);
  mapObj.set(key, value);
  if (mapObj.size > limit) {
    const oldestKey = mapObj.keys().next().value;
    if (oldestKey !== undefined) mapObj.delete(oldestKey);
  }
}

function toDisplayTileCoords(px, py) {
  const tileX = DISPLAY_TILE_BASE_X + Math.floor(px / DISPLAY_TILE_SIZE);
  const tileY = DISPLAY_TILE_BASE_Y + Math.floor(py / DISPLAY_TILE_SIZE);
  const inX =
    ((px % DISPLAY_TILE_SIZE) + DISPLAY_TILE_SIZE) % DISPLAY_TILE_SIZE;
  const inY =
    ((py % DISPLAY_TILE_SIZE) + DISPLAY_TILE_SIZE) % DISPLAY_TILE_SIZE;
  return { tileX, tileY, inX, inY };
}

function getTileRangeForZoom(z) {
  const scale = Math.pow(2, NATIVE_MAX - z);
  const w = IMG_W / scale;
  const h = IMG_H / scale;
  const tilesX = Math.max(1, Math.ceil(w / TILE_SIZE));
  const tilesY = Math.max(1, Math.ceil(h / TILE_SIZE));
  return { tilesX, tilesY };
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}


function getVisibleTileRange(z) {
  if (!map) return null;
  const bounds = map.getPixelBounds(z);
  if (!bounds) return null;
  const minX = Math.floor(bounds.min.x / TILE_SIZE);
  const maxX = Math.floor((bounds.max.x - 1) / TILE_SIZE);
  const minY = Math.floor(bounds.min.y / TILE_SIZE);
  const maxY = Math.floor((bounds.max.y - 1) / TILE_SIZE);
  const { tilesX, tilesY } = getTileRangeForZoom(z);
  return {
    minX: clamp(minX, 0, tilesX - 1),
    maxX: clamp(maxX, 0, tilesX - 1),
    minY: clamp(minY, 0, tilesY - 1),
    maxY: clamp(maxY, 0, tilesY - 1),
  };
}

function isAbortError(err) {
  return !!err && (err.name === "AbortError" || err.code === 20);
}

function resetTileFetchQueue() {
  for (const job of tileFetchQueue) {
    try {
      job.reject(new DOMException("Aborted", "AbortError"));
    } catch (e) {}
  }
  tileFetchQueue = [];
  tileFetchInFlight = 0;
}

function pumpTileFetchQueue() {
  while (
    tileFetchInFlight < MAX_TILE_FETCH_INFLIGHT &&
    tileFetchQueue.length > 0
  ) {
    const job = tileFetchQueue.shift();
    if (!job) continue;
    const { fn, resolve, reject, signal } = job;
    if (signal && signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      continue;
    }
    tileFetchInFlight++;
    fn()
      .then(resolve, reject)
      .finally(() => {
        tileFetchInFlight--;
        pumpTileFetchQueue();
      });
  }
}

function enqueueTileFetch(fn, signal) {
  return new Promise((resolve, reject) => {
    tileFetchQueue.push({ fn, resolve, reject, signal });
    pumpTileFetchQueue();
  });
}

function resetPreloadQueue() {
  for (const job of preloadQueue) {
    try {
      job.reject(new DOMException("Aborted", "AbortError"));
    } catch (e) {}
  }
  preloadQueue = [];
  preloadInFlight = 0;
}

function pumpPreloadQueue() {
  while (preloadInFlight < MAX_PRELOAD_INFLIGHT && preloadQueue.length > 0) {
    const job = preloadQueue.shift();
    if (!job) continue;
    const { fn, resolve, reject, signal } = job;
    if (signal && signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      continue;
    }
    preloadInFlight++;
    fn()
      .then(resolve, reject)
      .finally(() => {
        preloadInFlight--;
        pumpPreloadQueue();
      });
  }
}

function enqueuePreload(fn, signal) {
  return new Promise((resolve, reject) => {
    preloadQueue.push({ fn, resolve, reject, signal });
    pumpPreloadQueue();
  });
}

// --- タイムスタンプリスト取得 ---
async function fetchTimestampList() {
  try {
    const resp = await fetch(TIMESTAMPS_URL);
    if (!resp.ok) {
      console.warn("timestamps.txt fetch failed:", resp.status);
      return;
    }
    const txt = await resp.text();
    parseTimestampList(txt);
  } catch (err) {
    console.warn("failed to fetch timestamps list:", err);
  }
}
function parseTimestampList(text) {
  timestampsByDate.clear();
  timestampLines = [];
  uniqueDates = [];
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (const line of lines) {
    if (!/^\d{12}$/.test(line)) continue;
    timestampLines.push(line);
    const datePart = line.slice(0, 8); // YYYYMMDD
    const timePart = line.slice(8); // hhmm
    if (!timestampsByDate.has(datePart)) timestampsByDate.set(datePart, []);
    timestampsByDate.get(datePart).push(timePart);
  }
  // sort times descending (latest first) per date
  for (const [k, arr] of timestampsByDate.entries()) {
    arr.sort((a, b) => b.localeCompare(a));
  }
  // build uniqueDates (YYYY-MM-DD) sorted descending (latest first)
  const dates = Array.from(timestampsByDate.keys()).sort((a, b) =>
    b.localeCompare(a),
  );
  uniqueDates = dates.map(
    (d) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`,
  );
  populateDateSelect();
  setupSlider();
}

function showLoading() {
  const el = document.getElementById("loadingOverlay");
  if (el) el.classList.add("is-visible");
}

function hideLoading() {
  const el = document.getElementById("loadingOverlay");
  if (el) el.classList.remove("is-visible");
}

function loadSavedState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (e) {
    return null;
  }
}

function saveState(patch = {}) {
  const next = {
    ...(savedState || {}),
    ...patch,
  };
  savedState = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch (e) {}
}

// populate date select with available dates only
function populateDateSelect() {
  const sel = ctrl.dateSelect;
  if (!sel) return;
  if (uniqueDates.length === 0) {
    sel.value = "";
    sel.min = "";
    sel.max = "";
    return;
  }
  const newest = uniqueDates[0];
  const oldest = uniqueDates[uniqueDates.length - 1];
  sel.min = oldest;
  sel.max = newest;
  if (!sel.value || sel.value < sel.min || sel.value > sel.max) {
    sel.value = newest;
  }
}

// --- スライダー関連 ---
function setupSlider() {
  const slider = ctrl.dateSlider;
  const info = ctrl.dateSliderInfo;
  if (!slider || !info) return;
  if (!timestampLines || timestampLines.length === 0) {
    if (ctrl.dateSliderBar) ctrl.dateSliderBar.style.display = "none";
    return;
  }
  ctrl.dateSliderBar.style.display = "flex";
  slider.min = 0;
  slider.max = Math.max(0, timestampLines.length - 1);
  const idx = currentTimestampFull
    ? timestampLines.indexOf(currentTimestampFull)
    : 0;
  slider.value = idx >= 0 ? idx : 0;
  info.textContent = `${parseInt(slider.value, 10) + 1} / ${timestampLines.length}`;
}

// set current timestamp by index from timestampLines
let sliderUpdateTimer = null;
function setTimestampByIndex(index, { preserveView = true } = {}) {
  if (!timestampLines || index < 0 || index >= timestampLines.length) return;
  currentTimestampFull = timestampLines[index];
  const datePart = currentTimestampFull.slice(0, 8);
  const timePart = currentTimestampFull.slice(8);
  const dateISO = `${datePart.slice(0, 4)}-${datePart.slice(4, 6)}-${datePart.slice(6, 8)}`;
  if (ctrl.dateSelect) ctrl.dateSelect.value = dateISO;
  if (ctrl.timeLabel)
    ctrl.timeLabel.textContent = `${timePart.slice(0, 2)}:${timePart.slice(2)}`;
  // 切替（ダブルバッファでフェード）
  switchToTimestamp(currentTimestampFull);
  saveState({ timestamp: currentTimestampFull });
}

// find index of timestamp (or -1)
function findTimestampIndex(ts) {
  return timestampLines.indexOf(ts);
}

// --- タイルレイヤ（タイムスタンプ別）を作るヘルパー ---
function createTileLayerForStamp(stamp) {
  const layer = L.tileLayer("", {
    tileSize: TILE_SIZE,
    maxNativeZoom: NATIVE_MAX,
    maxZoom: DISPLAY_MAX,
    detectRetina: false,
    noWrap: true,
    crossOrigin: true,
  });

  // Leaflet 内部の _tileReady が、レイヤー削除後に呼ばれて _map が null になることがある。
  // その場合は何もしないで安全に抜ける。
  const originalTileReady = layer._tileReady && layer._tileReady.bind(layer);
  if (originalTileReady) {
    layer._tileReady = function (coords, err, tile) {
      const mapRef = this._map;
      if (!mapRef) return;
      try {
        return originalTileReady(coords, err, tile);
      } catch (e) {
        if (!this._map || /_fadeAnimated/.test(String(e && e.message))) return;
        throw e;
      }
    };
  }

  // override createTile to use the stamp captured by closure
  const originalCreateTile = layer.createTile.bind(layer);
  layer.createTile = function (coords, done) {
    const tileZoom = Math.min(coords.z, NATIVE_MAX);
    const scale = Math.pow(2, coords.z - tileZoom);
    const tileX = Math.floor(coords.x / scale);
    const tileY = Math.floor(coords.y / scale);

    const { tilesX, tilesY } = getTileRangeForZoom(tileZoom);
    if (tileX < 0 || tileY < 0 || tileX >= tilesX || tileY >= tilesY) {
      const tile = document.createElement("img");
      setTimeout(done, 0);
      return tile;
    }
    const tileUrl = buildTileUrlForStamp(stamp, tileZoom, tileX, tileY);
    if (!tileUrl) {
      const tile = document.createElement("img");
      setTimeout(done, 0);
      return tile;
    }

    const tileEl = originalCreateTile(coords, done);
    try {
      tileEl.crossOrigin = "anonymous";
    } catch (e) {}
    setTimeout(() => {
      tileEl.src = tileUrl;
    }, 0);
    return tileEl;
  };

  return layer;
}

// 切替本体（ダブルバッファ）:
// newStamp: 'YYYYMMDDhhmm' or null (use ctrl.dateSelect value)
// 動作: 新レイヤを opacity=0 で追加し load を待ってフェード差し替え
function switchToTimestamp(newStamp) {
  // 中の進行中切替があればキャンセル（既にaddされたレイヤはタイムアウトで削除されるが、ここでは簡単に扱う）
  if (loadingSwitch && loadingSwitch.abort) {
    try {
      loadingSwitch.abort();
    } catch (e) {}
    loadingSwitch = null;
  }
  // タイル取得の fetch() を確実に中断
  if (tileFetchController) {
    try {
      tileFetchController.abort();
    } catch (e) {}
  }
  resetTileFetchQueue();
  tileFetchController = new AbortController();

  const stampKey = normalizeStamp(newStamp);

  // create new layer using stampKey (if null, create with date-based empty stamp -> buildTileUrlForStamp handles it)
  const newLayer = createTileLayerForStamp(stampKey);

  // ensure initially invisible
  newLayer.setOpacity(0);
  newLayer.addTo(map);

  // prepare a handle to possibly abort later
  let aborted = false;
  loadingSwitch = {
    abort: () => {
      aborted = true;
      if (tileFetchController) {
        try {
          tileFetchController.abort();
        } catch (e) {}
      }
      resetTileFetchQueue();
    },
  };

  // when all visible tiles are loaded for this layer
  const onLoadHandler = () => {
    if (aborted) {
      // remove newLayer and bail out
      try {
        map.removeLayer(newLayer);
      } catch (e) {}
      loadingSwitch = null;
      return;
    }

    // prepare CSS transition for smooth crossfade
    const newContainer = newLayer.getContainer && newLayer.getContainer();
    const oldContainer =
      activeTileLayer &&
      activeTileLayer.getContainer &&
      activeTileLayer.getContainer();
    if (newContainer) newContainer.style.transition = "opacity 320ms ease";
    if (oldContainer) oldContainer.style.transition = "opacity 320ms ease";

    // trigger repaint then crossfade
    requestAnimationFrame(() => {
      try {
        newLayer.setOpacity(1);
      } catch (e) {}
      if (activeTileLayer) {
        try {
          activeTileLayer.setOpacity(0);
        } catch (e) {}
      }
    });

    // after transition, remove old layer
    setTimeout(() => {
      if (activeTileLayer && map.hasLayer(activeTileLayer)) {
        try {
          map.removeLayer(activeTileLayer);
        } catch (e) {}
      }
      activeTileLayer = newLayer;
      loadingSwitch = null;
      // redraw overlays/canvas
      drawPixelGrid();
      if (initialLoading) {
        initialLoading = false;
        hideLoading();
      }
    }, 360);
  };

  // if new layer errors loading at least one tile, still attempt to swap after timeout to avoid indefinite hang
  let loadTimeout = setTimeout(() => {
    // if not loaded yet, still perform immediate swap so UI isn't stuck
    if (!aborted) onLoadHandler();
  }, 5000);

  newLayer.once("load", () => {
    clearTimeout(loadTimeout);
    onLoadHandler();
  });
  newLayer.once("tileerror", () => {
    // ignore single tile errors; rely on 'load' or timeout
  });
}

// --- マップ初期化 ---
function initMap() {
  map = L.map("map", {
    crs: L.CRS.Simple,
    minZoom: 0,
    maxZoom: DISPLAY_MAX,
    zoomSnap: parseFloat(ctrl.zoomSnap?.value || 1),
    zoomDelta: parseFloat(ctrl.zoomSnap?.value || 1),
    inertia: false,
    fadeAnimation: false,
  });

  map.whenReady(() => {
    isMapReady = true;
    updateZoomInfo();
    resizeCanvasToMap();
    if (savedState && savedState.view) {
      const v = savedState.view;
      if (
        Number.isFinite(v.lat) &&
        Number.isFinite(v.lng) &&
        Number.isFinite(v.zoom)
      ) {
        map.setView([v.lat, v.lng], v.zoom, { animate: false });
      }
    }
  });

  // まずはダミーの activeTileLayer を作っておく（空のstampで）
  activeTileLayer = createTileLayerForStamp(null);
  activeTileLayer.setOpacity(1);
  activeTileLayer.addTo(map);

  // 表示変化時に再描画
  map.on("click", onMapClick);
  map.on("zoomstart", onInteractionStart);
  map.on("zoomend", onInteractionEnd);
  map.on("movestart", onInteractionStart);
  map.on("moveend", onInteractionEnd);
  map.on("moveend", () => {
    if (!ensureMapReady()) return;
    const c = map.getCenter();
    const z = map.getZoom();
    saveState({ view: { lat: c.lat, lng: c.lng, zoom: z } });
  });
  map.on("zoomend", () => {
    if (!ensureMapReady()) return;
    const c = map.getCenter();
    const z = map.getZoom();
    saveState({ view: { lat: c.lat, lng: c.lng, zoom: z } });
  });
  map.on("mousemove", (e) => {
    showCoords(e);
  });
  window.addEventListener("resize", resizeCanvasToMap);
  resizeCanvasToMap();

  // 画像範囲の境界を定義（外側へパンできないようにする）
  const southWest = map.unproject([0, IMG_H], NATIVE_MAX);
  const northEast = map.unproject([IMG_W, 0], NATIVE_MAX);
  const bounds = new L.LatLngBounds(southWest, northEast);
  const paddedBounds = bounds.pad(0.08);
  map.setMaxBounds(paddedBounds);
  map.options.maxBoundsViscosity = 1.0;

  // fit bounds once tileset known size
  map.fitBounds(bounds, { maxZoom: DISPLAY_MAX });

  updateZoomInfo();
}

function ensureMapReady() {
  return !!map && isMapReady;
}

// 設定を適用（レイヤーを完全に破棄せず、存在する場合は再描画）
function applySettings(opts = {}) {
  const zoomSnap = parseFloat(ctrl.zoomSnap?.value || 1);

  if (!map) return;

  map.options.maxZoom = DISPLAY_MAX;
  map.options.zoomSnap = zoomSnap;
  map.options.zoomDelta = zoomSnap;

  // 再描画（レイヤーは switchToTimestamp で差し替えるので、ここでは activeTileLayer を redraw）
  if (activeTileLayer) {
    try {
      activeTileLayer.redraw();
    } catch (e) {}
  }

  document.getElementById("map")?.classList.remove("tile-pixelated");

  updateZoomInfo();
  console.log("Applied settings:", {
    zoomSnap,
    date: ctrl.dateSelect?.value,
    timestamp: currentTimestampFull,
  });

  saveState({
    settings: {
      zoomSnap: ctrl.zoomSnap?.value,
      sampleStep: ctrl.sampleStep?.value,
      overlayOpacity: ctrl.overlayOpacity?.value,
      gridMinScreen: ctrl.gridMinScreen?.value,
      preloadRange: ctrl.preloadRange?.value,
      pixelPicker: !!ctrl.pixelPickerToggle?.checked,
      pixelGrid: !!ctrl.pixelGridToggle?.checked,
      colorize: !!ctrl.colorizeToggle?.checked,
    },
  });

  drawPixelGrid();

  if (opts.commit !== false) {
    appliedSettings = getSettingsFromControls();
    if (isSettingsPanelOpen) panelBaseline = { ...appliedSettings };
  }
  updateSettingsDirtyState();
}

// ズーム情報更新
function updateZoomInfo() {
  if (!ensureMapReady()) return;
  const z = map.getZoom();
  const displayZoom = Math.round(z * 10) / 10;
  const scale = Math.pow(2, displayZoom - NATIVE_MAX);
  const formatNumber = (v, digits = 3) => {
    const s = v.toFixed(digits);
    return s.replace(/\.?0+$/, "");
  };
  const scaleText = `×${formatNumber(scale)}`;
  if (ctrl.zoomInfo)
    ctrl.zoomInfo.textContent = `zoom: ${displayZoom} (nativeMax: ${NATIVE_MAX}, scale: ${scaleText})`;
}

// マウス座標表示（ピクセル単位）
function showCoords(e) {
  if (!ensureMapReady()) return;
  const p = map.project(e.latlng, NATIVE_MAX);
  const px = Math.round(p.x);
  const py = Math.round(p.y);
  const d = toDisplayTileCoords(px, py);
  if (ctrl.coordsInfo)
    ctrl.coordsInfo.textContent = `pixel: ${d.tileX}, ${d.tileY}, ${d.inX}, ${d.inY}`;
}

// キャンバスサイズをマップに合わせる
function resizeCanvasToMap() {
  if (!ensureMapReady()) return;
  const size = map.getSize
    ? map.getSize()
    : { x: window.innerWidth, y: window.innerHeight };
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = size.x + "px";
  canvas.style.height = size.y + "px";
  canvas.width = Math.round(size.x * dpr);
  canvas.height = Math.round(size.y * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawPixelGrid();
}

function clearCanvas() {
  const dpr = window.devicePixelRatio || 1;
  ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
}
// ビュー変化時の処理
function onInteractionStart() {
  isInteracting = true;
  clearCanvas();
  pixelMarker.style.display = "none";
  if (redrawTimer) clearTimeout(redrawTimer);
}

function onInteractionEnd() {
  isInteracting = false;
  const zoomSnap = parseFloat(ctrl.zoomSnap?.value || 1);
  if (!isSnappingZoom && Number.isFinite(zoomSnap) && zoomSnap > 0) {
    const z = map.getZoom();
    const snapped = Math.round(z / zoomSnap) * zoomSnap;
    if (Math.abs(snapped - z) > 1e-6) {
      isSnappingZoom = true;
      map.setZoom(snapped, { animate: false });
      return;
    }
  }
  if (isSnappingZoom) {
    isSnappingZoom = false;
  }
  updateZoomInfo();
  if (redrawTimer) clearTimeout(redrawTimer);
  redrawTimer = setTimeout(() => {
    resizeCanvasToMap();
  }, 150);
}

// メイン描画（既存ロジックを保持）
async function drawPixelGrid() {
  if (!ensureMapReady()) return;
  if (isInteracting) return;
  clearCanvas();
  pixelMarker.style.display = "none";

  const currentZoom = map.getZoom();

  if (currentZoom < MIN_ZOOM_TO_SHOW) {
    return;
  }

  if (ctrl.colorizeToggle?.checked) {
    await drawColorOverlay();
  }
  if (ctrl.pixelGridToggle?.checked) {
    const p0 = map.latLngToContainerPoint(map.unproject([0, 0], NATIVE_MAX));
    const p1x = map.latLngToContainerPoint(map.unproject([1, 0], NATIVE_MAX));
    const p1y = map.latLngToContainerPoint(map.unproject([0, 1], NATIVE_MAX));
    const pixelScreenX = Math.abs(p1x.x - p0.x);
    const pixelScreenY = Math.abs(p1y.y - p0.y);
    const minScreen = Math.max(1, parseFloat(ctrl.gridMinScreen?.value) || 6);
    const stepGrid = Math.max(
      1,
      Math.ceil(minScreen / Math.max(pixelScreenX, pixelScreenY, 1e-9)),
    );
    drawGridLines(stepGrid, pixelScreenX, pixelScreenY);
  }
}

function drawGridLines(step, pixelScreenX, pixelScreenY) {
  const nativeMax = NATIVE_MAX;
  const topLeftLatLng = map.containerPointToLatLng([0, 0]);
  const bottomRightLatLng = map.containerPointToLatLng([
    map.getSize().x,
    map.getSize().y,
  ]);
  const topLeftPx = map.project(topLeftLatLng, nativeMax);
  const bottomRightPx = map.project(bottomRightLatLng, nativeMax);
  const startX = Math.floor(Math.min(topLeftPx.x, bottomRightPx.x));
  const endX = Math.ceil(Math.max(topLeftPx.x, bottomRightPx.x));
  const startY = Math.floor(Math.min(topLeftPx.y, bottomRightPx.y));
  const endY = Math.ceil(Math.max(topLeftPx.y, bottomRightPx.y));
  const contStart = map.latLngToContainerPoint(
    map.unproject([startX, startY], nativeMax),
  );
  const dX = pixelScreenX;
  const dY = pixelScreenY;

  ctx.save();
  ctx.lineWidth = 1;
  ctx.imageSmoothingEnabled = false;
  const canvasW = map.getSize().x;
  const canvasH = map.getSize().y;

  ctx.strokeStyle = "rgba(255,255,255,0.85)";
  for (let x = startX; x <= endX; x += step) {
    const cx = contStart.x + (x - startX) * dX;
    if (cx < -1 || cx > canvasW + 1) continue;
    ctx.beginPath();
    ctx.moveTo(Math.round(cx) + 0.5, 0.5);
    ctx.lineTo(Math.round(cx) + 0.5, canvasH + 0.5);
    ctx.stroke();
  }
  for (let y = startY; y <= endY; y += step) {
    const cy = contStart.y + (y - startY) * dY;
    if (cy < -1 || cy > canvasH + 1) continue;
    ctx.beginPath();
    ctx.moveTo(0.5, Math.round(cy) + 0.5);
    ctx.lineTo(canvasW + 0.5, Math.round(cy) + 0.5);
    ctx.stroke();
  }

  ctx.strokeStyle = "rgba(0,0,0,0.35)";
  for (let x = startX; x <= endX; x += step) {
    const cx = contStart.x + (x - startX) * dX;
    if (cx < -1 || cx > canvasW + 1) continue;
    ctx.beginPath();
    ctx.moveTo(Math.round(cx) + 0.5, 0.5);
    ctx.lineTo(Math.round(cx) + 0.5, canvasH + 0.5);
    ctx.stroke();
  }
  for (let y = startY; y <= endY; y += step) {
    const cy = contStart.y + (y - startY) * dY;
    if (cy < -1 || cy > canvasH + 1) continue;
    ctx.beginPath();
    ctx.moveTo(0.5, Math.round(cy) + 0.5);
    ctx.lineTo(canvasW + 0.5, Math.round(cy) + 0.5);
    ctx.stroke();
  }
  ctx.restore();
}

async function drawColorOverlay() {
  if (tileFetchController && tileFetchController.signal.aborted) return;
  const nativeMax = NATIVE_MAX;
  const tileSize = TILE_SIZE;
  const p0 = map.latLngToContainerPoint(map.unproject([0, 0], nativeMax));
  const p1x = map.latLngToContainerPoint(map.unproject([1, 0], nativeMax));
  const p1y = map.latLngToContainerPoint(map.unproject([0, 1], nativeMax));
  const pixelScreenX = Math.abs(p1x.x - p0.x);
  const pixelScreenY = Math.abs(p1y.y - p0.y);
  const pixelScreen = Math.max(pixelScreenX, pixelScreenY);

  const topLeftLatLng = map.containerPointToLatLng([0, 0]);
  const bottomRightLatLng = map.containerPointToLatLng([
    map.getSize().x,
    map.getSize().y,
  ]);
  const topLeftPx = map.project(topLeftLatLng, nativeMax);
  const bottomRightPx = map.project(bottomRightLatLng, nativeMax);
  const startX = Math.floor(Math.min(topLeftPx.x, bottomRightPx.x));
  const endX = Math.ceil(Math.max(topLeftPx.x, bottomRightPx.x));
  const startY = Math.floor(Math.min(topLeftPx.y, bottomRightPx.y));
  const endY = Math.ceil(Math.max(topLeftPx.y, bottomRightPx.y));

  const startTileX = Math.floor(startX / tileSize);
  const endTileX = Math.floor((endX - 1) / tileSize);
  const startTileY = Math.floor(startY / tileSize);
  const endTileY = Math.floor((endY - 1) / tileSize);

  const vw = map.getSize().x;
  const vh = map.getSize().y;

  if (pixelScreen < 1) {
    const MAX_PIXELS_WORK = 200000;
    let stepScreen = 1;
    if (vw * vh > MAX_PIXELS_WORK) {
      stepScreen = Math.ceil(Math.sqrt((vw * vh) / MAX_PIXELS_WORK));
    }

    const off = document.createElement("canvas");
    off.width = vw;
    off.height = vh;
    const offCtx = off.getContext("2d");
    const imageData = offCtx.createImageData(vw, vh);
    const data = imageData.data;

    const contStart = map.latLngToContainerPoint(
      map.unproject([startX, startY], nativeMax),
    );

    for (let cy = 0; cy < vh; cy += stepScreen) {
      const imageYf = startY + (cy - contStart.y) / (pixelScreenY || 1);
      const imageSy = Math.floor(imageYf);
      for (let cx = 0; cx < vw; cx += stepScreen) {
        const imageXf = startX + (cx - contStart.x) / (pixelScreenX || 1);
        const imageSx = Math.floor(imageXf);

        if (imageSx < 0 || imageSy < 0) continue;
        if (imageSx > endX || imageSy > endY) continue;

        const tx = Math.floor(imageSx / tileSize);
        const ty = Math.floor(imageSy / tileSize);
        const inTx = imageSx - tx * tileSize;
        const inTy = imageSy - ty * tileSize;
        const key = `${currentTimestampFull || (ctrl.dateSelect?.value || "").replace(/-/g, "")}/${nativeMax}/${tx}/${ty}`;

        try {
          let tilePixels = tilePixelCache.get(key);
          if (!tilePixels) {
            const bitmap = await fetchTileBitmap(nativeMax, tx, ty);
            const tmp = document.createElement("canvas");
            tmp.width = bitmap.width;
            tmp.height = bitmap.height;
            const tctx = tmp.getContext("2d");
            tctx.drawImage(bitmap, 0, 0);
            const img = tctx.getImageData(0, 0, tmp.width, tmp.height);
            tilePixels = { w: tmp.width, h: tmp.height, data: img.data };
            setCacheWithLimit(
              tilePixelCache,
              key,
              tilePixels,
              MAX_TILE_PIXEL_CACHE,
            );
          }
          if (
            inTx < 0 ||
            inTy < 0 ||
            inTx >= tilePixels.w ||
            inTy >= tilePixels.h
          )
            continue;
          const idx = (inTy * tilePixels.w + inTx) * 4;
          const r = tilePixels.data[idx];
          const g = tilePixels.data[idx + 1];
          const b = tilePixels.data[idx + 2];
          const a = tilePixels.data[idx + 3];

          for (let sy = 0; sy < stepScreen; sy++) {
            const dy = cy + sy;
            if (dy >= vh) break;
            for (let sx = 0; sx < stepScreen; sx++) {
              const dx = cx + sx;
              if (dx >= vw) break;
              const di = (dy * vw + dx) * 4;
              data[di] = r;
              data[di + 1] = g;
              data[di + 2] = b;
              data[di + 3] = a;
            }
          }
        } catch (err) {
          if (isAbortError(err)) return;
          continue;
        }
      }
    }

    offCtx.putImageData(imageData, 0, 0);
    ctx.save();
    ctx.globalAlpha = parseFloat(ctrl.overlayOpacity?.value || 1);
    ctx.drawImage(off, 0, 0, vw, vh);
    ctx.restore();
    return;
  }

  let userStep = Math.max(1, parseInt(ctrl.sampleStep?.value || "1", 10));
  let autoStep = userStep;
  if (pixelScreen > 0 && pixelScreen < 1) {
    autoStep = Math.max(autoStep, Math.ceil(1 / pixelScreen));
  }

  let step = autoStep;
  const estSampleX = Math.max(1, pixelScreenX * step);
  const estSampleY = Math.max(1, pixelScreenY * step);
  const estSamples = (vw * vh) / (estSampleX * estSampleY);
  if (estSamples > MAX_SAMPLES) {
    const factor = Math.sqrt(estSamples / MAX_SAMPLES);
    step = Math.ceil(step * factor);
  }

  const dX = Math.max(1, Math.round(pixelScreenX * step));
  const dY = Math.max(1, Math.round(pixelScreenY * step));

  ctx.save();
  ctx.globalAlpha = parseFloat(ctrl.overlayOpacity?.value || 1);

  for (let tx = startTileX; tx <= endTileX; tx++) {
    for (let ty = startTileY; ty <= endTileY; ty++) {
      const key = `${currentTimestampFull || (ctrl.dateSelect?.value || "").replace(/-/g, "")}/${nativeMax}/${tx}/${ty}`;
      try {
        let tilePixels = tilePixelCache.get(key);
        if (!tilePixels) {
          const bitmap = await fetchTileBitmap(nativeMax, tx, ty);
          const offc = document.createElement("canvas");
          offc.width = bitmap.width;
          offc.height = bitmap.height;
          const offCtx = offc.getContext("2d");
          offCtx.drawImage(bitmap, 0, 0);
          const imgData = offCtx.getImageData(0, 0, offc.width, offc.height);
          tilePixels = { w: offc.width, h: offc.height, data: imgData.data };
          setCacheWithLimit(
            tilePixelCache,
            key,
            tilePixels,
            MAX_TILE_PIXEL_CACHE,
          );
        }

        const left = Math.max(startX, tx * tileSize);
        const right = Math.min(endX, (tx + 1) * tileSize);
        const top = Math.max(startY, ty * tileSize);
        const bottom = Math.min(endY, (ty + 1) * tileSize);
        if (right <= left || bottom <= top) continue;
        const offsetX = left - tx * tileSize;
        const offsetY = top - ty * tileSize;
        const w = right - left;
        const h = bottom - top;

        for (let py = 0; py < h; py += step) {
          for (let px = 0; px < w; px += step) {
            const sx = Math.floor(offsetX + px);
            const sy = Math.floor(offsetY + py);
            if (sx < 0 || sy < 0 || sx >= tilePixels.w || sy >= tilePixels.h)
              continue;
            const idx = (sy * tilePixels.w + sx) * 4;
            const r = tilePixels.data[idx];
            const g = tilePixels.data[idx + 1];
            const b = tilePixels.data[idx + 2];
            const a = tilePixels.data[idx + 3] / 255;

            const imagePxX = tx * tileSize + sx;
            const imagePxY = ty * tileSize + sy;
            const cont = map.latLngToContainerPoint(
              map.unproject([imagePxX, imagePxY], nativeMax),
            );
            const rx = (cont.x + 0.5) | 0;
            const ry = (cont.y + 0.5) | 0;
            if (
              rx + dX < 0 ||
              rx > map.getSize().x ||
              ry + dY < 0 ||
              ry > map.getSize().y
            )
              continue;

            ctx.fillStyle = `rgba(${r},${g},${b},${a})`;
            ctx.fillRect(rx, ry, dX, dY);
          }
        }
      } catch (err) {
        if (isAbortError(err)) return;
        continue;
      }
    }
  }

  ctx.restore();
}

// タイルを取得して ImageBitmap を返す（キャッシュあり）
async function fetchTileBitmap(z, x, y) {
  const stampKey = normalizeStamp(currentTimestampFull);
  if (!stampKey) throw new Error("timestamp not set");
  const key = `${stampKey}/${z}/${x}/${y}`;
  if (tileCache.has(key)) return tileCache.get(key);
  const url = buildTileUrlForStamp(stampKey, z, x, y);
  if (!url) throw new Error("timestamp not set");
  const signal = tileFetchController ? tileFetchController.signal : undefined;
  if (signal && signal.aborted) throw new DOMException("Aborted", "AbortError");
  return enqueueTileFetch(async () => {
    const resp = await fetch(url, { mode: "cors", signal });
    if (!resp.ok)
      throw new Error(`Tile fetch failed: ${resp.status} ${resp.statusText}`);
    const blob = await resp.blob();
    const bitmap = await createImageBitmap(blob);
    setCacheWithLimit(tileCache, key, bitmap, MAX_TILE_CACHE);
    return bitmap;
  }, signal);
}

async function fetchTileBitmapForStamp(stamp, z, x, y, signal) {
  const stampKey = normalizeStamp(stamp);
  if (!stampKey) throw new Error("timestamp not set");
  const key = `${stampKey}/${z}/${x}/${y}`;
  if (tileCache.has(key)) return tileCache.get(key);
  const url = buildTileUrlForStamp(stampKey, z, x, y);
  if (!url) throw new Error("timestamp not set");
  return enqueuePreload(async () => {
    const resp = await fetch(url, { mode: "cors", signal });
    if (!resp.ok)
      throw new Error(`Tile fetch failed: ${resp.status} ${resp.statusText}`);
    const blob = await resp.blob();
    const bitmap = await createImageBitmap(blob);
    setCacheWithLimit(tileCache, key, bitmap, MAX_TILE_CACHE);
    return bitmap;
  }, signal);
}

// ビットマップから単一ピクセルの色を読む
async function readPixelFromTileBitmap(bitmap, x, y) {
  if (x < 0 || y < 0 || x >= bitmap.width || y >= bitmap.height) return null;
  const tmp = document.createElement("canvas");
  tmp.width = bitmap.width;
  tmp.height = bitmap.height;
  const c = tmp.getContext("2d");
  c.drawImage(bitmap, 0, 0);
  const d = c.getImageData(x, y, 1, 1).data;
  return { r: d[0], g: d[1], b: d[2], a: d[3] };
}

// ピクセル選択
let lastPicked = null;
async function onMapClick(e) {
  if (!ctrl.pixelPickerToggle?.checked) return;
  if (!ensureMapReady()) return;

  const tileSize = TILE_SIZE;

  const p = map.project(e.latlng, NATIVE_MAX);
  const px = Math.floor(p.x);
  const py = Math.floor(p.y);

  const tileX = Math.floor(px / tileSize);
  const tileY = Math.floor(py / tileSize);
  const inTileX = px - tileX * tileSize;
  const inTileY = py - tileY * tileSize;

  const d = toDisplayTileCoords(px, py);
  if (ctrl.pixelText)
    ctrl.pixelText.textContent = `pixel: ${d.tileX}, ${d.tileY}, ${d.inX}, ${d.inY}\nタイル: z=${NATIVE_MAX}, x=${tileX}, y=${tileY}\n読み込み中...`;
  if (ctrl.pixelOutput) ctrl.pixelOutput.style.display = "flex";
  if (ctrl.colorSwatch) ctrl.colorSwatch.style.background = "#ffffff";

  try {
    const bitmap = await fetchTileBitmap(NATIVE_MAX, tileX, tileY);
    const pxData = await readPixelFromTileBitmap(bitmap, inTileX, inTileY);
    if (!pxData) throw new Error("タイル内座標が範囲外です");
    const { r, g, b, a } = pxData;
    const hex =
      "#" +
      [r, g, b]
        .map((v) => v.toString(16).padStart(2, "0"))
        .join("")
        .toUpperCase();
    if (ctrl.colorSwatch) ctrl.colorSwatch.style.background = hex;
    if (ctrl.pixelText)
      ctrl.pixelText.textContent = `pixel: ${d.tileX}, ${d.tileY}, ${d.inX}, ${d.inY}\nタイル: z=${NATIVE_MAX}, x=${tileX}, y=${tileY}\nRGBA: ${r}, ${g}, ${b}, ${a}\nHEX: ${hex}`;
    lastPicked = { px, py, r, g, b, a, hex };

    showPixelMarker(px, py);
  } catch (err) {
    if (isAbortError(err)) {
      return;
    }
    console.error(err);
    if (ctrl.pixelText)
      ctrl.pixelText.textContent = `pixel: ${d.tileX}, ${d.tileY}, ${d.inX}, ${d.inY}\nエラー: ${err.message}\nCORS を確認してください`;
    if (ctrl.colorSwatch) ctrl.colorSwatch.style.background = "#ffffff";
    lastPicked = null;
    pixelMarker.style.display = "none";
  }
}

// 選択ピクセルを赤枠で表示
function showPixelMarker(imagePxX, imagePxY) {
  if (!ensureMapReady()) return;
  const topLeft = map.latLngToContainerPoint(
    map.unproject([imagePxX, imagePxY], NATIVE_MAX),
  );
  const bottomRight = map.latLngToContainerPoint(
    map.unproject([imagePxX + 1, imagePxY + 1], NATIVE_MAX),
  );
  const left = Math.round(topLeft.x);
  const top = Math.round(topLeft.y);
  const w = Math.max(1, Math.round(bottomRight.x - topLeft.x));
  const h = Math.max(1, Math.round(bottomRight.y - topLeft.y));

  pixelMarker.style.left = left + "px";
  pixelMarker.style.top = top + "px";
  pixelMarker.style.width = w + "px";
  pixelMarker.style.height = h + "px";
  pixelMarker.style.display = "block";
  setTimeout(() => {
    if (!ctrl.pixelPickerToggle?.checked) pixelMarker.style.display = "none";
  }, 2000);
}

// 色をクリップボードにコピー
ctrl.copyColor?.addEventListener("click", () => {
  if (!lastPicked) return;
  const text = lastPicked.hex;
  navigator.clipboard?.writeText(text).then(
    () => {
      ctrl.copyColor.textContent = "コピー済み";
      setTimeout(() => (ctrl.copyColor.textContent = "HEXをコピー"), 1200);
    },
    () => {
      alert("コピーに失敗しました");
    },
  );
});

// キャッシュクリア
ctrl.clearCache?.addEventListener("click", () => {
  tileCache.clear();
  tilePixelCache.clear();
  if (ctrl.pixelText) ctrl.pixelText.textContent = "キャッシュをクリアしました";
});

// トグル変更時は再描画
ctrl.pixelGridToggle?.addEventListener("change", () => {
  drawPixelGrid();
});
ctrl.colorizeToggle?.addEventListener("change", () => {
  drawPixelGrid();
});
ctrl.pixelPickerToggle?.addEventListener("change", () => {
  if (!ctrl.pixelPickerToggle?.checked) {
    if (ctrl.pixelOutput) ctrl.pixelOutput.style.display = "none";
    lastPicked = null;
    pixelMarker.style.display = "none";
  }
});

const settingsInputs = [
  ctrl.zoomSnap,
  ctrl.sampleStep,
  ctrl.overlayOpacity,
  ctrl.gridMinScreen,
  ctrl.preloadRange,
  ctrl.pixelPickerToggle,
  ctrl.pixelGridToggle,
  ctrl.colorizeToggle,
];

for (const el of settingsInputs) {
  if (!el) continue;
  el.addEventListener("input", updateSettingsDirtyState);
  el.addEventListener("change", updateSettingsDirtyState);
}

// Apply / Fit ボタン
ctrl.applyBtn?.addEventListener("click", () => {
  try {
    applySettings();
  } catch (err) {
    alert("設定適用エラー: " + err.message);
  }
});
ctrl.undoBtn?.addEventListener("click", () => {
  if (!panelSnapshot) return;
  const target = { ...panelSnapshot };
  setControlsFromSettings(target);
  try {
    applySettings();
    updateSettingsDirtyState();
  } catch (err) {
    alert("設定復元エラー: " + err.message);
  }
});
ctrl.fitBtn?.addEventListener("click", () => {
  const southWest = map.unproject([0, IMG_H], NATIVE_MAX);
  const northEast = map.unproject([IMG_W, 0], NATIVE_MAX);
  const bounds = new L.LatLngBounds(southWest, northEast);
  map.fitBounds(bounds, { maxZoom: DISPLAY_MAX });
});

// 日付操作 helpers
function formatDateYYYYMMDD(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// prev/next handlers preserve view and update timestamp for that date
ctrl.prevDate?.addEventListener("click", async () => {
  const cur = ctrl.dateSelect?.value
    ? new Date(ctrl.dateSelect.value)
    : new Date();
  cur.setDate(cur.getDate() - 1);
  const iso = formatDateYYYYMMDD(cur);
  if (uniqueDates.includes(iso)) {
    if (ctrl.dateSelect) ctrl.dateSelect.value = iso;
    await updateCurrentTimestampForDate(iso, { preserveView: true });
  }
});
ctrl.nextDate?.addEventListener("click", async () => {
  const cur = ctrl.dateSelect?.value
    ? new Date(ctrl.dateSelect.value)
    : new Date();
  cur.setDate(cur.getDate() + 1);
  const iso = formatDateYYYYMMDD(cur);
  if (uniqueDates.includes(iso)) {
    if (ctrl.dateSelect) ctrl.dateSelect.value = iso;
    await updateCurrentTimestampForDate(iso, { preserveView: true });
  }
});
ctrl.dateSelect?.addEventListener("change", async () => {
  await updateCurrentTimestampForDate(ctrl.dateSelect.value, {
    preserveView: true,
  });
});

function buildPreloadOrder(centerIndex, range, total) {
  const order = [];
  order.push(centerIndex);
  for (let i = 1; i <= range; i++) {
    const left = centerIndex - i;
    const right = centerIndex + i;
    if (left >= 0) order.push(left);
    if (right < total) order.push(right);
  }
  return order;
}

function updatePreloadInfo(text) {
  if (ctrl.preloadInfo) ctrl.preloadInfo.textContent = text || "";
}

function finishPreload(runId, message) {
  if (runId !== preloadRunId) return;
  isPreloading = false;
  if (ctrl.preloadBtn) ctrl.preloadBtn.textContent = "📥先読み";
  updatePreloadInfo(message || "");
}

function cancelPreload() {
  preloadRunId++;
  if (preloadController) {
    try {
      preloadController.abort();
    } catch (e) {}
  }
  resetPreloadQueue();
  isPreloading = false;
  if (ctrl.preloadBtn) ctrl.preloadBtn.textContent = "📥先読み";
  updatePreloadInfo("先読み停止");
}

function startPreloadAroundCurrent(range = 30) {
  if (!ensureMapReady()) return;
  if (!currentTimestampFull) {
    updatePreloadInfo("タイムスタンプ未選択");
    return;
  }

  const idx = findTimestampIndex(currentTimestampFull);
  if (idx < 0 || !timestampLines.length) {
    updatePreloadInfo("先読み不可");
    return;
  }

  const z = clamp(Math.round(map.getZoom()), 0, NATIVE_MAX);
  const tileRange = getVisibleTileRange(z);
  if (!tileRange) {
    updatePreloadInfo("範囲取得失敗");
    return;
  }

  preloadRunId++;
  const runId = preloadRunId;
  isPreloading = true;
  if (ctrl.preloadBtn) ctrl.preloadBtn.textContent = "停止";

  resetPreloadQueue();
  preloadController = new AbortController();

  const order = buildPreloadOrder(idx, range, timestampLines.length);
  let total = 0;
  let done = 0;
  let skipped = 0;
  let lastUpdate = 0;

  const { minX, maxX, minY, maxY } = tileRange;

  updatePreloadInfo("先読み開始...");

  outer: for (const i of order) {
    const stamp = timestampLines[i];
    if (!normalizeStamp(stamp)) continue;
    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        if (total >= MAX_PRELOAD_TASKS) break outer;
        const key = `${stamp}/${z}/${x}/${y}`;
        if (tileCache.has(key)) {
          skipped++;
          continue;
        }
        total++;
        fetchTileBitmapForStamp(stamp, z, x, y, preloadController.signal)
          .catch((err) => {
            if (isAbortError(err)) return;
          })
          .finally(() => {
            if (runId !== preloadRunId) return;
            done++;
            const now = Date.now();
            if (done === total || now - lastUpdate > 200) {
              lastUpdate = now;
              updatePreloadInfo(`先読み ${done}/${total} (skip ${skipped})`);
            }
            if (done === total) {
              finishPreload(runId, `先読み完了 ${done}/${total}`);
            }
          });
      }
    }
  }

  if (total === 0) {
    finishPreload(runId, "先読み対象なし");
  }
}

ctrl.preloadBtn?.addEventListener("click", () => {
  if (isPreloading) {
    cancelPreload();
    return;
  }
  const range = Math.max(
    0,
    Math.min(300, parseInt(ctrl.preloadRange?.value || "30", 10)),
  );
  startPreloadAroundCurrent(Number.isFinite(range) ? range : 30);
});

// updateCurrentTimestampForDate: set currentTimestampFull to latest for that date,
// update UI and use switchToTimestamp() to swap layers smoothly
async function updateCurrentTimestampForDate(dateISO, opts = {}) {
  const preserveView = opts.preserveView || false;

  if (!dateISO) {
    currentTimestampFull = null;
    if (ctrl.timeLabel) ctrl.timeLabel.textContent = "--:--";
    // redraw overlays/canvas
    drawPixelGrid();
    return;
  }
  const compact = dateISO.replace(/-/g, "");
  const times = timestampsByDate.get(compact);
  if (times && times.length > 0) {
    const hhmm = times[0]; // latest
    currentTimestampFull = `${compact}${hhmm}`;
    if (ctrl.timeLabel)
      ctrl.timeLabel.textContent = `${hhmm.slice(0, 2)}:${hhmm.slice(2)}`;
    const idx = findTimestampIndex(currentTimestampFull);
    if (idx >= 0 && ctrl.dateSlider) {
      ctrl.dateSlider.value = idx;
      if (ctrl.dateSliderInfo)
        ctrl.dateSliderInfo.textContent = `${idx + 1} / ${timestampLines.length}`;
    }
    // 切替実行
    switchToTimestamp(currentTimestampFull);
    saveState({ timestamp: currentTimestampFull });
  } else {
    currentTimestampFull = null;
    if (ctrl.timeLabel) ctrl.timeLabel.textContent = "--:--";
    switchToTimestamp(null);
  }
}

// slider input handling (debounced)
if (ctrl.dateSlider) {
  ctrl.dateSlider.addEventListener("input", (ev) => {
    const idx = parseInt(ev.target.value, 10);
    if (ctrl.dateSliderInfo)
      ctrl.dateSliderInfo.textContent = `${idx + 1} / ${timestampLines.length}`;
    if (sliderUpdateTimer) clearTimeout(sliderUpdateTimer);
    sliderUpdateTimer = setTimeout(() => {
      setTimestampByIndex(idx, { preserveView: true });
      sliderUpdateTimer = null;
    }, 120);
  });
}

// Settings パネルの開閉（toggle）
ctrl.settingsBtn?.addEventListener("click", () => {
  const panel = ctrl.controlPanel;
  if (!panel) return;
  const isHidden = panel.classList.contains("hidden");
  if (isHidden) {
    panel.classList.remove("hidden");
    isSettingsPanelOpen = true;
    panelSnapshot = getSettingsFromControls();
    panelBaseline = { ...panelSnapshot };
    updateSettingsDirtyState();
    ctrl.settingsBtn.setAttribute("aria-expanded", "true");
    return;
  }
  if (settingsDirty) {
    ctrl.applyBtn?.focus();
    return;
  }
  panel.classList.add("hidden");
  isSettingsPanelOpen = false;
  panelSnapshot = null;
  panelBaseline = null;
  updateSettingsDirtyState();
  ctrl.settingsBtn.setAttribute("aria-expanded", "false");
});

ctrl.infoBtn?.addEventListener("click", () => {
  const panel = ctrl.infoPanel;
  if (!panel) return;
  const isHidden = panel.classList.contains("hidden");
  panel.classList.toggle("hidden");
  ctrl.infoBtn.setAttribute("aria-expanded", String(!isHidden));
});

ctrl.updatesBtn?.addEventListener("click", () => {
  const panel = ctrl.updatesPanel;
  if (!panel) return;
  const isHidden = panel.classList.contains("hidden");
  panel.classList.toggle("hidden");
  ctrl.updatesBtn.setAttribute("aria-expanded", String(!isHidden));
});

// 初期化: 日付を今日にセット & タイムスタンプ読み込み
(async function initControls() {
  const today = new Date();
  const todayISO = formatDateYYYYMMDD(today);

  showLoading();

  savedState = loadSavedState();

  // restore settings (before map init)
  if (savedState && savedState.settings) {
    const s = savedState.settings;
    if (ctrl.zoomSnap && s.zoomSnap != null)
      ctrl.zoomSnap.value = String(s.zoomSnap);
    if (ctrl.sampleStep && s.sampleStep != null)
      ctrl.sampleStep.value = String(s.sampleStep);
    if (ctrl.overlayOpacity && s.overlayOpacity != null)
      ctrl.overlayOpacity.value = String(s.overlayOpacity);
    if (ctrl.gridMinScreen && s.gridMinScreen != null)
      ctrl.gridMinScreen.value = String(s.gridMinScreen);
    if (ctrl.preloadRange && s.preloadRange != null)
      ctrl.preloadRange.value = String(s.preloadRange);
    if (ctrl.pixelPickerToggle && typeof s.pixelPicker === "boolean")
      ctrl.pixelPickerToggle.checked = s.pixelPicker;
    if (ctrl.pixelGridToggle && typeof s.pixelGrid === "boolean")
      ctrl.pixelGridToggle.checked = s.pixelGrid;
    if (ctrl.colorizeToggle && typeof s.colorize === "boolean")
      ctrl.colorizeToggle.checked = s.colorize;
  } else {
    if (ctrl.preloadRange) ctrl.preloadRange.value = "30";
  }

  await fetchTimestampList();

  if (timestampLines.length > 0) {
    const savedTs =
      savedState && typeof savedState.timestamp === "string"
        ? savedState.timestamp
        : null;
    if (savedTs && timestampLines.includes(savedTs)) {
      currentTimestampFull = savedTs;
    } else if (timestampLines.includes(DEFAULT_TIMESTAMP)) {
      currentTimestampFull = DEFAULT_TIMESTAMP;
    } else {
      currentTimestampFull = timestampLines[0]; // top of file (YYYYMMDDhhmm)
    }
    const datePart = currentTimestampFull.slice(0, 8);
    const timePart = currentTimestampFull.slice(8);
    const dateISO = `${datePart.slice(0, 4)}-${datePart.slice(4, 6)}-${datePart.slice(6, 8)}`;
    if (ctrl.dateSelect) {
      if (uniqueDates.includes(dateISO)) ctrl.dateSelect.value = dateISO;
    }
    if (ctrl.timeLabel)
      ctrl.timeLabel.textContent = `${timePart.slice(0, 2)}:${timePart.slice(2)}`;
    const idx = findTimestampIndex(currentTimestampFull);
    if (idx >= 0 && ctrl.dateSlider) {
      ctrl.dateSlider.value = idx;
      if (ctrl.dateSliderInfo)
        ctrl.dateSliderInfo.textContent = `${idx + 1} / ${timestampLines.length}`;
    }
    saveState({ timestamp: currentTimestampFull });
  } else {
    await updateCurrentTimestampForDate(ctrl.dateSelect?.value);
  }

  initMap();
  // 初回は activeTileLayer を currentTimestampFull へ切替
  switchToTimestamp(currentTimestampFull);
  applySettings();
})();

// キーボードショートカット
window.addEventListener("keydown", (ev) => {
  if (!map) return;
  if (ev.key === "+" || ev.key === "=") map.zoomIn();
  if (ev.key === "-") map.zoomOut();
  if (ev.key === "r") ctrl.fitBtn?.click();
  if (ev.key === "ArrowLeft") ctrl.prevDate?.click();
  if (ev.key === "ArrowRight") ctrl.nextDate?.click();
});

// 初回キャンバスサイズ合わせ
setTimeout(resizeCanvasToMap, 50);
