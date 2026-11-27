# Formal Pseudocode — Modular Client-Side Ergonomics-Aware Solver & Dynamic Repair

This document provides algorithmic pseudocode matching the exact TypeScript implementation in `solver/src/alns-lahc-solver.ts`, `solver/src/bitmask-index.ts`, `solver/src/humane-evaluator.ts`, and `solver/src/tpe-tuner.ts`. The modular architecture pairs a **DSATUR + MN-LAHC core** (Algorithms 1–2) with **optional Stage 3–4 polishing** (Algorithms 3–4) and **live minimal-perturbation repair** (Algorithm 5).

---

## Algorithm 1: Stage 1 — Progressive Start-Floor DSATUR with Day-Windowed Wet-Lab Staggering

**Input:** Session set $X$, room set $R$, policy $\pi$ (including optional `hardFridayPrayer`), seed $s$  
**Output:** Hard-feasible initial assignment $A_1$

1. Initialize 160-bit occupancy bitsets ($5$ days $\times$ $156$ five-minute quanta in $[420, 1200)$) for rooms, lecturers, expanded cohorts $K(x)$, and senior cohorts $S(w)$, plus O(1) Friday prayer mask $[690, 780)$ (`11:30-13:00`) when `hardFridayPrayer = true`.
2. **Place pinned sessions:** $\forall p \in \Pi$, commit $A_1(p)$ directly into bitsets.
3. **Day-windowed wet-lab staggering:** Group shared saturated wet labs (e.g., `LAB. KIMIA` across BTK and IL) and prefer alternating contiguous day windows ($\{\text{Mon, Tue, Wed}\}$ vs. $\{\text{Wed, Thu, Fri}\}$) so semester-$s$ wet labs coincide with free slots of semester-$(s+2)$ senior cohorts.
4. **Hardest-first ordering:** Sort unplaced sessions $x \in X \setminus \Pi$ descending by static difficulty score (`340 min` double practicals $>$ wet labs $>$ dry labs $>$ `150 min` lectures $>$ `50/100 min` lectures, weighted by cohort/lecturer weekly minutes and degree).
5. **Progressive Start-Floor placement:**
   - Start with ergonomic floor $t_{\text{floor}} = 08{:}40$ (`520` min).
   - Select next unassigned session $x^*$ maximizing DSATUR saturation (fewest remaining feasible `(day, start, room)` candidates).
   - Score feasible candidates by contiguous class window fit, senior cohort clearance, Friday prayer clearance, and minimal daily spread.
   - **1-2-blocker ejection:** If zero conflict-free slots exist, attempt ejecting 1 or 2 unpinned blocking sessions $B \subset X \setminus \Pi$, place $x^*$, and re-insert $B$ into alternative feasible slots (rollback on failure).
   - If still unplaced after ejection retries, relax $t_{\text{floor}}$ progressively ($08{:}40 \to 07{:}50 \to 07{:}00$) or trigger a randomized restart with perturbed tie-breaking.

---

## Algorithm 2: Stage 2 — Two-Phase Lexicographic Adaptive Multi-Neighborhood LAHC (MN-LAHC) with Geometric SA Reheating

**Input:** Feasible $A_1$, hyperparameters $(L, T_0, \alpha, \rho_{2A}, w_{\text{day4}}, w_{\text{gap}}, \dots)$, budget $B_{\text{ms}}$  
**Output:** Improved feasible assignment $A_2$

1. Initialize LAHC circular fitness list $F[0..L-1] \leftarrow E(A_1)$ (`L = 65`), current $A \leftarrow A_1$, best $A^* \leftarrow A_1$, temperature $T \leftarrow T_0$, and roulette operator weights $W[1..6] = 1.0$.
2. **Phase 2A (Contiguity Locking, first $\rho_{2A}$ of budget):**
   - Set $w_{\text{lone}} \leftarrow 0$ (protecting classes with $\le 3$ sessions) and prioritize hole-day penalty $w_{\text{hole}} = 3200$ so all 36 classes reach contiguous active-day spans.
3. **Phase 2B (Compactness & Gap Refinement, remaining budget):**
   - Minimize the unified surrogate objective $F_{\text{soft}}(A)$ (`w_hole = 3200`, `w_day5 = 1050`, `w_early0700 = 980`, `w_lone = 920`, `w_day4 = 460`, `w_gap = 280`, `w_early0750 = 180`, `w_late1620 = 110`, configurable lecturer-equity weight `w_lec in {95 (standard), 300 (equity)}`, plus `w_fri = 500` soft or hard bitmask exclusion).
   - **2x2 Factorial Objective Switch (`useExactObjective`):** For the 2x2 Objective $\times$ Algorithm audit ($\{\text{MN-LAHC}, \text{Stage-4}\} \times \{F_{\text{soft}}, \text{Obj}_{\text{S4}}\}$, $n = 30$ seeds), Stage 2 also supports directly minimizing $-\text{Obj}_{\text{S4}}(A) = -(1000\cdot H_{\text{raw}}(A) - 300\cdot\text{LecIso}(A))$ with normalized $\tilde{w}_{\text{lec}} = 0.30$. Under identical $\text{Obj}_{\text{S4}}$, standalone Stage-2 `MN-LAHC (Obj_S4)` (`10.56 s`) reaches $H_{\text{gated}} = 89.32 \pm 1.84$ and `78.06` balanced equity at $\lambda = 0.6$ (`18.8` isolated lecturer days).
