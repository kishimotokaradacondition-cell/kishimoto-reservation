"""
判定ロジックのテスト（AWGS 2019 の定義どおりに動くかを機械的に確認）

実行: cd sarcopenia && python -m pytest -q
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest  # noqa: E402

from criteria import CUTOFFS, compute_smi, evaluate, sarcf_total  # noqa: E402


def base(**kw):
    d = {"sex": "male", "age": 72, "height_cm": 165}
    d.update(kw)
    return d


# ── 計算 ──
def test_smi_formula():
    # 四肢骨格筋量 19.1kg / 身長1.65m² = 7.02
    assert compute_smi(19.1, 165) == 7.02


def test_smi_requires_height():
    assert compute_smi(19.1, None) is None
    assert compute_smi(None, 165) is None


def test_limbs_are_summed_into_asm_and_smi():
    r = evaluate(base(arm_r_kg=2.5, arm_l_kg=2.4, leg_r_kg=7.0, leg_l_kg=6.9))
    assert r["values"]["asm_kg"] == 18.8
    assert r["values"]["smi"] == round(18.8 / 1.65 ** 2, 2)
    assert r["values"]["smi_source"] == "limbs"


def test_direct_smi_overrides_limbs():
    r = evaluate(base(smi=7.5, arm_r_kg=1, arm_l_kg=1, leg_r_kg=1, leg_l_kg=1))
    assert r["values"]["smi"] == 7.5
    assert r["values"]["smi_source"] == "direct"


def test_sarcf_total_needs_all_five():
    assert sarcf_total({"strength": 1, "walk": 0, "chair": 1, "stairs": 2, "falls": 0}) == 4
    assert sarcf_total({"strength": 1, "walk": 0}) is None
    assert sarcf_total({}) is None


# ── 基準値（男女差）──
def test_cutoffs_follow_awgs2019():
    assert CUTOFFS["grip_kg"] == {"male": 28.0, "female": 18.0}
    assert CUTOFFS["smi_bia"] == {"male": 7.0, "female": 5.7}
    assert CUTOFFS["calf_cm"] == {"male": 34.0, "female": 33.0}
    assert CUTOFFS["gait_speed_ms"] == 1.0
    assert CUTOFFS["chair_stand_sec"] == 12.0


def test_female_cutoffs_are_applied():
    # 握力 20kg: 男性なら低下、女性なら基準内
    assert evaluate(base(sex="male", grip_kg=20))["flags"]["low_strength"] is True
    assert evaluate(base(sex="female", grip_kg=20))["flags"]["low_strength"] is False


def test_sex_required():
    with pytest.raises(ValueError):
        evaluate({"sex": ""})


# ── 判定フロー ──
def test_severe_when_mass_strength_and_performance_all_low():
    r = evaluate(base(smi=6.5, grip_kg=25, gait_speed_ms=0.8))
    assert r["level"] == "severe"


def test_sarcopenia_when_mass_low_plus_one_of_strength_or_performance():
    assert evaluate(base(smi=6.5, grip_kg=25, gait_speed_ms=1.2))["level"] == "sarcopenia"
    assert evaluate(base(smi=6.5, grip_kg=30, chair_stand_sec=13))["level"] == "sarcopenia"


def test_low_mass_only_when_strength_and_performance_normal():
    assert evaluate(base(smi=6.5, grip_kg=30, gait_speed_ms=1.2))["level"] == "low_mass_only"


def test_low_mass_only_when_others_unmeasured():
    r = evaluate(base(smi=6.5))
    assert r["level"] == "low_mass_only"
    assert any("確定" in n for n in r["notes"])


def test_possible_when_mass_unmeasured_but_strength_low():
    assert evaluate(base(grip_kg=25))["level"] == "possible"


def test_possible_when_mass_unmeasured_but_performance_low():
    assert evaluate(base(chair_stand_sec=14))["level"] == "possible"


def test_function_low_when_mass_normal_but_strength_low():
    assert evaluate(base(smi=7.5, grip_kg=25))["level"] == "function_low"


def test_none_when_everything_normal():
    r = evaluate(base(smi=7.5, grip_kg=30, gait_speed_ms=1.2, chair_stand_sec=9, calf_cm=36))
    assert r["level"] == "none"


def test_screen_positive_when_only_screening_is_abnormal():
    sarcf = {"strength": 1, "walk": 1, "chair": 1, "stairs": 1, "falls": 0}  # 4点
    r = evaluate(base(sarcf=sarcf))
    assert r["level"] == "screen_positive"
    assert r["values"]["sarcf_score"] == 4


def test_sarc_calf_adds_ten_points_when_calf_low():
    sarcf = {"strength": 1, "walk": 0, "chair": 0, "stairs": 0, "falls": 0}  # 1点
    r = evaluate(base(sarcf=sarcf, calf_cm=33))  # 男性 34cm未満 → +10
    assert r["values"]["sarc_calf_score"] == 11
    assert r["flags"]["screening_positive"] is True


def test_insufficient_when_nothing_measured():
    assert evaluate(base())["level"] == "insufficient"


def test_chair_stand_boundary_is_inclusive():
    # 12秒「以上」で低下
    assert evaluate(base(chair_stand_sec=12))["flags"]["low_performance"] is True
    assert evaluate(base(chair_stand_sec=11.9))["flags"]["low_performance"] is False


def test_grip_boundary_is_exclusive():
    # 28kg「未満」で低下 → ちょうど28は基準内
    assert evaluate(base(grip_kg=28))["flags"]["low_strength"] is False
    assert evaluate(base(grip_kg=27.9))["flags"]["low_strength"] is True


def test_young_age_adds_caution_note():
    r = evaluate(base(age=45, grip_kg=30))
    assert any("65歳" in n for n in r["notes"])


def test_criteria_rows_are_listed_for_display():
    r = evaluate(base(grip_kg=25))
    keys = [c["key"] for c in r["criteria"]]
    assert keys == ["calf", "sarcf", "sarc_calf", "grip", "gait", "chair", "smi"]
    grip_row = next(c for c in r["criteria"] if c["key"] == "grip")
    assert grip_row["low"] is True and grip_row["value"] == 25.0
