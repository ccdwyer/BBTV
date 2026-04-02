# BBTV — Design Document

**Date:** 2026-04-01
**Status:** Approved

## Overview

BBTV is a local media player for kids, controlled by scanning QR codes from a printed book. A USB barcode scanner reads QR codes that map to local media files, launching VLC in fullscreen. A web admin UI manages the library and generates printable QR code book pages with cover art.

**Target platforms:** macOS, Linux (Omarchy)

## System Architecture

### Components

1. **Bun/TypeScript server** — manages media library, serves web UI, tracks watch progress, generates QR codes, fetches TMDB metadata
2. **Idle screen** — fullscreen kiosk browser page on the TV, captures scanner input, communicates with server via WebSocket
3. **VLC** — launched via subprocess in fullscreen mode for playback
4. **Admin web UI** — browse library, fetch metadata, manage cover art, generate/print QR code book pages
5. **SQLite database** — media index, TMDB metadata, cover art paths, QR mappings, per-show watch progress

### Flow

1. Kid scans QR code from printed book
2. USB HID scanner "types" `http://localhost:3000/play/<id>` + Enter into kiosk browser
3. Browser page intercepts the URL, sends request to server via WebSocket
4. Server resolves ID to file path (or next episode for shows), launches `vlc --fullscreen --play-and-exit <file>`
5. VLC plays fullscreen. When it exits, server notifies idle screen via WebSocket, idle screen returns to waiting state.

## Media Library

### Directory scanning

Configurable root media directories scanned recursively. Supported structures:

- `TV Shows/<Show Name>/Season XX/<episode files>`
- `TV Shows/<Show Name>/<episode files>` (seasonless)
- `Movies/<Movie Name>/<file>` or `Movies/<file>`
- `Music Videos/<file>`

File names parsed for episode numbers and titles (e.g., "Episode 05 - Blue goes to the zoo.mp4").

Rescan triggered manually from admin UI or on startup.

### TMDB integration

- Unmatched shows/movies queued for TMDB lookup after scan
- TV shows: match name, fetch series metadata, season info, episode titles, poster/backdrop art
- Movies: match title (optionally year), fetch metadata and poster art
- Cover art downloaded and cached locally
- Manual correction via admin UI (search TMDB, pick correct result)
- Requires free TMDB API key (v3 API)

### Watch progress

- Per-show: tracks last episode played (season + episode number)
- "Next episode" advances linearly, wraps to episode 1 after finale
- No per-episode resume position (kids usually watch the whole thing)

## QR Codes & Printable Book

### QR code generation

- Each media item and each show gets a unique short ID in the database
- Shows get two types: show-level code (plays next episode) and optionally per-episode codes
- QR codes encode `http://<server>:3000/play/<id>`
- Generated as SVGs for crisp printing at any size

### Printable book pages

- Admin UI "Print Book" section organized by category (TV Shows, Movies, Music Videos)
- Grid layout: cover art + QR code + title per item
- TV Shows: one entry per show with poster art
- Movies: one entry per movie with poster art
- Customizable item selection and ordering
- Print-friendly CSS layout (Ctrl+P)
- Designed to look like a picture book: big cover art, QR code, large title

## Idle Screen

- Served at `/idle`, opened in Chrome/Chromium kiosk mode: `--kiosk --app=http://localhost:3000/idle`
- Dark background, friendly message: "Scan a code to watch!"
- Hidden text input stays focused to capture scanner HID keyboard input
- URL pattern detected and sent to server via WebSocket
- Shows cover art during "Loading..." state while VLC launches
- Returns to idle when server signals VLC has exited

## Playback

- VLC spawned as subprocess: `vlc --fullscreen --play-and-exit <filepath>`
- macOS: `/Applications/VLC.app/Contents/MacOS/VLC`
- Linux: `vlc` from PATH
- Process monitored; exit triggers idle screen return
- Scanning new code while playing kills current VLC and launches new one

## Admin Web UI

Accessed at `http://<server>:3000/admin` from any device on local network. No authentication (local network only).

### Pages

- **Dashboard** — library stats, recent watch history
- **Library** — browse by category, view/edit metadata, TMDB match, cover art, QR preview
- **Scan Library** — trigger rescan, view unmatched items, bulk TMDB matching
- **Settings** — media directories, server port, VLC path
- **Print Book** — QR code book generator

## Tech Stack

- **Runtime:** Bun
- **Server:** Hono
- **Database:** SQLite via `bun:sqlite`
- **TMDB:** direct v3 API calls
- **QR generation:** `qrcode` npm package (SVG output)
- **Admin frontend:** Preact
- **Idle screen:** plain HTML/CSS/JS
- **VLC control:** Bun subprocess API
- **WebSocket:** Hono built-in

## Project Structure

```
bbtv/
├── src/
│   ├── server/          # Hono routes, websocket handlers
│   ├── lib/
│   │   ├── scanner.ts   # Media directory scanning & parsing
│   │   ├── tmdb.ts      # TMDB API client
│   │   ├── vlc.ts       # VLC subprocess management
│   │   ├── qrcode.ts    # QR code generation
│   │   └── db.ts        # SQLite schema & queries
│   ├── frontend/
│   │   ├── admin/       # Preact admin UI
│   │   └── idle/        # Idle screen (plain HTML/CSS/JS)
│   └── index.ts         # Entry point
├── data/                # SQLite DB, cached cover art
├── package.json
├── tsconfig.json
└── bunfig.toml
```

## Startup

- `bbtv start` launches server and opens kiosk browser
- Can be configured for auto-start via systemd (Linux) or launchd (macOS)
