const streamIdEl = document.getElementById("streamId");
const fileInput = document.getElementById("fileInput");
const pickBtn = document.getElementById("pickBtn");
const previewEl = document.getElementById("preview");
const statusEl = document.getElementById("status");
const recentCard = document.getElementById("recentCard");
const tinyGallery = document.getElementById("tinyGallery");

pickBtn.addEventListener("click", (e) => {
  e.preventDefault();
  fileInput.click();
});

function parseStreamId() {
  // 1) query param ?stream=ABCD-EFGH
  const params = new URLSearchParams(location.search);
  let id = params.get("stream");

  // 2) if someone hits /ABCD-EFGH directly, use that path segment
  if (!id) {
    const m = location.pathname.match(/([A-Za-z]{4}-[A-Za-z]{4})/);
    if (m) id = m[1];
  }

  // normalize to uppercase
  if (id) id = id.toUpperCase();
  return id;
}

const streamId = parseStreamId();
if (!streamId) {
  streamIdEl.textContent = "No stream ID in URL.";
  statusEl.innerHTML = `Make sure you opened the link from the TV.`;
  pickBtn.disabled = true;
} else {
  streamIdEl.textContent = `Stream: ${streamId}`;
}

function setStatus(msg) {
  statusEl.textContent = msg;
}

function showPreview(file) {
  const url = URL.createObjectURL(file);
  previewEl.src = url;
  previewEl.style.display = "block";
}

async function presignUpload(file) {
  const r = await fetch("/api/presign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      streamId,
      contentType: file.type || "image/jpeg"
    })
  });
  if (!r.ok) throw new Error("Presign failed");
  return r.json();
}

async function putToS3(uploadUrl, file) {
  const r = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": file.type || "image/jpeg"
    },
    body: file
  });
  if (!r.ok) throw new Error("S3 PUT failed");
}

async function completeUpload({ key, filename }) {
  const r = await fetch("/api/complete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ streamId, key, filename })
  });
  if (!r.ok) throw new Error("Complete failed");
}

function addToRecent(url) {
  recentCard.style.display = "block";
  const img = document.createElement("img");
  img.src = url;
  tinyGallery.prepend(img);
}

fileInput.addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;

  showPreview(file);
  pickBtn.disabled = true;

  try {
    setStatus("Preparing upload…");
    const { uploadUrl, key, filename } = await presignUpload(file);

    setStatus("Uploading to S3…");
    await putToS3(uploadUrl, file);

    setStatus("Finalizing…");
    await completeUpload({ key, filename });

    setStatus("✅ Uploaded! Check your TV.");
    addToRecent(URL.createObjectURL(file));
  } catch (err) {
    console.error(err);
    setStatus("❌ Upload failed. Try again.");
  } finally {
    pickBtn.disabled = false;
    fileInput.value = "";
  }
});