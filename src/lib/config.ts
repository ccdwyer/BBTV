import { join } from "path";

const dataDir = process.env.BBTV_DATA_DIR || join(import.meta.dir, "../../data");

export const config = {
  port: parseInt(process.env.BBTV_PORT || "3456"),
  dataDir,
  dbPath: join(dataDir, "bbtv.db"),
  coverArtDir: join(dataDir, "covers"),
  mediaDirs: (process.env.BBTV_MEDIA_DIRS || "").split(":").filter(Boolean),
  tmdbApiKey: process.env.TMDB_API_KEY || "",
  vlcPath: process.platform === "darwin"
    ? "/Applications/VLC.app/Contents/MacOS/VLC"
    : "vlc",
};
