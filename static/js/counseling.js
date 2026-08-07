/* オンライン整体カウンセリングシート */

const SESSION_ID = document.body.dataset.sessionId;
let sessionData = null;   // サーバーから取得したセッション
let photos = [];          // 写真一覧
let maxPhotoId = 0;
let pollTimer = null;

function showToast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2500);
}

async function api(url, opts) {
  const res = await fetch(url, opts);
  if (res.status === 401) { location.href = "/admin/login"; throw new Error("unauthorized"); }
  const j = await res.json();
  if (!res.ok) throw new Error(j.error || "エラーが発生しました");
  return j;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ── チップ選択 ───────────────────────────────────────
function initChips(groupId, single) {
  const group = document.getElementById(groupId);
  group.querySelectorAll(".chip").forEach((chip) => {
    chip.addEventListener("click", (e) => {
      e.preventDefault();
      if (single) {
        group.querySelectorAll(".chip").forEach((c) => c.classList.toggle("selected", c === chip));
      } else {
        chip.classList.toggle("selected");
      }
    });
  });
}
initChips("posture-findings", false);
initChips("an-facing", true);

function chipValues(id) {
  return [...document.querySelectorAll("#" + id + " .chip.selected")].map((c) => c.dataset.v);
}
function setChips(id, values) {
  const set = new Set(values || []);
  document.querySelectorAll("#" + id + " .chip").forEach((c) =>
    c.classList.toggle("selected", set.has(c.dataset.v)));
}

// ── ボディマップ ─────────────────────────────────────
const selectedAreas = new Set();

function switchBody(side) {
  document.getElementById("bm-front").classList.toggle("hidden", side !== "front");
  document.getElementById("bm-back").classList.toggle("hidden", side !== "back");
  document.getElementById("bm-front-btn").classList.toggle("active", side === "front");
  document.getElementById("bm-back-btn").classList.toggle("active", side === "back");
}

document.querySelectorAll(".bm-spots circle").forEach((spot) => {
  spot.addEventListener("click", () => {
    const area = spot.dataset.area;
    if (selectedAreas.has(area)) selectedAreas.delete(area);
    else selectedAreas.add(area);
    syncBodymap();
  });
});

function syncBodymap() {
  document.querySelectorAll(".bm-spots circle").forEach((spot) =>
    spot.classList.toggle("selected", selectedAreas.has(spot.dataset.area)));
  const box = document.getElementById("bm-selected");
  box.innerHTML = selectedAreas.size
    ? [...selectedAreas].map((a) => `<span class="bm-tag">${esc(a)}</span>`).join("")
    : '<span style="font-size:12px;color:var(--muted)">タップした部位がここに表示されます</span>';
}

// ── NRS ──────────────────────────────────────────────
[["nrs-now", "nrs-now-val"], ["nrs-worst", "nrs-worst-val"]].forEach(([sid, vid]) => {
  document.getElementById(sid).addEventListener("input", (e) =>
    document.getElementById(vid).textContent = e.target.value);
});
function setNrs(sid, vid, v) {
  document.getElementById(sid).value = v ?? 0;
  document.getElementById(vid).textContent = v ?? 0;
}

// ── セッション読み込み ───────────────────────────────
async function loadSession() {
  sessionData = await api("/api/admin/counseling/" + SESSION_ID);
  document.getElementById("client-title").textContent =
    `${sessionData.client_name} 様` + (sessionData.client_contact ? `（${sessionData.client_contact}）` : "");
  document.getElementById("upload-url").value = location.origin + "/p/" + sessionData.upload_token;
  updateStatusBtn();

  const d = sessionData.data || {};
  (d.pain_areas || []).forEach((a) => selectedAreas.add(a));
  syncBodymap();
  setNrs("nrs-now", "nrs-now-val", d.pain_now);
  setNrs("nrs-worst", "nrs-worst-val", d.pain_worst);
  document.getElementById("chief-memo").value = d.chief_memo || "";
  setChips("posture-findings", d.posture_findings);
  document.getElementById("posture-memo").value = d.posture_memo || "";
  document.getElementById("plan-memo").value = d.plan || "";
  document.getElementById("selfcare-memo").value = d.selfcare || "";

  photos = sessionData.photos || [];
  maxPhotoId = photos.reduce((m, p) => Math.max(m, p.id), 0);
  renderPhotos();
  startPolling();
}

function updateStatusBtn() {
  const btn = document.getElementById("status-btn");
  btn.textContent = sessionData.status === "done" ? "対応中に戻す" : "✓ 完了にする";
}

async function toggleStatus() {
  const next = sessionData.status === "done" ? "open" : "done";
  await api("/api/admin/counseling/" + SESSION_ID, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: next }),
  });
  sessionData.status = next;
  updateStatusBtn();
  showToast(next === "done" ? "完了にしました（アップロードリンクは無効になります）" : "対応中に戻しました");
  startPolling();
}

