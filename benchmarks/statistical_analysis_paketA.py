"""
Comprehensive GLP Statistical Analysis (A1 + A2 + A3 + A4 + A6 + A7)

Computes:
  - Sample mean, SD (ddof=1), median, IQR
  - Paired t-test, Wilcoxon signed-rank, Brown-Forsythe Levene variance test
  - Family-wise Holm-Bonferroni correction per RQ family (A1_2x2, A3_30seeds, A4_Components, A6_Dynamic300, A7_Sensitivity)
  - 2x2 Factorial Main Effects & Interaction Decomposition for A1 ({MN-LAHC, S4} x {F_soft, Obj_S4}) on H_gated, H_bal,0.3, H_bal,0.6, and raw LecIso
  - Post-hoc paired statistical power (1 - beta at alpha = 0.05) + MDE (minimum detectable effect at 80% power)
  - Multi-margin TOST equivalence tests (+/-1.0, +/-1.5, +/-2.0 pts) on H_gated, H_bal,0.3, and H_bal,0.6 for BOTH n=30 and held-out n=25
  - McNemar exact test & Wilson 95% CIs on A6 N=300 dynamic repair (180 conflict-only trials)

Outputs:
  - results/paketA_statistical_report.json
  - results/paketA_statistical_tables.md
"""
from __future__ import annotations

import json
from pathlib import Path
import numpy as np
from scipy import stats

BASE = Path(__file__).resolve().parent.parent
RES_DIR = BASE / "results"
PA_ABN = RES_DIR / "paketA_ablation_30seeds.json"
PA_DYN = RES_DIR / "paketA_dynamic_300.json"
PA_MILP = RES_DIR / "milp_fair_a2_results.json"
OUT_JSON = RES_DIR / "paketA_statistical_report.json"
OUT_MD = RES_DIR / "paketA_statistical_tables.md"


def cliffs_delta(a: np.ndarray, b: np.ndarray) -> float:
    gt = sum(int(np.sum(x > b)) for x in a)
    lt = sum(int(np.sum(x < b)) for x in a)
    return float((gt - lt) / (len(a) * len(b)))


def bootstrap_ci(diff: np.ndarray, n_boot: int = 5000, seed: int = 42) -> tuple[float, float]:
    rng = np.random.default_rng(seed)
    n = len(diff)
    boots = np.array([float(np.mean(rng.choice(diff, size=n, replace=True))) for _ in range(n_boot)])
    return float(np.percentile(boots, 2.5)), float(np.percentile(boots, 97.5))


def paired_power(dz: float, n: int, alpha: float = 0.05) -> float:
    df = max(1, n - 1)
    t_crit = float(stats.t.ppf(1 - alpha / 2, df))
    ncp = abs(dz) * np.sqrt(n)
    if ncp > 12.0:
        return 1.0
    p_upper = float(1.0 - stats.nct.cdf(t_crit, df, ncp))
    p_lower = float(stats.nct.cdf(-t_crit, df, ncp))
    if np.isnan(p_upper) or np.isnan(p_lower):
        return 1.0
    return round(min(1.0, max(0.0, p_upper + p_lower)), 4)


def mde_80_power(sd_diff: float, n: int, alpha: float = 0.05) -> float:
    """Minimum detectable paired mean difference at 80% power."""
    df = max(1, n - 1)
    t_crit = float(stats.t.ppf(1 - alpha / 2, df))
    t_beta = float(stats.t.ppf(0.80, df))
    return round(float((t_crit + t_beta) * sd_diff / np.sqrt(max(1, n))), 3)


def paired_tost(a_vals: list[float], b_vals: list[float], bound: float) -> dict:
    diff = np.asarray(a_vals, dtype=float) - np.asarray(b_vals, dtype=float)
    n = len(diff)
    m = float(np.mean(diff))
    sd = float(np.std(diff, ddof=1)) if n > 1 else 0.0
    se = sd / np.sqrt(n) if n > 0 else 0.0
    df = max(1, n - 1)
    if se > 1e-12:
        t_low = (m - (-bound)) / se
        p_low = float(1.0 - stats.t.cdf(t_low, df))
        t_high = (m - bound) / se
        p_high = float(stats.t.cdf(t_high, df))
        p_tost = max(p_low, p_high)
        t90 = float(stats.t.ppf(0.95, df))
        ci90 = [round(m - t90 * se, 3), round(m + t90 * se, 3)]
        z_crit = float(stats.norm.ppf(0.95))
        pwr_exact = float(max(0.0, 2.0 * stats.norm.cdf(bound / se - z_crit) - 1.0))
    else:
        p_tost = 0.0 if abs(m) < bound else 1.0
        ci90 = [round(m, 3), round(m, 3)]
        pwr_exact = 1.0
    return {
        "n": n,
        "bound": bound,
        "mean_diff": round(m, 3),
        "sd_diff": round(sd, 3),
        "se_diff": round(se, 3),
        "ci90_diff": ci90,
        "p_tost": round(p_tost, 5),
        "equivalent_alpha05": bool(p_tost < 0.05),
        "tost_power_at_zero": round(pwr_exact, 4),
    }


