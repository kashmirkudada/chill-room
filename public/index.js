// ─── DOM refs (must exist before socket handlers fire) ────────────────────────
const chatLogEl = document.getElementById("chat-log");
const chatInput = document.getElementById("chat-input");
const videoUrlInput = document.getElementById("video-url-input");

// ─── State ────────────────────────────────────────────────────────────────────
let me = null;
let users = {};
let playlist = [];
let videoState = {
  playing: false,
  currentIndex: -1,
  timestamp: 0,
  lastUpdated: Date.now(),
};
let ytPlayer = null;
let ytReady = false;
let vimeoPlayer = null;
let vimeoReady = false;
let vimeoBoundSrc = null;
let html5El = null;
let html5Ready = false;
let embedReady = false;
let activeMediaType = null;
let activeMediaId = null;
let isSyncing = false;
let connected = false;
let dj = null;
let isDj = false;

const keys = {};
const SPEED = 3;

// ─── Socket ───────────────────────────────────────────────────────────────────
const socket =
  typeof io !== "undefined"
    ? io({ transports: ["websocket", "polling"] })
    : null;

// ─── Canvas setup ─────────────────────────────────────────────────────────────
const canvas = document.getElementById("lounge");
const ctx = canvas.getContext("2d");

function resizeCanvas() {
  const wrap = document.getElementById("lounge-wrap");
  canvas.width = wrap.clientWidth;
  canvas.height = wrap.clientHeight;
}
function handleResize() {
  resizeCanvas();
}
resizeCanvas();
window.addEventListener("resize", handleResize);
window.addEventListener("orientationchange", () =>
  setTimeout(handleResize, 100),
);

// ─── Layout resize (video height + width) ─────────────────────────────────────
const LAYOUT_KEYS = { h: "chillroom-video-h", w: "chillroom-video-w" };
const rootStyle = document.documentElement.style;

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function defaultVideoHeight() {
  const mainCol = document.getElementById("main-col");
  const available = (mainCol?.clientHeight || window.innerHeight - 48) - 90 - 6;
  return clamp(Math.round(available * 0.72), 220, window.innerHeight - 48 - 90);
}

function applyVideoHeight(px) {
  rootStyle.setProperty("--video-pane-h", `${px}px`);
  resizeCanvas();
}

function applyVideoWidth(pct) {
  rootStyle.setProperty("--video-pane-w", `${clamp(pct, 55, 88)}%`);
}

function isMobileLayout() {
  return window.innerWidth <= 680;
}

function loadLayoutPrefs() {
  if (isMobileLayout()) {
    rootStyle.setProperty("--video-pane-h", "auto");
    return;
  }
  const savedH = Number(localStorage.getItem(LAYOUT_KEYS.h));
  const savedW = Number(localStorage.getItem(LAYOUT_KEYS.w));
  applyVideoHeight(
    Number.isFinite(savedH) && savedH > 0 ? savedH : defaultVideoHeight(),
  );
  applyVideoWidth(Number.isFinite(savedW) && savedW > 0 ? savedW : 74);
}

function setupPaneResizer(handle, { axis, onDrag, onEnd }) {
  let dragging = false;

  const start = (clientX, clientY) => {
    dragging = true;
    handle.classList.add("dragging");
    document.body.style.userSelect = "none";
    document.body.style.cursor = axis === "x" ? "col-resize" : "row-resize";
  };

  const move = (clientX, clientY) => {
    if (!dragging) return;
    onDrag(clientX, clientY);
  };

  const stop = () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove("dragging");
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    onEnd?.();
    resizeCanvas();
  };

  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    start(e.clientX, e.clientY);
  });
  window.addEventListener("mousemove", (e) => move(e.clientX, e.clientY));
  window.addEventListener("mouseup", stop);

  handle.addEventListener(
    "touchstart",
    (e) => {
      e.preventDefault();
      const t = e.touches[0];
      start(t.clientX, t.clientY);
    },
    { passive: false },
  );
  window.addEventListener(
    "touchmove",
    (e) => {
      if (!dragging) return;
      const t = e.touches[0];
      move(t.clientX, t.clientY);
    },
    { passive: true },
  );
  window.addEventListener("touchend", stop);
}

