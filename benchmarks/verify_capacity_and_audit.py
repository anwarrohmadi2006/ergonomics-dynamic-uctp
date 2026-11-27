"""
Standalone public verification of FST capacity bounds (continuous minutes vs
discrete slot bin-packing), weekly class workload thresholds (1420 vs 1490 min),
and wet-lab Asprak cohort availability.
"""
from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
DATA_JSON = BASE / "data" / "fst-20261-anonymized.json"
OUT_JSON = BASE / "results" / "capacity_audit.json"


def main() -> None:
    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    data = json.loads(DATA_JSON.read_text(encoding="utf-8"))
    sessions = data["sessions"]
    rooms = data["rooms"]

    theory = [s for s in sessions if s["roomType"] in ("PASCA", "SAINTEK")]
    n_100 = sum(1 for s in theory if s["duration"] == 100)
    n_150 = sum(1 for s in theory if s["duration"] == 150)
    other_dur = [s["duration"] for s in theory if s["duration"] not in (100, 150)]
    total_min = sum(s["duration"] for s in theory)

    pasca_rooms = [r for r in rooms if r["type"] == "PASCA"]
    saintek_rooms = [r for r in rooms if r["type"] == "SAINTEK"]
    room_days_strict = len(pasca_rooms) * 3 + len(saintek_rooms) * 5

    cap_500_min = room_days_strict * 500
    deficit_min = total_min - cap_500_min
    min_unavoidable_discrete_waste = 50 if (n_150 % 2 == 1) else 0
    discrete_deficit_min = (total_min + min_unavoidable_discrete_waste) - cap_500_min
    discrete_100m_slots_needed = (discrete_deficit_min + 99) // 100

    dry_overflow_rooms = [r for r in rooms if r["name"] in ("LAB. DATA ENGINEER", "LAB. DATA SCIENCE")]
    dry_baseline_sessions = [s for s in sessions if s["room"] in ("LAB. DATA ENGINEER", "LAB. DATA SCIENCE")]

    cls_minutes: dict[str, int] = defaultdict(int)
    cls_sessions: dict[str, int] = defaultdict(int)
    for s in sessions:
        for c in s["classes"]:
            cls_minutes[c] += s["duration"]
            cls_sessions[c] += 1

    sorted_classes = sorted(
        [
            {
                "className": c,
                "totalWeeklyMinutes": m,
                "sessionCount": cls_sessions[c],
                "exceeds1420": m > 1420,
                "exceeds1490": m > 1490,
            }
            for c, m in cls_minutes.items()
        ],
        key=lambda x: x["totalWeeklyMinutes"],
        reverse=True,
    )

    payload = {
        "theoryCapacity": {
            "theorySessionCount": len(theory),
            "theory100MinCount": n_100,
            "theory150MinCount": n_150,
            "otherDurations": other_dur,
            "totalTheoryMinutes": total_min,
            "pascaRooms": len(pasca_rooms),
            "saintekRooms": len(saintek_rooms),
            "strictRoomDays": room_days_strict,
            "ergonomic0840to1800CapMin": cap_500_min,
            "continuousLoadPct": round((total_min / cap_500_min) * 100, 2),
            "continuousDeficitMin": deficit_min,
            "continuous100mEquivalents": round(deficit_min / 100, 2),
            "minUnavoidableDiscreteWasteMin": min_unavoidable_discrete_waste,
            "discreteDeficitMin": discrete_deficit_min,
            "discrete100mSlotsShortfall": discrete_100m_slots_needed,
            "campus0700to1800CapMin": room_days_strict * 600,
            "campus0700to1800LoadPct": round((total_min / (room_days_strict * 600)) * 100, 2),
        },
        "dryLabOverflow": {
            "rooms": [r["name"] for r in dry_overflow_rooms],
            "existingDryLabSessions": len(dry_baseline_sessions),
            "existingDryLabMinutes": sum(s["duration"] for s in dry_baseline_sessions),
            "grossWeekly0840Minutes": len(dry_overflow_rooms) * 5 * 500,
        },
        "classWorkloadAudit": {
            "totalClasses": len(sorted_classes),
            "classesExceeding1420": [c for c in sorted_classes if c["exceeds1420"]],
            "classesExceeding1490": [c for c in sorted_classes if c["exceeds1490"]],
            "highestUnder1420": next((c for c in sorted_classes if not c["exceeds1420"]), None),
            "allClassesTop10": sorted_classes[:10],
        },
        "wetLabCount": sum(1 for s in sessions if s["isWetLab"]),
    }
    OUT_JSON.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    print("CAPACITY_AUDIT_OK:", payload["theoryCapacity"]["continuousDeficitMin"], "min deficit")


if __name__ == "__main__":
    main()