async function deleteSession() {
  if (!confirm(`${sessionData.client_name}様のカウンセリングシートを削除しますか？\n写真もすべて削除されます。`)) return;
  await api("/api/admin/counseling/" + SESSION_ID, { method: "DELETE" });
  location.href = "/admin/counseling";
}

function copyUploadUrl() {
  const input = document.getElementById("upload-url");
  input.select();
  if (navigator.clipboard) {
    navigator.clipboard.writeText(input.value).then(() => showToast("リンクをコピーしました"));
  } else {
    document.execCommand("copy");
    showToast("リンクをコピーしました");
  }
}

// ── シート保存 ───────────────────────────────────────
async function saveSession() {
  const data = {
    pain_areas: [...selectedAreas],
    pain_now: +document.getElementById("nrs-now").value,
    pain_worst: +document.getElementById("nrs-worst").value,
    chief_memo: document.getElementById("chief-memo").value,
    posture_findings: chipValues("posture-findings"),
    posture_memo: document.getElementById("posture-memo").value,
    plan: document.getElementById("plan-memo").value,
    selfcare: document.getElementById("selfcare-memo").value,
  };
  await api("/api/admin/counseling/" + SESSION_ID, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data }),
  });
  showToast("シートを保存しました");
}

// ── 写真表示・ポーリング ─────────────────────────────
function offsetsSummary(m) {
  if (!m || !m.offsets) return "";
  const o = m.offsets;
  const f = (v) => (v > 0 ? "+" : "") + v + "%";
  return `耳${f(o.ear)}／肩${f(o.shoulder)}／股関節${f(o.hip)}／膝${f(o.knee)}`;
}

function renderPhotos() {
  const grid = document.getElementById("photo-grid");
  if (!photos.length) {
    grid.innerHTML = '<p style="font-size:13px;color:var(--muted)">まだ写真はありません</p>';
    return;
  }
  grid.innerHTML = photos.map((p) => `
    <div class="photo-card">
      <img src="${p.photo}" alt="${esc(p.label || "姿勢写真")}" onclick="openAnalyzeModal(${p.id})">
      <div class="photo-meta">
        <span>${esc(p.label || "写真")}${p.source === "client" ? "（お客様）" : ""}</span>
        <span style="color:var(--muted)">${esc((p.created_at || "").slice(11, 16))}</span>
      </div>
      ${p.markers ? `<div class="photo-offsets">${offsetsSummary(p.markers)}</div>` : ""}
      <div style="display:flex;gap:6px;margin-top:6px">
        <button class="btn btn-outline btn-sm" style="flex:1" onclick="openAnalyzeModal(${p.id})">📐 マーカー分析</button>
        <button class="btn btn-outline btn-sm" onclick="deletePhoto(${p.id})">🗑</button>
      </div>
    </div>`).join("");
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  if (sessionData.status !== "open") return;
  pollTimer = setInterval(async () => {
    try {
      const news = await api(`/api/admin/counseling/${SESSION_ID}/photos?after=${maxPhotoId}`);
      if (news.length) {
        photos.push(...news);
        maxPhotoId = photos.reduce((m, p) => Math.max(m, p.id), 0);
        renderPhotos();
        showToast(`お客様から写真が${news.length}枚届きました`);
      }
    } catch (e) { /* ポーリング失敗は無視 */ }
  }, 6000);
}

