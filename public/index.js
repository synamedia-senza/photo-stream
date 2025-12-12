const qrcodeImg = document.getElementById("qrcode");
const streamIdEl = document.getElementById("streamId");
const thumbsEl = document.getElementById("thumbs");
const mainImgEl = document.getElementById("mainImg");
const emptyStateEl = document.getElementById("emptyState");
const statusEl = document.getElementById("status");

const S3_BUCKET = "senza-developer";
const BASE_PREFIX = "photo-stream";
const POLL_MS = 15000;

let lastSignature = "";

function generateCode(text, size) {
  const data = encodeURIComponent(text);
  const src = `https://api.qrserver.com/v1/create-qr-code/?data=${data}&size=${size}x${size}`;
  qrcodeImg.src = src;
  qrcodeImg.width = size;
  qrcodeImg.height = size;
}

function randomLetters(n) {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let out = "";
  for (let i = 0; i < n; i++) {
    out += letters[Math.floor(Math.random() * letters.length)];
  }
  return out;
}

function generateStreamId() {
  return `${randomLetters(4)}-${randomLetters(4)}`;
}

function getOrCreateStreamId() {
  const key = "photoStreamId";
  let id = localStorage.getItem(key);
  if (!id) {
    id = generateStreamId();
    localStorage.setItem(key, id);
  }
  return id;
}

function s3UrlForKey(key) {
  // public bucket demo URL
  return `https://${S3_BUCKET}.s3.amazonaws.com/${key}`;
}

let streamId = getOrCreateStreamId();
let photos = [];
let activeIndex = -1;

function setStatus(msg) {
  statusEl.textContent = msg;
}

function render() {
  thumbsEl.innerHTML = "";

  if (!photos.length) {
    emptyStateEl.style.display = "block";
    mainImgEl.style.display = "none";
    activeIndex = -1;
    return;
  }

  emptyStateEl.style.display = "none";
  mainImgEl.style.display = "block";

  photos.forEach((p, idx) => {
    const img = document.createElement("img");
    img.src = s3UrlForKey(p.key);
    img.title = p.filename || p.key;
    if (idx === activeIndex) img.classList.add("active");
    img.onclick = () => {
      activeIndex = idx;
      showActive();
      renderThumbActive();
    };
    thumbsEl.appendChild(img);
  });

  // default to latest photo if nothing selected
  if (activeIndex < 0) activeIndex = photos.length - 1;
  showActive();
  renderThumbActive();

  // scroll thumbs so active is visible
  const activeThumb = thumbsEl.querySelector("img.active");
  if (activeThumb) activeThumb.scrollIntoView({ inline: "center", behavior: "smooth" });
}

function renderThumbActive() {
  [...thumbsEl.querySelectorAll("img")].forEach((el, i) => {
    el.classList.toggle("active", i === activeIndex);
  });
}

function showActive() {
  const p = photos[activeIndex];
  if (!p) return;
  const url = s3UrlForKey(p.key);
  mainImgEl.style.opacity = "0";
  setTimeout(() => {
    mainImgEl.src = url;
    mainImgEl.onload = () => { mainImgEl.style.opacity = "1"; };
    mainImgEl.onerror = () => { mainImgEl.style.opacity = "1"; };
  }, 120);
}

function signatureFor(list) {
  return list.map(p => p.key).join("|");
}

async function refreshPhotos() {
  try {
    const r = await fetch(`/api/photos/${streamId}`);
    const data = await r.json();
    if (!data.photos) throw new Error("Bad response");

    const newList = data.photos;
    const newSig = signatureFor(newList);

    if (newSig === lastSignature) {
      setStatus(`Stream ${streamId} • ${photos.length} photo(s)`);
      return;
    }

    lastSignature = newSig;

    const prevKeys = new Set(photos.map(p => p.key));
    const added = newList.filter(p => !prevKeys.has(p.key));

    photos = newList;

    if (added.length) {
      activeIndex = photos.length - 1; // jump to latest
    } else if (activeIndex >= photos.length) {
      activeIndex = photos.length - 1;
    }

    render();
    setStatus(`Stream ${streamId} • ${photos.length} photo(s)`);
  } catch (e) {
    console.error(e);
    setStatus("Error loading photos");
  }
}

function startPolling() {
  refreshPhotos();
  setInterval(refreshPhotos, POLL_MS);
}

function focusActiveThumb() {
  const activeThumb = thumbsEl.querySelector("img.active");
  if (activeThumb) {
    activeThumb.scrollIntoView({ inline: "center", behavior: "smooth", block: "nearest" });
  }
}

function setActiveIndex(nextIndex) {
  if (!photos.length) return;

  if (nextIndex < 0) nextIndex = photos.length - 1;
  if (nextIndex >= photos.length) nextIndex = 0;

  if (nextIndex === activeIndex) return;

  activeIndex = nextIndex;
  showActive();
  renderThumbActive();
  focusActiveThumb();
}

async function clearPhotos() {
  try {
    setStatus("Clearing photos…");
    const r = await fetch(`/api/clear/${streamId}`, { method: "POST" });
    if (!r.ok) throw new Error("Clear failed");

    photos = [];
    activeIndex = -1;
    lastSignature = ""; // so next refresh repaints
    render();

    setStatus(`Stream ${streamId} • 0 photo(s)`);
  } catch (e) {
    console.error(e);
    setStatus("Error clearing photos");
  }
}

function init() {
  streamIdEl.textContent = streamId;

  const phoneLink = `${location.origin}/phone.html?stream=${streamId}`;
  generateCode(phoneLink, 160);

  startPolling();

  document.addEventListener("keydown", async function (event) {
    switch (event.key) {
      case "Enter": break;
      case "Escape": await clearPhotos(); break;
      case "ArrowUp": break;
      case "ArrowDown": break;
      case "ArrowLeft": setActiveIndex(activeIndex - 1); break;
      case "ArrowRight": setActiveIndex(activeIndex + 1); break;
      default: return;
    }
    event.preventDefault();
  });

  try {
    const socket = io();
    socket.emit("joinStream", { streamId });
    socket.on("photoAdded", () => refreshPhotos());
  } catch (e) {
    console.warn("Socket init failed (ok for demo)", e);
  }
}

init();