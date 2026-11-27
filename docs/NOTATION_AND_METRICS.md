# Notation, Abbreviations, Metrics, and Formal Sub-Score Formulas

## 1. List of Abbreviations

| Abbreviation | Full Term | Context |
|---|---|---|
| **Asprak** | *Asisten Praktikum* (Laboratory Assistant) | Senior student cohort (semester $s+2$) assisting wet-lab practicals |
| **CSP** | Constraint Satisfaction Problem | Formal combinatorial timetabling framework |
| **DSATUR** | Degree of Saturation | Constructive graph-coloring ordering heuristic (Stage 1) |
| **GLP** | Good Laboratory Practice | Standardized experimental benchmarking protocol (Kendall et al. 2016) |
| **ISHOMA** | *Istirahat, Sholat, Makan* | Midday rest, prayer, and lunch break (`12:00-13:00` Mon-Thu; `11:30-13:00` Fri) |
| **LA** | Laboratory Assistant | English synonym for Asprak |
| **MILP** | Mixed-Integer Linear Programming | Exact mathematical optimization baseline (HiGHS) |
| **MN-LAHC** | Multi-Neighborhood Late Acceptance Hill-Climbing | Stage-2 metaheuristic with six local neighborhoods and SA reheating |
| **OCC** | Optimistic Concurrency Control | Version-checked Cloudflare D1 persistence (HTTP 409 conflict guard) |
| **SA** | Simulated Annealing | Probabilistic local-search baseline (2-Op Pure SA and 4-Op Tuned SA) |
| **SIAKAD** | *Sistem Informasi Akademik* | Institutional academic portal export schema (SIAKAD V2) |
| **TOST** | Two One-Sided Tests | Formal statistical equivalence test (Lakens 2017) |
| **TPE** | Tree-structured Parzen Estimator | Sequential model-based hyperparameter optimizer |
| **UAS** | *Ujian Akhir Semester* | Institutional final examination timetable module |
| **UCTP** | University Course Timetabling Problem | NP-hard scheduling problem class |

---

## 2. Symbol Glossary

| Symbol | Formal Meaning | Unit / Domain |
|---|---|---|
| $X = \{x_1, \dots, x_{280}\}$ | Active weekly instructional sessions | Set ($\|X\| = 280$) |
| $A(x_i) = (d_i, t_i, r_i)$ | Assignment of weekday, start minute, and room | $d_i \in \{\text{Mon}..\text{Fri}\}$, $t_i \in [420, 1140]$, $r_i \in D_{\text{room}}(x_i)$ |
| $l_i$ | Session duration | Minutes ($\{50, 100, 150, 170, 340\}$) |
| $\Pi \subseteq X$ | Fixed institutional reservations (doctoral-study lecturers) | Locked subset |
| $K(x_i)$ | Expanded class cohort set (links practical sub-cohorts to parent class) | Cohort identifiers |
| $R_{\text{Pasca}}$ | Nine borrowed Postgraduate rooms restricted to Mon-Wed | Room subset |
| $X_{\text{wet}}$ | 32 wet-laboratory practical sessions requiring senior LAs | Session subset |
| $S(w)$ | Eligible senior cohorts (semester $s+2$) for wet lab $w$ | Cohort subset |
| `WORK_END` | Standard afternoon soft-penalty cutoff (`16:20`, `980` min) | Minutes |
| `s` / `ms` | SI runtime units: seconds / milliseconds | Time |
| `d` (EN) / `hari` (ID) | Days per week (strictly separated from hours `h` / `j`) | Days |
| `h` (EN) / `j` (ID) | Hours (e.g., `<= 5h` = `300 min` continuous block) | Hours |
| `min` / `mnt` | Minutes (e.g., `> 1,420 min`, `>= 100 min` idle gap) | Minutes |
| `C/L` (EN) / `K/D` (ID) | Class (Kelas) / Lecturer (Dosen) breakdown | Count |

---

## 3. Wet-Lab Assistant (Asprak) Status Definitions

For each wet-laboratory practical $w \in X_{\text{wet}}$ with eligible senior cohorts $S(w)$:

- **`CLEAR`:** Every eligible senior cohort $c \in S(w)$ is unassigned during $w$ (`busySeniors = 0`).
- **`PARTIAL`:** At least one senior cohort $c \in S(w)$ is free (`freeSeniors >= 1`), satisfying hard constraint (3), while at least one other senior cohort is busy (`busySeniors >= 1`). Penalized softly (`0.25` in $H_{\text{comp}}$).
- **`DEADLOCK`:** Zero eligible senior cohorts are free (`freeSeniors = 0`). Treated as a hard constraint violation (`asprakDeadlockCount`).

---

## 4. Standardized Weekly Workload Threshold (`1,420 min`) and Friday Prayer Window (`11:30-13:00`)

- In `solver/src/humane-evaluator.ts`, the 4-day fallback exception is `totalWeeklyMin > 1420`. Independent audit (`results/capacity_audit.json`) confirms the top classes are `Teknologi Pangan 5B` (`1,750 min`), `Teknologi Pangan 5A` (`1,700 min`), and `Teknologi Pangan 3B` (`1,580 min`), while the fourth highest is `Bioteknologi 3A` (`1,410 min`). Thus dynamic `compactCeiling` equals `33` out of `36` classes (`|C_<=1420| = 33`), and `gapNormRef = round(1.8 * |C|) = 65`.
- When `hardFridayPrayer = true`, any session on Friday (`Jumat`) overlapping `[690, 780)` (`11:30-13:00`) is rejected in $O(1)$ inside `BitmaskIndex.canPlaceHard()` and gated as a hard violation in `auditSchedule()`. Friday idle-gap computation (`effectiveDeadGap`) subtracts the `[690, 780)` window so the Friday prayer break is never counted as a dead waiting gap.

