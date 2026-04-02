import { Hono } from "hono";
import { createBunWebSocket } from "hono/bun";
import {
  getQrCode,
  getMediaItem,
  getEpisodes,
  getEpisode,
  getWatchProgress,
  setWatchProgress,
  getAllMediaItems,
  getMediaItemsByType,
  getRandomMediaItem,
  getRemainingWatchSeconds,
  getDailyLimitMinutes,
  setDailyLimitMinutes,
  getTodayWatchSeconds,
  getAllChildren,
  getChild,
  getChildByQrCode,
  createChild,
  updateChild,
  deleteChild,
  getChildSchedules,
  setChildSchedule,
  setChildScheduleBulk,
  getChildBonusTime,
  getChildAvailableBonusMinutes,
  grantBonusTime,
  getChildTimeStatus,
  getChildWatchHistory,
  type MediaItem,
  type MediaType,
  type Episode,
  type ChildTimeStatus,
} from "../lib/db";
import { play, stop, next, pause, resume, isPlaying, isPaused, onPlaybackEnd, getCurrentFilePath, type PlayResult } from "../lib/vlc";
import { getOrCreateQrId, generateQrSvg } from "../lib/qrcode";
import { scanMediaDirectories } from "../lib/scanner";
import { config } from "../lib/config";
import { admin } from "./admin";
import { print } from "./print";
import { childrenAdmin } from "./children-admin";

const { upgradeWebSocket, websocket } = createBunWebSocket();

const app = new Hono();

// Mount admin UI
app.route("/admin", admin);
app.route("/admin/print", print);
app.route("/admin/children", childrenAdmin);

// --- Special QR code IDs ---
const SPECIAL_CODES: Record<string, string> = {
  next: "bbtv-next",
  random: "bbtv-random",
  stop: "bbtv-stop",
  pause: "bbtv-pause",
  play: "bbtv-play",
  signout: "bbtv-signout",
};

// --- Active child session ---
let activeChildId: string | null = null;
let childSessionTimeout: ReturnType<typeof setTimeout> | null = null;
const CHILD_SESSION_TIMEOUT_MS = 10 * 60 * 1000; // 10 min inactivity timeout

function setActiveChild(childId: string | null) {
  activeChildId = childId;
  resetSessionTimeout();
  if (childId) {
    const status = getChildTimeStatus(childId);
    broadcastToIdle({
      type: "child_signed_in",
      childId,
      childName: status?.childName,
      remainingSeconds: status?.remainingSeconds,
      canWatch: status?.canWatch,
    });
    console.log(`[Session] Child signed in: ${status?.childName} (${childId})`);
  } else {
    broadcastToIdle({ type: "child_signed_out" });
    console.log("[Session] Child signed out");
  }
}

function resetSessionTimeout() {
  if (childSessionTimeout) clearTimeout(childSessionTimeout);
  if (activeChildId && !isPlaying()) {
    childSessionTimeout = setTimeout(() => {
      console.log("[Session] Auto sign-out due to inactivity");
      setActiveChild(null);
    }, CHILD_SESSION_TIMEOUT_MS);
  }
}

export function getActiveChildId(): string | null {
  return activeChildId;
}

// Track connected idle screen clients
type WsClient = { send: (data: string) => void };
const idleClients = new Set<WsClient>();

function broadcastToIdle(msg: object) {
  const json = JSON.stringify(msg);
  for (const ws of idleClients) ws.send(json);
}

// Notify idle screens when playback state changes
onPlaybackEnd(() => {
  const childStatus = activeChildId ? getChildTimeStatus(activeChildId) : null;
  broadcastToIdle({
    type: "playback_ended",
    childName: childStatus?.childName,
    remainingSeconds: childStatus?.remainingSeconds,
    canWatch: childStatus?.canWatch,
  });
  resetSessionTimeout();
});

// --- WebSocket for idle screen ---

app.get(
  "/ws",
  upgradeWebSocket(() => ({
    onOpen(_event, ws) {
      idleClients.add(ws as unknown as WsClient);
    },
    onClose(_event, ws) {
      idleClients.delete(ws as unknown as WsClient);
    },
    onMessage(event, ws) {
      try {
        const data = JSON.parse(String(event.data));
        if (data.type === "play" && data.qrId) {
          handlePlay(data.qrId, ws as unknown as WsClient);
        }
      } catch {
        // ignore bad messages
      }
    },
  }))
);

