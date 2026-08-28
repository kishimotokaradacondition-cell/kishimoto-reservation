/* 回内足 分析・提案アプリ 本体 */
(function () {
  "use strict";
  const D = PRONATION_DATA;
  const $ = (id) => document.getElementById(id);
  const CLINIC = "きしもとカラダcondiTion";
  const CLINIC_INFO = "神戸市垂水区舞子｜TEL 078-785-5251";
  const LS_KEY = "pronationRecords";

  /* ---------- 初期描画 ---------- */
  // スポーツ
  const sportSel = $("pSport");
  Object.entries(D.sports).forEach(([k, v]) => {
    const o = document.createElement("option");
    o.value = k; o.textContent = v.label;
    sportSel.appendChild(o);
  });
  sportSel.value = "other";

  // 痛み部位チップ
  const painChips = $("painChips");
  Object.entries(D.painSites).forEach(([k, v]) => {
    const c = document.createElement("span");
    c.className = "chip"; c.dataset.key = k; c.textContent = v.label;
    c.onclick = () => {
      if (k === "none") {
        painChips.querySelectorAll(".chip").forEach(x => x.classList.remove("sel"));
        c.classList.add("sel");
      } else {
        painChips.querySelector('[data-key="none"]').classList.remove("sel");
        c.classList.toggle("sel");
      }
    };
    painChips.appendChild(c);
  });

  // レッドフラグ
  const rfList = $("redflagList");
  D.redFlags.forEach(rf => {
    const l = document.createElement("label");
    l.className = "check redflag";
    l.innerHTML = `<span style="display:flex;gap:8px;align-items:flex-start"><input type="checkbox" data-rf="${rf.id}"><span>${rf.label}</span></span><span class="rf-note">${rf.note}</span>`;
    l.querySelector("input").onchange = e => l.classList.toggle("checked", e.target.checked);
    rfList.appendChild(l);
  });

  // FPI-6 テーブル
  const fpiBody = $("fpiTable").querySelector("tbody");
  D.fpi6Items.forEach(item => {
    const tr = document.createElement("tr");
    const mkSel = side => {
      const s = document.createElement("select");
      s.dataset.fpi = item.id; s.dataset.side = side;
      [-2, -1, 0, 1, 2].forEach(v => {
        const o = document.createElement("option");
        o.value = v; o.textContent = (v > 0 ? "+" : "") + v;
        if (v === 0) o.selected = true;
        s.appendChild(o);
      });
      s.onchange = updateFpi;
      return s;
    };
    const td0 = document.createElement("td");
    td0.innerHTML = `${item.label}<div class="hint">${item.hint}</div>`;
    tr.appendChild(td0);
    [ "L", "R" ].forEach(side => {
      const td = document.createElement("td");
      td.appendChild(mkSel(side));
      tr.appendChild(td);
    });
    fpiBody.appendChild(tr);
  });
  function fpiTotal(side) {
    let t = 0;
    document.querySelectorAll(`select[data-side="${side}"]`).forEach(s => t += Number(s.value));
    return t;
  }
  function updateFpi() {
    $("fpiL").textContent = fmtSigned(fpiTotal("L"));
    $("fpiR").textContent = fmtSigned(fpiTotal("R"));
  }
  const fmtSigned = v => (v > 0 ? "+" + v : String(v));

  /* ---------- ステップ移動 ---------- */
  const secs = ["sec1", "sec2", "sec3", "sec4"];
  function show(step) {
    secs.forEach((id, i) => $(id).classList.toggle("hidden", i !== step - 1));
    $("secRecords").classList.add("hidden");
    document.querySelectorAll(".step").forEach(el => {
      const n = Number(el.dataset.step);
      el.classList.toggle("active", n === step);
      el.classList.toggle("done", n < step);
    });
    window.scrollTo(0, 0);
  }
  $("to2").onclick = () => {
    if (!$("pName").value.trim() || !$("pAge").value) { alert("お名前と年齢を入力してください。"); return; }
    show(2);
  };
  $("back1").onclick = () => show(1);
  $("to3").onclick = () => show(3);
  $("back2").onclick = () => show(2);
  $("back3").onclick = () => show(3);
  $("btnRecords").onclick = () => { secs.forEach(id => $(id).classList.add("hidden")); renderRecords(); $("secRecords").classList.remove("hidden"); };
  $("closeRecords").onclick = () => { $("secRecords").classList.add("hidden"); show(current ? 4 : 1); };

  /* ---------- 入力の収集 ---------- */
  function collect() {
    const pains = [...painChips.querySelectorAll(".chip.sel")].map(c => c.dataset.key);
    const flags = [...document.querySelectorAll("input[data-rf]:checked")].map(i => i.dataset.rf);
    const num = id => { const v = $(id).value; return v === "" ? null : Number(v); };
    return {
      date: new Date().toISOString().slice(0, 10),
      name: $("pName").value.trim(),
      age: Number($("pAge").value),
      sex: $("pSex").value,
      sport: sportSel.value,
      sportName: $("pSportName").value.trim(),
      hours: num("pHours"),
      pains: pains.length ? pains : ["none"],
      nrs: { rest: num("nrsRest") || 0, walk: num("nrsWalk") || 0, sport: num("nrsSport") || 0 },
      habits: { single: $("hSingle").checked, wsit: $("hWsit").checked, noBarefoot: $("hBarefoot").checked, shoes: $("hShoes").checked },
      redflags: flags,
      fpi: { L: fpiTotal("L"), R: fpiTotal("R") },
      nav: { L: num("navL"), R: num("navR") },
      kneeWall: { L: num("kwL"), R: num("kwR") },
      beighton: num("beighton"),
      sls: { L: num("slsL"), R: num("slsR") },
      squat: { L: $("sqL").value, R: $("sqR").value },
      flexArch: $("flexArch").checked,
      reevals: []
    };
  }

  /* ---------- 分析ロジック ---------- */
  function slsNorm(age) {
    if (age <= 5) return 8; if (age <= 9) return 20; if (age <= 11) return 48; return 120;
  }
  function analyze(p) {
    const hasPain = !(p.pains.length === 1 && p.pains[0] === "none");
    const maxNrs = Math.max(p.nrs.rest, p.nrs.walk, p.nrs.sport);
    const fpiMax = Math.max(p.fpi.L, p.fpi.R);
    const navMax = Math.max(p.nav.L ?? 0, p.nav.R ?? 0);
    const findings = [];   // 施術者向けの陽性所見
    if (fpiMax >= 10) findings.push(`FPI-6 ${fmtSigned(fpiMax)}(強い回内: +10以上)`);
    else if (fpiMax >= 6) findings.push(`FPI-6 ${fmtSigned(fpiMax)}(回内: +6〜+9)`);
    if (navMax >= 15) findings.push(`舟状骨落下 ${navMax}mm(著明: >15mm)`);
    else if (navMax >= 10) findings.push(`舟状骨落下 ${navMax}mm(回内: ≥10mm)`);
    if (p.beighton != null && p.beighton >= 6) findings.push(`Beighton ${p.beighton}点(全身弛緩: ≥6)`);
    if (p.squat.L === "poor" || p.squat.R === "poor") findings.push("片脚スクワットで膝内入り・体幹動揺(poor)");
    else if (p.squat.L === "fair" || p.squat.R === "fair") findings.push("片脚スクワットで軽度の膝内入り(fair)");
    const norm = slsNorm(p.age);
    ["L", "R"].forEach(s => {
      if (p.sls[s] != null && p.sls[s] < norm) findings.push(`片脚立位 ${s === "L" ? "左" : "右"} ${p.sls[s]}秒(年齢基準 ${norm}秒未満)`);
    });
    ["L", "R"].forEach(s => {
      if (p.kneeWall[s] != null && p.kneeWall[s] < 10) findings.push(`膝壁テスト ${s === "L" ? "左" : "右"} ${p.kneeWall[s]}cm(<10cmで背屈制限)`);
    });
    if (p.hours != null && p.hours > p.age) findings.push(`週練習時間 ${p.hours}時間 > 年齢(${p.age})=使いすぎリスク OR 2.07`);
    const asym = (p.fpi.L != null && p.fpi.R != null && Math.abs(p.fpi.L - p.fpi.R) >= 4);
    if (asym) findings.push("FPI-6の左右差が大きい(≥4)——片側性でないか確認");

    let type, variant = null;
    if (p.redflags.length > 0 || !p.flexArch) {
      type = "C";
    } else if (p.age < 8 && !hasPain && (p.beighton == null || p.beighton < 6)) {
      type = "A";
    } else if (!hasPain && fpiMax < 6 && navMax < 10 && p.squat.L !== "poor" && p.squat.R !== "poor") {
      type = "A"; variant = "obs"; // 8歳以上だが所見乏しい→経過観察+予防
    } else {
      type = "B";
    }
    const band = p.age <= 12 ? "elementary" : (p.age <= 18 ? "teen" : "adult");
    return { type, variant, band, findings, hasPain, maxNrs, fpiMax, navMax, slsNormVal: norm };
  }

  /* ---------- 結果(院内ビュー) ---------- */
  let current = null;   // {patient, result}

  $("analyze").onclick = () => {
    const p = collect();
    const r = analyze(p);
    current = { patient: p, result: r };
    renderPro(p, r);
    renderHandout(p, r);
    show(4);
  };

  function renderPro(p, r) {
    const t = D.types[r.type];
    const painLabels = p.pains.map(k => D.painSites[k].label).join("、");
    let html = `
      <div class="typeBanner" style="background:${t.color}">
        <h4>${t.name}${r.variant === "obs" ? "(所見乏しい・経過観察+予防)" : ""}</h4>
        <p>${t.definition}</p>
      </div>
      <div class="kv">
        <div class="item"><span>FPI-6 左/右</span><b>${fmtSigned(p.fpi.L)} / ${fmtSigned(p.fpi.R)}</b><span>${D.norms.fpi6}</span></div>
        <div class="item"><span>舟状骨落下 左/右</span><b>${p.nav.L ?? "-"} / ${p.nav.R ?? "-"} mm</b><span>${D.norms.navDrop}</span></div>
        <div class="item"><span>膝壁テスト 左/右</span><b>${p.kneeWall.L ?? "-"} / ${p.kneeWall.R ?? "-"} cm</b><span>${D.norms.kneeWall}</span></div>
        <div class="item"><span>Beighton</span><b>${p.beighton ?? "-"} 点</b><span>${D.norms.beighton}</span></div>
        <div class="item"><span>片脚立位 左/右</span><b>${p.sls.L ?? "-"} / ${p.sls.R ?? "-"} 秒</b><span>年齢基準 ${r.slsNormVal}秒</span></div>
        <div class="item"><span>片脚スクワット 左/右</span><b>${p.squat.L || "-"} / ${p.squat.R || "-"}</b><span>${D.norms.fppa}</span></div>
        <div class="item"><span>痛みNRS(安静/歩行/運動)</span><b>${p.nrs.rest}/${p.nrs.walk}/${p.nrs.sport}</b><span>部位: ${painLabels}</span></div>
        <div class="item ${p.hours != null && p.hours > p.age ? "warn" : ""}"><span>週練習時間</span><b>${p.hours ?? "-"} h</b><span>目安: 時間/週 ≦ 年齢</span></div>
      </div>`;

    if (r.type === "C") {
      const flags = p.redflags.map(id => D.redFlags.find(f => f.id === id)).filter(Boolean);
      html += `<div class="result-block"><h5>該当したレッドフラグ</h5><ul class="flag-list">`;
      if (!p.flexArch) html += `<li>つま先立ち・Jack's testでアーチが出ない(硬性の疑い)</li>`;
      flags.forEach(f => html += `<li>${f.label} — <span class="mini">${f.note}</span></li>`);
      html += `</ul><p class="note">${t.policy}</p></div>`;
    } else {
      html += `<div class="result-block"><h5>陽性所見</h5>` +
        (r.findings.length ? `<ul class="flag-list">${r.findings.map(f => `<li>${f}</li>`).join("")}</ul>`
                           : `<p class="note">明確な陽性所見はありません。</p>`) + `</div>`;
      html += `<div class="result-block"><h5>方針</h5><p class="note">${t.policy}</p></div>`;
      if (r.type === "B") {
        html += `<div class="result-block"><h5>適用プログラム</h5><p class="note">${D.programs[r.band].label}(案B: 足部内在筋+股関節・体幹)。${D.programs[r.band].basis}</p></div>`;
      }
    }
    html += `<div class="result-block"><h5>説明時の言葉のルール(禁止表現→言い換え)</h5>
      <table class="evalTable"><thead><tr><th>使わない表現</th><th>言い換え(根拠あり)</th></tr></thead><tbody>
      ${D.wording.replace.map(w => `<tr><td>${w.ng}</td><td>${w.ok}</td></tr>`).join("")}
      </tbody></table></div>`;
    $("resultPro").innerHTML = html;
  }

  /* ---------- 患者様配布資料 ---------- */
  function fpiGauge(p) {
    // -12〜+12 のゲージに左右のFPI-6をプロット
    const x = v => 20 + ((v + 12) / 24) * 360;
    return `<div class="gauge"><svg viewBox="0 0 400 74" xmlns="http://www.w3.org/2000/svg">
      <rect x="20" y="28" width="360" height="14" rx="7" fill="#e8eef2"/>
      <rect x="${x(0)}" y="28" width="${x(5) - x(0)}" height="14" fill="#a5c8a9"/>
      <rect x="${x(6)}" y="28" width="${x(9) - x(6)}" height="14" fill="#f0c987"/>
      <rect x="${x(10)}" y="28" width="${x(12) - x(10)}" height="14" fill="#e39a8e"/>
      <text x="${x(2.5)}" y="22" font-size="9" text-anchor="middle" fill="#4a6b52">正常 0〜+5</text>
      <text x="${x(7.5)}" y="22" font-size="9" text-anchor="middle" fill="#8a6d3b">回内 +6〜+9</text>
      <text x="${x(11)}" y="22" font-size="9" text-anchor="middle" fill="#9c4438">強い回内</text>
      <circle cx="${x(p.fpi.L)}" cy="35" r="6" fill="#16425b"/>
      <text x="${x(p.fpi.L)}" y="58" font-size="9" text-anchor="middle" fill="#16425b">左 ${fmtSigned(p.fpi.L)}</text>
      <circle cx="${x(p.fpi.R)}" cy="35" r="6" fill="#4d8fb3"/>
      <text x="${x(p.fpi.R)}" y="70" font-size="9" text-anchor="middle" fill="#4d8fb3">右 ${fmtSigned(p.fpi.R)}</text>
      <text x="20" y="58" font-size="8" fill="#7c909c">-12(回外)</text>
      <text x="380" y="58" font-size="8" text-anchor="end" fill="#7c909c">+12(回内)</text>
    </svg></div>`;
  }

  function handoutHeader(p, sub) {
    return `<div class="h-header">
      <div><div class="h-title">${p.name} 様${sub}</div></div>
      <div class="h-clinic">${CLINIC}<br>${CLINIC_INFO}</div></div>
      <div class="h-meta"><span>作成日: <b>${p.date}</b></span><span>年齢: <b>${p.age}歳</b></span>
      <span>スポーツ: <b>${p.sportName || D.sports[p.sport].label}</b></span>
      <span>週練習時間: <b>${p.hours ?? "-"}時間</b></span></div>`;
  }

  function renderHandout(p, r) {
    const t = D.types[r.type];
    const hasPain = r.hasPain;
    let html = "";

    /* ── 1枚目: 結果とメカニズムの説明 ── */
    html += `<div class="h-page">` + handoutHeader(p, " 足の分析結果とご提案");
    html += `<h4>1. 今日の足の評価結果</h4>
      <div class="h-type" style="border-color:${t.color}"><span class="t-name" style="color:${t.color}">${t.name}</span>
      <p>${t.patientMsg}</p></div>`;
    html += `<h5>足の姿勢スコア(FPI-6)</h5>` + fpiGauge(p);
    html += `<table><thead><tr><th>評価項目</th><th>左</th><th>右</th><th>目安</th></tr></thead><tbody>
      <tr><td>舟状骨落下(土踏まずの沈み込み)</td><td>${p.nav.L ?? "-"} mm</td><td>${p.nav.R ?? "-"} mm</td><td>正常 5〜9mm</td></tr>
      <tr><td>足首の柔らかさ(膝壁テスト)</td><td>${p.kneeWall.L ?? "-"} cm</td><td>${p.kneeWall.R ?? "-"} cm</td><td>10cm以上</td></tr>
      <tr><td>片脚立ち</td><td>${p.sls.L ?? "-"} 秒</td><td>${p.sls.R ?? "-"} 秒</td><td>${r.slsNormVal}秒(年齢基準)</td></tr>
      <tr><td>片脚スクワット(膝の内入り)</td><td>${p.squat.L || "-"}</td><td>${p.squat.R || "-"}</td><td>膝が第2趾の上=good</td></tr>
      <tr><td>体の柔らかさ(Beighton)</td><td colspan="2">${p.beighton ?? "-"} / 9点</td><td>6点以上=関節が柔らかい体質</td></tr>
      <tr><td>痛み(0〜10)</td><td colspan="2">安静 ${p.nrs.rest}・歩行 ${p.nrs.walk}・運動 ${p.nrs.sport}</td><td>再評価のたびに記録</td></tr>
    </tbody></table>`;

    if (r.type === "C") {
      html += `<h4>2. まず整形外科での確認をおすすめします</h4>
        <p>今日の確認では、次の所見がありました。</p><ul>`;
      if (!p.flexArch) html += `<li>つま先立ちをしてもアーチ(土踏まず)が出ない</li>`;
      p.redflags.forEach(id => { const f = D.redFlags.find(x => x.id === id); if (f) html += `<li>${f.label}</li>`; });
      html += `</ul>
        <p>これらは、骨のつながり方(足根骨癒合など)や過剰骨(外脛骨)、その他の病態が背景にある可能性を示すサインです。<b>レントゲン・CTなどの画像検査でしか確認できない</b>ため、運動プログラムを始める前に整形外科の受診をおすすめします。</p>
        <div class="h-warn">当院からのお願い: 受診の結果がわかりましたら、お知らせください。診断に合わせて、安全に進められる運動計画を一緒に作ります。当院で骨の形を「矯正」することはありません。</div>`;
      html += handoutFooter();
      html += `</div>`;
      $("handout").innerHTML = html;
      return;
    }

    // タイプA/B: メカニズム説明
    html += `<h4>2. なぜ${hasPain ? "痛みが出ている" : "今のうちにケアする"}のか</h4>`;
    p.pains.forEach(k => {
      const ps = D.painSites[k];
      html += `<h5>${ps.label}</h5><p>${ps.mechanism}</p>`;
      if (ps.kidNote && p.age <= 15) html += `<p class="mini">※ ${ps.kidNote}</p>`;
    });
    const sp = D.sports[p.sport];
    html += `<h5>${sp.label}をされている方へ</h5><p>${sp.note}</p>`;
    if (p.hours != null && p.hours > p.age) {
      html += `<div class="h-warn">週の練習時間(${p.hours}時間)が年齢(${p.age})を超えています。「週の練習時間(時間) ≦ 年齢」が使いすぎによるケガ予防の国際的な目安です。休養日を含めた調整をおすすめします。</div>`;
    }
    html += `<h4>3. 目標——「形を戻す」ではなく「使い方を育てる」</h4>
      <div class="h-goal"><p>装具や手技で骨の形が変わるという根拠はありません。トレーニングで確実に変えられるのは次の3つです。</p>
      <ul><li><b>足で床を押せる</b>(土踏まずの支え: 舟状骨の沈み込みが2〜6mm改善)</li>
      <li><b>膝が内に入らない</b>着地・切り返しの動作</li>
      <li><b>腰で反らずに立てる</b>体幹と股関節の支え</li></ul>
      <p>効果の判定は<b>8週後</b>です。4週で見た目が変わらなくても、それは想定どおりの経過です。</p></div>`;
    html += handoutFooter() + `</div>`;

    /* ── 2枚目: プログラム ── */
    if (r.type === "B" || r.variant === "obs") {
      const prog = D.programs[r.band];
      html += `<div class="h-page">` + handoutHeader(p, " 12週トレーニングプログラム");
      html += `<h4>4. ${prog.label}${r.variant === "obs" ? "(予防・パフォーマンス目的)" : ""}</h4>`;
      html += `<table><thead><tr><th style="width:16%">期間</th><th>院で行うこと(週1回)</th><th>自宅の宿題</th></tr></thead><tbody>`;
      prog.blocks.forEach(b => {
        html += `<tr><td><b>${b.weeks}</b></td>
          <td><ul>${b.clinic.map(x => `<li>${x}</li>`).join("")}</ul></td>
          <td><ul>${b.home.map(x => `<li>${x}</li>`).join("")}</ul><p class="mini">※ ${b.rule}</p></td></tr>`;
      });
      html += `</tbody></table>`;
      html += `<h5>生活のポイント</h5><p>${prog.life}</p>`;
      html += handoutFooter() + `</div>`;

      /* ── 3枚目: 宿題シート+再評価 ── */
      html += `<div class="h-page">` + handoutHeader(p, " 自宅宿題シート");
      html += `<h4>5. 宿題チェック表(できた日に○・シール)</h4>
        <p>目標は<b>週3回以上</b>(毎日3〜5分)。週3回できた週は右端に◎を付けましょう。${p.age <= 12 ? "お家の方は横で「足の指まっすぐ?」と声をかけてあげてください。" : ""}</p>`;
      html += `<table class="hw-grid"><thead><tr><th class="wk">週</th><th>月</th><th>火</th><th>水</th><th>木</th><th>金</th><th>土</th><th>日</th><th>週3回達成</th></tr></thead><tbody>`;
      for (let w = 1; w <= 12; w++) {
        html += `<tr><td class="wk">第${w}週${w === 4 ? "(再評価)" : w === 8 ? "(判定)" : w === 12 ? "(卒業評価)" : ""}</td>${"<td></td>".repeat(7)}<td></td></tr>`;
      }
      html += `</tbody></table>`;
      html += `<h4>6. 再評価の予定と「効いた」の基準</h4>
        <table><thead><tr><th>時期</th><th>確認すること</th><th>目標</th></tr></thead><tbody>
        <tr><td>4週後</td><td>片脚スクワットの膝の位置・片脚立ち・痛み</td><td>フォームの改善(数値はまだ変わらなくてOK)</td></tr>
        <tr><td><b>8週後(判定)</b></td><td>舟状骨落下・FPI-6・痛みNRS</td><td><b>舟状骨落下 -2mm以上/痛み -2以上</b></td></tr>
        <tr><td>12週後</td><td>総合評価</td><td>目標達成→維持期(週2回)へ。3か月ごとに確認</td></tr>
        </tbody></table>
        <div class="h-warn">こんな時はご連絡ください: 運動で痛みが増える/夜間や安静時に痛む/${p.age <= 15 ? "土踏まずの上の骨の出っ張りを押すと強く痛む/" : ""}2週間続けても痛みで練習に参加できない。</div>`;
      if (r.band === "elementary") {
        html += `<h4>7. 保護者の方へ——「子どもの足と姿勢のはなし」</h4><ul>` +
          D.parentPoints.map(x => `<li>${x}</li>`).join("") + `</ul>`;
      }
      html += handoutFooter() + `</div>`;
    } else {
      /* タイプA(8歳未満・無症状): 保護者向け説明のみ */
      html += `<div class="h-page">` + handoutHeader(p, " 保護者の方向けのご案内");
      html += `<h4>4. 今は「治療」ではなく「育てる」時期です</h4>
        <p>${t.policy}</p>
        <h5>お家でできること</h5><ul>
        <li>家の中は裸足で過ごす(裸足の習慣がある子は土踏まずが高く育ちやすい)</li>
        <li>週2日以上、公園などで30分以上の自由遊び(鬼ごっこ・登る・跳ぶ)</li>
        <li>足指じゃんけん(グー・チョキ・パー)を遊びとして</li>
        <li>W座りをやめて、椅子の高さと靴のサイズ(3〜4か月ごと)を確認</li></ul>
        <h4>5. 保護者の方へ——「子どもの足と姿勢のはなし」</h4><ul>` +
        D.parentPoints.map(x => `<li>${x}</li>`).join("") + `</ul>
        <div class="h-warn">こんな時はご相談ください: 痛みを訴える/片足だけ扁平/つま先立ちしても土踏まずが出ない/歩き方が急に変わった。<b>次回の足型チェックは6か月後</b>をおすすめします。</div>`;
      html += handoutFooter() + `</div>`;
    }
    $("handout").innerHTML = html;
  }

  function handoutFooter() {
    return `<div class="h-footer"><span>${CLINIC}｜${CLINIC_INFO}</span>
      <span class="sig">本資料は約90の医学文献に基づく当院の標準プロトコルから作成しています。</span></div>`;
  }

  $("print").onclick = () => window.print();

  /* ---------- 保存先(フォルダ / ブラウザ内) ----------
   * フォルダ保存: File System Access API(Chrome/Edge)。アプリの
   * フォルダ等を一度選ぶと、記録が1件=1つのJSONファイルとして
   * そのフォルダに保存され、次回以降も同じフォルダから一覧できる。
   * 未対応ブラウザ・フォルダ未選択時は従来どおり localStorage。 */
  const hasFS = "showDirectoryPicker" in window;
  let dirHandle = null;      // 接続済みフォルダ
  let pendingHandle = null;  // 前回使ったが再許可待ちのフォルダ

  function idb() {
    return new Promise((res, rej) => {
      const rq = indexedDB.open("pronationFS", 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore("handles");
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
  }
  async function idbSet(k, v) {
    const db = await idb();
    return new Promise((res, rej) => {
      const tx = db.transaction("handles", "readwrite");
      tx.objectStore("handles").put(v, k);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
  }
  async function idbGet(k) {
    const db = await idb();
    return new Promise((res, rej) => {
      const rq = db.transaction("handles").objectStore("handles").get(k);
      rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error);
    });
  }

  // ファイル名はASCIIのみ(日本語名は文字コード・同期ツール起因の事故を避け、JSON内に保持)
  const recFileName = rec => `record_${rec.patient.date}_${rec.id}.json`;

  async function folderFindName(id) {
    for await (const [name, h] of dirHandle.entries()) {
      if (h.kind === "file" && name.endsWith(`_${id}.json`)) return name;
    }
    return null;
  }
  async function folderRecords() {
    const recs = [];
    for await (const [name, h] of dirHandle.entries()) {
      if (h.kind === "file" && name.startsWith("record_") && name.endsWith(".json")) {
        try {
          const j = JSON.parse(await (await h.getFile()).text());
          if (j && j.id && j.patient && j.result) recs.push(j);
        } catch { /* 壊れたファイルは一覧から除外 */ }
      }
    }
    recs.sort((a, b) => b.id - a.id);
    return recs;
  }
  async function folderWrite(rec) {
    const fname = (await folderFindName(rec.id)) || recFileName(rec);
    const fh = await dirHandle.getFileHandle(fname, { create: true });
    const w = await fh.createWritable();
    await w.write(JSON.stringify(rec, null, 2));
    await w.close();
  }
  async function folderDelete(id) {
    const fname = await folderFindName(id);
    if (fname) await dirHandle.removeEntry(fname);
  }

  const localLoad = () => { try { return JSON.parse(localStorage.getItem(LS_KEY)) || []; } catch { return []; } };
  const localSave = recs => localStorage.setItem(LS_KEY, JSON.stringify(recs));

  async function loadRecords() { return dirHandle ? folderRecords() : localLoad(); }
  async function saveRecord(rec) {
    if (dirHandle) { await folderWrite(rec); return; }
    const recs = localLoad(); recs.unshift(rec); localSave(recs);
  }
  async function updateRecord(rec) {
    if (dirHandle) { await folderWrite(rec); return; }
    localSave(localLoad().map(x => (x.id === rec.id ? rec : x)));
  }
  async function deleteRecord(id) {
    if (dirHandle) { await folderDelete(id); return; }
    localSave(localLoad().filter(x => x.id !== id));
  }

  async function migrateLocalToFolder() {
    const locals = localLoad();
    if (!locals.length) return 0;
    const existing = new Set((await folderRecords()).map(r => r.id));
    let n = 0;
    for (const rec of locals) if (!existing.has(rec.id)) { await folderWrite(rec); n++; }
    return n;
  }

  function updateStorageBar() {
    const st = $("storeStatus");
    if (dirHandle) {
      st.innerHTML = `保存先: <span class="connected">フォルダ「${dirHandle.name || "選択済み"}」に自動保存中</span>`;
      $("pickFolder").textContent = "保存フォルダを変更";
      $("reconnectFolder").classList.add("hidden");
    } else if (pendingHandle) {
      st.textContent = "保存先: このブラウザ内(前回のフォルダは未接続)";
      $("reconnectFolder").classList.remove("hidden");
    } else if (hasFS) {
      st.textContent = "保存先: このブラウザ内(フォルダ未選択)";
    } else {
      st.textContent = "保存先: このブラウザ内(このブラウザはフォルダ保存に未対応。バックアップ書き出しをご利用ください)";
      $("pickFolder").disabled = true;
    }
  }

  async function connectFolder(handle) {
    dirHandle = handle; pendingHandle = null;
    try { await idbSet("dir", handle); } catch { /* file://等で保存できなくても動作は継続 */ }
    const moved = await migrateLocalToFolder();
    updateStorageBar();
    if (moved > 0) alert(`ブラウザ内に保存されていた${moved}件の記録をフォルダにコピーしました。今後の記録はフォルダに保存されます。`);
  }

  $("pickFolder").onclick = async () => {
    if (!hasFS) return;
    try {
      const handle = await window.showDirectoryPicker({ mode: "readwrite" });
      await connectFolder(handle);
    } catch (e) {
      if (e && e.name !== "AbortError") alert("フォルダを開けませんでした: " + e.message);
    }
  };
  $("reconnectFolder").onclick = async () => {
    if (!pendingHandle) return;
    try {
      const p = pendingHandle.requestPermission ? await pendingHandle.requestPermission({ mode: "readwrite" }) : "granted";
      if (p === "granted") await connectFolder(pendingHandle);
    } catch (e) { alert("再接続できませんでした。「保存フォルダを選択」からやり直してください。"); }
  };

  (async function initStore() {
    if (hasFS) {
      try {
        const h = await idbGet("dir");
        if (h) {
          const p = h.queryPermission ? await h.queryPermission({ mode: "readwrite" }) : "granted";
          if (p === "granted") dirHandle = h;
          else pendingHandle = h;   // クリック(ユーザー操作)で再許可を取る
        }
      } catch { /* 復元できなければブラウザ内保存で続行 */ }
    }
    updateStorageBar();
  })();

  /* ---------- バックアップ(全ブラウザ共通) ---------- */
  $("exportAll").onclick = async () => {
    const recs = await loadRecords();
    if (!recs.length) { alert("保存された記録がありません。"); return; }
    const blob = new Blob([JSON.stringify(recs, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `回内足記録バックアップ_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  $("importBtn").onclick = () => $("importFile").click();
  $("importFile").onchange = async e => {
    let added = 0, skipped = 0;
    const existing = new Set((await loadRecords()).map(r => r.id));
    for (const f of e.target.files) {
      try {
        const j = JSON.parse(await f.text());
        const list = Array.isArray(j) ? j : [j];
        for (const rec of list) {
          if (rec && rec.id && rec.patient && rec.result) {
            if (existing.has(rec.id)) { skipped++; continue; }
            await saveRecord(rec); existing.add(rec.id); added++;
          }
        }
      } catch { skipped++; }
    }
    e.target.value = "";
    alert(`読み込み完了: ${added}件追加${skipped ? `・${skipped}件は重複/読込不可のためスキップ` : ""}`);
    if (!$("secRecords").classList.contains("hidden")) renderRecords();
  };

  /* ---------- 記録の保存・再評価 ---------- */
  $("save").onclick = async () => {
    if (!current) return;
    try {
      await saveRecord({ id: Date.now(), patient: current.patient, result: current.result });
      alert(dirHandle
        ? `フォルダ「${dirHandle.name || "選択済み"}」に保存しました。「保存済みの記録」から再評価を追記できます。`
        : "保存しました(この端末のブラウザ内)。フォルダにファイルとして残す場合は上部の「保存フォルダを選択」をご利用ください。");
    } catch (e) { alert("保存に失敗しました: " + e.message); }
  };

  async function renderRecords() {
    const wrap = $("recordsList");
    let recs;
    try { recs = await loadRecords(); }
    catch (e) { wrap.innerHTML = `<p class="note">記録を読み込めませんでした: ${e.message}</p>`; return; }
    if (!recs.length) { wrap.innerHTML = `<p class="note">保存された記録はまだありません。</p>`; return; }
    wrap.innerHTML = "";
    recs.forEach(rec => {
      const p = rec.patient, r = rec.result;
      const t = D.types[r.type];
      const div = document.createElement("div");
      div.className = "recCard";
      const baseNav = Math.max(p.nav.L ?? 0, p.nav.R ?? 0);
      const baseNrs = Math.max(p.nrs.rest, p.nrs.walk, p.nrs.sport);
      let rows = (p.reevals || []).map(ev => {
        const dNav = ev.nav != null && baseNav ? (ev.nav - baseNav) : null;
        const dNrs = ev.nrs != null ? (ev.nrs - baseNrs) : null;
        const ok = (dNav != null && dNav <= -2) || (dNrs != null && dNrs <= -2);
        return `<tr><td>${ev.date}(${ev.week}週)</td><td>${ev.nav ?? "-"} mm${dNav != null ? `(${dNav > 0 ? "+" : ""}${dNav})` : ""}</td>
          <td>${ev.nrs ?? "-"}${dNrs != null ? `(${dNrs > 0 ? "+" : ""}${dNrs})` : ""}</td><td>${ev.hw ?? "-"} 回/週</td>
          <td class="${ok ? "judge-ok" : "judge-ng"}">${ok ? "改善" : (Number(ev.week) >= 8 ? "要見直し" : "経過中")}</td></tr>`;
      }).join("");
      div.innerHTML = `
        <div class="recHead"><div><b>${p.name}</b> 様(${p.age}歳)・${p.date}
          <span class="mini" style="color:${t.color}">${t.name}</span></div>
          <div><button class="btn" data-act="open">開く</button> <button class="btn danger" data-act="del">削除</button></div></div>
        <table><thead><tr><th>再評価日</th><th>舟状骨落下(最大側)</th><th>NRS(最大)</th><th>宿題実施</th><th>判定</th></tr></thead>
        <tbody><tr><td>${p.date}(初回)</td><td>${baseNav || "-"} mm</td><td>${baseNrs}</td><td>-</td><td>基準</td></tr>${rows}</tbody></table>
        <div class="reevalForm">
          <label>週数<select data-f="week"><option>4</option><option>8</option><option>12</option></select></label>
          <label>舟状骨落下(mm)<input type="number" step="0.5" data-f="nav"></label>
          <label>NRS(0〜10)<input type="number" min="0" max="10" data-f="nrs"></label>
          <label>宿題(回/週)<input type="number" min="0" max="7" data-f="hw"></label>
          <button class="btn primary" data-act="addEv">再評価を追記</button>
        </div>
        <p class="mini">判定基準: 8週で舟状骨落下-2mm以上またはNRS-2以上。未達なら宿題実施率(週3回未満なら方法を変える)→負荷量・近位評価→装具短期併用→改善なければ紹介。</p>`;
      div.querySelector('[data-act="open"]').onclick = () => {
        current = { patient: p, result: r };
        renderPro(p, r); renderHandout(p, r);
        $("secRecords").classList.add("hidden"); show(4);
      };
      div.querySelector('[data-act="del"]').onclick = async () => {
        if (!confirm(`${p.name}様の記録を削除しますか?`)) return;
        try { await deleteRecord(rec.id); } catch (e) { alert("削除に失敗しました: " + e.message); }
        renderRecords();
      };
      div.querySelector('[data-act="addEv"]').onclick = async () => {
        const g = f => { const el = div.querySelector(`[data-f="${f}"]`); return el.value === "" ? null : Number(el.value); };
        (rec.patient.reevals = rec.patient.reevals || []).push({
          date: new Date().toISOString().slice(0, 10),
          week: g("week"), nav: g("nav"), nrs: g("nrs"), hw: g("hw")
        });
        try { await updateRecord(rec); } catch (e) { alert("保存に失敗しました: " + e.message); }
        renderRecords();
      };
      wrap.appendChild(div);
    });
  }
})();
