#!/usr/bin/env bun
import { serve } from "bun";
import { app, websocket } from "./server/app";
import { getDb } from "./lib/db";
import { scanMediaDirectories } from "./lib/scanner";
import { matchAllUnmatched } from "./lib/tmdb";
import { config } from "./lib/config";

const command = process.argv[2];

switch (command) {
  case "start":
    await startServer();
    break;
  case "scan":
    await runScan();
    break;
  case "match":
    await runMatch();
    break;
  default:
    console.log(`BBTV - QR Code Media Player for Kids

Usage:
  bbtv start          Start the server and open the idle screen in kiosk mode
  bbtv scan           Scan media directories and update the library
  bbtv match          Fetch TMDB metadata for unmatched media

Environment:
  BBTV_PORT           Server port (default: 3456)
  BBTV_MEDIA_DIRS     Colon-separated media directories
  BBTV_DATA_DIR       Data directory for DB and covers
  TMDB_API_KEY        TMDB API key for metadata fetching
`);
}

async function startServer() {
  getDb();

  const port = config.port;
  console.log(`BBTV starting on http://localhost:${port}`);

  serve({
    fetch: app.fetch,
    port,
    websocket,
  });

  console.log(`BBTV ready at http://localhost:${port}`);
  console.log(`Idle screen: http://localhost:${port}/idle`);
  console.log(`Admin UI: http://localhost:${port}/admin`);

  // Auto-scan on startup if media dirs are configured
  if (config.mediaDirs.length > 0) {
    console.log(`Scanning media directories: ${config.mediaDirs.join(", ")}`);
    const result = scanMediaDirectories(config.mediaDirs);
    console.log(`Scan complete: ${result.added} added, ${result.updated} updated, ${result.shows} shows, ${result.episodes} episodes`);
  }

  // Open kiosk browser
  await openKiosk(port);
}

async function openKiosk(port: number) {
  const url = `http://localhost:${port}/idle`;

  const platform = process.platform;
  let browserArgs: string[];

  if (platform === "darwin") {
    // macOS: try Chrome first, fall back to Chromium
    browserArgs = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "--kiosk",
      `--app=${url}`,
      "--disable-infobars",
      "--disable-session-crashed-bubble",
      "--noerrdialogs",
    ];

    // Check if Chrome exists, fallback to Chromium
    const chromeExists = await Bun.file(browserArgs[0]!).exists();
    if (!chromeExists) {
      browserArgs[0] = "/Applications/Chromium.app/Contents/MacOS/Chromium";
    }
  } else {
    // Linux: try chromium, then google-chrome, then chromium-browser
    const browsers = ["chromium", "google-chrome", "chromium-browser"];
    let found = "chromium";
    for (const b of browsers) {
      try {
        const result = Bun.spawnSync(["which", b]);
        if (result.exitCode === 0) {
          found = b;
          break;
        }
      } catch {
        continue;
      }
    }
    browserArgs = [
      found,
      "--kiosk",
      `--app=${url}`,
      "--disable-infobars",
      "--disable-session-crashed-bubble",
      "--noerrdialogs",
    ];
  }

  console.log(`Opening kiosk browser: ${browserArgs[0]}`);

  Bun.spawn(browserArgs, {
    stdio: ["ignore", "ignore", "ignore"],
  });
}

async function runScan() {
  getDb();
  if (config.mediaDirs.length === 0) {
    console.error("No media directories configured. Set BBTV_MEDIA_DIRS environment variable.");
    process.exit(1);
  }

  console.log(`Scanning: ${config.mediaDirs.join(", ")}`);
  const result = scanMediaDirectories(config.mediaDirs);
  console.log(`Done: ${result.added} added, ${result.updated} updated, ${result.shows} shows, ${result.episodes} episodes`);
}

async function runMatch() {
  getDb();
  if (!config.tmdbApiKey) {
    console.error("TMDB_API_KEY not set. Get a free key at https://www.themoviedb.org/settings/api");
    process.exit(1);
  }

  console.log("Matching unmatched media with TMDB...");
  const result = await matchAllUnmatched();
  console.log(`Done: ${result.matched} matched, ${result.failed} failed`);
}