4. **Main loop (while iterations $< M_{\max}$ and elapsed $< B_{\text{ms}}$):**
   - Select one of six local neighborhoods $k \in \{1..6\}$ via adaptive roulette weights $W$ (note: local single/pair moves rather than classical destroy-and-repair ALNS):
     1. `hole-collapse` (move outer-day session into an interior hole/active day)
     2. `isolated-day-merge` (relocate a 1-session day onto an existing active day)
     3. `gap-tightening` (shift same-day session to reduce idle gap $\ge 100$ min)
     4. `la-relocation` (move wet-lab or senior session to eliminate `DEADLOCK`/`PARTIAL` overlap)
     5. `single-shift` (move 1 session to a feasible `(day, start, room)`)
     6. `pair-swap` (swap 2 compatible sessions)
   - Verify hard feasibility in $O(1)$ using 160-bit bitmasks (including `hardFridayPrayer`); compute candidate surrogate energy $E(A')$.
   - **Hybrid acceptance (LAHC + SA):** Let $v = \text{iter} \bmod L$. Accept $A'$ if $E(A') \le E(A)$ OR $E(A') \le F[v]$ OR $\text{rand}() < \exp(-(E(A') - E(A)) / T)$.
   - Update $F[v] \leftarrow E(A)$, best solution $A^*$, adaptive operator scores $\sigma_k$, and cool $T \leftarrow \max(T_{\min}, \alpha T)$.
   - **Geometric reheating:** When stagnant beyond the patience threshold, reheat $T$ toward $T_0$ and reset stagnation counter.

---

## Algorithm 3: Optional Stage 3 — Deterministic 3-Cycle Bridge Exchange (`skipStage3`)

**Input:** Assignment $A_2$  
**Output:** Assignment $A_3$ with residual non-contiguous holes / blocked wet labs repaired

1. Scan classes with residual `holeDays > 0` and wet labs with suboptimal senior availability.
2. For each target session $x_a$ needing relocation into a saturated target slot $s^*$:
   - Identify single blocker $x_b$ occupying $s^*$, and candidate destination $s_b$ blocked by a single session $x_c$.
   - Verify in $O(1)$ bitmask operations whether a 3-cycle rotation $x_a \to s^*$, $x_b \to s_b$, $x_c \to s_{\text{free}}$ preserves all hard constraints $C_H$ and strictly decreases $E(A)$.
   - Commit the first strictly improving 3-cycle bridge exchange.
3. **Component Ablation Note (`skipStage3 = true`, $n = 10$, limited power):** Disabling Stage 3 shows no measurable degradation (`91.25` vs. `90.31` on $H_{\text{gated}}$, `p_holm = 0.643`; `77.33` vs. `77.95` on $H_{\text{bal},0.6}$, `p_holm = 1.00`).

---

## Algorithm 4: Optional Stage 4 — Equity-Aware Strategic Oscillation (`deepPolishSchedule`) & Optional Client-Side TPE

**Input:** Assignment $A_3$, oscillation rounds $R$, normalized lecturer equity weight $\tilde{w}_{\text{lec}} = w_{\text{lec}}/1000 \in \{0.00035\text{ (Student-Only)}, 0.30\text{ (Equity-Aware)}\}$, ablation flags (`useSurrogateObjective`, `disableHalfDayRepack`, `disableOscillation`, `weightScale`), optional TPE budget $N_{\text{trials}}$  
**Output:** Polished assignment $A_4$

1. **Optional Client-Side TPE (Practically Equivalent via Multi-Margin Paired TOST, $n = 30$ & Held-Out $n = 25$):**
   - Sample $N_{\text{startup}}$ uniform hyperparameter tuples $\theta_t \in \Theta$, then partition completed trials at quantile $\gamma = 0.25$ into $D_l$ and $D_g$ with 1D truncated Gaussian Parzen KDEs maximizing $l(\theta)/g(\theta)$.
   - Across $n = 30$ paired seeds, `TPE + S4-Eq` yields `+0.28` on $H_{\text{gated}}$ (`p_holm = 0.807`) and `-0.96` on $H_{\text{bal},0.6}$ (`p_holm = 0.462`). Multi-margin paired TOST (Lakens 2017) confirms practical equivalence on $H_{\text{gated}}$ within `+/-1.0` point at $n = 30$ (`90% CI [-0.17, +0.73]`, `p_TOST = 0.0040`, power `0.978`) and within `+/-1.5` points on held-out $n = 25$ (`p_TOST = 4.10e-4`), and on $H_{\text{bal},0.6}$ within `+/-2.0` points (`p_TOST = 0.0240`). Default execution skips TPE to avoid its `~12.2 s` overhead.
