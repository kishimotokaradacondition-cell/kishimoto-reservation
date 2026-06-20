/* ── 状態 ─────────────────────────────────────────── */
const state = {
  year:  new Date().getFullYear(),
  month: new Date().getMonth(),
  calData:   [],   // slots for current month
  holidays:  {},   // { "YYYY-MM-DD": "祝日名" }
  selectedDay: null,
  addMode: "single",
  addDayPreset: null,
};

const DOW_JA = ["日","月","火","水","木","金","土"];
// きしもとカラダ整体 基本時間帯（施術45分）
const PRESET_TIMES = [
  "11:15", "12:15", "13:15", "14:15", "15:30", "17:00", "18:00", "19:00",
];
const SLOT_DURATION = 45;

function monthKey() {
  return `${state.year}-${String(state.month+1).padStart(2,"0")}`;
}
function fmtDate(d) {
  const dt = new Date(d + "T00:00:00");
  return `${dt.getMonth()+1}/${dt.getDate()}（${DOW_JA[dt.getDay()]}）`;
}
function fmtTime(t) { return t.slice(0,5); }

/* ── トースト ─────────────────────────────────────── */
function toast(msg, ms = 2800) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), ms);
}

/* ── タブ切替 ─────────────────────────────────────── */
function switchTab(tab) {
  document.querySelectorAll(".tab-btn").forEach(b => {
    b.classList.toggle("active", b.dataset.tab === tab);
  });
  document.getElementById("tab-slots").classList.toggle("hidden", tab !== "slots");
  document.getElementById("tab-reservations").classList.toggle("hidden", tab !== "reservations");
  if (tab === "reservations") loadReservations();
}

/* ── 月ナビ ───────────────────────────────────────── */
function changeMonth(delta) {
  state.month += delta;
  if (state.month < 0)  { state.month = 11; state.year--; }
  if (state.month > 11) { state.month = 0;  state.year++; }
  state.selectedDay = null;
  document.getElementById("day-slots-panel").classList.add("hidden");
  loadAdminCalendar();
}

/* ── カレンダー読込・描画 ─────────────────────────── */
async function loadAdminCalendar() {
  const mk = monthKey();
  document.getElementById("admin-month-label").textContent =
    `${state.year}年${state.month+1}月`;

  const [calRes, holRes] = await Promise.all([
    fetch(`/api/admin/calendar?month=${mk}`, { credentials: "include" }),
    fetch(`/api/holidays?month=${mk}`),
  ]);
  state.calData  = calRes.ok  ? await calRes.json()  : [];
  state.holidays = holRes.ok  ? await holRes.json()  : {};
  renderAdminCalendar();
}

function slotsByDate() {
  const map = {};
  state.calData.forEach(s => {
    if (!map[s.date]) map[s.date] = [];
    map[s.date].push(s);
  });
  return map;
}

