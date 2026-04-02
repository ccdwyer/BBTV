import { join } from "path";
import { mkdirSync, existsSync } from "fs";
import { config } from "./config";

export interface VideoInfo {
  title: string;
  thumbnail: string | null;
  duration: number;
  uploader: string;
}

export interface DownloadProgress {
  status: "fetching_info" | "downloading" | "complete" | "error";
  title?: string;
  thumbnail?: string | null;
  percent?: number;
  error?: string;
  filePath?: string;
}

type ProgressCallback = (progress: DownloadProgress) => void;

function ytDlpPath(): string {
  return process.env.YTDLP_PATH || "yt-dlp";
}

export async function fetchVideoInfo(url: string): Promise<VideoInfo> {
  const proc = Bun.spawn([
    ytDlpPath(),
    "--dump-json",
    "--no-playlist",
    url,
  ], { stdio: ["ignore", "pipe", "pipe"] });

  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`yt-dlp failed: ${stderr.trim()}`);
  }

  const info = JSON.parse(stdout);
  return {
    title: info.title || "Unknown",
    thumbnail: info.thumbnail || null,
    duration: info.duration || 0,
    uploader: info.uploader || info.channel || "Unknown",
  };
}

export async function downloadVideo(
  url: string,
  category: string,
  customTitle: string | null,
  onProgress: ProgressCallback,
): Promise<string> {
  // Determine output directory
  const mediaDir = config.mediaDirs[0];
  if (!mediaDir) throw new Error("No media directory configured");

  const outputDir = join(mediaDir, category);
  mkdirSync(outputDir, { recursive: true });

  // First fetch info for the title
  onProgress({ status: "fetching_info" });

  let info: VideoInfo;
  try {
    info = await fetchVideoInfo(url);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    onProgress({ status: "error", error: msg });
    throw err;
  }

  const title = customTitle || info.title;
  onProgress({
    status: "downloading",
    title,
    thumbnail: info.thumbnail,
    percent: 0,
  });

  // Sanitize filename
  const safeTitle = title.replace(/[/\\?%*:|"<>]/g, "").replace(/\s+/g, " ").trim();
  const outputTemplate = join(outputDir, `${safeTitle}.%(ext)s`);

  const proc = Bun.spawn([
    ytDlpPath(),
    "--no-playlist",
    "--merge-output-format", "mp4",
    "-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
    "--newline",
    "--progress",
    "-o", outputTemplate,
    url,
  ], { stdio: ["ignore", "pipe", "pipe"] });

  // Parse progress from stdout
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const percentMatch = line.match(/(\d+\.?\d*)%/);
      if (percentMatch) {
        onProgress({
          status: "downloading",
          title,
          thumbnail: info.thumbnail,
          percent: parseFloat(percentMatch[1]!),
        });
      }
    }
  }

  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    const error = `Download failed: ${stderr.trim()}`;
    onProgress({ status: "error", error });
    throw new Error(error);
  }

  // Find the output file
  const expectedPath = join(outputDir, `${safeTitle}.mp4`);
  const filePath = existsSync(expectedPath) ? expectedPath : expectedPath;

  onProgress({
    status: "complete",
    title,
    filePath,
  });

  return filePath;
}
