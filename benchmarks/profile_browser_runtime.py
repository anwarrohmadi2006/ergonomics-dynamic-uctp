"""
Real Desktop Browser Web-Worker Runtime Profiling (Chromium Headless 1x).

Serves the standalone anonymized `demo_app/` locally over 127.0.0.1 (eliminating network
jitter) and measures real Chromium V8 Web-Worker execution times for:
  1. Full 4-Stage Equity-Aware Schedule Generation (5 seeds on desktop Chromium Web Worker)
  2. Live Interactive Depth-2 Ejection Repair & Safe-Slot Evaluation (10 clicks per profile)

Saves structured results to `experiment_v2/results/browser_profile_results.json`.
"""
from __future__ import annotations

import functools
import http.server
import json
import socketserver
import threading
import time
from pathlib import Path
import numpy as np
from playwright.sync_api import sync_playwright

BASE = Path(__file__).resolve().parent.parent
DEMO_DIR = BASE.parent / "demo_app"
OUT_JSON = BASE / "results" / "browser_profile_results.json"


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        pass


def start_static_server(directory: Path):
    handler = functools.partial(QuietHandler, directory=str(directory))
    httpd = socketserver.TCPServer(("127.0.0.1", 0), handler)
    port = httpd.server_address[1]
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    return httpd, port