// --- Play endpoint (HTTP fallback) ---

app.get("/play/:id", async (c) => {
  const qrId = c.req.param("id");
  const result = await resolveAndPlay(qrId);
  if (!result.ok) {
    return c.json({ error: result.error }, 404);
  }
  return c.redirect("/idle");
});

// --- Idle screen ---

app.get("/idle", (c) => {
  return c.html(idlePageHtml());
});

// --- API routes for admin ---

app.get("/api/media", (c) => {
  const mediaType = c.req.query("type") as MediaType | undefined;
  const items = mediaType ? getMediaItemsByType(mediaType) : getAllMediaItems();
  return c.json(items);
});

app.get("/api/media/:id", (c) => {
  const item = getMediaItem(c.req.param("id"));
  if (!item) return c.json({ error: "Not found" }, 404);

  const episodes = item.media_type === "tv_show" ? getEpisodes(item.id) : [];
  const qrId = getOrCreateQrId(item.id, "item");
  return c.json({ ...item, episodes, qrId });
});

app.get("/api/media/:id/qr.svg", async (c) => {
  const item = getMediaItem(c.req.param("id"));
  if (!item) return c.json({ error: "Not found" }, 404);

  const qrId = getOrCreateQrId(item.id, "item");
  const svg = await generateQrSvg(qrId);
  return c.body(svg, { headers: { "Content-Type": "image/svg+xml" } });
});

app.post("/api/scan", (c) => {
  const result = scanMediaDirectories(config.mediaDirs);
  return c.json(result);
});

app.get("/api/status", (c) => {
  const remaining = getRemainingWatchSeconds();
  return c.json({
    playing: isPlaying(),
    remainingSeconds: remaining,
    todayWatchedMinutes: Math.round(getTodayWatchSeconds() / 60),
    dailyLimitMinutes: getDailyLimitMinutes(),
  });
});

app.post("/api/stop", async (c) => {
  await stop();
  return c.json({ ok: true });
});

// --- Time limit API ---

app.get("/api/time-limit", (c) => {
  return c.json({
    dailyLimitMinutes: getDailyLimitMinutes(),
    todayWatchedSeconds: getTodayWatchSeconds(),
    remainingSeconds: getRemainingWatchSeconds(),
  });
});

app.post("/api/time-limit", async (c) => {
  const body = await c.req.json<{ minutes: number | null }>();
  setDailyLimitMinutes(body.minutes);
  return c.json({ ok: true, dailyLimitMinutes: body.minutes });
});

// --- YouTube download ---

