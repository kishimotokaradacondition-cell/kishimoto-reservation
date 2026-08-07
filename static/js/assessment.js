/* オンライン姿勢・痛みチェック */

// ── ステップ切替 ─────────────────────────────────────
let currentStep = 1;

function goAsStep(n) {
  if (n === 2 && !document.getElementById("as-name").value.trim()) {
    showToast("お名前を入力してください");
    return;
  }
  for (let i = 1; i <= 5; i++) {
    document.getElementById("as-step" + i).classList.toggle("hidden", i !== n);
    const ind = document.getElementById("as-step" + i + "-ind");
    ind.classList.toggle("active", i === n);
    ind.classList.toggle("done", i < n);
  }
  currentStep = n;
  window.scrollTo({ top: 0 });
}

function showToast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2500);
}

// ── チップ選択（data-single で単一選択） ─────────────
document.querySelectorAll(".chip-group").forEach((group) => {
  const single = group.hasAttribute("data-single");
  group.querySelectorAll(".chip").forEach((chip) => {
    chip.addEventListener("click", (e) => {
      e.preventDefault();
      if (single) {
        group.querySelectorAll(".chip").forEach((c) => {
          if (c !== chip) c.classList.remove("selected");
        });
        chip.classList.add("selected");
      } else {
        chip.classList.toggle("selected");
      }
    });
  });
});

function chipValues(id) {
  return [...document.querySelectorAll("#" + id + " .chip.selected")].map((c) => c.dataset.v);
}
function chipValue(id) {
  const v = chipValues(id);
  return v.length ? v[0] : "";
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
    if (selectedAreas.has(area)) {
      selectedAreas.delete(area);
      spot.classList.remove("selected");
    } else {
      selectedAreas.add(area);
      spot.classList.add("selected");
    }
    renderSelectedAreas();
  });
});

function renderSelectedAreas() {
  const box = document.getElementById("bm-selected");
  if (!selectedAreas.size) {
    box.innerHTML = '<span style="font-size:12px;color:var(--muted)">タップした部位がここに表示されます</span>';
    return;
  }
  box.innerHTML = [...selectedAreas]
    .map((a) => `<span class="bm-tag">${a}</span>`)
    .join("");
}
renderSelectedAreas();

// ── NRSスライダー ────────────────────────────────────
[["nrs-now", "nrs-now-val"], ["nrs-worst", "nrs-worst-val"], ["nrs-adl", "nrs-adl-val"]].forEach(
  ([sid, vid]) => {
    const s = document.getElementById(sid);
    s.addEventListener("input", () => {
      document.getElementById(vid).textContent = s.value;
    });
  }
);

// ── 写真チェック ─────────────────────────────────────
const MARKERS = [
  { key: "ear",      label: "耳",       color: "#e05a5a" },
  { key: "shoulder", label: "肩",       color: "#e0a23c" },
  { key: "hip",      label: "股関節",   color: "#3ca3e0" },
  { key: "knee",     label: "膝",       color: "#7c5ae0" },
  { key: "ankle",    label: "くるぶし", color: "#2e8b6e" },
];
let photoImg = null;       // Imageオブジェクト
let photoDataUrl = null;   // 縮小済みJPEG data URI
let markerPos = [];        // canvas座標 [{x,y}]
let dragIndex = -1;

document.getElementById("as-photo-input").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      // 長辺900pxに縮小してJPEG化（送信サイズを抑える）
      const scale = Math.min(1, 900 / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      photoDataUrl = c.toDataURL("image/jpeg", 0.82);
      const small = new Image();
      small.onload = () => {
        photoImg = small;
        setupCanvas();
        document.getElementById("as-photo-card").classList.remove("hidden");
      };
      small.src = photoDataUrl;
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
});

function setupCanvas() {
  const canvas = document.getElementById("as-canvas");
  const wrapW = document.getElementById("as-canvas-wrap").clientWidth || 340;
  const scale = wrapW / photoImg.width;
  canvas.width = wrapW;
  canvas.height = Math.round(photoImg.height * scale);
  // マーカー初期位置：横中央のやや左に縦一列
  const x = canvas.width * 0.45;
  markerPos = [
    { x, y: canvas.height * 0.12 },
    { x, y: canvas.height * 0.25 },
    { x, y: canvas.height * 0.52 },
    { x, y: canvas.height * 0.72 },
    { x, y: canvas.height * 0.92 },
  ];
  drawCanvas();
  bindCanvasEvents(canvas);
}

