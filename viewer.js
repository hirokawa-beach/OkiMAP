const dziRoot = "img/dzi";
const availableDates = [
  "202508200005",
  "202508210000",
  "202508220000",
  "202508230000",
  "202508232300",
  "202508250000",
  "202508260000",
  "202508270000",
  "202508280000",
  "202508290100",
  "202508300000",
  "202508310000",
  "202509010000",
  "202509020000",
  "202509030000",
  "202509040000",
  "202509050000",
  "202509060000",
  "202509070000",
  "202509080000",
  "202509090000",
  "202509100000",
  "202509110000",
  "202509120000",
  "202509130000",
];

let currentIndex = 0;
let isPlaying = false;
let playInterval = null;

// === OpenSeadragon ===
const viewer = OpenSeadragon({
    id: "viewer",
    prefixUrl: "https://cdnjs.cloudflare.com/ajax/libs/openseadragon/4.1.0/images/",
    showNavigationControl: true,
    minZoomLevel: 0.5,
    defaultZoomLevel: 1,
    preserveViewport: true,
    visibilityRatio: 1.0,
    blendTime: 0,
    immediateRender: true,
    maxZoomPixelRatio: 4,
    background: "#9bbdff",
    imageSmoothingEnabled: false,
    tileOverlap: 0,               // タイル端余白を0に
    smoothTileEdgesMinZoom: Infinity,    // 端ぼかしを完全無効化
});

// タイル描画時のピクセルずれ修正
viewer.addHandler('tile-drawing', function(event) {
    const ctx = event.renderedContext;
    if (!ctx) return;
    
    // 描画座標とサイズを整数に丸める
    const x = Math.round(event.x);
    const y = Math.round(event.y);
    const w = Math.round(event.rendered.canvas.width);
    const h = Math.round(event.rendered.canvas.height);
    
    // transformをリセットして正確に配置
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    
    // 整数座標で描画
    ctx.drawImage(event.rendered.canvas, x, y, w, h);
    
    // 元の描画をキャンセル
    event.rendered = null;
});

// ビューポート更新時にもピクセルアライメントを強制
viewer.addHandler('animation', function(event) {
    const viewport = viewer.viewport;
    const bounds = viewport.getBounds(true);
    
    // ビューポートの座標を微調整してピクセルグリッドに合わせる
    const containerSize = viewport.getContainerSize();
    const zoom = viewport.getZoom(true);
    
    // ピクセル単位での位置計算
    const pixelX = bounds.x * containerSize.x * zoom;
    const pixelY = bounds.y * containerSize.y * zoom;
    
    // 整数位置に調整（必要に応じて）
    const adjustedX = Math.round(pixelX) / (containerSize.x * zoom);
    const adjustedY = Math.round(pixelY) / (containerSize.y * zoom);
    
    if (Math.abs(adjustedX - bounds.x) > 0.0001 || Math.abs(adjustedY - bounds.y) > 0.0001) {
        bounds.x = adjustedX;
        bounds.y = adjustedY;
    }
});

// 左クリック拡大
viewer.addHandler("canvas-click", function(event) {
  if (!event.quick) return; // シングルクリックのみ
  viewer.viewport.zoomBy(1.2);
  viewer.viewport.applyConstraints();
  logZoom();
});

// 右クリック縮小
viewer.addHandler("canvas-contextmenu", function(event) {
  event.preventDefaultAction = true; // デフォを無効化
  if (event.originalEvent) {
    event.originalEvent.preventDefault(); // ブラウザメニューを無効化
  }
  viewer.viewport.zoomBy(1 / 2);
  viewer.viewport.applyConstraints();
  logZoom();
});

viewer.addHandler("canvas-scroll", function(event){
    logZoom();
});

// 各日付で上側に追加されたピクセル数
const topOffsets = {
  "20250826": 0,
  "20250827": 0,
  "20250828": 0,
  "20250829": 0,  
};

// 各日付で左側に追加されたピクセル数
const leftOffsets = {
  "20250826": 0,
  "20250827": 0,
  "20250828": 0,  // もし左に追加されているなら
  "20250829": 0,
};

let preloadedTiles = {}; // キャッシュ用

function logZoom() {
    console.log("Zoom:", (viewer.viewport.getZoom()*100).toFixed(1) + "%");
}

function loadDZI(index) {
  const date = availableDates[index];
  const dziUrl = `${dziRoot}/${date}/tiled.dzi`;

  const dateObj = parseDate(date);
  document.getElementById("date-main").textContent = dateObj.main;
  document.getElementById("date-sub").textContent = dateObj.sub;

  let savedData = null;
  if (viewer.world.getItemCount() > 0) {
    const tiledImage = viewer.world.getItemAt(0);
    const bounds = viewer.viewport.getBounds();
    const imageSize = tiledImage.getContentSize();
    const zoom = viewer.viewport.getZoom();
    
    savedData = {
      centerX: (bounds.x + bounds.width / 2) * imageSize.x,
      centerY: (bounds.y + bounds.height / 2) * imageSize.y,
      zoom: zoom,
      oldSize: imageSize
    };
    
    console.log("=== Date change:", availableDates[currentIndex], "→", date, "===");
  }

  // キャッシュ済みなら即表示
  if (preloadedTiles[dziUrl]) {
    console.log("Using preloaded:", dziUrl);
    viewer.open({
      tileSource: preloadedTiles[dziUrl].source,
      success: (event) => restoreViewport(savedData, event),
    });
  } else {
    // 通常読み込み
    viewer.open({
      tileSource: dziUrl,
      success: (event) => {
        restoreViewport(savedData, event);
        // 読み込み完了したらキャッシュ登録
        preloadedTiles[dziUrl] = event.item;
        logZoom();
      },
    });
  }

  currentIndex = index;

  // プリロード（前後の日付）
  preloadNeighbor(index - 1);
  preloadNeighbor(index + 1);
}

