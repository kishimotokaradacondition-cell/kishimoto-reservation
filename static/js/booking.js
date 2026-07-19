/* ── 状態 ─────────────────────────────────────────── */
const state = {
  currentYear:  new Date().getFullYear(),
  currentMonth: new Date().getMonth(),
  calData:      {},   // { "YYYY-MM-DD": { available: N } }
  selectedDate: null,
  selectedSlot: null,
};

const DOW_JA = ["日","月","火","水","木","金","土"];
const MONTH_JA = (y, m) => `${y}年${m + 1}月`;

function fmtDate(d) {
  const dt = new Date(d + "T00:00:00");
  return `${dt.getFullYear()}年${dt.getMonth()+1}月${dt.getDate()}日（${DOW_JA[dt.getDay()]}）`;
}
function fmtTime(t) {
  return t.slice(0, 5);
}

/* ── トースト ─────────────────────────────────────── */
function toast(msg, ms = 2800) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), ms);
}

/* ── ステップ管理 ─────────────────────────────────── */
function goStep(n) {
  [1,2,3,4,5].forEach(i => {
    document.getElementById(`step${i}`).classList.toggle("hidden", i !== n);
  });
  [1,2,3,4].forEach(i => {
    const ind = document.getElementById(`step${i}-ind`);
    if (!ind) return;
    ind.classList.remove("active","done");
    if (i === n) ind.classList.add("active");
    else if (i < n) ind.classList.add("done");
  });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

/* ── カレンダー読込・描画 ─────────────────────────── */
const SVC = (typeof SERVICE !== "undefined") ? SERVICE : "seitai";

async function loadCalendarData() {
  const res = await fetch(`/api/slots/calendar?service=${SVC}`);
  if (res.ok) state.calData = await res.json();
  renderCalendar();
}

function renderCalendar() {
  const y = state.currentYear;
  const m = state.currentMonth;
  document.getElementById("cal-month-label").textContent = MONTH_JA(y, m);

  const today = new Date();
  today.setHours(0,0,0,0);

  const first = new Date(y, m, 1);
  const last  = new Date(y, m+1, 0);
  const startDow = first.getDay();

  const body = document.getElementById("cal-body");
  body.innerHTML = "";

  // 前月の空白
  for (let i = 0; i < startDow; i++) {
    const el = document.createElement("div");
    el.className = "cal-day other-month";
    body.appendChild(el);
  }

  for (let d = 1; d <= last.getDate(); d++) {
    const dt = new Date(y, m, d);
    const iso = `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const info = state.calData[iso] || { available: 0 };
    const isPast = dt < today;

    const el = document.createElement("div");
    el.className = "cal-day";
    el.innerHTML = `<span class="day-num">${d}</span>`;

    if (dt.getTime() === today.getTime()) el.classList.add("today");

    if (isPast || info.available === 0) {
      el.classList.add(isPast ? "past" : "no-slots");
    } else {
      el.classList.add("has-slots");
      const dot = document.createElement("div");
      dot.className = "dot";
      el.appendChild(dot);
      el.addEventListener("click", () => selectDate(iso));
    }

    if (state.selectedDate === iso) el.classList.add("selected");

    body.appendChild(el);
  }
}

function selectDate(iso) {
  state.selectedDate = iso;
  renderCalendar();
  loadTimeSlots(iso);
}

/* ── 時間帯 ───────────────────────────────────────── */
async function loadTimeSlots(iso) {
  const res = await fetch(`/api/slots?date=${iso}&service=${SVC}`);
  const slots = await res.json();

  document.getElementById("selected-date-label").textContent = fmtDate(iso);
  const grid = document.getElementById("time-grid");
  grid.innerHTML = "";

  if (!slots.length) {
    grid.innerHTML = '<p style="grid-column:1/-1;color:var(--muted);font-size:13px">この日の空き枠がありません</p>';
  } else {
    slots.forEach(s => {
      const btn = document.createElement("button");
      btn.className = "time-btn";
      const isLate = SVC === "seitai" && s.time >= "18:00";
      btn.innerHTML = `${fmtTime(s.time)}<small>${s.duration}分</small>${isLate ? '<span class="weekday-label">平日のみ</span>' : ''}`;
      btn.addEventListener("click", () => {
        document.querySelectorAll(".time-btn").forEach(b => b.classList.remove("selected"));
        btn.classList.add("selected");
        state.selectedSlot = s;
        // 時間選択後すぐにお客様情報ステップへ進む
        const dtLabel = `${fmtDate(s.date)} ${fmtTime(s.time)}〜`;
        document.getElementById("selected-datetime-label").textContent = dtLabel;
        goStep(3);
      });
      grid.appendChild(btn);
    });
  }

  goStep(2);
}

/* ── 月ナビ ───────────────────────────────────────── */
document.getElementById("prev-month").addEventListener("click", () => {
  state.currentMonth--;
  if (state.currentMonth < 0) { state.currentMonth = 11; state.currentYear--; }
  renderCalendar();
});
document.getElementById("next-month").addEventListener("click", () => {
  state.currentMonth++;
  if (state.currentMonth > 11) { state.currentMonth = 0; state.currentYear++; }
  renderCalendar();
});

/* ── 確認画面へ ───────────────────────────────────── */
function goConfirm() {
  if (!state.selectedSlot) {
    toast("時間帯を選択してください"); return;
  }
  const name  = document.getElementById("input-name").value.trim();
  const phone = document.getElementById("input-phone").value.trim();
  const email = document.getElementById("input-email").value.trim();
  if (!name)  { toast("お名前を入力してください"); return; }
  if (!phone) { toast("電話番号を入力してください"); return; }
  if (!email) { toast("メールアドレスを入力してください"); return; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { toast("正しいメールアドレスを入力してください"); return; }

  const dtLabel = `${fmtDate(state.selectedSlot.date)} ${fmtTime(state.selectedSlot.time)}〜`;
  document.getElementById("selected-datetime-label").textContent = dtLabel;
  document.getElementById("confirm-datetime").textContent = dtLabel;
  document.getElementById("confirm-name").textContent  = name;
  document.getElementById("confirm-phone").textContent = phone;

  // メールアドレス
  const emailRow = document.getElementById("confirm-email-row");
  if (email) {
    document.getElementById("confirm-email").textContent = email;
    emailRow.style.display = "";
  } else {
    emailRow.style.display = "none";
  }

  // ご要望（任意）
  const note = document.getElementById("input-note").value.trim();
  const noteRow = document.getElementById("confirm-note-row");
  if (note) {
    document.getElementById("confirm-note").textContent = note;
    noteRow.style.display = "";
  } else {
    noteRow.style.display = "none";
  }

  goStep(4);
}

/* ── 予約送信 ─────────────────────────────────────── */
const SUBMIT_LABEL = document.getElementById("submit-btn").textContent;

async function submitReservation() {
  const btn = document.getElementById("submit-btn");
  btn.disabled = true;
  btn.textContent = "送信中...";

  try {
    const res = await fetch("/api/reservations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slot_id:        state.selectedSlot.id,
        customer_name:  document.getElementById("input-name").value.trim(),
        customer_phone: document.getElementById("input-phone").value.trim(),
        customer_email: document.getElementById("input-email").value.trim(),
        customer_note:  document.getElementById("input-note").value.trim(),
      }),
    });
    const data = await res.json();

    if (!res.ok) {
      toast("❌ " + (data.error || "エラーが発生しました"));
      btn.disabled = false;
      btn.textContent = SUBMIT_LABEL;
      return;
    }

    // 事前決済が必要な場合はStripeの決済ページへ移動
    if (data.payment_required && data.checkout_url) {
      btn.textContent = "決済ページへ移動中...";
      window.location.href = data.checkout_url;
      return;
    }

    document.getElementById("done-datetime").textContent =
      `${fmtDate(data.date)} ${fmtTime(data.time)}〜`;
    document.getElementById("done-name").textContent  = data.customer_name;
    document.getElementById("done-phone").textContent =
      document.getElementById("input-phone").value.trim();
    document.getElementById("done-id").textContent = `No.${data.reservation_id}`;

    goStep(5);
  } catch {
    toast("通信エラーが発生しました");
    btn.disabled = false;
    btn.textContent = SUBMIT_LABEL;
  }
}

/* ── リセット ─────────────────────────────────────── */
function resetAll() {
  state.selectedDate = null;
  state.selectedSlot = null;
  document.getElementById("input-name").value  = "";
  document.getElementById("input-phone").value = "";
  document.getElementById("input-email").value = "";
  document.getElementById("input-note").value  = "";
  loadCalendarData();
  goStep(1);
}

/* ── 起動 ─────────────────────────────────────────── */
loadCalendarData();
goStep(1);
