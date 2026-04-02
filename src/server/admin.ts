import { Hono } from "hono";
import {
  getAllMediaItems,
  getMediaItem,
  getEpisodes,
  getMediaItemsByType,
  type MediaItem,
  type MediaType,
} from "../lib/db";
import { getOrCreateQrId, generateQrSvg, getPlayUrl } from "../lib/qrcode";
import { generateSpecialQrSvg } from "../lib/qrcode";
import { config } from "../lib/config";
import { getDailyLimitMinutes, getTodayWatchSeconds, getRemainingWatchSeconds } from "../lib/db";

const admin = new Hono();

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function layout(title: string, content: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} - BBTV Admin</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f5; color: #333; }
    nav { background: #1a1a2e; color: white; padding: 1rem 2rem; display: flex; align-items: center; gap: 2rem; }
    nav a { color: #a0a0c0; text-decoration: none; font-weight: 500; }
    nav a:hover, nav a.active { color: white; }
    nav h1 { color: #e94560; font-size: 1.5rem; margin-right: 1rem; }
    .container { max-width: 1200px; margin: 2rem auto; padding: 0 2rem; }
    .card { background: white; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); padding: 1.5rem; margin-bottom: 1rem; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 1.5rem; }
    .media-card { background: white; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); overflow: hidden; text-decoration: none; color: inherit; transition: transform 0.1s; }
    .media-card:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(0,0,0,0.15); }
    .media-card img { width: 100%; aspect-ratio: 2/3; object-fit: cover; background: #ddd; }
    .media-card .no-poster { width: 100%; aspect-ratio: 2/3; background: #e0e0e0; display: flex; align-items: center; justify-content: center; font-size: 3rem; color: #999; }
    .media-card .info { padding: 0.75rem; }
    .media-card .info h3 { font-size: 0.9rem; margin-bottom: 0.25rem; }
    .media-card .info .meta { font-size: 0.75rem; color: #888; }
    .badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 4px; font-size: 0.7rem; font-weight: 600; text-transform: uppercase; }
    .badge-tv { background: #e3f2fd; color: #1565c0; }
    .badge-movie { background: #fce4ec; color: #c62828; }
    .badge-music { background: #f3e5f5; color: #7b1fa2; }
    .btn { display: inline-block; padding: 0.5rem 1rem; border-radius: 6px; border: none; cursor: pointer; font-size: 0.9rem; font-weight: 500; text-decoration: none; }
    .btn-primary { background: #e94560; color: white; }
    .btn-primary:hover { background: #d63851; }
    .btn-secondary { background: #eee; color: #333; }
    .btn-secondary:hover { background: #ddd; }
    .stats { display: flex; gap: 1.5rem; margin-bottom: 2rem; }
    .stat { background: white; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); padding: 1.5rem; flex: 1; text-align: center; }
    .stat .number { font-size: 2.5rem; font-weight: 700; color: #e94560; }
    .stat .label { font-size: 0.85rem; color: #888; margin-top: 0.25rem; }
    .actions { display: flex; gap: 0.75rem; margin-bottom: 1.5rem; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 0.75rem; text-align: left; border-bottom: 1px solid #eee; }
    th { font-weight: 600; color: #666; font-size: 0.85rem; }
    .detail-header { display: flex; gap: 2rem; margin-bottom: 2rem; }
    .detail-poster { width: 200px; flex-shrink: 0; }
    .detail-poster img { width: 100%; border-radius: 8px; }
    .detail-info { flex: 1; }
    .detail-info h2 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    .detail-info .overview { color: #666; margin: 1rem 0; line-height: 1.6; }
    .qr-preview { text-align: center; padding: 1rem; }
    .qr-preview svg { max-width: 150px; }
    .section-title { font-size: 1.2rem; font-weight: 600; margin: 1.5rem 0 1rem; }
    .toast { position: fixed; bottom: 2rem; right: 2rem; background: #333; color: white; padding: 1rem 1.5rem; border-radius: 8px; display: none; z-index: 100; }
    .toast.show { display: block; }
    .filter-tabs { display: flex; gap: 0.5rem; margin-bottom: 1.5rem; }
    .filter-tab { padding: 0.4rem 1rem; border-radius: 20px; border: 1px solid #ddd; background: white; cursor: pointer; font-size: 0.85rem; text-decoration: none; color: #666; }
    .filter-tab.active { background: #e94560; color: white; border-color: #e94560; }
  </style>
</head>
<body>
  <nav>
    <h1>BBTV</h1>
    <a href="/admin">Dashboard</a>
    <a href="/admin/library">Library</a>
    <a href="/admin/children">Children</a>
    <a href="/admin/download">Download</a>
    <a href="/admin/print">Print Book</a>
    <a href="/admin/settings">Settings</a>
  </nav>
  <div class="container">
    ${content}
  </div>
  <div class="toast" id="toast"></div>
  <script>
    function showToast(msg) {
      const t = document.getElementById('toast');
      t.textContent = msg;
      t.classList.add('show');
      setTimeout(function() { t.classList.remove('show'); }, 3000);
    }
    async function apiPost(url) {
      const res = await fetch(url, { method: 'POST' });
      return res.json();
    }
  </script>
</body>
</html>`;
}

function mediaBadge(mediaType: MediaType): string {
  const labels: Record<MediaType, [string, string]> = {
    tv_show: ["TV Show", "badge-tv"],
    movie: ["Movie", "badge-movie"],
    music_video: ["Music", "badge-music"],
  };
  const [label, cls] = labels[mediaType];
  return `<span class="badge ${cls}">${escapeHtml(label)}</span>`;
}

function posterImg(item: MediaItem): string {
  if (item.poster_path) {
    return `<img src="/covers/${encodeURIComponent(item.poster_path)}" alt="${escapeHtml(item.title)}" />`;
  }
  const icons: Record<MediaType, string> = { tv_show: "TV", movie: "Film", music_video: "Music" };
  return `<div class="no-poster">${icons[item.media_type]}</div>`;
}

// --- Dashboard ---

admin.get("/", (c) => {
  const items = getAllMediaItems();
  const shows = items.filter((i) => i.media_type === "tv_show").length;
  const movies = items.filter((i) => i.media_type === "movie").length;
  const musicVideos = items.filter((i) => i.media_type === "music_video").length;

  return c.html(layout("Dashboard", `
    <h2 style="margin-bottom: 1.5rem;">Dashboard</h2>
    <div class="stats">
      <div class="stat"><div class="number">${shows}</div><div class="label">TV Shows</div></div>
      <div class="stat"><div class="number">${movies}</div><div class="label">Movies</div></div>
      <div class="stat"><div class="number">${musicVideos}</div><div class="label">Music Videos</div></div>
      <div class="stat"><div class="number">${items.length}</div><div class="label">Total</div></div>
    </div>
    <div class="actions">
      <button class="btn btn-primary" onclick="scanLibrary()">Scan Library</button>
      <button class="btn btn-secondary" onclick="matchAll()">Fetch TMDB Metadata</button>
    </div>
    <div class="card" id="scan-result" style="display:none;"></div>
    <script>
      async function scanLibrary() {
        showToast('Scanning...');
        const r = await apiPost('/api/scan');
        var el = document.getElementById('scan-result');
        el.style.display = 'block';
        el.textContent = 'Scan complete: ' + r.added + ' added, ' + r.updated + ' updated, ' + r.shows + ' shows, ' + r.episodes + ' episodes';
        setTimeout(function() { location.reload(); }, 1500);
      }
      async function matchAll() {
        showToast('Fetching TMDB metadata... this may take a while');
        const r = await apiPost('/api/match-all');
        showToast(r.matched + ' matched, ' + r.failed + ' failed');
        setTimeout(function() { location.reload(); }, 1500);
      }
    </script>
  `));
});

// --- Library ---

admin.get("/library", (c) => {
  const filter = c.req.query("type") as MediaType | undefined;
  const items = filter ? getMediaItemsByType(filter) : getAllMediaItems();

  const filterTabs = `
    <div class="filter-tabs">
      <a href="/admin/library" class="filter-tab ${!filter ? "active" : ""}">All</a>
      <a href="/admin/library?type=tv_show" class="filter-tab ${filter === "tv_show" ? "active" : ""}">TV Shows</a>
      <a href="/admin/library?type=movie" class="filter-tab ${filter === "movie" ? "active" : ""}">Movies</a>
      <a href="/admin/library?type=music_video" class="filter-tab ${filter === "music_video" ? "active" : ""}">Music Videos</a>
    </div>
  `;

  const grid = items.map((item) => `
    <a href="/admin/media/${encodeURIComponent(item.id)}" class="media-card">
      ${posterImg(item)}
      <div class="info">
        <h3>${escapeHtml(item.title)}</h3>
        <div class="meta">${mediaBadge(item.media_type)} ${item.year ? `(${item.year})` : ""}</div>
      </div>
    </a>
  `).join("");

  return c.html(layout("Library", `
    <h2 style="margin-bottom: 1.5rem;">Library</h2>
    ${filterTabs}
    <div class="grid">${grid || "<p>No media found. Configure media directories in Settings and scan.</p>"}</div>
  `));
});

// --- Media Detail ---

admin.get("/media/:id", async (c) => {
  const item = getMediaItem(c.req.param("id"));
  if (!item) return c.html(layout("Not Found", "<p>Media not found</p>"), 404);

  const episodes = item.media_type === "tv_show" ? getEpisodes(item.id) : [];
  const qrId = getOrCreateQrId(item.id, "item");
  const qrSvg = await generateQrSvg(qrId);
  const playUrl = getPlayUrl(qrId);

  const episodeTable = episodes.length > 0 ? `
    <h3 class="section-title">Episodes (${episodes.length})</h3>
    <div class="card">
      <table>
        <thead><tr><th>#</th><th>Season</th><th>Episode</th><th>Title</th><th>TMDB</th></tr></thead>
        <tbody>
          ${episodes.map((e) => `
            <tr>
              <td>${e.season_number ? `S${String(e.season_number).padStart(2, "0")}E${String(e.episode_number).padStart(2, "0")}` : `E${String(e.episode_number).padStart(2, "0")}`}</td>
              <td>${e.season_number ?? "N/A"}</td>
              <td>${e.episode_number}</td>
              <td>${escapeHtml(e.title || "Untitled")}</td>
              <td>${e.tmdb_episode_id ? "Yes" : "No"}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  ` : "";

  const typeIcon = item.media_type === "tv_show" ? "TV" : item.media_type === "movie" ? "Film" : "Music";

  return c.html(layout(item.title, `
    <div class="detail-header">
      <div class="detail-poster">
        ${item.poster_path ? `<img src="/covers/${encodeURIComponent(item.poster_path)}" alt="${escapeHtml(item.title)}" />` : `<div class="no-poster" style="width:200px;height:300px;border-radius:8px;">${typeIcon}</div>`}
        <div class="qr-preview" style="margin-top:1rem;">
          ${qrSvg}
          <div style="font-size:0.75rem;color:#888;margin-top:0.5rem;">${escapeHtml(playUrl)}</div>
        </div>
      </div>
      <div class="detail-info">
        <h2>${escapeHtml(item.title)} ${item.year ? `(${item.year})` : ""}</h2>
        <div style="margin-bottom:0.5rem;">${mediaBadge(item.media_type)}</div>
        ${item.overview ? `<p class="overview">${escapeHtml(item.overview)}</p>` : ""}
        <div style="margin:1rem 0;">
          <strong>TMDB:</strong> ${item.tmdb_id ? `Matched (ID: ${item.tmdb_id})` : "Not matched"}
          ${!item.tmdb_id ? `<button class="btn btn-secondary" style="margin-left:0.5rem;" onclick="matchTmdb('${escapeHtml(item.id)}')">Auto Match</button>` : ""}
        </div>
        ${item.folder_path ? `<div><strong>Folder:</strong> <code>${escapeHtml(item.folder_path)}</code></div>` : ""}
        ${item.file_path ? `<div><strong>File:</strong> <code>${escapeHtml(item.file_path)}</code></div>` : ""}
      </div>
    </div>
    ${episodeTable}
    <script>
      async function matchTmdb(id) {
        showToast('Matching with TMDB...');
        const r = await apiPost('/api/media/' + encodeURIComponent(id) + '/match');
        showToast(r.success ? 'Matched!' : 'No match found');
        setTimeout(function() { location.reload(); }, 1000);
      }
    </script>
  `));
});

// --- Settings ---

admin.get("/settings", async (c) => {
  const dailyLimit = getDailyLimitMinutes();
  const watchedToday = Math.round(getTodayWatchSeconds() / 60);
  const remaining = getRemainingWatchSeconds();
  const remainingMins = remaining !== null ? Math.round(remaining / 60) : null;

  // Generate special code QR SVGs
  const specialCodes = [
    { id: "bbtv-play", label: "Play / Resume", desc: "Resume paused playback" },
    { id: "bbtv-pause", label: "Pause", desc: "Pause current playback" },
    { id: "bbtv-stop", label: "Stop", desc: "Stop and return to idle" },
    { id: "bbtv-next", label: "Next / Skip", desc: "Skip to next episode" },
    { id: "bbtv-random", label: "Random", desc: "Play something random" },
    { id: "bbtv-signout", label: "Sign Out", desc: "Sign out current child" },
  ];
  const specialQrs = await Promise.all(specialCodes.map(async (sc) => ({
    ...sc,
    svg: await generateSpecialQrSvg(sc.id),
    url: `http://localhost:${config.port}/play/${sc.id}`,
  })));

  return c.html(layout("Settings", `
    <h2 style="margin-bottom: 1.5rem;">Settings</h2>

    <div class="card">
      <h3>Daily Watch Time Limit</h3>
      <p style="color: #666; margin: 0.5rem 0;">
        Limit how much TV your child can watch per day. Leave empty for unlimited.
      </p>
      <div style="display: flex; align-items: center; gap: 1rem; margin: 1rem 0;">
        <input type="number" id="daily-limit" value="${dailyLimit ?? ""}" placeholder="No limit"
          min="0" max="1440" style="width: 100px; padding: 0.5rem; border: 1px solid #ddd; border-radius: 6px; font-size: 1rem;" />
        <span style="color: #666;">minutes per day</span>
        <button class="btn btn-primary" onclick="saveTimeLimit()">Save</button>
        <button class="btn btn-secondary" onclick="clearTimeLimit()">Remove Limit</button>
      </div>
      <p style="color: #666; font-size: 0.85rem;">
        Today: ${watchedToday} min watched${remainingMins !== null ? `, ${remainingMins} min remaining` : ""}
      </p>
    </div>

    <div class="card" style="margin-top: 1rem;">
      <h3>Special QR Codes</h3>
      <p style="color: #666; margin: 0.5rem 0;">Print these and add them to your QR code book for extra controls.</p>
      <div style="display: flex; gap: 2rem; margin: 1rem 0; flex-wrap: wrap;">
        ${specialQrs.map((sq) => `
          <div style="text-align: center; padding: 1rem; border: 1px solid #eee; border-radius: 8px;">
            <div style="width: 120px; margin: 0 auto;">${sq.svg}</div>
            <div style="font-weight: 600; margin-top: 0.5rem;">${escapeHtml(sq.label)}</div>
            <div style="font-size: 0.75rem; color: #888;">${escapeHtml(sq.desc)}</div>
          </div>
        `).join("")}
      </div>
    </div>

    <div class="card" style="margin-top: 1rem;">
      <h3>Media Directories</h3>
      <p style="color: #666; margin: 0.5rem 0;">Currently configured via <code>BBTV_MEDIA_DIRS</code> environment variable:</p>
      ${config.mediaDirs.length > 0
        ? `<ul style="margin: 0.5rem 0 0 1.5rem;">${config.mediaDirs.map((d) => `<li><code>${escapeHtml(d)}</code></li>`).join("")}</ul>`
        : `<p style="color: #c62828;">No directories configured. Set <code>BBTV_MEDIA_DIRS</code> and restart.</p>`
      }
    </div>
    <div class="card" style="margin-top: 1rem;">
      <h3>TMDB API Key</h3>
      <p style="color: #666; margin: 0.5rem 0;">Status: ${config.tmdbApiKey ? '<span style="color: green;">Configured</span>' : '<span style="color: #c62828;">Not set</span>. Set <code>TMDB_API_KEY</code> environment variable.'}</p>
    </div>
    <div class="card" style="margin-top: 1rem;">
      <h3>Server</h3>
      <p style="color: #666; margin: 0.5rem 0;">Port: <code>${config.port}</code></p>
      <p style="color: #666; margin: 0.5rem 0;">VLC Path: <code>${escapeHtml(config.vlcPath)}</code></p>
      <p style="color: #666; margin: 0.5rem 0;">Data Directory: <code>${escapeHtml(config.dataDir)}</code></p>
    </div>

    <script>
      async function saveTimeLimit() {
        var val = document.getElementById('daily-limit').value;
        var minutes = val ? parseInt(val, 10) : null;
        await fetch('/api/time-limit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ minutes: minutes })
        });
        showToast(minutes ? 'Limit set to ' + minutes + ' minutes' : 'Limit removed');
        setTimeout(function() { location.reload(); }, 1000);
      }
      async function clearTimeLimit() {
        await fetch('/api/time-limit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ minutes: null })
        });
        showToast('Limit removed');
        setTimeout(function() { location.reload(); }, 1000);
      }
    </script>
  `));
});

// --- Download ---

admin.get("/download", (c) => {
  return c.html(layout("Download", `
    <h2 style="margin-bottom: 1.5rem;">Download from YouTube</h2>

    <div class="card">
      <div style="display: flex; gap: 1rem; align-items: flex-end; flex-wrap: wrap;">
        <div style="flex: 1; min-width: 300px;">
          <label style="display: block; font-weight: 600; margin-bottom: 0.25rem;">YouTube URL</label>
          <input type="text" id="yt-url" placeholder="https://www.youtube.com/watch?v=..."
            style="width: 100%; padding: 0.5rem; border: 1px solid #ddd; border-radius: 6px; font-size: 1rem;" />
        </div>
        <div>
          <label style="display: block; font-weight: 600; margin-bottom: 0.25rem;">Save to</label>
          <select id="yt-category" style="padding: 0.5rem; border: 1px solid #ddd; border-radius: 6px; font-size: 1rem;">
            <option value="Music Videos">Music Videos</option>
            <option value="Movies">Movies</option>
            <option value="TV Shows">TV Shows</option>
          </select>
        </div>
        <button class="btn btn-secondary" onclick="fetchInfo()">Preview</button>
        <button class="btn btn-primary" onclick="startDownload()">Download</button>
      </div>
    </div>

    <div class="card" id="preview-card" style="display: none; margin-top: 1rem;">
      <div style="display: flex; gap: 1.5rem; align-items: start;">
        <img id="preview-thumb" src="" alt="" style="width: 200px; border-radius: 8px; display: none;" />
        <div style="flex: 1;">
          <h3 id="preview-title" style="margin-bottom: 0.25rem;"></h3>
          <p id="preview-uploader" style="color: #888; font-size: 0.85rem;"></p>
          <p id="preview-duration" style="color: #888; font-size: 0.85rem;"></p>
          <div style="margin-top: 0.75rem;">
            <label style="display: block; font-weight: 600; margin-bottom: 0.25rem;">Custom title (optional)</label>
            <input type="text" id="yt-title" placeholder="Leave empty to use YouTube title"
              style="width: 100%; padding: 0.5rem; border: 1px solid #ddd; border-radius: 6px; font-size: 0.9rem;" />
          </div>
        </div>
      </div>
    </div>

    <div class="card" id="progress-card" style="display: none; margin-top: 1rem;">
      <div style="display: flex; align-items: center; gap: 1rem;">
        <div style="flex: 1;">
          <div id="progress-text" style="font-weight: 600; margin-bottom: 0.5rem;">Downloading...</div>
          <div style="background: #eee; border-radius: 4px; height: 8px; overflow: hidden;">
            <div id="progress-bar" style="background: #e94560; height: 100%; width: 0%; transition: width 0.3s;"></div>
          </div>
        </div>
        <div id="progress-percent" style="font-weight: 700; color: #e94560; min-width: 50px; text-align: right;">0%</div>
      </div>
    </div>

    <script>
      async function fetchInfo() {
        var url = document.getElementById('yt-url').value.trim();
        if (!url) return showToast('Enter a YouTube URL');

        showToast('Fetching video info...');
        try {
          var res = await fetch('/api/youtube/info', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: url })
          });
          var data = await res.json();
          if (data.error) { showToast('Error: ' + data.error); return; }

          document.getElementById('preview-card').style.display = 'block';
          document.getElementById('preview-title').textContent = data.title;
          document.getElementById('preview-uploader').textContent = 'By: ' + data.uploader;
          var mins = Math.floor(data.duration / 60);
          var secs = data.duration % 60;
          document.getElementById('preview-duration').textContent = 'Duration: ' + mins + ':' + String(secs).padStart(2, '0');

          var thumb = document.getElementById('preview-thumb');
          if (data.thumbnail) {
            thumb.src = data.thumbnail;
            thumb.style.display = 'block';
          } else {
            thumb.style.display = 'none';
          }
        } catch (err) {
          showToast('Failed to fetch info');
        }
      }

      async function startDownload() {
        var url = document.getElementById('yt-url').value.trim();
        if (!url) return showToast('Enter a YouTube URL');

        var category = document.getElementById('yt-category').value;
        var title = document.getElementById('yt-title').value.trim() || null;

        var progressCard = document.getElementById('progress-card');
        var progressBar = document.getElementById('progress-bar');
        var progressText = document.getElementById('progress-text');
        var progressPercent = document.getElementById('progress-percent');
        progressCard.style.display = 'block';
        progressBar.style.width = '0%';
        progressText.textContent = 'Starting download...';
        progressPercent.textContent = '0%';

        try {
          var res = await fetch('/api/youtube/download', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: url, category: category, title: title })
          });

          var reader = res.body.getReader();
          var decoder = new TextDecoder();
          var buffer = '';

          while (true) {
            var result = await reader.read();
            if (result.done) break;

            buffer += decoder.decode(result.value, { stream: true });
            var lines = buffer.split('\\n');
            buffer = lines.pop() || '';

            for (var i = 0; i < lines.length; i++) {
              var line = lines[i].trim();
              if (!line.startsWith('data: ')) continue;
              try {
                var data = JSON.parse(line.slice(6));
                if (data.status === 'fetching_info') {
                  progressText.textContent = 'Fetching video info...';
                } else if (data.status === 'downloading') {
                  var pct = Math.round(data.percent || 0);
                  progressBar.style.width = pct + '%';
                  progressPercent.textContent = pct + '%';
                  progressText.textContent = 'Downloading: ' + (data.title || '');
                } else if (data.status === 'complete' || data.status === 'complete_and_scanned') {
                  progressBar.style.width = '100%';
                  progressPercent.textContent = '100%';
                  progressText.textContent = 'Download complete! Library updated.';
                  showToast('Download complete!');
                } else if (data.status === 'error') {
                  progressText.textContent = 'Error: ' + (data.error || 'Unknown error');
                  progressBar.style.background = '#ff4444';
                  showToast('Download failed');
                }
              } catch (e) {}
            }
          }
        } catch (err) {
          progressText.textContent = 'Download failed';
          showToast('Download failed: ' + err.message);
        }
      }
    </script>
  `));
});

export { admin };
