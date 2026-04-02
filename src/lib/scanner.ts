import { readdirSync, statSync } from "fs";
import { basename, extname, join, relative } from "path";
import { nanoid } from "nanoid";
import {
  upsertMediaItem,
  upsertEpisode,
  getEpisodes,
  deleteEpisodesForShow,
  getAllMediaItems,
  type MediaItem,
} from "./db";

const VIDEO_EXTENSIONS = new Set([
  ".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".webm", ".m4v", ".ts", ".mpg", ".mpeg",
]);

function isVideo(filename: string): boolean {
  return VIDEO_EXTENSIONS.has(extname(filename).toLowerCase());
}

interface ScanResult {
  added: number;
  updated: number;
  shows: number;
  episodes: number;
}

export function scanMediaDirectories(mediaDirs: string[]): ScanResult {
  const result: ScanResult = { added: 0, updated: 0, shows: 0, episodes: 0 };
  const existingItems = new Map(getAllMediaItems().map((m) => [m.folder_path ?? m.file_path, m]));

  for (const rootDir of mediaDirs) {
    const entries = safeReadDir(rootDir);
    for (const entry of entries) {
      const entryPath = join(rootDir, entry);
      if (!isDirectory(entryPath)) continue;

      const categoryName = entry.toLowerCase();
      if (categoryName.includes("tv") || categoryName.includes("show")) {
        scanTvShows(entryPath, existingItems, result);
      } else if (categoryName.includes("movie")) {
        scanMovies(entryPath, existingItems, result);
      } else if (categoryName.includes("music")) {
        scanMusicVideos(entryPath, existingItems, result);
      }
    }
  }

  return result;
}

function scanTvShows(
  tvDir: string,
  existing: Map<string | null, MediaItem>,
  result: ScanResult
) {
  for (const showName of safeReadDir(tvDir)) {
    const showPath = join(tvDir, showName);
    if (!isDirectory(showPath)) continue;

    const showId = existing.get(showPath)?.id ?? nanoid(10);
    const isNew = !existing.has(showPath);

    upsertMediaItem({
      id: showId,
      media_type: "tv_show",
      title: showName,
      folder_path: showPath,
      file_path: null,
      tmdb_id: null,
      tmdb_type: null,
      overview: null,
      poster_path: null,
      backdrop_path: null,
      year: null,
    });

    if (isNew) result.added++;
    else result.updated++;
    result.shows++;

    // Clear existing episodes and rescan
    deleteEpisodesForShow(showId);
    scanEpisodes(showPath, showId, result);
  }
}

function scanEpisodes(showPath: string, showId: string, result: ScanResult) {
  const entries = safeReadDir(showPath);

  // Check if there are season directories
  const seasonDirs = entries.filter((e) => {
    const lower = e.toLowerCase();
    return isDirectory(join(showPath, e)) && /^season\s*\d+$/i.test(lower);
  });

  if (seasonDirs.length > 0) {
    // Has season directories
    for (const seasonDir of seasonDirs) {
      const seasonNum = parseSeasonNumber(seasonDir);
      const seasonPath = join(showPath, seasonDir);
      for (const file of safeReadDir(seasonPath)) {
        if (!isVideo(file)) continue;
        const parsed = parseEpisodeFilename(file);
        const epId = nanoid(10);
        upsertEpisode({
          id: epId,
          show_id: showId,
          season_number: seasonNum,
          episode_number: parsed.episode,
          title: parsed.title,
          file_path: join(seasonPath, file),
          tmdb_episode_id: null,
          overview: null,
          still_path: null,
        });
        result.episodes++;
      }
    }
  } else {
    // Flat episode files (no seasons)
    const videoFiles = entries.filter(isVideo).sort();
    for (let i = 0; i < videoFiles.length; i++) {
      const file = videoFiles[i]!;
      const parsed = parseEpisodeFilename(file);
      const epId = nanoid(10);
      upsertEpisode({
        id: epId,
        show_id: showId,
        season_number: null,
        episode_number: parsed.episode || i + 1,
        title: parsed.title,
        file_path: join(showPath, file),
        tmdb_episode_id: null,
        overview: null,
        still_path: null,
      });
      result.episodes++;
    }
  }
}