app.post("/api/youtube/info", async (c) => {
  const { url } = await c.req.json<{ url: string }>();
  try {
    const { fetchVideoInfo } = await import("../lib/youtube");
    const info = await fetchVideoInfo(url);
    return c.json(info);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

app.post("/api/youtube/download", async (c) => {
  const { url, category, title } = await c.req.json<{
    url: string;
    category: string;
    title: string | null;
  }>();
  try {
    const { downloadVideo } = await import("../lib/youtube");

    // Stream progress via SSE
    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        try {
          await downloadVideo(url, category, title, (progress) => {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(progress)}\n\n`));
          });

          // After download, trigger a library rescan
          scanMediaDirectories(config.mediaDirs);
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ status: "complete_and_scanned" })}\n\n`));
        } catch (err) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({
            status: "error",
            error: err instanceof Error ? err.message : String(err),
          })}\n\n`));
        }
        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

// --- TMDB routes ---

app.post("/api/match-all", async (c) => {
  const { matchAllUnmatched } = await import("../lib/tmdb");
  const result = await matchAllUnmatched();
  return c.json(result);
});

app.post("/api/media/:id/match", async (c) => {
  const { matchMediaItem } = await import("../lib/tmdb");
  const success = await matchMediaItem(c.req.param("id"));
  return c.json({ success });
});

app.post("/api/media/:id/tmdb-match", async (c) => {
  const { tmdbId, type } = await c.req.json<{ tmdbId: number; type: "tv" | "movie" }>();
  const { manualMatch } = await import("../lib/tmdb");
  const success = await manualMatch(c.req.param("id"), tmdbId, type);
  return c.json({ success });
});

app.get("/api/tmdb/search", async (c) => {
  const query = c.req.query("q") || "";
  const type = c.req.query("type") || "tv";
  const { searchTvShow, searchMovie } = await import("../lib/tmdb");
  const results = type === "movie" ? await searchMovie(query) : await searchTvShow(query);
  return c.json(results);
});

// --- Children API ---

app.get("/api/children", (c) => {
  const children = getAllChildren();
  return c.json(children.map((child) => ({
    ...child,
    timeStatus: getChildTimeStatus(child.id),
  })));
});

app.post("/api/children", async (c) => {
  const { name, avatarColor, weekdayAllotment, weekdayMax, weekendAllotment, weekendMax } = await c.req.json<{
    name: string;
    avatarColor?: string;
    weekdayAllotment?: number;
    weekdayMax?: number;
    weekendAllotment?: number;
    weekendMax?: number;
  }>();
  const { nanoid } = await import("nanoid");
  const id = nanoid(8);
  const qrCodeId = `bbtv-child-${nanoid(6)}`;
  createChild({ id, name, avatar_color: avatarColor || "#e94560", qr_code_id: qrCodeId });

  // Set default schedules
  setChildScheduleBulk(
    id,
    { allotment: weekdayAllotment ?? 30, max: weekdayMax ?? 60 },
    { allotment: weekendAllotment ?? 60, max: weekendMax ?? 120 },
  );

  return c.json({ id, qrCodeId });
});

app.get("/api/children/:id", (c) => {
  const child = getChild(c.req.param("id"));
  if (!child) return c.json({ error: "Not found" }, 404);
  return c.json({
    ...child,
    timeStatus: getChildTimeStatus(child.id),
    schedules: getChildSchedules(child.id),
    bonusTime: getChildBonusTime(child.id),
    availableBonus: getChildAvailableBonusMinutes(child.id),
    watchHistory: getChildWatchHistory(child.id, 20),
  });
});

app.put("/api/children/:id", async (c) => {
  const { name, avatarColor } = await c.req.json<{ name: string; avatarColor: string }>();
  updateChild(c.req.param("id"), name, avatarColor);
  return c.json({ ok: true });
});

app.delete("/api/children/:id", (c) => {
  deleteChild(c.req.param("id"));
  if (activeChildId === c.req.param("id")) setActiveChild(null);
  return c.json({ ok: true });
});

app.put("/api/children/:id/schedule/:day", async (c) => {
  const day = parseInt(c.req.param("day"), 10);
  const { allotmentMinutes, maxMinutes } = await c.req.json<{ allotmentMinutes: number; maxMinutes: number }>();
  setChildSchedule(c.req.param("id"), day, allotmentMinutes, maxMinutes);
  return c.json({ ok: true });
});

app.post("/api/children/:id/bonus", async (c) => {
  const { minutes, reason } = await c.req.json<{ minutes: number; reason: string }>();
  grantBonusTime(c.req.param("id"), minutes, reason);
  return c.json({ ok: true });
});

app.get("/api/children/:id/qr.svg", async (c) => {
  const child = getChild(c.req.param("id"));
  if (!child) return c.json({ error: "Not found" }, 404);
  const { generateSpecialQrSvg } = await import("../lib/qrcode");
  const svg = await generateSpecialQrSvg(child.qr_code_id);
  return c.body(svg, { headers: { "Content-Type": "image/svg+xml" } });
});

app.get("/api/session", (c) => {
  if (!activeChildId) return c.json({ active: false });
  const status = getChildTimeStatus(activeChildId);
  return c.json({ active: true, ...status });
});

app.post("/api/session/signout", (c) => {
  setActiveChild(null);
  return c.json({ ok: true });
});

// --- Special codes API ---

app.get("/api/special-codes", (c) => {
  return c.json(SPECIAL_CODES);
});

// --- Health check ---

app.get("/health", (c) => c.json({ status: "ok" }));

// Serve data dir files (logo, etc)
app.get("/data/*", async (c) => {
  const filePath = c.req.path.replace("/data/", "");
  const fullPath = `${config.dataDir}/${filePath}`;
  const file = Bun.file(fullPath);
  if (await file.exists()) return new Response(file);
  return c.json({ error: "Not found" }, 404);
});

// --- Serve cover art ---

app.get("/covers/*", async (c) => {
  const filePath = c.req.path.replace("/covers/", "");
  const fullPath = `${config.coverArtDir}/${filePath}`;
  const file = Bun.file(fullPath);
  if (await file.exists()) {
    return new Response(file);
  }
  return c.json({ error: "Not found" }, 404);
});

// --- Play logic ---

async function handlePlay(qrId: string, ws: WsClient) {
  const result = await resolveAndPlay(qrId);
  if (result.ok) {
    if (result.childSignedIn) {
      // Child sign-in doesn't play anything, just broadcasts (already done in setActiveChild)
      ws.send(JSON.stringify({
        type: "child_signed_in",
        childName: result.childName,
        remainingSeconds: result.remainingSeconds,
      }));
    } else {
      ws.send(JSON.stringify({
        type: "playing",
        title: result.title,
        poster: result.poster,
      }));
    }
  } else {
    ws.send(JSON.stringify({
      type: "error",
      error: result.error,
      timeLimitReached: result.timeLimitReached,
      needsChildSignIn: result.needsChildSignIn,
    }));
  }
}

type PlayResponse =
  | { ok: true; title: string; poster: string | null; remainingSeconds?: number; childSignedIn?: boolean; childName?: string }
  | { ok: false; error: string; timeLimitReached?: boolean; needsChildSignIn?: boolean };

async function resolveAndPlay(qrId: string): Promise<PlayResponse> {
  // --- Handle special codes ---
  if (qrId === SPECIAL_CODES.stop) {
    await stop();
    return { ok: true, title: "Stopped", poster: null };
  }

  if (qrId === SPECIAL_CODES.pause) {
    await pause();
    return { ok: true, title: "Paused", poster: null };
  }

  if (qrId === SPECIAL_CODES.play) {
    await resume();
    return { ok: true, title: "Resumed", poster: null };
  }

  if (qrId === SPECIAL_CODES.next) {
    return handleNext();
  }

  if (qrId === SPECIAL_CODES.random) {
    return handleRandom();
  }

  if (qrId === SPECIAL_CODES.signout) {
    await stop();
    setActiveChild(null);
    return { ok: true, title: "Signed out", poster: null };
  }

  // --- Check for child sign-in QR code ---
  if (qrId.startsWith("bbtv-child-")) {
    const child = getChildByQrCode(qrId);
    if (!child) return { ok: false, error: "Unknown child code" };

    setActiveChild(child.id);
    const status = getChildTimeStatus(child.id);
    return {
      ok: true,
      title: `Hi ${child.name}!`,
      poster: null,
      childSignedIn: true,
      childName: child.name,
      remainingSeconds: status?.remainingSeconds,
    };
  }

  // --- Check if children exist and one needs to be signed in ---
  const children = getAllChildren();
  if (children.length > 0 && !activeChildId) {
    return {
      ok: false,
      error: "Scan your name card first!",
      needsChildSignIn: true,
    };
  }

  // --- Check child time limit ---
  if (activeChildId) {
    resetSessionTimeout();
    const status = getChildTimeStatus(activeChildId);
    if (status && !status.canWatch) {
      return {
        ok: false,
        error: `${status.childName}'s watch time is up for today!`,
        timeLimitReached: true,
      };
    }
  }

  // --- Regular QR codes ---
  const qr = getQrCode(qrId);
  if (!qr) return { ok: false, error: "Unknown QR code" };

  if (qr.qr_type === "episode") {
    return playEpisode(qr.media_id);
  }

  // Item-level play
  const item = getMediaItem(qr.media_id);
  if (!item) return { ok: false, error: "Media not found" };

  if (item.media_type === "movie" || item.media_type === "music_video") {
    return playFile(item.file_path!, item.id, item.title, item.poster_path);
  }

  // TV show — play next episode
  return playNextEpisode(item);
}