function restoreViewport(savedData, event) {
  if (!savedData) return;
  const tiledImage = event.item;
  const newImageSize = tiledImage.getContentSize();
  const newCenterX = savedData.centerX / newImageSize.x;
  const newCenterY = savedData.centerY / newImageSize.y;
  viewer.viewport.zoomTo(savedData.zoom, null, true);
  viewer.viewport.panTo(new OpenSeadragon.Point(newCenterX, newCenterY), true);
}

function preloadNeighbor(index) {
  if (index < 0 || index >= availableDates.length) return;

  const date = availableDates[index];
  const dziUrl = `${dziRoot}/${date}/tiled.dzi`;
  if (preloadedTiles[dziUrl]) return; // すでに読み込み済みならスキップ

  console.log("Preloading:", dziUrl);
  viewer.addTiledImage({
    tileSource: dziUrl,
    opacity: 0, // 非表示
    success: (event) => {
      preloadedTiles[dziUrl] = event.item;
      console.log("✅ Preloaded:", dziUrl);
    },
  });
}

// === 表示している画像の時刻表示 ===
function parseDate(dateStr) {
  const y = dateStr.slice(0, 4);
  const m = dateStr.slice(4, 6);
  const d = dateStr.slice(6, 8);
  const h = parseInt(dateStr.slice(8, 10), 10);
  const min = dateStr.slice(10, 12);
  
  let ampm, hh;
  if (h === 0) {
    ampm = "am";
    hh = "00";
  } else if (h < 12) {
    ampm = "am";
    hh = ("0" + h).slice(-2);
  } else if (h === 12) {
    ampm = "pm";
    hh = "12";
  } else {
    ampm = "pm";
    hh = ("0" + (h - 12)).slice(-2);
  }
  return {
    main: `${y}.${m}.${d}`,
    sub: `${hh}:${min} ${ampm} (JST)`,
  };
}

// === ボタン操作 ===
document.getElementById("prev").addEventListener("click", () => {
  if (currentIndex > 0) loadDZI(currentIndex - 1);
});
document.getElementById("next").addEventListener("click", () => {
  if (currentIndex < availableDates.length - 1) loadDZI(currentIndex + 1);
});

// === 再生ボタン ===
document.getElementById("play-btn").addEventListener("click", () => {
  isPlaying = !isPlaying;
  const btn = document.getElementById("play-btn");
  if (isPlaying) {
    btn.textContent = "⏸";
    btn.style.fontSize = "1.5em";
    playInterval = setInterval(() => {
      if (currentIndex < availableDates.length - 1) {
        loadDZI(currentIndex + 1);
      } else {
        clearInterval(playInterval);
        isPlaying = false;
        btn.textContent = "▶";
        btn.style.fontSize = ""; 
      }
    }, 5000);
  } else {
    clearInterval(playInterval);
    btn.textContent = "▶";
    btn.style.fontSize = ""; 
  }
});

// === ドラッグ移動 ===
const timeBar = document.getElementById("time-bar");
let isDragging = false;
let offset = { x: 0, y: 0 };

timeBar.addEventListener("mousedown", (e) => {
  isDragging = true;
  offset.x = e.clientX - timeBar.offsetLeft;
  offset.y = e.clientY - timeBar.offsetTop;
  timeBar.style.cursor = "grabbing";
});

window.addEventListener("mousemove", (e) => {
  if (!isDragging) return;
  e.preventDefault();
  const x = e.clientX - offset.x;
  const y = e.clientY - offset.y;
  timeBar.style.left = `${x}px`;
  timeBar.style.top = `${y}px`;
  timeBar.style.transform = "none";
});

window.addEventListener("mouseup", () => {
  isDragging = false;
  timeBar.style.cursor = "grab";
});

// === 日付選択UI ===
const dateDisplay = document.getElementById("date-display");
const dateSelector = document.getElementById("date-selector");
const dateOverlay = document.getElementById("date-overlay");
const dateList = document.getElementById("date-list");
const closeSelector = document.getElementById("close-selector");

dateDisplay.addEventListener("click", (e) => {
  e.stopPropagation();
  dateList.innerHTML = "";
  availableDates.forEach((date, index) => {
    const dateObj = parseDate(date);
    const btn = document.createElement("button");
    btn.textContent = `${dateObj.main} ${dateObj.sub}`;
    btn.style.cssText = "padding: 10px; width: 100%; text-align: left; cursor: pointer; border: 1px solid #ccc; background: white; border-radius: 5px;";
    
    if (index === currentIndex) {
      btn.style.background = "#e3f2fd";
      btn.style.fontWeight = "bold";
    }
    
    btn.addEventListener("click", () => {
      loadDZI(index);
      dateSelector.style.display = "none";
      dateOverlay.style.display = "none";
    });
    
    btn.addEventListener("mouseenter", () => {
      btn.style.background = "#f0f0f0";
    });
    btn.addEventListener("mouseleave", () => {
      btn.style.background = index === currentIndex ? "#e3f2fd" : "white";
    });
    
    dateList.appendChild(btn);
  });
  
  dateSelector.style.display = "block";
  dateOverlay.style.display = "block";
});

closeSelector.addEventListener("click", () => {
  dateSelector.style.display = "none";
  dateOverlay.style.display = "none";
});

dateOverlay.addEventListener("click", () => {
  dateSelector.style.display = "none";
  dateOverlay.style.display = "none";
});

// === 初期ロード ===
loadDZI(0);
logZoom();