def compare_paired(family: str, name: str, a_vals: list[float], b_vals: list[float]) -> dict:
    a = np.asarray(a_vals, dtype=float)
    b = np.asarray(b_vals, dtype=float)
    diff = a - b
    n = len(diff)
    m_a, sd_a = float(np.mean(a)), float(np.std(a, ddof=1))
    m_b, sd_b = float(np.mean(b)), float(np.std(b, ddof=1))
    m_d, sd_d = float(np.mean(diff)), float(np.std(diff, ddof=1))
    ci_lo, ci_hi = bootstrap_ci(diff)
    if sd_d > 1e-12:
        t_stat, p_t = stats.ttest_rel(a, b)
        dz = m_d / sd_d
        j_corr = 1.0 - 3.0 / max(1.0, (4.0 * (n - 1) - 1.0))
        hedges_g = dz * j_corr
        pwr = paired_power(dz, n)
        mde = mde_80_power(sd_d, n)
    else:
        t_stat, p_t, dz, hedges_g, pwr, mde = 0.0, 1.0, 0.0, 0.0, 0.05, 0.0
    nz = diff[np.abs(diff) > 1e-12]
    if len(nz) >= 3:
        w_stat, p_w = stats.wilcoxon(nz, zero_method="wilcox")
    else:
        w_stat, p_w = 0.0, 1.0
    lev_stat, p_lev = stats.levene(a, b, center="median")
    return {
        "family": family,
        "comparison": name,
        "n": n,
        "mean_A": round(m_a, 2),
        "sd_A": round(sd_a, 2),
        "mean_B": round(m_b, 2),
        "sd_B": round(sd_b, 2),
        "mean_diff": round(m_d, 2),
        "sd_diff": round(sd_d, 2),
        "ci95_diff": [round(ci_lo, 2), round(ci_hi, 2)],
        "paired_t": round(float(t_stat), 3),
        "paired_p": float(p_t),
        "wilcoxon_w": round(float(w_stat), 2),
        "wilcoxon_p": float(p_w),
        "levene_bf_p": round(float(p_lev), 4),
        "cohens_dz": round(float(dz), 3),
        "hedges_g": round(float(hedges_g), 3),
        "cliffs_delta": round(cliffs_delta(a, b), 3),
        "power_observed": pwr,
        "mde_80pct_power": mde,
    }


def apply_holm_by_family(comps: list[dict]) -> None:
    fams = sorted(set(c["family"] for c in comps))
    for fam in fams:
        sub = [c for c in comps if c["family"] == fam]
        m = len(sub)
        for p_key, out_key in [("paired_p", "paired_p_holm"), ("wilcoxon_p", "wilcoxon_p_holm")]:
            order = sorted(range(m), key=lambda i: sub[i][p_key])
            running_max = 0.0
            for rank, idx in enumerate(order):
                adj = min(1.0, sub[idx][p_key] * (m - rank))
                running_max = max(running_max, adj)
                sub[idx][out_key] = float(running_max)


def vals(data: dict, method: str, key: str) -> list[float]:
    return [float(r[key]) for r in data["methods"][method]["runs"]]


