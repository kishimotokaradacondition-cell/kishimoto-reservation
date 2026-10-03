/* ── サルコペニア簡易評価 画面の動き ──────────────────────────
   役割:
     1. 入力中の自動計算（SARC-F 合計・歩行速度・ASM/SMI）
     2. InBody 画像のプレビューと縮小
     3. サーバーへ送信（判定のみ / 判定して保存）
     4. 判定結果・前回比の表示
     5. 履歴の一覧・呼び出し・削除・再評価
   判定の計算そのものはサーバー側 criteria.py が行い、この JS は表示に専念します。 */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const form = $("assess-form");

  let imageBlob = null;          // 送信する画像（縮小済み）
  let imagePreviewUrl = null;    // プレビュー用 URL
  let currentId = null;          // 表示中の保存済み記録の ID（未保存なら null）
  let currentAssessment = null;  // 表示中の記録（再評価の引き継ぎ用）

  // ── 共通 ───────────────────────────────────────────────
  function num(id) {
    const v = ($(id).value || "").trim();
    if (v === "") return null;
    const f = parseFloat(v);
    return Number.isFinite(f) ? f : null;
  }
  function fmt(v, digits = 1) {
    if (v === null || v === undefined || v === "") return "―";
    const n = Number(v);
    return Number.isFinite(n) ? n.toFixed(digits) : String(v);
  }
  function fmtDate(s) {
    if (!s) return "";
    return s.replace(/-/g, "/").slice(0, 16);
  }
  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  let toastTimer = null;
  function toast(msg, isError = false) {
    const el = $("toast");
    el.textContent = msg;
    el.className = "show" + (isError ? " error" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = ""; }, 3200);
  }
  async function api(url, opts = {}) {
    const res = await fetch(url, { credentials: "include", ...opts });
    if (res.status === 401) { window.location.href = "/login"; throw new Error("ログインが必要です"); }
    let data = {};
    try { data = await res.json(); } catch (_) { /* 本文なし */ }
    if (!res.ok) throw new Error(data.error || `エラー (${res.status})`);
    return data;
  }

  // ── 1. 自動計算 ────────────────────────────────────────
  function updateSarcf() {
    let total = 0, answered = 0;
    form.querySelectorAll(".sarcf-input:checked").forEach((el) => { total += Number(el.value); answered++; });
    $("sarcf-total").textContent = answered === 5 ? `${total} 点` : `未回答あり（${answered}/5 問）`;
  }
  function updateGait() {
    const dist = parseFloat($("gait_distance").value);
    const sec = num("gait_sec");
    if (sec && sec > 0) {
      const ms = dist / sec;
      $("gait_speed_ms").value = ms.toFixed(2);
      $("gait-calc").textContent = `歩行速度: ${ms.toFixed(2)} m/秒`;
    } else {
      $("gait_speed_ms").value = "";
      $("gait-calc").textContent = "歩行速度: ―";
    }
  }
  function updateAsm() {
    const limbs = ["arm_r_kg", "arm_l_kg", "leg_r_kg", "leg_l_kg"].map(num);
    const h = num("height_cm");
    let text = "四肢骨格筋量 (ASM): ― ／ SMI: ―";
    if (limbs.every((v) => v !== null)) {
      const asm = limbs.reduce((a, b) => a + b, 0);
      let smiText = "―（身長を入力）";
      if (h && h > 0) smiText = (asm / Math.pow(h / 100, 2)).toFixed(2) + " kg/m²";
      text = `四肢骨格筋量 (ASM): ${asm.toFixed(2)} kg ／ SMI: ${smiText}`;
    }
    const direct = num("smi");
    if (direct !== null) text += `　→ 直接入力の SMI ${direct.toFixed(2)} を使用`;
    $("asm-calc").textContent = text;
  }
  form.addEventListener("change", (e) => { if (e.target.classList.contains("sarcf-input")) updateSarcf(); });
  ["gait_distance", "gait_sec"].forEach((id) => $(id).addEventListener("input", updateGait));
  $("gait_distance").addEventListener("change", updateGait);
  ["arm_r_kg", "arm_l_kg", "leg_r_kg", "leg_l_kg", "height_cm", "smi"].forEach((id) => $(id).addEventListener("input", updateAsm));

  // ── 2. 画像 ────────────────────────────────────────────
  async function shrinkImage(file, maxSide = 1600, quality = 0.85) {
    // スマホ写真(3〜5MB)を長辺1600pxのJPEGに縮小して保存容量を抑える。
    // HEIC などブラウザが描けない形式は、そのまま送る（サーバー側で受け付ける）。
    try {
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
      const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      canvas.getContext("2d").drawImage(bmp, 0, 0, w, h);
      const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", quality));
      return blob || file;
    } catch (_) {
      return file;
    }
  }
  function clearImage() {
    imageBlob = null;
    if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl);
    imagePreviewUrl = null;
    $("inbody_image").value = "";
    $("preview-img").removeAttribute("src");
    $("preview-wrap").classList.add("hidden");
  }
  $("inbody_image").addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) { clearImage(); return; }
    if (!file.type.startsWith("image/")) { toast("画像ファイルを選んでください", true); clearImage(); return; }
    imageBlob = await shrinkImage(file);
    if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl);
    imagePreviewUrl = URL.createObjectURL(imageBlob);
    $("preview-img").src = imagePreviewUrl;
    $("preview-meta").textContent = `${file.name}（${(file.size / 1024 / 1024).toFixed(1)}MB → 送信 ${(imageBlob.size / 1024).toFixed(0)}KB）`;
    $("preview-wrap").classList.remove("hidden");
  });
  $("clear-image").addEventListener("click", clearImage);

  // ── 3. 送信 ────────────────────────────────────────────
  function validate() {
    if (!$("patient_name").value.trim()) { toast("お名前を入力してください", true); $("patient_name").focus(); return false; }
    if (!form.querySelector('input[name="sex"]:checked')) { toast("性別を選択してください", true); return false; }
    return true;
  }
  function formAsObject() {
    const obj = {};
    new FormData(form).forEach((v, k) => { if (!(v instanceof File)) obj[k] = v; });
    return obj;
  }
  function formAsMultipart() {
    const fd = new FormData(form);
    fd.delete("inbody_image");
    if (imageBlob) fd.append("inbody_image", imageBlob, imageBlob.type === "image/jpeg" ? "inbody.jpg" : "inbody");
    return fd;
  }
  function setBusy(busy) {
    $("submit-btn").disabled = busy;
    $("preview-btn").disabled = busy;
    $("submit-btn").textContent = busy ? "送信中…" : "判定して保存する";
  }

  $("preview-btn").addEventListener("click", async () => {
    if (!validate()) return;
    setBusy(true);
    try {
      const data = await api("/api/evaluate", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(formAsObject()),
      });
      renderResult({
        patient_name: $("patient_name").value.trim(),
        created_at: null,
        result: data.result,
        image_url: imagePreviewUrl,
        previous: null,
      }, { saved: false });
      toast("判定しました（未保存）");
    } catch (e) { toast(e.message, true); }
    finally { setBusy(false); }
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!validate()) return;
    setBusy(true);
    try {
      const data = await api("/api/assessments", { method: "POST", body: formAsMultipart() });
      renderResult(data.assessment, { saved: true });
      toast("保存しました");
      loadHistory();
      loadNames();
    } catch (e) { toast(e.message, true); }
    finally { setBusy(false); }
  });

  $("reset-btn").addEventListener("click", () => {
    form.reset();
    clearImage();
    updateSarcf(); updateGait(); updateAsm();
    $("result-card").classList.add("hidden");
    currentId = null; currentAssessment = null;
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  // ── 4. 結果表示 ────────────────────────────────────────
  // 前回比: 項目キー → 記録のフィールド名と「大きいほど良いか」
  const PREV_MAP = {
    calf:      { field: "calf_cm",         higherIsBetter: true },
    sarcf:     { field: "sarcf_score",     higherIsBetter: false },
    grip:      { field: "grip_kg",         higherIsBetter: true },
    gait:      { field: "gait_speed_ms",   higherIsBetter: true },
    chair:     { field: "chair_stand_sec", higherIsBetter: false },
    smi:       { field: "smi",             higherIsBetter: true },
  };
  function deltaCell(key, value, previous) {
    const m = PREV_MAP[key];
    if (!m || !previous || value === null || value === undefined) return "";
    const prev = previous[m.field];
    if (prev === null || prev === undefined) return "";
    const d = Number(value) - Number(prev);
    if (Math.abs(d) < 0.005) return `<span class="delta-flat">±0</span>`;
    const good = m.higherIsBetter ? d > 0 : d < 0;
    const sign = d > 0 ? "+" : "";
    return `<span class="${good ? "delta-up" : "delta-down"}">${sign}${d.toFixed(2)}</span>`;
  }
  function markCell(low) {
    if (low === true)  return '<span class="mark mark-low">基準未達</span>';
    if (low === false) return '<span class="mark mark-ok">基準内</span>';
    return '<span class="mark mark-na">未測定</span>';
  }

  function renderResult(a, { saved }) {
    const r = a.result;
    currentId = saved ? a.id : null;
    currentAssessment = a;

    const badge = $("result-badge");
    badge.textContent = r.label;
    badge.className = "result-badge " + (r.css || "");
    $("result-name").textContent = a.patient_name ? `${a.patient_name} 様` : "";
    $("result-date").textContent = saved ? `記録 No.${a.id}　${fmtDate(a.created_at)}` : "（未保存のプレビュー）";
    $("result-action").textContent = r.action;

    const notes = r.notes || [];
    $("result-notes").classList.toggle("hidden", notes.length === 0);
    $("result-notes-list").innerHTML = notes.map((n) => `<li>${esc(n)}</li>`).join("");

    const unitDigits = { calf: 1, sarcf: 0, sarc_calf: 0, grip: 1, gait: 2, chair: 1, smi: 2 };
    $("criteria-body").innerHTML = r.criteria.map((c) => `
      <tr>
        <td>${esc(c.name)}</td>
        <td class="num">${c.value === null ? "―" : fmt(c.value, unitDigits[c.key] ?? 1) + " " + esc(c.unit)}</td>
        <td>${esc(c.cutoff)}</td>
        <td>${markCell(c.low)}</td>
        <td>${deltaCell(c.key, c.value, a.previous)}</td>
      </tr>`).join("");

    const hasImg = !!a.image_url;
    $("result-image").classList.toggle("hidden", !hasImg);
    $("result-grid").classList.toggle("with-image", hasImg);
    if (hasImg) $("result-img").src = a.image_url; else $("result-img").removeAttribute("src");

    $("delete-btn").classList.toggle("hidden", !saved);
    $("result-card").classList.remove("hidden");
    $("result-card").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // ── 5. 履歴・再評価・削除 ───────────────────────────────
  async function loadHistory() {
    const name = $("history-filter").value.trim();
    try {
      const data = await api("/api/assessments?limit=50" + (name ? "&name=" + encodeURIComponent(name) : ""));
      const items = data.items || [];
      $("history-empty").classList.toggle("hidden", items.length > 0);
      $("history-body").innerHTML = items.map((it) => `
        <tr class="clickable" data-id="${it.id}">
          <td>${esc(fmtDate(it.created_at))}</td>
          <td>${esc(it.patient_name)}</td>
          <td><span class="lv-pill ${esc(it.result_css)}">${esc(it.result_label)}</span></td>
          <td>${fmt(it.smi, 2)}</td>
          <td>${fmt(it.grip_kg, 1)}</td>
          <td>${fmt(it.gait_speed_ms, 2)}</td>
          <td>${fmt(it.chair_stand_sec, 1)}</td>
          <td>${it.has_image ? "📷" : ""}</td>
        </tr>`).join("");
    } catch (e) { toast(e.message, true); }
  }
  $("history-body").addEventListener("click", async (e) => {
    const tr = e.target.closest("tr[data-id]");
    if (!tr) return;
    try {
      const data = await api(`/api/assessments/${tr.dataset.id}`);
      renderResult(data.assessment, { saved: true });
    } catch (err) { toast(err.message, true); }
  });
  $("history-refresh").addEventListener("click", loadHistory);
  let filterTimer = null;
  $("history-filter").addEventListener("input", () => { clearTimeout(filterTimer); filterTimer = setTimeout(loadHistory, 300); });

  async function loadNames() {
    try {
      const data = await api("/api/names");
      $("name-list").innerHTML = (data.names || []).map((n) => `<option value="${esc(n)}"></option>`).join("");
    } catch (_) { /* 候補が出ないだけなので無視 */ }
  }

  $("reassess-btn").addEventListener("click", () => {
    const a = currentAssessment;
    if (!a) return;
    // 未保存プレビューには sex が無いので、リセット前に画面の選択を控えておく
    const sexOnScreen = (form.querySelector('input[name="sex"]:checked') || {}).value;
    form.reset();
    clearImage();
    $("patient_name").value = a.patient_name || "";
    const sex = a.sex || sexOnScreen;
    if (sex) { const el = form.querySelector(`input[name="sex"][value="${sex}"]`); if (el) el.checked = true; }
    if (a.age !== undefined && a.age !== null) $("age").value = a.age;
    if (a.height_cm) $("height_cm").value = a.height_cm;
    if (a.weight_kg) $("weight_kg").value = a.weight_kg;
    updateSarcf(); updateGait(); updateAsm();
    $("result-card").classList.add("hidden");
    currentId = null;
    toast("基本情報を引き継ぎました。測定値を入力してください");
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  $("delete-btn").addEventListener("click", async () => {
    if (!currentId) return;
    if (!confirm(`記録 No.${currentId} を削除します。元に戻せません。よろしいですか？`)) return;
    try {
      await api(`/api/assessments/${currentId}`, { method: "DELETE" });
      toast("削除しました");
      $("result-card").classList.add("hidden");
      currentId = null; currentAssessment = null;
      loadHistory(); loadNames();
    } catch (e) { toast(e.message, true); }
  });

  const logoutBtn = $("logout-btn");
  if (logoutBtn) logoutBtn.addEventListener("click", async () => {
    await fetch("/api/logout", { method: "POST", credentials: "include" });
    window.location.href = "/login";
  });

  // ── 初期化 ─────────────────────────────────────────────
  updateSarcf(); updateGait(); updateAsm();
  loadHistory(); loadNames();
})();
