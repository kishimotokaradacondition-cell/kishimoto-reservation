"""
サルコペニア判定ロジック（AWGS 2019 準拠）

出典:
  Chen LK, et al. Asian Working Group for Sarcopenia: 2019 Consensus Update on
  Sarcopenia Diagnosis and Treatment. J Am Med Dir Assoc. 2020;21(3):300-307.

役割:
  このファイルは「数値の計算」と「基準値との比較」だけを担当します。
  画面（HTML/JS）やデータベース（SQLite）には一切触れないので、
  基準値を変えたいときは下の CUTOFFS を書き換えるだけで済みます。

注意（医療上の位置づけ）:
  ここで出る結果は「スクリーニング（ふるい分け）」の判定であり、医師による診断ではありません。
  画面・印刷物では必ず「〜の可能性」「〜の疑い」という表現を使い、
  「サルコペニアと診断」とは書かないこと。
"""

# ── 基準値（AWGS 2019）────────────────────────────────────────
# 「未満」「以上」の向きはコメントの通り。すべて成人（主に65歳以上）向けの値。
CUTOFFS = {
    # 症例抽出（スクリーニング）
    "calf_cm":        {"male": 34.0, "female": 33.0},  # 下腿周囲長: この値「未満」で陽性
    "sarcf":          4,     # SARC-F 合計（0〜10点）: この値「以上」で陽性
    "sarc_calf":      11,    # SARC-CalF 合計（SARC-F ＋ 下腿周囲長低下なら+10点）: 「以上」で陽性
    # 筋力
    "grip_kg":        {"male": 28.0, "female": 18.0},  # 握力: 「未満」で筋力低下
    # 身体機能
    "gait_speed_ms":  1.0,   # 6m 通常歩行速度(m/秒): 「未満」で身体機能低下
    "chair_stand_sec": 12.0, # 5回椅子立ち上がりテスト(秒): 「以上」で身体機能低下
    # 筋肉量（BIA = InBody などの生体電気インピーダンス法）
    "smi_bia":        {"male": 7.0, "female": 5.7},    # SMI = 四肢骨格筋量 ÷ 身長(m)²: 「未満」で筋肉量低下
}

# ── SARC-F 質問票 ───────────────────────────────────────────
# (キー, 見出し, 質問文)
SARCF_ITEMS = [
    ("strength", "筋力",       "4.5kg程度（2Lペットボトル2本くらい）の物を持ち上げて運ぶのは、どれくらい大変ですか？"),
    ("walk",     "歩行",       "部屋の中を歩くのは、どれくらい大変ですか？"),
    ("chair",    "立ち上がり", "椅子やベッドから立ち上がるのは、どれくらい大変ですか？"),
    ("stairs",   "階段",       "階段を10段のぼるのは、どれくらい大変ですか？"),
    ("falls",    "転倒",       "過去1年間に、何回転びましたか？"),
]

# 選択肢（値: 表示）。転倒だけ選択肢の文言が違う。
SARCF_CHOICES = {
    "default": [(0, "まったく大変でない"), (1, "少し大変"), (2, "とても大変・できない")],
    "falls":   [(0, "なし"), (1, "1〜3回"), (2, "4回以上")],
}

# ── 判定レベルの定義 ─────────────────────────────────────────
# key → (表示ラベル, 色クラス, 現場での次の一手)
LEVELS = {
    "severe": (
        "重症サルコペニアの可能性",
        "lv-severe",
        "筋肉量・筋力・身体機能の3つすべてが基準を下回っています。医療機関（かかりつけ医）への相談を勧め、"
        "並行してレジスタンス運動＋たんぱく質摂取の指導を開始。3か月後に再評価。",
    ),
    "sarcopenia": (
        "サルコペニアの可能性",
        "lv-high",
        "筋肉量低下に加え、筋力または身体機能の低下があります。かかりつけ医への情報共有を勧め、"
        "下肢を中心としたレジスタンス運動と栄養（たんぱく質 1.0〜1.2g/kg/日目安）を指導。3か月後に再評価。",
    ),
    "possible": (
        "サルコペニアの疑い（筋肉量は未測定）",
        "lv-mid",
        "筋力または身体機能が低下しています。InBody で筋肉量（SMI）を測定すると判定が確定します。"
        "測定を待たずに運動・栄養指導は開始してよい段階です。",
    ),
    "function_low": (
        "筋力・身体機能の低下あり（筋肉量は基準内）",
        "lv-mid",
        "AWGS 2019 の定義ではサルコペニアに該当しませんが、転倒リスクの観点から運動介入の対象です。"
        "原因（痛み・関節可動域・足部機能）を別途評価し、3か月後に再評価。",
    ),
    "low_mass_only": (
        "筋肉量の低下のみ（基準上は該当なし）",
        "lv-low",
        "筋肉量は低いが筋力・身体機能は保たれている状態（または未測定）です。"
        "予防的にレジスタンス運動と栄養を指導し、半年後に再評価。",
    ),
    "screen_positive": (
        "スクリーニング陽性（要・測定）",
        "lv-low",
        "SARC-F または下腿周囲長で陽性です。握力・歩行速度・椅子立ち上がりを測定し、"
        "可能なら InBody で筋肉量も測定してください。",
    ),
    "none": (
        "基準上は該当なし",
        "lv-ok",
        "現時点でサルコペニアの基準には当たりません。年1回の再評価（握力・下腿周囲長・SARC-F）を推奨。",
    ),
    "insufficient": (
        "判定不可（測定項目が不足）",
        "lv-na",
        "判定には「握力」「歩行速度 or 椅子立ち上がり」「筋肉量（SMI）」のいずれかが必要です。",
    ),
}


