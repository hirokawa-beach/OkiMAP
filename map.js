// --- 設定 ---
const MIN_ZOOM_TO_SHOW = 8; // グリッド／オーバーレイを描画する最小ズーム

// --- 状態とキャッシュ ---
let map, tileLayer;
const tileCache = new Map(); // キャッシュ: "z/x/y" -> ImageBitmap
const tilePixelCache = new Map(); // キャッシュ: "z/x/y" -> {w,h,data}
const MAX_SAMPLES = 500000; // 最大サンプル数（自動間引きの閾値）
let isInteracting = false; // ← これが追加されてる
let redrawTimer = null;

// コントロール要素参照
const ctrl = {
    tileUrl: document.getElementById('tileUrl'),
    imgW: document.getElementById('imgW'),
    imgH: document.getElementById('imgH'),
    tileSize: document.getElementById('tileSize'),
    nativeMax: document.getElementById('nativeMax'),
    displayMax: document.getElementById('displayMax'),
    zoomSnap: document.getElementById('zoomSnap'),
    renderMode: document.getElementById('renderMode'),
    applyBtn: document.getElementById('applyBtn'),
    fitBtn: document.getElementById('fitBtn'),
    zoomInfo: document.getElementById('zoomInfo'),
    coordsInfo: document.getElementById('coordsInfo'),
    pixelPickerToggle: document.getElementById('pixelPickerToggle'),
    pixelGridToggle: document.getElementById('pixelGridToggle'),
    colorizeToggle: document.getElementById('colorizeToggle'),
    sampleStep: document.getElementById('sampleStep'),
    overlayOpacity: document.getElementById('overlayOpacity'),
    pixelOutput: document.getElementById('pixelOutput'),
    colorSwatch: document.getElementById('colorSwatch'),
    pixelText: document.getElementById('pixelText'),
    copyColor: document.getElementById('copyColor'),
    clearCache: document.getElementById('clearCache'),
    gridMinScreen: document.getElementById('gridMinScreen')
};

const canvas = document.getElementById('pixelGridCanvas');
const ctx = canvas.getContext('2d');
const pixelMarker = document.getElementById('pixelMarker');

// タイル URL 組み立て
function tileUrl(z, x, y) {
  return ctrl.tileUrl.value
    .replace('{z}', z)
    .replace('{x}', x)
    .replace('{y}', y)
    + `?native=${z}`;
}

// --- マップ初期化 ---
function initMap() {
    map = L.map('map', {
        crs: L.CRS.Simple,
        minZoom: 0,
        maxZoom: parseInt(ctrl.displayMax.value, 10),
        zoomSnap: parseFloat(ctrl.zoomSnap.value),
        zoomDelta: 1,
        inertia: false
    });

    tileLayer = L.tileLayer('', { noWrap: true }).addTo(map);

    // 表示変化時に再描画
    map.on('click', onMapClick);
    map.on('zoomstart', onInteractionStart); // ← 変更
    map.on('zoomend', onInteractionEnd); // ← 変更
    map.on('movestart', onInteractionStart); // ← 変更
    map.on('moveend', onInteractionEnd);
    window.addEventListener('resize', resizeCanvasToMap);
    resizeCanvasToMap();
}

// レイヤー削除
function clearLayer() {
    if (tileLayer) {
        try { map.removeLayer(tileLayer); } catch (e) { }
        tileLayer = null;
    }
}