async function playEpisode(episodeId: string): Promise<PlayResponse> {
  const episode = getEpisode(episodeId);
  if (!episode) return { ok: false, error: "Episode not found" };

  const show = getMediaItem(episode.show_id);
  const title = show
    ? `${show.title} - ${episode.title || `Episode ${episode.episode_number}`}`
    : episode.title || "Unknown";

  const result = await play(episode.file_path, episode.show_id, activeChildId);
  if (!result.ok) return { ok: false, error: result.error! };

  setWatchProgress(episode.show_id, episode.season_number, episode.episode_number);

  return { ok: true, title, poster: show?.poster_path ?? null };
}

async function playFile(
  filePath: string,
  mediaId: string,
  title: string,
  poster: string | null,
): Promise<PlayResponse> {
  if (!filePath) return { ok: false, error: "No file path" };

  const result = await play(filePath, mediaId, activeChildId);
  if (!result.ok) return { ok: false, error: result.error! };

  return { ok: true, title, poster };
}

async function playNextEpisode(item: MediaItem): Promise<PlayResponse> {
  const episodes = getEpisodes(item.id);
  if (episodes.length === 0) return { ok: false, error: "No episodes found" };

  const progress = getWatchProgress(item.id);
  let nextEp: Episode | undefined;

  if (!progress) {
    nextEp = episodes[0];
  } else {
    const lastIdx = episodes.findIndex(
      (e) => e.season_number === progress.last_season && e.episode_number === progress.last_episode
    );
    if (lastIdx === -1 || lastIdx >= episodes.length - 1) {
      nextEp = episodes[0];
    } else {
      nextEp = episodes[lastIdx + 1];
    }
  }

  if (!nextEp) return { ok: false, error: "No episode to play" };

  const result = await play(nextEp.file_path, item.id, activeChildId);
  if (!result.ok) return { ok: false, error: result.error! };

  setWatchProgress(item.id, nextEp.season_number, nextEp.episode_number);

  return {
    ok: true,
    title: `${item.title} - ${nextEp.title || `Episode ${nextEp.episode_number}`}`,
    poster: item.poster_path,
  };
}

