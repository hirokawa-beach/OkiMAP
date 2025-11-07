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

// === OpenSeadragon 初期化 ===
const viewer = OpenSeadragon({
  id: "viewer",
  prefixUrl: "https://cdnjs.cloudflare.com/ajax/libs/openseadragon/4.1.0/images/",
  showNavigationControl: true,
  showZoomControl: true,
  minZoomLevel: 0.8,
  defaultZoomLevel: 1,
  preserveViewport: true,
  visibilityRatio: 1.0,
  blendTime: 0.1,
  maxZoomPixelRatio: 4,
  background: "#9bbdff",
  imageSmoothingEnabled: false,
});

// === DZI 読み込み ===
function loadDZI(index) {
  const date = availableDates[index];
  const dziUrl = `${dziRoot}/${date}/tiled.dzi`;

  const dateObj = parseDate(date);
  document.getElementById("date-main").textContent = dateObj.main;
  document.getElementById("date-sub").textContent = dateObj.sub;

  viewer.open(dziUrl);
  currentIndex = index;
}

function parseDate(dateStr) {
  const y = dateStr.slice(0, 4);
  const m = dateStr.slice(4, 6);
  const d = dateStr.slice(6, 8);
  const h = dateStr.slice(8, 10);
  const min = dateStr.slice(10, 12);
  const ampm = h < 12 ? "am" : "pm";
  const hh = ("0" + (h % 12 || 12)).slice(-2);
  return {
    main: `${y}.${m}.${d}`,
    sub: `${ampm} ${hh}:${min} (JST)`,
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
    btn.textContent = "❚❚";
    playInterval = setInterval(() => {
      if (currentIndex < availableDates.length - 1) {
        loadDZI(currentIndex + 1);
      } else {
        clearInterval(playInterval);
        isPlaying = false;
        btn.textContent = "▶";
      }
    }, 5000);
  } else {
    clearInterval(playInterval);
    btn.textContent = "▶";
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

// === 初期ロード ===
loadDZI(0);