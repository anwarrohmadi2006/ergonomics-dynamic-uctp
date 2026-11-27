"""
Fair Full-Instance 280-Session Exact HiGHS MILP Baseline (A2)
Cold-Start + True DSATUR & MN-LAHC Warm-Starts via highspy (60 s / 300 s / 600 s),
reporting Primal Objective, Dual Bound, MIP Optimality Gap %, Node Count, and
exact CSPEngine.auditSchedule evaluation.

Usage (from repository root):
  python -B benchmarks/benchmark_fair_milp_a2.py --mode cold600
  python -B benchmarks/benchmark_fair_milp_a2.py --mode warm_dsatur600
  python -B benchmarks/benchmark_fair_milp_a2.py --mode warm_mnlahc300
  python -B benchmarks/benchmark_fair_milp_a2.py --mode merge
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import time
from collections import defaultdict
from pathlib import Path

import highspy
import numpy as np
from scipy.sparse import csc_matrix

BASE = Path(__file__).resolve().parent.parent
DATA_PATH = BASE / "data" / "fst-20261-anonymized.json"
RES_DIR = BASE / "results"
OUT_MERGED = RES_DIR / "milp_fair_a2_results.json"

ENGINE_CANDIDATES = [
    BASE / "solver" / "dist" / "csp-engine.js",
    BASE.parent / "app" / "js" / "csp-engine.js",
]
ENGINE_PATH = next((p for p in ENGINE_CANDIDATES if p.exists()), ENGINE_CANDIDATES[0])

DAYS = ["Senin", "Selasa", "Rabu", "Kamis", "Jumat"]
DAY_TO_IDX = {d: i for i, d in enumerate(DAYS)}
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
            base = re.sub(r"^Praktikum\s+", "", c, flags=re.I).strip()
            if base and base not in seen:
                seen.add(base)
                out.append(base)
            m = re.match(r"^(.+?\s+\d)[A-Z]\d+$", base)
            if m:
                parent_prefix = m.group(1)
                for suf in ["A", "B", "C"]:
                    if base.startswith(parent_prefix + suf) and (parent_prefix + suf) not in seen:
                        seen.add(parent_prefix + suf)
                        out.append(parent_prefix + suf)
        else:
            m = re.match(r"^(.+?\s+\d[A-Z])\d+$", c)
            if m and m.group(1) not in seen:
                seen.add(m.group(1))
                out.append(m.group(1))
    return out


def get_allowed_rooms(session: dict, rooms: list[dict]) -> list[str]:
    if session["roomType"] in ("WET_LAB", "DRY_LAB"):
        return [session.get("originalRoom") or session["room"]]
    base = [r["name"] for r in rooms if r["type"] in ("PASCA", "SAINTEK")]
    if session.get("prodi") in ("IF", "SD"):
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


def generate_seed_schedule_via_node(mode: str, seed: int = 42) -> tuple[list[dict], float, dict]:
    script = f"""
const fs = require('fs');
const C = require({json.dumps(str(ENGINE_PATH))});
const ds = JSON.parse(fs.readFileSync({json.dumps(str(DATA_PATH))}, 'utf8'));
const pol = {{ ...C.DEFAULT_POLICY, allowDryLabOverflow: true, protectFridayPrayer: true, hardFridayPrayer: true }};
let res;
if ({json.dumps(mode)} === 'dsatur') {{
  res = C.constructiveReset(ds.sessions, ds.rooms, pol, {{ seed: {seed}, skipStage2: true }});
}} else {{
  res = C.constructiveReset(ds.sessions, ds.rooms, pol, {{ seed: {seed}, maxIters: 5000000, timeBudgetMs: 10200, lecturerIsolatedWeight: 300 }});
}}
console.log(JSON.stringify({{ latencyMs: res.latencyMs, audit: res.audit, sessions: res.sessions }}));
"""
    proc = subprocess.run(["node", "-e", script], text=True, capture_output=True, cwd=str(BASE), check=True)
    obj = json.loads(proc.stdout.strip())
    return obj["sessions"], float(obj["latencyMs"]), obj["audit"]


def audit_via_node(assigned_sessions: list[dict]) -> dict:
    script = f"""