// 設定を適用
function applySettings() {
    const tileUrlVal = ctrl.tileUrl.value.trim() || 'img/tiles/{z}/{x}/{y}.png';
    const imgW = Math.max(1, parseInt(ctrl.imgW.value, 10));
    const imgH = Math.max(1, parseInt(ctrl.imgH.value, 10));
    const tileSize = Math.max(16, parseInt(ctrl.tileSize.value, 10));
    const nativeMax = Math.max(0, parseInt(ctrl.nativeMax.value, 10));
    const displayMax = Math.max(nativeMax, parseInt(ctrl.displayMax.value, 10));
    const zoomSnap = parseFloat(ctrl.zoomSnap.value);
    const renderMode = ctrl.renderMode.value;

    map.options.maxZoom = displayMax;
    map.options.zoomSnap = zoomSnap;

    const southWest = map.unproject([0, imgH], nativeMax);
    const northEast = map.unproject([imgW, 0], nativeMax);
    const bounds = new L.LatLngBounds(southWest, northEast);

    clearLayer();
    tileLayer = L.tileLayer(tileUrlVal, {
        tileSize: tileSize,
        maxNativeZoom: nativeMax,
        maxZoom: displayMax, //オーバーレイ非表示・ドラッグ時のガイドとして
        detectRetina: false,
        noWrap: true
    }).addTo(map);
    // createTile をオーバーライド
    const originalCreateTile = tileLayer.createTile.bind(tileLayer);
    tileLayer.createTile = function (coords, done) {
        // 負の座標は読み込まない
        if (coords.x < 0 || coords.y < 0) {
            const tile = document.createElement('img');
            setTimeout(done, 0);
            return tile;
        }
        return originalCreateTile(coords, done);
    };
    if (map.getZoom() > nativeMax) {
        tileLayer.setOpacity(0);
    } else {
        tileLayer.setOpacity(1);
    }
    if (renderMode === 'pixel') {
        document.getElementById('map').classList.add('tile-pixelated');
    } else {
        document.getElementById('map').classList.remove('tile-pixelated');
    }

    map.fitBounds(bounds, { maxZoom: displayMax });

    updateZoomInfo();
    console.log('Applied settings:', { tileUrlVal, imgW, imgH, tileSize, nativeMax, displayMax, zoomSnap, renderMode });

    // タイルキャッシュをクリアして再描画
    tileCache.clear();
    tilePixelCache.clear();
    drawPixelGrid();
}

// ズーム情報更新
function updateZoomInfo() {
    const z = map.getZoom();
    const nativeMax = parseInt(ctrl.nativeMax.value, 10);
    const scale = Math.pow(2, z - nativeMax);
    const scaleText = z >= nativeMax ? `×${scale}` : `1/${Math.pow(2, nativeMax - z)}`;
    ctrl.zoomInfo.textContent = `zoom: ${z} (nativeMax: ${nativeMax}, scale: ${scaleText})`;
}

// マウス座標表示（ピクセル単位）
function showCoords(e) {
    const nativeMax = parseInt(ctrl.nativeMax.value, 10);
    const p = map.project(e.latlng, nativeMax);
    ctrl.coordsInfo.textContent = `pixel: ${Math.round(p.x)} , ${Math.round(p.y)}`;
}

// キャンバスサイズをマップに合わせる
function resizeCanvasToMap() {
    const size = map.getSize ? map.getSize() : { x: window.innerWidth, y: window.innerHeight };
    const dpr = window.devicePixelRatio || 1;
    canvas.style.width = size.x + 'px';
    canvas.style.height = size.y + 'px';
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
    clearCanvas(); // オーバーレイを即座にクリア
    pixelMarker.style.display = 'none'; // ピクセルマーカーも非表示
    if (redrawTimer) clearTimeout(redrawTimer);
}

function onInteractionEnd() {
    isInteracting = false;
    updateZoomInfo();
    // 操作終了後、少し遅延してから再描画(連続操作対策)
    if (redrawTimer) clearTimeout(redrawTimer);
    redrawTimer = setTimeout(() => {
        resizeCanvasToMap();
    }, 150);
}

function onResize() {
    resizeCanvasToMap();
}

// メイン: グリッド/オーバーレイ描画（MIN_ZOOM_TO_SHOW 未満ではスキップ）
async function drawPixelGrid() {
    if (isInteracting) return;
    clearCanvas();
    pixelMarker.style.display = 'none';

    const currentZoom = map.getZoom();

    // 最小ズーム未満なら重い描画はしない（設定トグルがオンでも無視）
    if (currentZoom < MIN_ZOOM_TO_SHOW) {
        return;
    }

    // まずオーバーレイ（色付け）を描き、その上にグリッドを描画する
    if (ctrl.colorizeToggle.checked) {
        await drawColorOverlay();
    }
    if (ctrl.pixelGridToggle.checked) {
        // グリッドの間引き間隔を決定（画面上のピクセルサイズを考慮）
        const p0 = map.latLngToContainerPoint(map.unproject([0, 0], parseInt(ctrl.nativeMax.value, 10)));
        const p1x = map.latLngToContainerPoint(map.unproject([1, 0], parseInt(ctrl.nativeMax.value, 10)));
        const p1y = map.latLngToContainerPoint(map.unproject([0, 1], parseInt(ctrl.nativeMax.value, 10)));
        const scale = Math.pow(2, map.getZoom() - nativeMax);
        const pixelScreenX = scale;
        const pixelScreenY = scale;
        const minScreen = Math.max(1, parseFloat(ctrl.gridMinScreen.value) || 6);
        const stepGrid = Math.max(1, Math.ceil(minScreen / Math.max(pixelScreenX, pixelScreenY, 1e-9)));
        drawGridLines(stepGrid, pixelScreenX, pixelScreenY);
    }
}

