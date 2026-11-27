"""
GLP Statistical Analysis for Symmetric 10.4s Equal-Time Controlled Ablation Suite.

Computes:
  - Sample SD (ddof=1), median, IQR
  - Paired t-test (ttest_rel), Wilcoxon signed-rank test, Welch's t-test (ddof=1)
  - Separate Holm-Bonferroni family-wise error correction per research question family (RQ1-RQ5)
  - Brown-Forsythe / Levene variance equality test (for TPE variance claim check)
  - Formal Two One-Sided Tests (TOST) equivalence testing (Lakens 2017) with 90% CI & p_TOST
  - Paired Cohen's d_z, Hedges' g, Cliff's delta, and 95% bootstrap CI (5,000 resamples)
"""
from __future__ import annotations

import json
from pathlib import Path
import numpy as np
from scipy import stats

BASE = Path(__file__).resolve().parent.parent
V2_JSON = BASE / "results" / "benchmark_v2_results.json"
OUT_JSON = BASE / "results" / "statistical_report.json"
OUT_MD = BASE / "results" / "statistical_tables.md"


def cliffs_delta(a: np.ndarray, b: np.ndarray) -> float:
    gt = 0
    lt = 0
    for x in a:
        gt += int(np.sum(x > b))
        lt += int(np.sum(x < b))
    return float((gt - lt) / (len(a) * len(b)))


def bootstrap_ci_mean_diff(diff: np.ndarray, n_boot: int = 5000, seed: int = 42) -> tuple[float, float]:
    rng = np.random.default_rng(seed)
    n = len(diff)
    boots = np.empty(n_boot, dtype=float)
    for i in range(n_boot):
        sample = rng.choice(diff, size=n, replace=True)
        boots[i] = float(np.mean(sample))
    return float(np.percentile(boots, 2.5)), float(np.percentile(boots, 97.5))


def paired_tost(a_vals: list[float], b_vals: list[float], bound: float) -> dict:
    """Two One-Sided Tests (TOST) for paired practical equivalence within [-bound, +bound]."""
    diff = np.asarray(a_vals, dtype=float) - np.asarray(b_vals, dtype=float)
    n = len(diff)
    m = float(np.mean(diff))
    sd = float(np.std(diff, ddof=1))
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
    else:
        p_tost = 0.0 if abs(m) < bound else 1.0
        ci90 = [round(m, 3), round(m, 3)]
    return {
        "bound": bound,
        "mean_diff": round(m, 3),
        "ci90_diff": ci90,
        "p_tost": float(p_tost),
        "equivalent_at_alpha05": bool(p_tost < 0.05),
    }


def compare_paired(family: str, name: str, a_vals: list[float], b_vals: list[float]) -> dict:
    a = np.asarray(a_vals, dtype=float)
    b = np.asarray(b_vals, dtype=float)
    diff = a - b
    n = len(diff)
    sd_a = float(np.std(a, ddof=1))
    sd_b = float(np.std(b, ddof=1))
    sd_diff = float(np.std(diff, ddof=1))

    if sd_diff > 1e-12:
        t_rel, p_rel = stats.ttest_rel(a, b)
    else:
        t_rel, p_rel = 0.0, 1.0
    t_welch, p_welch = stats.ttest_ind(a, b, equal_var=False)
    try:
        w_stat, p_wilcoxon = stats.wilcoxon(a, b, zero_method="wilcox")
    except ValueError:
        w_stat, p_wilcoxon = 0.0, 1.0

    lev_stat, lev_p = stats.levene(a, b, center="median")
    cohens_dz = float(np.mean(diff) / sd_diff) if sd_diff > 1e-12 else 0.0
    j_corr = 1.0 - (3.0 / (4.0 * max(1, n - 1) - 1.0)) if n > 2 else 1.0
    hedges_g_paired = float(cohens_dz * j_corr)
    ci_lo, ci_hi = bootstrap_ci_mean_diff(diff)

    return {
        "family": family,
        "comparison": name,
        "n": n,
        "mean_A": round(float(np.mean(a)), 3),
        "sd_A": round(sd_a, 3),
        "median_A": round(float(np.median(a)), 3),
        "iqr_A": round(float(np.percentile(a, 75) - np.percentile(a, 25)), 3),
        "mean_B": round(float(np.mean(b)), 3),
        "sd_B": round(sd_b, 3),
        "median_B": round(float(np.median(b)), 3),
        "iqr_B": round(float(np.percentile(b, 75) - np.percentile(b, 25)), 3),
        "mean_diff": round(float(np.mean(diff)), 3),
        "ci95_diff": [round(ci_lo, 3), round(ci_hi, 3)],
        "paired_t": round(float(t_rel), 4),
        "paired_p": float(p_rel),
        "welch_t_ddof1": round(float(t_welch), 4),
        "welch_p_ddof1": float(p_welch),
        "wilcoxon_stat": round(float(w_stat), 4),
        "wilcoxon_p": float(p_wilcoxon),
        "levene_bf_stat": round(float(lev_stat), 4),
        "levene_bf_p": float(lev_p),
        "paired_cohens_dz": round(cohens_dz, 4),
        "hedges_g": round(hedges_g_paired, 4),
        "cliffs_delta": round(cliffs_delta(a, b), 4),
    }


