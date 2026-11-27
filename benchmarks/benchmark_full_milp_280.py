"""
Full 280-Session Institutional UCTP Exact MILP Baseline via HiGHS (scipy.optimize.milp).

Formulates ALL hard institutional constraints C_H on the full 280-session FST dataset
(Mode B + Hard Friday Prayer 11:30-13:00):
  1. Single assignment per session across exact solver-matched (day, start, room) domains
  2. Zero room overlap across every active 5-minute quantum
  3. Zero lecturer overlap across every active 5-minute quantum
  4. Zero expanded class-cohort K(x_i) overlap across every active 5-minute quantum
  5. Borrowed Postgraduate rooms strictly Monday-Wednesday
  6. Zero ISHOMA (12:00-13:00) and zero Hard Friday Prayer (11:30-13:00) overlaps
  7. Exact disjunctive senior-cohort Asprak coverage for all 32 wet-lab practicals:
     sum_{c in S(w)} y_{w,c} >= 1, with y_{w,c} = 0 whenever any session of senior c
     overlaps wet lab w at the chosen slot.

Linear ergonomic objective (MILP-tractable subset of F_soft):
  Minimize early starts (<08:40: 980 at 07:00, 180 at 07:50), late finishes (>16:20: 14),
  plus active class-day counts (350/day) and active lecturer-day counts (150/day).
  (Non-linear hole-day spans, dead-gap subtraction, and isolated-day counts are evaluated
   post-hoc via the exact production `CSPEngine.auditSchedule` auditor!)

Benchmarked at two wall-clock limits:
  - 10.5 s (equal wall-clock budget to client-side Stage-4 Equity / MN-LAHC)
  - 60.0 s (6x longer offline desktop MILP budget)

Saves results to `experiment_v2/results/milp_full_280_results.json`.
"""
from __future__ import annotations

import json
import re
import subprocess
import time
from collections import defaultdict
from pathlib import Path

import numpy as np
from scipy.optimize import Bounds, LinearConstraint, milp
from scipy.sparse import csc_matrix

BASE = Path(__file__).resolve().parent.parent
DATA_PATH = BASE / "data" / "fst-20261-anonymized.json"
OUT_PATH = BASE / "results" / "milp_full_280_results.json"

DAYS = ["Senin", "Selasa", "Rabu", "Kamis", "Jumat"]
PASCA_DAYS = {0, 1, 2}
SD_IF_DRY_LABS = {"LAB. DATA ENGINEER", "LAB. DATA SCIENCE"}