function renderAdminCalendar() {
  const y = state.year, m = state.month;
  const today = new Date(); today.setHours(0,0,0,0);
  const first = new Date(y, m, 1);
  const last  = new Date(y, m+1, 0);
  const map   = slotsByDate();

  const body = document.getElementById("admin-cal-body");
  body.innerHTML = "";

  for (let i = 0; i < first.getDay(); i++) {
    body.appendChild(Object.assign(document.createElement("div"), { className: "admin-cal-day", style: "cursor:default;opacity:.3" }));
  }

  for (let d = 1; d <= last.getDate(); d++) {
    const iso = `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const slots = map[iso] || [];
    const avail  = slots.filter(s => s.is_available && !s.booked).length;
    const booked = slots.filter(s => s.booked).length;

    const el = document.createElement("div");
    el.className = "admin-cal-day";
    if (iso === state.selectedDay) el.style.background = "var(--primary-lt)";

    const holName = state.holidays[iso] || "";
    let html = `<div class="day-label">${d}${holName ? `<span style="font-size:9px;color:#e47300;margin-left:3px">祝</span>` : ""}</div>`;
    if (holName) html += `<span class="badge" style="background:#fff3e0;color:#e47300;font-size:9px">${holName}</span>`;
    if (avail)   html += `<span class="badge badge-avail">空${avail}</span>`;
    if (booked)  html += `<span class="badge badge-booked">予${booked}</span>`;
    el.innerHTML = html;

    el.addEventListener("click", () => showDaySlots(iso));
    body.appendChild(el);
  }
}

/* ── 日付クリック: 枠一覧 ────────────────────────── */
function showDaySlots(iso) {
  state.selectedDay = iso;
  renderAdminCalendar();

  const slots = (slotsByDate()[iso] || []).sort((a,b) => a.time.localeCompare(b.time));
  document.getElementById("day-slots-title").textContent = fmtDate(iso) + " の予約枠";
  document.getElementById("day-add-btn").dataset.iso = iso;

  const list = document.getElementById("day-slot-list");
  list.innerHTML = "";

  if (!slots.length) {
    list.innerHTML = '<li style="color:var(--muted);font-size:13px;padding:8px">この日の枠はありません</li>';
  } else {
    slots.forEach(s => {
      const li = document.createElement("li");
      li.className = "slot-item" + (s.booked ? " booked" : (!s.is_available ? " unavail" : ""));

      let statusTag = s.booked
        ? '<span class="tag" style="background:#fdecea;color:#c33">予約済</span>'
        : (s.is_available
            ? '<span class="tag tag-confirmed">空き</span>'
            : '<span class="tag" style="background:#eee;color:#999">非公開</span>');

      li.innerHTML = `
        <div>
          <span style="font-weight:700;font-size:15px">${fmtTime(s.time)}</span>
          <span style="font-size:12px;color:var(--muted);margin-left:6px">${s.duration}分</span>
          ${statusTag}
        </div>
        <div style="display:flex;gap:6px">
          ${s.booked
            ? `<button class="btn btn-sm" style="background:#fdecea;color:#c33;border:none" onclick="viewBooking(${s.id})">予約詳細</button>`
            : (s.is_available
                ? `<button class="btn btn-outline btn-sm" onclick="toggleAvail(${s.id}, 0)">非公開に</button>`
                : `<button class="btn btn-primary btn-sm" onclick="toggleAvail(${s.id}, 1)">公開する</button>`)
          }
          ${!s.booked ? `<button class="btn btn-sm" style="background:#fee;color:#d44;border:none" onclick="deleteSlot(${s.id})">削除</button>` : ""}
        </div>`;
      list.appendChild(li);
    });
  }

  document.getElementById("day-slots-panel").classList.remove("hidden");
}

/* ── 空き状態トグル ───────────────────────────────── */
async function toggleAvail(id, val) {
  await fetch(`/api/admin/slots/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ is_available: val }),
  });
  toast(val ? "公開しました" : "非公開にしました");
  await loadAdminCalendar();
  if (state.selectedDay) showDaySlots(state.selectedDay);
}

/* ── 枠削除 ───────────────────────────────────────── */
async function deleteSlot(id) {
  if (!confirm("この枠を削除しますか？")) return;
  const res = await fetch(`/api/admin/slots/${id}`, {
    method: "DELETE", credentials: "include"
  });
  const data = await res.json();
  if (!res.ok) { toast("❌ " + data.error); return; }
  toast("削除しました");
  await loadAdminCalendar();
  if (state.selectedDay) showDaySlots(state.selectedDay);
}