function drawCanvas() {
  const canvas = document.getElementById("as-canvas");
  const ctx = canvas.getContext("2d");
  ctx.drawImage(photoImg, 0, 0, canvas.width, canvas.height);
  // くるぶし基準の鉛直線
  const ankle = markerPos[4];
  ctx.strokeStyle = "rgba(46,139,110,.85)";
  ctx.setLineDash([6, 4]);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(ankle.x, 0);
  ctx.lineTo(ankle.x, canvas.height);
  ctx.stroke();
  ctx.setLineDash([]);
  // マーカー間の線
  ctx.strokeStyle = "rgba(255,255,255,.8)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  markerPos.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.stroke();
  // マーカー
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

function bindCanvasEvents(canvas) {
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
    drawCanvas();
  };
  const end = () => (dragIndex = -1);
  canvas.addEventListener("mousedown", start);
  canvas.addEventListener("mousemove", move);
  window.addEventListener("mouseup", end);
  canvas.addEventListener("touchstart", start, { passive: false });
  canvas.addEventListener("touchmove", move, { passive: false });
  canvas.addEventListener("touchend", end);
}

// マーカー位置から前方偏位（%：耳-くるぶし間の高さ比）を計算
function photoOffsets() {
  if (!photoImg) return null;
  const facing = chipValue("as-facing") || "left";
  const ankle = markerPos[4];
  const bodyH = Math.abs(markerPos[0].y - ankle.y);
  if (bodyH < 40) return null; // マーカー未調整とみなす
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

// ── スコア計算 ───────────────────────────────────────
function calcScores(answers, offsets) {
  let score = 100;
  const types = [];

  // 壁立ちQ1：頭の位置
  if (answers.wall_head === "意識すればつく") score -= 10;
  if (answers.wall_head === "つかない・顎が上がる") { score -= 20; }
  // 壁立ちQ2：腰のすき間
  if (answers.wall_lumbar === "手のひら2枚以上・こぶしが入る") score -= 15;
  if (answers.wall_lumbar === "ほとんどすき間がない") score -= 10;
  // 左右差
  if (answers.shoulder_height === "少し違う") score -= 5;
  if (answers.shoulder_height === "明らかに違う") score -= 10;
  if (answers.shoes === "左右で減り方が違う") score -= 10;
  else if (answers.shoes === "外側が減る" || answers.shoes === "内側が減る") score -= 5;
  // 習慣（最大-20）
  score -= Math.min(20, (answers.habits || []).length * 4);

  // 写真評価
  if (offsets) {
    if (Math.abs(offsets.ear) >= 8) score -= 10;
    else if (Math.abs(offsets.ear) >= 4) score -= 5;
    if (Math.abs(offsets.hip) >= 8) score -= 8;
    else if (Math.abs(offsets.hip) >= 4) score -= 4;
  }
  score = Math.max(0, Math.min(100, score));

  // タイプ判定
  const headFwd = answers.wall_head === "つかない・顎が上がる" ||
                  answers.wall_head === "意識すればつく" ||
                  (offsets && offsets.ear - offsets.shoulder >= 5);
  if (headFwd) types.push("頭が前に出やすい（ストレートネック・猫背傾向）");
  if (answers.wall_lumbar === "手のひら2枚以上・こぶしが入る")
    types.push("反り腰傾向");
  if (answers.wall_lumbar === "ほとんどすき間がない")
    types.push("腰のカーブが少ない（フラットバック傾向）");
  if (answers.shoulder_height === "明らかに違う" || answers.shoes === "左右で減り方が違う" ||
      (answers.shoulder_height === "少し違う" && (answers.habits || []).some((h) => h.includes("脚を組む") || h.includes("同じ側"))))
    types.push("左右のバランスの崩れ");
  if (offsets && offsets.hip >= 5)
    types.push("骨盤が前に出やすい（スウェイバック傾向）");
  if (!types.length) types.push("大きな崩れは見られません");

  return { score, types };
}

// ── 送信・結果表示 ───────────────────────────────────
let submitted = false;

async function submitAssessment() {
  const answers = {
    lifestyle: chipValues("as-lifestyle"),
    pain_areas: [...selectedAreas],
    pain_quality: chipValues("as-quality"),
    pain_timing: chipValues("as-timing"),
    pain_duration: chipValue("as-duration"),
    red_flags: [...document.querySelectorAll("#as-redflags input:checked")].map((c) => c.value),
    wall_head: chipValue("as-wall-head"),
    wall_lumbar: chipValue("as-wall-lumbar"),
    shoulder_height: chipValue("as-shoulder"),
    shoes: chipValue("as-shoes"),
    habits: chipValues("as-habits"),
  };
  const offsets = photoOffsets();
  const { score, types } = calcScores(answers, offsets);
  const scores = {
    pain_now: +document.getElementById("nrs-now").value,
    pain_worst: +document.getElementById("nrs-worst").value,
    adl: +document.getElementById("nrs-adl").value,
    posture_score: score,
    posture_type: types.join("／"),
    red_flag: answers.red_flags.length > 0,
    photo_offsets: offsets,
  };

  renderResult(answers, scores, types);
  goAsStep(5);

  if (submitted) return; // 二重送信防止（結果は再表示可）
  submitted = true;
  try {
    const res = await fetch("/api/assessments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: document.getElementById("as-name").value.trim(),
        age_group: chipValue("as-age"),
        gender: chipValue("as-gender"),
        contact: document.getElementById("as-contact").value.trim(),
        answers, scores,
        photo: photoDataUrl,
      }),
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
  } catch (e) {
    submitted = false;
    showToast("送信に失敗しましたが、結果はご覧いただけます");
  }
}