function initLayoutResizers() {
  const mainCol = document.getElementById("main-col");
  const boombox = document.getElementById("boombox");
  const paneResizer = document.getElementById("pane-resizer");
  const videoSplitter = document.getElementById("video-splitter");

  loadLayoutPrefs();

  setupPaneResizer(paneResizer, {
    axis: "y",
    onDrag: (_x, clientY) => {
      const rect = mainCol.getBoundingClientRect();
      const next = clientY - rect.top;
      const max = rect.height - 90 - 6;
      applyVideoHeight(clamp(next, 200, max));
    },
    onEnd: () => {
      const h = parseInt(
        getComputedStyle(document.documentElement).getPropertyValue(
          "--video-pane-h",
        ),
        10,
      );
      if (Number.isFinite(h)) localStorage.setItem(LAYOUT_KEYS.h, String(h));
    },
  });

  setupPaneResizer(videoSplitter, {
    axis: "x",
    onDrag: (clientX) => {
      const rect = boombox.getBoundingClientRect();
      const pct = ((clientX - rect.left) / rect.width) * 100;
      applyVideoWidth(pct);
    },
    onEnd: () => {
      const w = parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue(
          "--video-pane-w",
        ),
      );
      if (Number.isFinite(w))
        localStorage.setItem(LAYOUT_KEYS.w, String(Math.round(w)));
    },
  });

  window.addEventListener("resize", () => {
    if (isMobileLayout()) {
      rootStyle.setProperty("--video-pane-h", "auto");
      return;
    }
    const savedH = Number(localStorage.getItem(LAYOUT_KEYS.h));
    if (!Number.isFinite(savedH) || savedH <= 0) {
      applyVideoHeight(defaultVideoHeight());
    }
  });
}

initLayoutResizers();

// ─── Draw loop ────────────────────────────────────────────────────────────────
function drawLounge() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Background grid
  ctx.strokeStyle = "rgba(255,255,255,0.03)";
  ctx.lineWidth = 1;
  const gridSize = 40;
  for (let x = 0; x < canvas.width; x += gridSize) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvas.height);
    ctx.stroke();
  }
  for (let y = 0; y < canvas.height; y += gridSize) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(canvas.width, y);
    ctx.stroke();
  }

  drawFurniture();

  for (const id in users) {
    drawAvatar(users[id], me && id === me.id);
  }

  requestAnimationFrame(drawLounge);
}

