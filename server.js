// server.js
// Demo photo-stream server: presigned uploads to S3 + TV polling + optional socket push.

import "dotenv/config";
import express from "express";
import http from "http";
import path from "path";
import crypto from "crypto";
import { Server } from "socket.io";
import { S3Client, ListObjectsV2Command, PutObjectCommand} from "@aws-sdk/client-s3";
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
app.use(express.json({ limit: "1mb" })); // presign payload is tiny

// Serve static files (TV + phone clients)
app.use(express.static(path.join(__dirname, "public")));

// --- Helpers ---
function safeStreamId(id) {
  // Demo-safe: allow ABCD-EFGH style only
  return typeof id === "string" && /^[A-Z]{4}-[A-Z]{4}$/.test(id);
}

function extensionFromContentType(ct) {
  if (!ct) return "jpg";
  const lower = ct.toLowerCase();
  if (lower.includes("png")) return "png";
  if (lower.includes("webp")) return "webp";
  if (lower.includes("heic") || lower.includes("heif")) return "heic";
  return "jpg"; // default for jpeg and unknowns
}

function makeRandomFilename(ext) {
  const rand = crypto.randomBytes(8).toString("hex");
  return `${Date.now()}-${rand}.${ext}`;
}

function streamPrefix(streamId) {
  return `${BASE_PREFIX}${streamId}/`;
}

// --- API ---
//
// 1) List photos for a stream
// GET /api/photos/:streamId
//
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
      .filter(o => o.Key && o.Key !== Prefix) // remove folder placeholder if any
      .map(o => ({
        key: o.Key,
        filename: o.Key.replace(Prefix, ""),
        lastModified: o.LastModified ? o.LastModified.toISOString() : null,
        size: o.Size || 0,
        // TV can build URL using same origin proxy endpoint or direct bucket URL
      }))
      // newest last (or reverse for newest first)
      .sort((a, b) => new Date(a.lastModified) - new Date(b.lastModified));

    res.json({ streamId, photos: items });
  } catch (err) {
    console.error("ListObjects error", err);
    res.status(500).json({ error: "Failed to list photos" });
  }
});

//
// 2) Presign upload
// POST /api/presign
// body: { streamId, contentType }
//
// Returns: { uploadUrl, key, filename }
//
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

//
// 3) Complete upload (nice-to-have)
// POST /api/complete
// body: { streamId, key, filename }
//
// Emits socket event to room streamId.
//
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

// --- Optional: simple proxy to serve images via same origin ---
// If you want the TV to use same-origin URLs instead of public bucket URLs,
// you can add a signed GET proxy later. For now, demo assumes bucket is public
// or CloudFront is configured.

// --- Socket.IO setup ---
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // demo
    methods: ["GET", "POST"],
  },
});

io.on("connection", (socket) => {
  // TV should emit: socket.emit("joinStream", { streamId })
  socket.on("joinStream", ({ streamId }) => {
    if (!safeStreamId(streamId)) return;
    socket.join(streamId);
    socket.emit("joinedStream", { streamId });
  });

  socket.on("disconnect", () => {
    // no-op
  });
});

// --- Start ---
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Photo stream demo server running on http://localhost:${PORT}`);
  console.log(`Using bucket: ${S3_BUCKET} in region: ${AWS_REGION}`);
});