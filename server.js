require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

const PORT = process.env.PORT || 3000;

// ─── Serve static files ───────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html")),
);
app.get("/index.js", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.js")),
);

// ─── In-memory state (no database needed) ────────────────────────────────────
let users = {}; // { socketId: { id, name, x, y, color } }
let chatLog = []; // [ { name, color, message, time } ]
let playlist = []; // [ { videoId, url, addedBy } ]
let djId = null; // first user in room controls playback
let videoState = {
  playing: false,
  currentIndex: -1,
  timestamp: 0,
  lastUpdated: Date.now(),
};

// Avatar colors pool
const COLORS = [
  "#FF6B6B",
  "#FFD93D",
  "#6BCB77",
  "#4D96FF",
  "#C77DFF",
  "#FF9A3C",
  "#00C9A7",
  "#F72585",
];
const AVATAR_NAMES = [
  "Comet",
  "Nova",
  "Pixel",
  "Vibe",
  "Echo",
  "Nimbus",
  "Drift",
  "Spark",
];

function getRandomColor() {
  return COLORS[Math.floor(Math.random() * COLORS.length)];
}

function getRandomName() {
  return (
    AVATAR_NAMES[Math.floor(Math.random() * AVATAR_NAMES.length)] +
    Math.floor(Math.random() * 99)
  );
}

function getSpawnPosition() {
  return {
    x: 80 + Math.floor(Math.random() * 400),
    y: 60 + Math.floor(Math.random() * 120),
  };
}

function setDj(userId) {
  if (!users[userId]) return null;
  djId = userId;
  return getDjInfo();
}

function getDjInfo() {
  if (!djId || !users[djId]) return null;
  const dj = users[djId];
  return { id: dj.id, name: dj.name, color: dj.color };
}

function assignDjIfNeeded() {
  if (djId && users[djId]) return getDjInfo();
  const ids = Object.keys(users);
  djId = ids.length ? ids[0] : null;
  return getDjInfo();
}