function drawFurniture() {
  const pad = 24;
  const sofaW = Math.min(220, canvas.width * 0.45);
  const sofaH = Math.min(70, canvas.height * 0.35);
  const tableW = Math.min(130, canvas.width * 0.3);
  const tableH = Math.min(48, canvas.height * 0.22);
  const sofaX = pad;
  const sofaY = pad;
  const tableX = sofaX + sofaW * 0.35;
  const tableY = sofaY + sofaH + 16;

  ctx.fillStyle = "rgba(124, 106, 255, 0.07)";
  ctx.strokeStyle = "rgba(124, 106, 255, 0.15)";
  ctx.lineWidth = 1.5;
  roundRect(ctx, sofaX, sofaY, sofaW, sofaH, 10);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "rgba(124,106,255,0.25)";
  ctx.font = "11px Space Grotesk, sans-serif";
  ctx.fillText("🛋️  lounge sofa", sofaX + 18, sofaY + sofaH - 12);

  ctx.fillStyle = "rgba(255,107,157,0.06)";
  ctx.strokeStyle = "rgba(255,107,157,0.2)";
  roundRect(ctx, tableX, tableY, tableW, tableH, 8);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "rgba(255,107,157,0.4)";
  ctx.fillText("☕ coffee table", tableX + 8, tableY + tableH - 10);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawAvatar(u, isMe) {
  const { x, y, color, name } = u;

  if (isMe) {
    ctx.shadowColor = color;
    ctx.shadowBlur = 14;
  }

  ctx.beginPath();
  ctx.arc(x, y, 18, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();

  ctx.lineWidth = isMe ? 3 : 1.5;
  ctx.strokeStyle = isMe ? "#fff" : "rgba(255,255,255,0.3)";
  ctx.stroke();
  ctx.shadowBlur = 0;

  ctx.fillStyle = "#fff";
  ctx.font = "bold 11px Space Grotesk, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(name.slice(0, 2).toUpperCase(), x, y);

  ctx.font = "11px Space Grotesk, sans-serif";
  ctx.textBaseline = "top";
  const label = isMe ? `${name} (you)` : name;
  const tw = ctx.measureText(label).width;
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  roundRect(ctx, x - tw / 2 - 5, y + 22, tw + 10, 16, 4);
  ctx.fill();
  ctx.fillStyle = isMe ? "#e8eaf0" : "#a0a8b8";
  ctx.fillText(label, x - tw / 2, y + 24);

  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
}

// ─── Movement ─────────────────────────────────────────────────────────────────
window.addEventListener("keydown", (e) => {
  keys[e.key] = true;
});
window.addEventListener("keyup", (e) => {
  keys[e.key] = false;
});

function moveLoop() {
  if (!me || !users[me.id]) {
    requestAnimationFrame(moveLoop);
    return;
  }

  let moved = false;
  let { x, y } = users[me.id];

  if (keys["ArrowUp"] || keys["w"]) {
    y -= SPEED;
    moved = true;
  }
  if (keys["ArrowDown"] || keys["s"]) {
    y += SPEED;
    moved = true;
  }
  if (keys["ArrowLeft"] || keys["a"]) {
    x -= SPEED;
    moved = true;
  }
  if (keys["ArrowRight"] || keys["d"]) {
    x += SPEED;
    moved = true;
  }

  x = Math.max(20, Math.min(canvas.width - 20, x));
  y = Math.max(20, Math.min(canvas.height - 20, y));

  if (moved && socket) {
    users[me.id].x = x;
    users[me.id].y = y;
    socket.emit("move", { x, y });
  }

  requestAnimationFrame(moveLoop);
}

// ─── Touch / drag movement (mobile) ───────────────────────────────────────────
let touchActive = false;
let touchTarget = null;

function canvasPointFromEvent(e) {
  const rect = canvas.getBoundingClientRect();
  const touch = e.touches ? e.touches[0] : e;
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  return {
    x: (touch.clientX - rect.left) * scaleX,
    y: (touch.clientY - rect.top) * scaleY,
  };
}

function moveMeTo(x, y) {
  if (!me || !users[me.id] || !socket) return;
  x = Math.max(20, Math.min(canvas.width - 20, x));
  y = Math.max(20, Math.min(canvas.height - 20, y));
  users[me.id].x = x;
  users[me.id].y = y;
  socket.emit("move", { x, y });
}

canvas.addEventListener(
  "touchstart",
  (e) => {
    if (!me) return;
    e.preventDefault();
    touchActive = true;
    touchTarget = canvasPointFromEvent(e);
    moveMeTo(touchTarget.x, touchTarget.y);
  },
  { passive: false },
);

canvas.addEventListener(
  "touchmove",
  (e) => {
    if (!touchActive) return;
    e.preventDefault();
    touchTarget = canvasPointFromEvent(e);
    moveMeTo(touchTarget.x, touchTarget.y);
  },
  { passive: false },
);

canvas.addEventListener("touchend", () => {
  touchActive = false;
  touchTarget = null;
});

canvas.addEventListener("mousedown", (e) => {
  if (!me || e.button !== 0) return;
  touchActive = true;
  touchTarget = canvasPointFromEvent(e);
  moveMeTo(touchTarget.x, touchTarget.y);
});

window.addEventListener("mousemove", (e) => {
  if (!touchActive || e.buttons !== 1) return;
  touchTarget = canvasPointFromEvent(e);
  moveMeTo(touchTarget.x, touchTarget.y);
});

window.addEventListener("mouseup", () => {
  touchActive = false;
  touchTarget = null;
});

// ─── Socket Events ────────────────────────────────────────────────────────────
function setConnectionStatus(status) {
  const label = document.getElementById("my-name-label");
  const sendBtn = document.getElementById("chat-send");
  if (status === "connected" && me) {
    label.textContent = me.name;
    chatInput.disabled = false;
    sendBtn.disabled = false;
  } else if (status === "connecting") {
    label.textContent = "connecting...";
    chatInput.disabled = true;
    sendBtn.disabled = true;
  } else if (status === "error") {
    label.textContent = "use npm start — not Live Server";
    chatInput.disabled = true;
    sendBtn.disabled = true;
  } else if (status === "disconnected") {
    label.textContent = "disconnected";
    chatInput.disabled = true;
    sendBtn.disabled = true;
  }
  updateDjUI();
}

if (!socket) {
  setConnectionStatus("error");
  addSystemMessage(
    "⚠️ Socket.io not available. Do not use Live Server or open index.html directly. Run npm start in the terminal, then open http://localhost:5502 (or your PORT from .env).",
  );
} else {
  setConnectionStatus("connecting");

  socket.on("connect", () => {
    connected = true;
    console.log("[Chill Room] Socket connected:", socket.id);
  });

  socket.on("connect_error", (err) => {
    connected = false;
    console.error("[Chill Room] Connection error:", err.message);
    setConnectionStatus("error");
  });

  socket.on("disconnect", () => {
    connected = false;
    setConnectionStatus("disconnected");
  });

  socket.on("init", (data) => {
    me = data.me;
    users = data.users;
    playlist = data.playlist || [];
    videoState = normalizeVideoState(data.videoState);
    dj = data.dj ?? null;
    isDj = !!(me && dj && dj.id === me.id);

    document.getElementById("my-color-dot").style.background = me.color;
    setConnectionStatus("connected");
    updateDjUI();
    updateOnlineCount();
    renderPlaylist();

    chatLogEl.innerHTML = "";
    (data.chatLog || []).forEach(addChatMessage);

    showFastPreviewIfNeeded();
    startSyncRetries();
    syncVideoWhenReady();
  });

  socket.on("user_joined", (user) => {
    users[user.id] = user;
    updateOnlineCount();
    updateDjUI();
    addSystemMessage(`${user.name} joined the room`);
  });

  socket.on("user_left", (id) => {
    if (users[id]) {
      addSystemMessage(`${users[id].name} left the room`);
      delete users[id];
      updateOnlineCount();
      updateDjUI();
    }
  });

  socket.on("user_moved", ({ id, x, y }) => {
    if (users[id]) {
      users[id].x = x;
      users[id].y = y;
    }
  });

  socket.on("chat_message", addChatMessage);

  socket.on("reaction", ({ emoji, x, y }) => {
    spawnFloatingReaction(emoji, x, y);
  });

  socket.on("playlist_updated", (pl) => {
    playlist = pl;
    renderPlaylist();
  });

  socket.on("video_state", (state) => {
    videoState = normalizeVideoState(state);
    showFastPreviewIfNeeded();
    syncVideoWhenReady();
    startSyncRetries();
  });

  socket.on("error_msg", (msg) => {
    addSystemMessage(`⚠️ ${msg}`);
  });

  socket.on("dj_changed", (nextDj) => {
    dj = nextDj;
    isDj = !!(me && dj && dj.id === me.id);
    updateDjUI();
    if (isDj) {
      addSystemMessage(
        "🎧 You're the DJ now — you control play, pause, and skip",
      );
    } else if (dj) {
      addSystemMessage(`🎧 ${dj.name} is now the DJ`);
    }
  });
}

function updateDjUI() {
  const badge = document.getElementById("dj-badge");
  const playerWrap = document.getElementById("yt-player-wrap");
  const becomeBtn = document.getElementById("btn-become-dj");
  const passWrap = document.getElementById("pass-dj-wrap");
  const passMenu = document.getElementById("pass-dj-menu");
  const canControl = isDj && connected;

  document.getElementById("btn-play").disabled = !canControl;
  document.getElementById("btn-prev").disabled = !canControl;
  document.getElementById("btn-next").disabled = !canControl;
  document.getElementById("add-video-btn").disabled = !connected;
  videoUrlInput.disabled = !connected;

  playerWrap.classList.toggle("view-only", !canControl);

  becomeBtn.hidden = isDj || !connected;
  becomeBtn.disabled = !connected;
  passWrap.hidden = !isDj || !connected;
  passMenu.classList.remove("open");
  renderPassDjMenu();

  if (!dj) {
    badge.className = "";
    badge.innerHTML = "🎧 DJ: <b>—</b>";
    return;
  }

  if (isDj) {
    badge.className = "is-dj";
    badge.innerHTML = "🎧 You are the <b>DJ</b> — you control playback";
  } else {
    badge.className = "";
    badge.innerHTML = `🎧 DJ: <b style="color:${escHtml(dj.color)}">${escHtml(dj.name)}</b> controls playback`;
  }
}

function renderPassDjMenu() {
  const menu = document.getElementById("pass-dj-menu");
  const others = Object.values(users).filter((u) => me && u.id !== me.id);
  if (!isDj || others.length === 0) {
    menu.innerHTML = "";
    return;
  }
  menu.innerHTML = others
    .map(
      (u) =>
        `<button type="button" class="pass-dj-item" data-id="${escHtml(u.id)}"><span class="dot" style="background:${escHtml(u.color)}"></span>${escHtml(u.name)}</button>`,
    )
    .join("");
  menu.querySelectorAll(".pass-dj-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!socket || !isDj) return;
      socket.emit("pass_dj", btn.dataset.id);
      menu.classList.remove("open");
    });
  });
}

