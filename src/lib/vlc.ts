import { config } from "./config";
import {
  getPlaybackPosition,
  setPlaybackPosition,
  clearPlaybackPosition,
  logWatchTime,
  accountWatchTime,
} from "./db";

const VLC_HTTP_PORT = 9090;
const VLC_HTTP_PASSWORD = "bbtv";

let currentProcess: ReturnType<typeof Bun.spawn> | null = null;
let currentFilePath: string | null = null;
let currentMediaId: string | null = null;
let currentChildId: string | null = null;
let playbackStartTime: number | null = null;
let positionPollInterval: ReturnType<typeof setInterval> | null = null;
let onExitCallback: (() => void) | null = null;

export function onPlaybackEnd(cb: () => void) {
  onExitCallback = cb;
}

export function isPlaying(): boolean {
  return currentProcess !== null;
}

export function getCurrentFilePath(): string | null {
  return currentFilePath;
}

export interface PlayResult {
  ok: boolean;
  error?: string;
  timeLimitReached?: boolean;
  remainingSeconds?: number;
}

export async function play(filePath: string, mediaId: string | null = null, childId: string | null = null): Promise<PlayResult> {
  // Kill any existing playback (saves position first)
  await stop();

  // Check for resume position
  const savedPosition = getPlaybackPosition(filePath);
  const startTime = savedPosition?.position_seconds ?? 0;

  const vlcArgs = [
    config.vlcPath,
    "--fullscreen",
    "--play-and-exit",
    "--no-video-title-show",
    // Enable HTTP interface for position tracking
    "--extraintf", "http",
    "--http-port", String(VLC_HTTP_PORT),
    "--http-password", VLC_HTTP_PASSWORD,
    filePath,
  ];

  // Add start time for resume
  if (startTime > 5) {
    vlcArgs.splice(vlcArgs.length - 1, 0, "--start-time", String(Math.max(0, startTime - 3)));
  }

  console.log(`[VLC] Playing: ${filePath}${startTime > 5 ? ` (resuming from ${Math.round(startTime)}s)` : ""}${childId ? ` [child: ${childId}]` : ""}`);

  currentFilePath = filePath;
  currentMediaId = mediaId;
  currentChildId = childId;
  playbackStartTime = Date.now();

  currentProcess = Bun.spawn(vlcArgs, {
    stdio: ["ignore", "ignore", "ignore"],
  });

  // Start polling for position
  startPositionPolling();

  // Monitor the process for exit
  currentProcess.exited.then(async () => {
    console.log("[VLC] Playback ended");

    // Save final position and log watch time
    await saveCurrentPosition();
    logWatchDuration();

    stopPositionPolling();
    currentProcess = null;
    currentFilePath = null;
    currentMediaId = null;
    currentChildId = null;
    playbackStartTime = null;
    onExitCallback?.();
  });

  return { ok: true };
}

export async function stop(): Promise<void> {
  if (currentProcess) {
    console.log("[VLC] Stopping current playback");
    await saveCurrentPosition();
    logWatchDuration();
    stopPositionPolling();
    currentProcess.kill();
    await currentProcess.exited;
    currentProcess = null;
    currentFilePath = null;
    currentMediaId = null;
    currentChildId = null;
    playbackStartTime = null;
  }
}

export async function next(): Promise<void> {
  if (currentProcess) {
    if (currentFilePath) clearPlaybackPosition(currentFilePath);
    logWatchDuration();
    stopPositionPolling();
    currentProcess.kill();
    await currentProcess.exited;
    currentProcess = null;
    currentFilePath = null;
    currentMediaId = null;
    currentChildId = null;
    playbackStartTime = null;
  }
}

// --- VLC HTTP Interface ---

interface VlcStatus {
  time: number;     // current position in seconds
  length: number;   // total duration in seconds
  state: string;    // "playing", "paused", "stopped"
}

const vlcAuth = { Authorization: "Basic " + btoa(`:${VLC_HTTP_PASSWORD}`) };

async function getVlcStatus(): Promise<VlcStatus | null> {
  try {
    const res = await fetch(`http://localhost:${VLC_HTTP_PORT}/requests/status.json`, {
      headers: vlcAuth,
      signal: AbortSignal.timeout(1000),
    });
    if (!res.ok) return null;
    const data = await res.json() as VlcStatus;
    return data;
  } catch {
    return null;
  }
}

async function sendVlcCommand(command: string, val?: string): Promise<boolean> {
  try {
    const url = val
      ? `http://localhost:${VLC_HTTP_PORT}/requests/status.json?command=${command}&val=${val}`
      : `http://localhost:${VLC_HTTP_PORT}/requests/status.json?command=${command}`;
    const res = await fetch(url, {
      headers: vlcAuth,
      signal: AbortSignal.timeout(1000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function pause(): Promise<boolean> {
  if (!currentProcess) return false;
  console.log("[VLC] Toggling pause");
  return sendVlcCommand("pl_pause");
}

export async function isPaused(): Promise<boolean> {
  const status = await getVlcStatus();
  return status?.state === "paused";
}

export async function resume(): Promise<boolean> {
  if (!currentProcess) return false;
  const status = await getVlcStatus();
  if (status?.state === "paused") {
    console.log("[VLC] Resuming");
    return sendVlcCommand("pl_pause"); // pl_pause toggles
  }
  return true; // already playing
}

// --- Position Tracking ---

let lastKnownPosition = 0;
let lastKnownDuration = 0;

function startPositionPolling() {
  lastKnownPosition = 0;
  lastKnownDuration = 0;
  positionPollInterval = setInterval(async () => {
    const status = await getVlcStatus();
    if (status && status.time > 0) {
      lastKnownPosition = status.time;
      lastKnownDuration = status.length;
    }
  }, 5000); // Poll every 5 seconds
}

function stopPositionPolling() {
  if (positionPollInterval) {
    clearInterval(positionPollInterval);
    positionPollInterval = null;
  }
}

async function saveCurrentPosition(): Promise<void> {
  if (!currentFilePath) return;

  // Try to get final position from VLC
  const status = await getVlcStatus();
  const position = status?.time ?? lastKnownPosition;
  const duration = status?.length ?? lastKnownDuration;

  if (position <= 0) return;

  // If within 5% of the end or less than 60s remaining, consider it "finished"
  if (duration > 0 && (position >= duration * 0.95 || duration - position < 60)) {
    console.log(`[VLC] Playback completed (${Math.round(position)}/${Math.round(duration)}s), clearing position`);
    clearPlaybackPosition(currentFilePath);
  } else {
    console.log(`[VLC] Saving position: ${Math.round(position)}/${Math.round(duration)}s for ${currentFilePath}`);
    setPlaybackPosition(currentFilePath, position, duration);
  }
}

function logWatchDuration(): void {
  if (!playbackStartTime) return;
  const durationSeconds = (Date.now() - playbackStartTime) / 1000;
  if (durationSeconds > 5) {
    logWatchTime(currentChildId, currentMediaId, durationSeconds);
    if (currentChildId) {
      accountWatchTime(currentChildId, durationSeconds);
    }
    console.log(`[VLC] Logged ${Math.round(durationSeconds)}s of watch time${currentChildId ? ` for child ${currentChildId}` : ""}`);
  }
}
