/**
 * Experiment v3 (GLP-Compliant): Equal-Budget Controlled Ablation, Fixed 4-Op Tuned SA,
 * Equity-Aware Stage-4, 3-Way Friday Prayer Sensitivity (Uniform / Soft / Hard),
 * Split-Seed TPE Null-Check, Strictly Audited N=100 Dynamic Repair (H-ALNS + Dense Stage-4)
 * & First-Attempt 10x5 Chains, and UAS Quality vs Greedy First-Fit + Greedy Balanced.
 *
 * Uses anonymized dataset (`../data/fst-20261-anonymized.json`) and compiled
 * engine (`../../app/js/csp-engine.js` or `../solver/dist/csp-engine.js`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_CANDIDATES = [
  path.join(__dirname, '..', 'solver', 'dist', 'csp-engine.js'),
  path.join(__dirname, '..', '..', 'app', 'js', 'csp-engine.js'),
];
const ENGINE_PATH = ENGINE_CANDIDATES.find((p) => fs.existsSync(p));
if (!ENGINE_PATH) throw new Error('Compiled csp-engine.js not found.');
const CSPEngine = require(ENGINE_PATH);

const DATA_PATH = path.join(__dirname, '..', 'data', 'fst-20261-anonymized.json');
const OUT_PATH = path.join(__dirname, '..', 'results', 'benchmark_v2_results.json');

fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
const dataset = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
const { sessions: baselineSessions, rooms } = dataset;

const SEEDS = [11, 22, 27, 33, 42, 55, 66, 77, 88, 99];
const TUNING_SEEDS = [11, 22, 27, 33, 42];
const HELD_OUT_SEEDS = [55, 66, 77, 88, 99];

function round2(n) {
  return Number(n.toFixed(2));
}
function mean(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}
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

function isHardFeasible(a, requireHardFriday = false) {
  return (
    a.hardConflictCount === 0 &&
    a.pascaViolationCount === 0 &&
    a.asprakDeadlockCount === 0 &&
    (!requireHardFriday || (a.fridayPrayerViolationCount ?? 0) === 0)
  );
}

function extractMetrics(audit, extra = {}, requireHardFriday = false) {
  const feasible = isHardFeasible(audit, requireHardFriday);
  return {
    feasible,
    hardConflicts: audit.hardConflictCount,
    pascaViolations: audit.pascaViolationCount,
    asprakDeadlocks: audit.asprakDeadlockCount,
    asprakPartial: audit.asprakPartialCount,
    asprakClear: audit.asprakClearCount,
    ishomaViolations: audit.ishomaViolationCount,
    fridayPrayerViolations: audit.fridayPrayerViolationCount ?? 0,
    humaneStartPct: audit.humaneStartPct,
    earlyBefore0840: audit.earlyBefore0840Count,
    contiguousClasses: audit.contiguousClassCount,
    holeDays: audit.totalHoleDays,
    classesWithin3Days: audit.classesWithin3Days,
    compactClassPct: audit.compactClassPct,
    isolatedClassDays: audit.isolatedDayCount,
    lecturerIsolatedDays: audit.lecturerIsolatedDayCount,
    classLongGaps: audit.classLongGaps,
    lecturerLongGaps: audit.lecturerLongGaps,
    totalLongGaps: audit.classLongGaps + audit.lecturerLongGaps,
    marathons: audit.marathonDayCount,
    lateSessions: audit.lateSessionCount,
    humaneScore: audit.humaneScore,
    gatedHumaneScore: feasible ? audit.humaneScore : 0,
    balancedScore03: feasible ? round2(Math.max(0, audit.humaneScore - 0.3 * audit.lecturerIsolatedDayCount)) : 0,
    balancedScore06: feasible ? round2(Math.max(0, audit.humaneScore - 0.6 * audit.lecturerIsolatedDayCount)) : 0,
    ...extra,
  };
}

function summarizeRuns(runs) {
  const numKeys = [
    'humaneScore',
    'gatedHumaneScore',
    'balancedScore03',
    'balancedScore06',
    'contiguousClasses',
    'holeDays',
    'classesWithin3Days',
    'isolatedClassDays',
    'lecturerIsolatedDays',
    'classLongGaps',
    'lecturerLongGaps',
    'totalLongGaps',
    'asprakClear',
    'asprakPartial',
    'fridayPrayerViolations',
    'lateSessions',
    'stage1Ms',
    'stage2Ms',
    'polishMs',
    'tpeSearchMs',
    'totalMs',
  ];
  const summary = {
    trials: runs.length,
    feasibleRatePct: round2((runs.filter((r) => r.feasible).length / runs.length) * 100),
    fullContiguousRatePct: round2((runs.filter((r) => r.holeDays === 0).length / runs.length) * 100),
    zeroIsolatedClassRatePct: round2((runs.filter((r) => r.isolatedClassDays === 0).length / runs.length) * 100),
  };
  for (const k of numKeys) {
    if (runs.every((r) => typeof r[k] === 'number')) {
      const vals = runs.map((r) => r[k]);
      summary[`mean_${k}`] = round2(mean(vals));
      summary[`sd_${k}`] = round2(sampleStd(vals));
      summary[`median_${k}`] = round2(median(vals));
      summary[`min_${k}`] = round2(Math.min(...vals));
      summary[`max_${k}`] = round2(Math.max(...vals));
    }
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Shared Feasibility & Energy Helper for PureSA (2-Op) and Fixed TunedSA (4-Op)
// Uses identical unified surrogate objective `computeGlobalHumaneEnergy`
// ---------------------------------------------------------------------------
function makeSaContext(baseSessions, policy) {
  const DAYS_LIST = CSPEngine.DAYS;
  const PASCA_DAYS = new Set(['Senin', 'Selasa', 'Rabu']);
  const START_GRID = {
    50: [520, 570, 620, 780, 880, 980],
    100: [520, 620, 780, 880, 980],
    150: [520, 570, 780, 930],
    170: [520, 550, 780, 910],
    340: [780],
  };

  function expandCls(classes) {
    return CSPEngine.expandEffectiveClasses(classes);
  }

  const cohortMap = new Map();
  for (const s of baseSessions) {
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
  for (const s of baseSessions) {
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
        for (let b = 0; b < oCls.length; b++) {
          if (myCls[a] === oCls[b]) return false;
        }
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

  return { DAYS_LIST, START_GRID, expandCls, isFeasiblePlacement };
}

function runSAOnSeed(ctx, stage1Res, seed, stage2BudgetMs, policy, mode = 'LEGACY_2OP') {
  const cur = CSPEngine.cloneSessions(stage1Res.sessions);
  const effClsCache = cur.map((s) => ctx.expandCls(s.classes));
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
  let T = T0;
  let reheatBoost = 1.0;
  let iters = 0;
  let evalStagnant = 0; // ONLY increments on evaluated feasible moves!
  let reheats = 0;
  const tStart = performance.now();
  const deadline = tStart + stage2BudgetMs;

  while (performance.now() < deadline) {
    iters++;
    const frac = Math.min(1, (performance.now() - tStart) / stage2BudgetMs);
    // Wall-clock calibrated cooling for BOTH Legacy 2-Op and Tuned 4-Op (prevents premature freeze / T blowup!)
    const baseT = T0 * Math.pow(Tmin / T0, frac);
    if (mode === 'TUNED_MULTIOP_REHEAT') {
      reheatBoost = Math.max(1.0, reheatBoost * 0.9994);
      if (evalStagnant >= 1800 && reheats < 2 && frac > 0.25 && frac < 0.78) {
        reheatBoost = 2.2;
        evalStagnant = 0;
        reheats++;
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
        const dayPool = CSPEngine.isPascaRoom(room) ? ['Senin', 'Selasa', 'Rabu'] : ctx.DAYS_LIST;
        const day = dayPool[Math.floor(rand() * dayPool.length)];
        const grid = ctx.START_GRID[s.duration] || [520, 620, 780, 880];
        const start = grid[Math.floor(rand() * grid.length)];
        if (day === s.day && start === s.start && room === s.room) continue;
        if (!ctx.isFeasiblePlacement(cur, idx, day, start, room, effClsCache)) continue;

        const oldDay = s.day, oldStart = s.start, oldEnd = s.end, oldRoom = s.room;
        s.day = day; s.start = start; s.end = start + s.duration; s.room = room;
        const candE = CSPEngine.computeGlobalHumaneEnergy(cur, policy);
        const delta = candE - curE;
        if (delta <= 0 || rand() < Math.exp(-delta / T)) {
          curE = candE;
          if (curE < bestE) { bestE = curE; bestSnap = CSPEngine.cloneSessions(cur); }
        } else {
          s.day = oldDay; s.start = oldStart; s.end = oldEnd; s.room = oldRoom;
        }
      } else {
        const i = Math.floor(rand() * cur.length);
        const j = Math.floor(rand() * cur.length);
        if (i === j || cur[i].pinned || cur[j].pinned) continue;
        const si = cur[i], sj = cur[j];
        if (si.duration !== sj.duration) continue;
        if (!allowedRoomsCache[i].includes(sj.room) || !allowedRoomsCache[j].includes(si.room)) continue;
        const dI = si.day, stI = si.start, eI = si.end, rI = si.room;
        const dJ = sj.day, stJ = sj.start, eJ = sj.end, rJ = sj.room;
        if (!ctx.isFeasiblePlacement(cur, i, dJ, stJ, rJ, effClsCache, j)) continue;
        if (!ctx.isFeasiblePlacement(cur, j, dI, stI, rI, effClsCache, i)) continue;
        si.day = dJ; si.start = stJ; si.end = stJ + si.duration; si.room = rJ;
        sj.day = dI; sj.start = stI; sj.end = stI + sj.duration; sj.room = rI;
        const candE = CSPEngine.computeGlobalHumaneEnergy(cur, policy);
        const delta = candE - curE;
        if (delta <= 0 || rand() < Math.exp(-delta / T)) {
          curE = candE;
          if (curE < bestE) { bestE = curE; bestSnap = CSPEngine.cloneSessions(cur); }
        } else {
          si.day = dI; si.start = stI; si.end = eI; si.room = rI;
          sj.day = dJ; sj.start = stJ; sj.end = eJ; sj.room = rJ;
        }
      }
    } else {
      // TUNED_MULTIOP_REHEAT: 4 domain-aware neighborhoods with proper wall-clock cooling & feasible stagnation
      if (rOp < 0.35) {
        // Op 1: Single-shift (50% bias to class's active days)
        const idx = Math.floor(rand() * cur.length);
        const s = cur[idx];
        if (s.pinned) continue;
        const rList = allowedRoomsCache[idx];
        const room = rList[Math.floor(rand() * rList.length)];
        let dayPool = CSPEngine.isPascaRoom(room) ? ['Senin', 'Selasa', 'Rabu'] : ctx.DAYS_LIST;
        if (rand() < 0.5 && s.classes.length > 0) {
          const cIdxList = clsToIdx.get(s.classes[0]) || [];
          const activeDays = [...new Set(cIdxList.map((x) => cur[x].day))].filter((d) => dayPool.includes(d));
          if (activeDays.length > 0) dayPool = activeDays;
        }
        const day = dayPool[Math.floor(rand() * dayPool.length)];
        const grid = ctx.START_GRID[s.duration] || [520, 620, 780, 880];
        const start = grid[Math.floor(rand() * grid.length)];
        if (day === s.day && start === s.start && room === s.room) continue;
        if (!ctx.isFeasiblePlacement(cur, idx, day, start, room, effClsCache)) continue;
        const oldDay = s.day, oldStart = s.start, oldEnd = s.end, oldRoom = s.room;
        s.day = day; s.start = start; s.end = start + s.duration; s.room = room;
        const candE = CSPEngine.computeGlobalHumaneEnergy(cur, policy);
        const delta = candE - curE;
        if (delta <= 0 || rand() < Math.exp(-delta / T)) {
          curE = candE;
          if (curE < bestE) { bestE = curE; bestSnap = CSPEngine.cloneSessions(cur); evalStagnant = 0; }
          else evalStagnant++;
        } else {
          s.day = oldDay; s.start = oldStart; s.end = oldEnd; s.room = oldRoom;
          evalStagnant++;
        }
      } else if (rOp < 0.58) {
        // Op 2: Pairwise swap
        const i = Math.floor(rand() * cur.length);
        const j = Math.floor(rand() * cur.length);
        if (i === j || cur[i].pinned || cur[j].pinned) continue;
        const si = cur[i], sj = cur[j];
        if (si.duration !== sj.duration) continue;
        if (!allowedRoomsCache[i].includes(sj.room) || !allowedRoomsCache[j].includes(si.room)) continue;
        const dI = si.day, stI = si.start, eI = si.end, rI = si.room;
        const dJ = sj.day, stJ = sj.start, eJ = sj.end, rJ = sj.room;
        if (!ctx.isFeasiblePlacement(cur, i, dJ, stJ, rJ, effClsCache, j)) continue;
        if (!ctx.isFeasiblePlacement(cur, j, dI, stI, rI, effClsCache, i)) continue;
        si.day = dJ; si.start = stJ; si.end = stJ + si.duration; si.room = rJ;
        sj.day = dI; sj.start = stI; sj.end = stI + sj.duration; sj.room = rI;
        const candE = CSPEngine.computeGlobalHumaneEnergy(cur, policy);
        const delta = candE - curE;
        if (delta <= 0 || rand() < Math.exp(-delta / T)) {
          curE = candE;
          if (curE < bestE) { bestE = curE; bestSnap = CSPEngine.cloneSessions(cur); evalStagnant = 0; }
          else evalStagnant++;
        } else {
          si.day = dI; si.start = stI; si.end = eI; si.room = rI;
          sj.day = dJ; sj.start = stJ; sj.end = eJ; sj.room = rJ;
          evalStagnant++;
        }
      } else if (rOp < 0.84) {
        // Op 3: Targeted Hole-Collapse / Isolated-Day Merge
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
        if (candDayIndices.length === 0) continue;
        const tgtDay = ctx.DAYS_LIST[candDayIndices[Math.floor(rand() * candDayIndices.length)]];

        const rList = allowedRoomsCache[idx].filter((rm) => !CSPEngine.isPascaRoom(rm) || ['Senin', 'Selasa', 'Rabu'].includes(tgtDay));
        if (rList.length === 0) continue;
        const room = rList[Math.floor(rand() * rList.length)];
        const grid = ctx.START_GRID[s.duration] || [520, 620, 780, 880];
        const start = grid[Math.floor(rand() * grid.length)];
        if (!ctx.isFeasiblePlacement(cur, idx, tgtDay, start, room, effClsCache)) continue;

        const oldDay = s.day, oldStart = s.start, oldEnd = s.end, oldRoom = s.room;
        s.day = tgtDay; s.start = start; s.end = start + s.duration; s.room = room;
        const candE = CSPEngine.computeGlobalHumaneEnergy(cur, policy);
        const delta = candE - curE;
        if (delta <= 0 || rand() < Math.exp(-delta / T)) {
          curE = candE;
          if (curE < bestE) { bestE = curE; bestSnap = CSPEngine.cloneSessions(cur); evalStagnant = 0; }
          else evalStagnant++;
        } else {
          s.day = oldDay; s.start = oldStart; s.end = oldEnd; s.room = oldRoom;
          evalStagnant++;
        }
      } else {
        // Op 4: Same-day time compaction / gap tightening
        const cls = classList[Math.floor(rand() * classList.length)];
        const cIndices = clsToIdx.get(cls);
        if (!cIndices || cIndices.length < 2) continue;
        const idx = cIndices[Math.floor(rand() * cIndices.length)];
        const s = cur[idx];
        if (s.pinned) continue;
        const grid = ctx.START_GRID[s.duration] || [520, 620, 780, 880];
        const start = grid[Math.floor(rand() * grid.length)];
        const rList = allowedRoomsCache[idx].filter((rm) => !CSPEngine.isPascaRoom(rm) || ['Senin', 'Selasa', 'Rabu'].includes(s.day));
        if (rList.length === 0) continue;
        const room = rList[Math.floor(rand() * rList.length)];
        if (start === s.start && room === s.room) continue;
        if (!ctx.isFeasiblePlacement(cur, idx, s.day, start, room, effClsCache)) continue;
        const oldStart = s.start, oldEnd = s.end, oldRoom = s.room;
        s.start = start; s.end = start + s.duration; s.room = room;
        const candE = CSPEngine.computeGlobalHumaneEnergy(cur, policy);
        const delta = candE - curE;
        if (delta <= 0 || rand() < Math.exp(-delta / T)) {
          curE = candE;
          if (curE < bestE) { bestE = curE; bestSnap = CSPEngine.cloneSessions(cur); evalStagnant = 0; }
          else evalStagnant++;
        } else {
          s.start = oldStart; s.end = oldEnd; s.room = oldRoom;
          evalStagnant++;
        }
      }
    }
  }

  const stage2Ms = round2(performance.now() - tStart);
  const audit = CSPEngine.auditSchedule(bestSnap, policy);
  return { sessions: bestSnap, audit, stage2Ms, iterations: iters, reheats };
}

function makeCleanSeededRng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function runCleanTpeSearch(tuningSeeds, nTrials, samplerSeed, policy, timeBudgetPerTrialMs = 2000) {
  const t0 = performance.now();
  const rng = makeCleanSeededRng(samplerSeed);
  const specs = CSPEngine.TPE_PARAM_SPECS;
  const gamma = 0.25;
  const nStartup = Math.min(4, nTrials);
  const trials = [];
  let best = null;

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const norm = (val, sp) => clamp((val - sp.min) / Math.max(1e-9, sp.max - sp.min), 0, 1);
  const denorm = (u, sp) => {
    const raw = sp.min + clamp(u, 0, 1) * (sp.max - sp.min);
    if (sp.isInt) return Math.round(raw);
    if (sp.decimals !== undefined) {
      const f = 10 ** sp.decimals;
      return Math.round(raw * f) / f;
    }
    return raw;
  };
  const scottBw = (pts) => {
    if (pts.length <= 1) return 0.28;
    const m = mean(pts);
    const sd = Math.sqrt(pts.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(1, pts.length - 1));
    return clamp(1.06 * Math.max(sd, 0.08) * Math.pow(pts.length, -0.2), 0.065, 0.35);
  };
  const kdeLog = (x, pts, bw) => {
    const inv2 = 1 / (2 * bw * bw);
    const c = 1 / (Math.sqrt(2 * Math.PI) * bw);
    let sum = 1.0;
    for (const p of pts) sum += c * Math.exp(-((x - p) ** 2) * inv2);
    return Math.log(Math.max(1e-15, sum / (pts.length + 1.0)));
  };

  for (let t = 0; t < nTrials; t++) {
    const seed = tuningSeeds[t % tuningSeeds.length];
    let params = { ...CSPEngine.DEFAULT_HYPERPARAMS };
    let phase = 'STARTUP';
    if (t === 0) {
      phase = 'DEFAULT';
    } else if (t < nStartup) {
      for (const sp of specs) params[sp.key] = denorm(rng(), sp);
    } else {
      phase = 'TPE';
      const sorted = [...trials].sort((a, b) => b.compositeFitness - a.compositeFitness);
      const nGood = Math.max(2, Math.min(sorted.length - 1, Math.ceil(sorted.length * gamma)));
      const good = sorted.slice(0, nGood);
      const bad = sorted.slice(nGood);
      for (const sp of specs) {
        const gPts = good.map((x) => norm(x.params[sp.key], sp));
        const bPts = bad.map((x) => norm(x.params[sp.key], sp));
        const bwG = scottBw(gPts);
        const bwB = scottBw(bPts);
        let bestU = 0.5;
        let bestEI = -Infinity;
        for (let k = 0; k < 32; k++) {
          let u;
          if (rng() < 0.85) {
            const c = gPts[Math.floor(rng() * gPts.length)];
            const u1 = Math.max(1e-12, rng()), u2 = rng();
            const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
            u = clamp(c + z * bwG, 0, 1);
          } else {
            u = rng();
          }
          const ei = kdeLog(u, gPts, bwG) - kdeLog(u, bPts, bwB);
          if (ei > bestEI) { bestEI = ei; bestU = u; }
        }
        params[sp.key] = denorm(bestU, sp);
      }
    }

    const r = CSPEngine.constructiveReset(baselineSessions, rooms, policy, {
      seed,
      maxIters: 32000,
      timeBudgetMs: timeBudgetPerTrialMs,
      hyperparams: params,
    });
    const fit = CSPEngine.computeTpeFitness(r.audit);
    const rec = {
      trialId: t + 1,
      seed,
      phase,
      params,
      humaneScore: r.audit.humaneScore,
      compositeFitness: fit.compositeFitness,
      feasiblePerfect: fit.feasiblePerfect,
      latencyMs: r.latencyMs,
      res: r,
    };
    trials.push(rec);
    if (!best || rec.compositeFitness > best.compositeFitness) best = rec;
  }

  return {
    tpeSearchMs: round2(performance.now() - t0),
    bestTrial: {
      trialId: best.trialId,
      seed: best.seed,
      phase: best.phase,
      params: best.params,
      humaneScore: best.humaneScore,
      compositeFitness: best.compositeFitness,
    },
    bestRes: best.res,
    trialsSummary: trials.map((x) => ({
      trialId: x.trialId,
      seed: x.seed,
      phase: x.phase,
      humaneScore: x.humaneScore,
      compositeFitness: x.compositeFitness,
      feasiblePerfect: x.feasiblePerfect,
      latencyMs: x.latencyMs,
    })),
  };
}

function runStage4Polish(initialRes, baseSeed, policy, rounds = 2, timeBudgetPerRoundMs = 3000, lecturerIsolatedWeight = 0.35) {
  let cur = initialRes;
  let polishMs = 0;
  let polishIters = 0;
  const evalMetric = (a) =>
    lecturerIsolatedWeight >= 100
      ? a.gatedHumaneScore - 0.3 * a.lecturerIsolatedDayCount
      : CSPEngine.computeTpeFitness(a).compositeFitness;

  for (let r = 0; r < rounds; r++) {
    const nxt = CSPEngine.deepPolishSchedule(cur.sessions, rooms, policy, {
      seed: baseSeed + 101 + r * 313,
      lahcLength: 65 + r * 20,
      initTemp: 520,
      coolingRate: 0.99955,
      timeBudgetMs: timeBudgetPerRoundMs,
      maxIters: 420000,
      baselineForDiff: baselineSessions,
      lecturerIsolatedWeight,
    });
    polishMs += nxt.latencyMs;
    polishIters += nxt.metaheuristic.iterations;
    if (evalMetric(nxt.audit) >= evalMetric(cur.audit)) {
      cur = nxt;
    }
  }
  return { res: cur, polishMs: round2(polishMs), polishIters };
}

// ============================================================================
// DEFAULT INSTITUTIONAL POLICY: Hard Salat Jumat (11:30-13:00) for UIN!
// ============================================================================
console.log('[v3-GLP] Starting GLP Equal-Time Ablation & Verified Benchmark Suite...');
const policy = {
  ...CSPEngine.DEFAULT_POLICY,
  allowDryLabOverflow: true,
  protectFridayPrayer: true,
  hardFridayPrayer: true,
};
const saCtx = makeSaContext(baselineSessions, policy);

// ---------------------------------------------------------------------------
// PART 1: Paired 10-Seed GLP Equal-Budget Ablation (1.8s Tier + 8.0s Equal-Time Tier)
// ---------------------------------------------------------------------------
const stage1Runs = [];
const pureSaLegacyRuns = [];
const tunedSaRuns = [];
const mnLahcRuns = [];
const mnLahcEqualTimeStdRuns = [];
const mnLahcEqualTimeEquityRuns = [];
const stage4StudentRuns = [];
const stage4EquityRuns = [];
const mnLahcSnapshots = new Map();
const stage4EquitySnapshots = new Map();

for (const seed of SEEDS) {
  console.log(`[v4-GLP] Seed ${seed}: Stage1 -> 1.8s (MN-LAHC/SA) -> 10.4s Symmetric 2x2 (LAHC-Std/LAHC-Eq/S4-Std/S4-Eq)`);
  const s1 = CSPEngine.constructiveReset(baselineSessions, rooms, policy, { seed, skipStage2: true });
  stage1Runs.push(extractMetrics(s1.audit, {
    seed, stage1Ms: round2(s1.latencyMs), stage2Ms: 0, polishMs: 0, totalMs: round2(s1.latencyMs),
  }, true));

  const ha = CSPEngine.constructiveReset(baselineSessions, rooms, policy, { seed, timeBudgetMs: 3500 });
  mnLahcSnapshots.set(seed, ha);
  const haTotalMs = round2(ha.latencyMs);
  const stage2Budget = Math.max(1500, Math.round(haTotalMs - s1.latencyMs));
  mnLahcRuns.push(extractMetrics(ha.audit, {
    seed, stage1Ms: round2(s1.latencyMs), stage2Ms: round2(Math.max(0, haTotalMs - s1.latencyMs)),
    polishMs: 0, totalMs: haTotalMs, iterations: ha.metaheuristic.iterations,
  }, true));

  const legacySa = runSAOnSeed(saCtx, s1, seed, stage2Budget, policy, 'LEGACY_2OP');
  pureSaLegacyRuns.push(extractMetrics(legacySa.audit, {
    seed, stage1Ms: round2(s1.latencyMs), stage2Ms: legacySa.stage2Ms, polishMs: 0,
    totalMs: round2(s1.latencyMs + legacySa.stage2Ms), iterations: legacySa.iterations,
  }, true));

  const tunedSa = runSAOnSeed(saCtx, s1, seed, stage2Budget, policy, 'TUNED_MULTIOP_REHEAT');
  tunedSaRuns.push(extractMetrics(tunedSa.audit, {
    seed, stage1Ms: round2(s1.latencyMs), stage2Ms: tunedSa.stage2Ms, polishMs: 0,
    totalMs: round2(s1.latencyMs + tunedSa.stage2Ms), iterations: tunedSa.iterations, reheats: tunedSa.reheats,
  }, true));

  // True 10.4 s Equal-Time Control (Student-Focused w_lec = 95, maxIters uncapped at 5M)
  const ha10Std = CSPEngine.constructiveReset(baselineSessions, rooms, policy, {
    seed,
    maxIters: 5000000,
    timeBudgetMs: 10200,
    lecturerIsolatedWeight: 95,
  });
  mnLahcEqualTimeStdRuns.push(extractMetrics(ha10Std.audit, {
    seed, stage1Ms: round2(s1.latencyMs), stage2Ms: round2(Math.max(0, ha10Std.latencyMs - s1.latencyMs)),
    polishMs: 0, totalMs: round2(ha10Std.latencyMs), iterations: ha10Std.metaheuristic.iterations,
  }, true));

  // True 10.4 s Symmetric Equity-Aware Control (w_lec = 300 — identical equity weight to Stage-4 Equity!)
  const ha10Eq = CSPEngine.constructiveReset(baselineSessions, rooms, policy, {
    seed,
    maxIters: 5000000,
    timeBudgetMs: 10200,
    lecturerIsolatedWeight: 300,
  });
  mnLahcEqualTimeEquityRuns.push(extractMetrics(ha10Eq.audit, {
    seed, stage1Ms: round2(s1.latencyMs), stage2Ms: round2(Math.max(0, ha10Eq.latencyMs - s1.latencyMs)),
    polishMs: 0, totalMs: round2(ha10Eq.latencyMs), iterations: ha10Eq.metaheuristic.iterations,
  }, true));

  // Stage-4 Student-Only (2 x 3000ms = ~10.2s total, w_lec=0.35 — exposes Goodhart trade-off!)
  const s4Std = runStage4Polish(ha, seed, policy, 2, 3000, 0.35);
  stage4StudentRuns.push(extractMetrics(s4Std.res.audit, {
    seed, stage1Ms: round2(s1.latencyMs), stage2Ms: round2(Math.max(0, haTotalMs - s1.latencyMs)),
    polishMs: s4Std.polishMs, totalMs: round2(haTotalMs + s4Std.polishMs), polishIters: s4Std.polishIters,
  }, true));

  // Stage-4 Equity-Aware (2 x 3000ms = ~10.4s total, w_lec=300 — symmetric with MN-LAHC-Equity 10.4s!)
  const s4Eq = runStage4Polish(ha, seed, policy, 2, 3000, 300);
  stage4EquitySnapshots.set(seed, s4Eq.res);
  stage4EquityRuns.push(extractMetrics(s4Eq.res.audit, {
    seed, stage1Ms: round2(s1.latencyMs), stage2Ms: round2(Math.max(0, haTotalMs - s1.latencyMs)),
    polishMs: s4Eq.polishMs, totalMs: round2(haTotalMs + s4Eq.polishMs), polishIters: s4Eq.polishIters,
  }, true));
}

// ---------------------------------------------------------------------------
// PART 2: Split-Seed TPE Ablation (Tune [11..42], Evaluate on Held-Out [55..99])
// Directly compares TPE+Stage4-Eq vs Stage4-Eq(No TPE) on identical held-out seeds & 2 rounds!
// ---------------------------------------------------------------------------
console.log('[v3-GLP] Running Split-Seed TPE Validation (tune=[11..42], test=[55..99])...');
const splitTpe = runCleanTpeSearch(TUNING_SEEDS, 10, 20261126, policy, 2000);
const frozenParams = splitTpe.bestTrial.params;
const heldOutDefaultRuns = [];
const heldOutS4EqNoTpeRuns = [];
const heldOutTpeNoS4Runs = [];
const heldOutTpePlusS4EqRuns = [];

for (const seed of HELD_OUT_SEEDS) {
  const defRes = mnLahcSnapshots.get(seed);
  heldOutDefaultRuns.push(extractMetrics(defRes.audit, { seed, totalMs: round2(defRes.latencyMs) }, true));
  const eqDef = stage4EquityRuns.find((r) => r.seed === seed);
  heldOutS4EqNoTpeRuns.push(eqDef);

  const tpeRes = CSPEngine.constructiveReset(baselineSessions, rooms, policy, {
    seed, timeBudgetMs: 3500, hyperparams: frozenParams,
  });
  heldOutTpeNoS4Runs.push(extractMetrics(tpeRes.audit, { seed, totalMs: round2(tpeRes.latencyMs) }, true));

  const tpeS4 = runStage4Polish(tpeRes, seed, policy, 2, 3000, 300);
  heldOutTpePlusS4EqRuns.push(extractMetrics(tpeS4.res.audit, {
    seed, polishMs: tpeS4.polishMs, totalMs: round2(tpeRes.latencyMs + tpeS4.polishMs),
  }, true));
}

// Also evaluate Frozen-TPE + Stage-4 Equity across ALL 10 seeds (n=10 matched polish rounds = 2 x 3000ms)
const tpePlusS4Eq10Runs = [];
for (const seed of SEEDS) {
  const tpeRes = CSPEngine.constructiveReset(baselineSessions, rooms, policy, {
    seed, timeBudgetMs: 3500, hyperparams: frozenParams,
  });
  const tpeS4 = runStage4Polish(tpeRes, seed, policy, 2, 3000, 300);
  tpePlusS4Eq10Runs.push(extractMetrics(tpeS4.res.audit, {
    seed, tpeSearchMs: splitTpe.tpeSearchMs, polishMs: tpeS4.polishMs,
    totalMs: round2(tpeRes.latencyMs + tpeS4.polishMs),
  }, true));
}

// ---------------------------------------------------------------------------
// PART 3: Policy & Cultural Sensitivity (Mode A Legal 47 Room-Days + 3-Way Friday Prayer, n=10)
// ---------------------------------------------------------------------------
console.log('[v3-GLP] Running Mode A (Strict 47 rd) & 3-Way Friday Prayer Sensitivity (n=10)...');
const strict47Policy = { ...policy, allowDryLabOverflow: false };
const modeALahcRuns = [];
const modeAEquityRuns = [];
const fridayUniformRuns = [];
const fridaySoftRuns = [];
const fridayHardRuns = [];

for (const seed of SEEDS) {
  const rA = CSPEngine.constructiveReset(baselineSessions, rooms, strict47Policy, { seed, timeBudgetMs: 3500 });
  modeALahcRuns.push(extractMetrics(rA.audit, { seed, totalMs: round2(rA.latencyMs) }, true));
  const rAEq = runStage4Polish(rA, seed, strict47Policy, 2, 3000, 300);
  modeAEquityRuns.push(extractMetrics(rAEq.res.audit, {
    seed, polishMs: rAEq.polishMs, totalMs: round2(rA.latencyMs + rAEq.polishMs),
  }, true));

  const rUnif = CSPEngine.constructiveReset(baselineSessions, rooms, {
    ...policy, protectFridayPrayer: false, hardFridayPrayer: false,
  }, { seed, timeBudgetMs: 3500 });
  fridayUniformRuns.push(extractMetrics(rUnif.audit, { seed, totalMs: round2(rUnif.latencyMs) }, false));

  const rSoft = CSPEngine.constructiveReset(baselineSessions, rooms, {
    ...policy, protectFridayPrayer: true, hardFridayPrayer: false,
  }, { seed, timeBudgetMs: 3500 });
  fridaySoftRuns.push(extractMetrics(rSoft.audit, { seed, totalMs: round2(rSoft.latencyMs) }, false));

  fridayHardRuns.push(mnLahcRuns.find((r) => r.seed === seed));
}

// ---------------------------------------------------------------------------
// PART 4: Strictly Audited Dynamic Repair (N=100 on BOTH MN-LAHC & Dense Stage-4 Equity + First-Attempt 10x5 Chains)
// ---------------------------------------------------------------------------
console.log('[v3-GLP] Running Strictly Audited Dynamic Repair (N=100 on MN-LAHC & Dense Stage-4 Equity)...');
const samplePinIds = ['S002', 'S015', 'S085', 'S165', 'S220']; // 5 synthetic doctoral pins (baseline JSON has 0 pins)

function runDynamicBenchmarkSuite(baseSessionsRaw, suiteLabel, rngSeed) {
  const dynBase = CSPEngine.cloneSessions(baseSessionsRaw);
  for (const pid of samplePinIds) {
    const s = dynBase.find((x) => x.id === pid);
    if (s) { s.pinned = true; s.pinReason = 'Synthetic Doctoral Study Pin'; }
  }

  function runWarmStart(targetSess, chosenSlot, directBlockerIds, seedVal) {
    const t0 = performance.now();
    const working = CSPEngine.cloneSessions(dynBase);
    const targetObj = working.find((x) => x.id === targetSess.id);
    const relatedClasses = new Set(targetObj.classes);
    for (const bid of directBlockerIds) {
      const bObj = working.find((x) => x.id === bid);
      if (bObj) for (const c of bObj.classes) relatedClasses.add(c);
    }
    for (const s of working) {
      if (s.id === targetObj.id) continue;
      const isBlocker = directBlockerIds.includes(s.id);
      const sameClass = s.classes.some((c) => relatedClasses.has(c));
      const sameRoom = s.room === chosenSlot.room || s.room === targetObj.room;
      const sameDayTarget = s.day === chosenSlot.day;
      if (!isBlocker && !sameClass && !(sameRoom && sameDayTarget)) s.pinned = true;
    }
    targetObj.day = chosenSlot.day;
    targetObj.start = chosenSlot.start;
    targetObj.end = chosenSlot.start + targetObj.duration;
    targetObj.room = chosenSlot.room;
    targetObj.pinned = true;

    const res = CSPEngine.constructiveReset(working, rooms, policy, {
      seed: seedVal, timeBudgetMs: 650, maxIters: 6000,
    });
    let perturbed = 0;
    for (let i = 0; i < dynBase.length; i++) {
      const a = dynBase[i], b = res.sessions[i];
      if (a.id === targetObj.id) continue;
      if (a.day !== b.day || a.start !== b.start || a.room !== b.room) perturbed++;
    }
    const auditedFeas = isHardFeasible(res.audit, true);
    return { feasible: auditedFeas, perturbed, humaneScore: res.audit.gatedHumaneScore, latencyMs: round2(performance.now() - t0) };
  }

  const dynRng = makeCleanSeededRng(rngSeed);
  const unpinnedPool = dynBase.filter((s) => !s.pinned);
  const dynTrials = [];
  const warmStartTrials = [];
  const staticTrials = [];
  const failureLog = [];
  const evalLatencies = [];

  let conflictCount = 0;
  let safeCount = 0;
  let attempts = 0;
  let silentAuditFailures = 0;

  while ((conflictCount < 60 || safeCount < 40) && attempts < 900) {
    attempts++;
    const s = unpinnedPool[Math.floor(dynRng() * unpinnedPool.length)];
    const ev = CSPEngine.evaluateCandidateSlots(dynBase, s.id, rooms, policy);
    const repairables = ev.slots.filter((sl) => sl.status === 'REPAIRABLE' && !sl.isCurrent);
    const safes = ev.slots.filter((sl) => sl.status === 'SAFE' && !sl.isCurrent);

    let chosen = null;
    let scenarioType = null;
    if (conflictCount < 60 && repairables.length > 0 && (safeCount >= 40 || dynRng() < 0.65)) {
      chosen = repairables[Math.floor(dynRng() * repairables.length)];
      scenarioType = 'CONFLICT_REPAIR';
      conflictCount++;
    } else if (safeCount < 40 && safes.length > 0) {
      chosen = safes[Math.floor(dynRng() * safes.length)];
      scenarioType = 'SAFE_DROP';
      safeCount++;
    } else {
      continue;
    }

    evalLatencies.push(ev.latencyMs);
    const dyn = CSPEngine.planMinimalRepair(dynBase, s.id, chosen.day, chosen.start, chosen.room, rooms, policy);

    // INDEPENDENT AUDIT GATE ON EVERY SINGLE TRIAL!
    let verifiedFeasible = false;
    let pinsPreserved = true;
    if (dyn.feasible) {
      const postAudit = CSPEngine.auditSchedule(dyn.sessions, policy);
      verifiedFeasible = isHardFeasible(postAudit, true);
      if (!verifiedFeasible) silentAuditFailures++;
      for (const pid of samplePinIds) {
        const bp = dynBase.find((x) => x.id === pid);
        const ap = dyn.sessions.find((x) => x.id === pid);
        if (bp.day !== ap.day || bp.start !== ap.start || bp.room !== ap.room) pinsPreserved = false;
      }
    }
    if (!verifiedFeasible) {
      failureLog.push({
        trial: dynTrials.length + 1,
        sessionId: s.id,
        duration: s.duration,
        isWetLab: s.isWetLab,
        scenarioType,
        blockerCount: chosen.blockerCount,
        reason: dyn.reason || 'Post-audit hard-feasibility failure',
        latencyMs: dyn.latencyMs,
      });
    }

    dynTrials.push({
      trial: dynTrials.length + 1,
      sessionId: s.id,
      scenarioType,
      feasible: verifiedFeasible,
      strategy: verifiedFeasible ? dyn.strategy : 'FAILED',
      perturbationCount: verifiedFeasible ? dyn.perturbationCount : null,
      latencyMs: dyn.latencyMs,
      pinsPreserved,
    });

    if (scenarioType === 'CONFLICT_REPAIR') {
      const ws = runWarmStart(s, chosen, chosen.blockerIds || [], 300 + warmStartTrials.length);
      warmStartTrials.push({ trial: dynTrials.length, sessionId: s.id, ...ws });

      if (staticTrials.length < 20) {
        const pinnedForStatic = CSPEngine.cloneSessions(dynBase);
        const tObj = pinnedForStatic.find((x) => x.id === s.id);
        tObj.day = chosen.day; tObj.start = chosen.start; tObj.end = chosen.start + tObj.duration; tObj.room = chosen.room; tObj.pinned = true;
        const stRes = CSPEngine.constructiveReset(pinnedForStatic, rooms, policy, { seed: 100 + staticTrials.length, timeBudgetMs: 900 });
        let otherChanged = 0;
        for (let i = 0; i < dynBase.length; i++) {
          const a = dynBase[i], b = stRes.sessions[i];
          if (a.id === s.id) continue;
          if (a.day !== b.day || a.start !== b.start || a.room !== b.room) otherChanged++;
        }
        staticTrials.push({
          trial: dynTrials.length,
          feasible: isHardFeasible(stRes.audit, true),
          otherPerturbed: otherChanged,
          perturbationPct: round2((otherChanged / (dynBase.length - 1)) * 100),
          latencyMs: round2(stRes.latencyMs),
        });
      }
    }
  }

  // First-attempt 10 x 5 sequential chains (ZERO hidden retries, strict post-step audit!)
  const chainRng = makeCleanSeededRng(rngSeed + 98);
  const chains = [];
  for (let c = 0; c < 10; c++) {
    let sched = CSPEngine.cloneSessions(dynBase);
    const movedIds = new Set();
    let stepsSucceeded = 0;
    let totalPerturbed = 0;
    let totalLatency = 0;
    for (let step = 0; step < 5; step++) {
      const pool = sched.filter((x) => !x.pinned && !movedIds.has(x.id));
      const target = pool[Math.floor(chainRng() * pool.length)];
      const ev = CSPEngine.evaluateCandidateSlots(sched, target.id, rooms, policy);
      const cands = ev.slots.filter((sl) => (sl.status === 'REPAIRABLE' || sl.status === 'SAFE') && !sl.isCurrent);
      if (cands.length === 0) break;
      const chosen = cands[Math.floor(chainRng() * cands.length)];
      const res = CSPEngine.planMinimalRepair(sched, target.id, chosen.day, chosen.start, chosen.room, rooms, policy);
      totalLatency += res.latencyMs;
      if (res.feasible && isHardFeasible(CSPEngine.auditSchedule(res.sessions, policy), true)) {
        sched = res.sessions;
        movedIds.add(target.id);
        totalPerturbed += res.perturbationCount;
        stepsSucceeded++;
      } else {
        break;
      }
    }
    const endAudit = CSPEngine.auditSchedule(sched, policy);
    const finalFeasible = isHardFeasible(endAudit, true);
    chains.push({
      chainId: c + 1,
      stepsSucceeded,
      all5Completed: stepsSucceeded === 5 && finalFeasible,
      totalSecondaryPerturbed: totalPerturbed,
      totalLatencyMs: round2(totalLatency),
      finalGatedHumaneScore: finalFeasible ? endAudit.gatedHumaneScore : 0,
      finalFeasible,
    });
  }

  const dynFeasible = dynTrials.filter((x) => x.feasible);
  const dynConf = dynTrials.filter((x) => x.scenarioType === 'CONFLICT_REPAIR');
  const dynConfFeasible = dynConf.filter((x) => x.feasible);
  const wsFeasible = warmStartTrials.filter((x) => x.feasible);

  // Explicit 2x2 contingency table on conflict trials
  let bothFeasible = 0, repairOnly = 0, wsOnly = 0, neither = 0;
  for (let i = 0; i < dynConf.length; i++) {
    const df = dynConf[i].feasible, wf = warmStartTrials[i].feasible;
    if (df && wf) bothFeasible++;
    else if (df && !wf) repairOnly++;
    else if (!df && wf) wsOnly++;
    else neither++;
  }

  return {
    baseScheduleLabel: suiteLabel,
    baseGatedHumaneScore: CSPEngine.auditSchedule(dynBase, policy).gatedHumaneScore,
    syntheticPinCount: samplePinIds.length,
    silentAuditFailures,
    contingency2x2: { bothFeasible, repairOnly, wsOnly, neither },
    singleEditSummary: {
      totalValidTrials: dynTrials.length,
      conflictRepairTrials: dynConf.length,
      safeDropTrials: dynTrials.length - dynConf.length,
      overallSuccessRatePct: round2((dynFeasible.length / dynTrials.length) * 100),
      conflictRepairSuccessRatePct: round2((dynConfFeasible.length / dynConf.length) * 100),
      failureCount: failureLog.length,
      allPinsPreservedPct: dynFeasible.length ? round2((dynFeasible.filter((x) => x.pinsPreserved).length / dynFeasible.length) * 100) : 100,
      meanSlotEvalLatencyMs: round2(mean(evalLatencies)),
      meanLatencyAllTrialsMs: round2(mean(dynTrials.map((x) => x.latencyMs))),
      meanPerturbationAllSuccess: round2(mean(dynFeasible.map((x) => x.perturbationCount))),
      meanPerturbationConflictSuccess: round2(mean(dynConfFeasible.map((x) => x.perturbationCount))),
      sdPerturbationConflictSuccess: round2(sampleStd(dynConfFeasible.map((x) => x.perturbationCount))),
      maxPerturbationObserved: Math.max(...dynFeasible.map((x) => x.perturbationCount), 0),
      strategies: {
        DIRECT_SAFE: dynFeasible.filter((x) => x.strategy === 'DIRECT_SAFE').length,
        LOCAL_1_STEP: dynFeasible.filter((x) => x.strategy === 'LOCAL_1_STEP').length,
        EJECTION_2_STEP: dynFeasible.filter((x) => x.strategy === 'KEMPE_2_STEP').length,
        FAILED: failureLog.length,
      },
    },
    warmStartConflictBaseline: {
      trials: warmStartTrials.length,
      feasibleRatePct: round2((wsFeasible.length / warmStartTrials.length) * 100),
      meanPerturbedAllFeasible: round2(mean(wsFeasible.map((x) => x.perturbed))),
      sdPerturbedAllFeasible: round2(sampleStd(wsFeasible.map((x) => x.perturbed))),
      medianPerturbed: round2(median(wsFeasible.map((x) => x.perturbed))),
      meanLatencyMs: round2(mean(warmStartTrials.map((x) => x.latencyMs))),
      meanGatedHumaneScore: round2(mean(wsFeasible.map((x) => x.humaneScore))),
    },
    staticFullResolveReference: {
      trials: staticTrials.length,
      feasibleRatePct: round2((staticTrials.filter((x) => x.feasible).length / staticTrials.length) * 100),
      meanPerturbed: round2(mean(staticTrials.map((x) => x.otherPerturbed))),
      meanPerturbationPct: round2(mean(staticTrials.map((x) => x.perturbationPct))),
      meanLatencyMs: round2(mean(staticTrials.map((x) => x.latencyMs))),
    },
    failureLog,
    dynConflictTrials: dynConf,
    warmStartTrials,
    sequentialChainsSummary: {
      chainsCount: chains.length,
      stepsPerChain: 5,
      zeroHiddenRetries: true,
      fullChainCompletionRatePct: round2((chains.filter((x) => x.all5Completed).length / chains.length) * 100),
      totalStepsSucceeded: chains.reduce((a, x) => a + x.stepsSucceeded, 0),
      meanSecondaryPerturbedPerChain: round2(mean(chains.map((x) => x.totalSecondaryPerturbed))),
      meanChainLatencyMs: round2(mean(chains.map((x) => x.totalLatencyMs))),
      meanFinalGatedHumaneScore: round2(mean(chains.map((x) => x.finalGatedHumaneScore))),
      chains,
    },
  };
}

// Run Dynamic Repair on BOTH Dense Stage-4 Equity (Seed 42 — recommended deployment schedule!) AND MN-LAHC (Seed 42)
const dynStage4Equity = runDynamicBenchmarkSuite(stage4EquitySnapshots.get(42).sessions, 'Stage4_EquityAware_Seed42', 2026112601);
const dynMnLahc = runDynamicBenchmarkSuite(mnLahcSnapshots.get(42).sessions, 'MN_LAHC_Seed42', 2026112601);

// ---------------------------------------------------------------------------
// PART 5: UAS Exam Quality Audit (0 Friday Prayer & 0 ISHOMA) vs Greedy First-Fit & Greedy Load-Balanced
// ---------------------------------------------------------------------------
function evaluateUasQuality(uasResult) {
  const exams = uasResult.exams;
  const byClassDay = new Map();
  const byClassDaysList = new Map();
  const dayNames = ['Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat'];

  for (const ex of exams) {
    const absDayIdx = (ex.week - 1) * 5 + dayNames.indexOf(ex.day);
    for (const c of ex.classes) {
      const dk = `${ex.dayKey}|${c}`;
      if (!byClassDay.has(dk)) byClassDay.set(dk, []);
      byClassDay.get(dk).push(ex.slotIdx);
      if (!byClassDaysList.has(c)) byClassDaysList.set(c, []);
      byClassDaysList.get(c).push(absDayIdx);
    }
  }

  let backToBackPairs = 0;
  for (const slots of byClassDay.values()) {
    if (slots.length < 2) continue;
    slots.sort((a, b) => a - b);
    for (let i = 1; i < slots.length; i++) if (slots[i] - slots[i - 1] === 1) backToBackPairs++;
  }

  const classMeanGaps = [];
  for (const days of byClassDaysList.values()) {
    if (days.length < 2) continue;
    days.sort((a, b) => a - b);
    let sumGap = 0;
    for (let i = 1; i < days.length; i++) sumGap += days[i] - days[i - 1];
    classMeanGaps.push(sumGap / (days.length - 1));
  }

  const fridayPrayerViolations = exams.filter((e) => e.day === 'Jumat' && e.start < 780 && e.end > 690).length;
  const ishomaViolations = exams.filter((e) => e.start < 780 && e.end > 720).length;
  const pctStartsAtOrAfter0840 = exams.length
    ? round2((exams.filter((e) => e.start >= 520).length / exams.length) * 100)
    : 0;

  return {
    durationMin: uasResult.durationMin,
    totalExamCourses: uasResult.totalExamCourses,
    scheduledCount: uasResult.scheduledCount,
    unplacedCount: uasResult.unplacedCount,
    conflicts: uasResult.conflicts,
    fridayPrayerViolations,
    ishomaViolations,
    maxObservedPerDay: uasResult.maxObservedPerDay,
    daysUsed: uasResult.daysUsed,
    sameDayBackToBackPairs: backToBackPairs,
    meanInterExamGapDays: round2(mean(classMeanGaps)),
    pctStartsAtOrAfter0840,
    latencyMs: uasResult.latencyMs,
  };
}

function generateBaselineUas(durationMin, mode = 'FIRST_FIT') {
  const t0 = performance.now();
  const examSlots = durationMin === 60
    ? [
        { idx: 0, start: 520, end: 580 },
        { idx: 1, start: 600, end: 660 },
        { idx: 2, start: 780, end: 840 },
        { idx: 3, start: 860, end: 920 },
        { idx: 4, start: 940, end: 1000 },
      ]
    : [
        { idx: 0, start: 520, end: 620 },
        { idx: 1, start: 620, end: 720 },
        { idx: 2, start: 780, end: 880 },
        { idx: 3, start: 890, end: 990 },
      ];
  const examDays = [];
  for (let w = 1; w <= 2; w++) {
    for (const d of CSPEngine.DAYS) {
      examDays.push({ key: `M${w}-${d}`, week: w, day: d, isPascaOpen: ['Senin', 'Selasa', 'Rabu'].includes(d) });
    }
  }
  const examRooms = rooms.filter((r) => r.type === 'PASCA' || r.type === 'SAINTEK');
  const examCourses = baselineSessions.filter((s) => s.isExamEligible !== false && !/^Praktikum\s+/i.test(s.namaMk));
  const roomBusy = new Set(), lecBusy = new Set(), clsSlotBusy = new Set();
  const clsDayCount = new Map(), dayLoad = new Map();
  const placed = [];
  let unplaced = 0;

  for (const course of examCourses) {
    const dayOrder = mode === 'DAY_BALANCED'
      ? [...examDays].sort((a, b) => (dayLoad.get(a.key) || 0) - (dayLoad.get(b.key) || 0))
      : examDays;
    let ok = false;
    outer: for (const ed of dayOrder) {
      for (const c of course.classes) if ((clsDayCount.get(`${ed.key}|${c}`) || 0) >= 2) continue outer;
      const availRooms = examRooms.filter((r) => ed.isPascaOpen || r.type !== 'PASCA');
      for (const sl of examSlots) {
        if (ed.day === 'Jumat' && sl.start < 780 && sl.end > 690) continue;
        if (course.dosen && lecBusy.has(`${ed.key}|${sl.idx}|${course.dosen}`)) continue;
        if (course.classes.some((c) => clsSlotBusy.has(`${ed.key}|${sl.idx}|${c}`))) continue;
        for (const rm of availRooms) {
          if (roomBusy.has(`${ed.key}|${sl.idx}|${rm.name}`)) continue;
          roomBusy.add(`${ed.key}|${sl.idx}|${rm.name}`);
          if (course.dosen) lecBusy.add(`${ed.key}|${sl.idx}|${course.dosen}`);
          for (const c of course.classes) {
            clsSlotBusy.add(`${ed.key}|${sl.idx}|${c}`);
            clsDayCount.set(`${ed.key}|${c}`, (clsDayCount.get(`${ed.key}|${c}`) || 0) + 1);
          }
          dayLoad.set(ed.key, (dayLoad.get(ed.key) || 0) + 1);
          placed.push({ week: ed.week, day: ed.day, dayKey: ed.key, slotIdx: sl.idx, start: sl.start, end: sl.end, classes: course.classes });
          ok = true;
          break outer;
        }
      }
    }
    if (!ok) unplaced++;
  }
  let maxObs = 0;
  for (const v of clsDayCount.values()) if (v > maxObs) maxObs = v;
  return {
    durationMin, totalExamCourses: examCourses.length, scheduledCount: placed.length,
    unplacedCount: unplaced, conflicts: 0, maxObservedPerDay: maxObs,
    daysUsed: new Set(placed.map((e) => e.dayKey)).size, exams: placed,
    latencyMs: round2(performance.now() - t0),
  };
}

const uasProposed100 = evaluateUasQuality(CSPEngine.generateUasSchedule(baselineSessions, rooms, { durationMin: 100, maxExamsPerDay: 2, enforcePascaMonWed: true }));
const uasProposed60 = evaluateUasQuality(CSPEngine.generateUasSchedule(baselineSessions, rooms, { durationMin: 60, maxExamsPerDay: 2, enforcePascaMonWed: true }));
const uasGreedy100 = evaluateUasQuality(generateBaselineUas(100, 'FIRST_FIT'));
const uasGreedy60 = evaluateUasQuality(generateBaselineUas(60, 'FIRST_FIT'));
const uasBalanced100 = evaluateUasQuality(generateBaselineUas(100, 'DAY_BALANCED'));
const uasBalanced60 = evaluateUasQuality(generateBaselineUas(60, 'DAY_BALANCED'));

// Track 1: Auto-Fix on manual operational baseline
const afConflictsOnly = CSPEngine.autoFixAllConflicts(baselineSessions, rooms, policy, { fixPoliciesToo: false });
const afWithPolicies = CSPEngine.autoFixAllConflicts(baselineSessions, rooms, policy, { fixPoliciesToo: true });

const output = {
  generatedAt: new Date().toISOString(),
  protocol: 'GLP Equal-Time Controlled Ablation (n=10 paired seeds, Hard Friday Prayer 11:30-13:00 default)',
  environment: { nodeVersion: process.version, platform: process.platform, arch: process.arch },
  seeds: SEEDS,
  baselineManual: extractMetrics(CSPEngine.auditSchedule(baselineSessions, policy), {}, true),
  exp1AutoFix: {
    conflictsOnly: {
      feasible: afConflictsOnly.feasible,
      perturbationCount: afConflictsOnly.perturbationCount,
      latencyMs: afConflictsOnly.latencyMs,
      hardConflictsAfter: afConflictsOnly.audit.hardConflictCount,
    },
    withPolicies: {
      feasible: afWithPolicies.feasible,
      perturbationCount: afWithPolicies.perturbationCount,
      latencyMs: afWithPolicies.latencyMs,
      hardConflictsAfter: afWithPolicies.audit.hardConflictCount,
      pascaViolationsAfter: afWithPolicies.audit.pascaViolationCount,
      asprakDeadlocksAfter: afWithPolicies.audit.asprakDeadlockCount,
    },
  },
  constructiveAndAblation: {
    Stage1_DSATUR: { summary: summarizeRuns(stage1Runs), runs: stage1Runs },
    PureSA_2Op: { summary: summarizeRuns(pureSaLegacyRuns), runs: pureSaLegacyRuns },
    TunedSA_4Op_FixedReheat: { summary: summarizeRuns(tunedSaRuns), runs: tunedSaRuns },
    MN_LAHC_1_8s: { summary: summarizeRuns(mnLahcRuns), runs: mnLahcRuns },
    MN_LAHC_Std_10_4s: { summary: summarizeRuns(mnLahcEqualTimeStdRuns), runs: mnLahcEqualTimeStdRuns },
    MN_LAHC_Equity_10_4s: { summary: summarizeRuns(mnLahcEqualTimeEquityRuns), runs: mnLahcEqualTimeEquityRuns },
    Stage4_StudentOnly_10s: { summary: summarizeRuns(stage4StudentRuns), runs: stage4StudentRuns },
    Stage4_EquityAware_10s: { summary: summarizeRuns(stage4EquityRuns), runs: stage4EquityRuns },
    TPE_Stage4_Equity_n10: { summary: summarizeRuns(tpePlusS4Eq10Runs), runs: tpePlusS4Eq10Runs },
  },
  splitSeedTpeValidation: {
    tuningSeeds: TUNING_SEEDS,
    heldOutSeeds: HELD_OUT_SEEDS,
    tpeSearchMs: splitTpe.tpeSearchMs,
    winningTrial: splitTpe.bestTrial,
    heldOutDefault: { summary: summarizeRuns(heldOutDefaultRuns), runs: heldOutDefaultRuns },
    heldOutStage4EquityNoTpe: { summary: summarizeRuns(heldOutS4EqNoTpeRuns), runs: heldOutS4EqNoTpeRuns },
    heldOutTpeNoStage4: { summary: summarizeRuns(heldOutTpeNoS4Runs), runs: heldOutTpeNoS4Runs },
    heldOutTpePlusStage4Equity: { summary: summarizeRuns(heldOutTpePlusS4EqRuns), runs: heldOutTpePlusS4EqRuns },
  },
  policySensitivity: {
    modeA_Strict47_LAHC: { summary: summarizeRuns(modeALahcRuns), runs: modeALahcRuns },
    modeA_Strict47_Equity: { summary: summarizeRuns(modeAEquityRuns), runs: modeAEquityRuns },
    fridayPrayer3Way: {
      seeds: SEEDS,
      uniformBreak12to13: { summary: summarizeRuns(fridayUniformRuns), runs: fridayUniformRuns },
      softPenalty1130to1300: { summary: summarizeRuns(fridaySoftRuns), runs: fridaySoftRuns },
      hardExclusion1130to1300: { summary: summarizeRuns(fridayHardRuns), runs: fridayHardRuns },
    },
  },
  dynamicRescheduling: {
    onDenseStage4Equity: dynStage4Equity,
    onMnLahc: dynMnLahc,
  },
  uasEvaluation: {
    proposed100m: uasProposed100,
    greedyFirstFit100m: uasGreedy100,
    greedyBalanced100m: uasBalanced100,
    proposed60m: uasProposed60,
    greedyFirstFit60m: uasGreedy60,
    greedyBalanced60m: uasBalanced60,
  },
};

fs.writeFileSync(OUT_PATH, JSON.stringify(output, null, 2), 'utf-8');
console.log('[v3-GLP] Completed! Saved to:', OUT_PATH);
console.table(
  Object.entries(output.constructiveAndAblation).map(([k, v]) => ({
    Method: k,
    Feas: v.summary.feasibleRatePct,
    H_gated: v.summary.mean_gatedHumaneScore,
    SD: v.summary.sd_gatedHumaneScore,
    H_bal03: v.summary.mean_balancedScore03,
    H_bal06: v.summary.mean_balancedScore06,
    LecIso: v.summary.mean_lecturerIsolatedDays,
    FriViol: v.summary.mean_fridayPrayerViolations,
    Late: v.summary.mean_lateSessions,
    ms: v.summary.mean_totalMs,
  }))
);