document.getElementById("btn-become-dj").addEventListener("click", () => {
  if (!socket || !connected || isDj) return;
  socket.emit("become_dj");
});

document.getElementById("btn-pass-dj").addEventListener("click", () => {
  document.getElementById("pass-dj-menu").classList.toggle("open");
});

document.addEventListener("click", (e) => {
  const wrap = document.getElementById("pass-dj-wrap");
  if (!wrap.contains(e.target)) {
    document.getElementById("pass-dj-menu").classList.remove("open");
  }
});

// ─── Chat ─────────────────────────────────────────────────────────────────────
document.getElementById("chat-send").addEventListener("click", sendChat);
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendChat();
});

function sendChat() {
  const msg = chatInput.value.trim();
  if (!msg || !me || !socket || !connected) return;
  socket.emit("chat_message", msg);
  chatInput.value = "";
}

function addChatMessage({ name, color, message, time }) {
  const el = document.createElement("div");
  el.className = "msg";
  el.innerHTML = `
    <div class="sender" style="color:${color}">${escHtml(name)} <span class="time">${time}</span></div>
    <div class="text">${escHtml(message)}</div>
  `;
  chatLogEl.appendChild(el);
  chatLogEl.scrollTop = chatLogEl.scrollHeight;
}

function addSystemMessage(text) {
  const el = document.createElement("div");
  el.className = "system-msg";
  el.textContent = text;
  chatLogEl.appendChild(el);
  chatLogEl.scrollTop = chatLogEl.scrollHeight;
}

