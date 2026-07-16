(() => {
  "use strict";

  const KINDS = {
    plan: { label: "開発計画", icon: "🏗️" },
    working: { label: "作業中", icon: "🚧" },
    report: { label: "報告", icon: "📣" },
    question: { label: "質問", icon: "❓" },
  };
  const STATUSES = {
    open: "未着手",
    in_progress: "進行中",
    review: "確認待ち",
    done: "完了",
    on_hold: "保留",
  };

  const $ = (id) => document.getElementById(id);
  const dom = {
    button: $("collabBtn"),
    visibilityButton: $("pinVisibilityBtn"),
    panel: $("collabPanel"),
    close: $("collabCloseBtn"),
    connection: $("collabConnection"),
    userLabel: $("collabUserLabel"),
    login: $("collabLoginBtn"),
    logout: $("collabLogoutBtn"),
    notificationButton: $("notificationBtn"),
    notificationBadge: $("notificationBadge"),
    notificationView: $("notificationView"),
    notificationSummary: $("notificationSummary"),
    notificationList: $("notificationList"),
    readAllNotifications: $("readAllNotificationsBtn"),
    browse: $("collabBrowseView"),
    kindFilter: $("pinKindFilter"),
    statusFilter: $("pinStatusFilter"),
    favoriteFilterLabel: $("favoriteFilterLabel"),
    favoriteFilter: $("favoriteFilter"),
    startPin: $("startPinBtn"),
    modeHint: $("pinModeHint"),
    cancelPinMode: $("cancelPinModeBtn"),
    list: $("pinList"),
    editor: $("pinEditor"),
    editorHeading: $("pinEditorTitle"),
    coordinate: $("pinCoordinate"),
    kind: $("pinKind"),
    status: $("pinStatus"),
    title: $("pinTitle"),
    body: $("pinBody"),
    relatedUrl: $("pinRelatedUrl"),
    editorError: $("pinEditorError"),
    savePin: $("savePinBtn"),
    detail: $("pinDetail"),
    detailContent: $("pinDetailContent"),
    detailActions: $("pinDetailActions"),
    commentList: $("commentList"),
    commentForm: $("commentForm"),
    commentBody: $("commentBody"),
    commentError: $("commentError"),
    commentLoginHint: $("commentLoginHint"),
    commentScrollTop: $("commentScrollTopBtn"),
    commentEditor: $("commentEditor"),
    commentEditBody: $("commentEditBody"),
    commentEditorError: $("commentEditorError"),
    saveCommentEdit: $("saveCommentEditBtn"),
    commentEditorBack: $("commentEditorBackBtn"),
    cancelCommentEdit: $("cancelCommentEditBtn"),
  };

  const state = {
    apiBaseUrl: "",
    configured: false,
    user: null,
    profile: null,
    pins: [],
    profiles: new Map(),
    map: null,
    layer: null,
    addMode: false,
    pendingPoint: null,
    editingPin: null,
    selectedPin: null,
    editingComment: null,
    notifications: [],
    unreadCount: 0,
    notificationTimer: null,
    display: {
      pinsVisible: true,
      pinTitles: true,
      pinHoverContent: true,
    },
  };

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function formatDate(value) {
    if (!value) return "";
    return new Intl.DateTimeFormat("ja-JP", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(value));
  }

  function safeUrl(value) {
    if (!value) return null;
    try {
      const url = new URL(value);
      return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
    } catch (_) {
      return null;
    }
  }

  class ApiError extends Error {
    constructor(message, status) {
      super(message);
      this.name = "ApiError";
      this.status = status;
    }
  }

  async function apiRequest(path, options = {}) {
    const requestOptions = {
      method: options.method || "GET",
      credentials: "include",
      headers: { Accept: "application/json" },
    };
    if (options.body !== undefined) {
      requestOptions.headers["Content-Type"] = "application/json";
      requestOptions.body = JSON.stringify(options.body);
    }
    const response = await fetch(`${state.apiBaseUrl}${path}`, requestOptions);
    if (!response.ok) {
      let message = `API request failed (${response.status})`;
      try {
        const errorBody = await response.json();
        if (errorBody?.detail) message = errorBody.detail;
      } catch (_) {}
      throw new ApiError(message, response.status);
    }
    if (response.status === 204) return null;
    return response.json();
  }

  function profileFor(id) {
    return state.profiles.get(id) || {
      display_name: "不明なユーザー",
      avatar_url: null,
      is_admin: false,
    };
  }

  function canManage(authorId) {
    return !!state.user && (state.user.id === authorId || state.profile?.is_admin);
  }

  function profileLabel(profile) {
    const name = profile?.display_name || "不明なユーザー";
    return `${name}${profile?.is_admin ? "（管理者）" : ""}`;
  }

  function formatPixelCoordinate(x, y) {
    const pixel = window.OkiMap?.imagePointToDisplayPixel?.(x, y);
    return pixel
      ? `pixel: ${pixel.tileX}, ${pixel.tileY}, ${pixel.inX}, ${pixel.inY}`
      : "pixel: --, --, --, --";
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"]/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
    })[character]);
  }

  function summarize(value, limit) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    if (!text) return "内容はありません。";
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
  }

  function updateVisibilityButton() {
    const visible = state.display.pinsVisible;
    dom.visibilityButton.textContent = visible ? "📌 ピン ON" : "📍 ピン OFF";
    dom.visibilityButton.setAttribute("aria-pressed", String(visible));
    dom.visibilityButton.title = visible
      ? "地図上の共有ピンを非表示"
      : "地図上の共有ピンを表示";
    dom.visibilityButton.classList.toggle("is-off", !visible);
  }

  function applyDisplaySettings(settings) {
    state.display = { ...state.display, ...(settings || {}) };
    updateVisibilityButton();
    renderMarkers(filteredPins());
  }

  function setPanel(open) {
    dom.panel.classList.toggle("hidden", !open);
    dom.button.setAttribute("aria-expanded", String(open));
    if (!open) cancelAddMode();
  }

  function showView(name) {
    dom.browse.classList.toggle("hidden", name !== "browse");
    dom.editor.classList.toggle("hidden", name !== "editor");
    dom.detail.classList.toggle("hidden", name !== "detail");
    dom.commentEditor.classList.toggle("hidden", name !== "comment-editor");
    dom.notificationView.classList.toggle("hidden", name !== "notifications");
  }

  function setBusy(button, busy, label) {
    button.disabled = busy;
    if (busy) {
      button.dataset.previousLabel = button.textContent;
      button.textContent = label;
    } else if (button.dataset.previousLabel) {
      button.textContent = button.dataset.previousLabel;
      delete button.dataset.previousLabel;
    }
  }

  function updateAuthUi() {
    const signedIn = !!state.user;
    dom.login.classList.toggle("hidden", signedIn || !state.configured);
    dom.logout.classList.toggle("hidden", !signedIn);
    dom.startPin.disabled = !signedIn;
    dom.startPin.title = signedIn ? "" : "投稿にはDiscordログインが必要です";
    dom.commentForm.classList.toggle("hidden", !signedIn || !state.selectedPin);
    dom.commentLoginHint.classList.toggle("hidden", signedIn);
    dom.notificationButton.classList.toggle("hidden", !signedIn);
    dom.favoriteFilterLabel.classList.toggle("hidden", !signedIn);
    if (!signedIn) dom.favoriteFilter.checked = false;
    if (signedIn) {
      const suffix = state.profile?.is_admin ? "（管理者）" : "";
      dom.userLabel.textContent = `${state.profile?.display_name || "Discordユーザー"}${suffix}`;
    } else {
      dom.userLabel.textContent = "閲覧モード";
    }
  }

  function rememberAuthors(records) {
    for (const record of records || []) {
      if (record.author?.id) state.profiles.set(record.author.id, record.author);
    }
  }

  async function loadSession() {
    const session = await apiRequest("/auth/session");
    state.user = session.user || null;
    state.profile = state.user;
    if (state.user) state.profiles.set(state.user.id, state.user);
    updateAuthUi();
  }

  function filteredPins() {
    const kind = dom.kindFilter.value;
    const status = dom.statusFilter.value;
    return state.pins.filter((pin) => {
      if (dom.favoriteFilter.checked && !pin.is_favorite) return false;
      if (kind !== "all" && pin.kind !== kind) return false;
      if (status === "active" && pin.status === "done") return false;
      return status === "all" || status === "active" || pin.status === status;
    });
  }

  function makeBadge(pin) {
    const badge = el("span", `pin-badge kind-${pin.kind}`);
    badge.textContent = `${KINDS[pin.kind]?.icon || "📌"} ${KINDS[pin.kind]?.label || pin.kind}`;
    return badge;
  }

  function updateFavoriteButton(button, pin) {
    const active = !!pin.is_favorite;
    const count = Number(pin.favorite_count || 0);
    button.classList.toggle("is-favorite", active);
    button.setAttribute("aria-pressed", String(active));
    button.title = active ? "お気に入りから外す" : "お気に入りに追加";
    button.textContent = button.classList.contains("favorite-list-btn")
      ? active ? "★" : "☆"
      : `${active ? "★" : "☆"} ${active ? "お気に入り済み" : "お気に入り"}${count ? ` (${count})` : ""}`;
  }

  function makeFavoriteButton(pin, className) {
    const button = el("button", className);
    button.type = "button";
    updateFavoriteButton(button, pin);
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      if (!state.user || button.disabled) return;
      button.disabled = true;
      try {
        const result = await apiRequest(`/pins/${encodeURIComponent(pin.id)}/favorite`, {
          method: pin.is_favorite ? "DELETE" : "POST",
        });
        Object.assign(pin, result);
        const storedPin = state.pins.find((item) => item.id === pin.id);
        if (storedPin && storedPin !== pin) Object.assign(storedPin, result);
        updateFavoriteButton(button, pin);
        renderList();
      } catch (error) {
        console.error("Failed to update favorite", error);
        alert("お気に入りを更新できませんでした。");
      } finally {
        button.disabled = false;
      }
    });
    return button;
  }

  function renderList() {
    dom.list.replaceChildren();
    const pins = filteredPins();
    if (!state.configured) {
      dom.list.append(el("p", "collab-empty", "共有ピンの接続設定がまだありません。"));
      renderMarkers([]);
      return;
    }
    if (!pins.length) {
      dom.list.append(el("p", "collab-empty", "条件に一致するピンはありません。"));
      renderMarkers([]);
      return;
    }
    for (const pin of pins) {
      const row = el("div", "pin-list-row");
      const button = el("button", "pin-list-item");
      button.type = "button";
      const top = el("span", "pin-list-top");
      top.append(makeBadge(pin), el("span", `status-chip status-${pin.status}`, STATUSES[pin.status]));
      button.append(top, el("strong", "pin-list-title", pin.title));
      const counts = [];
      if (pin.comment_count) counts.push(`💬 ${pin.comment_count}`);
      if (pin.favorite_count) counts.push(`★ ${pin.favorite_count}`);
      button.append(el("span", "pin-list-meta", `${profileLabel(profileFor(pin.author_id))}・${formatDate(pin.updated_at)}${counts.length ? `・${counts.join(" ")}` : ""}`));
      button.addEventListener("click", () => openDetail(pin));
      row.append(button);
      if (state.user) row.append(makeFavoriteButton(pin, "favorite-list-btn"));
      dom.list.append(row);
    }
    renderMarkers(pins);
  }

  function groupNearbyPins(pins, radius = 46) {
    const projected = [];
    for (const pin of pins) {
      const latlng = window.OkiMap.imagePointToLatLng(pin.x, pin.y);
      if (!latlng) continue;
      projected.push({ pin, latlng, point: state.map.latLngToContainerPoint(latlng) });
    }
    const parent = projected.map((_, index) => index);
    const find = (index) => {
      while (parent[index] !== index) {
        parent[index] = parent[parent[index]];
        index = parent[index];
      }
      return index;
    };
    const unite = (left, right) => {
      const leftRoot = find(left);
      const rightRoot = find(right);
      if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
    };
    const cells = new Map();
    projected.forEach((item, index) => {
      const cellX = Math.floor(item.point.x / radius);
      const cellY = Math.floor(item.point.y / radius);
      for (let x = cellX - 1; x <= cellX + 1; x += 1) {
        for (let y = cellY - 1; y <= cellY + 1; y += 1) {
          for (const otherIndex of cells.get(`${x}:${y}`) || []) {
            if (item.point.distanceTo(projected[otherIndex].point) <= radius) {
              unite(index, otherIndex);
            }
          }
        }
      }
      const key = `${cellX}:${cellY}`;
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(index);
    });
    const groups = new Map();
    projected.forEach((item, index) => {
      const root = find(index);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(item);
    });
    return [...groups.values()];
  }

  function renderMarkers(pins) {
    if (!state.layer || !state.map) return;
    state.layer.clearLayers();
    if (!state.display.pinsVisible) return;
    for (const group of groupNearbyPins(pins)) {
      if (group.length > 1) {
        const center = L.latLng(
          group.reduce((sum, item) => sum + item.latlng.lat, 0) / group.length,
          group.reduce((sum, item) => sum + item.latlng.lng, 0) / group.length,
        );
        const count = group.length;
        const icon = L.divIcon({
          className: "collab-cluster-wrap",
          html: `<span class="collab-cluster" aria-hidden="true">${count}</span>`,
          iconSize: [42, 42],
          iconAnchor: [21, 21],
        });
        const marker = L.marker(center, {
          icon,
          pane: "collabPins",
          keyboard: true,
          title: `${count}件の共有ピン`,
        });
        const popup = el("div", "collab-cluster-popup");
        popup.append(el("strong", null, `${count}件の共有ピン`));
        const options = el("div", "collab-cluster-options");
        const sortedGroup = [...group].sort((left, right) =>
          String(right.pin.updated_at || "").localeCompare(String(left.pin.updated_at || "")),
        );
        for (const { pin } of sortedGroup) {
          const button = el("button", "collab-cluster-option");
          button.type = "button";
          button.append(
            el("span", "collab-cluster-option-title", `${KINDS[pin.kind]?.icon || "📌"} ${pin.title}`),
            el("span", "collab-cluster-option-meta", `${KINDS[pin.kind]?.label || pin.kind}・${STATUSES[pin.status] || pin.status}`),
          );
          button.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            state.map.closePopup();
            setPanel(true);
            openDetail(pin);
          });
          options.append(button);
        }
        popup.append(options);
        marker.bindPopup(popup, {
          className: "collab-cluster-popup-shell",
          minWidth: 220,
          maxWidth: 320,
        });
        marker.addTo(state.layer);
        continue;
      }
      const { pin, latlng } = group[0];
      const title = state.display.pinTitles
        ? `<span class="collab-marker-title">${escapeHtml(pin.title)}</span>`
        : "";
      const icon = L.divIcon({
        className: "collab-marker-wrap",
        html: `<span class="collab-marker kind-${pin.kind} status-${pin.status}" aria-hidden="true"><span>${KINDS[pin.kind]?.icon || "📌"}</span></span>${title}`,
        iconSize: [34, 42],
        iconAnchor: [17, 39],
      });
      const marker = L.marker(latlng, {
        icon,
        pane: "collabPins",
        keyboard: true,
        title: pin.title,
      });
      if (state.display.pinHoverContent) {
        const tooltip = el("span", "collab-tooltip", summarize(pin.body, 260));
        marker.bindTooltip(tooltip, {
          direction: "top",
          offset: [0, -32],
          className: "collab-content-tooltip",
        });
      }
      marker.on("click", () => {
        setPanel(true);
        openDetail(pin);
      });
      marker.addTo(state.layer);
    }
  }

  async function refreshPins(options = {}) {
    if (!state.configured) return;
    dom.connection.textContent = "ピンを読み込み中...";
    let data;
    try {
      data = await apiRequest("/pins");
    } catch (error) {
      console.error("Failed to load pins", error);
      dom.connection.textContent = "ピンを読み込めませんでした";
      return;
    }
    state.pins = data || [];
    rememberAuthors(state.pins);
    dom.connection.textContent = `${state.pins.length}件の共有ピン`;
    renderList();
    if (options.reopenId) {
      const pin = state.pins.find((item) => item.id === options.reopenId);
      if (pin) await openDetail(pin);
    }
  }

  function updateNotificationBadge() {
    const count = Number(state.unreadCount || 0);
    dom.notificationBadge.textContent = count > 99 ? "99+" : String(count);
    dom.notificationBadge.classList.toggle("hidden", count === 0);
    dom.notificationButton.setAttribute("aria-label", count ? `通知を開く（未読${count}件）` : "通知を開く");
  }

  function renderNotifications() {
    dom.notificationList.replaceChildren();
    const notifications = state.notifications || [];
    dom.notificationSummary.textContent = state.unreadCount
      ? `未読 ${state.unreadCount}件`
      : "未読の通知はありません";
    dom.readAllNotifications.disabled = state.unreadCount === 0;
    if (!notifications.length) {
      dom.notificationList.append(el("p", "collab-empty", "通知はまだありません。"));
      return;
    }
    for (const notification of notifications) {
      const button = el("button", `notification-item${notification.read_at ? "" : " is-unread"}`);
      button.type = "button";
      const actorName = notification.actor?.display_name || "ユーザー";
      button.append(
        el("strong", "notification-title", notification.pin_title),
        el("span", "notification-message", `${actorName}さんがコメントしました`),
        el("span", "notification-preview", summarize(notification.comment_body, 100)),
        el("time", "notification-time", formatDate(notification.created_at)),
      );
      button.addEventListener("click", () => openNotification(notification));
      dom.notificationList.append(button);
    }
  }

  async function loadNotifications({ quiet = false } = {}) {
    if (!state.user) return;
    if (!quiet) dom.notificationSummary.textContent = "通知を読み込み中...";
    try {
      const data = await apiRequest("/notifications");
      state.notifications = data.notifications || [];
      state.unreadCount = Number(data.unread_count || 0);
      for (const notification of state.notifications) {
        if (notification.actor?.id) state.profiles.set(notification.actor.id, notification.actor);
      }
      updateNotificationBadge();
      renderNotifications();
    } catch (error) {
      console.error("Failed to load notifications", error);
      if (!quiet) dom.notificationSummary.textContent = "通知を読み込めませんでした";
    }
  }

  async function openNotification(notification) {
    if (!notification.read_at) {
      try {
        await apiRequest(`/notifications/${encodeURIComponent(notification.id)}/read`, { method: "PATCH" });
        notification.read_at = new Date().toISOString();
        state.unreadCount = Math.max(0, state.unreadCount - 1);
        updateNotificationBadge();
        renderNotifications();
      } catch (error) {
        console.error("Failed to mark notification as read", error);
      }
    }
    let pin = state.pins.find((item) => item.id === notification.pin_id);
    if (!pin) {
      await refreshPins();
      pin = state.pins.find((item) => item.id === notification.pin_id);
    }
    if (pin) await openDetail(pin);
  }

  async function readAllNotifications() {
    if (!state.user || !state.unreadCount) return;
    setBusy(dom.readAllNotifications, true, "既読中...");
    try {
      await apiRequest("/notifications/read-all", { method: "POST" });
      const readAt = new Date().toISOString();
      for (const notification of state.notifications) {
        if (!notification.read_at) notification.read_at = readAt;
      }
      state.unreadCount = 0;
      updateNotificationBadge();
      renderNotifications();
    } catch (error) {
      console.error("Failed to mark all notifications as read", error);
      alert("通知を既読にできませんでした。");
    } finally {
      setBusy(dom.readAllNotifications, false);
    }
  }

  function startNotificationPolling() {
    if (state.notificationTimer) clearInterval(state.notificationTimer);
    state.notificationTimer = state.user
      ? setInterval(() => loadNotifications({ quiet: true }), 60000)
      : null;
  }

  function attachMap() {
    if (state.map || !window.OkiMap?.map) return;
    state.map = window.OkiMap.map;
    if (!state.map.getPane("collabPins")) {
      state.map.createPane("collabPins");
      state.map.getPane("collabPins").classList.add("leaflet-collab-pane");
    }
    state.layer = L.layerGroup().addTo(state.map);
    state.display = {
      ...state.display,
      ...(window.OkiMap.getCollabDisplaySettings?.() || {}),
    };
    updateVisibilityButton();
    state.map.on("click", onMapClick);
    state.map.on("zoomend", () => renderMarkers(filteredPins()));
    renderList();
  }

  function startAddMode() {
    if (!state.user || !state.map) return;
    window.OkiMap.disablePixelPicker();
    state.addMode = true;
    state.pendingPoint = null;
    dom.modeHint.classList.remove("hidden");
    dom.startPin.classList.add("is-active");
    document.getElementById("map")?.classList.add("pin-placement-mode");
  }

  function cancelAddMode() {
    state.addMode = false;
    dom.modeHint.classList.add("hidden");
    dom.startPin.classList.remove("is-active");
    document.getElementById("map")?.classList.remove("pin-placement-mode");
  }

  function onMapClick(event) {
    if (!state.addMode) return;
    const point = window.OkiMap.latLngToImagePoint(event.latlng);
    if (!point?.inside) return;
    cancelAddMode();
    state.pendingPoint = { x: point.x, y: point.y };
    openEditor();
  }

  function openEditor(pin = null) {
    if (!state.user) return;
    state.editingPin = pin;
    if (pin) state.pendingPoint = { x: pin.x, y: pin.y };
    dom.editor.reset();
    dom.editorHeading.textContent = pin ? "ピンを編集" : "ピンを追加";
    dom.coordinate.textContent = formatPixelCoordinate(state.pendingPoint.x, state.pendingPoint.y);
    dom.kind.value = pin?.kind || "plan";
    dom.status.value = pin?.status || "open";
    dom.title.value = pin?.title || "";
    dom.body.value = pin?.body || "";
    dom.relatedUrl.value = pin?.related_url || "";
    dom.editorError.textContent = "";
    showView("editor");
    dom.title.focus();
  }

  async function savePin(event) {
    event.preventDefault();
    if (!state.user || !state.pendingPoint) return;
    dom.editorError.textContent = "";
    const relatedUrl = dom.relatedUrl.value.trim();
    if (relatedUrl && !safeUrl(relatedUrl)) {
      dom.editorError.textContent = "関連URLはhttpまたはhttpsのURLを入力してください。";
      return;
    }
    const payload = {
      x: state.pendingPoint.x,
      y: state.pendingPoint.y,
      kind: dom.kind.value,
      status: dom.status.value,
      title: dom.title.value.trim(),
      body: dom.body.value.trim(),
      related_url: relatedUrl || null,
    };
    setBusy(dom.savePin, true, "保存中...");
    let result;
    try {
      result = state.editingPin
        ? await apiRequest(`/pins/${encodeURIComponent(state.editingPin.id)}`, {
            method: "PATCH",
            body: payload,
          })
        : await apiRequest("/pins", { method: "POST", body: payload });
    } catch (error) {
      console.error("Failed to save pin", error);
      dom.editorError.textContent = "保存できませんでした。入力内容または権限を確認してください。";
      return;
    } finally {
      setBusy(dom.savePin, false);
    }
    state.editingPin = null;
    state.pendingPoint = null;
    await refreshPins({ reopenId: result.id });
  }

  function appendMeta(container, pin) {
    const meta = el("div", "pin-detail-meta");
    meta.append(makeBadge(pin), el("span", `status-chip status-${pin.status}`, STATUSES[pin.status]));
    container.append(meta);
  }

  async function openDetail(pin) {
    state.selectedPin = pin;
    showView("detail");
    dom.detailContent.replaceChildren();
    appendMeta(dom.detailContent, pin);
    dom.detailContent.append(el("h2", "pin-detail-title", pin.title));
    if (pin.body) dom.detailContent.append(el("p", "pin-detail-body", pin.body));
    const profile = profileFor(pin.author_id);
    dom.detailContent.append(el("p", "pin-detail-byline", `${profileLabel(profile)}・${formatDate(pin.created_at)}`));
    dom.detailContent.append(el("p", "collab-coordinate", formatPixelCoordinate(pin.x, pin.y)));
    const links = el("div", "pin-detail-links");
    const wplaceUrl = safeUrl(window.OkiMap?.imagePointToWplaceUrl?.(pin.x, pin.y));
    if (wplaceUrl) {
      const wplaceLink = el("a", "pin-wplace-link", "Wplaceで開く ↗");
      wplaceLink.href = wplaceUrl;
      wplaceLink.target = "_blank";
      wplaceLink.rel = "noopener noreferrer";
      links.append(wplaceLink);
    }
    const url = safeUrl(pin.related_url);
    if (url) {
      const link = el("a", "pin-related-link", "関連リンクを開く ↗");
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      links.append(link);
    }
    if (links.childElementCount) dom.detailContent.append(links);
    dom.detailActions.replaceChildren();
    if (state.user) {
      dom.detailActions.append(makeFavoriteButton(pin, "secondary favorite-detail-btn"));
    }
    if (canManage(pin.author_id)) {
      const edit = el("button", "secondary", "編集");
      edit.type = "button";
      edit.addEventListener("click", () => openEditor(pin));
      const remove = el("button", "danger", "削除");
      remove.type = "button";
      remove.addEventListener("click", () => deletePin(pin));
      dom.detailActions.append(edit, remove);
    }
    updateAuthUi();
    if (state.map) {
      const latlng = window.OkiMap.imagePointToLatLng(pin.x, pin.y);
      if (latlng && !state.map.getBounds().contains(latlng)) state.map.panTo(latlng);
    }
    await loadComments(pin.id);
  }

  async function deletePin(pin) {
    if (!canManage(pin.author_id) || !confirm(`「${pin.title}」を削除しますか？`)) return;
    try {
      await apiRequest(`/pins/${encodeURIComponent(pin.id)}`, { method: "DELETE" });
    } catch (error) {
      console.error("Failed to delete pin", error);
      alert("ピンを削除できませんでした。");
      return;
    }
    state.selectedPin = null;
    showView("browse");
    await refreshPins();
  }

  async function loadComments(pinId) {
    dom.commentList.replaceChildren(el("p", "collab-muted", "コメントを読み込み中..."));
    let data;
    try {
      data = await apiRequest(`/pins/${encodeURIComponent(pinId)}/comments`);
    } catch (error) {
      console.error("Failed to load comments", error);
      dom.commentList.replaceChildren(el("p", "collab-error", "コメントを読み込めませんでした。"));
      return;
    }
    rememberAuthors(data);
    renderComments(data || []);
  }

  function renderComments(comments) {
    dom.commentList.replaceChildren();
    if (!comments.length) {
      dom.commentScrollTop.classList.add("hidden");
      dom.commentList.append(el("p", "collab-empty", "まだコメントはありません。"));
      return;
    }
    dom.commentScrollTop.classList.remove("hidden");
    for (const comment of comments) {
      const article = el("article", "comment-item");
      const isOwnComment = !!state.user && state.user.id === comment.author_id;
      article.classList.toggle("is-own-comment", isOwnComment);
      const header = el("div", "comment-header");
      header.append(
        el("strong", isOwnComment ? "own-comment-label" : null, isOwnComment ? "自分" : profileLabel(profileFor(comment.author_id))),
        el("time", null, formatDate(comment.created_at)),
      );
      article.append(header);
      const isLong = comment.body.length > 240 || comment.body.split("\n").length > 5;
      if (isLong) {
        const preview = el("p", "comment-body comment-preview", summarize(comment.body, 220));
        const details = el("details", "comment-details");
        const summary = el("summary", null, "続きを表示…");
        details.append(summary, el("p", "comment-body", comment.body));
        details.addEventListener("toggle", () => {
          preview.classList.toggle("hidden", details.open);
          summary.textContent = details.open ? "折りたたむ" : "続きを表示…";
        });
        article.append(preview, details);
      } else {
        article.append(el("p", "comment-body", comment.body));
      }
      if (canManage(comment.author_id)) {
        const actions = el("div", "comment-actions");
        const edit = el("button", "link-btn", "編集");
        edit.type = "button";
        edit.addEventListener("click", () => editComment(comment));
        const remove = el("button", "link-btn danger-text", "削除");
        remove.type = "button";
        remove.addEventListener("click", () => deleteComment(comment));
        actions.append(edit, remove);
        article.append(actions);
      }
      dom.commentList.append(article);
    }
    // 読み込み・投稿後はアニメーションせず、その場で末尾を表示する。
    // requestAnimationFrameを挟むと一瞬先頭が描画されるため同期的に移動する。
    dom.commentList.scrollTop = dom.commentList.scrollHeight;
  }

  async function saveComment(event) {
    event.preventDefault();
    if (!state.user || !state.selectedPin) return;
    const body = dom.commentBody.value.trim();
    if (!body) return;
    dom.commentError.textContent = "";
    const button = dom.commentForm.querySelector("button[type='submit']");
    setBusy(button, true, "送信中...");
    try {
      await apiRequest(`/pins/${encodeURIComponent(state.selectedPin.id)}/comments`, {
        method: "POST",
        body: { body },
      });
    } catch (error) {
      console.error("Failed to save comment", error);
      dom.commentError.textContent = "コメントを保存できませんでした。";
      return;
    } finally {
      setBusy(button, false);
    }
    dom.commentBody.value = "";
    await loadComments(state.selectedPin.id);
    // コメント投稿後は、一覧だけでなく外側の詳細パネルも最新コメントまで移動する。
    dom.commentList.scrollTop = dom.commentList.scrollHeight;
    dom.panel.scrollTop = dom.panel.scrollHeight;
  }

  function editComment(comment) {
    if (!canManage(comment.author_id)) return;
    state.editingComment = comment;
    dom.commentEditor.reset();
    dom.commentEditBody.value = comment.body;
    dom.commentEditorError.textContent = "";
    showView("comment-editor");
    dom.commentEditBody.focus();
  }

  function closeCommentEditor() {
    state.editingComment = null;
    dom.commentEditorError.textContent = "";
    showView(state.selectedPin ? "detail" : "browse");
  }

  async function saveCommentEdit(event) {
    event.preventDefault();
    const comment = state.editingComment;
    if (!comment || !canManage(comment.author_id)) return;
    const body = dom.commentEditBody.value.trim();
    dom.commentEditorError.textContent = "";
    if (!body) {
      dom.commentEditorError.textContent = "コメントを入力してください。";
      return;
    }
    if (body === comment.body) {
      closeCommentEditor();
      return;
    }
    setBusy(dom.saveCommentEdit, true, "保存中...");
    try {
      await apiRequest(`/comments/${encodeURIComponent(comment.id)}`, {
        method: "PATCH",
        body: { body },
      });
      state.editingComment = null;
      showView("detail");
      await loadComments(state.selectedPin.id);
    } catch (error) {
      console.error("Failed to edit comment", error);
      dom.commentEditorError.textContent = "コメントを編集できませんでした。";
    } finally {
      setBusy(dom.saveCommentEdit, false);
    }
  }

  async function deleteComment(comment) {
    if (!confirm("このコメントを削除しますか？")) return;
    try {
      await apiRequest(`/comments/${encodeURIComponent(comment.id)}`, { method: "DELETE" });
      await loadComments(state.selectedPin.id);
    } catch (error) {
      console.error("Failed to delete comment", error);
      alert("コメントを削除できませんでした。");
    }
  }

  function login() {
    location.assign(`${state.apiBaseUrl}/auth/discord/login`);
  }

  async function logout() {
    try {
      await apiRequest("/auth/logout", { method: "POST" });
      state.user = null;
      state.profile = null;
      state.selectedPin = null;
      state.notifications = [];
      state.unreadCount = 0;
      startNotificationPolling();
      updateNotificationBadge();
      showView("browse");
      updateAuthUi();
      renderList();
    } catch (error) {
      console.error("Failed to logout", error);
      alert("ログアウトできませんでした。");
    }
  }

  function bindEvents() {
    dom.button.addEventListener("click", () => setPanel(dom.panel.classList.contains("hidden")));
    dom.close.addEventListener("click", () => setPanel(false));
    dom.login.addEventListener("click", login);
    dom.logout.addEventListener("click", logout);
    dom.kindFilter.addEventListener("change", renderList);
    dom.statusFilter.addEventListener("change", renderList);
    dom.favoriteFilter.addEventListener("change", renderList);
    dom.notificationButton.addEventListener("click", async () => {
      showView("notifications");
      await loadNotifications();
    });
    dom.readAllNotifications.addEventListener("click", readAllNotifications);
    dom.startPin.addEventListener("click", startAddMode);
    dom.cancelPinMode.addEventListener("click", cancelAddMode);
    dom.editor.addEventListener("submit", savePin);
    dom.commentForm.addEventListener("submit", saveComment);
    dom.visibilityButton.addEventListener("click", () => {
      window.OkiMap?.setPinsVisible?.(!state.display.pinsVisible);
    });
    dom.commentScrollTop.addEventListener("click", () => {
      dom.commentList.scrollTo({ top: 0, behavior: "smooth" });
    });
    const submitOnEnter = (textarea, form) => {
      textarea.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return;
        event.preventDefault();
        if (form.querySelector("button[type='submit']")?.disabled) return;
        form.requestSubmit();
      });
    };
    submitOnEnter(dom.commentBody, dom.commentForm);
    submitOnEnter(dom.commentEditBody, dom.commentEditor);
    dom.commentEditor.addEventListener("submit", saveCommentEdit);
    dom.commentEditorBack.addEventListener("click", closeCommentEditor);
    dom.cancelCommentEdit.addEventListener("click", closeCommentEditor);
    document.querySelectorAll("[data-collab-back]").forEach((button) => {
      button.addEventListener("click", () => {
        state.editingPin = null;
        state.pendingPoint = null;
        showView("browse");
      });
    });
    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && state.addMode) cancelAddMode();
    });
    window.addEventListener("okimap:map-ready", attachMap);
    window.addEventListener("okimap:collab-display-change", (event) => {
      applyDisplaySettings(event.detail);
    });
  }

  async function init() {
    bindEvents();
    attachMap();
    if (new URLSearchParams(location.search).get("panel") === "pins") setPanel(true);
    const config = window.OKIMAP_COLLAB_CONFIG || {};
    state.apiBaseUrl = String(config.apiBaseUrl || "").replace(/\/$/, "");
    state.configured = /^https?:\/\//.test(state.apiBaseUrl);
    if (!state.configured) {
      dom.connection.textContent = "共有ピンは未設定です";
      updateAuthUi();
      renderList();
      return;
    }
    try {
      await loadSession();
    } catch (error) {
      console.error("Failed to load login session", error);
      state.user = null;
      state.profile = null;
      updateAuthUi();
    }
    await refreshPins();
    if (state.user) {
      await loadNotifications({ quiet: true });
      startNotificationPolling();
    }
  }

  init().catch((error) => {
    console.error("Failed to initialize collaboration layer", error);
    dom.connection.textContent = "共有機能を初期化できませんでした";
  });
})();