/* ── 予約詳細 ─────────────────────────────────────── */
async function viewBooking(slotId) {
  const res = await fetch("/api/admin/reservations", { credentials: "include" });
  const all = await res.json();
  const r   = all.find(x => x.slot_id === slotId || x.date === state.selectedDay);

  if (!r) { toast("予約情報が見つかりません"); return; }

  document.getElementById("slot-modal-title").textContent = "予約詳細";
  document.getElementById("slot-modal-body").innerHTML = `
    <dl>
      <div class="confirm-row"><dt>日時</dt><dd>${fmtDate(r.date)} ${fmtTime(r.time)}</dd></div>
      <div class="confirm-row"><dt>お名前</dt><dd>${r.customer_name}</dd></div>
      <div class="confirm-row"><dt>電話番号</dt><dd>${r.customer_phone}</dd></div>
      ${r.customer_note ? `<div class="confirm-row"><dt>ご要望</dt><dd>${r.customer_note}</dd></div>` : ""}
      <div class="confirm-row"><dt>予約日時</dt><dd>${r.created_at.slice(0,16)}</dd></div>
    </dl>
    <button class="btn btn-danger" style="margin-top:16px" onclick="cancelReservation(${r.id})">
      この予約をキャンセルする
    </button>`;
  document.getElementById("slot-modal").classList.remove("hidden");
}