// ─── Reactions ────────────────────────────────────────────────────────────────
document.querySelectorAll(".reaction-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (!me || !socket || !connected) return;
    socket.emit("reaction", btn.dataset.emoji);
  });
});

function spawnFloatingReaction(emoji, avatarX, avatarY) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = rect.width / canvas.width;
  const scaleY = rect.height / canvas.height;
  const screenX = rect.left + avatarX * scaleX;
  const screenY = rect.top + avatarY * scaleY;

  const el = document.createElement("div");
  el.className = "float-reaction";
  el.textContent = emoji;
  el.style.left = `${screenX - 12}px`;
  el.style.top = `${screenY - 40}px`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1900);
}

// ─── Media helpers ────────────────────────────────────────────────────────────
function mediaType(item) {
  if (!item) return null;
  if (item.type) return item.type;
  if (item.videoId) return "youtube";
  return "direct";
}

function mediaId(item) {
  if (!item) return null;
  // Server sends { type: "youtube", id: "VIDEO_ID" } — always prefer item.id, fall back to item.videoId
  return item.id || item.videoId || null;
}

function mediaLabel(item) {
  if (!item) return "Nothing yet...";
  if (item.label) return item.label;
  if (item.videoId) return `youtu.be/${item.videoId}`;
  return item.url || "video";
}

function showMediaLayer(type) {
  document
    .getElementById("yt-layer")
    .classList.toggle("hidden", type !== "youtube");
  html5El.classList.toggle("hidden", type !== "direct");
  document
    .getElementById("embed-frame")
    .classList.toggle(
      "hidden",
      !["vimeo", "twitch", "dailymotion"].includes(type),
    );
}

function hidePlaceholder() {
  document.getElementById("player-placeholder").style.display = "none";
}

function setPlayerLoading(visible) {
  document
    .getElementById("player-loading")
    .classList.toggle("visible", visible);
}

function hideFastPreview() {
  const embed = document.getElementById("yt-fast-embed");
  embed.classList.add("hidden");
  embed.removeAttribute("src");
}

function showFastPreviewIfNeeded() {
  const item = playlist[videoState.currentIndex];
  if (!item) return;

  const type = mediaType(item);
  const id = mediaId(item);
  const seekTo = Math.max(0, Math.floor(getSeekPosition()));

  if (type === "youtube") {
    if (ytReady && activeMediaType === "youtube" && activeMediaId === id)
      return;

    const embed = document.getElementById("yt-fast-embed");
    const params = new URLSearchParams({
      start: String(seekTo),
      autoplay: videoState.playing ? "1" : "0",
      playsinline: "1",
      rel: "0",
      modestbranding: "1",
    });

    embed.src = `https://www.youtube.com/embed/${id}?${params}`;
    embed.classList.remove("hidden");
    document.getElementById("yt-layer").classList.add("hidden");
    hidePlaceholder();
    setPlayerLoading(true);
  } else if (type === "direct" && !html5Ready) {
    showMediaLayer("direct");
    html5El.src = id;
    hidePlaceholder();
    setPlayerLoading(true);
  } else if (
    ["vimeo", "twitch", "dailymotion"].includes(type) &&
    !isPlayerReadyFor(type)
  ) {
    const frame = document.getElementById("embed-frame");
    frame.src = buildEmbedSrc(item, seekTo);
    showMediaLayer(type);
    hidePlaceholder();
    setPlayerLoading(true);
  } else {
    return;
  }

  document.getElementById("np-title").textContent = mediaLabel(item);
}

let syncRetryTimer = null;

function startSyncRetries() {
  if (syncRetryTimer) clearInterval(syncRetryTimer);
  let attempts = 0;
  syncRetryTimer = setInterval(() => {
    attempts += 1;
    if (attempts > 20) {
      clearInterval(syncRetryTimer);
      syncRetryTimer = null;
      setPlayerLoading(false);
      return;
    }
    syncVideoWhenReady();
  }, 150);
}

function stopSyncRetries() {
  if (syncRetryTimer) {
    clearInterval(syncRetryTimer);
    syncRetryTimer = null;
  }
}

function twitchParent() {
  return window.location.hostname || "localhost";
}

function formatTwitchTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h}h${m}m${s}s`;
}

function buildEmbedSrc(item, seekTo = 0) {
  const parent = twitchParent();
  if (item.type === "vimeo") {
    return `https://player.vimeo.com/video/${item.id}?autoplay=0`;
  }
  if (item.type === "twitch" && item.twitchKind === "clip") {
    return `https://clips.twitch.tv/embed?clip=${item.id}&parent=${parent}`;
  }
  if (item.type === "twitch") {
    let src = `https://player.twitch.tv/?video=${item.id}&parent=${parent}&autoplay=false`;
    if (seekTo > 0) src += `&time=${formatTwitchTime(seekTo)}`;
    return src;
  }
  if (item.type === "dailymotion") {
    let src = `https://www.dailymotion.com/embed/video/${item.id}`;
    if (seekTo > 0) src += `?start=${Math.floor(seekTo)}`;
    return src;
  }
  return null;
}

