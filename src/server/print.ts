import { Hono } from "hono";
import {
  getAllMediaItems,
  getMediaItemsByType,
  type MediaItem,
  type MediaType,
} from "../lib/db";
import { getOrCreateQrId, generateQrSvg } from "../lib/qrcode";

const print = new Hono();

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

print.get("/", async (c) => {
  const filter = c.req.query("type") as MediaType | undefined;
  const items = filter ? getMediaItemsByType(filter) : getAllMediaItems();

  const cards = await Promise.all(items.map(async (item) => {
    const qrId = getOrCreateQrId(item.id, "item");
    const qrSvg = await generateQrSvg(qrId);
    const poster = item.poster_path
      ? `<img src="/covers/${encodeURIComponent(item.poster_path)}" alt="${escapeHtml(item.title)}" />`
      : `<div class="placeholder">${escapeHtml(item.title.charAt(0))}</div>`;

    return `
      <div class="book-card">
        <div class="poster">${poster}</div>
        <div class="qr">${qrSvg}</div>
        <div class="title">${escapeHtml(item.title)}</div>
      </div>
    `;
  }));

  // Group by type for section headers
  const tvShows = items.filter((i) => i.media_type === "tv_show");
  const movies = items.filter((i) => i.media_type === "movie");
  const musicVideos = items.filter((i) => i.media_type === "music_video");

  async function renderSection(sectionTitle: string, sectionItems: MediaItem[]): Promise<string> {
    if (sectionItems.length === 0) return "";
    const sectionCards = await Promise.all(sectionItems.map(async (item) => {
      const qrId = getOrCreateQrId(item.id, "item");
      const qrSvg = await generateQrSvg(qrId);
      const poster = item.poster_path
        ? `<img src="/covers/${encodeURIComponent(item.poster_path)}" alt="${escapeHtml(item.title)}" />`
        : `<div class="placeholder">${escapeHtml(item.title.charAt(0))}</div>`;
      return `
        <div class="book-card">
          <div class="poster">${poster}</div>
          <div class="qr">${qrSvg}</div>
          <div class="title">${escapeHtml(item.title)}</div>
        </div>
      `;
    }));
    return `
      <div class="section">
        <h2 class="section-header">${escapeHtml(sectionTitle)}</h2>
        <div class="book-grid">${sectionCards.join("")}</div>
      </div>
    `;
  }

  const sections = filter
    ? `<div class="book-grid">${cards.join("")}</div>`
    : (await renderSection("TV Shows", tvShows)) +
      (await renderSection("Movies", movies)) +
      (await renderSection("Music Videos", musicVideos));

  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>BBTV - Print Book</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: white;
      color: #333;
    }

    /* Screen-only controls */
    .controls {
      background: #1a1a2e;
      color: white;
      padding: 1rem 2rem;
      display: flex;
      align-items: center;
      gap: 1.5rem;
    }
    .controls h1 { color: #e94560; font-size: 1.5rem; }
    .controls a { color: #a0a0c0; text-decoration: none; }
    .controls a:hover { color: white; }
    .controls .btn { padding: 0.5rem 1rem; border-radius: 6px; border: none; cursor: pointer; font-weight: 500; }
    .controls .btn-print { background: #e94560; color: white; font-size: 1rem; }
    .filter-tabs { display: flex; gap: 0.5rem; }
    .filter-tab { padding: 0.3rem 0.8rem; border-radius: 20px; border: 1px solid #555; background: transparent; color: #a0a0c0; cursor: pointer; font-size: 0.85rem; text-decoration: none; }
    .filter-tab.active { background: #e94560; color: white; border-color: #e94560; }

    /* Book layout */
    .container { max-width: 900px; margin: 2rem auto; padding: 0 1rem; }

    .section-header {
      font-size: 1.8rem;
      text-align: center;
      padding: 1rem 0;
      margin: 1rem 0;
      border-bottom: 2px solid #e94560;
      color: #1a1a2e;
    }

    .book-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 2rem;
      padding: 1rem 0;
    }

    .book-card {
      text-align: center;
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .book-card .poster {
      width: 100%;
      aspect-ratio: 2/3;
      overflow: hidden;
      border-radius: 8px;
      margin-bottom: 0.5rem;
    }

    .book-card .poster img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }

    .book-card .poster .placeholder {
      width: 100%;
      height: 100%;
      background: #e8e8e8;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 3rem;
      color: #999;
      border-radius: 8px;
    }

    .book-card .qr {
      margin: 0.5rem auto;
      width: 100px;
    }

    .book-card .qr svg {
      width: 100%;
      height: auto;
    }

    .book-card .title {
      font-size: 1rem;
      font-weight: 600;
      margin-top: 0.25rem;
    }

    /* Print styles */
    @media print {
      .controls { display: none !important; }
      body { background: white; }
      .container { margin: 0; max-width: none; padding: 0.5cm; }

      .section {
        page-break-before: always;
      }
      .section:first-child {
        page-break-before: auto;
      }

      .book-grid {
        gap: 1.5rem;
      }

      .book-card .poster {
        border: 1px solid #ddd;
      }

      .book-card .title {
        font-size: 0.9rem;
      }
    }
  </style>
</head>
<body>
  <div class="controls">
    <h1>BBTV</h1>
    <a href="/admin">Back to Admin</a>
    <div class="filter-tabs">
      <a href="/admin/print" class="filter-tab ${!filter ? "active" : ""}">All</a>
      <a href="/admin/print?type=tv_show" class="filter-tab ${filter === "tv_show" ? "active" : ""}">TV Shows</a>
      <a href="/admin/print?type=movie" class="filter-tab ${filter === "movie" ? "active" : ""}">Movies</a>
      <a href="/admin/print?type=music_video" class="filter-tab ${filter === "music_video" ? "active" : ""}">Music Videos</a>
    </div>
    <button class="btn btn-print" onclick="window.print()">Print Book</button>
  </div>
  <div class="container">
    ${sections}
  </div>
</body>
</html>`);
});

export { print };