// グリッド線を描く
function drawGridLines(step, pixelScreenX, pixelScreenY) {
    const nativeMax = parseInt(ctrl.nativeMax.value, 10);
    const topLeftLatLng = map.containerPointToLatLng([0, 0]);
    const bottomRightLatLng = map.containerPointToLatLng([map.getSize().x, map.getSize().y]);
    const topLeftPx = map.project(topLeftLatLng, nativeMax);
    const bottomRightPx = map.project(bottomRightLatLng, nativeMax);
    const startX = Math.floor(Math.min(topLeftPx.x, bottomRightPx.x));
    const endX = Math.ceil(Math.max(topLeftPx.x, bottomRightPx.x));
    const startY = Math.floor(Math.min(topLeftPx.y, bottomRightPx.y));
    const endY = Math.ceil(Math.max(topLeftPx.y, bottomRightPx.y));
    const contStart = map.latLngToContainerPoint(map.unproject([startX, startY], nativeMax));
    const dX = pixelScreenX;
    const dY = pixelScreenY;

    ctx.save();
    ctx.lineWidth = 1;
    ctx.imageSmoothingEnabled = false;
    const canvasW = map.getSize().x;
    const canvasH = map.getSize().y;

    // コントラストを確保するため白と黒の二重線にする
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
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

    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
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

// --- オーバーレイ（色付き）描画 ---
// 低ズームで抽象化（ブロック状）にならないよう、ズームに応じて描画法を変える。
async function drawColorOverlay() {
    const nativeMax = parseInt(ctrl.nativeMax.value, 10);
    const tileSize = parseInt(ctrl.tileSize.value, 10);
    const p0 = map.latLngToContainerPoint(map.unproject([0, 0], nativeMax));
    const p1x = map.latLngToContainerPoint(map.unproject([1, 0], nativeMax));
    const p1y = map.latLngToContainerPoint(map.unproject([0, 1], nativeMax));
    const pixelScreenX = Math.abs(p1x.x - p0.x);
    const pixelScreenY = Math.abs(p1y.y - p0.y);
    const pixelScreen = Math.max(pixelScreenX, pixelScreenY);

    // 表示領域の画像ピクセル範囲を求める
    const topLeftLatLng = map.containerPointToLatLng([0, 0]);
    const bottomRightLatLng = map.containerPointToLatLng([map.getSize().x, map.getSize().y]);
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

    // 画面ピクセル数（viewport）
    const vw = map.getSize().x;
    const vh = map.getSize().y;

    const offscreen = document.createElement('canvas');
    let offscreenCtx = offscreen.getContext('2d');
    let offImageData = null;
    if (offscreen.width !== vw || offscreen.height !== vh) {
        offscreen.width = vw;
        offscreen.height = vh;
        offImageData = offscreenCtx.createImageData(vw, vh);
    }
    // 低ズーム（1画像ピクセル < 1 screen px）の場合はスクリーンピクセル毎に最近傍色を割り当てる方式へ切替
    if (pixelScreen < 1) {
        // 作業量が大きくなりすぎないようにステップを自動調整する
        const MAX_PIXELS_WORK = 200000;
        let stepScreen = 1;
        if (vw * vh > MAX_PIXELS_WORK) {
            stepScreen = Math.ceil(Math.sqrt((vw * vh) / MAX_PIXELS_WORK));
        }

        // ビューポートと同じサイズのオフスクリーンを作り、ImageData に直接ピクセルを書き込む
        const off = document.createElement('canvas');
        off.width = vw;
        off.height = vh;
        const offCtx = off.getContext('2d');
        const imageData = offCtx.createImageData(vw, vh);
        const data = imageData.data;

        // ビュー左上のコンテナ座標基準点
        const contStart = map.latLngToContainerPoint(map.unproject([startX, startY], nativeMax));

        // 画面上の各サンプル点に対して対応する画像ピクセルを取り、その色を ImageData に埋める
        for (let cy = 0; cy < vh; cy += stepScreen) {
            const imageYf = startY + (cy - contStart.y) / (pixelScreenY || 1);
            const imageSy = Math.floor(imageYf);
            for (let cx = 0; cx < vw; cx += stepScreen) {
                const imageXf = startX + (cx - contStart.x) / (pixelScreenX || 1);
                const imageSx = Math.floor(imageXf);

                // 範囲外チェック
                if (imageSx < 0 || imageSy < 0) continue;
                if (imageSx > endX || imageSy > endY) continue;

                // 対応タイルとタイル内座標
                const tx = Math.floor(imageSx / tileSize);
                const ty = Math.floor(imageSy / tileSize);
                const inTx = imageSx - tx * tileSize;
                const inTy = imageSy - ty * tileSize;
                const key = `${nativeMax}/${tx}/${ty}`;

                try {
                    let tilePixels = tilePixelCache.get(key);
                    if (!tilePixels) {
                        const bitmap = await fetchTileBitmap(nativeMax, tx, ty);
                        const tmp = document.createElement('canvas');
                        tmp.width = bitmap.width;
                        tmp.height = bitmap.height;
                        const tctx = tmp.getContext('2d');
                        tctx.drawImage(bitmap, 0, 0);
                        const img = tctx.getImageData(0, 0, tmp.width, tmp.height);
                        tilePixels = { w: tmp.width, h: tmp.height, data: img.data };
                        tilePixelCache.set(key, tilePixels);
                    }
                    if (inTx < 0 || inTy < 0 || inTx >= tilePixels.w || inTy >= tilePixels.h) continue;
                    const idx = (inTy * tilePixels.w + inTx) * 4;
                    const r = tilePixels.data[idx];
                    const g = tilePixels.data[idx + 1];
                    const b = tilePixels.data[idx + 2];
                    const a = tilePixels.data[idx + 3];

                    // stepScreen x stepScreen ブロックを埋める
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
                    // タイル取得失敗は無視（透明のまま）
                    continue;
                }
            }
        }

        // 作成した ImageData をオフスクリーンに描き、オーバーレイとして合成する
        offCtx.putImageData(imageData, 0, 0);
        ctx.save();
        ctx.globalAlpha = parseFloat(ctrl.overlayOpacity.value);
        ctx.drawImage(off, 0, 0, vw, vh);
        ctx.restore();
        return;
    }

    // --- 高ズームモード: 画素ごとの正確なサンプリング（以前のロジックを踏襲） ---
    let userStep = Math.max(1, parseInt(ctrl.sampleStep.value, 10));
    let autoStep = userStep;
    if (pixelScreen > 0 && pixelScreen < 1) {
        autoStep = Math.max(autoStep, Math.ceil(1 / pixelScreen));
    }

    // サンプル数の見積もりと自動間引き
    let totalEstimate = 0;
    for (let tx = startTileX; tx <= endTileX; tx++) {
        for (let ty = startTileY; ty <= endTileY; ty++) {
            const left = Math.max(startX, tx * tileSize);
            const right = Math.min(endX, (tx + 1) * tileSize);
            const top = Math.max(startY, ty * tileSize);
            const bottom = Math.min(endY, (ty + 1) * tileSize);
            if (right <= left || bottom <= top) continue;
            const w = right - left;
            const h = bottom - top;
            totalEstimate += Math.ceil(w / autoStep) * Math.ceil(h / autoStep);
        }
    }

    let step = autoStep;
    if (totalEstimate > MAX_SAMPLES) {
        const factor = Math.sqrt(totalEstimate / MAX_SAMPLES);
        step = Math.ceil(step * factor);
    }

    const dX = Math.max(1, Math.round(pixelScreenX * step));
    const dY = Math.max(1, Math.round(pixelScreenY * step));

    ctx.save();
    ctx.globalAlpha = parseFloat(ctrl.overlayOpacity.value);

    for (let tx = startTileX; tx <= endTileX; tx++) {
        for (let ty = startTileY; ty <= endTileY; ty++) {
            const key = `${nativeMax}/${tx}/${ty}`;
            try {
                let tilePixels = tilePixelCache.get(key);
                if (!tilePixels) {
                    const bitmap = await fetchTileBitmap(nativeMax, tx, ty);
                    const offc = document.createElement('canvas');
                    offc.width = bitmap.width;
                    offc.height = bitmap.height;
                    const offCtx = offc.getContext('2d');
                    offCtx.drawImage(bitmap, 0, 0);
                    const imgData = offCtx.getImageData(0, 0, offc.width, offc.height);
                    tilePixels = { w: offc.width, h: offc.height, data: imgData.data };
                    tilePixelCache.set(key, tilePixels);
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
                        if (sx < 0 || sy < 0 || sx >= tilePixels.w || sy >= tilePixels.h) continue;
                        const idx = (sy * tilePixels.w + sx) * 4;
                        const r = tilePixels.data[idx];
                        const g = tilePixels.data[idx + 1];
                        const b = tilePixels.data[idx + 2];
                        const a = tilePixels.data[idx + 3] / 255;

                        const imagePxX = tx * tileSize + sx;
                        const imagePxY = ty * tileSize + sy;
                        const cont = map.latLngToContainerPoint(map.unproject([imagePxX, imagePxY], nativeMax));
                        const rx = (cont.x + 0.5) | 0;
                        const ry = (cont.y + 0.5) | 0;
                        if (rx + dX < 0 || rx > map.getSize().x || ry + dY < 0 || ry > map.getSize().y) continue;

                        ctx.fillStyle = `rgba(${r},${g},${b},${a})`;
                        ctx.fillRect(rx, ry, dX, dY);
                    }
                }
            } catch (err) {
                continue;
            }
        }
    }

    ctx.restore();
}

