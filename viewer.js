const dziRoot = "img/dzi";
const availableDates = [
  "202508200005", "202508210000", "202508220000", "202508230000", "202508232300",
  "202508250000", "202508260000", "202508270000", "202508280000", "202508290100",
  "202508300000", "202508310000", "202509010000", "202509020000", "202509030000",
  "202509040000", "202509050000", "202509060000", "202509070000", "202509080000",
  "202509090000", "202509100000", "202509110000", "202509120000", "202509130000",
  "202509140000", "202509150000", "202509160000", "202509170000", "202509180000",
  "202509190000", "202509200000", "202509210000", "202509220000", "202509230000",
  "202509240000", "202509250000", "202509260000", "202509270000", "202509280000",
  "202509290000", "202509300000", "202510010000", "202510020000", "202510030000",
  "202510040000", "202510050000", "202510060000", "202510070000", "202510080000",
  "202510090000", "202510100000", "202510110000", "202510120000", "202510130000",
  "202510140000", "202510150000", "202510160000", "202510170000", "202510180100",
  "202510190100", "202510200100", "202510210100", "202510220100", "202510230100",
  "202510240100", "202510260100", "202510270100", "202510280100", "202510290100",
  "202510300100", "202510310100", "202511010100", "202511020100", "202511030100",
  "202511040100", "202511050100", "202511060100", "202511070100", "202511080100",
  "202511090100", "202511100100", "202511110100", "202511120100", "202511130100",
  "202511140100", "202511150100", "202511160100", "202511170100", "202511180100",
  "202511190100"
];

let currentIndex = 0;
let isPlaying = false;
let playInterval = null;
let switching = false; // 切替中フラグ

// ==== DOM 要素 ==================================================
const range = document.getElementById("inputRange");
const dateMainEl = document.getElementById("date-main");
const dateSubEl = document.getElementById("date-sub");
const playBtn = document.getElementById("play-btn");
const prevBtn = document.getElementById("prev");
const nextBtn = document.getElementById("next");
const dateDisplay = document.getElementById("date-display");

// 範囲初期化（必ず availableDates に合わせる）
if (!range) throw new Error("inputRange 要素が見つかりません");
range.min = 0;
range.max = Math.max(0, availableDates.length - 1);
range.value = 0;

// スライダーの見た目グラデ用色
const activeColor = "#377494";
const inactiveColor = "#dddddd";
function updateRangeBackground() {
  const ratio = (range.value - range.min) / Math.max(1, (range.max - range.min)) * 100;
  range.style.background = `linear-gradient(90deg, ${activeColor} ${ratio}%, ${inactiveColor} ${ratio}%)`;
}
updateRangeBackground();

// ==== OpenSeadragon 初期化 ======================================
const viewer = OpenSeadragon({
  id: "viewer",
  prefixUrl: "https://cdnjs.cloudflare.com/ajax/libs/openseadragon/4.1.0/images/",
  showNavigationControl: true,
  showZoomControl: true,
  minZoomLevel: 0.5,
  defaultZoomLevel: 1,
  preserveViewport: true,
  visibilityRatio: 1.0,
  blendTime: 0,
  immediateRender: true,
  maxZoomPixelRatio: 4,
  background: "#9bbdff",
  imageSmoothingEnabled: false,
  tileOverlap: 0
});

// ピクセルずれを軽減する試み（副作用注意）
viewer.addHandler('tile-drawing', function(event) {
  const ctx = event.renderedContext;
  if (!ctx || !event.rendered || !event.rendered.canvas) return;
  const x = Math.round(event.x);
  const y = Math.round(event.y);
  const w = Math.round(event.rendered.canvas.width);
  const h = Math.round(event.rendered.canvas.height);

  ctx.save();
  ctx.setTransform(1,0,0,1,0,0);
  ctx.imageSmoothingEnabled = false;
  try {
    ctx.drawImage(event.rendered.canvas, x, y, w, h);
    event.rendered = null;
  } catch(e) { /* フォールバックはOSDに任せる */ }
  ctx.restore();
});

// ==== キャッシュ（プリロード保持） ==============================
const preloadedTiles = {}; // { dziUrl: { url, item } }
let currentItem = null;    // 現在表示されている OpenSeadragon の item