function scoreColor(score) {
  if (score >= 80) return "var(--primary)";
  if (score >= 60) return "#e0a23c";
  return "#e05a5a";
}

function renderResult(answers, scores, types) {
  const box = document.getElementById("as-result");
  let html = "";

  // レッドフラグ警告
  if (answers.red_flags.length) {
    html += `
    <div class="rf-alert">
      <div style="font-weight:700;margin-bottom:6px">⚠️ まずは医療機関へのご相談をおすすめします</div>
      <p style="font-size:13px">チェックいただいた項目（${answers.red_flags.map((f) => "「" + f + "」").join("")}）は、
      整体の前に病院・クリニックでの確認をおすすめするサインです。
      整形外科などの受診をご検討ください。受診後のケアは当院でもご相談いただけます。</p>
    </div>`;
  }

  // 姿勢スコア
  html += `
  <div class="card">
    <div class="card-title">姿勢スコア</div>
    <div class="score-circle" style="color:${scoreColor(scores.posture_score)}">
      <span class="score-num">${scores.posture_score}</span><span class="score-max">/100</span>
    </div>
    <div class="score-types">
      ${types.map((t) => `<span class="type-tag">${t}</span>`).join("")}
    </div>
  </div>`;

  // 痛みサマリー
  const areas = answers.pain_areas.length ? answers.pain_areas.join("・") : "（部位の選択なし）";
  html += `
  <div class="card">
    <div class="card-title">痛みの状態</div>
    <div class="pain-summary">
      <div class="pain-row"><span>気になる部位</span><b>${areas}</b></div>
      ${painBar("いまの痛み", scores.pain_now)}
      ${painBar("最もつらい時", scores.pain_worst)}
      ${painBar("生活への支障", scores.adl)}
      ${answers.pain_duration ? `<div class="pain-row"><span>期間</span><b>${answers.pain_duration}</b></div>` : ""}
    </div>
  </div>`;

  // 写真評価
  if (scores.photo_offsets) {
    const o = scores.photo_offsets;
    html += `
    <div class="card">
      <div class="card-title">写真チェック（くるぶし基準の前後バランス）</div>
      ${offsetBar("耳", o.ear)}
      ${offsetBar("肩", o.shoulder)}
      ${offsetBar("股関節", o.hip)}
      ${offsetBar("膝", o.knee)}
      <p style="font-size:11px;color:var(--muted);margin-top:8px">
        ＋は前方、−は後方へのずれ（身長に対する割合）。目安として ±4%以内 がバランスの良い範囲です。
      </p>
    </div>`;
  }

  // アドバイス
  html += `
  <div class="card">
    <div class="card-title">おすすめセルフケア</div>
    ${adviceHtml(types, answers)}
  </div>`;

  html += `
  <div class="card" style="background:var(--primary-lt);border:1.5px solid var(--primary)">
    <p style="font-size:13px">
      チェック結果は当院に届いています。ご来院時には、この結果をもとに
      国家資格者が姿勢とお身体の状態を詳しく評価し、施術とセルフケアをご提案します。
    </p>
  </div>`;

  box.innerHTML = html;
}