def run_profile(url: str, seeds: list[int], cpu_throttle: int) -> dict:
    arrange_runs = []
    repair_eval_ms = []
    repair_move_ms = []

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1440, "height": 840})
        page = context.new_page()
        if cpu_throttle > 1:
            cdp = context.new_cdp_session(page)
            cdp.send("Emulation.setCPUThrottlingRate", {"rate": cpu_throttle})

        page.goto(url, wait_until="networkidle", timeout=30000)
        page.wait_for_selector("#timelineGrid .tl-card", timeout=15000)

        for seed in seeds:
            # Execute the exact production Stage 1-4 Equity-Aware pipeline inside a real Browser Web Worker
            res = page.evaluate(
                """(seedVal) => new Promise((resolve, reject) => {
                    const ds = window.FST_BASELINE_DATASET;
                    const policy = {
                        ...window.CSPEngine.DEFAULT_POLICY,
                        allowDryLabOverflow: true,
                        protectFridayPrayer: true,
                        hardFridayPrayer: true,
                    };
                    const workerCode = `
                        importScripts('${location.origin}/js/csp-engine.js');
                        self.onmessage = (e) => {
                            const { sessions, rooms, policy, seed } = e.data;
                            const t0 = performance.now();
                            const c1 = self.CSPEngine.constructiveReset(sessions, rooms, policy, { seed, timeBudgetMs: 3500 });
                            let cur = c1;
                            for (let r = 0; r < 2; r++) {
                                const nxt = self.CSPEngine.deepPolishSchedule(cur.sessions, rooms, policy, {
                                    seed: seed + 101 + r * 313,
                                    lahcLength: 65 + r * 20,
                                    initTemp: 520,
                                    coolingRate: 0.99955,
                                    timeBudgetMs: 3000,
                                    maxIters: 420000,
                                    baselineForDiff: sessions,
                                    lecturerIsolatedWeight: 300,
                                });
                                if (nxt.audit.balancedScore03 >= cur.audit.balancedScore03) cur = nxt;
                            }
                            const totalMs = performance.now() - t0;
                            // Benchmark 10 interactive slot evaluations & minimal repair plans
                            const evalTimes = [];
                            const moveTimes = [];
                            const sampleIds = cur.sessions.slice(0, 10).map(s => s.id);
                            for (const sid of sampleIds) {
                                const te0 = performance.now();
                                const ev = self.CSPEngine.evaluateCandidateSlots(cur.sessions, sid, rooms, policy);
                                evalTimes.push(performance.now() - te0);
                                const cand = ev.topSafeSlots[0] || ev.topSwapSlots[0];
                                if (cand) {
                                    const tm0 = performance.now();
                                    self.CSPEngine.planMinimalRepair(cur.sessions, sid, cand.day, cand.start, cand.room, rooms, policy);
                                    moveTimes.push(performance.now() - tm0);
                                }
                            }
                            self.postMessage({
                                seed,
                                stage13Ms: Number(c1.latencyMs.toFixed(2)),
                                totalMs: Number(totalMs.toFixed(2)),
                                feasible: cur.audit.hardFeasible,
                                gatedHumaneScore: cur.audit.gatedHumaneScore,
                                balancedScore03: cur.audit.balancedScore03,
                                balancedScore06: cur.audit.balancedScore06,
                                lecturerIsolatedDays: cur.audit.lecturerIsolatedDayCount,
                                fridayViolations: cur.audit.fridayPrayerViolationCount,
                                evalTimes,
                                moveTimes,
                            });
                        };
                    `;
                    const blob = new Blob([workerCode], { type: 'application/javascript' });
                    const w = new Worker(URL.createObjectURL(blob));
                    w.onmessage = (ev) => { w.terminate(); resolve(ev.data); };
                    w.onerror = (err) => { w.terminate(); reject(String(err.message || err)); };
                    w.postMessage({ sessions: ds.sessions, rooms: ds.rooms, policy, seed: seedVal });
                })""",
                seed,
            )
            arrange_runs.append({
                "seed": res["seed"],
                "stage13Ms": res["stage13Ms"],
                "totalMs": res["totalMs"],
                "feasible": res["feasible"],
                "gatedHumaneScore": res["gatedHumaneScore"],
                "balancedScore03": res["balancedScore03"],
                "balancedScore06": res["balancedScore06"],
                "lecturerIsolatedDays": res["lecturerIsolatedDays"],
                "fridayViolations": res["fridayViolations"],
            })
            repair_eval_ms.extend(res["evalTimes"])
            repair_move_ms.extend(res["moveTimes"])

        browser.close()

    tot = np.asarray([r["totalMs"] for r in arrange_runs], dtype=float)
    s13 = np.asarray([r["stage13Ms"] for r in arrange_runs], dtype=float)
    ev = np.asarray(repair_eval_ms, dtype=float)
    mv = np.asarray(repair_move_ms, dtype=float)
    hg = np.asarray([r["gatedHumaneScore"] for r in arrange_runs], dtype=float)

    return {
        "cpuThrottleRate": cpu_throttle,
        "seeds": seeds,
        "runs": arrange_runs,
        "summary": {
            "meanStage13Ms": round(float(np.mean(s13)), 2),
            "sdStage13Ms": round(float(np.std(s13, ddof=1)), 2) if len(s13) > 1 else 0.0,
            "meanTotalMs": round(float(np.mean(tot)), 2),
            "sdTotalMs": round(float(np.std(tot, ddof=1)), 2) if len(tot) > 1 else 0.0,
            "meanGatedHumaneScore": round(float(np.mean(hg)), 2),
            "meanSlotEvalMs": round(float(np.mean(ev)), 2),
            "p95SlotEvalMs": round(float(np.percentile(ev, 95)), 2),
            "meanInteractiveRepairMs": round(float(np.mean(mv)), 2),
            "p95InteractiveRepairMs": round(float(np.percentile(mv, 95)), 2),
            "allFeasible": all(r["feasible"] for r in arrange_runs),
            "allZeroFriday": all(r["fridayViolations"] == 0 for r in arrange_runs),
        },
    }


def main() -> None:
    if DEMO_DIR.exists():
        httpd, port = start_static_server(DEMO_DIR)
        url = f"http://127.0.0.1:{port}/index.html"
    else:
        httpd = None
        url = "https://fst-csp-demo.pages.dev/"
    try:
        print(f"[BrowserProfile] Running Chromium Desktop Web Worker profile (5 seeds) on {url}...")
        desktop = run_profile(url, [11, 22, 27, 33, 42], cpu_throttle=1)
        print("[BrowserProfile] Desktop:", json.dumps(desktop["summary"]))
    finally:
        if httpd is not None:
            httpd.shutdown()

    payload = {
        "runtime": "Chromium Headless Web Worker (Playwright Desktop 1x)",
        "policy": "Mode B + Hard Friday Prayer (11:30-13:00) + Stage-4 Equity (w_lec=300)",
        "note": "Measures genuine dedicated browser Web Worker execution on demo_app/ served locally over 127.0.0.1; physical smartphone profiling remains future work.",
        "desktopWebWorker": desktop,
    }
    OUT_JSON.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"[BrowserProfile] Saved {OUT_JSON}")


if __name__ == "__main__":
    main()