// ==== ユーティリティ: 日付表示 ==================================
function formatDateLabel(dateStr) {
  const y = dateStr.slice(0,4);
  const m = dateStr.slice(4,6);
  const d = dateStr.slice(6,8);
  const hh = dateStr.slice(8,10);
  const mm = dateStr.slice(10,12);
  // 24時間 -> am/pm 変換
  const hnum = parseInt(hh,10);
  let ampm, hh12;
  if (hnum === 0) { ampm = "am"; hh12 = "00"; }
  else if (hnum < 12) { ampm = "am"; hh12 = ("0"+hnum).slice(-2); }
  else if (hnum === 12) { ampm = "pm"; hh12 = "12"; }
  else { ampm = "pm"; hh12 = ("0"+(hnum-12)).slice(-2); }
  return { main: `${y}.${m}.${d}`, sub: `${hh12}:${mm} ${ampm} (JST)` };
}

// ==== スライダー同期 ===========================================
function syncSliderImmediate(index) {
  // UI を即時に反映（loadDZI の呼び出し直後にも呼ぶ）
  range.value = index;
  updateRangeBackground();
  const labels = formatDateLabel(availableDates[index]);
  dateMainEl.textContent = labels.main;
  dateSubEl.textContent = labels.sub;
}

// ==== ビューポート保存/復元 ===================================
function captureViewportData() {
  if (!currentItem) return null;
  const bounds = viewer.viewport.getBounds();
  const imgSize = currentItem.getContentSize();
  const zoom = viewer.viewport.getZoom();
  if (!imgSize) return null;
  return {
    centerX: (bounds.x + bounds.width/2) * imgSize.x,
    centerY: (bounds.y + bounds.height/2) * imgSize.y,
    zoom: zoom,
    oldSize: imgSize
  };
}
function restoreViewport(savedData, item) {
  if (!savedData || !item) return;
  const newSize = item.getContentSize();
  if (!newSize) return;
  const newCenterX = savedData.centerX / newSize.x;
  const newCenterY = savedData.centerY / newSize.y;
  viewer.viewport.zoomTo(savedData.zoom, null, true);
  viewer.viewport.panTo(new OpenSeadragon.Point(newCenterX, newCenterY), true);
}

// ==== フェード切替処理 =========================================
// newSource: dziUrl (文字列) または tileSource オブジェクト
function smoothAddAndFade(newSource, savedData, onComplete) {
  // 既に切替中なら無視
  if (switching) {
    if (onComplete) onComplete(false);
    return;
  }
  switching = true;

  // 追加
  viewer.addTiledImage({
    tileSource: newSource,
    opacity: 0,
    success: function(event) {
      const newItem = event.item;

      // キャッシュ登録（sourceを保存）
      try { preloadedTiles[newItem.source] = { url: newItem.source, item: newItem }; } catch(e){}

      // まず保存されている座標を復元（可能なら）
      if (savedData) {
        try { restoreViewport(savedData, newItem); } catch(e){ /* ignore */ }
      }

      // oldItem を徐々にフェードアウト、新Item をフェードイン
      const oldItem = currentItem;
      newItem.setOpacity(0);
      // newItem を前面に
      try { viewer.world.setItemIndex(newItem, viewer.world.getItemCount()-1); } catch(e){}

      let op = 0;
      const step = 0.08; // フェード速度（大きいほど速い）
      const t = setInterval(() => {
        op = Math.min(1, op + step);
        try { newItem.setOpacity(op); } catch(e){}
        if (oldItem) try { oldItem.setOpacity(Math.max(0, 1-op)); } catch(e){}
        if (op >= 1) {
          clearInterval(t);
          // 古いアイテムを削除
          if (oldItem && viewer.world.getIndexOfItem(oldItem) !== -1) {
            try { viewer.world.removeItem(oldItem); } catch(e){}
          }
          currentItem = newItem;
          switching = false;
          if (onComplete) onComplete(true);
        }
      }, 16);
    },
    error: function(err) {
      console.warn("addTiledImage error", err);
      switching = false;
      if (onComplete) onComplete(false);
    }
  });
}