function painBar(label, v) {
  const color = v >= 7 ? "#e05a5a" : v >= 4 ? "#e0a23c" : "var(--primary)";
  return `
  <div class="pain-row">
    <span>${label}</span>
    <div class="bar-track"><div class="bar-fill" style="width:${v * 10}%;background:${color}"></div></div>
    <b style="min-width:44px;text-align:right">${v} / 10</b>
  </div>`;
}

function offsetBar(label, v) {
  const abs = Math.min(15, Math.abs(v));
  const good = Math.abs(v) < 4;
  const color = good ? "var(--primary)" : Math.abs(v) < 8 ? "#e0a23c" : "#e05a5a";
  const side = v > 0 ? "right" : "left";
  return `
  <div class="pain-row">
    <span>${label}</span>
    <div class="offset-track">
      <div class="offset-center"></div>
      <div class="offset-fill" style="${side}:50%;width:${(abs / 15) * 50}%;background:${color}"></div>
    </div>
    <b style="min-width:52px;text-align:right">${v > 0 ? "+" : ""}${v}%</b>
  </div>`;
}

const ADVICE = {
  head: {
    match: (t) => t.includes("頭が前に"),
    title: "顎引きエクササイズ（チンタック）",
    body: "背筋を伸ばして座り、顎を軽く引いて頭を後ろにスライドさせ、5秒キープ×10回。デスクワークの合間に1〜2時間ごとに行うのがおすすめです。",
  },
  sway: {
    match: (t) => t.includes("反り腰"),
    title: "お腹の引き込み＋もも前のストレッチ",
    body: "仰向けで膝を立て、腰と床のすき間を軽くつぶすようにお腹を引き込み10秒×10回。立って足首をつかみ、もも前を30秒ずつ伸ばすストレッチも有効です。",
  },
  flat: {
    match: (t) => t.includes("フラットバック"),
    title: "背骨をしなやかに動かす体操",
    body: "四つばいで背中を丸める↔反らせる（キャット＆ドッグ）をゆっくり10回。腰を一気に反らせず、背骨全体を順番に動かす意識で行いましょう。",
  },
  side: {
    match: (t) => t.includes("左右"),
    title: "左右差をつくる習慣のリセット",
    body: "脚組み・片側での荷物持ちなど「いつも同じ側」の習慣を意識して左右交互に。体側を伸ばすストレッチ（バンザイして真横に倒す）を左右30秒ずつどうぞ。",
  },
  swayback: {
    match: (t) => t.includes("スウェイバック"),
    title: "骨盤を戻す壁立ちリセット",
    body: "壁にかかと・お尻・背中をつけて立ち、お腹を軽く引き込んだ姿勢を30秒キープ。骨盤を前に突き出すクセをリセットする感覚を覚えましょう。",
  },
};

function adviceHtml(types, answers) {
  const joined = types.join("");
  let items = Object.values(ADVICE).filter((a) => a.match(joined));
  if (!items.length) {
    items = [{
      title: "良い状態のキープを",
      body: "現時点で大きな崩れは見られません。長時間同じ姿勢を避け、1時間に1回は立ち上がって体を動かす習慣を続けましょう。",
    }];
  }
  let html = items
    .map((a) => `<div class="advice-item"><b>💡 ${a.title}</b><p>${a.body}</p></div>`)
    .join("");
  if (scoresNum() >= 7) {
    html = `<div class="advice-item"><b>⚠️ 痛みが強い間は</b><p>無理なストレッチは控え、痛みのない範囲で軽く動かす程度にしてください。強い痛みが続く場合は早めにご相談ください。</p></div>` + html;
  }
  return html;
}

function scoresNum() {
  return +document.getElementById("nrs-now").value;
}

// リサイズでキャンバス再描画
window.addEventListener("resize", () => {
  if (photoImg && !document.getElementById("as-photo-card").classList.contains("hidden")) {
    const old = markerPos.map((p) => ({ ...p }));
    const canvas = document.getElementById("as-canvas");
    const oldW = canvas.width, oldH = canvas.height;
    setupCanvas();
    // 相対位置を維持
    markerPos = old.map((p) => ({
      x: (p.x / oldW) * canvas.width,
      y: (p.y / oldH) * canvas.height,
    }));
    drawCanvas();
  }
});