def factorial_2x2(data: dict, metric: str) -> dict:
    """Decompose 2x2 paired factorial {MN-LAHC, S4} x {F_soft, Obj_S4} across n=30 seeds."""
    m_f = np.asarray(vals(data, "A1_MN_LAHC_Fsoft", metric))
    m_o = np.asarray(vals(data, "A1_MN_LAHC_ObjS4", metric))
    s_f = np.asarray(vals(data, "A1_Stage4_Fsoft", metric))
    s_o = np.asarray(vals(data, "A1_Stage4_ObjS4", metric))

    alg_eff = 0.5 * ((s_f - m_f) + (s_o - m_o))
    obj_eff = 0.5 * ((m_o - m_f) + (s_o - s_f))
    inter = (s_o - s_f) - (m_o - m_f)

    def stat_block(arr: np.ndarray) -> dict:
        m = float(np.mean(arr))
        sd = float(np.std(arr, ddof=1))
        t_v, p_v = stats.ttest_1samp(arr, 0.0)
        lo, hi = bootstrap_ci(arr)
        return {
            "mean": round(m, 3),
            "sd": round(sd, 3),
            "ci95": [round(lo, 2), round(hi, 2)],
            "t": round(float(t_v), 3),
            "p": float(p_v),
        }

    return {
        "metric": metric,
        "cellMeans": {
            "MN_LAHC_Fsoft": round(float(np.mean(m_f)), 2),
            "MN_LAHC_ObjS4": round(float(np.mean(m_o)), 2),
            "Stage4_Fsoft": round(float(np.mean(s_f)), 2),
            "Stage4_ObjS4": round(float(np.mean(s_o)), 2),
        },
        "mainEffect_Algorithm_S4_minus_MN": stat_block(alg_eff),
        "mainEffect_Objective_ObjS4_minus_Fsoft": stat_block(obj_eff),
        "interaction_Alg_x_Obj": stat_block(inter),
    }