def holm_bonferroni(pvals: list[float]) -> list[float]:
    m = len(pvals)
    if m == 0:
        return []
    order = np.argsort(pvals)
    adjusted = np.empty(m, dtype=float)
    prev = 0.0
    for rank, idx in enumerate(order):
        adj = min(1.0, max(prev, pvals[idx] * (m - rank)))
        adjusted[idx] = adj
        prev = adj
    return [float(x) for x in adjusted]


def main() -> None:
    v2 = json.loads(V2_JSON.read_text(encoding="utf-8"))
    ca = v2["constructiveAndAblation"]

    def vec(key: str, metric: str) -> list[float]:
        return [float(r[metric]) for r in ca[key]["runs"]]

    comparisons = [
        # Family 1: Equal-Budget 1.8s Search Mechanism Comparison (Identical Surrogate Objective)
        compare_paired("RQ1_Search_1.8s", "MN-LAHC (1.8s) vs Stage-1 DSATUR (H_gated)", vec("MN_LAHC_1_8s", "gatedHumaneScore"), vec("Stage1_DSATUR", "gatedHumaneScore")),
        compare_paired("RQ1_Search_1.8s", "Tuned SA (4-Op) vs Pure SA (2-Op) (H_gated)", vec("TunedSA_4Op_FixedReheat", "gatedHumaneScore"), vec("PureSA_2Op", "gatedHumaneScore")),
        compare_paired("RQ1_Search_1.8s", "MN-LAHC (1.8s) vs Pure SA (2-Op) (H_gated)", vec("MN_LAHC_1_8s", "gatedHumaneScore"), vec("PureSA_2Op", "gatedHumaneScore")),
        compare_paired("RQ1_Search_1.8s", "MN-LAHC (1.8s) vs Tuned SA (4-Op) (H_gated)", vec("MN_LAHC_1_8s", "gatedHumaneScore"), vec("TunedSA_4Op_FixedReheat", "gatedHumaneScore")),

        # Family 2: Symmetric 2x2 Equal-Time 10.4s Ablation ({MN-LAHC, Stage-4} x {Student-Focused, Equity w_lec=300})
        compare_paired("RQ2_Symm_10.4s", "MN-LAHC Std (10.4s) vs MN-LAHC (1.8s) (H_gated)", vec("MN_LAHC_Std_10_4s", "gatedHumaneScore"), vec("MN_LAHC_1_8s", "gatedHumaneScore")),
        compare_paired("RQ2_Symm_10.4s", "Stage-4 Student-Only (10s) vs MN-LAHC Std (10.4s) (H_gated)", vec("Stage4_StudentOnly_10s", "gatedHumaneScore"), vec("MN_LAHC_Std_10_4s", "gatedHumaneScore")),
        compare_paired("RQ2_Symm_10.4s", "MN-LAHC Equity (10.4s) vs MN-LAHC Std (10.4s) (H_bal,0.6)", vec("MN_LAHC_Equity_10_4s", "balancedScore06"), vec("MN_LAHC_Std_10_4s", "balancedScore06")),
        compare_paired("RQ2_Symm_10.4s", "Stage-4 Equity (10s) vs MN-LAHC Equity (10.4s) (H_gated)", vec("Stage4_EquityAware_10s", "gatedHumaneScore"), vec("MN_LAHC_Equity_10_4s", "gatedHumaneScore")),
        compare_paired("RQ2_Symm_10.4s", "Stage-4 Equity (10s) vs MN-LAHC Equity (10.4s) (H_bal,0.3)", vec("Stage4_EquityAware_10s", "balancedScore03"), vec("MN_LAHC_Equity_10_4s", "balancedScore03")),
        compare_paired("RQ2_Symm_10.4s", "Stage-4 Equity (10s) vs MN-LAHC Equity (10.4s) (H_bal,0.6)", vec("Stage4_EquityAware_10s", "balancedScore06"), vec("MN_LAHC_Equity_10_4s", "balancedScore06")),
        compare_paired("RQ2_Symm_10.4s", "Stage-4 Equity (10s) vs Stage-4 Student-Only (10s) (H_bal,0.3)", vec("Stage4_EquityAware_10s", "balancedScore03"), vec("Stage4_StudentOnly_10s", "balancedScore03")),
        compare_paired("RQ2_Symm_10.4s", "Stage-4 Equity (10s) vs Stage-4 Student-Only (10s) (H_bal,0.6)", vec("Stage4_EquityAware_10s", "balancedScore06"), vec("Stage4_StudentOnly_10s", "balancedScore06")),

        # Family 3: TPE Marginal Contribution (Same 2-round Stage-4 Equity, n=10 & Held-Out n=5)
        compare_paired("RQ3_TPE_Marginal", "TPE+Stage-4 Equity vs Stage-4 Equity (No TPE) (n=10, H_gated)", vec("TPE_Stage4_Equity_n10", "gatedHumaneScore"), vec("Stage4_EquityAware_10s", "gatedHumaneScore")),
        compare_paired("RQ3_TPE_Marginal", "TPE+Stage-4 Equity vs Stage-4 Equity (No TPE) (n=10, H_bal,0.3)", vec("TPE_Stage4_Equity_n10", "balancedScore03"), vec("Stage4_EquityAware_10s", "balancedScore03")),
    ]

    ho = v2["splitSeedTpeValidation"]
    comparisons.extend([
        compare_paired("RQ3_TPE_Marginal", "Held-Out (n=5): TPE (No S4) vs Default MN-LAHC (H_gated)",
                       [r["gatedHumaneScore"] for r in ho["heldOutTpeNoStage4"]["runs"]],
                       [r["gatedHumaneScore"] for r in ho["heldOutDefault"]["runs"]]),
        compare_paired("RQ3_TPE_Marginal", "Held-Out (n=5): TPE+Stage-4 Eq vs Stage-4 Eq (No TPE) (H_gated)",
                       [r["gatedHumaneScore"] for r in ho["heldOutTpePlusStage4Equity"]["runs"]],
                       [r["gatedHumaneScore"] for r in ho["heldOutStage4EquityNoTpe"]["runs"]]),
    ])

    # Family 4: Friday Prayer 3-Way Sensitivity (n=10)
    fri = v2["policySensitivity"]["fridayPrayer3Way"]
    comparisons.extend([
        compare_paired("RQ4_Policy_Friday", "Friday Soft Penalty vs Uniform 12-13 (Friday Overlaps)",
                       [r["fridayPrayerViolations"] for r in fri["softPenalty1130to1300"]["runs"]],
                       [r["fridayPrayerViolations"] for r in fri["uniformBreak12to13"]["runs"]]),
        compare_paired("RQ4_Policy_Friday", "Friday Hard Exclusion vs Uniform 12-13 (H_gated)",
                       [r["gatedHumaneScore"] for r in fri["hardExclusion1130to1300"]["runs"]],
                       [r["gatedHumaneScore"] for r in fri["uniformBreak12to13"]["runs"]]),
    ])

    # Family 5: Dynamic Local Repair vs Warm-Start Resolve (BOTH Dense Stage-4 Equity & MN-LAHC bases)
    for key, label in [("onDenseStage4Equity", "Dense Stage-4 Eq"), ("onMnLahc", "MN-LAHC")]:
        suite = v2["dynamicRescheduling"][key]
        paired_d, paired_w = [], []
        for dt, wt in zip(suite["dynConflictTrials"], suite["warmStartTrials"]):
            if dt["feasible"] and wt["feasible"]:
                paired_d.append(float(dt["perturbationCount"]))
                paired_w.append(float(wt["perturbed"]))
        if len(paired_d) >= 3:
            comparisons.append(
                compare_paired("RQ5_Dynamic_MPP", f"Ejection Local Repair vs Warm-Start ({label}, Secondary Moves)", paired_d, paired_w)
            )

    # Apply Holm-Bonferroni SEPARATELY per research question family
    by_fam: dict[str, list[int]] = {}
    for idx, c in enumerate(comparisons):
        by_fam.setdefault(c["family"], []).append(idx)
    for fam, indices in by_fam.items():
        hp = holm_bonferroni([comparisons[i]["paired_p"] for i in indices])
        hw = holm_bonferroni([comparisons[i]["wilcoxon_p"] for i in indices])
        for i, p_h, w_h in zip(indices, hp, hw):
            comparisons[i]["paired_p_holm"] = p_h
            comparisons[i]["wilcoxon_p_holm"] = w_h

    # Formal TOST Equivalence Tests for TPE vs No-TPE (Lakens 2017)
    tost_results = {
        "tpe_vs_noTpe_n10_Hgated_bound1_5": paired_tost(vec("TPE_Stage4_Equity_n10", "gatedHumaneScore"), vec("Stage4_EquityAware_10s", "gatedHumaneScore"), 1.5),
        "tpe_vs_noTpe_n10_Hgated_bound2_0": paired_tost(vec("TPE_Stage4_Equity_n10", "gatedHumaneScore"), vec("Stage4_EquityAware_10s", "gatedHumaneScore"), 2.0),
        "tpe_vs_noTpe_n10_Hbal03_bound1_5": paired_tost(vec("TPE_Stage4_Equity_n10", "balancedScore03"), vec("Stage4_EquityAware_10s", "balancedScore03"), 1.5),
        "tpe_vs_noTpe_n10_Hbal03_bound2_0": paired_tost(vec("TPE_Stage4_Equity_n10", "balancedScore03"), vec("Stage4_EquityAware_10s", "balancedScore03"), 2.0),
        "tpe_vs_noTpe_heldOut5_Hgated_bound2_0": paired_tost(
            [r["gatedHumaneScore"] for r in ho["heldOutTpePlusStage4Equity"]["runs"]],
            [r["gatedHumaneScore"] for r in ho["heldOutStage4EquityNoTpe"]["runs"]],
            2.0,
        ),
    }

    report = {
        "protocol": "GLP Symmetric 10.4s Equal-Time Family-Wise Holm-Bonferroni + TOST Statistical Analysis (ddof=1)",
        "comparisons": comparisons,
        "tostEquivalence": tost_results,
    }
    OUT_JSON.write_text(json.dumps(report, indent=2), encoding="utf-8")

    lines = [
        "# GLP Statistical Analysis Report (Symmetric 10.4s Equal-Time Controlled Ablation + TOST)",
        "",
        "| Family | Comparison | n | Mean±SD (A) | Mean±SD (B) | Diff [95% Boot CI] | Paired t (p_holm) | Wilcoxon (p_holm) | Levene BF p | Hedges' g | Cliff's δ |",
        "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for c in comparisons:
        lines.append(
            f"| {c['family']} | {c['comparison']} | {c['n']} | {c['mean_A']:.2f}±{c['sd_A']:.2f} | "
            f"{c['mean_B']:.2f}±{c['sd_B']:.2f} | {c['mean_diff']:+.2f} [{c['ci95_diff'][0]:+.2f}, {c['ci95_diff'][1]:+.2f}] | "
            f"{c['paired_t']:.2f} ({c['paired_p_holm']:.2e}) | {c['wilcoxon_stat']:.1f} ({c['wilcoxon_p_holm']:.2e}) | "
            f"{c['levene_bf_p']:.3f} | {c['hedges_g']:+.2f} | {c['cliffs_delta']:+.2f} |"
        )
    lines.extend([
        "",
        "## TOST Practical Equivalence Tests for TPE vs. Default Stage-4 Equity",
        "",
        "| Test | Bound (±pts) | Mean Diff | 90% CI | p_TOST | Equivalent (α=0.05) |",
        "|---|---:|---:|---|---:|---|",
    ])
    for k, t in tost_results.items():
        lines.append(
            f"| {k} | ±{t['bound']:.1f} | {t['mean_diff']:+.3f} | [{t['ci90_diff'][0]:+.3f}, {t['ci90_diff'][1]:+.3f}] | {t['p_tost']:.4f} | {'Yes' if t['equivalent_at_alpha05'] else 'No'} |"
        )
    OUT_MD.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