async function deletePhoto(photoId) {
  if (!confirm("この写真を削除しますか？")) return;
  await api("/api/admin/counseling/photos/" + photoId, { method: "DELETE" });
  photos = photos.filter((p) => p.id !== photoId);
  renderPhotos();
}

// スタッフ側からの写真追加
document.getElementById("staff-photo-input").addEventListener("change", (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = async () => {
      const scale = Math.min(1, 1000 / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      const dataUrl = c.toDataURL("image/jpeg", 0.82);
      try {
        const j = await api(`/api/admin/counseling/${SESSION_ID}/photos`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ photo: dataUrl, label: "スタッフ追加" }),
        });
        photos.push({ id: j.photo_id, photo: dataUrl, label: "スタッフ追加", source: "staff",
                      created_at: "", markers: null });
        maxPhotoId = Math.max(maxPhotoId, j.photo_id);
        renderPhotos();
        showToast("写真を追加しました");
      } catch (err) {
        showToast(err.message);
      }
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
});

// ── マーカー分析モーダル ─────────────────────────────
const MARKERS = [
  { key: "ear",      label: "耳",       color: "#e05a5a" },
  { key: "shoulder", label: "肩",       color: "#e0a23c" },
  { key: "hip",      label: "股関節",   color: "#3ca3e0" },
  { key: "knee",     label: "膝",       color: "#7c5ae0" },
  { key: "ankle",    label: "踝",       color: "#2e8b6e" },
];
let anPhoto = null;     // 分析対象の写真オブジェクト
let anImg = null;       // Image
let markerPos = [];     // canvas座標
let dragIndex = -1;

function openAnalyzeModal(photoId) {
  anPhoto = photos.find((p) => p.id === photoId);
  if (!anPhoto) return;
  document.getElementById("analyze-title").textContent =
    `マーカー分析：${anPhoto.label || "写真"}`;
  const img = new Image();
  img.onload = () => {
    anImg = img;
    document.getElementById("analyze-modal").classList.remove("hidden");
    if (anPhoto.markers && anPhoto.markers.facing) {
      setChips("an-facing", [anPhoto.markers.facing]);
    }
    setupAnalyzeCanvas();
    updateAnResult();
  };
  img.src = anPhoto.photo;
}

function closeAnalyzeModal() {
  document.getElementById("analyze-modal").classList.add("hidden");
  anPhoto = null;
  anImg = null;
}

function setupAnalyzeCanvas() {
  const canvas = document.getElementById("an-canvas");
  const wrapW = document.getElementById("an-canvas-wrap").clientWidth || 400;
  // 縦長写真がモーダルに収まるよう高さも制限
  let w = wrapW;
  let h = Math.round((anImg.height / anImg.width) * w);
  const maxH = Math.round(window.innerHeight * 0.5);
  if (h > maxH) { h = maxH; w = Math.round((anImg.width / anImg.height) * h); }
  canvas.width = w;
  canvas.height = h;
  canvas.style.width = w + "px";
  canvas.style.margin = "0 auto";

  if (anPhoto.markers && Array.isArray(anPhoto.markers.points) && anPhoto.markers.points.length === 5) {
    // 保存済みマーカー（画像に対する相対座標 0..1）を復元
    markerPos = anPhoto.markers.points.map((p) => ({ x: p.x * w, y: p.y * h }));
  } else {
    const x = w * 0.45;
    markerPos = [
      { x, y: h * 0.10 },
      { x, y: h * 0.24 },
      { x, y: h * 0.52 },
      { x, y: h * 0.72 },
      { x, y: h * 0.93 },
    ];
  }
  drawAnalyzeCanvas();
  bindAnalyzeCanvas(canvas);
}

function drawAnalyzeCanvas() {
  const canvas = document.getElementById("an-canvas");
  const ctx = canvas.getContext("2d");
  ctx.drawImage(anImg, 0, 0, canvas.width, canvas.height);
  const ankle = markerPos[4];
  ctx.strokeStyle = "rgba(46,139,110,.9)";
  ctx.setLineDash([6, 4]);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(ankle.x, 0);
  ctx.lineTo(ankle.x, canvas.height);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.strokeStyle = "rgba(255,255,255,.85)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  markerPos.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.stroke();
  markerPos.forEach((p, i) => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 11, 0, Math.PI * 2);
    ctx.fillStyle = MARKERS[i].color;
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.font = "bold 9px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(MARKERS[i].label, p.x, p.y);
  });
}