// タイルを取得して ImageBitmap を返す（キャッシュあり）
async function fetchTileBitmap(z, x, y) {
    const key = `${z}/${x}/${y}`;
    if (tileCache.has(key)) return tileCache.get(key);
    const url = tileUrl(z, x, y);
    const resp = await fetch(url, { mode: 'cors' });
    if (!resp.ok) throw new Error(`Tile fetch failed: ${resp.status} ${resp.statusText}`);
    const blob = await resp.blob();
    const bitmap = await createImageBitmap(blob);
    tileCache.set(key, bitmap);
    return bitmap;
}

// ビットマップから単一ピクセルの色を読む
async function readPixelFromTileBitmap(bitmap, x, y) {
    if (x < 0 || y < 0 || x >= bitmap.width || y >= bitmap.height) return null;
    const tmp = document.createElement('canvas');
    tmp.width = bitmap.width;
    tmp.height = bitmap.height;
    const c = tmp.getContext('2d');
    c.drawImage(bitmap, 0, 0);
    const d = c.getImageData(x, y, 1, 1).data;
    return { r: d[0], g: d[1], b: d[2], a: d[3] };
}

// ピクセル選択（クリック時）
let lastPicked = null;
async function onMapClick(e) {
    if (!ctrl.pixelPickerToggle.checked) return;

    const nativeMax = parseInt(ctrl.nativeMax.value, 10);
    const tileSize = parseInt(ctrl.tileSize.value, 10);

    const p = map.project(e.latlng, nativeMax);
    const px = Math.floor(p.x);
    const py = Math.floor(p.y);

    const tileX = Math.floor(px / tileSize);
    const tileY = Math.floor(py / tileSize);
    const inTileX = px - tileX * tileSize;
    const inTileY = py - tileY * tileSize;

    ctrl.pixelText.textContent = `pixel: ${px}, ${py}\nタイル: z=${nativeMax}, x=${tileX}, y=${tileY}\n読み込み中...`;
    ctrl.pixelOutput.style.display = 'flex';
    ctrl.colorSwatch.style.background = '#ffffff';

    try {
        const bitmap = await fetchTileBitmap(nativeMax, tileX, tileY);
        const pxData = await readPixelFromTileBitmap(bitmap, inTileX, inTileY);
        if (!pxData) throw new Error('タイル内座標が範囲外です');
        const { r, g, b, a } = pxData;
        const hex = '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();
        ctrl.colorSwatch.style.background = hex;
        ctrl.pixelText.textContent = `pixel: ${px}, ${py}\nタイル: z=${nativeMax}, x=${tileX}, y=${tileY}\nRGBA: ${r}, ${g}, ${b}, ${a}\nHEX: ${hex}`;
        lastPicked = { px, py, r, g, b, a, hex };

        showPixelMarker(px, py);
    } catch (err) {
        console.error(err);
        ctrl.pixelText.textContent = `pixel: ${px}, ${py}\nエラー: ${err.message}\nCORS を確認してください`;
        ctrl.colorSwatch.style.background = '#ffffff';
        lastPicked = null;
        pixelMarker.style.display = 'none';
    }
}

