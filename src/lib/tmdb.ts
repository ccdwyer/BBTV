import { mkdirSync } from "fs";
import { join } from "path";
import { config } from "./config";
import {
  getMediaItem,
  upsertMediaItem,
  getEpisodes,
  upsertEpisode,
  type MediaItem,
} from "./db";

const TMDB_BASE = "https://api.themoviedb.org/3";
const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p";

interface TmdbSearchResult {
  id: number;
  name?: string;
  title?: string;
  overview: string;
  poster_path: string | null;
  backdrop_path: string | null;
  first_air_date?: string;
  release_date?: string;
}

interface TmdbEpisode {
  id: number;
  episode_number: number;
  season_number: number;
  name: string;
  overview: string;
  still_path: string | null;
}

interface TmdbSeason {
  season_number: number;
  episodes: TmdbEpisode[];
}

async function tmdbFetch<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  if (!config.tmdbApiKey) throw new Error("TMDB_API_KEY not set");

  const url = new URL(`${TMDB_BASE}${path}`);
  url.searchParams.set("api_key", config.tmdbApiKey);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`TMDB API error: ${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

export async function searchTvShow(query: string): Promise<TmdbSearchResult[]> {
  const data = await tmdbFetch<{ results: TmdbSearchResult[] }>("/search/tv", { query });
  return data.results;
}

export async function searchMovie(query: string, year?: number): Promise<TmdbSearchResult[]> {
  const params: Record<string, string> = { query };
  if (year) params.year = String(year);
  const data = await tmdbFetch<{ results: TmdbSearchResult[] }>("/search/movie", params);
  return data.results;
}

async function downloadImage(tmdbPath: string, localFilename: string, size = "w500"): Promise<string> {
  mkdirSync(config.coverArtDir, { recursive: true });
  const url = `${TMDB_IMAGE_BASE}/${size}${tmdbPath}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download image: ${url}`);

  const localPath = join(config.coverArtDir, localFilename);
  await Bun.write(localPath, res);
  return localFilename;
}

export async function matchAndFetchTvShow(mediaId: string): Promise<boolean> {
  const item = getMediaItem(mediaId);
  if (!item || item.media_type !== "tv_show") return false;

  const results = await searchTvShow(item.title);
  if (results.length === 0) return false;

  const best = results[0]!;
  const yearMatch = best.first_air_date?.match(/^(\d{4})/);

  let posterLocal: string | null = null;
  let backdropLocal: string | null = null;

  if (best.poster_path) {
    posterLocal = await downloadImage(best.poster_path, `${mediaId}_poster.jpg`);
  }
  if (best.backdrop_path) {
    backdropLocal = await downloadImage(best.backdrop_path, `${mediaId}_backdrop.jpg`, "w1280");
  }

  upsertMediaItem({
    ...item,
    tmdb_id: best.id,
    tmdb_type: "tv",
    overview: best.overview || item.overview,
    poster_path: posterLocal,
    backdrop_path: backdropLocal,
    year: yearMatch ? parseInt(yearMatch[1]!, 10) : item.year,
  });

  // Fetch episode metadata
  await fetchEpisodeMetadata(mediaId, best.id);

  return true;
}

export async function matchAndFetchMovie(mediaId: string): Promise<boolean> {
  const item = getMediaItem(mediaId);
  if (!item || item.media_type !== "movie") return false;

  const results = await searchMovie(item.title, item.year ?? undefined);
  if (results.length === 0) return false;

  const best = results[0]!;
  const yearMatch = best.release_date?.match(/^(\d{4})/);

  let posterLocal: string | null = null;
  let backdropLocal: string | null = null;

  if (best.poster_path) {
    posterLocal = await downloadImage(best.poster_path, `${mediaId}_poster.jpg`);
  }
  if (best.backdrop_path) {
    backdropLocal = await downloadImage(best.backdrop_path, `${mediaId}_backdrop.jpg`, "w1280");
  }

  upsertMediaItem({
    ...item,
    tmdb_id: best.id,
    tmdb_type: "movie",
    overview: best.overview || item.overview,
    title: best.title || item.title,
    poster_path: posterLocal,
    backdrop_path: backdropLocal,
    year: yearMatch ? parseInt(yearMatch[1]!, 10) : item.year,
  });

  return true;
}

async function fetchEpisodeMetadata(mediaId: string, tmdbShowId: number): Promise<void> {
  const episodes = getEpisodes(mediaId);
  if (episodes.length === 0) return;

  // Get unique season numbers
  const seasonNums = [...new Set(episodes.map((e) => e.season_number ?? 1))];

  for (const seasonNum of seasonNums) {
    try {
      const season = await tmdbFetch<TmdbSeason>(`/tv/${tmdbShowId}/season/${seasonNum}`);

      for (const tmdbEp of season.episodes) {
        // Find matching local episode
        const localEp = episodes.find(
          (e) => (e.season_number ?? 1) === tmdbEp.season_number && e.episode_number === tmdbEp.episode_number
        );
        if (!localEp) continue;

        let stillLocal: string | null = null;
        if (tmdbEp.still_path) {
          stillLocal = await downloadImage(
            tmdbEp.still_path,
            `${localEp.id}_still.jpg`,
            "w300"
          );
        }

        upsertEpisode({
          ...localEp,
          title: tmdbEp.name || localEp.title,
          tmdb_episode_id: tmdbEp.id,
          overview: tmdbEp.overview || localEp.overview,
          still_path: stillLocal,
        });
      }
    } catch (err) {
      console.error(`[TMDB] Failed to fetch season ${seasonNum} for show ${tmdbShowId}:`, err);
    }
  }
}

export async function manualMatch(mediaId: string, tmdbId: number, type: "tv" | "movie"): Promise<boolean> {
  const item = getMediaItem(mediaId);
  if (!item) return false;

  if (type === "tv") {
    const data = await tmdbFetch<TmdbSearchResult>(`/tv/${tmdbId}`);
    const yearMatch = data.first_air_date?.match(/^(\d{4})/);

    let posterLocal: string | null = null;
    let backdropLocal: string | null = null;
    if (data.poster_path) posterLocal = await downloadImage(data.poster_path, `${mediaId}_poster.jpg`);
    if (data.backdrop_path) backdropLocal = await downloadImage(data.backdrop_path, `${mediaId}_backdrop.jpg`, "w1280");

    upsertMediaItem({
      ...item,
      tmdb_id: tmdbId,
      tmdb_type: "tv",
      overview: data.overview || item.overview,
      poster_path: posterLocal,
      backdrop_path: backdropLocal,
      year: yearMatch ? parseInt(yearMatch[1]!, 10) : item.year,
    });

    await fetchEpisodeMetadata(mediaId, tmdbId);
  } else {
    const data = await tmdbFetch<TmdbSearchResult>(`/movie/${tmdbId}`);
    const yearMatch = data.release_date?.match(/^(\d{4})/);

    let posterLocal: string | null = null;
    let backdropLocal: string | null = null;
    if (data.poster_path) posterLocal = await downloadImage(data.poster_path, `${mediaId}_poster.jpg`);
    if (data.backdrop_path) backdropLocal = await downloadImage(data.backdrop_path, `${mediaId}_backdrop.jpg`, "w1280");

    upsertMediaItem({
      ...item,
      tmdb_id: tmdbId,
      tmdb_type: "movie",
      overview: data.overview || item.overview,
      title: data.title || item.title,
      poster_path: posterLocal,
      backdrop_path: backdropLocal,
      year: yearMatch ? parseInt(yearMatch[1]!, 10) : item.year,
    });
  }

  return true;
}

export async function matchMediaItem(mediaId: string): Promise<boolean> {
  const item = getMediaItem(mediaId);
  if (!item) return false;

  switch (item.media_type) {
    case "tv_show":
      return matchAndFetchTvShow(mediaId);
    case "movie":
      return matchAndFetchMovie(mediaId);
    default:
      return false;
  }
}

export async function matchAllUnmatched(): Promise<{ matched: number; failed: number }> {
  const { getAllMediaItems } = await import("./db");
  const items = getAllMediaItems().filter((m) => !m.tmdb_id && m.media_type !== "music_video");

  let matched = 0;
  let failed = 0;

  for (const item of items) {
    try {
      const success = await matchMediaItem(item.id);
      if (success) matched++;
      else failed++;
    } catch (err) {
      console.error(`[TMDB] Failed to match ${item.title}:`, err);
      failed++;
    }
    // Rate limit: TMDB allows ~40 requests per 10 seconds
    await new Promise((r) => setTimeout(r, 250));
  }

  return { matched, failed };
}
