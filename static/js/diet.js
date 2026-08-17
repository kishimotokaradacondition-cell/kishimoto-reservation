/* 食事・ダイエット管理 フロントエンド */

const state = {
  token: new URLSearchParams(location.search).get("token") || "",
  isAdmin: false,
  profiles: [],
  profileId: null,
  date: todayStr(),
  activityLevels: {},
  mealTypes: {},
  mealType: "breakfast",
  summary: null,
  foods: [],
  selectedFood: null,
  mets: [],
};

/* ── ユーティリティ ── */

function todayStr() {
  const d = new Date(Date.now() + 9 * 3600 * 1000); // JST
  return d.toISOString().slice(0, 10);
}

function fmtDate(s) {
  const [y, m, d] = s.split("-").map(Number);
  const dow = "日月火水木金土"[new Date(y, m - 1, d).getDay()];
  const t = todayStr();
  const suffix = s === t ? "（今日）" : "";
  return `${m}月${d}日(${dow})${suffix}`;
}

function q(url) {
  if (!state.token) return url;
  return url + (url.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(state.token);
}

async function api(url, options) {
  const res = await fetch(q(url), options);
  let data = {};
  try { data = await res.json(); } catch (e) { /* 本文なし */ }
  if (!res.ok) {
    const err = new Error(data.error || "通信に失敗しました");
    err.status = res.status;
    throw err;
  }
  return data;
}

function post(url, body) {
  if (state.token) body = Object.assign({ token: state.token }, body);
  return api(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function patch(url, body) {
  if (state.token) body = Object.assign({ token: state.token }, body);
  return api(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function del(url) {
  return api(url, { method: "DELETE" });
}

function num(id) {
  const v = document.getElementById(id).value;
  return v === "" ? null : parseFloat(v);
}

function val(id) { return document.getElementById(id).value.trim(); }
function setVal(id, v) { document.getElementById(id).value = (v === null || v === undefined) ? "" : v; }
function el(id) { return document.getElementById(id); }
function esc(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

let toastTimer = null;
function toast(msg) {
  const t = el("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
}

/* ── 起動 ── */

document.addEventListener("DOMContentLoaded", boot);

async function boot() {
  try {
    const data = await api("/api/diet/profiles");
    state.isAdmin = data.is_admin;
    state.profiles = data.profiles;
    state.activityLevels = data.activity_levels;
    state.mealTypes = data.meal_types;
    if (!state.profiles.length) {
      el("loginBox").style.display = "";
      el("loginErr").textContent = "プロフィールがありません。管理画面から作成してください。";
      return;
    }
    const saved = parseInt(localStorage.getItem("dietProfileId") || "0", 10);
    state.profileId = state.profiles.some(p => p.id === saved) ? saved : state.profiles[0].id;
    el("appBox").style.display = "";
    el("loginBox").style.display = "none";
    renderProfileSelect();
    renderStaticParts();
    await Promise.all([loadFoods(), loadMets()]);
    await reload();
  } catch (e) {
    if (e.status === 401) {
      el("loginBox").style.display = "";
      el("appBox").style.display = "none";
    } else {
      toast(e.message);
    }
  }
}

async function doLogin() {
  try {
    await api("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: el("loginPw").value }),
    });
    el("loginErr").textContent = "";
    boot();
  } catch (e) {
    el("loginErr").textContent = e.message;
  }
}

async function doLogout() {
  await api("/api/admin/logout", { method: "POST" });
  location.href = "/diet";
}

function renderProfileSelect() {
  const sel = el("profileSelect");
  sel.innerHTML = state.profiles
    .map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
  sel.value = state.profileId;
  sel.style.display = state.profiles.length > 1 ? "" : "none";
}

function switchProfile(id) {
  state.profileId = parseInt(id, 10);
  localStorage.setItem("dietProfileId", state.profileId);
  reload();
}

function renderStaticParts() {
  // 食事区分チップ
  el("mealTypeChips").innerHTML = state.mealTypes
    .map(m => `<button class="chip${m.key === state.mealType ? " active" : ""}" data-mt="${m.key}" onclick="pickMealType('${m.key}')">${esc(m.label)}</button>`)
    .join("");
  // 活動レベル
  el("stActivity").innerHTML = state.activityLevels
    .map(v => `<option value="${v.key}">${esc(v.label)}（×${v.factor}）</option>`).join("");
  el("adminCard").style.display = state.isAdmin ? "" : "none";
  el("shareCard").style.display = state.isAdmin ? "" : "none";
  // 日付初期値
  setVal("ibDate", state.date);
  setVal("blDate", state.date);
}

function switchTab(name) {
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".tab-pane").forEach(p => p.classList.toggle("active", p.id === "tab-" + name));
  window.scrollTo(0, 0);
  if (name === "report") loadReport();
  if (name === "body") loadBodyTabs();
}

function shiftDate(days) {
  const d = new Date(state.date + "T00:00:00");
  d.setDate(d.getDate() + days);
  state.date = d.toISOString().slice(0, 10);
  reload();
}

/* ── ホーム描画 ── */

async function reload() {
  const s = await api(`/api/diet/profiles/${state.profileId}/summary?date=${state.date}`);
  state.summary = s;
  el("dateLabel").textContent = fmtDate(s.date);
  el("dateLabel2").textContent = fmtDate(s.date);
  renderCalories(s);
  renderMacros(s);
  renderLogs(s);
  renderAdvice(s);
  renderWeightChart(s);
  fillSettings(s.profile);
  renderCalcDetail(s);
  renderMealHint(s);
  renderExEstimate();
}

function renderCalories(s) {
  const target = s.effective_target_kcal;
  const eaten = s.totals.kcal;
  el("tgtKcal").textContent = target ? target.toLocaleString() : "-";
  el("eatKcal").textContent = eaten.toLocaleString();
  el("exKcal").textContent = s.totals.exercise_kcal.toLocaleString();

  const remain = target ? target - eaten : null;
  const big = el("remainKcal");
  if (remain === null) {
    big.textContent = "-";
    el("remainLabel").textContent = "設定を入力してください";
  } else if (remain >= 0) {
    big.textContent = remain.toLocaleString();
    big.classList.remove("over");
    el("remainLabel").textContent = "のこり kcal";
  } else {
    big.textContent = Math.abs(remain).toLocaleString();
    big.classList.add("over");
    el("remainLabel").textContent = "オーバー kcal";
  }

  // ドーナツリング
  const pct = target ? Math.min(eaten / target, 1) : 0;
  const r = 52, cx = 60, cy = 60, circ = 2 * Math.PI * r;
  const color = (target && eaten > target) ? "var(--danger)" : "var(--primary)";
  el("calRing").innerHTML = `
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#eef2f0" stroke-width="12"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="12"
      stroke-linecap="round" stroke-dasharray="${(circ * pct).toFixed(1)} ${circ.toFixed(1)}"
      transform="rotate(-90 ${cx} ${cy})"/>`;
}

function macroRow(name, cls, now, target, unit) {
  const pct = target ? Math.min(now / target * 100, 100) : 0;
  const over = target && now > target * 1.05;
  return `<div class="macro">
      <div class="head">
        <span class="name">${name}</span>
        <span class="val">${now.toFixed(1)}${unit} / ${target ? target + unit : "-"}</span>
      </div>
      <div class="bar ${cls}"><span class="${over ? "over" : ""}" style="width:${pct}%"></span></div>
    </div>`;
}

function renderMacros(s) {
  const t = s.targets, v = s.totals;
  el("macros").innerHTML =
    macroRow("P たんぱく質", "p", v.protein_g, t.protein_g, "g") +
    macroRow("F 脂質", "f", v.fat_g, t.fat_g, "g") +
    macroRow("C 炭水化物", "c", v.carb_g, t.carb_g, "g") +
    macroRow("食塩相当量", "s", v.salt_g, t.salt_limit_g, "g") +
    `<p class="note-text" style="margin-top:10px">
       水分の目安 ${t.water_ml ? (t.water_ml / 1000).toFixed(1) + "L" : "-"}／日。
       たんぱく質は除脂肪量1kgあたり2.0gを目標にしています。</p>`;
}

function renderLogs(s) {
  const groups = state.mealTypes.map(({ key, label }) => {
    const items = s.meals.filter(m => m.meal_type === key);
    const sum = items.reduce((a, m) => a + m.kcal, 0);
    const rows = items.length
      ? items.map(m => `<div class="log-item">
            <span class="nm">${esc(m.name)}${m.amount !== 1 ? ` ×${m.amount}` : ""}
              <small>P ${m.protein_g}g / F ${m.fat_g}g / C ${m.carb_g}g</small></span>
            <span class="kc">${Math.round(m.kcal)}kcal</span>
            <button class="del" onclick="removeMeal(${m.id})" aria-label="削除">×</button>
          </div>`).join("")
      : `<div class="empty">記録なし</div>`;
    return `<div class="log-group">
        <div class="ttl"><span>${esc(label)}</span><span>${Math.round(sum)} kcal</span></div>
        ${rows}</div>`;
  }).join("");

  const exRows = s.exercises.length
    ? s.exercises.map(e => `<div class="log-item">
          <span class="nm">${esc(e.kind)}<small>${e.minutes}分 / ${e.mets}METs</small></span>
          <span class="kc">-${Math.round(e.kcal)}kcal</span>
          <button class="del" onclick="removeExercise(${e.id})" aria-label="削除">×</button>
        </div>`).join("")
    : `<div class="empty">記録なし</div>`;

  const html = groups + `<div class="log-group">
      <div class="ttl"><span>運動</span><span>-${s.totals.exercise_kcal} kcal</span></div>
      ${exRows}</div>`;
  el("todayLogs").innerHTML = html;
  el("todayLogs2").innerHTML = html;
}

function renderAdvice(s) {
  el("advice").innerHTML = s.advice
    .map(t => `<div class="tip ${t.level}">${esc(t.text)}</div>`).join("");
}

/* ── グラフ ── */

function renderWeightChart(s) {
  const pts = s.trend.filter(t => t.weight_kg);
  const svg = el("weightChart");
  if (pts.length < 2) {
    svg.innerHTML = `<text x="160" y="78" text-anchor="middle" fill="#7a9088" font-size="11">
      体重を2日以上記録するとグラフが表示されます</text>`;
    return;
  }
  const W = 320, H = 150, pad = { l: 34, r: 10, t: 12, b: 22 };
  const goal = s.targets.goal_weight_kg;
  // 目盛りは体重の実測値だけで決める（目標体重が遠いとグラフが潰れるため）
  const values = pts.map(p => p.weight_kg);
  let min = Math.min(...values), max = Math.max(...values);
  const span = Math.max(max - min, 1);
  min -= span * 0.2; max += span * 0.2;
  const x = i => pad.l + (W - pad.l - pad.r) * (pts.length === 1 ? 0.5 : i / (pts.length - 1));
  const y = v => pad.t + (H - pad.t - pad.b) * (1 - (v - min) / (max - min));

  const line = pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.weight_kg).toFixed(1)}`).join(" ");
  const area = `${line} L${x(pts.length - 1).toFixed(1)},${H - pad.b} L${x(0).toFixed(1)},${H - pad.b} Z`;
  const dots = pts.map((p, i) =>
    `<circle cx="${x(i).toFixed(1)}" cy="${y(p.weight_kg).toFixed(1)}" r="2.5" fill="#2e8b6e"/>`).join("");
  // 目標体重が表示範囲の外なら、グラフの端に寄せて矢印つきで示す
  let goalLine = "";
  if (goal) {
    const outside = goal < min ? "↓" : (goal > max ? "↑" : "");
    const gy = Math.min(Math.max(y(goal), pad.t + 2), H - pad.b);
    goalLine = `
      <line x1="${pad.l}" y1="${gy.toFixed(1)}" x2="${W - pad.r}" y2="${gy.toFixed(1)}"
        stroke="#f0a500" stroke-width="1.5" stroke-dasharray="4 3"/>
      <text x="${W - pad.r}" y="${(gy - 4).toFixed(1)}" text-anchor="end" fill="#f0a500" font-size="9">
        目標 ${goal}kg ${outside}</text>`;
  }
  const gridVals = [max, (max + min) / 2, min];
  const grid = gridVals.map(v => `
    <line x1="${pad.l}" y1="${y(v).toFixed(1)}" x2="${W - pad.r}" y2="${y(v).toFixed(1)}"
      stroke="#eef2f0" stroke-width="1"/>
    <text x="${pad.l - 4}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end" fill="#7a9088" font-size="8.5">
      ${v.toFixed(1)}</text>`).join("");

  svg.innerHTML = `
    <defs><linearGradient id="wg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#2e8b6e" stop-opacity=".22"/>
      <stop offset="100%" stop-color="#2e8b6e" stop-opacity="0"/>
    </linearGradient></defs>
    ${grid}${goalLine}
    <path d="${area}" fill="url(#wg)"/>
    <path d="${line}" fill="none" stroke="#2e8b6e" stroke-width="2" stroke-linejoin="round"/>
    ${dots}
    <text x="${pad.l}" y="${H - 6}" fill="#7a9088" font-size="8.5">${pts[0].date.slice(5)}</text>
    <text x="${W - pad.r}" y="${H - 6}" text-anchor="end" fill="#7a9088" font-size="8.5">${pts[pts.length - 1].date.slice(5)}</text>`;
}

function renderReportChart(weeks) {
  const svg = el("reportChart");
  // 記録のない週も横軸に並べる（棒の幅と週の間隔をそろえるため）
  const rows = weeks;
  if (!rows.some(w => w.avg_weight_kg !== null || w.avg_kcal !== null)) {
    svg.innerHTML = `<text x="160" y="80" text-anchor="middle" fill="#7a9088" font-size="11">
      記録がたまるとグラフが表示されます</text>`;
    return;
  }
  const W = 320, H = 160, pad = { l: 32, r: 32, t: 12, b: 26 };
  const kcals = rows.map(r => r.avg_kcal).filter(v => v !== null);
  const kMax = kcals.length ? Math.max(...kcals) * 1.15 : 1;
  const ws = rows.map(r => r.avg_weight_kg).filter(v => v !== null);
  let wMin = ws.length ? Math.min(...ws) : 0, wMax = ws.length ? Math.max(...ws) : 1;
  const wSpan = Math.max(wMax - wMin, 1);
  wMin -= wSpan * 0.3; wMax += wSpan * 0.3;

  const bw = (W - pad.l - pad.r) / rows.length;
  const barW = Math.min(bw * 0.6, 22);   // 週が少ないときに棒が巨大にならないよう上限
  const x = i => pad.l + bw * (i + 0.5);
  const yK = v => pad.t + (H - pad.t - pad.b) * (1 - v / kMax);
  const yW = v => pad.t + (H - pad.t - pad.b) * (1 - (v - wMin) / (wMax - wMin));

  const bars = rows.map((r, i) => r.avg_kcal === null ? "" :
    `<rect x="${(x(i) - barW / 2).toFixed(1)}" y="${yK(r.avg_kcal).toFixed(1)}"
       width="${barW.toFixed(1)}" height="${(H - pad.b - yK(r.avg_kcal)).toFixed(1)}"
       fill="#3b82c4" opacity=".28" rx="2"/>`).join("");

  const wPts = rows.map((r, i) => ({ i, v: r.avg_weight_kg })).filter(p => p.v !== null);
  const wLine = wPts.map((p, n) => `${n ? "L" : "M"}${x(p.i).toFixed(1)},${yW(p.v).toFixed(1)}`).join(" ");
  const wDots = wPts.map(p =>
    `<circle cx="${x(p.i).toFixed(1)}" cy="${yW(p.v).toFixed(1)}" r="2.5" fill="#2e8b6e"/>`).join("");
  const labels = rows.map((r, i) =>
    `<text x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle" fill="#7a9088" font-size="8">
      ${r.week_start.slice(5).replace("-", "/")}</text>`).join("");

  svg.innerHTML = `${bars}
    <path d="${wLine}" fill="none" stroke="#2e8b6e" stroke-width="2"/>${wDots}${labels}`;
}

/* ── 記録の追加・削除 ── */

function pickMealType(k) {
  state.mealType = k;
  document.querySelectorAll("#mealTypeChips .chip")
    .forEach(c => c.classList.toggle("active", c.dataset.mt === k));
}

async function loadFoods() {
  const d = await api("/api/diet/foods");
  state.foods = d.foods;
  renderFoodList(state.foods.slice(0, 40));
}

function searchFoods() {
  const kw = val("foodSearch");
  const list = kw
    ? state.foods.filter(f => f.name.includes(kw) || (f.category || "").includes(kw))
    : state.foods.slice(0, 40);
  renderFoodList(list.slice(0, 60));
}

function renderFoodList(list) {
  el("foodList").innerHTML = list.length
    ? list.map(f => `<div class="food-item" data-id="${f.id}" onclick="pickFood(${f.id})">
        <span>${esc(f.name)}<span class="meta"> ／ ${esc(f.unit_label)}</span></span>
        <span class="meta">${Math.round(f.kcal)}kcal P${f.protein_g}</span>
      </div>`).join("")
    : `<div class="empty">該当する食品がありません。下の欄に直接入力できます。</div>`;
}

function pickFood(id) {
  const f = state.foods.find(x => x.id === id);
  if (!f) return;
  state.selectedFood = f;
  setVal("mealName", f.name);
  setVal("mealKcal", Math.round(f.kcal));
  setVal("mealP", f.protein_g);
  setVal("mealF", f.fat_g);
  setVal("mealC", f.carb_g);
  setVal("mealSalt", f.salt_g);
  document.querySelectorAll(".food-item")
    .forEach(n => n.classList.toggle("sel", parseInt(n.dataset.id, 10) === id));
}

async function saveMeal() {
  const name = val("mealName");
  if (!name) return toast("メニュー名を入力してください");
  const amount = num("mealAmount") || 1;
  const body = {
    date: state.date, meal_type: state.mealType, name, amount,
    kcal: num("mealKcal") || 0, protein_g: num("mealP") || 0,
    fat_g: num("mealF") || 0, carb_g: num("mealC") || 0, salt_g: num("mealSalt") || 0,
  };
  // マスタから選んだ食品そのままなら、数量に応じてサーバー側で計算させる
  if (state.selectedFood && state.selectedFood.name === name) body.food_id = state.selectedFood.id;
  try {
    await post(`/api/diet/profiles/${state.profileId}/meals`, body);
    ["mealName", "mealKcal", "mealP", "mealF", "mealC", "mealSalt"].forEach(i => setVal(i, ""));
    setVal("mealAmount", 1);
    state.selectedFood = null;
    document.querySelectorAll(".food-item").forEach(n => n.classList.remove("sel"));
    await reload();
    toast("食事を記録しました");
  } catch (e) { toast(e.message); }
}

async function removeMeal(id) {
  await del(`/api/diet/meals/${id}`);
  await reload();
  toast("削除しました");
}

async function loadMets() {
  const d = await api("/api/diet/mets");
  state.mets = d.presets;
  el("exPreset").innerHTML = `<option value="">（自由入力）</option>` +
    d.presets.map((m, i) => `<option value="${i}">${esc(m.kind)}（${m.mets}METs）</option>`).join("");
  el("exMin").addEventListener("input", renderExEstimate);
  el("exMets").addEventListener("input", renderExEstimate);
}

function applyMetsPreset() {
  const i = val("exPreset");
  if (i === "") return;
  setVal("exMets", state.mets[i].mets);
  renderExEstimate();
}

function renderExEstimate() {
  const w = state.summary && state.summary.body.weight_kg;
  const min = num("exMin"), mets = num("exMets");
  if (!w || !min || !mets) { el("exEstimate").textContent = ""; return; }
  const kcal = Math.round(mets * w * (min / 60) * 1.05);
  el("exEstimate").textContent =
    `推定消費カロリー 約${kcal}kcal（METs ${mets} × 体重${w}kg × ${min}分）`;
}

async function saveExercise() {
  const i = val("exPreset");
  const kind = i !== "" ? state.mets[i].kind : "運動";
  const minutes = num("exMin");
  const mets = num("exMets");
  if (!minutes || !mets) return toast("時間とMETsを入力してください");
  try {
    await post(`/api/diet/profiles/${state.profileId}/exercises`,
      { date: state.date, kind, minutes, mets });
    await reload();
    toast("運動を記録しました");
  } catch (e) { toast(e.message); }
}

async function removeExercise(id) {
  await del(`/api/diet/exercises/${id}`);
  await reload();
  toast("削除しました");
}

function openFoodForm() {
  const f = el("foodForm");
  f.style.display = f.style.display === "none" ? "" : "none";
  if (f.style.display === "") setVal("nfName", val("mealName"));
}

async function saveFood() {
  const name = val("nfName");
  if (!name) return toast("食品名を入力してください");
  try {
    await post("/api/diet/foods", {
      name, category: val("nfCat"), unit_label: val("nfUnit") || "1食",
      kcal: num("nfKcal") || 0, protein_g: num("nfP") || 0, fat_g: num("nfF") || 0,
      carb_g: num("nfC") || 0, salt_g: num("nfSalt") || 0,
    });
    await loadFoods();
    ["nfName", "nfKcal", "nfP", "nfF", "nfC", "nfSalt"].forEach(i => setVal(i, ""));
    toast("食品マスタに登録しました");
  } catch (e) { toast(e.message); }
}

function renderMealHint(s) {
  const t = s.targets;
  if (!t.target_kcal) return;
  const perMeal = Math.round(t.target_kcal / 3);
  el("mealHint").textContent =
    `1食あたりの目安は約${perMeal}kcal・たんぱく質約${Math.round(t.protein_g / 3)}gです。`;
}

/* ── 体重・InBody ── */

async function saveQuickWeight() {
  const w = num("quickWeight");
  if (!w) return toast("体重を入力してください");
  try {
    await post(`/api/diet/profiles/${state.profileId}/body-logs`,
      { date: state.date, weight_kg: w, body_fat_pct: num("quickFat") });
    setVal("quickWeight", ""); setVal("quickFat", "");
    await reload();
    toast("体重を記録しました");
  } catch (e) { toast(e.message); }
}

async function saveBodyLog() {
  const w = num("blWeight");
  if (!w) return toast("体重を入力してください");
  try {
    await post(`/api/diet/profiles/${state.profileId}/body-logs`,
      { date: val("blDate") || state.date, weight_kg: w, body_fat_pct: num("blFat") });
    setVal("blWeight", ""); setVal("blFat", "");
    await Promise.all([reload(), loadBodyTabs()]);
    toast("保存しました");
  } catch (e) { toast(e.message); }
}

async function saveInbody() {
  const w = num("ibWeight");
  if (!w) return toast("体重を入力してください");
  try {
    await post(`/api/diet/profiles/${state.profileId}/inbody`, {
      measured_on: val("ibDate") || state.date,
      weight_kg: w, body_fat_pct: num("ibFatPct"), fat_mass_kg: num("ibFatMass"),
      muscle_kg: num("ibMuscle"), fat_free_mass_kg: num("ibFFM"),
      body_water_kg: num("ibWater"), protein_kg: num("ibProtein"),
      mineral_kg: num("ibMineral"), bmi: num("ibBmi"),
      visceral_fat_level: num("ibVisceral"), waist_cm: num("ibWaist"),
      bmr_kcal: num("ibBmr"), score: num("ibScore"),
    });
    ["ibWeight", "ibFatPct", "ibFatMass", "ibMuscle", "ibFFM", "ibWater", "ibProtein",
      "ibMineral", "ibBmi", "ibVisceral", "ibWaist", "ibBmr", "ibScore"].forEach(i => setVal(i, ""));
    await Promise.all([reload(), loadBodyTabs()]);
    toast("InBodyデータを保存しました");
  } catch (e) { toast(e.message); }
}

async function loadBodyTabs() {
  const [ib, bl] = await Promise.all([
    api(`/api/diet/profiles/${state.profileId}/inbody`),
    api(`/api/diet/profiles/${state.profileId}/body-logs?days=90`),
  ]);
  renderInbodyLatest(ib.records);
  renderInbodyTable(ib.records);
  renderBodyLogTable(bl.logs);
}

function renderInbodyLatest(records) {
  if (!records.length) {
    el("inbodyLatest").innerHTML = `<div class="empty">まだInBodyデータがありません。</div>`;
    return;
  }
  const r = records[0];
  const prev = records[1];
  const std = (state.summary && state.summary.standards) ||
    { bmi_max: 25, fat_pct_max: 20, waist_max: 85, visceral_max: 10 };

  // 前回との差。増えたほうが良い項目（筋肉・除脂肪量・基礎代謝）は色を反転させる
  const diff = (key, unit, digits, goodDown) => {
    if (!prev || r[key] === null || prev[key] === null) return "";
    const d = r[key] - prev[key];
    if (Math.abs(d) < 0.05) return "";
    const good = goodDown ? d < 0 : d > 0;
    return `<small style="color:${good ? "var(--primary)" : "var(--danger)"}">
      ${d > 0 ? "+" : ""}${d.toFixed(digits)}${unit}</small>`;
  };
  const cell = (label, value, unit, warn, key, digits = 1, goodDown = true) => `
    <div class="stat${warn ? " warn" : ""}">
      <div class="lbl">${label}</div>
      <div class="val">${value === null || value === undefined ? "-" : value}<small>${unit}</small></div>
      ${key ? diff(key, unit, digits, goodDown) : ""}
    </div>`;

  el("inbodyLatest").innerHTML = `
    <p class="note-text" style="margin-bottom:10px">測定日 ${r.measured_on}</p>
    <div class="stat-grid">
      ${cell("体重", r.weight_kg, "kg", false, "weight_kg")}
      ${cell("体脂肪率", r.body_fat_pct, "%", r.body_fat_pct > std.fat_pct_max, "body_fat_pct")}
      ${cell("BMI", r.bmi, "", r.bmi >= std.bmi_max, "bmi")}
      ${cell("骨格筋量", r.muscle_kg, "kg", false, "muscle_kg", 1, false)}
      ${cell("体脂肪量", r.fat_mass_kg, "kg", false, "fat_mass_kg")}
      ${cell("除脂肪量", r.fat_free_mass_kg, "kg", false, "fat_free_mass_kg", 1, false)}
      ${cell("内臓脂肪Lv", r.visceral_fat_level, "", r.visceral_fat_level >= std.visceral_max, "visceral_fat_level", 0)}
      ${cell("腹囲", r.waist_cm, "cm", r.waist_cm >= std.waist_max, "waist_cm")}
      ${cell("基礎代謝", r.bmr_kcal, "kcal", false, "bmr_kcal", 0, false)}
    </div>
    ${r.note ? `<p class="note-text" style="margin-top:10px">${esc(r.note)}</p>` : ""}`;
}

function renderInbodyTable(records) {
  const t = el("inbodyTable");
  if (!records.length) { t.innerHTML = ""; return; }
  t.innerHTML = `<tr><th>測定日</th><th>体重</th><th>体脂肪率</th><th>骨格筋</th>
      <th>内臓脂肪</th><th>基礎代謝</th><th></th></tr>` +
    records.map(r => `<tr>
      <td>${r.measured_on}</td><td>${r.weight_kg ?? "-"}</td><td>${r.body_fat_pct ?? "-"}</td>
      <td>${r.muscle_kg ?? "-"}</td><td>${r.visceral_fat_level ?? "-"}</td><td>${r.bmr_kcal ?? "-"}</td>
      <td><button class="del" onclick="removeInbody(${r.id})">×</button></td></tr>`).join("");
}

async function removeInbody(id) {
  if (!confirm("この測定データを削除しますか？")) return;
  await del(`/api/diet/inbody/${id}`);
  await Promise.all([reload(), loadBodyTabs()]);
  toast("削除しました");
}

function renderBodyLogTable(logs) {
  const t = el("bodyLogTable");
  const rows = logs.slice().reverse().slice(0, 30);
  if (!rows.length) { t.innerHTML = `<tr><td class="empty">記録なし</td></tr>`; return; }
  t.innerHTML = `<tr><th>日付</th><th>体重</th><th>体脂肪率</th><th></th></tr>` +
    rows.map(r => `<tr>
      <td>${r.date}</td><td>${r.weight_kg ?? "-"}kg</td><td>${r.body_fat_pct ?? "-"}</td>
      <td><button class="del" onclick="removeBodyLog(${r.id})">×</button></td></tr>`).join("");
}

async function removeBodyLog(id) {
  await del(`/api/diet/body-logs/${id}`);
  await Promise.all([reload(), loadBodyTabs()]);
  toast("削除しました");
}

/* ── 週次レポート ── */

async function loadReport() {
  const d = await api(`/api/diet/profiles/${state.profileId}/report?weeks=8&date=${state.date}`);
  renderReportChart(d.weeks);
  const t = state.summary ? state.summary.targets.target_kcal : null;
  el("reportTable").innerHTML =
    `<tr><th>週</th><th>記録</th><th>kcal</th><th>P(g)</th><th>運動</th><th>体重</th><th>前週差</th></tr>` +
    d.weeks.map(w => `<tr>
      <td>${w.week_start.slice(5).replace("-", "/")}〜</td>
      <td>${w.logged_days}日</td>
      <td${t && w.avg_kcal ? (w.avg_kcal > t ? ' class="up"' : ' class="down"') : ""}>${w.avg_kcal ?? "-"}</td>
      <td>${w.avg_protein_g ?? "-"}</td>
      <td style="white-space:nowrap">${w.exercise_days}日${w.exercise_min}分</td>
      <td>${w.avg_weight_kg ?? "-"}</td>
      <td class="${!w.weight_diff_kg ? "" : (w.weight_diff_kg < 0 ? "down" : "up")}">
        ${w.weight_diff_kg === null ? "-" : (w.weight_diff_kg > 0 ? "+" : "") + w.weight_diff_kg}</td>
    </tr>`).join("");
}

/* ── 設定 ── */

function fillSettings(p) {
  setVal("stName", p.name);
  setVal("stSex", p.sex || "male");
  setVal("stAge", p.age);
  setVal("stHeight", p.height_cm);
  setVal("stGoalWeight", p.goal_weight_kg);
  setVal("stGoalFat", p.goal_fat_pct);
  setVal("stActivity", p.activity_level || "mid");
  setVal("stPace", p.goal_pace_kg);
  el("stAddExercise").checked = !!p.add_exercise;
  if (state.isAdmin && p.token) {
    el("shareUrl").textContent = `${location.origin}/diet?token=${p.token}`;
  }
}

async function saveProfile() {
  try {
    await patch(`/api/diet/profiles/${state.profileId}`, {
      name: val("stName"), sex: val("stSex"), age: num("stAge"),
      height_cm: num("stHeight"), goal_weight_kg: num("stGoalWeight"),
      goal_fat_pct: num("stGoalFat"), activity_level: val("stActivity"),
      goal_pace_kg: num("stPace"), add_exercise: el("stAddExercise").checked,
    });
    const d = await api("/api/diet/profiles");
    state.profiles = d.profiles;
    renderProfileSelect();
    await reload();
    toast("設定を保存しました");
  } catch (e) { toast(e.message); }
}

function renderCalcDetail(s) {
  const t = s.targets, b = s.body;
  const rows = [
    ["現在の体重", b.weight_kg ? b.weight_kg + " kg" : "-"],
    ["除脂肪量", b.fat_free_mass_kg ? b.fat_free_mass_kg + " kg" : "-"],
    ["基礎代謝量", t.bmr_kcal ? t.bmr_kcal + " kcal" : "-"],
    ["活動代謝量(TDEE)", t.tdee_kcal ? `${t.tdee_kcal} kcal（基礎代謝×${t.activity_factor}）` : "-"],
    ["減量ぶんの調整", t.deficit_kcal ? `-${t.deficit_kcal} kcal/日（月${t.pace_kg_per_month}kg想定）` : "なし"],
    ["1日の目標カロリー", t.target_kcal ? `${t.target_kcal} kcal` : "-"],
    ["PFC目標", t.protein_g ? `P ${t.protein_g}g / F ${t.fat_g}g / C ${t.carb_g}g` : "-"],
    ["目標体重まで", t.to_lose_kg ? `${t.to_lose_kg} kg` : "達成済み・未設定"],
    ["到達見込み", t.eta_date ? `${t.eta_date}（約${t.eta_days}日後）` : "-"],
  ];
  el("calcDetail").innerHTML = `<table class="tbl">` +
    rows.map(r => `<tr><td>${r[0]}</td><td>${esc(r[1])}</td></tr>`).join("") + `</table>`;
}

function copyShare() {
  const text = el("shareUrl").textContent;
  navigator.clipboard.writeText(text).then(() => toast("コピーしました"), () => toast(text));
}

async function addProfile() {
  const name = val("npName");
  if (!name) return toast("お名前を入力してください");
  try {
    const r = await post("/api/diet/profiles", {
      name, sex: val("npSex"), age: num("npAge"), height_cm: num("npHeight"),
    });
    const d = await api("/api/diet/profiles");
    state.profiles = d.profiles;
    state.profileId = r.id;
    localStorage.setItem("dietProfileId", r.id);
    renderProfileSelect();
    setVal("npName", ""); setVal("npAge", ""); setVal("npHeight", "");
    await reload();
    toast("プロフィールを追加しました");
  } catch (e) { toast(e.message); }
}