// 選択ピクセルを赤枠で表示
function showPixelMarker(imagePxX, imagePxY) {
    const nativeMax = parseInt(ctrl.nativeMax.value, 10);
    const topLeft = map.latLngToContainerPoint(map.unproject([imagePxX, imagePxY], nativeMax));
    const bottomRight = map.latLngToContainerPoint(map.unproject([imagePxX + 1, imagePxY + 1], nativeMax));
    const left = Math.round(topLeft.x);
    const top = Math.round(topLeft.y);
    const w = Math.max(1, Math.round(bottomRight.x - topLeft.x));
    const h = Math.max(1, Math.round(bottomRight.y - topLeft.y));

    pixelMarker.style.left = left + 'px';
    pixelMarker.style.top = top + 'px';
    pixelMarker.style.width = w + 'px';
    pixelMarker.style.height = h + 'px';
    pixelMarker.style.display = 'block';
    setTimeout(() => {
        if (!ctrl.pixelPickerToggle.checked) pixelMarker.style.display = 'none';
    }, 2000);
}

// 色をクリップボードにコピー
ctrl.copyColor.addEventListener('click', () => {
    if (!lastPicked) return;
    const text = lastPicked.hex;
    navigator.clipboard?.writeText(text).then(() => {
        ctrl.copyColor.textContent = 'コピー済み';
        setTimeout(() => ctrl.copyColor.textContent = 'HEXをコピー', 1200);
    }, () => {
        alert('コピーに失敗しました');
    });
});

