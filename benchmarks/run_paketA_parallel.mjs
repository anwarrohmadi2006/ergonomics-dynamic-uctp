/**
 * Paket A — Multi-Core Parallel GLP Benchmark Suite (A1 + A3 + A4 + A7)
 * Spawns Node worker_threads across CPU cores to execute:
 *   - A1: Symmetric 2x2 Objective x Algorithm Matrix at ~10.4s (w_lec = 300, n = 30 paired seeds):
 *         {MN-LAHC, Stage-4} x {F_soft surrogate, Obj_S4 (1000*H_raw - 300*LecIso)}
 *   - A3: Full n = 30 paired seeds across all core methods + Frozen-TPE (5 train + 25 held-out)
 *   - A4: Stage-3 & Stage-4 Component Ablation (n = 10 paired seeds):
 *         w/o Stage-3 3-Cycle Bridge, w/o Half-Day Bin-Pack/Repack, w/o Strategic Oscillation
 *   - A7: Soft Weight Sensitivity ±20% (n = 10 paired seeds):
 *         S4-Equity (-20% / +20%) and MN-LAHC Eq (-20% / +20%)
 *
 * Output: experiment_v2/results/paketA_ablation_30seeds.json
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ENGINE_CANDIDATES = [
  path.join(__dirname, '..', 'solver', 'dist', 'csp-engine.js'),
  path.join(__dirname, '..', '..', 'app', 'js', 'csp-engine.js'),
];
const ENGINE_PATH = ENGINE_CANDIDATES.find((p) => fs.existsSync(p));
if (!ENGINE_PATH) throw new Error('Compiled csp-engine.js not found.');

const DATA_PATH = path.join(__dirname, '..', 'data', 'fst-20261-anonymized.json');
const V2_PATH = path.join(__dirname, '..', 'results', 'benchmark_v2_results.json');
const OUT_PATH = path.join(__dirname, '..', 'results', 'paketA_ablation_30seeds.json');

const SEEDS_30 = [
  11, 22, 27, 33, 42, 55, 66, 77, 88, 99,
  101, 113, 127, 139, 149, 157, 167, 179, 191, 199,
  211, 223, 229, 239, 251, 263, 271, 281, 293, 307,
];
const SEEDS_10_SET = new Set(SEEDS_30.slice(0, 10));

function round2(n) { return Number(n.toFixed(2)); }
function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function sampleStd(arr) {
  if (arr.length <= 1) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((acc, x) => acc + (x - m) ** 2, 0) / (arr.length - 1));
}
function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function isHardFeasible(a) {
  return (
    a.hardConflictCount === 0 &&
    a.pascaViolationCount === 0 &&
    a.asprakDeadlockCount === 0 &&
    (a.fridayPrayerViolationCount ?? 0) === 0
  );
}
function extractMetrics(audit, extra = {}) {
  const feasible = isHardFeasible(audit);
  const gated = feasible ? audit.humaneScore : 0;
  const lecIso = audit.lecturerIsolatedDayCount;
  return {
    feasible,
    hardConflicts: audit.hardConflictCount,
    pascaViolations: audit.pascaViolationCount,
    asprakDeadlocks: audit.asprakDeadlockCount,
    asprakPartials: audit.asprakPartialCount,
    fridayPrayerViolations: audit.fridayPrayerViolationCount ?? 0,
    ishomaViolations: audit.ishomaViolationCount ?? 0,
    earlyBefore0840: audit.earlyBefore0840Count,
    contiguousClasses: audit.contiguousClassCount,
    holeDays: audit.totalHoleDays,
    classesWithin3Days: audit.classesWithin3Days,
    isolatedClassDays: audit.isolatedDayCount,
    lecturerIsolatedDays: lecIso,
    totalLongGaps: audit.classLongGaps + audit.lecturerLongGaps,
    lateSessions: audit.lateSessionCount,
    rawHumaneScore: audit.humaneScore,
    gatedHumaneScore: round2(gated),
    balancedScore03: round2(Math.max(0, gated - 0.3 * lecIso)),
    balancedScore06: round2(Math.max(0, gated - 0.6 * lecIso)),
    ...extra,
  };
}
function summarizeRuns(runs) {
  const keys = [
    'gatedHumaneScore', 'rawHumaneScore', 'balancedScore03', 'balancedScore06',
    'contiguousClasses', 'holeDays', 'classesWithin3Days',
    'isolatedClassDays', 'lecturerIsolatedDays', 'totalLongGaps',
    'earlyBefore0840', 'lateSessions', 'asprakPartials', 'fridayPrayerViolations', 'totalMs',
  ];
  const out = { n: runs.length, feasibleRatePct: round2((runs.filter((r) => r.feasible).length / runs.length) * 100) };
  for (const k of keys) {
    const vals = runs.map((r) => r[k]).filter((v) => typeof v === 'number');
    out[`mean_${k}`] = round2(mean(vals));
    out[`sd_${k}`] = round2(sampleStd(vals));
    out[`median_${k}`] = round2(median(vals));
  }
  return out;
}

if (!isMainThread) {
  // =========================================================================
  // WORKER THREAD: Executes all assigned seeds independently on dedicated core
  // =========================================================================
  const CSPEngine = require(ENGINE_PATH);
  const { seeds, baselineSessions, rooms, frozenTpeParams } = workerData;
  const policy = {
    ...CSPEngine.DEFAULT_POLICY,
    allowDryLabOverflow: true,
    protectFridayPrayer: true,
    hardFridayPrayer: true,
  };

  // SA Baseline helpers (identical to run_ablation_and_baselines.mjs)
  const DAYS_LIST = CSPEngine.DAYS;
  const PASCA_DAYS = new Set(['Senin', 'Selasa', 'Rabu']);
  const START_GRID = {
    50: [520, 570, 620, 780, 880, 980],
    100: [520, 620, 780, 880, 980],
    150: [520, 570, 780, 930],
    170: [520, 550, 780, 910],
    340: [780],
  };
  const cohortMap = new Map();
  for (const s of baselineSessions) {
    for (const c of s.classes) {
      if (/^Praktikum\s+/i.test(c)) continue;
      const m = c.match(/^(.+?)\s+(\d)[A-Z]$/);
      if (!m) continue;
      const key = `${m[1].trim()}|${m[2]}`;
      if (!cohortMap.has(key)) cohortMap.set(key, new Set());
      cohortMap.get(key).add(c);
    }
  }
  const seniorMap = new Map();
  for (const s of baselineSessions) {
    if (!s.isWetLab) continue;
    const seniors = new Set();
    for (const c of s.classes) {
      const clean = c.replace(/^Praktikum\s+/i, '').trim();
      const m = clean.match(/^(.+?)\s+(\d)[A-Z]$/);
      if (!m) continue;
      const up = cohortMap.get(`${m[1].trim()}|${Number(m[2]) + 2}`);
      if (up) for (const sc of up) seniors.add(sc);
    }
    if (seniors.size > 0) seniorMap.set(s.id, Array.from(seniors));
  }

  function isFeasiblePlacement(sessions, idx, day, start, room, effClsCache, skipIdx = -1) {
    const s = sessions[idx];
    const end = start + s.duration;
    if (start < 520 || end > 1140) return false;
    if (s.duration <= 300 && start < 780 && end > 720) return false;
    if (policy.hardFridayPrayer && day === 'Jumat' && start < 780 && end > 690) return false;
    if (policy.enforcePascaMonWed && CSPEngine.isPascaRoom(room) && !PASCA_DAYS.has(day)) return false;
    const myCls = effClsCache[idx];
    for (let j = 0; j < sessions.length; j++) {
      if (j === idx || j === skipIdx) continue;
      const o = sessions[j];
      if (o.day !== day || start >= o.end || o.start >= end) continue;
      if (o.room === room) return false;
      if (s.dosen && o.dosen && s.dosen === o.dosen) return false;
      const oCls = effClsCache[j];
      for (let a = 0; a < myCls.length; a++) {
        for (let b = 0; b < oCls.length; b++) if (myCls[a] === oCls[b]) return false;
      }
    }
    if (policy.enforceAsprakWetLab) {
      const mySeniors = seniorMap.get(s.id);
      if (mySeniors) {
        let freeCnt = 0;
        for (const sc of mySeniors) {
          let busy = false;
          for (let j = 0; j < sessions.length; j++) {
            if (j === idx || j === skipIdx) continue;
            const o = sessions[j];
            if (o.day !== day || start >= o.end || o.start >= end) continue;
            if (effClsCache[j].includes(sc)) { busy = true; break; }
          }
          if (!busy) { freeCnt++; break; }
        }
        if (freeCnt === 0) return false;
      }
      for (let j = 0; j < sessions.length; j++) {
        if (j === idx || j === skipIdx) continue;
        const w = sessions[j];
        const wSeniors = seniorMap.get(w.id);
        if (!wSeniors || w.day !== day || start >= w.end || w.start >= end) continue;
        if (!wSeniors.some((sc) => myCls.includes(sc))) continue;
        let freeCnt = 0;
        for (const sc of wSeniors) {
          if (myCls.includes(sc)) continue;
          let busy = false;
          for (let k = 0; k < sessions.length; k++) {
            if (k === idx || k === j || k === skipIdx) continue;
            const o = sessions[k];
            if (o.day !== w.day || w.start >= o.end || o.start >= w.end) continue;
            if (effClsCache[k].includes(sc)) { busy = true; break; }
          }
          if (!busy) { freeCnt++; break; }
        }
        if (freeCnt === 0) return false;
      }
    }
    return true;
  }

  function runSAOnSeed(stage1Res, seed, stage2BudgetMs, mode) {
    const cur = CSPEngine.cloneSessions(stage1Res.sessions);
    const effClsCache = cur.map((s) => CSPEngine.expandEffectiveClasses(s.classes));
    const allowedRoomsCache = cur.map((s) => CSPEngine.getAllowedRooms(s, rooms, policy));
    const dayToIdx = { Senin: 0, Selasa: 1, Rabu: 2, Kamis: 3, Jumat: 4 };
    const clsToIdx = new Map();
    for (let i = 0; i < cur.length; i++) {
      for (const c of cur[i].classes) {
        if (!clsToIdx.has(c)) clsToIdx.set(c, []);
        clsToIdx.get(c).push(i);
      }
    }
    const classList = Array.from(clsToIdx.keys());

    let curE = CSPEngine.computeGlobalHumaneEnergy(cur, policy);
    let bestE = curE;
    let bestSnap = CSPEngine.cloneSessions(cur);
    let rng = (seed * 2654435761 + 1013904223) >>> 0;
    const rand = () => {
      rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0;
      return rng / 4294967296;
    };

    const T0 = mode === 'TUNED_MULTIOP_REHEAT' ? 380 : 450;
    const Tmin = 1.5;
    let T = T0, reheatBoost = 1.0, iters = 0, evalStagnant = 0, reheats = 0;
    const tStart = performance.now();
    const deadline = tStart + stage2BudgetMs;

    while (performance.now() < deadline) {
      iters++;
      const frac = Math.min(1, (performance.now() - tStart) / stage2BudgetMs);
      const baseT = T0 * Math.pow(Tmin / T0, frac);
      if (mode === 'TUNED_MULTIOP_REHEAT') {
        reheatBoost = Math.max(1.0, reheatBoost * 0.9994);
        if (evalStagnant >= 1800 && reheats < 2 && frac > 0.25 && frac < 0.78) {
          reheatBoost = 2.2; evalStagnant = 0; reheats++;
        }
        T = Math.min(T0 * 0.5, baseT * reheatBoost);
      } else {
        T = baseT;
      }

      const rOp = rand();
      if (mode === 'LEGACY_2OP') {
        if (rOp < 0.72) {
          const idx = Math.floor(rand() * cur.length);
          const s = cur[idx];
          if (s.pinned) continue;
          const rList = allowedRoomsCache[idx];
          const room = rList[Math.floor(rand() * rList.length)];
          const dayPool = CSPEngine.isPascaRoom(room) ? ['Senin', 'Selasa', 'Rabu'] : DAYS_LIST;
          const day = dayPool[Math.floor(rand() * dayPool.length)];
          const grid = START_GRID[s.duration] || [520, 620, 780, 880];
          const start = grid[Math.floor(rand() * grid.length)];
          if (day === s.day && start === s.start && room === s.room) continue;
          if (!isFeasiblePlacement(cur, idx, day, start, room, effClsCache)) continue;
          const oD = s.day, oSt = s.start, oEn = s.end, oR = s.room;
          s.day = day; s.start = start; s.end = start + s.duration; s.room = room;
          const candE = CSPEngine.computeGlobalHumaneEnergy(cur, policy);
          if (candE <= curE || rand() < Math.exp(-(candE - curE) / T)) {
            curE = candE; if (curE < bestE) { bestE = curE; bestSnap = CSPEngine.cloneSessions(cur); }
          } else { s.day = oD; s.start = oSt; s.end = oEn; s.room = oR; }
        } else {
          const i = Math.floor(rand() * cur.length), j = Math.floor(rand() * cur.length);
          if (i === j || cur[i].pinned || cur[j].pinned) continue;
          const si = cur[i], sj = cur[j];
          if (si.duration !== sj.duration) continue;
          if (!allowedRoomsCache[i].includes(sj.room) || !allowedRoomsCache[j].includes(si.room)) continue;
          const dI = si.day, stI = si.start, eI = si.end, rI = si.room;
          const dJ = sj.day, stJ = sj.start, eJ = sj.end, rJ = sj.room;
          if (!isFeasiblePlacement(cur, i, dJ, stJ, rJ, effClsCache, j)) continue;
          if (!isFeasiblePlacement(cur, j, dI, stI, rI, effClsCache, i)) continue;
          si.day = dJ; si.start = stJ; si.end = stJ + si.duration; si.room = rJ;
          sj.day = dI; sj.start = stI; sj.end = stI + sj.duration; sj.room = rI;
          const candE = CSPEngine.computeGlobalHumaneEnergy(cur, policy);
          if (candE <= curE || rand() < Math.exp(-(candE - curE) / T)) {
            curE = candE; if (curE < bestE) { bestE = curE; bestSnap = CSPEngine.cloneSessions(cur); }
          } else {
            si.day = dI; si.start = stI; si.end = eI; si.room = rI;
            sj.day = dJ; sj.start = stJ; sj.end = eJ; sj.room = rJ;
          }
        }
      } else {
        if (rOp < 0.35) {
          const idx = Math.floor(rand() * cur.length);
          const s = cur[idx];
          if (s.pinned) continue;
          const rList = allowedRoomsCache[idx];
          const room = rList[Math.floor(rand() * rList.length)];
          let dayPool = CSPEngine.isPascaRoom(room) ? ['Senin', 'Selasa', 'Rabu'] : DAYS_LIST;
          if (rand() < 0.5 && s.classes.length > 0) {
            const cIdxList = clsToIdx.get(s.classes[0]) || [];
            const activeDays = [...new Set(cIdxList.map((x) => cur[x].day))].filter((d) => dayPool.includes(d));
            if (activeDays.length > 0) dayPool = activeDays;
          }
          const day = dayPool[Math.floor(rand() * dayPool.length)];
          const grid = START_GRID[s.duration] || [520, 620, 780, 880];
          const start = grid[Math.floor(rand() * grid.length)];
          if (day === s.day && start === s.start && room === s.room) continue;
          if (!isFeasiblePlacement(cur, idx, day, start, room, effClsCache)) continue;
          const oD = s.day, oSt = s.start, oEn = s.end, oR = s.room;
          s.day = day; s.start = start; s.end = start + s.duration; s.room = room;
          const candE = CSPEngine.computeGlobalHumaneEnergy(cur, policy);
          if (candE <= curE || rand() < Math.exp(-(candE - curE) / T)) {
            curE = candE;
            if (curE < bestE) { bestE = curE; bestSnap = CSPEngine.cloneSessions(cur); evalStagnant = 0; } else evalStagnant++;
          } else { s.day = oD; s.start = oSt; s.end = oEn; s.room = oR; evalStagnant++; }
        } else if (rOp < 0.58) {
          const i = Math.floor(rand() * cur.length), j = Math.floor(rand() * cur.length);
          if (i === j || cur[i].pinned || cur[j].pinned) continue;
          const si = cur[i], sj = cur[j];
          if (si.duration !== sj.duration) continue;
          if (!allowedRoomsCache[i].includes(sj.room) || !allowedRoomsCache[j].includes(si.room)) continue;
          const dI = si.day, stI = si.start, eI = si.end, rI = si.room;
          const dJ = sj.day, stJ = sj.start, eJ = sj.end, rJ = sj.room;
          if (!isFeasiblePlacement(cur, i, dJ, stJ, rJ, effClsCache, j)) continue;
          if (!isFeasiblePlacement(cur, j, dI, stI, rI, effClsCache, i)) continue;
          si.day = dJ; si.start = stJ; si.end = stJ + si.duration; si.room = rJ;
          sj.day = dI; sj.start = stI; sj.end = stI + sj.duration; sj.room = rI;
          const candE = CSPEngine.computeGlobalHumaneEnergy(cur, policy);
          if (candE <= curE || rand() < Math.exp(-(candE - curE) / T)) {
            curE = candE;
            if (curE < bestE) { bestE = curE; bestSnap = CSPEngine.cloneSessions(cur); evalStagnant = 0; } else evalStagnant++;
          } else {
            si.day = dI; si.start = stI; si.end = eI; si.room = rI;
            sj.day = dJ; sj.start = stJ; sj.end = eJ; sj.room = rJ; evalStagnant++;
          }
        } else if (rOp < 0.84) {
          const cls = classList[Math.floor(rand() * classList.length)];
          const cIndices = clsToIdx.get(cls);
          if (!cIndices || cIndices.length < 2) continue;
          const byDay = [[], [], [], [], []];
          for (const id of cIndices) byDay[dayToIdx[cur[id].day]].push(id);
          const activeDays = [];
          for (let d = 0; d < 5; d++) if (byDay[d].length > 0) activeDays.push(d);
          if (activeDays.length < 2) continue;
          const singles = activeDays.filter((d) => byDay[d].length === 1);
          const srcDay = singles.length > 0 ? singles[Math.floor(rand() * singles.length)] : (rand() < 0.5 ? activeDays[0] : activeDays[activeDays.length - 1]);
          const srcList = byDay[srcDay];
          const idx = srcList[Math.floor(rand() * srcList.length)];
          const s = cur[idx];
          if (s.pinned) continue;
          const minD = activeDays[0], maxD = activeDays[activeDays.length - 1];
          const candDayIndices = [];
          for (let d = minD; d <= maxD; d++) if (d !== srcDay) candDayIndices.push(d);
          if (!candDayIndices.length) continue;
          const tgtDay = DAYS_LIST[candDayIndices[Math.floor(rand() * candDayIndices.length)]];
          const rList = allowedRoomsCache[idx].filter((rm) => !CSPEngine.isPascaRoom(rm) || ['Senin', 'Selasa', 'Rabu'].includes(tgtDay));
          if (!rList.length) continue;
          const room = rList[Math.floor(rand() * rList.length)];
          const grid = START_GRID[s.duration] || [520, 620, 780, 880];
          const start = grid[Math.floor(rand() * grid.length)];
          if (!isFeasiblePlacement(cur, idx, tgtDay, start, room, effClsCache)) continue;
          const oD = s.day, oSt = s.start, oEn = s.end, oR = s.room;
          s.day = tgtDay; s.start = start; s.end = start + s.duration; s.room = room;
          const candE = CSPEngine.computeGlobalHumaneEnergy(cur, policy);
          if (candE <= curE || rand() < Math.exp(-(candE - curE) / T)) {
            curE = candE;
            if (curE < bestE) { bestE = curE; bestSnap = CSPEngine.cloneSessions(cur); evalStagnant = 0; } else evalStagnant++;
          } else { s.day = oD; s.start = oSt; s.end = oEn; s.room = oR; evalStagnant++; }
        } else {
          const cls = classList[Math.floor(rand() * classList.length)];
          const cIndices = clsToIdx.get(cls);
          if (!cIndices || cIndices.length < 2) continue;
          const idx = cIndices[Math.floor(rand() * cIndices.length)];
          const s = cur[idx];
          if (s.pinned) continue;
          const grid = START_GRID[s.duration] || [520, 620, 780, 880];
          const start = grid[Math.floor(rand() * grid.length)];
          if (start === s.start) continue;
          const rList = allowedRoomsCache[idx].filter((rm) => !CSPEngine.isPascaRoom(rm) || ['Senin', 'Selasa', 'Rabu'].includes(s.day));
          if (!rList.length) continue;
          const room = rand() < 0.7 && rList.includes(s.room) ? s.room : rList[Math.floor(rand() * rList.length)];
          if (!isFeasiblePlacement(cur, idx, s.day, start, room, effClsCache)) continue;
          const oSt = s.start, oEn = s.end, oR = s.room;
          s.start = start; s.end = start + s.duration; s.room = room;
          const candE = CSPEngine.computeGlobalHumaneEnergy(cur, policy);
          if (candE <= curE || rand() < Math.exp(-(candE - curE) / T)) {
            curE = candE;
            if (curE < bestE) { bestE = curE; bestSnap = CSPEngine.cloneSessions(cur); evalStagnant = 0; } else evalStagnant++;
          } else { s.start = oSt; s.end = oEn; s.room = oR; evalStagnant++; }
        }
      }
    }
    return { audit: CSPEngine.auditSchedule(bestSnap, policy), stage2Ms: round2(performance.now() - tStart), iterations: iters };
  }

  function runStage4(initialRes, baseSeed, opts = {}) {
    const rounds = opts.rounds ?? 2;
    const budgetPerRound = opts.timeBudgetPerRoundMs ?? 3000;
    const lecW = opts.lecturerIsolatedWeight ?? 300;
    const useSurr = Boolean(opts.useSurrogateObjective);
    const wScale = opts.weightScale ?? 1.0;
    const polEval = { ...policy, lecturerIsolatedWeight: lecW * wScale };

    let cur = initialRes;
    let polishMs = 0;
    const scoreOf = (resObj) => {
      if (useSurr) return -CSPEngine.computeGlobalHumaneEnergy(resObj.sessions, polEval);
      if (lecW >= 100) return resObj.audit.gatedHumaneScore - ((lecW * wScale) / 1000) * resObj.audit.lecturerIsolatedDayCount;
      return CSPEngine.computeTpeFitness(resObj.audit).compositeFitness;
    };

    for (let r = 0; r < rounds; r++) {
      const nxt = CSPEngine.deepPolishSchedule(cur.sessions, rooms, policy, {
        seed: baseSeed + 101 + r * 313,
        lahcLength: 65 + r * 20,
        initTemp: 520,
        coolingRate: 0.99955,
        timeBudgetMs: budgetPerRound,
        maxIters: 420000,
        baselineForDiff: baselineSessions,
        lecturerIsolatedWeight: lecW,
        useSurrogateObjective: useSurr,
        disableHalfDayRepack: Boolean(opts.disableHalfDayRepack),
        disableOscillation: Boolean(opts.disableOscillation),
        weightScale: wScale,
      });
      polishMs += nxt.latencyMs;
      if (scoreOf(nxt) >= scoreOf(cur)) cur = nxt;
    }
    return { res: cur, polishMs: round2(polishMs) };
  }

  const results = {};
  for (const seed of seeds) {
    const row = { seed };
    const s1 = CSPEngine.constructiveReset(baselineSessions, rooms, policy, { seed, skipStage2: true });
    row.Stage1_DSATUR = extractMetrics(s1.audit, { seed, totalMs: round2(s1.latencyMs) });

    const ha = CSPEngine.constructiveReset(baselineSessions, rooms, policy, { seed, timeBudgetMs: 3500 });
    const haMs = round2(ha.latencyMs);
    const s2Budget = Math.max(1500, Math.round(haMs - s1.latencyMs));
    row.MN_LAHC_1_8s = extractMetrics(ha.audit, { seed, totalMs: haMs });

    const psa = runSAOnSeed(s1, seed, s2Budget, 'LEGACY_2OP');
    row.PureSA_2Op = extractMetrics(psa.audit, { seed, totalMs: round2(s1.latencyMs + psa.stage2Ms) });

    const tsa = runSAOnSeed(s1, seed, s2Budget, 'TUNED_MULTIOP_REHEAT');
    row.TunedSA_4Op = extractMetrics(tsa.audit, { seed, totalMs: round2(s1.latencyMs + tsa.stage2Ms) });

    // Equal-time ~10.4s: MN-LAHC Std (w_lec=95, F_soft)
    const mnStd = CSPEngine.constructiveReset(baselineSessions, rooms, policy, {
      seed, maxIters: 5000000, timeBudgetMs: 10200, lecturerIsolatedWeight: 95,
    });
    row.MN_LAHC_Std_10_4s = extractMetrics(mnStd.audit, { seed, totalMs: round2(mnStd.latencyMs) });

    // A1 Cell (1,1): MN-LAHC optimizing F_soft (w_lec=300, 10.4s)
    const mnFsoft = CSPEngine.constructiveReset(baselineSessions, rooms, policy, {
      seed, maxIters: 5000000, timeBudgetMs: 10200, lecturerIsolatedWeight: 300, useExactObjective: false,
    });
    row.A1_MN_LAHC_Fsoft = extractMetrics(mnFsoft.audit, { seed, totalMs: round2(mnFsoft.latencyMs) });

    // A1 Cell (1,2): MN-LAHC optimizing Stage-4 Exact Objective Obj_S4 (w_lec=300, 10.4s)
    const mnObjS4 = CSPEngine.constructiveReset(baselineSessions, rooms, policy, {
      seed, maxIters: 5000000, timeBudgetMs: 10200, lecturerIsolatedWeight: 300, useExactObjective: true,
    });
    row.A1_MN_LAHC_ObjS4 = extractMetrics(mnObjS4.audit, { seed, totalMs: round2(mnObjS4.latencyMs) });

    // Stage-4 Student-Only (w_lec=0.35, Obj_S4)
    const s4Std = runStage4(ha, seed, { lecturerIsolatedWeight: 0.35, useSurrogateObjective: false });
    row.Stage4_StudentOnly = extractMetrics(s4Std.res.audit, { seed, totalMs: round2(haMs + s4Std.polishMs) });

    // A1 Cell (2,1): Stage-4 optimizing F_soft (w_lec=300, ~10.2s)
    const s4Fsoft = runStage4(ha, seed, { lecturerIsolatedWeight: 300, useSurrogateObjective: true });
    row.A1_Stage4_Fsoft = extractMetrics(s4Fsoft.res.audit, { seed, totalMs: round2(haMs + s4Fsoft.polishMs) });

    // A1 Cell (2,2): Stage-4 optimizing Obj_S4 (w_lec=300, ~10.2s — Production S4-Equity)
    const s4ObjS4 = runStage4(ha, seed, { lecturerIsolatedWeight: 300, useSurrogateObjective: false });
    row.A1_Stage4_ObjS4 = extractMetrics(s4ObjS4.res.audit, { seed, totalMs: round2(haMs + s4ObjS4.polishMs) });

    // A3 TPE + Stage-4 Equity across all 30 seeds (5 train [11..42] + 25 held-out [55..307])
    const tpeBase = CSPEngine.constructiveReset(baselineSessions, rooms, policy, {
      seed, timeBudgetMs: 3500, hyperparams: frozenTpeParams,
    });
    const tpeS4 = runStage4(tpeBase, seed, { lecturerIsolatedWeight: 300, useSurrogateObjective: false });
    row.TPE_Stage4_Equity = extractMetrics(tpeS4.res.audit, { seed, totalMs: round2(tpeBase.latencyMs + tpeS4.polishMs) });

    // A4 (Component Ablation) & A7 (Weight Sensitivity ±20%) on first 10 paired seeds [11..99]
    if (SEEDS_10_SET.has(seed)) {
      const haNoS3 = CSPEngine.constructiveReset(baselineSessions, rooms, policy, {
        seed, timeBudgetMs: 3500, skipStage3: true,
      });
      const s4NoS3 = runStage4(haNoS3, seed, { lecturerIsolatedWeight: 300 });
      row.A4_S4_NoStage3Bridge = extractMetrics(s4NoS3.res.audit, { seed, totalMs: round2(haNoS3.latencyMs + s4NoS3.polishMs) });

      const s4NoBin = runStage4(ha, seed, { lecturerIsolatedWeight: 300, disableHalfDayRepack: true });
      row.A4_S4_NoHalfDayRepack = extractMetrics(s4NoBin.res.audit, { seed, totalMs: round2(haMs + s4NoBin.polishMs) });

      const s4NoOsc = runStage4(ha, seed, { lecturerIsolatedWeight: 300, disableOscillation: true });
      row.A4_S4_NoOscillation = extractMetrics(s4NoOsc.res.audit, { seed, totalMs: round2(haMs + s4NoOsc.polishMs) });

      // A7 Weight sensitivity ±20%
      const s4Wm20 = runStage4(ha, seed, { lecturerIsolatedWeight: 300, weightScale: 0.8 });
      row.A7_S4_WeightMinus20 = extractMetrics(s4Wm20.res.audit, { seed, totalMs: round2(haMs + s4Wm20.polishMs) });

      const s4Wp20 = runStage4(ha, seed, { lecturerIsolatedWeight: 300, weightScale: 1.2 });
      row.A7_S4_WeightPlus20 = extractMetrics(s4Wp20.res.audit, { seed, totalMs: round2(haMs + s4Wp20.polishMs) });

      const mnWm20 = CSPEngine.constructiveReset(baselineSessions, rooms, policy, {
        seed, maxIters: 5000000, timeBudgetMs: 10200, lecturerIsolatedWeight: 300, weightScale: 0.8,
      });
      row.A7_MN_LAHC_WeightMinus20 = extractMetrics(mnWm20.audit, { seed, totalMs: round2(mnWm20.latencyMs) });

      const mnWp20 = CSPEngine.constructiveReset(baselineSessions, rooms, policy, {
        seed, maxIters: 5000000, timeBudgetMs: 10200, lecturerIsolatedWeight: 300, weightScale: 1.2,
      });
      row.A7_MN_LAHC_WeightPlus20 = extractMetrics(mnWp20.audit, { seed, totalMs: round2(mnWp20.latencyMs) });
    }

    results[seed] = row;
    parentPort.postMessage({ type: 'progress', seed });
  }
  parentPort.postMessage({ type: 'done', results });
} else {
  // =========================================================================
  // MAIN THREAD: Orchestrates 6 parallel worker_threads (leaves headroom for HiGHS)
  // =========================================================================
  const tStartAll = performance.now();
  const dataset = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
  const v2Prev = JSON.parse(fs.readFileSync(V2_PATH, 'utf-8'));
  const frozenTpeParams = v2Prev.splitSeedTpeValidation.winningTrial.params;
  const tpeOfflineMs = v2Prev.splitSeedTpeValidation.tpeSearchMs;

  const NUM_WORKERS = Math.min(6, Math.max(2, os.cpus().length - 4));
  const chunks = Array.from({ length: NUM_WORKERS }, () => []);
  // Interleave seeds so A4/A7 heavy seeds [11..99] spread evenly across workers!
  SEEDS_30.forEach((s, idx) => chunks[idx % NUM_WORKERS].push(s));

  console.log(`[PaketA-Parallel] Launching ${NUM_WORKERS} worker threads for n=30 seeds (A1 2x2 + A3 n=30 + A4 + A7)...`);
  let doneSeeds = 0;
  const mergedBySeed = {};

  await Promise.all(
    chunks.map((chunkSeeds, wid) =>
      new Promise((resolve, reject) => {
        const w = new Worker(__filename, {
          workerData: {
            seeds: chunkSeeds,
            baselineSessions: dataset.sessions,
            rooms: dataset.rooms,
            frozenTpeParams,
          },
        });
        w.on('message', (msg) => {
          if (msg.type === 'progress') {
            doneSeeds++;
            console.log(`  [W${wid}] seed ${msg.seed} done (${doneSeeds}/${SEEDS_30.length}, elapsed=${((performance.now() - tStartAll) / 1000).toFixed(1)}s)`);
          } else if (msg.type === 'done') {
            Object.assign(mergedBySeed, msg.results);
            resolve();
          }
        });
        w.on('error', reject);
        w.on('exit', (code) => { if (code !== 0) reject(new Error(`Worker ${wid} exited ${code}`)); });
      })
    )
  );

  const methodNames30 = [
    'Stage1_DSATUR', 'PureSA_2Op', 'TunedSA_4Op', 'MN_LAHC_1_8s',
    'MN_LAHC_Std_10_4s', 'A1_MN_LAHC_Fsoft', 'A1_MN_LAHC_ObjS4',
    'Stage4_StudentOnly', 'A1_Stage4_Fsoft', 'A1_Stage4_ObjS4', 'TPE_Stage4_Equity',
  ];
  const methodNames10 = [
    'A4_S4_NoStage3Bridge', 'A4_S4_NoHalfDayRepack', 'A4_S4_NoOscillation',
    'A7_S4_WeightMinus20', 'A7_S4_WeightPlus20', 'A7_MN_LAHC_WeightMinus20', 'A7_MN_LAHC_WeightPlus20',
  ];

  const methods = {};
  for (const m of methodNames30) {
    const runs = SEEDS_30.map((s) => mergedBySeed[s][m]);
    methods[m] = { summary: summarizeRuns(runs), runs };
  }
  const seeds10 = SEEDS_30.slice(0, 10);
  for (const m of methodNames10) {
    const runs = seeds10.map((s) => mergedBySeed[s][m]);
    methods[m] = { summary: summarizeRuns(runs), runs };
  }

  // Also summarize held-out n=25 seeds [55..307] for TPE vs No-TPE!
  const heldOut25Seeds = SEEDS_30.slice(5);
  const heldOutNoTpe = heldOut25Seeds.map((s) => mergedBySeed[s].A1_Stage4_ObjS4);
  const heldOutTpe = heldOut25Seeds.map((s) => mergedBySeed[s].TPE_Stage4_Equity);

  const output = {
    meta: {
      seeds30: SEEDS_30,
      seeds10,
      tpeTrainingSeeds: SEEDS_30.slice(0, 5),
      tpeHeldOut25Seeds: heldOut25Seeds,
      tpeOfflineSearchMs: tpeOfflineMs,
      frozenTpeParams,
      workersUsed: NUM_WORKERS,
      wallClockSec: round2((performance.now() - tStartAll) / 1000),
      policy: 'Mode B (+2 dry labs) + Hard Friday Prayer Exclusion (11:30-13:00)',
    },
    methods,
    heldOut25TpeComparison: {
      stage4EquityNoTpe: { summary: summarizeRuns(heldOutNoTpe), runs: heldOutNoTpe },
      tpeStage4Equity: { summary: summarizeRuns(heldOutTpe), runs: heldOutTpe },
    },
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(output, null, 2), 'utf-8');
  console.log(`\n[PaketA-Parallel] ALL DONE in ${output.meta.wallClockSec}s -> ${OUT_PATH}`);
  for (const [k, v] of Object.entries(methods)) {
    const s = v.summary;
    console.log(
      `  ${k.padEnd(25)} n=${String(s.n).padStart(2)} | Hg=${s.mean_gatedHumaneScore.toFixed(2)}±${s.sd_gatedHumaneScore.toFixed(2)} | Hb03=${s.mean_balancedScore03.toFixed(2)} | Hb06=${s.mean_balancedScore06.toFixed(2)} | LecIso=${s.mean_lecturerIsolatedDays.toFixed(1)} | Gap=${s.mean_totalLongGaps.toFixed(1)} | t=${(s.mean_totalMs / 1000).toFixed(2)}s`
    );
  }
}