# ── ユーティリティ ──────────────────────────────────────────
def _num(v):
    """空文字・None・変換不能は None、それ以外は float を返す"""
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip()
    if s == "":
        return None
    try:
        return float(s)
    except ValueError:
        return None


def _int(v):
    f = _num(v)
    return None if f is None else int(round(f))


def compute_smi(asm_kg, height_cm):
    """SMI（骨格筋指数）= 四肢骨格筋量(kg) ÷ 身長(m)²"""
    asm_kg = _num(asm_kg)
    height_cm = _num(height_cm)
    if asm_kg is None or height_cm is None or height_cm <= 0:
        return None
    h_m = height_cm / 100.0
    return round(asm_kg / (h_m * h_m), 2)


def resolve_muscle_mass(data, height_cm):
    """
    入力データから ASM（四肢骨格筋量）と SMI を決める。
    優先順位: ① SMI 直接入力 → ② ASM 直接入力 → ③ 四肢（右腕・左腕・右脚・左脚）の合計
    戻り値: (smi, asm_kg, source)   source は "direct" / "asm" / "limbs" / None
    """
    smi_direct = _num(data.get("smi"))
    if smi_direct is not None:
        asm = _num(data.get("asm_kg"))
        if asm is None:
            asm = _sum_limbs(data)
        return smi_direct, asm, "direct"

    asm = _num(data.get("asm_kg"))
    if asm is not None:
        return compute_smi(asm, height_cm), asm, "asm"

    asm = _sum_limbs(data)
    if asm is not None:
        return compute_smi(asm, height_cm), asm, "limbs"

    return None, None, None


def _sum_limbs(data):
    limbs = [_num(data.get(k)) for k in ("arm_r_kg", "arm_l_kg", "leg_r_kg", "leg_l_kg")]
    if any(v is None for v in limbs):
        return None
    return round(sum(limbs), 2)


def sarcf_total(answers):
    """
    SARC-F の合計点。5問すべて回答済みのときだけ点数を返し、未回答があれば None。
    answers: {"strength": 0..2, "walk": ..., ...}
    """
    if not answers:
        return None
    total = 0
    for key, _, _ in SARCF_ITEMS:
        v = _int(answers.get(key))
        if v is None or v not in (0, 1, 2):
            return None
        total += v
    return total