def expand_effective_classes(classes: list[str]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for raw in classes:
        c = raw.strip()
        if not c:
            continue
        if c not in seen:
            seen.add(c)
            out.append(c)
        if re.match(r"^Praktikum\s+", c, re.I):
            parent = re.sub(r"^Praktikum\s+", "", c, flags=re.I).strip()
            if parent and parent not in seen:
                seen.add(parent)
                out.append(parent)
    return out


def get_allowed_rooms(s: dict, rooms: list[dict]) -> list[str]:
    if s["roomType"] in ("WET_LAB", "DRY_LAB"):
        return [s.get("originalRoom") or s["room"]]
    base = [r["name"] for r in rooms if r["type"] in ("PASCA", "SAINTEK")]
    if s.get("prodi") in ("IF", "SD"):
        dry = [r["name"] for r in rooms if r["type"] == "DRY_LAB" and r["name"].upper() in SD_IF_DRY_LABS]
        return base + dry
    return base


def get_candidate_starts(dur: int) -> list[int]:
    if dur > 300:
        cands = [780, 420]
    elif dur == 170:
        cands = [520, 550, 780, 880, 910, 470, 420]
    elif dur == 150:
        cands = [780, 930, 520, 570, 470, 420]
    elif dur == 100:
        cands = [520, 620, 780, 880, 980, 470, 570, 420]
    else:
        cands = [520, 570, 620, 670, 780, 830, 880, 930, 980, 470, 420]
    max_end = 1140 if dur > 300 else 1080
    valid = []
    for st in cands:
        en = st + dur
        if st < 420 or en > max_end:
            continue
        if dur <= 300 and st < 780 and en > 720:
            continue
        valid.append(st)
    return valid


def is_pasca_room(name: str) -> bool:
    return bool(re.match(r"^Pasca", name or "", re.I))


def audit_via_node(assigned_sessions: list[dict]) -> dict:
    script = r"""
const fs = require('fs');
const C = require('./solver/dist/csp-engine.js');
const sessions = JSON.parse(fs.readFileSync(0, 'utf8'));
const pol = { ...C.DEFAULT_POLICY, allowDryLabOverflow: true, protectFridayPrayer: true, hardFridayPrayer: true };
const a = C.auditSchedule(sessions, pol);
console.log(JSON.stringify({
  hardFeasible: a.hardFeasible,
  hardConflictCount: a.hardConflictCount,
  pascaViolationCount: a.pascaViolationCount,
  asprakDeadlockCount: a.asprakDeadlockCount,
  asprakPartialCount: a.asprakPartialCount,
  fridayPrayerViolationCount: a.fridayPrayerViolationCount,
  ishomaViolationCount: a.ishomaViolationCount,
  earlyBefore0840Count: a.earlyBefore0840Count,
  contiguousClassCount: a.contiguousClassCount,
  totalHoleDays: a.totalHoleDays,
  classesWithin3Days: a.classesWithin3Days,
  isolatedDayCount: a.isolatedDayCount,
  lecturerIsolatedDayCount: a.lecturerIsolatedDayCount,
  totalLongGaps: a.classLongGaps + a.lecturerLongGaps,
  lateSessionCount: a.lateSessionCount,
  rawHumaneScore: a.rawHumaneScore,
  gatedHumaneScore: a.gatedHumaneScore,
  balancedScore03: a.balancedScore03,
  balancedScore06: a.balancedScore06,
}));
"""
    proc = subprocess.run(
        ["node", "-e", script],
        input=json.dumps(assigned_sessions),
        text=True,
        capture_output=True,
        cwd=str(BASE),
        check=True,
    )
    return json.loads(proc.stdout.strip())


def build_and_solve(sessions: list[dict], rooms: list[dict], time_limits: list[float]) -> dict:
    t_build0 = time.perf_counter()
    n = len(sessions)
    eff_classes = [expand_effective_classes(s["classes"]) for s in sessions]

    # Build senior cohort map for all 32 wet labs (exact match to humane-evaluator.ts)
    cohort_map: dict[str, set[str]] = defaultdict(set)
    for cls_list in eff_classes:
        for c in cls_list:
            if re.match(r"^Praktikum\s+", c, re.I):
                continue
            m = re.match(r"^(.+?)\s+(\d)[A-Z]$", c)
            if m:
                cohort_map[f"{m.group(1).strip()}|{m.group(2)}"].add(c)

    senior_map: dict[int, list[str]] = {}
    for i, s in enumerate(sessions):
        if not s.get("isWetLab"):
            continue
        seniors: set[str] = set()
        for c in s["classes"]:
            clean = re.sub(r"^Praktikum\s+", "", c, flags=re.I).strip()
            m = re.match(r"^(.+?)\s+(\d)[A-Z]$", clean)
            if m:
                up = cohort_map.get(f"{m.group(1).strip()}|{int(m.group(2)) + 2}", set())
                seniors.update(up)
        if seniors:
            senior_map[i] = sorted(seniors)

    # 1. Enumerate assignment variables x_{i, d, st, r}
    # To keep the MILP tractable for HiGHS while preserving exact hard-constraint semantics,
    # use the compact canonical primary+07:50 start grid (identical to solver!)
    var_meta: list[tuple[int, int, int, str]] = []
    sess_vars: list[list[int]] = [[] for _ in range(n)]

    # Resource occupancy maps: (res_key, day, quantum_10m) -> list of var indices
    # Note: all start times & durations are multiples of 10 minutes (420..1140, dur in {50,100,150,170,340})!
    room_occ: dict[tuple[str, int, int], list[int]] = defaultdict(list)
    lec_occ: dict[tuple[str, int, int], list[int]] = defaultdict(list)
    cls_occ: dict[tuple[str, int, int], list[int]] = defaultdict(list)
    cls_day_vars: dict[tuple[str, int], list[int]] = defaultdict(list)
    lec_day_vars: dict[tuple[str, int], list[int]] = defaultdict(list)

    all_classes: set[str] = set()
    all_lecturers: set[str] = set()

    for i, s in enumerate(sessions):
        dur = int(s["duration"])
        allowed_r = get_allowed_rooms(s, rooms)
        starts = get_candidate_starts(dur)
        lec = (s.get("dosen") or "").strip()
        if lec:
            all_lecturers.add(lec)
        for c in eff_classes[i]:
            all_classes.add(c)

        for d in range(5):
            for st in starts:
                en = st + dur
                # Hard Friday Prayer exclusion 11:30-13:00 ([690, 780))
                if d == 4 and st < 780 and en > 690:
                    continue
                q_lo = st // 10
                q_hi = en // 10
                for r in allowed_r:
                    if is_pasca_room(r) and d not in PASCA_DAYS:
                        continue
                    vid = len(var_meta)
                    var_meta.append((i, d, st, r))
                    sess_vars[i].append(vid)
                    for q in range(q_lo, q_hi):
                        room_occ[(r, d, q)].append(vid)
                        if lec:
                            lec_occ[(lec, d, q)].append(vid)
                        for c in eff_classes[i]:
                            cls_occ[(c, d, q)].append(vid)
                    for c in eff_classes[i]:
                        cls_day_vars[(c, d)].append(vid)
                    if lec:
                        lec_day_vars[(lec, d)].append(vid)

    n_assign = len(var_meta)

    # 2. Auxiliary binary variables:
    #   - z_cls_{c,d} in {0,1}: class c active on day d
    #   - z_lec_{l,d} in {0,1}: lecturer l active on day d
    #   - y_asp_{w,c} in {0,1}: senior cohort c is 100% free during wet lab w
    z_cls_idx: dict[tuple[str, int], int] = {}
    z_lec_idx: dict[tuple[str, int], int] = {}
    y_asp_idx: dict[tuple[int, str], int] = {}

    next_var = n_assign
    for c in sorted(all_classes):
        for d in range(5):
            if cls_day_vars[(c, d)]:
                z_cls_idx[(c, d)] = next_var
                next_var += 1
    for lec in sorted(all_lecturers):
        for d in range(5):
            if lec_day_vars[(lec, d)]:
                z_lec_idx[(lec, d)] = next_var
                next_var += 1
    for w, s_list in sorted(senior_map.items()):
        for c in s_list:
            y_asp_idx[(w, c)] = next_var
            next_var += 1

    total_vars = next_var

    # 3. Objective vector c (minimize linear ergonomic surrogate)
    c_obj = np.zeros(total_vars, dtype=float)
    for vid, (i, d, st, r) in enumerate(var_meta):
        en = st + int(sessions[i]["duration"])
        cost = 0.0
        if st < 470:
            cost += 980.0
        elif st < 520:
            cost += 180.0
        if en > 980:
            cost += 14.0 if en <= 1080 else 32.0
        c_obj[vid] = cost
    for vid in z_cls_idx.values():
        c_obj[vid] = 350.0
    for vid in z_lec_idx.values():
        c_obj[vid] = 150.0

    # 4. Build sparse linear constraints (COO -> CSC)
    rows: list[int] = []
    cols: list[int] = []
    vals: list[float] = []
    lbs: list[float] = []
    ubs: list[float] = []
    row_id = 0

    def add_row(col_list: list[int], val_list: list[float], lb: float, ub: float):
        nonlocal row_id
        rows.extend([row_id] * len(col_list))
        cols.extend(col_list)
        vals.extend(val_list)
        lbs.append(lb)
        ubs.append(ub)
        row_id += 1

    # (a) Each session assigned to exactly 1 slot
    for i in range(n):
        add_row(sess_vars[i], [1.0] * len(sess_vars[i]), 1.0, 1.0)

    # (b) Room, Lecturer, Expanded Class non-overlap at every 10-min quantum
    for occ_map in (room_occ, lec_occ, cls_occ):
        for vlist in occ_map.values():
            if len(vlist) > 1:
                add_row(vlist, [1.0] * len(vlist), -np.inf, 1.0)

    # (c) Active day linking: sum_{x in (c,d)} x <= M * z_{c,d}
    for (c, d), vlist in cls_day_vars.items():
        if not vlist:
            continue
        zv = z_cls_idx[(c, d)]
        M = float(min(len(vlist), 8))
        add_row(vlist + [zv], [1.0] * len(vlist) + [-M], -np.inf, 0.0)
    for (lec, d), vlist in lec_day_vars.items():
        if not vlist:
            continue
        zv = z_lec_idx[(lec, d)]
        M = float(min(len(vlist), 8))
        add_row(vlist + [zv], [1.0] * len(vlist) + [-M], -np.inf, 0.0)

    # (d) Exact Disjunctive Wet-Lab Asprak Coverage:
    # For each wet lab w:
    #   (i) sum_{c in S(w)} y_{w,c} >= 1
    #   (ii) For every valid (d, q) covered by w's variables and every c in S(w):
    #        (sum_{v in w covering (d,q)} x_v) + (sum_{u in senior c covering (d,q)} x_u) + y_{w,c} <= 2
    #        Proof: if w occupies (d,q) [=1] AND senior c occupies (d,q) [=1], then y_{w,c} MUST be 0!
    for w, s_list in sorted(senior_map.items()):
        add_row([y_asp_idx[(w, c)] for c in s_list], [1.0] * len(s_list), 1.0, np.inf)
        # Group w's variables by (day, quantum)
        w_dq: dict[tuple[int, int], list[int]] = defaultdict(list)
        dur_w = int(sessions[w]["duration"])
        for vid in sess_vars[w]:
            _, d, st, _ = var_meta[vid]
            for q in range(st // 10, (st + dur_w) // 10):
                w_dq[(d, q)].append(vid)
        for c in s_list:
            yv = y_asp_idx[(w, c)]
            for (d, q), w_vids in w_dq.items():
                sen_vids = cls_occ.get((c, d, q), [])
                if sen_vids:
                    # Exclude self if ever shared (disjoint by semester s vs s+2)
                    c_cols = w_vids + sen_vids + [yv]
                    c_vals = [1.0] * len(w_vids) + [1.0] * len(sen_vids) + [1.0]
                    add_row(c_cols, c_vals, -np.inf, 2.0)

    A = csc_matrix((vals, (rows, cols)), shape=(row_id, total_vars))
    integrality = np.ones(total_vars, dtype=int)
    bounds = Bounds(np.zeros(total_vars), np.ones(total_vars))
    constraint = LinearConstraint(A, np.asarray(lbs), np.asarray(ubs))
    build_ms = round((time.perf_counter() - t_build0) * 1000, 2)

    print(
        f"[FullMILP-280] Built sparse model in {build_ms} ms: "
        f"vars={total_vars} (assign={n_assign}, aux={total_vars - n_assign}), "
        f"constraints={row_id}, nnz={A.nnz}"
    )

    runs = []
    for tl in time_limits:
        t0 = time.perf_counter()
        res = milp(
            c=c_obj,
            integrality=integrality,
            bounds=bounds,
            constraints=constraint,
            options={"time_limit": float(tl), "disp": False, "mip_rel_gap": 0.001},
        )
        solve_ms = round((time.perf_counter() - t0) * 1000, 2)
        entry = {
            "timeLimitSec": tl,
            "solveMs": solve_ms,
            "status": int(res.status),
            "message": str(res.message),
            "incumbentFound": res.x is not None,
            "objectiveValue": round(float(res.fun), 2) if res.fun is not None else None,
            "audit": None,
        }
        if res.x is not None:
            sol_sessions = json.loads(json.dumps(sessions))
            placed = 0
            for vid in range(n_assign):
                if res.x[vid] > 0.5:
                    i, d, st, r = var_meta[vid]
                    sol_sessions[i]["day"] = DAYS[d]
                    sol_sessions[i]["start"] = st
                    sol_sessions[i]["end"] = st + int(sol_sessions[i]["duration"])
                    sol_sessions[i]["room"] = r
                    placed += 1
            entry["placedSessions"] = placed
            entry["audit"] = audit_via_node(sol_sessions)
        print(
            f"[FullMILP-280] limit={tl}s | solve={solve_ms}ms | status={res.status} ({res.message}) | "
            f"incumbent={entry['incumbentFound']} | audit={entry['audit']}"
        )
        runs.append(entry)

    return {
        "solver": "HiGHS (scipy.optimize.milp)",
        "policy": "Mode B + Hard Friday Prayer (11:30-13:00) + Exact 32 Wet-Lab Disjunctive Asprak",
        "modelStats": {
            "sessions": n,
            "totalBinaryVars": total_vars,
            "assignmentVars": n_assign,
            "auxDayAndAsprakVars": total_vars - n_assign,
            "linearConstraints": row_id,
            "nonZeros": int(A.nnz),
            "modelBuildMs": build_ms,
        },
        "runs": runs,
    }


def main() -> None:
    ds = json.loads(DATA_PATH.read_text(encoding="utf-8"))
    out = build_and_solve(ds["sessions"], ds["rooms"], time_limits=[10.5, 60.0])
    OUT_PATH.write_text(json.dumps(out, indent=2), encoding="utf-8")
    print(f"[FullMILP-280] Saved {OUT_PATH}")


if __name__ == "__main__":
    main()