2. **Strategic Oscillation, Objective-Alignment Audit, & Component Ablation:**
   - **Normalized objective disclosure:** Maximizing $1000\cdot H_{\text{raw}} - 300\cdot\text{LecIso}$ divides cleanly into $H_{\text{raw}} - 0.30\cdot\text{LecIso}$, which coincides with $H_{\text{bal},0.3}$ ($\tilde{w}_{\text{lec}} = 0.30 = \lambda$). Therefore, **$H_{\text{bal},0.6}$ (not directly optimized) and raw lecturer isolated days (`LecIso`)** serve as primary balanced-equity metrics.
   - **Controlled relaxation & restoration:** Temporarily relax isolated-day bounds (`2 -> 1 -> 0`) while strictly preserving hard invariants (`0` clashes, `0` Pasca Thu-Fri, `0` LA deadlocks, `0` Friday prayer overlaps when hard-gated) and using dynamic cohort denominators (`compactCeiling`, `gapNormRef`).
   - **2x2 Factorial (`n = 30`) & Component Ablation (`n = 10`, limited power):** Switching `MN-LAHC` to identical $\text{Obj}_{\text{S4}}$ accounts for almost the entire equity gain (`H_gated` `86.31 -> 89.32`, `p_holm = 1.95e-7`; `H_bal,0.6` `75.35 -> 78.06`, `p_holm = 1.46e-3`). Although Stage 4 received longer wall-clock runtime (`16.31 s` vs. `10.56 s`), it is statistically equivalent to `MN-LAHC (Obj_S4)` within `+/-1.5` points across all three indices (`H_gated` `+0.58`, `p_TOST = 0.0041`, `p_holm = 0.438`; `H_bal,0.3` `p_TOST = 0.0001`; `H_bal,0.6` `p_TOST = 0.0390`). Ablating `disableHalfDayRepack` (`90.20` vs. `90.31`) or `disableOscillation` (`90.40` vs. `90.31`) yields no measurable drop (`p_holm = 1.00`). Thus, Stages 3-4 are not shown necessary and `MN-LAHC (Obj_S4)` is the recommended lean core.

---

## Algorithm 5: Depth-2 Ejection-Chain Minimal-Perturbation Repair (`planMinimalRepair`)

**Input:** Current feasible schedule $A$, target move $(x^* \to s^*)$, pinned set $\Pi$  
**Output:** Strictly audited feasible schedule $A'$ minimizing $\Delta(A, A')$, or `FAILED` with explicit diagnostic (triggers warm-start fallback in production)

1. Check policy validity of $(x^*, s^*)$ (time grid, room compatibility, Pasca Mon-Wed, ISHOMA, and `hardFridayPrayer` when enabled). If invalid, return `FAILED`.
2. Collect direct blockers $B = \{b \in A \setminus \{x^*\} : \text{conflicts}(x^*@s^*, b) \text{ or induces wet-lab Asprak deadlock}\}$.
3. If $B \cap \Pi \neq \emptyset$, return `FAILED` ("conflicts with pinned doctoral slot").
4. If $B = \emptyset$, construct candidate $A'$ (`DIRECT_SAFE`, $\Delta = 0$) and verify `auditSchedule(A').hardFeasible === true` before returning.
5. Initialize lock set $L \leftarrow \{x^*\} \cup \Pi$, remove $B$ into repair pool.
6. For each $b \in B$:
   - **Depth-1 ejection (`LOCAL_1_STEP`):** Search minimum-soft-cost conflict-free slot $s_{\text{free}}$ for $b$. If found, place $b \to s_{\text{free}}$ and add $b$ to $L$.
   - **Depth-2 ejection chain (`EJECTION_2_STEP`):** Otherwise scan all policy-valid slots $(d, t, r)$ for $b$ blocked by exactly one unpinned session $c \notin L$; temporarily displace $c$, place $b$, and search a conflict-free slot $s_c$ for $c$. If found, commit $(b, c)$ and add both to $L$.
   - If neither depth-1 nor depth-2 succeeds, return `FAILED` (in production, fall back to bounded Warm-Start Repair).
7. **Mandatory Post-Repair Hard Gate:** Run `auditSchedule(A', policy)` on the complete resulting timetable; return `feasible: true` if and only if `hardFeasible === true` (zero clashes, zero Pasca violations, zero Asprak deadlocks, zero hard Friday overlaps).
8. **Audited Performance ($N = 300$ edits = `120` safe + `180` conflict-only):** On the `180` non-trivial conflict edits, depth-2 ejection resolves `168/180` (`93.33%`, 95% Wilson CI `[88.71%, 96.15%]`) in `10.67 ms` (`p95 = 18.88 ms`) with `1.63 +/- 0.66` moves vs. `173/180` (`96.11%`, CI `[92.19%, 98.10%]`) in `158.9 ms` with `15.54 +/- 5.43` moves for Warm-Start Repair ($n = 164$ paired mutually feasible conflicts, `p_holm = 2.98e-76`, `g = -2.66`; combined fallback: **`177/180 = 98.33%`**) and `242.45 +/- 5.74` moves (`1,231 ms`) for Static Full Re-solve ($n = 60$).
