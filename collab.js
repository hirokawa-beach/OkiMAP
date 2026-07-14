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
    browse: $("collabBrowseView"),
    kindFilter: $("pinKindFilter"),
    statusFilter: $("pinStatusFilter"),
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
      const button = el("button", "pin-list-item");
      button.type = "button";
      const top = el("span", "pin-list-top");
      top.append(makeBadge(pin), el("span", `status-chip status-${pin.status}`, STATUSES[pin.status]));
      button.append(top, el("strong", "pin-list-title", pin.title));
      button.append(el("span", "pin-list-meta", `${profileLabel(profileFor(pin.author_id))}・${formatDate(pin.updated_at)}`));
      button.addEventListener("click", () => openDetail(pin));
      dom.list.append(button);
    }
    renderMarkers(pins);
  }

  function renderMarkers(pins) {
    if (!state.layer || !state.map) return;
    state.layer.clearLayers();
    if (!state.display.pinsVisible) return;
    for (const pin of pins) {
      const latlng = window.OkiMap.imagePointToLatLng(pin.x, pin.y);
      if (!latlng) continue;
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
        const tooltip = el("span", "collab-tooltip", summarize(pin.body, 180));
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
    const url = safeUrl(pin.related_url);
    if (url) {
      const link = el("a", "pin-related-link", "関連リンクを開く ↗");
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      dom.detailContent.append(link);
    }
    dom.detailActions.replaceChildren();
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
      const header = el("div", "comment-header");
      header.append(
        el("strong", null, profileLabel(profileFor(comment.author_id))),
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
    requestAnimationFrame(() => {
      dom.commentList.scrollTop = dom.commentList.scrollHeight;
    });
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
  }

  init().catch((error) => {
    console.error("Failed to initialize collaboration layer", error);
    dom.connection.textContent = "共有機能を初期化できませんでした";
  });
})();