// キャッシュクリア
ctrl.clearCache.addEventListener('click', () => {
    tileCache.clear();
    tilePixelCache.clear();
    ctrl.pixelText.textContent = 'キャッシュをクリアしました';
});

// トグル変更時は再描画
ctrl.pixelGridToggle.addEventListener('change', () => {
    drawPixelGrid();
});
ctrl.colorizeToggle.addEventListener('change', () => {
    drawPixelGrid();
});
ctrl.pixelPickerToggle.addEventListener('change', () => {
    if (!ctrl.pixelPickerToggle.checked) {
        ctrl.pixelOutput.style.display = 'none';
        lastPicked = null;
        pixelMarker.style.display = 'none';
    }
});

// Apply / Fit ボタン
ctrl.applyBtn.addEventListener('click', () => {
    try {
        applySettings();
    } catch (err) {
        alert('設定適用エラー: ' + err.message);
    }
});
ctrl.fitBtn.addEventListener('click', () => {
    const imgW = Math.max(1, parseInt(ctrl.imgW.value, 10));
    const imgH = Math.max(1, parseInt(ctrl.imgH.value, 10));
    const nativeMax = Math.max(0, parseInt(ctrl.nativeMax.value, 10));
    const southWest = map.unproject([0, imgH], nativeMax);
    const northEast = map.unproject([imgW, 0], nativeMax);
    const bounds = new L.LatLngBounds(southWest, northEast);
    map.fitBounds(bounds, { maxZoom: parseInt(ctrl.displayMax.value, 10) });
});

// 初期化
initMap();
applySettings();

// キーボードショートカット
window.addEventListener('keydown', (ev) => {
    if (ev.key === '+' || ev.key === '=') map.zoomIn();
    if (ev.key === '-') map.zoomOut();
    if (ev.key === 'r') ctrl.fitBtn.click();
});

// 初回キャンバスサイズ合わせ
resizeCanvasToMap();