function loadVimeoApi() {
  if (window.Vimeo) return Promise.resolve();
  if (window.__vimeoApiLoading) return window.__vimeoApiLoading;
  window.__vimeoApiLoading = new Promise((resolve, reject) => {
    const tag = document.createElement("script");
    tag.src = "https://player.vimeo.com/api/player.js";
    tag.async = true;
    tag.onload = () => resolve();
    tag.onerror = reject;
    document.head.appendChild(tag);
  });
  return window.__vimeoApiLoading;
}

function bindVimeoPlayer(frame) {
  vimeoPlayer = new Vimeo.Player(frame);
  vimeoPlayer.on("loaded", () => {
    vimeoReady = true;
    syncVideoWhenReady();
  });
  vimeoPlayer.on("play", () => {
    if (isSyncing || !socket || !isDj || activeMediaType !== "vimeo") return;
    vimeoPlayer
      .getCurrentTime()
      .then((t) =>
        socket.emit("video_control", { action: "play", timestamp: t }),
      );
  });
  vimeoPlayer.on("pause", () => {
    if (isSyncing || !socket || !isDj || activeMediaType !== "vimeo") return;
    vimeoPlayer
      .getCurrentTime()
      .then((t) =>
        socket.emit("video_control", { action: "pause", timestamp: t }),
      );
  });
  vimeoPlayer.on("ended", () => {
    if (isSyncing || !socket || !isDj || activeMediaType !== "vimeo") return;
    socket.emit("video_control", { action: "next" });
  });
}

async function ensureVimeoPlayer(src) {
  await loadVimeoApi();
  const frame = document.getElementById("embed-frame");
  if (vimeoBoundSrc !== src) {
    vimeoBoundSrc = src;
    vimeoReady = false;
    bindVimeoPlayer(frame);
  }
  return vimeoPlayer;
}

// ─── Players ──────────────────────────────────────────────────────────────────
function getYouTubePlayerOptions() {
  const item = playlist[videoState.currentIndex];
  const opts = {
    height: "100%",
    width: "100%",
    playerVars: {
      autoplay: 0,
      controls: 1,
      modestbranding: 1,
      rel: 0,
      playsinline: 1,
    },
    events: {
      onReady: () => {
        ytReady = true;
        syncVideoWhenReady();
        startSyncRetries();
      },
      onStateChange: (e) => {
        if (isSyncing || !socket || !isDj || activeMediaType !== "youtube")
          return;
        if (e.data === YT.PlayerState.PLAYING) {
          socket.emit("video_control", {
            action: "play",
            timestamp: ytPlayer.getCurrentTime(),
          });
        } else if (e.data === YT.PlayerState.PAUSED) {
          socket.emit("video_control", {
            action: "pause",
            timestamp: ytPlayer.getCurrentTime(),
          });
        } else if (e.data === YT.PlayerState.ENDED) {
          socket.emit("video_control", { action: "next" });
        }
      },
    },
  };

  if (item && mediaType(item) === "youtube") {
    const vid = mediaId(item);
    if (vid) {
      opts.videoId = vid;
      const start = Math.max(0, Math.floor(getSeekPosition()));
      if (start > 0) opts.playerVars.start = start;
    }
  }

  return opts;
}

function initYouTubePlayer() {
  if (ytPlayer || !window.YT || !window.YT.Player) return;
  ytPlayer = new YT.Player("yt-player", getYouTubePlayerOptions());
}

window.onYouTubeIframeAPIReady = initYouTubePlayer;

function loadYouTubeAPI() {
  if (window.YT && window.YT.Player) {
    initYouTubePlayer();
    return;
  }
  const tag = document.createElement("script");
  tag.src = "https://www.youtube.com/iframe_api";
  tag.async = true;
  document.head.appendChild(tag);
}

function initHtml5Player() {
  html5El = document.getElementById("html5-player");
  html5El.addEventListener("loadedmetadata", () => {
    html5Ready = true;
    syncVideoWhenReady();
  });
  html5El.addEventListener("play", () => {
    if (isSyncing || !socket || !isDj || activeMediaType !== "direct") return;
    socket.emit("video_control", {
      action: "play",
      timestamp: html5El.currentTime,
    });
  });
  html5El.addEventListener("pause", () => {
    if (isSyncing || !socket || !isDj || activeMediaType !== "direct") return;
    socket.emit("video_control", {
      action: "pause",
      timestamp: html5El.currentTime,
    });
  });
  html5El.addEventListener("ended", () => {
    if (isSyncing || !socket || !isDj || activeMediaType !== "direct") return;
    socket.emit("video_control", { action: "next" });
  });
}

