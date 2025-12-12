import "dotenv/config";
import express from "express";
import http from "http";
import path from "path";
import crypto from "crypto";
import { Server } from "socket.io";
import { 
  S3Client,
  ListObjectsV2Command,
  PutObjectCommand,
  DeleteObjectsCommand
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const AWS_REGION = process.env.AWS_REGION || "us-east-1";
const S3_BUCKET = process.env.S3_BUCKET;
const BASE_PREFIX = "photo-stream/";

if (!S3_BUCKET) {
  console.error("Missing env var S3_BUCKET");
  process.exit(1);
}

const s3 = new S3Client({ region: AWS_REGION });

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// --- API ---

app.get("/api/photos/:streamId", async (req, res) => {
  const { streamId } = req.params;
  if (!safeStreamId(streamId)) {
    return res.status(400).json({ error: "Invalid streamId" });
  }

  const Prefix = streamPrefix(streamId);

  try {
    const cmd = new ListObjectsV2Command({
      Bucket: S3_BUCKET,
      Prefix,
    });

    const out = await s3.send(cmd);

    const items = (out.Contents || [])
      .filter(o => o.Key && o.Key !== Prefix)
      .map(o => ({
        key: o.Key,
        filename: o.Key.replace(Prefix, ""),
        lastModified: o.LastModified ? o.LastModified.toISOString() : null,
        size: o.Size || 0,
      }))Z      .sort((a, b) => new Date(a.lastModified) - new Date(b.lastModified));

    res.json({ streamId, photos: items });
  } catch (err) {
    console.error("ListObjects error", err);
    res.status(500).json({ error: "Failed to list photos" });
  }
});

app.post("/api/presign", async (req, res) => {
  const { streamId, contentType } = req.body || {};

  if (!safeStreamId(streamId)) {
    return res.status(400).json({ error: "Invalid streamId" });
  }

  const ext = extensionFromContentType(contentType);
  const filename = makeRandomFilename(ext);
  const key = streamPrefix(streamId) + filename;

  try {
    const putCmd = new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      ContentType: contentType || "image/jpeg",
      // Demo caching posture: immutable objects
      CacheControl: "public, max-age=31536000, immutable",
    });

    const uploadUrl = await getSignedUrl(s3, putCmd, {
      expiresIn: 60 * 5, // 5 minutes
    });

    res.json({ uploadUrl, key, filename });
  } catch (err) {
    console.error("Presign error", err);
    res.status(500).json({ error: "Failed to presign upload" });
  }
});

app.post("/api/complete", (req, res) => {
  const { streamId, key, filename } = req.body || {};

  if (!safeStreamId(streamId) || typeof key !== "string") {
    return res.status(400).json({ error: "Invalid payload" });
  }

  // Broadcast to TVs listening on that stream room
  io.to(streamId).emit("photoAdded", {
    streamId,
    key,
    filename: filename || key.split("/").pop(),
    at: new Date().toISOString(),
  });

  res.json({ ok: true });
});

app.post("/api/clear/:streamId", async (req, res) => {
  const { streamId } = req.params;
  if (!safeStreamId(streamId)) return res.status(400).json({ error: "Invalid streamId" });

  const Prefix = streamPrefix(streamId);

  try {
    // List everything in the stream folder
    const listed = await s3.send(new ListObjectsV2Command({
      Bucket: S3_BUCKET,
      Prefix
    }));

    const keys = (listed.Contents || [])
      .map(o => o.Key)
      .filter(Boolean);

    if (!keys.length) return res.json({ ok: true, deleted: 0 });

    await s3.send(new DeleteObjectsCommand({
      Bucket: S3_BUCKET,
      Delete: {
        Objects: keys.map(Key => ({ Key })),
        Quiet: true
      }
    }));

    io.to(streamId).emit("streamCleared", { streamId, at: new Date().toISOString() });

    res.json({ ok: true, deleted: keys.length });
  } catch (err) {
    console.error("Clear stream error", err);
    res.status(500).json({ error: "Failed to clear stream" });
  }
});

// --- Socket.IO setup ---

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // demo
    methods: ["GET", "POST"],
  },
});

io.on("connection", (socket) => {
  socket.on("joinStream", ({ streamId }) => {
    if (!safeStreamId(streamId)) return;
    socket.join(streamId);
    socket.emit("joinedStream", { streamId });
  });

  socket.on("disconnect", () => {});
});

// --- Helpers ---

function safeStreamId(id) {
  return typeof id === "string" && /^[A-Z]{4}-[A-Z]{4}$/.test(id);
}

function extensionFromContentType(ct) {
  if (!ct) return "jpg";
  const lower = ct.toLowerCase();
  if (lower.includes("png")) return "png";
  if (lower.includes("webp")) return "webp";
  if (lower.includes("heic") || lower.includes("heif")) return "heic";
  return "jpg";
}

function makeRandomFilename(ext) {
  const rand = crypto.randomBytes(8).toString("hex");
  return `${Date.now()}-${rand}.${ext}`;
}

function streamPrefix(streamId) {
  return `${BASE_PREFIX}${streamId}/`;
}

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Photo stream demo server running on http://localhost:${PORT}`);
  console.log(`Using bucket: ${S3_BUCKET} in region: ${AWS_REGION}`);
});