async function handleNext(): Promise<PlayResponse> {
  if (!isPlaying()) return { ok: false, error: "Nothing is playing" };

  // Figure out what's currently playing so we can play the next thing
  // For now, just skip (stop current). The idle screen will show "scan again" message.
  await next();
  return { ok: true, title: "Skipped", poster: null };
}

async function handleRandom(): Promise<PlayResponse> {
  const item = getRandomMediaItem();
  if (!item) return { ok: false, error: "No media in library" };

  if (item.media_type === "tv_show") {
    return playNextEpisode(item);
  }

  return playFile(item.file_path!, item.id, item.title, item.poster_path);
}

// --- Idle page HTML ---

function idlePageHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>BBTV</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #0a0a12;
      color: #e0e0e0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
    }
    #static-canvas {
      position: fixed;
      top: 0; left: 0;
      width: 100%; height: 100%;
      z-index: 0;
      opacity: 0.07;
      pointer-events: none;
    }
    .content-layer {
      position: relative;
      z-index: 1;
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100vh;
    }
    .screen { text-align: center; display: none; }
    .screen.active { display: block; }
    .screen h1 {
      font-size: 4rem;
      margin-bottom: 1rem;
      color: #e94560;
      text-shadow: 0 0 20px rgba(233,69,96,0.4), 0 0 60px rgba(233,69,96,0.15);
    }
    .logo { max-width: 280px; margin: 0 auto 1rem; filter: drop-shadow(0 0 20px rgba(233,69,96,0.3)); }
    .screen p { font-size: 2rem; color: #a0a0b0; }
    .child-name {
      font-size: 2.5rem;
      color: #4fc3f7;
      margin: 0.5rem 0;
      text-shadow: 0 0 15px rgba(79,195,247,0.4);
    }
    .time-info { font-size: 1.3rem; color: #a0a0b0; margin-top: 0.75rem; }
    .time-info.warning { color: #e94560; }
    .time-info.expired { color: #ff2222; font-weight: bold; }
    .greeting { font-size: 3rem; color: #4fc3f7; margin-bottom: 0.5rem; }
    .loading { text-align: center; display: none; }
    .loading.active { display: flex; flex-direction: column; align-items: center; justify-content: center; }
    .loading img { max-width: 300px; max-height: 400px; border-radius: 12px; margin-bottom: 1rem; }
    .loading h2 { font-size: 2.5rem; color: #e94560; }
    .error-msg { text-align: center; display: none; }
    .error-msg.active { display: block; }
    .error-msg h2 { font-size: 2rem; color: #ff4444; margin-bottom: 0.5rem; }
    .error-msg p { font-size: 1.2rem; color: #a0a0b0; }
    .pulse { animation: pulse 2s infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
    .scanline {
      position: fixed;
      top: 0; left: 0;
      width: 100%; height: 100%;
      z-index: 2;
      pointer-events: none;
      background: repeating-linear-gradient(
        0deg,
        transparent,
        transparent 2px,
        rgba(0,0,0,0.08) 2px,
        rgba(0,0,0,0.08) 4px
      );
    }
    #scanner-input { position: absolute; top: -9999px; left: -9999px; }
  </style>
</head>
<body>
  <canvas id="static-canvas"></canvas>
  <div class="scanline"></div>
  <input id="scanner-input" type="text" autocomplete="off" autofocus />
  <div class="content-layer">

  <!-- No child signed in, prompt to scan name card -->
  <div class="screen" id="signin-screen">
    <img src="/data/bbtv-logo.png" alt="BBTV" class="logo" />
    <p class="pulse">Scan your name card to start!</p>
  </div>

  <!-- Child signed in, ready to scan media -->
  <div class="screen" id="idle-screen">
    <img src="/data/bbtv-logo.png" alt="BBTV" class="logo" />
    <div class="child-name" id="child-name"></div>
    <p class="pulse">Scan a code to watch!</p>
    <div class="time-info" id="time-info"></div>
  </div>

  <!-- No children configured, anyone can watch -->
  <div class="screen active" id="open-screen">
    <img src="/data/bbtv-logo.png" alt="BBTV" class="logo" />
    <p class="pulse">Scan a code to watch!</p>
    <div class="time-info" id="open-time-info"></div>
  </div>

  <div class="loading" id="loading">
    <img id="loading-poster" src="" alt="" />
    <h2 id="loading-title" class="pulse">Loading...</h2>
  </div>

  <div class="error-msg" id="error">
    <h2 id="error-title">Oops!</h2>
    <p id="error-detail"></p>
  </div>

  </div><!-- end content-layer -->

  <script>
    // --- TV Static Effect ---
    (function() {
      var canvas = document.getElementById('static-canvas');
      var ctx = canvas.getContext('2d');
      var w, h, imageData, data;

      function resize() {
        // Use a small resolution and let CSS scale it up for a chunky look
        w = canvas.width = Math.ceil(window.innerWidth / 4);
        h = canvas.height = Math.ceil(window.innerHeight / 4);
        imageData = ctx.createImageData(w, h);
        data = imageData.data;
      }
      resize();
      window.addEventListener('resize', resize);

      function drawStatic() {
        for (var i = 0; i < data.length; i += 4) {
          var v = Math.random() * 255;
          data[i] = v;
          data[i+1] = v;
          data[i+2] = v;
          data[i+3] = 255;
        }
        ctx.putImageData(imageData, 0, 0);
        requestAnimationFrame(drawStatic);
      }
      drawStatic();
    })();
  </script>

  <script>
    var input = document.getElementById('scanner-input');
    var signinScreen = document.getElementById('signin-screen');
    var idleScreen = document.getElementById('idle-screen');
    var openScreen = document.getElementById('open-screen');
    var loadingEl = document.getElementById('loading');
    var loadingPoster = document.getElementById('loading-poster');
    var loadingTitle = document.getElementById('loading-title');
    var errorEl = document.getElementById('error');
    var errorTitle = document.getElementById('error-title');
    var errorDetail = document.getElementById('error-detail');
    var childNameEl = document.getElementById('child-name');
    var timeInfoEl = document.getElementById('time-info');
    var openTimeInfoEl = document.getElementById('open-time-info');

    var hasChildren = false;
    var activeChild = null;

    document.addEventListener('click', function() { input.focus(); });
    setInterval(function() { input.focus(); }, 1000);

    // Check session state on load and periodically
    function updateSession() {
      fetch('/api/session').then(function(r) { return r.json(); }).then(function(data) {
        if (data.active) {
          activeChild = { name: data.childName, remaining: data.remainingSeconds, canWatch: data.canWatch };
          hasChildren = true;
          showChildIdle();
        } else {
          activeChild = null;
          // Check if children exist
          fetch('/api/children').then(function(r) { return r.json(); }).then(function(children) {
            hasChildren = children.length > 0;
            showDefaultIdle();
          });
        }
      }).catch(function() {});
    }
    updateSession();
    setInterval(updateSession, 30000);

    // Also poll global time limit for open mode
    function updateOpenTimeInfo() {
      if (hasChildren) return;
      fetch('/api/time-limit').then(function(r) { return r.json(); }).then(function(data) {
        if (data.dailyLimitMinutes === null) {
          openTimeInfoEl.textContent = '';
          return;
        }
        var remaining = data.remainingSeconds;
        if (remaining <= 0) {
          openTimeInfoEl.textContent = 'Watch time is up for today!';
          openTimeInfoEl.className = 'time-info expired';
        } else {
          openTimeInfoEl.textContent = Math.floor(remaining / 60) + ' minutes remaining';
          openTimeInfoEl.className = remaining < 600 ? 'time-info warning' : 'time-info';
        }
      }).catch(function() {});
    }
    updateOpenTimeInfo();
    setInterval(updateOpenTimeInfo, 30000);

    // WebSocket
    var protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var ws;
    function connect() {
      ws = new WebSocket(protocol + '//' + location.host + '/ws');
      ws.onmessage = function(event) {
        var data = JSON.parse(event.data);
        if (data.type === 'playing') {
          showLoading(data.title, data.poster);
          setTimeout(function() { showDefaultIdle(); }, 3000);
        } else if (data.type === 'child_signed_in') {
          activeChild = { name: data.childName, remaining: data.remainingSeconds, canWatch: data.canWatch };
          hasChildren = true;
          showChildIdle();
        } else if (data.type === 'child_signed_out') {
          activeChild = null;
          showDefaultIdle();
        } else if (data.type === 'playback_ended') {
          if (data.childName) {
            activeChild = { name: data.childName, remaining: data.remainingSeconds, canWatch: data.canWatch };
          }
          updateOpenTimeInfo();
          showDefaultIdle();
        } else if (data.type === 'error') {
          if (data.timeLimitReached) {
            showError('Time is up!', 'Watch time is done for today. Come back tomorrow!');
          } else if (data.needsChildSignIn) {
            showError('Who are you?', 'Scan your name card first!');
          } else {
            showError('Oops!', data.error || 'Something went wrong');
          }
          setTimeout(function() { showDefaultIdle(); }, 5000);
        }
      };
      ws.onclose = function() { setTimeout(connect, 2000); };
    }
    connect();

    // Scanner input
    input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') {
        var value = input.value.trim();
        input.value = '';
        var match = value.match(/\\/play\\/([a-zA-Z0-9_-]+)/);
        if (match) {
          var qrId = match[1];
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'play', qrId: qrId }));
          } else {
            window.location.href = '/play/' + qrId;
          }
        }
      }
    });

    function showLoading(title, poster) {
      hideAll();
      loadingEl.classList.add('active');
      loadingTitle.textContent = title || 'Loading...';
      if (poster) {
        loadingPoster.src = '/covers/' + poster;
        loadingPoster.style.display = 'block';
      } else {
        loadingPoster.style.display = 'none';
      }
    }

    function showError(title, detail) {
      hideAll();
      errorEl.classList.add('active');
      errorTitle.textContent = title;
      errorDetail.textContent = detail;
    }

    function showChildIdle() {
      hideAll();
      if (activeChild) {
        childNameEl.textContent = activeChild.name;
        var mins = Math.floor((activeChild.remaining || 0) / 60);
        if (!activeChild.canWatch) {
          timeInfoEl.textContent = 'Watch time is up for today!';
          timeInfoEl.className = 'time-info expired';
        } else if (mins < 10) {
          timeInfoEl.textContent = mins + ' minutes remaining';
          timeInfoEl.className = 'time-info warning';
        } else {
          timeInfoEl.textContent = mins + ' minutes remaining';
          timeInfoEl.className = 'time-info';
        }
        idleScreen.classList.add('active');
      }
      input.focus();
    }

    function showDefaultIdle() {
      hideAll();
      if (activeChild) {
        showChildIdle();
        return;
      }
      if (hasChildren) {
        signinScreen.classList.add('active');
      } else {
        openScreen.classList.add('active');
      }
      input.focus();
    }

    function hideAll() {
      signinScreen.classList.remove('active');
      idleScreen.classList.remove('active');
      openScreen.classList.remove('active');
      loadingEl.classList.remove('active');
      errorEl.classList.remove('active');
    }
  </script>
</body>
</html>`;
}

export { app, websocket };