function initEmbedPlayer() {
  const frame = document.getElementById("embed-frame");
  frame.addEventListener("load", () => {
    embedReady = true;
    syncVideoWhenReady();
  });
}

function normalizeVideoState(state) {
  if (!state)
    return {
      playing: false,
      currentIndex: -1,
      timestamp: 0,
      lastUpdated: Date.now(),
    };
  const lastUpdated = state.lastUpdated ?? Date.now();
  if (!state.playing) {
    return { ...state, lastUpdated };
  }
  // Add ~300ms RTT buffer so new joiners don't seek slightly behind
  const elapsed = (Date.now() - lastUpdated) / 1000 + 0.3;
  return {
    ...state,
    timestamp: (state.timestamp ?? 0) + elapsed,
    lastUpdated: Date.now(),
  };
}

function getSeekPosition() {
  if (!videoState.playing) return videoState.timestamp ?? 0;
  const elapsed = (Date.now() - (videoState.lastUpdated ?? Date.now())) / 1000;
  return (videoState.timestamp ?? 0) + elapsed;
}

function isPlayerReadyFor(type) {
  if (type === "youtube") return ytReady;
  if (type === "direct") return html5Ready;
  if (type === "vimeo") return vimeoReady;
  if (type === "twitch" || type === "dailymotion") return embedReady;
  return false;
}

function syncVideoWhenReady() {
  if (!me) return;
  const item = playlist[videoState.currentIndex];
  if (!item) return;
  if (!isPlayerReadyFor(mediaType(item))) return;
  applyVideoState();
}

async function applyVideoState() {
  if (videoState.currentIndex < 0 || videoState.currentIndex >= playlist.length)
    return;

  const item = playlist[videoState.currentIndex];
  const type = mediaType(item);
  const id = mediaId(item);
  const seekTo = Math.max(0, getSeekPosition());
  const changed = activeMediaType !== type || activeMediaId !== id;

  isSyncing = true;
  showMediaLayer(type);
  document.getElementById("np-title").textContent = mediaLabel(item);

  if (type === "youtube") {
    if (!ytReady) {
      isSyncing = false;
      return;
    }
    document.getElementById("yt-layer").classList.remove("hidden");
    let currentVideoId = null;
    try {
      currentVideoId = ytPlayer.getVideoData()?.video_id ?? null;
    } catch (_) {
      currentVideoId = null;
    }
    if (changed || currentVideoId !== id) {
      ytPlayer.loadVideoById({ videoId: id, startSeconds: seekTo });
      hidePlaceholder();
    } else {
      ytPlayer.seekTo(seekTo, true);
    }
    if (videoState.playing) ytPlayer.playVideo();
    else ytPlayer.pauseVideo();
    hideFastPreview();
    setPlayerLoading(false);
    stopSyncRetries();
  } else if (type === "direct") {
    if (changed || html5El.src !== id) {
      html5Ready = false;
      html5El.src = id;
      hidePlaceholder();
    }
    const applyDirect = () => {
      html5El.currentTime = seekTo;
      if (videoState.playing) html5El.play().catch(() => {});
      else html5El.pause();
    };
    if (html5El.readyState >= 1) applyDirect();
    else
      html5El.addEventListener("loadedmetadata", applyDirect, { once: true });
    setPlayerLoading(false);
    stopSyncRetries();
  } else if (type === "vimeo") {
    const frame = document.getElementById("embed-frame");
    const src = buildEmbedSrc(item);
    if (changed || vimeoBoundSrc !== src) {
      frame.src = src;
      hidePlaceholder();
      await ensureVimeoPlayer(src);
    } else if (!vimeoPlayer) {
      await ensureVimeoPlayer(src);
    }
    if (vimeoPlayer && vimeoReady) {
      await vimeoPlayer.setCurrentTime(seekTo).catch(() => {});
      if (videoState.playing) await vimeoPlayer.play().catch(() => {});
      else await vimeoPlayer.pause().catch(() => {});
      setPlayerLoading(false);
      stopSyncRetries();
    }
  } else if (type === "twitch" || type === "dailymotion") {
    const frame = document.getElementById("embed-frame");
    const src = buildEmbedSrc(item, changed ? seekTo : 0);
    if (changed || frame.src !== src) {
      embedReady = false;
      vimeoPlayer = null;
      vimeoReady = false;
      vimeoBoundSrc = null;
      frame.src = src;
      hidePlaceholder();
    }
    if (embedReady) {
      setPlayerLoading(false);
      stopSyncRetries();
    }
  }

  activeMediaType = type;
  activeMediaId = id;
  document.getElementById("btn-play").textContent = videoState.playing
    ? "⏸ Pause"
    : "▶ Play";
  renderPlaylist();
  setTimeout(() => {
    isSyncing = false;
  }, 1000);
}