---

## 5. Unified Surrogate Objective $F_{\text{soft}}(A)$

Pure SA (2-Op), Tuned SA (4-Op), Stage-2 MN-LAHC (`F_soft`), and Stage-4 (`F_soft` control in the 2x2 factorial matrix) minimize the identical unified surrogate objective in `computeGlobalHumaneEnergy()` and `computeFastEnergy()`:

- Hole days: `w_hole = 3,200`
- 5-day class spread: `w_day5 = 1,050`
- Early start `07:00`: `w_early0700 = 980`; overflow start `07:50`: `w_early0750 = 180`
- Student isolated single-course day: `w_lone = 920`
- 4-day class spread (classes `<= 1,420 min`): `w_day4 = 460`
- Idle gaps `>= 100 min` (outside ISHOMA / Friday prayer): `w_gap = 280`
- Late sessions finishing `> 16:20` (`WORK_END = 980`): `w_late = 110`
- Friday prayer overlap (soft mode): `w_fri = 500` (hard bitmask exclusion when `hardFridayPrayer = true`)
- Symmetric lecturer single-course day weight: `w_lec = 95` (standard) or `w_lec = 300` (equity control)

---

## 6. Explicit Sub-Score Formulas for $H_{\text{raw}}(A)$, $H_{\text{gated}}(A)$, and $H_{\text{bal},\lambda}(A)$

Matching `solver/src/humane-evaluator.ts` (`lines 697-726`) exactly, let $N = |X|$ be the session count (`280`), $M = |C|$ be the atomic class count (`36`), $M_{\le 1420} = \max(1, |\{c \in C : \text{WeeklyMin}(c) \le 1420\}|)$ (`33`), and $G_{\text{ref}} = \max(1, \text{round}(1.8 M))$ (`65`). The five additive sub-scores summing to $H_{\text{raw}}(A) \in [0, 100]$ are:

$$H_{\text{start}}(A) = 25 \cdot \frac{N - E_{<08:40}(A) - 0.5 \, E_{<07:50}(A)}{N} \tag{H.1}$$

$$H_{\text{contig}}(A) = 25 \cdot \frac{C_{\text{contig}}(A)}{M} \tag{H.2}$$

$$H_{\text{compact}}(A) = 20 \cdot \min\!\left(1,\, \frac{C_{\le 3\text{d}}(A)}{M_{\le 1420}}\right) \tag{H.3}$$

$$H_{\text{gap}}(A) = 15 \cdot \max\!\left(0,\, 1 - \frac{G_{\text{cls}}(A) + G_{\text{lec}}(A)}{G_{\text{ref}}}\right) \tag{H.4}$$

$$H_{\text{comp}}(A) = \max\!\Big(0,\; 15 - \big(4 V_{\text{clash}} + 0.5 V_{\text{Pasca}} + 2.5 V_{\text{dead}} + 0.25 V_{\text{part}} + 1.5 V_{\text{ISHOMA}} + 0.8 V_{\text{mar}} + 0.6 V_{\text{iso,cls}}\big)\Big) \tag{H.5}$$

$$H_{\text{raw}}(A) = \operatorname{clip}_{[0,100]}\!\big(H_{\text{start}} + H_{\text{contig}} + H_{\text{compact}} + H_{\text{gap}} + H_{\text{comp}}\big) \tag{H.6}$$

To prevent infeasible solutions from trading hard violations against soft ergonomics:

$$H_{\text{gated}}(A) = \begin{cases} H_{\text{raw}}(A), & \text{if } A \models C_H \text{ (0 clashes, 0 Pasca Thu-Fri, 0 LA deadlocks, 0 hard Friday overlaps)} \\ 0, & \text{otherwise} \end{cases} \tag{H.7}$$

Multi-stakeholder lecturer equity is audited at $\lambda \in \{0.3, 0.6\}$:

$$H_{\text{bal},\lambda}(A) = \max\!\big(0,\, H_{\text{gated}}(A) - \lambda \cdot \text{LecturerIsolatedDays}(A)\big). \tag{H.8}$$

### Objective-Alignment Disclosure (Stage-4 Polishing vs. $H_{\text{bal},\lambda}$)

In Stage-4 polishing (`deepPolishSchedule`), the objective maximizes $1000 \cdot H_{\text{raw}}(A) - w_{\text{lec}} \cdot \text{LecturerIsolatedDays}(A)$ (plus tie-breaking smooth guidance). Expressed in $H$-score points, the normalized lecturer weight is:

$$\tilde{w}_{\text{lec}} = \frac{w_{\text{lec}}}{1000} \in \begin{cases} 0.00035 \approx 0, & \text{Stage-4 Student-Only} \\ 0.30, & \text{Stage-4 Equity-Aware} \end{cases}$$

Because $\tilde{w}_{\text{lec}} = 0.30$ matches $\lambda = 0.3$ in $H_{\text{bal},0.3}$, improvements on $H_{\text{bal},0.3}$ under `Obj_S4` reflect direct objective optimization. Accordingly, **$H_{\text{bal},0.6}$ (not directly optimized) and raw `LecturerIsolatedDays`** are designated as the primary balanced-equity metrics, complemented by the full **2x2 objective-by-algorithm factorial matrix** (`{MN-LAHC, Stage-4} x {F_soft, Obj_S4}`).