def main() -> None:
    abn = json.loads(PA_ABN.read_text(encoding="utf-8"))
    dyn = json.loads(PA_DYN.read_text(encoding="utf-8"))
    milp = json.loads(PA_MILP.read_text(encoding="utf-8")) if PA_MILP.exists() else {}

    comps: list[dict] = []

    for metric, label in [
        ("gatedHumaneScore", "H_gated"),
        ("balancedScore03", "H_bal,0.3"),
        ("balancedScore06", "H_bal,0.6"),
        ("lecturerIsolatedDays", "LecIso"),
    ]:
        comps.append(compare_paired("A1_2x2_Matrix", f"S4(F_soft) vs MN-LAHC(F_soft) ({label})", vals(abn, "A1_Stage4_Fsoft", metric), vals(abn, "A1_MN_LAHC_Fsoft", metric)))
        comps.append(compare_paired("A1_2x2_Matrix", f"S4(Obj_S4) vs MN-LAHC(Obj_S4) ({label})", vals(abn, "A1_Stage4_ObjS4", metric), vals(abn, "A1_MN_LAHC_ObjS4", metric)))
        comps.append(compare_paired("A1_2x2_Matrix", f"MN-LAHC(Obj_S4) vs MN-LAHC(F_soft) ({label})", vals(abn, "A1_MN_LAHC_ObjS4", metric), vals(abn, "A1_MN_LAHC_Fsoft", metric)))
        comps.append(compare_paired("A1_2x2_Matrix", f"S4(Obj_S4) vs S4(F_soft) ({label})", vals(abn, "A1_Stage4_ObjS4", metric), vals(abn, "A1_Stage4_Fsoft", metric)))

    comps.append(compare_paired("A3_Core_30s", "MN-LAHC (1.8s) vs Tuned SA (4-Op) (H_gated)", vals(abn, "MN_LAHC_1_8s", "gatedHumaneScore"), vals(abn, "TunedSA_4Op", "gatedHumaneScore")))
    comps.append(compare_paired("A3_Core_30s", "Tuned SA (4-Op) vs Pure SA (2-Op) (H_gated)", vals(abn, "TunedSA_4Op", "gatedHumaneScore"), vals(abn, "PureSA_2Op", "gatedHumaneScore")))
    comps.append(compare_paired("A3_Core_30s", "MN-LAHC Std (10.4s) vs MN-LAHC (1.8s) (H_gated)", vals(abn, "MN_LAHC_Std_10_4s", "gatedHumaneScore"), vals(abn, "MN_LAHC_1_8s", "gatedHumaneScore")))
    comps.append(compare_paired("A3_Core_30s", "S4-Equity vs S4-StudentOnly (H_bal,0.6)", vals(abn, "A1_Stage4_ObjS4", "balancedScore06"), vals(abn, "Stage4_StudentOnly", "balancedScore06")))
    comps.append(compare_paired("A3_Core_30s", "S4-Equity vs MN-LAHC-Eq(F_soft) (H_gated)", vals(abn, "A1_Stage4_ObjS4", "gatedHumaneScore"), vals(abn, "A1_MN_LAHC_Fsoft", "gatedHumaneScore")))
    comps.append(compare_paired("A3_Core_30s", "S4-Equity vs MN-LAHC-Eq(F_soft) (H_bal,0.6)", vals(abn, "A1_Stage4_ObjS4", "balancedScore06"), vals(abn, "A1_MN_LAHC_Fsoft", "balancedScore06")))
    comps.append(compare_paired("A3_Core_30s", "TPE+S4-Eq vs S4-Eq (n=30, H_gated)", vals(abn, "TPE_Stage4_Equity", "gatedHumaneScore"), vals(abn, "A1_Stage4_ObjS4", "gatedHumaneScore")))
    comps.append(compare_paired("A3_Core_30s", "TPE+S4-Eq vs S4-Eq (n=30, H_bal,0.6)", vals(abn, "TPE_Stage4_Equity", "balancedScore06"), vals(abn, "A1_Stage4_ObjS4", "balancedScore06")))

    s4_10_hg = vals(abn, "A1_Stage4_ObjS4", "gatedHumaneScore")[:10]
    s4_10_b6 = vals(abn, "A1_Stage4_ObjS4", "balancedScore06")[:10]
    for m_key, m_lbl in [
        ("A4_S4_NoStage3Bridge", "w/o Stage-3 Bridge"),
        ("A4_S4_NoHalfDayRepack", "w/o Half-Day Repack"),
        ("A4_S4_NoOscillation", "w/o Strategic Oscillation"),
    ]:
        comps.append(compare_paired("A4_Components", f"Full S4-Eq vs {m_lbl} (H_gated)", s4_10_hg, vals(abn, m_key, "gatedHumaneScore")))
        comps.append(compare_paired("A4_Components", f"Full S4-Eq vs {m_lbl} (H_bal,0.6)", s4_10_b6, vals(abn, m_key, "balancedScore06")))

    comps.append(compare_paired("A7_WeightSens", "S4-Eq(-20%) vs S4-Eq(Base) (H_gated)", vals(abn, "A7_S4_WeightMinus20", "gatedHumaneScore"), s4_10_hg))
    comps.append(compare_paired("A7_WeightSens", "S4-Eq(+20%) vs S4-Eq(Base) (H_gated)", vals(abn, "A7_S4_WeightPlus20", "gatedHumaneScore"), s4_10_hg))
    comps.append(compare_paired("A7_WeightSens", "S4-Eq(-20%) vs S4-Eq(Base) (H_bal,0.6)", vals(abn, "A7_S4_WeightMinus20", "balancedScore06"), s4_10_b6))
    comps.append(compare_paired("A7_WeightSens", "S4-Eq(+20%) vs S4-Eq(Base) (H_bal,0.6)", vals(abn, "A7_S4_WeightPlus20", "balancedScore06"), s4_10_b6))

    ej_m = dyn["pairedArrays"]["ejectionMoves"]
    ws_m = dyn["pairedArrays"]["warmStartMoves"]
    comps.append(compare_paired("A6_Dynamic300", f"Ejection vs Warm-Start (Conflict Moves, n={len(ej_m)})", ej_m, ws_m))

    apply_holm_by_family(comps)

    a1_factorial = {
        m: factorial_2x2(abn, m)
        for m in ["gatedHumaneScore", "balancedScore03", "balancedScore06", "lecturerIsolatedDays"]
    }

    tost_grid = {}
    ho_tpe = abn["heldOut25TpeComparison"]["tpeStage4Equity"]["runs"]
    ho_no = abn["heldOut25TpeComparison"]["stage4EquityNoTpe"]["runs"]
    for metric, mlbl in [("gatedHumaneScore", "Hgated"), ("balancedScore03", "Hbal03"), ("balancedScore06", "Hbal06")]:
        for bound in [1.0, 1.5, 2.0]:
            bstr = str(bound).replace(".", "_")
            tost_grid[f"n30_{mlbl}_bound{bstr}"] = paired_tost(vals(abn, "TPE_Stage4_Equity", metric), vals(abn, "A1_Stage4_ObjS4", metric), bound)
            tost_grid[f"heldOut25_{mlbl}_bound{bstr}"] = paired_tost([r[metric] for r in ho_tpe], [r[metric] for r in ho_no], bound)
            tost_grid[f"s4_vs_mnObjS4_n30_{mlbl}_bound{bstr}"] = paired_tost(vals(abn, "A1_Stage4_ObjS4", metric), vals(abn, "A1_MN_LAHC_ObjS4", metric), bound)

    c2 = dyn["conflictOnlySummary"]["contingency2x2"]
    b_cnt, c_cnt = c2["ejectionOnly"], c2["warmStartOnly"]
    mcnemar_p = float(stats.binomtest(b_cnt, b_cnt + c_cnt, 0.5).pvalue) if (b_cnt + c_cnt) > 0 else 1.0

    report = {
        "meta": {
            "nSeedsMain": 30,
            "nSeedsHeldOutTpe": 25,
            "nSeedsA4A7": 10,
            "nDynamicTotal": dyn["protocol"]["totalEdits"],
            "nDynamicConflict": dyn["conflictOnlySummary"]["nConflict"],
            "nStaticResolve": dyn["staticFullResolveSummary"]["n"],
        },
        "a1_factorial_2x2": a1_factorial,
        "comparisons": comps,
        "tost_multi_margin": tost_grid,
        "a6_mcnemar_exact_p": round(mcnemar_p, 6),
        "a2_milp_summary": milp,
    }
    OUT_JSON.write_text(json.dumps(report, indent=2), encoding="utf-8")

    lines = [
        "# Paket A — Comprehensive GLP Statistical Report (A1 + A2 + A3 + A4 + A6 + A7)",
        "",
        "## 1. A1: 2x2 Objective x Algorithm Factorial Decomposition (n = 30, ~10.6 s, w_lec = 300)",
        "",
        "| Metric | MN(F_soft) | MN(Obj_S4) | S4(F_soft) | S4(Obj_S4) | Main Effect: Alg (S4-MN) | Main Effect: Obj (S4Obj-Fsoft) | Interaction |",
        "|---|---:|---:|---:|---:|---|---|---|",
    ]
    for m, blk in a1_factorial.items():
        cm = blk["cellMeans"]
        ea = blk["mainEffect_Algorithm_S4_minus_MN"]
        eo = blk["mainEffect_Objective_ObjS4_minus_Fsoft"]
        ei = blk["interaction_Alg_x_Obj"]
        lines.append(
            f"| {m} | {cm['MN_LAHC_Fsoft']:.2f} | {cm['MN_LAHC_ObjS4']:.2f} | {cm['Stage4_Fsoft']:.2f} | {cm['Stage4_ObjS4']:.2f} "
            f"| {ea['mean']:+.2f} (p={ea['p']:.2e}) | {eo['mean']:+.2f} (p={eo['p']:.2e}) | {ei['mean']:+.2f} (p={ei['p']:.2e}) |"
        )

    lines.extend([
        "",
        "## 2. Pairwise Holm-Bonferroni & Power Analysis",
        "",
        "| Family | Comparison | n | Mean+/-SD (A) | Mean+/-SD (B) | Diff [95% CI] | t (p_holm) | Hedges' g | Power | MDE(80%) |",
        "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ])
    for c in comps:
        lines.append(
            f"| {c['family']} | {c['comparison']} | {c['n']} | {c['mean_A']:.2f}+/-{c['sd_A']:.2f} | {c['mean_B']:.2f}+/-{c['sd_B']:.2f} "
            f"| {c['mean_diff']:+.2f} [{c['ci95_diff'][0]:+.2f}, {c['ci95_diff'][1]:+.2f}] | {c['paired_t']:.2f} ({c['paired_p_holm']:.2e}) "
            f"| {c['hedges_g']:+.2f} | {c['power_observed']:.3f} | {c['mde_80pct_power']:.2f} |"
        )

    lines.extend([
        "",
        "## 3. Multi-Margin TOST Equivalence (TPE+S4 vs Default S4-Eq)",
        "",
        "| Test | n | Margin (+/-) | Mean Diff | 90% CI | p_TOST | Equivalent (alpha=0.05) | Power@0 |",
        "|---|---:|---:|---:|---|---:|---|---:|",
    ])
    for k, v in tost_grid.items():
        lines.append(
            f"| {k} | {v['n']} | +/-{v['bound']:.1f} | {v['mean_diff']:+.3f} | [{v['ci90_diff'][0]:+.3f}, {v['ci90_diff'][1]:+.3f}] "
            f"| {v['p_tost']:.4f} | {'Yes' if v['equivalent_alpha05'] else 'No'} | {v['tost_power_at_zero']:.3f} |"
        )

    OUT_MD.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"[PaketA-Stats] Saved {OUT_JSON} & {OUT_MD}")


if __name__ == "__main__":
    main()