# ── 本体 ────────────────────────────────────────────────────
def evaluate(data):
    """
    1件分の入力（dict）を受け取り、判定結果（dict）を返す。
    画面にそのまま表示できるよう、各項目の「測定値・基準・結果」を criteria に並べる。
    """
    sex = (data.get("sex") or "").strip()
    if sex not in ("male", "female"):
        raise ValueError("性別（男性/女性）を選択してください")

    age       = _int(data.get("age"))
    height_cm = _num(data.get("height_cm"))
    calf      = _num(data.get("calf_cm"))
    grip      = _num(data.get("grip_kg"))
    gait      = _num(data.get("gait_speed_ms"))
    chair     = _num(data.get("chair_stand_sec"))
    sarcf_ans = data.get("sarcf") or {}
    sarcf     = sarcf_total(sarcf_ans)

    smi, asm, smi_source = resolve_muscle_mass(data, height_cm)

    notes = []

    # ── ① スクリーニング（症例抽出）──
    calf_cut = CUTOFFS["calf_cm"][sex]
    calf_low = None if calf is None else calf < calf_cut
    sarcf_pos = None if sarcf is None else sarcf >= CUTOFFS["sarcf"]
    sarc_calf = None
    sarc_calf_pos = None
    if sarcf is not None and calf_low is not None:
        sarc_calf = sarcf + (10 if calf_low else 0)
        sarc_calf_pos = sarc_calf >= CUTOFFS["sarc_calf"]

    screen_measured = [x for x in (calf_low, sarcf_pos, sarc_calf_pos) if x is not None]
    screening_positive = True if any(screen_measured) else (False if screen_measured else None)

    if sarcf is None and any(sarcf_ans.get(k) not in (None, "") for k, _, _ in SARCF_ITEMS):
        notes.append("SARC-F は5問すべて回答すると合計点が出ます（未回答あり）。")

    # ── ② 筋力 ──
    grip_cut = CUTOFFS["grip_kg"][sex]
    low_strength = None if grip is None else grip < grip_cut

    # ── ③ 身体機能 ──
    gait_low  = None if gait  is None else gait  < CUTOFFS["gait_speed_ms"]
    chair_low = None if chair is None else chair >= CUTOFFS["chair_stand_sec"]
    perf_measured = [x for x in (gait_low, chair_low) if x is not None]
    low_performance = True if any(perf_measured) else (False if perf_measured else None)

    # ── ④ 筋肉量 ──
    smi_cut = CUTOFFS["smi_bia"][sex]
    low_mass = None if smi is None else smi < smi_cut
    if smi is None and (asm is not None or _sum_limbs(data) is not None) and height_cm is None:
        notes.append("筋肉量（SMI）の計算には身長が必要です。")

    # ── ⑤ 判定（AWGS 2019 のフロー）──
    if low_mass is True:
        if low_strength and low_performance:
            level = "severe"
        elif low_strength or low_performance:
            level = "sarcopenia"
        else:
            level = "low_mass_only"
            if low_strength is None and low_performance is None:
                notes.append("筋力・身体機能を測定すると、サルコペニアかどうかが確定します。")
    elif low_mass is False:
        if low_strength or low_performance:
            level = "function_low"
        elif low_strength is None and low_performance is None:
            # 筋肉量だけ正常。筋力・機能が未測定なので「該当なし」寄りだが測定を促す
            level = "none"
            notes.append("筋肉量は基準内です。握力も測定すると評価の精度が上がります。")
        else:
            level = "none"
    else:  # 筋肉量 未測定
        if low_strength or low_performance:
            level = "possible"
        elif low_strength is False or low_performance is False:
            level = "none"
            if screening_positive:
                notes.append("スクリーニングは陽性ですが、測定した筋力・身体機能は基準内でした。InBody で筋肉量も確認すると安心です。")
        elif screening_positive:
            level = "screen_positive"
        elif screening_positive is False:
            level = "none"
            notes.append("スクリーニング陰性。握力など実測値があると、より確実です。")
        else:
            level = "insufficient"

    if age is not None and age < 65:
        notes.append("AWGS 2019 の基準値は主に65歳以上を対象に作られています。65歳未満では参考値として扱ってください。")

    label, css, action = LEVELS[level]

    # ── 画面表示用の一覧 ──
    def row(key, name, value, unit, cutoff_text, flag):
        return {
            "key": key, "name": name,
            "value": value, "unit": unit,
            "cutoff": cutoff_text,
            # True=基準を下回る（悪い） / False=基準内 / None=未測定
            "low": flag,
        }

    criteria = [
        row("calf",  "下腿周囲長",          calf,  "cm",  f"{calf_cut:g}cm 未満で陽性", calf_low),
        row("sarcf", "SARC-F 合計",         sarcf, "点",  f"{CUTOFFS['sarcf']}点 以上で陽性", sarcf_pos),
        row("sarc_calf", "SARC-CalF 合計",  sarc_calf, "点", f"{CUTOFFS['sarc_calf']}点 以上で陽性", sarc_calf_pos),
        row("grip",  "握力（左右の最大）",   grip,  "kg",  f"{grip_cut:g}kg 未満で筋力低下", low_strength),
        row("gait",  "歩行速度",            gait,  "m/秒", f"{CUTOFFS['gait_speed_ms']:g}m/秒 未満で身体機能低下", gait_low),
        row("chair", "5回椅子立ち上がり",   chair, "秒",  f"{CUTOFFS['chair_stand_sec']:g}秒 以上で身体機能低下", chair_low),
        row("smi",   "SMI（筋肉量指数）",   smi,   "kg/m²", f"{smi_cut:g}kg/m² 未満で筋肉量低下", low_mass),
    ]

    return {
        "level": level,
        "label": label,
        "css": css,
        "action": action,
        "flags": {
            "screening_positive": screening_positive,
            "low_strength": low_strength,
            "low_performance": low_performance,
            "low_mass": low_mass,
        },
        "values": {
            "sarcf_score": sarcf,
            "sarc_calf_score": sarc_calf,
            "asm_kg": asm,
            "smi": smi,
            "smi_source": smi_source,
        },
        "criteria": criteria,
        "notes": notes,
        "cutoffs": {
            "calf_cm": calf_cut,
            "grip_kg": grip_cut,
            "smi_bia": smi_cut,
            "gait_speed_ms": CUTOFFS["gait_speed_ms"],
            "chair_stand_sec": CUTOFFS["chair_stand_sec"],
            "sarcf": CUTOFFS["sarcf"],
            "sarc_calf": CUTOFFS["sarc_calf"],
        },
        "reference": "AWGS 2019 (Chen LK et al. J Am Med Dir Assoc 2020;21:300-307)",
    }