async function getPlayerTimestamp() {
  if (activeMediaType === "youtube" && ytPlayer) {
    try {
      return ytPlayer.getCurrentTime();
    } catch (_) {
      return videoState.timestamp ?? 0;
    }
  }
  if (activeMediaType === "direct" && html5El) return html5El.currentTime;
  if (activeMediaType === "vimeo" && vimeoPlayer) {
    try {
      return await vimeoPlayer.getCurrentTime();
    } catch (_) {
      return videoState.timestamp ?? 0;
    }
  }
  return videoState.timestamp ?? 0;
}

// ─── Transport Controls ───────────────────────────────────────────────────────
document.getElementById("btn-play").addEventListener("click", async () => {
  if (!socket || videoState.currentIndex < 0 || !isDj) return;
  const timestamp = await getPlayerTimestamp();
  socket.emit("video_control", {
    action: videoState.playing ? "pause" : "play",
    timestamp,
  });
});
document.getElementById("btn-prev").addEventListener("click", () => {
  if (socket && isDj) socket.emit("video_control", { action: "prev" });
});
document.getElementById("btn-next").addEventListener("click", () => {
  if (socket && isDj) socket.emit("video_control", { action: "next" });
});

// ─── Add Video ────────────────────────────────────────────────────────────────
document
  .getElementById("add-video-btn")
  .addEventListener("click", () => addVideo());
videoUrlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") addVideo();
});

function addVideo(urlOverride) {
  const url = (urlOverride ?? videoUrlInput.value).trim();
  if (!url || !socket || !connected) return;
  socket.emit("add_video", url);
  videoUrlInput.value = "";
  closePasteModal();
  if (!isDj) {
    addSystemMessage("Video queued — become DJ to control playback");
  }
}

function openPasteModal() {
  const modal = document.getElementById("paste-modal");
  const input = document.getElementById("paste-modal-input");
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  input.value = videoUrlInput.value;
  setTimeout(() => input.focus(), 50);
}

function closePasteModal() {
  const modal = document.getElementById("paste-modal");
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
  document.getElementById("paste-modal-input").value = "";
}

document
  .getElementById("btn-open-paste")
  .addEventListener("click", openPasteModal);
document
  .getElementById("paste-modal-cancel")
  .addEventListener("click", closePasteModal);
document
  .getElementById("paste-modal-backdrop")
  .addEventListener("click", closePasteModal);
document.getElementById("paste-modal-add").addEventListener("click", () => {
  addVideo(document.getElementById("paste-modal-input").value);
});
document
  .getElementById("paste-modal-input")
  .addEventListener("keydown", (e) => {
    if (e.key === "Enter") addVideo(e.target.value);
  });

document.getElementById("toggle-playlist").addEventListener("click", () => {
  const wrap = document.getElementById("playlist-wrap");
  const btn = document.getElementById("toggle-playlist");
  const open = wrap.classList.toggle("expanded");
  btn.textContent = open ? "Queue ▴" : "Queue ▾";
});

// ─── Playlist render ──────────────────────────────────────────────────────────
function renderPlaylist() {
  const wrap = document.getElementById("playlist-wrap");
  const toggle = document.getElementById("toggle-playlist");
  if (playlist.length === 0) {
    wrap.innerHTML = `<div style="font-size:11px;color:var(--muted);padding:4px 6px;">No videos yet. Add one above ↑</div>`;
    toggle.textContent = "Queue ▾";
    wrap.classList.remove("expanded");
    return;
  }
  if (isMobileLayout()) {
    toggle.textContent = wrap.classList.contains("expanded")
      ? `Queue ▴ (${playlist.length})`
      : `Queue ▾ (${playlist.length})`;
  }
  wrap.innerHTML = playlist
    .map(
      (item, i) => `
    <div class="playlist-item ${i === videoState.currentIndex ? "active" : ""}${isDj ? "" : " disabled"}" data-index="${i}">
      <span class="idx">${i + 1}</span>
      <span>${escHtml(mediaLabel(item))} <span style="color:var(--muted)">· ${escHtml(item.addedBy)}</span></span>
    </div>
  `,
    )
    .join("");

  wrap.querySelectorAll(".playlist-item").forEach((el) => {
    el.addEventListener("click", () => {
      if (!socket || !isDj) return;
      socket.emit("video_control", {
        action: "play_index",
        index: parseInt(el.dataset.index, 10),
      });
    });
  });
}

// ─── Online count ─────────────────────────────────────────────────────────────
function updateOnlineCount() {
  document.getElementById("count").textContent = Object.keys(users).length;
}

// ─── Utility ──────────────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─── Kick off ─────────────────────────────────────────────────────────────────
drawLounge();
moveLoop();
initHtml5Player();
initEmbedPlayer();
loadYouTubeAPI();
