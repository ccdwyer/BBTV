import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { config } from "./config";

let _db: Database | null = null;

export function getDb(): Database {
  if (_db) return _db;

  mkdirSync(dirname(config.dbPath), { recursive: true });
  _db = new Database(config.dbPath);
  _db.exec("PRAGMA journal_mode = WAL");
  _db.exec("PRAGMA foreign_keys = ON");
  migrate(_db);
  return _db;
}

/** Prefix object keys with $ for bun:sqlite named parameter binding */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function $(obj: Record<string, unknown>): any {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    result[`$${k}`] = v;
  }
  return result;
}

function migrate(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS media_items (
      id TEXT PRIMARY KEY,
      media_type TEXT NOT NULL CHECK(media_type IN ('movie', 'tv_show', 'music_video')),
      title TEXT NOT NULL,
      folder_path TEXT,
      file_path TEXT,
      tmdb_id INTEGER,
      tmdb_type TEXT,
      overview TEXT,
      poster_path TEXT,
      backdrop_path TEXT,
      year INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS episodes (
      id TEXT PRIMARY KEY,
      show_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
      season_number INTEGER,
      episode_number INTEGER NOT NULL,
      title TEXT,
      file_path TEXT NOT NULL,
      tmdb_episode_id INTEGER,
      overview TEXT,
      still_path TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(show_id, season_number, episode_number)
    );

    CREATE TABLE IF NOT EXISTS qr_codes (
      id TEXT PRIMARY KEY,
      media_id TEXT NOT NULL,
      qr_type TEXT NOT NULL CHECK(qr_type IN ('item', 'episode')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(media_id, qr_type)
    );

    CREATE TABLE IF NOT EXISTS watch_progress (
      show_id TEXT PRIMARY KEY REFERENCES media_items(id) ON DELETE CASCADE,
      last_season INTEGER,
      last_episode INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS playback_positions (
      file_path TEXT PRIMARY KEY,
      position_seconds REAL NOT NULL DEFAULT 0,
      duration_seconds REAL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS watch_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      child_id TEXT,
      media_id TEXT,
      duration_seconds REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS children (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      avatar_color TEXT NOT NULL DEFAULT '#e94560',
      qr_code_id TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS child_schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      child_id TEXT NOT NULL REFERENCES children(id) ON DELETE CASCADE,
      day_of_week INTEGER NOT NULL CHECK(day_of_week BETWEEN 0 AND 6),
      allotment_minutes INTEGER NOT NULL DEFAULT 30,
      max_minutes INTEGER NOT NULL DEFAULT 60,
      UNIQUE(child_id, day_of_week)
    );

    CREATE TABLE IF NOT EXISTS bonus_time (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      child_id TEXT NOT NULL REFERENCES children(id) ON DELETE CASCADE,
      minutes INTEGER NOT NULL,
      reason TEXT NOT NULL,
      spent_minutes INTEGER NOT NULL DEFAULT 0,
      granted_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_episodes_show ON episodes(show_id, season_number, episode_number);
    CREATE INDEX IF NOT EXISTS idx_qr_media ON qr_codes(media_id);
    CREATE INDEX IF NOT EXISTS idx_watch_log_date ON watch_log(date);
    CREATE INDEX IF NOT EXISTS idx_watch_log_child ON watch_log(child_id, date);
    CREATE INDEX IF NOT EXISTS idx_bonus_time_child ON bonus_time(child_id);
  `);
}

// --- Media Items ---

export type MediaType = "movie" | "tv_show" | "music_video";

export interface MediaItem {
  id: string;
  media_type: MediaType;
  title: string;
  folder_path: string | null;
  file_path: string | null;
  tmdb_id: number | null;
  tmdb_type: string | null;
  overview: string | null;
  poster_path: string | null;
  backdrop_path: string | null;
  year: number | null;
  created_at: string;
  updated_at: string;
}

export interface Episode {
  id: string;
  show_id: string;
  season_number: number | null;
  episode_number: number;
  title: string | null;
  file_path: string;
  tmdb_episode_id: number | null;
  overview: string | null;
  still_path: string | null;
  created_at: string;
}

export type QrType = "item" | "episode";

export interface QrCode {
  id: string;
  media_id: string;
  qr_type: QrType;
  created_at: string;
}

export interface WatchProgress {
  show_id: string;
  last_season: number | null;
  last_episode: number;
  updated_at: string;
}

export function getAllMediaItems(): MediaItem[] {
  return getDb().query("SELECT * FROM media_items ORDER BY media_type, title").all() as MediaItem[];
}

export function getMediaItemsByType(mediaType: MediaType): MediaItem[] {
  return getDb().query("SELECT * FROM media_items WHERE media_type = ? ORDER BY title").all(mediaType) as MediaItem[];
}

export function getMediaItem(id: string): MediaItem | null {
  return getDb().query("SELECT * FROM media_items WHERE id = ?").get(id) as MediaItem | null;
}

export function upsertMediaItem(item: Omit<MediaItem, "created_at" | "updated_at">): void {
  getDb().query(`
    INSERT INTO media_items (id, media_type, title, folder_path, file_path, tmdb_id, tmdb_type, overview, poster_path, backdrop_path, year)
    VALUES ($id, $media_type, $title, $folder_path, $file_path, $tmdb_id, $tmdb_type, $overview, $poster_path, $backdrop_path, $year)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      folder_path = excluded.folder_path,
      file_path = excluded.file_path,
      tmdb_id = excluded.tmdb_id,
      tmdb_type = excluded.tmdb_type,
      overview = excluded.overview,
      poster_path = excluded.poster_path,
      backdrop_path = excluded.backdrop_path,
      year = excluded.year,
      updated_at = datetime('now')
  `).run($(item as unknown as Record<string, unknown>));
}

export function deleteMediaItem(id: string): void {
  getDb().query("DELETE FROM media_items WHERE id = ?").run(id);
}

// --- Episodes ---

export function getEpisodes(showId: string): Episode[] {
  return getDb().query(
    "SELECT * FROM episodes WHERE show_id = ? ORDER BY season_number, episode_number"
  ).all(showId) as Episode[];
}

export function getEpisode(id: string): Episode | null {
  return getDb().query("SELECT * FROM episodes WHERE id = ?").get(id) as Episode | null;
}

export function upsertEpisode(ep: Omit<Episode, "created_at">): void {
  getDb().query(`
    INSERT INTO episodes (id, show_id, season_number, episode_number, title, file_path, tmdb_episode_id, overview, still_path)
    VALUES ($id, $show_id, $season_number, $episode_number, $title, $file_path, $tmdb_episode_id, $overview, $still_path)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      file_path = excluded.file_path,
      tmdb_episode_id = excluded.tmdb_episode_id,
      overview = excluded.overview,
      still_path = excluded.still_path
  `).run($(ep as unknown as Record<string, unknown>));
}

export function deleteEpisodesForShow(showId: string): void {
  getDb().query("DELETE FROM episodes WHERE show_id = ?").run(showId);
}

// --- QR Codes ---

export function getQrCode(id: string): QrCode | null {
  return getDb().query("SELECT * FROM qr_codes WHERE id = ?").get(id) as QrCode | null;
}

export function getQrCodeForMedia(mediaId: string, qrType: QrType): QrCode | null {
  return getDb().query(
    "SELECT * FROM qr_codes WHERE media_id = ? AND qr_type = ?"
  ).get(mediaId, qrType) as QrCode | null;
}

export function upsertQrCode(qr: Omit<QrCode, "created_at">): void {
  getDb().query(`
    INSERT INTO qr_codes (id, media_id, qr_type)
    VALUES ($id, $media_id, $qr_type)
    ON CONFLICT(media_id, qr_type) DO UPDATE SET id = excluded.id
  `).run($(qr as unknown as Record<string, unknown>));
}

// --- Watch Progress ---

export function getWatchProgress(showId: string): WatchProgress | null {
  return getDb().query("SELECT * FROM watch_progress WHERE show_id = ?").get(showId) as WatchProgress | null;
}

export function setWatchProgress(showId: string, season: number | null, episode: number): void {
  getDb().query(`
    INSERT INTO watch_progress (show_id, last_season, last_episode)
    VALUES (?, ?, ?)
    ON CONFLICT(show_id) DO UPDATE SET
      last_season = excluded.last_season,
      last_episode = excluded.last_episode,
      updated_at = datetime('now')
  `).run(showId, season, episode);
}

// --- Settings ---

export function getSetting(key: string): string | null {
  const row = getDb().query("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | null;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  getDb().query(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

// --- Playback Positions (Resume) ---

export interface PlaybackPosition {
  file_path: string;
  position_seconds: number;
  duration_seconds: number | null;
  updated_at: string;
}

export function getPlaybackPosition(filePath: string): PlaybackPosition | null {
  return getDb().query(
    "SELECT * FROM playback_positions WHERE file_path = ?"
  ).get(filePath) as PlaybackPosition | null;
}

export function setPlaybackPosition(filePath: string, position: number, duration: number | null): void {
  getDb().query(`
    INSERT INTO playback_positions (file_path, position_seconds, duration_seconds)
    VALUES (?, ?, ?)
    ON CONFLICT(file_path) DO UPDATE SET
      position_seconds = excluded.position_seconds,
      duration_seconds = excluded.duration_seconds,
      updated_at = datetime('now')
  `).run(filePath, position, duration);
}

export function clearPlaybackPosition(filePath: string): void {
  getDb().query("DELETE FROM playback_positions WHERE file_path = ?").run(filePath);
}

// --- Watch Log ---

export function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export function todayDayOfWeek(): number {
  return new Date().getDay(); // 0=Sunday, 6=Saturday
}

export function logWatchTime(childId: string | null, mediaId: string | null, durationSeconds: number): void {
  getDb().query(`
    INSERT INTO watch_log (date, child_id, media_id, duration_seconds) VALUES (?, ?, ?, ?)
  `).run(todayDate(), childId, mediaId, durationSeconds);
}

export function getChildTodayWatchSeconds(childId: string): number {
  const row = getDb().query(
    "SELECT COALESCE(SUM(duration_seconds), 0) as total FROM watch_log WHERE child_id = ? AND date = ?"
  ).get(childId, todayDate()) as { total: number };
  return row.total;
}

export function getTodayWatchSeconds(): number {
  const row = getDb().query(
    "SELECT COALESCE(SUM(duration_seconds), 0) as total FROM watch_log WHERE date = ?"
  ).get(todayDate()) as { total: number };
  return row.total;
}

// --- Legacy global daily limit (still used if no children configured) ---

export function getDailyLimitMinutes(): number | null {
  const val = getSetting("daily_limit_minutes");
  return val ? parseInt(val, 10) : null;
}

export function setDailyLimitMinutes(minutes: number | null): void {
  if (minutes === null) {
    getDb().query("DELETE FROM settings WHERE key = 'daily_limit_minutes'").run();
  } else {
    setSetting("daily_limit_minutes", String(minutes));
  }
}

export function getRemainingWatchSeconds(): number | null {
  const limit = getDailyLimitMinutes();
  if (limit === null) return null;
  const watched = getTodayWatchSeconds();
  return Math.max(0, limit * 60 - watched);
}

// --- Children ---

export interface Child {
  id: string;
  name: string;
  avatar_color: string;
  qr_code_id: string;
  created_at: string;
}

export function getAllChildren(): Child[] {
  return getDb().query("SELECT * FROM children ORDER BY name").all() as Child[];
}

export function getChild(id: string): Child | null {
  return getDb().query("SELECT * FROM children WHERE id = ?").get(id) as Child | null;
}

export function getChildByQrCode(qrCodeId: string): Child | null {
  return getDb().query("SELECT * FROM children WHERE qr_code_id = ?").get(qrCodeId) as Child | null;
}

export function createChild(child: Omit<Child, "created_at">): void {
  getDb().query(`
    INSERT INTO children (id, name, avatar_color, qr_code_id) VALUES (?, ?, ?, ?)
  `).run(child.id, child.name, child.avatar_color, child.qr_code_id);
}

export function updateChild(id: string, name: string, avatarColor: string): void {
  getDb().query("UPDATE children SET name = ?, avatar_color = ? WHERE id = ?").run(name, avatarColor, id);
}

export function deleteChild(id: string): void {
  getDb().query("DELETE FROM children WHERE id = ?").run(id);
}

// --- Child Schedules ---

export interface ChildSchedule {
  id: number;
  child_id: string;
  day_of_week: number; // 0=Sunday, 6=Saturday
  allotment_minutes: number;
  max_minutes: number;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function getDayName(day: number): string {
  return DAY_NAMES[day] || "Unknown";
}

export function getChildSchedules(childId: string): ChildSchedule[] {
  return getDb().query(
    "SELECT * FROM child_schedules WHERE child_id = ? ORDER BY day_of_week"
  ).all(childId) as ChildSchedule[];
}

export function getChildTodaySchedule(childId: string): ChildSchedule | null {
  return getDb().query(
    "SELECT * FROM child_schedules WHERE child_id = ? AND day_of_week = ?"
  ).get(childId, todayDayOfWeek()) as ChildSchedule | null;
}

export function setChildSchedule(childId: string, dayOfWeek: number, allotmentMinutes: number, maxMinutes: number): void {
  getDb().query(`
    INSERT INTO child_schedules (child_id, day_of_week, allotment_minutes, max_minutes)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(child_id, day_of_week) DO UPDATE SET
      allotment_minutes = excluded.allotment_minutes,
      max_minutes = excluded.max_minutes
  `).run(childId, dayOfWeek, allotmentMinutes, maxMinutes);
}

export function setChildScheduleBulk(childId: string, weekday: { allotment: number; max: number }, weekend: { allotment: number; max: number }): void {
  for (let day = 0; day <= 6; day++) {
    const isWeekend = day === 0 || day === 6;
    const s = isWeekend ? weekend : weekday;
    setChildSchedule(childId, day, s.allotment, s.max);
  }
}

// --- Bonus Time ---

export interface BonusTime {
  id: number;
  child_id: string;
  minutes: number;
  reason: string;
  spent_minutes: number;
  granted_at: string;
}

export function getChildBonusTime(childId: string): BonusTime[] {
  return getDb().query(
    "SELECT * FROM bonus_time WHERE child_id = ? ORDER BY granted_at DESC"
  ).all(childId) as BonusTime[];
}

export function getChildAvailableBonusMinutes(childId: string): number {
  const row = getDb().query(
    "SELECT COALESCE(SUM(minutes - spent_minutes), 0) as total FROM bonus_time WHERE child_id = ? AND minutes > spent_minutes"
  ).get(childId) as { total: number };
  return row.total;
}

export function grantBonusTime(childId: string, minutes: number, reason: string): void {
  getDb().query(`
    INSERT INTO bonus_time (child_id, minutes, reason) VALUES (?, ?, ?)
  `).run(childId, minutes, reason);
}

export function spendBonusMinutes(childId: string, minutesToSpend: number): void {
  // Spend from oldest bonus grants first (FIFO)
  const grants = getDb().query(
    "SELECT * FROM bonus_time WHERE child_id = ? AND minutes > spent_minutes ORDER BY granted_at ASC"
  ).all(childId) as BonusTime[];

  let remaining = minutesToSpend;
  for (const grant of grants) {
    if (remaining <= 0) break;
    const available = grant.minutes - grant.spent_minutes;
    const spend = Math.min(available, remaining);
    getDb().query("UPDATE bonus_time SET spent_minutes = spent_minutes + ? WHERE id = ?").run(spend, grant.id);
    remaining -= spend;
  }
}

// --- Child Time Calculation ---

export interface ChildTimeStatus {
  childId: string;
  childName: string;
  todayAllotmentMinutes: number;
  todayMaxMinutes: number;
  watchedTodaySeconds: number;
  availableBonusMinutes: number;
  remainingSeconds: number;
  canWatch: boolean;
}

export function getChildTimeStatus(childId: string): ChildTimeStatus | null {
  const child = getChild(childId);
  if (!child) return null;

  const schedule = getChildTodaySchedule(childId);
  const allotment = schedule?.allotment_minutes ?? 30; // default 30 min
  const max = schedule?.max_minutes ?? 60; // default 60 min

  const watchedSeconds = getChildTodayWatchSeconds(childId);
  const watchedMinutes = watchedSeconds / 60;
  const bonusAvailable = getChildAvailableBonusMinutes(childId);

  // Total available = allotment + bonus, capped at max
  const totalAvailableMinutes = Math.min(allotment + bonusAvailable, max);
  const remainingSeconds = Math.max(0, (totalAvailableMinutes - watchedMinutes) * 60);

  return {
    childId,
    childName: child.name,
    todayAllotmentMinutes: allotment,
    todayMaxMinutes: max,
    watchedTodaySeconds: watchedSeconds,
    availableBonusMinutes: bonusAvailable,
    remainingSeconds,
    canWatch: remainingSeconds > 0,
  };
}

/**
 * After a child watches N seconds, figure out how many of those came from
 * bonus vs allotment, and spend bonus accordingly.
 */
export function accountWatchTime(childId: string, watchedSeconds: number): void {
  const schedule = getChildTodaySchedule(childId);
  const allotment = schedule?.allotment_minutes ?? 30;

  const totalWatchedToday = getChildTodayWatchSeconds(childId);
  const totalWatchedMinutes = totalWatchedToday / 60;

  // If total watched exceeds allotment, the excess came from bonus
  if (totalWatchedMinutes > allotment) {
    const bonusUsedMinutes = totalWatchedMinutes - allotment;
    const previousBonusSpent = getDb().query(
      "SELECT COALESCE(SUM(spent_minutes), 0) as total FROM bonus_time WHERE child_id = ?"
    ).get(childId) as { total: number };

    const needToSpend = bonusUsedMinutes - previousBonusSpent.total;
    if (needToSpend > 0) {
      spendBonusMinutes(childId, Math.ceil(needToSpend));
    }
  }
}

// --- Random Media ---

export function getRandomMediaItem(): MediaItem | null {
  return getDb().query(
    "SELECT * FROM media_items ORDER BY RANDOM() LIMIT 1"
  ).get() as MediaItem | null;
}

// --- Child Watch History ---

export interface WatchLogEntry {
  id: number;
  date: string;
  child_id: string | null;
  media_id: string | null;
  duration_seconds: number;
  created_at: string;
}

export function getChildWatchHistory(childId: string, limit = 50): WatchLogEntry[] {
  return getDb().query(
    "SELECT * FROM watch_log WHERE child_id = ? ORDER BY created_at DESC LIMIT ?"
  ).all(childId, limit) as WatchLogEntry[];
}