function canvasPoint(canvas, ev) {
  const r = canvas.getBoundingClientRect();
  const t = ev.touches ? ev.touches[0] : ev;
  return {
    x: ((t.clientX - r.left) / r.width) * canvas.width,
    y: ((t.clientY - r.top) / r.height) * canvas.height,
  };
}

function bindAnalyzeCanvas(canvas) {
  if (canvas.dataset.bound) return;
  canvas.dataset.bound = "1";
  const start = (ev) => {
    const p = canvasPoint(canvas, ev);
    dragIndex = markerPos.findIndex((m) => Math.hypot(m.x - p.x, m.y - p.y) < 22);
    if (dragIndex >= 0) ev.preventDefault();
  };
  const move = (ev) => {
    if (dragIndex < 0) return;
    ev.preventDefault();
    const p = canvasPoint(canvas, ev);
    markerPos[dragIndex] = {
      x: Math.max(0, Math.min(canvas.width, p.x)),
      y: Math.max(0, Math.min(canvas.height, p.y)),
    };
    drawAnalyzeCanvas();
    updateAnResult();
  };
  const end = () => (dragIndex = -1);
  canvas.addEventListener("mousedown", start);
  canvas.addEventListener("mousemove", move);
  window.addEventListener("mouseup", end);
  canvas.addEventListener("touchstart", start, { passive: false });
  canvas.addEventListener("touchmove", move, { passive: false });
  canvas.addEventListener("touchend", end);
}

function computeOffsets() {
  const facing = chipValues("an-facing")[0] || "left";
  const ankle = markerPos[4];
  const bodyH = Math.abs(markerPos[0].y - ankle.y);
  if (bodyH < 40) return null;
  const sign = facing === "left" ? -1 : 1; // 顔が左向きなら前方=画面左
  const pct = (p) => Math.round(((p.x - ankle.x) * sign / bodyH) * 1000) / 10;
  return {
    facing,
    ear: pct(markerPos[0]),
    shoulder: pct(markerPos[1]),
    hip: pct(markerPos[2]),
    knee: pct(markerPos[3]),
  };
}

function updateAnResult() {
  const o = computeOffsets();
  const box = document.getElementById("an-result");
  if (!o) { box.innerHTML = ""; return; }
  const row = (label, v) => {
    const color = Math.abs(v) < 4 ? "var(--primary)" : Math.abs(v) < 8 ? "#e0a23c" : "#e05a5a";
    return `<span style="margin-right:14px">${label} <b style="color:${color}">${v > 0 ? "+" : ""}${v}%</b></span>`;
  };
  box.innerHTML =
    row("耳", o.ear) + row("肩", o.shoulder) + row("股関節", o.hip) + row("膝", o.knee) +
    '<div style="font-size:11px;color:var(--muted);margin-top:4px">くるぶし基準・＋が前方（身長比）。目安：±4%以内が良好</div>';
}

// facing切替時に再計算
document.querySelectorAll("#an-facing .chip").forEach((c) =>
  c.addEventListener("click", () => setTimeout(updateAnResult, 0)));

async function saveMarkers() {
  if (!anPhoto) return;
  const canvas = document.getElementById("an-canvas");
  const offsets = computeOffsets();
  if (!offsets) { showToast("マーカーの位置を調整してください"); return; }
  const markers = {
    // 画像サイズ非依存の相対座標（0..1）で保存
    points: markerPos.map((p) => ({
      x: Math.round((p.x / canvas.width) * 10000) / 10000,
      y: Math.round((p.y / canvas.height) * 10000) / 10000,
    })),
    facing: offsets.facing,
    offsets,
  };
  await api("/api/admin/counseling/photos/" + anPhoto.id, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ markers }),
  });
  anPhoto.markers = markers;
  renderPhotos();
  showToast("計測結果を保存しました");
  closeAnalyzeModal();
}

document.getElementById("analyze-modal").addEventListener("click", (e) => {
  if (e.target.id === "analyze-modal") closeAnalyzeModal();
});

loadSession();