const fs = require('fs');
const C = require({json.dumps(str(ENGINE_PATH))});
const sessions = JSON.parse(fs.readFileSync(0, 'utf8'));
const pol = {{ ...C.DEFAULT_POLICY, allowDryLabOverflow: true, protectFridayPrayer: true, hardFridayPrayer: true }};
const a = C.auditSchedule(sessions, pol);
console.log(JSON.stringify({{
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
}}));
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


def build_milp_structures(sessions: list[dict], rooms: list[dict], extra_slots: list[dict] | None = None):
    t_build0 = time.perf_counter()
    n = len(sessions)
    eff_classes = [expand_effective_classes(s["classes"]) for s in sessions]

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

    var_meta: list[tuple[int, int, int, str]] = []
    var_lookup: dict[tuple[int, int, int, str], int] = {}
    sess_vars: list[list[int]] = [[] for _ in range(n)]

    room_occ: dict[tuple[str, int, int], list[int]] = defaultdict(list)
    lec_occ: dict[tuple[str, int, int], list[int]] = defaultdict(list)
    cls_occ: dict[tuple[str, int, int], list[int]] = defaultdict(list)
    cls_day_vars: dict[tuple[str, int], list[int]] = defaultdict(list)
    lec_day_vars: dict[tuple[str, int], list[int]] = defaultdict(list)

    all_classes: set[str] = set()
    all_lecturers: set[str] = set()

    extra_by_idx: dict[int, set[tuple[int, int, str]]] = defaultdict(set)
    if extra_slots:
        for idx_s, s_ex in enumerate(extra_slots):
            extra_by_idx[idx_s].add((DAY_TO_IDX[s_ex["day"]], int(s_ex["start"]), s_ex["room"]))

    for i, s in enumerate(sessions):
        dur = int(s["duration"])
        allowed = get_allowed_rooms(s, rooms)
        starts = list(get_candidate_starts(dur))
        for (ed, est, er) in extra_by_idx.get(i, set()):
            if est not in starts:
                starts.append(est)
            if er not in allowed:
                allowed.append(er)
        starts = sorted(set(starts))

        lec = (s.get("dosen") or "").strip()
        if lec:
            all_lecturers.add(lec)
        for c in eff_classes[i]:
            all_classes.add(c)

        for d in range(5):
            for r in allowed:
                if is_pasca_room(r) and d not in PASCA_DAYS:
                    continue
                for st in starts:
                    en = st + dur
                    if en > 1140:
                        continue
                    if dur <= 300 and st < 780 and en > 720:
                        continue
                    if d == 4 and st < 780 and en > 690:
                        continue
                    vid = len(var_meta)
                    var_meta.append((i, d, st, r))
                    var_lookup[(i, d, st, r)] = vid
                    sess_vars[i].append(vid)

                    for q in range(st // 10, en // 10):
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

    cls_day_idx: dict[tuple[str, int], int] = {}
    lec_day_idx: dict[tuple[str, int], int] = {}
    y_asp_idx: dict[tuple[int, str], int] = {}

    cur_v = n_assign
    for c in sorted(all_classes):
        for d in range(5):
            if cls_day_vars[(c, d)]:
                cls_day_idx[(c, d)] = cur_v
                cur_v += 1
    for lec in sorted(all_lecturers):
        for d in range(5):
            if lec_day_vars[(lec, d)]:
                lec_day_idx[(lec, d)] = cur_v
                cur_v += 1
    for w, s_list in sorted(senior_map.items()):
        for c in s_list:
            y_asp_idx[(w, c)] = cur_v
            cur_v += 1

    total_vars = cur_v
    c_obj = np.zeros(total_vars, dtype=float)
    for vid, (i, d, st, r) in enumerate(var_meta):
        en = st + int(sessions[i]["duration"])
        cost = 0.0
        if st < 470:
            cost += 980.0
        elif st < 520:
            cost += 180.0
        if en > 980:
            cost += 14.0
        c_obj[vid] = cost
    for v in cls_day_idx.values():
        c_obj[v] = 350.0
    for v in lec_day_idx.values():
        c_obj[v] = 150.0

    rows: list[int] = []
    cols: list[int] = []
    vals: list[float] = []
    lbs: list[float] = []
    ubs: list[float] = []
    row_id = 0

    def add_row(c_list: list[int], v_list: list[float], lb: float, ub: float) -> None:
        nonlocal row_id
        rows.extend([row_id] * len(c_list))
        cols.extend(c_list)
        vals.extend(v_list)
        lbs.append(lb)
        ubs.append(ub)
        row_id += 1

    for i in range(n):
        add_row(sess_vars[i], [1.0] * len(sess_vars[i]), 1.0, 1.0)
    for vids in room_occ.values():
        if len(vids) > 1:
            add_row(vids, [1.0] * len(vids), -np.inf, 1.0)
    for vids in lec_occ.values():
        if len(vids) > 1:
            add_row(vids, [1.0] * len(vids), -np.inf, 1.0)
    for vids in cls_occ.values():
        if len(vids) > 1:
            add_row(vids, [1.0] * len(vids), -np.inf, 1.0)
    for (c, d), av in cls_day_idx.items():
        vids = cls_day_vars[(c, d)]
        add_row(vids + [av], [1.0] * len(vids) + [-10.0], -np.inf, 0.0)
    for (lec, d), av in lec_day_idx.items():
        vids = lec_day_vars[(lec, d)]
        add_row(vids + [av], [1.0] * len(vids) + [-10.0], -np.inf, 0.0)
    for w, s_list in sorted(senior_map.items()):
        add_row([y_asp_idx[(w, c)] for c in s_list], [1.0] * len(s_list), 1.0, np.inf)
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
                    add_row(w_vids + sen_vids + [yv], [1.0] * len(w_vids) + [1.0] * len(sen_vids) + [1.0], -np.inf, 2.0)

    A = csc_matrix((vals, (rows, cols)), shape=(row_id, total_vars))
    build_ms = round((time.perf_counter() - t_build0) * 1000, 2)
    return {
        "A": A, "c_obj": c_obj, "lbs": np.asarray(lbs), "ubs": np.asarray(ubs),
        "total_vars": total_vars, "n_assign": n_assign, "row_id": row_id,
        "var_meta": var_meta, "var_lookup": var_lookup,
        "cls_day_idx": cls_day_idx, "lec_day_idx": lec_day_idx,
        "y_asp_idx": y_asp_idx, "senior_map": senior_map,
        "eff_classes": eff_classes, "build_ms": build_ms,
    }


def make_warm_start_vector(model: dict, warm_sessions: list[dict]) -> tuple[np.ndarray, float]:
    x0 = np.zeros(model["total_vars"], dtype=float)
    var_lookup = model["var_lookup"]
    eff_classes = model["eff_classes"]
    cls_days_used: set[tuple[str, int]] = set()
    lec_days_used: set[tuple[str, int]] = set()
    cls_busy: dict[tuple[str, int], set[int]] = defaultdict(set)

    for i, s in enumerate(warm_sessions):
        d = DAY_TO_IDX[s["day"]]
        st = int(s["start"])
        en = st + int(s["duration"])
        r = s["room"]
        vid = var_lookup[(i, d, st, r)]
        x0[vid] = 1.0
        for c in eff_classes[i]:
            cls_days_used.add((c, d))
            for q in range(st // 10, en // 10):
                cls_busy[(c, d)].add(q)
        lec = (s.get("dosen") or "").strip()
        if lec:
            lec_days_used.add((lec, d))

    for key, idx in model["cls_day_idx"].items():
        if key in cls_days_used:
            x0[idx] = 1.0
    for key, idx in model["lec_day_idx"].items():
        if key in lec_days_used:
            x0[idx] = 1.0
    for w, s_list in model["senior_map"].items():
        ws = warm_sessions[w]
        d = DAY_TO_IDX[ws["day"]]
        qs = set(range(int(ws["start"]) // 10, (int(ws["start"]) + int(ws["duration"])) // 10))
        for c in s_list:
            if not (qs & cls_busy.get((c, d), set())):
                x0[model["y_asp_idx"][(w, c)]] = 1.0

    init_obj = float(np.dot(model["c_obj"], x0))
    return x0, round(init_obj, 2)


def solve_highs(model: dict, base_sessions: list[dict], time_limit_s: float, x_warm: np.ndarray | None = None, threads: int = 1) -> dict:
    h = highspy.Highs()
    h.setOptionValue("output_flag", False)
    h.setOptionValue("time_limit", float(time_limit_s))
    h.setOptionValue("threads", int(threads))
    h.setOptionValue("mip_rel_gap", 0.001)

    A = model["A"]
    lp = highspy.HighsLp()
    lp.num_col_ = model["total_vars"]
    lp.num_row_ = model["row_id"]
    lp.col_cost_ = model["c_obj"]
    lp.col_lower_ = np.zeros(model["total_vars"])
    lp.col_upper_ = np.ones(model["total_vars"])
    lp.row_lower_ = model["lbs"]
    lp.row_upper_ = model["ubs"]
    lp.integrality_ = [highspy.HighsVarType.kInteger] * model["total_vars"]
    lp.a_matrix_.format_ = highspy.MatrixFormat.kColwise
    lp.a_matrix_.start_ = A.indptr.tolist()
    lp.a_matrix_.index_ = A.indices.tolist()
    lp.a_matrix_.value_ = A.data.tolist()
    h.passModel(lp)

    warm_status = None
    if x_warm is not None:
        sol = highspy.HighsSolution()
        sol.col_value = x_warm.tolist()
        warm_status = str(h.setSolution(sol))

    t0 = time.perf_counter()
    h.run()
    solve_ms = round((time.perf_counter() - t0) * 1000, 2)
    info = h.getInfo()
    mstatus = str(h.getModelStatus())
    sol_out = h.getSolution()
    has_incumbent = bool(info.primal_solution_status == int(highspy.SolutionStatus.kSolutionStatusFeasible))

    primal_obj = round(float(info.objective_function_value), 2) if has_incumbent else None
    dual_bound = round(float(info.mip_dual_bound), 2) if np.isfinite(info.mip_dual_bound) else None
    mip_gap_pct = round(float(info.mip_gap) * 100, 2) if (has_incumbent and np.isfinite(info.mip_gap)) else None

    audit = None
    placed = 0
    if has_incumbent and len(sol_out.col_value) >= model["n_assign"]:
        sol_sessions = json.loads(json.dumps(base_sessions))
        for vid in range(model["n_assign"]):
            if sol_out.col_value[vid] > 0.5:
                i, d, st, r = model["var_meta"][vid]
                sol_sessions[i]["day"] = DAYS[d]
                sol_sessions[i]["start"] = st
                sol_sessions[i]["end"] = st + int(sol_sessions[i]["duration"])
                sol_sessions[i]["room"] = r
                placed += 1
        if placed == len(base_sessions):
            audit = audit_via_node(sol_sessions)

    return {
        "timeLimitSec": time_limit_s,
        "solveMs": solve_ms,
        "modelStatus": mstatus,
        "warmStartStatus": warm_status,
        "incumbentFound": has_incumbent,
        "placedSessions": placed,
        "primalObjective": primal_obj,
        "dualBound": dual_bound,
        "mipGapPct": mip_gap_pct,
        "mipNodeCount": int(info.mip_node_count),
        "audit": audit,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["cold600", "warm_dsatur600", "warm_mnlahc300", "merge"], required=True)
    args = parser.parse_args()

    if args.mode == "merge":
        parts = {}
        for m in ["cold600", "warm_dsatur600", "warm_mnlahc300"]:
            p = RES_DIR / f"_tmp_milp_{m}.json"
            if p.exists():
                parts[m] = json.loads(p.read_text(encoding="utf-8"))
        OUT_MERGED.write_text(json.dumps(parts, indent=2), encoding="utf-8")
        print(f"[A2-MILP] Merged -> {OUT_MERGED}")
        return

    ds = json.loads(DATA_PATH.read_text(encoding="utf-8"))
    sessions, rooms = ds["sessions"], ds["rooms"]

    if args.mode == "cold600":
        model = build_milp_structures(sessions, rooms)
        print(f"[A2-cold600] Built model: vars={model['total_vars']}, rows={model['row_id']}, nnz={model['A'].nnz}, build={model['build_ms']}ms")
        r60 = solve_highs(model, sessions, 60.0, None, threads=1)
        r600 = solve_highs(model, sessions, 600.0, None, threads=1)
        out = {
            "mode": "cold_start",
            "modelStats": {"vars": model["total_vars"], "rows": model["row_id"], "nnz": int(model["A"].nnz), "buildMs": model["build_ms"]},
            "runs": [r60, r600],
        }
    elif args.mode == "warm_dsatur600":
        ws_sess, ws_ms, ws_audit = generate_seed_schedule_via_node("dsatur", 42)
        model = build_milp_structures(sessions, rooms, extra_slots=ws_sess)
        x0, init_obj = make_warm_start_vector(model, ws_sess)
        r10 = solve_highs(model, sessions, 10.5, x0, threads=1)
        r60 = solve_highs(model, sessions, 60.0, x0, threads=1)
        r600 = solve_highs(model, sessions, 600.0, x0, threads=1)
        out = {
            "mode": "warm_start_dsatur",
            "seed": 42,
            "warmStartGenMs": round(ws_ms, 2),
            "warmStartInitialMilpObj": init_obj,
            "warmStartInitialAudit": {
                "gatedHumaneScore": ws_audit["gatedHumaneScore"],
                "balancedScore03": ws_audit["balancedScore03"],
                "balancedScore06": ws_audit["balancedScore06"],
                "lecturerIsolatedDayCount": ws_audit["lecturerIsolatedDayCount"],
            },
            "modelStats": {"vars": model["total_vars"], "rows": model["row_id"], "nnz": int(model["A"].nnz), "buildMs": model["build_ms"]},
            "runs": [r10, r60, r600],
        }
    else:
        ws_sess, ws_ms, ws_audit = generate_seed_schedule_via_node("mnlahc", 42)
        model = build_milp_structures(sessions, rooms, extra_slots=ws_sess)
        x0, init_obj = make_warm_start_vector(model, ws_sess)
        r60 = solve_highs(model, sessions, 60.0, x0, threads=1)
        r300 = solve_highs(model, sessions, 300.0, x0, threads=1)
        out = {
            "mode": "warm_start_mnlahc_eq",
            "seed": 42,
            "warmStartGenMs": round(ws_ms, 2),
            "warmStartInitialMilpObj": init_obj,
            "warmStartInitialAudit": {
                "gatedHumaneScore": ws_audit["gatedHumaneScore"],
                "balancedScore03": ws_audit["balancedScore03"],
                "balancedScore06": ws_audit["balancedScore06"],
                "lecturerIsolatedDayCount": ws_audit["lecturerIsolatedDayCount"],
            },
            "modelStats": {"vars": model["total_vars"], "rows": model["row_id"], "nnz": int(model["A"].nnz), "buildMs": model["build_ms"]},
            "runs": [r60, r300],
        }

    tmp_out = RES_DIR / f"_tmp_milp_{args.mode}.json"
    tmp_out.write_text(json.dumps(out, indent=2), encoding="utf-8")
    print(f"[A2-{args.mode}] Saved {tmp_out}")


if __name__ == "__main__":
    main()