// ─── Socket.io Events ─────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log(`[+] User connected: ${socket.id}`);

  // Assign avatar
  const pos = getSpawnPosition();
  users[socket.id] = {
    id: socket.id,
    name: getRandomName(),
    x: pos.x,
    y: pos.y,
    color: getRandomColor(),
  };

  if (!djId || !users[djId]) djId = socket.id;

  // Send new user their own info + current room state
  socket.emit("init", {
    me: users[socket.id],
    users,
    chatLog: chatLog.slice(-50),
    playlist,
    videoState: getCurrentVideoState(),
    dj: getDjInfo(),
  });

  // Broadcast new user to everyone else
  socket.broadcast.emit("user_joined", users[socket.id]);

  // ── Avatar movement ──────────────────────────────────────────────────────────
  socket.on("move", ({ x, y }) => {
    if (!users[socket.id]) return;
    users[socket.id].x = x;
    users[socket.id].y = y;
    socket.broadcast.emit("user_moved", { id: socket.id, x, y });
  });

  // ── Chat message ─────────────────────────────────────────────────────────────
  socket.on("chat_message", (message) => {
    if (!users[socket.id]) return;
    const msg = {
      name: users[socket.id].name,
      color: users[socket.id].color,
      message: String(message).slice(0, 300),
      time: new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      }),
    };
    chatLog.push(msg);
    if (chatLog.length > 100) chatLog.shift();
    io.emit("chat_message", msg);
  });

  // ── Floating emoji reaction ───────────────────────────────────────────────────
  socket.on("reaction", (emoji) => {
    if (!users[socket.id]) return;
    io.emit("reaction", {
      id: socket.id,
      emoji,
      x: users[socket.id].x,
      y: users[socket.id].y,
    });
  });

  // ── Playlist: add video ───────────────────────────────────────────────────────
  socket.on("add_video", (url) => {
    if (!users[socket.id]) return;
    const parsed = parseMediaUrl(url);
    if (!parsed) {
      return socket.emit(
        "error_msg",
        "Unsupported link. Try YouTube, Vimeo, Twitch, Dailymotion, or a direct .mp4/.webm link.",
      );
    }

    const item = { ...parsed, addedBy: users[socket.id].name };
    playlist.push(item);

    io.emit("playlist_updated", playlist);

    // Auto-play if nothing is playing
    if (videoState.currentIndex === -1) {
      videoState = {
        playing: true,
        currentIndex: 0,
        timestamp: 0,
        lastUpdated: Date.now(),
      };
      io.emit("video_state", videoState);
    }
  });

  // ── Video controls (play/pause/seek) — DJ only ───────────────────────────────
  socket.on("video_control", ({ action, timestamp, index }) => {
    if (socket.id !== djId) {
      return socket.emit("error_msg", "Only the DJ can control playback");
    }

    if (action === "play") {
      videoState.playing = true;
      videoState.timestamp = timestamp ?? videoState.timestamp;
      videoState.lastUpdated = Date.now();
    } else if (action === "pause") {
      videoState.playing = false;
      videoState.timestamp = timestamp ?? videoState.timestamp;
      videoState.lastUpdated = Date.now();
    } else if (action === "seek") {
      videoState.timestamp = timestamp;
      videoState.lastUpdated = Date.now();
    } else if (action === "next") {
      if (videoState.currentIndex < playlist.length - 1) {
        videoState.currentIndex++;
        videoState.timestamp = 0;
        videoState.playing = true;
        videoState.lastUpdated = Date.now();
      }
    } else if (action === "prev") {
      if (videoState.currentIndex > 0) {
        videoState.currentIndex--;
        videoState.timestamp = 0;
        videoState.playing = true;
        videoState.lastUpdated = Date.now();
      }
    } else if (action === "play_index") {
      videoState.currentIndex = index;
      videoState.timestamp = 0;
      videoState.playing = true;
      videoState.lastUpdated = Date.now();
    }
    io.emit("video_state", videoState);
  });

  // ── DJ: volunteer or pass role ───────────────────────────────────────────────
  socket.on("become_dj", () => {
    if (!users[socket.id]) return;
    const nextDj = setDj(socket.id);
    if (nextDj) io.emit("dj_changed", nextDj);
  });

  socket.on("pass_dj", (targetId) => {
    if (socket.id !== djId) {
      return socket.emit("error_msg", "Only the DJ can pass the role");
    }
    if (!users[targetId] || targetId === socket.id) {
      return socket.emit("error_msg", "Pick someone else in the room");
    }
    const nextDj = setDj(targetId);
    if (nextDj) io.emit("dj_changed", nextDj);
  });

  // ── Disconnect ────────────────────────────────────────────────────────────────
  socket.on("disconnect", () => {
    console.log(`[-] User disconnected: ${socket.id}`);
    const wasDj = socket.id === djId;
    io.emit("user_left", socket.id);
    delete users[socket.id];
    if (wasDj) {
      djId = null;
      const nextDj = assignDjIfNeeded();
      if (nextDj) io.emit("dj_changed", nextDj);
    }
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function parseMediaUrl(input) {
  const raw = String(input).trim();
  if (!raw) return null;

  let url;
  try {
    url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^www\./, "");
  const path = url.pathname;

  const yt = raw.match(
    /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/,
  );
  if (yt) {
    return { type: "youtube", id: yt[1], url: raw, label: `youtu.be/${yt[1]}` };
  }

  const vimeo = raw.match(/(?:vimeo\.com\/|player\.vimeo\.com\/video\/)(\d+)/);
  if (vimeo) {
    return {
      type: "vimeo",
      id: vimeo[1],
      url: raw,
      label: `vimeo.com/${vimeo[1]}`,
    };
  }

  const twitchVod = raw.match(/twitch\.tv\/videos\/(\d+)/);
  if (twitchVod) {
    return {
      type: "twitch",
      id: twitchVod[1],
      twitchKind: "video",
      url: raw,
      label: `twitch video`,
    };
  }

  const twitchClip = raw.match(
    /clips\.twitch\.tv\/([a-zA-Z0-9_-]+)|twitch\.tv\/[^/]+\/clip\/([a-zA-Z0-9_-]+)/,
  );
  if (twitchClip) {
    const id = twitchClip[1] || twitchClip[2];
    return {
      type: "twitch",
      id,
      twitchKind: "clip",
      url: raw,
      label: `twitch clip`,
    };
  }

  const dm = raw.match(/dailymotion\.com\/video\/([a-zA-Z0-9]+)/);
  if (dm) {
    return {
      type: "dailymotion",
      id: dm[1],
      url: raw,
      label: `dailymotion`,
    };
  }

  if (/\.(mp4|webm|ogg|m4v)(\?|#|$)/i.test(url.pathname + url.search)) {
    const label = decodeURIComponent(path.split("/").pop() || "video");
    return { type: "direct", id: url.href, url: url.href, label };
  }

  return null;
}

function getCurrentVideoState() {
  const lastUpdated = videoState.lastUpdated ?? Date.now();
  if (!videoState.playing) {
    return { ...videoState, lastUpdated };
  }
  const elapsed = (Date.now() - lastUpdated) / 1000;
  return {
    ...videoState,
    timestamp: (videoState.timestamp ?? 0) + elapsed,
    lastUpdated: Date.now(),
  };
}

// ─── Start server ─────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`✅ Chill Room running at http://localhost:${PORT}`);
});