// ==== プリロード（非表示で事前読み込み） =======================
function preload(index) {
  if (index < 0 || index >= availableDates.length) return;
  const date = availableDates[index];
  const dziUrl = `${dziRoot}/${date}/tiled.dzi`;
  // すでにプリロード済みで world に存在するならスキップ
  const prev = Object.values(preloadedTiles).find(v => v.url === dziUrl);
  if (prev && prev.item && viewer.world.getIndexOfItem(prev.item) !== -1) return;

  viewer.addTiledImage({
    tileSource: dziUrl,
    opacity: 0,
    success: function(event) {
      // 保存（url と item）
      preloadedTiles[dziUrl] = { url: dziUrl, item: event.item };
    },
    error: function() { /* ignore preload errors */ }
  });
}

// ==== メイン読み込み関数 =====================================
function loadDZI(index) {
  if (index < 0 || index >= availableDates.length) return;
  // スライダー等 UI を即時更新（ユーザーに瞬時に変化を見せる）
  syncSliderImmediate(index);

  // 保存しておく（ズーム/中心位置）
  const savedData = captureViewportData();

  // もしプリロード済みの item があれば使う（その URL を渡す）
  const date = availableDates[index];
  const dziUrl = `${dziRoot}/${date}/tiled.dzi`;

  // 切替（add + fade）を実行
  smoothAddAndFade(dziUrl, savedData, (ok) => {
    // フェード完了後の処理（必要なら）
    if (!ok) { console.warn("切替に失敗:", dziUrl); }
  });

  // currentIndex は UI と同期のためここで設定（loadDZI 呼び出し元のロジックが楽）
  currentIndex = index;

  // 近傍をプリロード
  preload(index - 1);
  preload(index + 1);
}

// ==== スライダー操作 =========================================
range.addEventListener("input", () => {
  const idx = parseInt(range.value, 10);
  updateRangeBackground();
  if (idx === currentIndex) return;
  // 切替中なら一旦待つ（入力は無視しないが、loadはswitching解除後に行う）
  if (switching) {
    // 切替中は次の操作を queued にする代わりに、単純に無視してrange表示だけ更新
    return;
  }
  loadDZI(idx);
});

// ==== prev/next/再生 ===========================================
prevBtn.addEventListener("click", () => {
  if (switching) return;
  if (currentIndex > 0) loadDZI(currentIndex - 1);
});
nextBtn.addEventListener("click", () => {
  if (switching) return;
  if (currentIndex < availableDates.length - 1) loadDZI(currentIndex + 1);
});

playBtn.addEventListener("click", () => {
  if (isPlaying) {
    clearInterval(playInterval);
    isPlaying = false;
    playBtn.textContent = "⏵";
  } else {
    isPlaying = true;
    playBtn.textContent = "⏸";
    playInterval = setInterval(() => {
      // 切替中なら次まで待つ（ここで無理に loadDZI を呼ばない）
      if (switching) return;
      if (currentIndex < availableDates.length - 1) {
        loadDZI(currentIndex + 1);
      } else {
        clearInterval(playInterval);
        isPlaying = false;
        playBtn.textContent = "⏵";
      }
    }, 5000);
  }
});

// ==== 日付リスト（オーバーレイ） =================================
dateDisplay.addEventListener("click", (e) => {
  e.stopPropagation();
  const overlay = document.getElementById("date-overlay");
  const selector = document.getElementById("date-selector");
  const list = document.getElementById("date-list");
  list.innerHTML = "";
  availableDates.forEach((d, i) => {
    const btn = document.createElement("button");
    const f = formatDateLabel(d);
    btn.textContent = `${f.main} ${f.sub}`;
    btn.style.display = "block";
    btn.style.width = "100%";
    btn.style.margin = "6px 0";
    if (i === currentIndex) btn.style.fontWeight = "700";
    btn.onclick = () => { selector.style.display = "none"; overlay.style.display = "none"; loadDZI(i); };
    list.appendChild(btn);
  });
  selector.style.display = "block";
  overlay.style.display = "block";
});
document.getElementById("close-selector").addEventListener("click", () => {
  document.getElementById("date-selector").style.display = "none";
  document.getElementById("date-overlay").style.display = "none";
});
document.getElementById("date-overlay").addEventListener("click", () => {
  document.getElementById("date-selector").style.display = "none";
  document.getElementById("date-overlay").style.display = "none";
});

// ==== 初期ロード =================================================
// ページ表示時に必ず availableDates[0] を読み込む（要望 A）
window.addEventListener("DOMContentLoaded", () => {
  // UI を先に反映しておく
  syncSliderImmediate(0);
  loadDZI(0);
});