async function cancelReservation(id) {
  if (!confirm("この予約をキャンセルしますか？")) return;
  await fetch(`/api/admin/reservations/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ status: "cancelled" }),
  });
  toast("キャンセルしました");
  closeSlotModal();
  await loadAdminCalendar();
  if (state.selectedDay) showDaySlots(state.selectedDay);
}

function closeSlotModal() {
  document.getElementById("slot-modal").classList.add("hidden");
}

/* ── 予約一覧 ─────────────────────────────────────── */
async function loadReservations() {
  const res = await fetch("/api/admin/reservations", { credentials: "include" });
  const list = await res.json();
  const el = document.getElementById("res-content");

  if (!list.length) {
    el.innerHTML = '<div style="text-align:center;color:var(--muted);padding:40px">確定済みの予約はありません</div>';
    return;
  }

  el.innerHTML = `
    <div style="overflow-x:auto">
    <table class="res-table">
      <thead><tr>
        <th>日付</th><th>時間</th><th>お名前</th><th>電話番号</th><th>ご要望</th><th></th>
      </tr></thead>
      <tbody>
        ${list.map(r => `
          <tr>
            <td>${fmtDate(r.date)}</td>
            <td>${fmtTime(r.time)}</td>
            <td style="font-weight:600">${r.customer_name}</td>
            <td>${r.customer_phone}</td>
            <td style="font-size:12px;color:var(--muted)">${r.customer_note || "—"}</td>
            <td><button class="btn btn-sm" style="background:#fee;color:#d44;border:none;white-space:nowrap"
                onclick="cancelReservation(${r.id})">ｷｬﾝｾﾙ</button></td>
          </tr>`).join("")}
      </tbody>
    </table>
    </div>`;
}

/* ── 枠追加モーダル ───────────────────────────────── */
function openAddModal() {
  state.addDayPreset = null;
  document.getElementById("add-date").value = "";
  document.getElementById("add-time").value = "10:00";
  document.getElementById("add-modal-error").style.display = "none";
  setAddMode("single");
  document.getElementById("add-modal").classList.remove("hidden");
}

function openAddModalForDay() {
  const iso = state.selectedDay;
  state.addDayPreset = iso;
  document.getElementById("add-date").value = iso;
  document.getElementById("bulk-start").value = iso;
  document.getElementById("bulk-end").value   = iso;
  document.getElementById("add-modal-error").style.display = "none";
  setAddMode("single");
  document.getElementById("add-modal").classList.remove("hidden");
}

function closeAddModal() {
  document.getElementById("add-modal").classList.add("hidden");
}

function setAddMode(mode) {
  state.addMode = mode;
  document.getElementById("add-single").classList.toggle("hidden", mode !== "single");
  document.getElementById("add-bulk").classList.toggle("hidden", mode !== "bulk");
  document.getElementById("add-mode-single").classList.toggle("btn-primary", mode === "single");
  document.getElementById("add-mode-single").classList.toggle("btn-outline", mode !== "single");
  document.getElementById("add-mode-bulk").classList.toggle("btn-primary", mode === "bulk");
  document.getElementById("add-mode-bulk").classList.toggle("btn-outline", mode !== "bulk");

  if (mode === "bulk" && !document.getElementById("time-checkboxes").children.length) {
    buildTimeCheckboxes();
  }
}

function buildTimeCheckboxes() {
  const box = document.getElementById("time-checkboxes");
  box.innerHTML = "";
  PRESET_TIMES.forEach((t, i) => {
    const label = document.createElement("label");
    label.style.cssText = "display:flex;align-items:center;gap:4px;font-size:14px;font-weight:400;cursor:pointer;padding:6px 8px;border:1.5px solid var(--border);border-radius:8px;justify-content:center";
    label.innerHTML = `<input type="radio" name="bulk-time" value="${t}" style="accent-color:var(--primary)"> ${t}`;
    box.appendChild(label);
  });
  // 最初の選択肢をデフォルト選択
  const first = box.querySelector('input[type="radio"]');
  if (first) first.checked = true;

  // 選択時にラベルのスタイルを更新
  box.addEventListener("change", () => {
    box.querySelectorAll("label").forEach(l => {
      l.style.borderColor = l.querySelector("input").checked ? "var(--primary)" : "var(--border)";
      l.style.background  = l.querySelector("input").checked ? "var(--primary-lt)" : "";
    });
  });
  // 初期スタイル
  const firstLabel = box.querySelector("label");
  if (firstLabel) { firstLabel.style.borderColor = "var(--primary)"; firstLabel.style.background = "var(--primary-lt)"; }
}

async function submitAddSlot() {
  const errEl = document.getElementById("add-modal-error");
  errEl.style.display = "none";

  let slots = [];

  if (state.addMode === "single") {
    const date = document.getElementById("add-date").value;
    const time = document.getElementById("add-time").value;
    if (!date || !time) { errEl.textContent = "日付と時間を入力してください"; errEl.style.display = "block"; return; }
    slots = [{ date, time: time + ":00", duration: SLOT_DURATION }];
  } else {
    const start = document.getElementById("bulk-start").value;
    const end   = document.getElementById("bulk-end").value;
    const dows  = [...document.querySelectorAll("#dow-checkboxes input:checked")].map(x => parseInt(x.value));
    const selTime = document.querySelector("#time-checkboxes input[type='radio']:checked")?.value;

    if (!start || !end)  { errEl.textContent = "期間を入力してください"; errEl.style.display = "block"; return; }
    if (!dows.length)    { errEl.textContent = "曜日を1つ以上選択してください"; errEl.style.display = "block"; return; }
    if (!selTime)        { errEl.textContent = "時間帯を選択してください"; errEl.style.display = "block"; return; }

    let cur = new Date(start + "T00:00:00");
    const last = new Date(end + "T00:00:00");
    while (cur <= last) {
      if (dows.includes(cur.getDay())) {
        const y = cur.getFullYear();
        const mo = String(cur.getMonth() + 1).padStart(2, "0");
        const d  = String(cur.getDate()).padStart(2, "0");
        slots.push({ date: `${y}-${mo}-${d}`, time: selTime + ":00", duration: SLOT_DURATION });
      }
      cur.setDate(cur.getDate() + 1);
    }
    if (!slots.length) { errEl.textContent = "条件に合う日程がありません"; errEl.style.display = "block"; return; }
  }

  const holidayAdjust = state.addMode === "bulk"
    ? (document.getElementById("holiday-adjust")?.checked ?? true)
    : false;

  const res = await fetch("/api/admin/slots", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ slots, holiday_adjust: holidayAdjust }),
  });
  const data = await res.json();
  if (!res.ok) { errEl.textContent = data.error || "エラー"; errEl.style.display = "block"; return; }

  toast(`✅ ${data.inserted}枠を追加しました`);
  closeAddModal();
  await loadAdminCalendar();
  if (state.selectedDay) showDaySlots(state.selectedDay);
}

/* ── ログアウト ───────────────────────────────────── */
async function doLogout() {
  await fetch("/api/admin/logout", { method: "POST", credentials: "include" });
  window.location.href = "/admin/login";
}

/* ── 起動 ─────────────────────────────────────────── */
loadAdminCalendar();