function scanMovies(
  moviesDir: string,
  existing: Map<string | null, MediaItem>,
  result: ScanResult
) {
  for (const entry of safeReadDir(moviesDir)) {
    const entryPath = join(moviesDir, entry);

    if (isDirectory(entryPath)) {
      // Movie in its own folder — find the video file inside
      const videoFile = safeReadDir(entryPath).find(isVideo);
      if (!videoFile) continue;
      const filePath = join(entryPath, videoFile);
      const movieId = existing.get(entryPath)?.id ?? nanoid(10);
      const parsed = parseMovieTitle(entry);

      upsertMediaItem({
        id: movieId,
        media_type: "movie",
        title: parsed.title,
        folder_path: entryPath,
        file_path: filePath,
        tmdb_id: null,
        tmdb_type: null,
        overview: null,
        poster_path: null,
        backdrop_path: null,
        year: parsed.year,
      });

      if (!existing.has(entryPath)) result.added++;
      else result.updated++;
    } else if (isVideo(entry)) {
      // Movie as a standalone file
      const parsed = parseMovieTitle(basename(entry, extname(entry)));
      const movieId = existing.get(entryPath)?.id ?? nanoid(10);

      upsertMediaItem({
        id: movieId,
        media_type: "movie",
        title: parsed.title,
        folder_path: null,
        file_path: entryPath,
        tmdb_id: null,
        tmdb_type: null,
        overview: null,
        poster_path: null,
        backdrop_path: null,
        year: parsed.year,
      });

      if (!existing.has(entryPath)) result.added++;
      else result.updated++;
    }
  }
}

function scanMusicVideos(
  musicDir: string,
  existing: Map<string | null, MediaItem>,
  result: ScanResult
) {
  for (const file of safeReadDir(musicDir)) {
    const filePath = join(musicDir, file);
    if (!isVideo(file)) continue;

    const title = basename(file, extname(file));
    const mvId = existing.get(filePath)?.id ?? nanoid(10);

    upsertMediaItem({
      id: mvId,
      media_type: "music_video",
      title,
      folder_path: null,
      file_path: filePath,
      tmdb_id: null,
      tmdb_type: null,
      overview: null,
      poster_path: null,
      backdrop_path: null,
      year: null,
    });

    if (!existing.has(filePath)) result.added++;
    else result.updated++;
  }
}

// --- Filename Parsing ---

export function parseEpisodeFilename(filename: string): { episode: number; title: string | null } {
  const nameWithoutExt = basename(filename, extname(filename));

  // Match patterns like "S01E05", "s01e05", "1x05"
  const sxeMatch = nameWithoutExt.match(/[Ss](\d+)[Ee](\d+)\s*[-–—]?\s*(.*)/);
  if (sxeMatch) {
    return {
      episode: parseInt(sxeMatch[2]!, 10),
      title: sxeMatch[3]?.trim() || null,
    };
  }

  // Match "Episode 05 - Title" or "Ep 05 - Title" or "E05 - Title"
  const epMatch = nameWithoutExt.match(/(?:Episode|Ep\.?|E)\s*(\d+)\s*[-–—]\s*(.*)/i);
  if (epMatch) {
    return {
      episode: parseInt(epMatch[1]!, 10),
      title: epMatch[2]?.trim() || null,
    };
  }

  // Match leading number: "05 - Title" or "05. Title"
  const numMatch = nameWithoutExt.match(/^(\d+)\s*[-–—.]\s*(.*)/);
  if (numMatch) {
    return {
      episode: parseInt(numMatch[1]!, 10),
      title: numMatch[2]?.trim() || null,
    };
  }

  // Fallback — try to extract any number
  const anyNum = nameWithoutExt.match(/(\d+)/);
  return {
    episode: anyNum ? parseInt(anyNum[1]!, 10) : 0,
    title: nameWithoutExt.trim(),
  };
}

export function parseSeasonNumber(dirName: string): number {
  const match = dirName.match(/(\d+)/);
  return match ? parseInt(match[1]!, 10) : 1;
}

export function parseMovieTitle(name: string): { title: string; year: number | null } {
  // Match "Movie Name (2023)" or "Movie Name [2023]"
  const yearMatch = name.match(/^(.+?)\s*[(\[]((?:19|20)\d{2})[)\]]/);
  if (yearMatch) {
    return { title: yearMatch[1]!.trim(), year: parseInt(yearMatch[2]!, 10) };
  }
  return { title: name.trim(), year: null };
}

// --- Helpers ---

function safeReadDir(dir: string): string[] {
  try {
    return readdirSync(dir).filter((e) => !e.startsWith("."));
  } catch {
    return [];
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
