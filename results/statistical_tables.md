# GLP Statistical Analysis Report (Symmetric 10.4s Equal-Time Controlled Ablation + TOST)

| Family | Comparison | n | Mean±SD (A) | Mean±SD (B) | Diff [95% Boot CI] | Paired t (p_holm) | Wilcoxon (p_holm) | Levene BF p | Hedges' g | Cliff's δ |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| RQ1_Search_1.8s | MN-LAHC (1.8s) vs Stage-1 DSATUR (H_gated) | 10 | 87.13±1.48 | 69.34±2.65 | +17.79 [+16.10, +19.28] | 20.40 (3.05e-08) | 0.0 (7.81e-03) | 0.171 | +5.90 | +1.00 |
| RQ1_Search_1.8s | Tuned SA (4-Op) vs Pure SA (2-Op) (H_gated) | 10 | 79.34±2.36 | 78.90±2.12 | +0.44 [-0.61, +1.46] | 0.77 (4.61e-01) | 16.0 (4.96e-01) | 0.666 | +0.22 | +0.15 |
| RQ1_Search_1.8s | MN-LAHC (1.8s) vs Pure SA (2-Op) (H_gated) | 10 | 87.13±1.48 | 78.90±2.12 | +8.23 [+6.81, +9.54] | 11.31 (2.54e-06) | 0.0 (7.81e-03) | 0.481 | +3.27 | +1.00 |
| RQ1_Search_1.8s | MN-LAHC (1.8s) vs Tuned SA (4-Op) (H_gated) | 10 | 87.13±1.48 | 79.34±2.36 | +7.79 [+6.78, +8.85] | 14.10 (5.80e-07) | 0.0 (7.81e-03) | 0.193 | +4.08 | +1.00 |
| RQ2_Symm_10.4s | MN-LAHC Std (10.4s) vs MN-LAHC (1.8s) (H_gated) | 10 | 88.12±2.53 | 87.13±1.48 | +0.99 [-0.56, +2.52] | 1.20 (2.61e-01) | 16.0 (2.75e-01) | 0.203 | +0.35 | +0.27 |
| RQ2_Symm_10.4s | Stage-4 Student-Only (10s) vs MN-LAHC Std (10.4s) (H_gated) | 10 | 94.18±1.34 | 88.12±2.53 | +6.06 [+4.64, +7.24] | 8.80 (6.13e-05) | 0.0 (1.56e-02) | 0.151 | +2.55 | +0.98 |
| RQ2_Symm_10.4s | MN-LAHC Equity (10.4s) vs MN-LAHC Std (10.4s) (H_bal,0.6) | 10 | 77.27±3.30 | 72.58±2.44 | +4.69 [+2.50, +6.75] | 4.09 (1.09e-02) | 3.0 (2.93e-02) | 0.240 | +1.18 | +0.76 |
| RQ2_Symm_10.4s | Stage-4 Equity (10s) vs MN-LAHC Equity (10.4s) (H_gated) | 10 | 90.51±1.63 | 87.29±1.42 | +3.22 [+1.97, +4.65] | 4.47 (7.78e-03) | 0.0 (1.56e-02) | 0.663 | +1.29 | +0.91 |
| RQ2_Symm_10.4s | Stage-4 Equity (10s) vs MN-LAHC Equity (10.4s) (H_bal,0.3) | 10 | 85.14±2.47 | 82.28±2.13 | +2.86 [+1.40, +4.43] | 3.45 (2.17e-02) | 0.0 (1.56e-02) | 0.768 | +1.00 | +0.74 |
| RQ2_Symm_10.4s | Stage-4 Equity (10s) vs MN-LAHC Equity (10.4s) (H_bal,0.6) | 10 | 79.77±3.65 | 77.27±3.30 | +2.50 [+0.53, +4.53] | 2.30 (9.45e-02) | 10.0 (1.68e-01) | 0.471 | +0.66 | +0.45 |
| RQ2_Symm_10.4s | Stage-4 Equity (10s) vs Stage-4 Student-Only (10s) (H_bal,0.3) | 10 | 85.14±2.47 | 77.71±2.16 | +7.43 [+5.89, +8.86] | 9.34 (4.42e-05) | 0.0 (1.56e-02) | 0.735 | +2.70 | +0.94 |
| RQ2_Symm_10.4s | Stage-4 Equity (10s) vs Stage-4 Student-Only (10s) (H_bal,0.6) | 10 | 79.77±3.65 | 61.24±3.44 | +18.53 [+15.74, +21.05] | 13.11 (2.90e-06) | 0.0 (1.56e-02) | 0.625 | +3.79 | +1.00 |
| RQ3_TPE_Marginal | TPE+Stage-4 Equity vs Stage-4 Equity (No TPE) (n=10, H_gated) | 10 | 90.84±2.09 | 90.51±1.63 | +0.33 [-0.49, +1.23] | 0.71 (9.92e-01) | 22.5 (1.00e+00) | 0.285 | +0.21 | +0.10 |
| RQ3_TPE_Marginal | TPE+Stage-4 Equity vs Stage-4 Equity (No TPE) (n=10, H_bal,0.3) | 10 | 84.27±2.78 | 85.14±2.47 | -0.87 [-2.07, +0.33] | -1.35 (6.30e-01) | 12.0 (7.15e-01) | 0.420 | -0.39 | -0.13 |
| RQ3_TPE_Marginal | Held-Out (n=5): TPE (No S4) vs Default MN-LAHC (H_gated) | 5 | 88.66±1.34 | 86.80±1.76 | +1.86 [+0.40, +2.98] | 2.53 (2.59e-01) | 1.0 (5.00e-01) | 0.657 | +0.91 | +0.56 |
| RQ3_TPE_Marginal | Held-Out (n=5): TPE+Stage-4 Eq vs Stage-4 Eq (No TPE) (H_gated) | 5 | 90.46±1.66 | 90.16±1.39 | +0.30 [-0.72, +1.32] | 0.50 (9.92e-01) | 6.0 (1.00e+00) | 0.638 | +0.18 | +0.04 |
| RQ4_Policy_Friday | Friday Soft Penalty vs Uniform 12-13 (Friday Overlaps) | 10 | 3.20±0.92 | 6.90±0.99 | -3.70 [-4.50, -2.90] | -8.75 (2.15e-05) | 0.0 (3.91e-03) | 0.749 | -2.53 | -0.99 |
| RQ4_Policy_Friday | Friday Hard Exclusion vs Uniform 12-13 (H_gated) | 10 | 87.13±1.48 | 86.76±2.69 | +0.37 [-0.83, +1.61] | 0.56 (5.88e-01) | 19.0 (7.34e-01) | 0.445 | +0.16 | -0.08 |
| RQ5_Dynamic_MPP | Ejection Local Repair vs Warm-Start (Dense Stage-4 Eq, Secondary Moves) | 58 | 1.62±0.56 | 15.98±6.03 | -14.36 [-15.85, -12.84] | -18.62 (1.34e-25) | 0.0 (6.86e-11) | 0.000 | -2.41 | -1.00 |
| RQ5_Dynamic_MPP | Ejection Local Repair vs Warm-Start (MN-LAHC, Secondary Moves) | 58 | 1.62±0.52 | 17.93±7.04 | -16.31 [-18.02, -14.60] | -18.33 (1.45e-25) | 0.0 (6.86e-11) | 0.000 | -2.37 | -1.00 |

## TOST Practical Equivalence Tests for TPE vs. Default Stage-4 Equity

| Test | Bound (±pts) | Mean Diff | 90% CI | p_TOST | Equivalent (α=0.05) |
|---|---:|---:|---|---:|---|
| tpe_vs_noTpe_n10_Hgated_bound1_5 | ±1.5 | +0.330 | [-0.523, +1.183] | 0.0165 | Yes |
| tpe_vs_noTpe_n10_Hgated_bound2_0 | ±2.0 | +0.330 | [-0.523, +1.183] | 0.0029 | Yes |
| tpe_vs_noTpe_n10_Hbal03_bound1_5 | ±1.5 | -0.870 | [-2.051, +0.311] | 0.1769 | No |
| tpe_vs_noTpe_n10_Hbal03_bound2_0 | ±2.0 | -0.870 | [-2.051, +0.311] | 0.0567 | No |
| tpe_vs_noTpe_heldOut5_Hgated_bound2_0 | ±2.0 | +0.300 | [-0.967, +1.567] | 0.0229 | Yes |
