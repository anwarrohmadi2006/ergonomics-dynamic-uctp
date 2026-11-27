/**
 * Paket A — A6: Scaled Audited Dynamic Repair Benchmark (N = 300 Edits, 180 Conflict-Only,
 * Wilson 95% CI, Explicit Edit Generation Protocol, Static Full Re-solve n = 60, 10x5 Chains).
 *
 * Output: experiment_v2/results/paketA_dynamic_300.json
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
const OUT_PATH = path.join(__dirname, '..', 'results', 'paketA_dynamic_300.json');

const dataset = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
const { sessions: baselineSessions, rooms } = dataset;

const policy = {
  ...CSPEngine.DEFAULT_POLICY,
  allowDryLabOverflow: true,
  protectFridayPrayer: true,
  hardFridayPrayer: true,
};

function round2(n) { return Number(n.toFixed(2)); }
function round4(n) { return Number(n.toFixed(4)); }
function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function sampleStd(arr) {
  if (arr.length <= 1) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((acc, x) => acc + (x - m) ** 2, 0) / (arr.length - 1));
}
function percentile(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
}
function wilsonCI95(k, n) {
  if (n <= 0) return [0, 0];
  const z = 1.959963984540054;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n)) / denom;
  return [round4(Math.max(0, center - half) * 100), round4(Math.min(1, center + half) * 100)];
}
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
function isHardFeasible(a) {
  return (
    a.hardConflictCount === 0 &&
    a.pascaViolationCount === 0 &&
    a.asprakDeadlockCount === 0 &&
    (a.fridayPrayerViolationCount ?? 0) === 0
  );
}

console.log('[A6-Dyn300] Building dense Stage-4 Equity base schedule (seed 42)...');
const ha42 = CSPEngine.constructiveReset(baselineSessions, rooms, policy, { seed: 42, timeBudgetMs: 3500 });
let denseBase = ha42;
for (let r = 0; r < 2; r++) {
  const nxt = CSPEngine.deepPolishSchedule(denseBase.sessions, rooms, policy, {
    seed: 42 + 101 + r * 313,
    lahcLength: 65 + r * 20,
    initTemp: 520,
    coolingRate: 0.99955,
    timeBudgetMs: 3000,
    maxIters: 420000,
    baselineForDiff: baselineSessions,
    lecturerIsolatedWeight: 300,
  });
  const mCur = denseBase.audit.gatedHumaneScore - 0.3 * denseBase.audit.lecturerIsolatedDayCount;
  const mNxt = nxt.audit.gatedHumaneScore - 0.3 * nxt.audit.lecturerIsolatedDayCount;
  if (mNxt >= mCur) denseBase = nxt;
}

const samplePinIds = ['S002', 'S015', 'S085', 'S165', 'S220'];
const dynBase = CSPEngine.cloneSessions(denseBase.sessions);
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
  return {
    feasible: isHardFeasible(res.audit),
    perturbed,
    humaneScore: res.audit.gatedHumaneScore,
    latencyMs: round2(performance.now() - t0),
  };
}

console.log('[A6-Dyn300] Running N=300 audited edits (120 safe + 180 conflict) & Static Re-solve n=60...');
const TARGET_CONFLICT = 180;
const TARGET_SAFE = 120;
const TARGET_STATIC = 60;

const dynRng = makeRng(20260721);
const unpinnedPool = dynBase.filter((s) => !s.pinned);
const dynTrials = [];
const warmStartTrials = [];
const staticTrials = [];
const evalLatencies = [];
let conflictCount = 0;
let safeCount = 0;
let attempts = 0;
let silentAuditFailures = 0;

while ((conflictCount < TARGET_CONFLICT || safeCount < TARGET_SAFE) && attempts < 4000) {
  attempts++;
  const s = unpinnedPool[Math.floor(dynRng() * unpinnedPool.length)];
  const ev = CSPEngine.evaluateCandidateSlots(dynBase, s.id, rooms, policy);
  const repairables = ev.slots.filter((sl) => sl.status === 'REPAIRABLE' && !sl.isCurrent);
  const safes = ev.slots.filter((sl) => sl.status === 'SAFE' && !sl.isCurrent);

  let chosen = null;
  let scenarioType = null;
  if (conflictCount < TARGET_CONFLICT && repairables.length > 0 && (safeCount >= TARGET_SAFE || dynRng() < 0.62)) {
    chosen = repairables[Math.floor(dynRng() * repairables.length)];
    scenarioType = 'CONFLICT_REPAIR';
    conflictCount++;
  } else if (safeCount < TARGET_SAFE && safes.length > 0) {
    chosen = safes[Math.floor(dynRng() * safes.length)];
    scenarioType = 'SAFE_DROP';
    safeCount++;
  } else {
    continue;
  }

  evalLatencies.push(ev.latencyMs);
  const dyn = CSPEngine.planMinimalRepair(dynBase, s.id, chosen.day, chosen.start, chosen.room, rooms, policy);

  let verifiedFeasible = false;
  let pinsPreserved = true;
  if (dyn.feasible) {
    const postAudit = CSPEngine.auditSchedule(dyn.sessions, policy);
    verifiedFeasible = isHardFeasible(postAudit);
    if (!verifiedFeasible) silentAuditFailures++;
    for (const pid of samplePinIds) {
      const bp = dynBase.find((x) => x.id === pid);
      const ap = dyn.sessions.find((x) => x.id === pid);
      if (bp.day !== ap.day || bp.start !== ap.start || bp.room !== ap.room) pinsPreserved = false;
    }
  }

  dynTrials.push({
    trial: dynTrials.length + 1,
    sessionId: s.id,
    scenarioType,
    blockerCount: chosen.blockerCount ?? 0,
    feasible: verifiedFeasible,
    strategy: verifiedFeasible ? dyn.strategy : 'FAILED',
    perturbationCount: verifiedFeasible ? dyn.perturbationCount : null,
    latencyMs: round2(dyn.latencyMs),
    pinsPreserved,
  });

  if (scenarioType === 'CONFLICT_REPAIR') {
    const ws = runWarmStart(s, chosen, chosen.blockerIds || [], 300 + warmStartTrials.length);
    warmStartTrials.push({ trial: dynTrials.length, sessionId: s.id, ...ws });

    if (staticTrials.length < TARGET_STATIC) {
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
        feasible: isHardFeasible(stRes.audit),
        otherPerturbed: otherChanged,
        perturbationPct: round2((otherChanged / (dynBase.length - 1)) * 100),
        latencyMs: round2(stRes.latencyMs),
      });
    }
  }
}

// 10 x 5 Zero-Retry Sequential Chains
const chainRng = makeRng(20260819);
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
    const reps = ev.slots.filter((sl) => sl.status === 'REPAIRABLE' && !sl.isCurrent);
    const sfs = ev.slots.filter((sl) => sl.status === 'SAFE' && !sl.isCurrent);
    const chosen = reps.length > 0 ? reps[Math.floor(chainRng() * reps.length)] : sfs.length > 0 ? sfs[Math.floor(chainRng() * sfs.length)] : null;
    if (!chosen) break;
    const dyn = CSPEngine.planMinimalRepair(sched, target.id, chosen.day, chosen.start, chosen.room, rooms, policy);
    totalLatency += dyn.latencyMs;
    if (dyn.feasible && isHardFeasible(CSPEngine.auditSchedule(dyn.sessions, policy))) {
      sched = dyn.sessions;
      movedIds.add(target.id);
      stepsSucceeded++;
      totalPerturbed += dyn.perturbationCount;
    } else {
      break;
    }
  }
  const finAudit = CSPEngine.auditSchedule(sched, policy);
  chains.push({
    chainId: c + 1,
    stepsSucceeded,
    all5Completed: stepsSucceeded === 5,
    totalSecondaryPerturbed: totalPerturbed,
    totalLatencyMs: round2(totalLatency),
    finalGatedHumaneScore: finAudit.gatedHumaneScore,
    finalFeasible: isHardFeasible(finAudit),
  });
}

const safeTrials = dynTrials.filter((t) => t.scenarioType === 'SAFE_DROP');
const confTrials = dynTrials.filter((t) => t.scenarioType === 'CONFLICT_REPAIR');
const confOk = confTrials.filter((t) => t.feasible);
const safeOk = safeTrials.filter((t) => t.feasible);
const wsOk = warmStartTrials.filter((t) => t.feasible);
const stOk = staticTrials.filter((t) => t.feasible);

let bothFeas = 0, ejOnly = 0, wsOnly = 0, neither = 0;
const pairedEjMoves = [], pairedWsMoves = [];
for (let i = 0; i < confTrials.length; i++) {
  const eOk = confTrials[i].feasible;
  const wOk = warmStartTrials[i].feasible;
  if (eOk && wOk) { bothFeas++; pairedEjMoves.push(confTrials[i].perturbationCount); pairedWsMoves.push(warmStartTrials[i].perturbed); }
  else if (eOk && !wOk) ejOnly++;
  else if (!eOk && wOk) wsOnly++;
  else neither++;
}

const output = {
  protocol: {
    baseSchedule: 'Dense Stage-4 Equity (seed=42, Mode B + Hard Friday Prayer 11:30-13:00)',
    baseGatedHumaneScore: denseBase.audit.gatedHumaneScore,
    baseBalanced03: denseBase.audit.balancedScore03,
    baseBalanced06: denseBase.audit.balancedScore06,
    syntheticPins: samplePinIds,
    samplingRule: 'Deterministic PRNG (seed=20260721) uniformly sampling unpinned sessions X\\Pi; for each sampled session, evaluate all policy-valid candidate slots via evaluateCandidateSlots and sample uniformly from REPAIRABLE (1-2 unpinned blockers, quota=180) or SAFE (0 blockers, quota=120). Every accepted repair passes mandatory post-repair CSPEngine.auditSchedule hard-feasibility gate.',
    totalEdits: dynTrials.length,
    safeDropQuota: TARGET_SAFE,
    conflictQuota: TARGET_CONFLICT,
    staticResolveTrials: staticTrials.length,
    silentAuditFailures,
  },
  conflictOnlySummary: {
    nConflict: confTrials.length,
    ejectionFeasibleCount: confOk.length,
    ejectionFeasiblePct: round2((confOk.length / confTrials.length) * 100),
    ejectionWilsonCI95Pct: wilsonCI95(confOk.length, confTrials.length),
    ejectionMeanMovesAllFeas: round2(mean(confOk.map((x) => x.perturbationCount))),
    ejectionSdMovesAllFeas: round2(sampleStd(confOk.map((x) => x.perturbationCount))),
    ejectionMeanLatencyMs: round2(mean(confTrials.map((x) => x.latencyMs))),
    ejectionSdLatencyMs: round2(sampleStd(confTrials.map((x) => x.latencyMs))),
    ejectionMedianLatencyMs: round2(percentile(confTrials.map((x) => x.latencyMs), 50)),
    ejectionP95LatencyMs: round2(percentile(confTrials.map((x) => x.latencyMs), 95)),
    warmStartFeasibleCount: wsOk.length,
    warmStartFeasiblePct: round2((wsOk.length / warmStartTrials.length) * 100),
    warmStartWilsonCI95Pct: wilsonCI95(wsOk.length, warmStartTrials.length),
    warmStartMeanLatencyMs: round2(mean(warmStartTrials.map((x) => x.latencyMs))),
    warmStartSdLatencyMs: round2(sampleStd(warmStartTrials.map((x) => x.latencyMs))),
    contingency2x2: { bothFeasible: bothFeas, ejectionOnly: ejOnly, warmStartOnly: wsOnly, neitherFeasible: neither },
    pairedMutuallyFeasibleN: bothFeas,
    pairedEjectionMeanMoves: round2(mean(pairedEjMoves)),
    pairedEjectionSdMoves: round2(sampleStd(pairedEjMoves)),
    pairedWarmStartMeanMoves: round2(mean(pairedWsMoves)),
    pairedWarmStartSdMoves: round2(sampleStd(pairedWsMoves)),
    strategies: {
      LOCAL_1_STEP: confTrials.filter((x) => x.strategy === 'LOCAL_1_STEP').length,
      EJECTION_2_STEP: confTrials.filter((x) => x.strategy === 'EJECTION_2_STEP').length,
      FAILED: confTrials.filter((x) => x.strategy === 'FAILED').length,
    },
  },
  safeDropSummary: {
    nSafe: safeTrials.length,
    feasibleCount: safeOk.length,
    feasiblePct: round2((safeOk.length / safeTrials.length) * 100),
    wilsonCI95Pct: wilsonCI95(safeOk.length, safeTrials.length),
    meanLatencyMs: round2(mean(safeTrials.map((x) => x.latencyMs))),
    meanSlotEvalMs: round2(mean(evalLatencies)),
  },
  combinedAll300Summary: {
    totalEdits: dynTrials.length,
    feasibleCount: confOk.length + safeOk.length,
    feasiblePct: round2(((confOk.length + safeOk.length) / dynTrials.length) * 100),
    wilsonCI95Pct: wilsonCI95(confOk.length + safeOk.length, dynTrials.length),
    meanLatencyMs: round2(mean(dynTrials.map((x) => x.latencyMs))),
    allPinsPreservedPct: round2((dynTrials.filter((x) => x.pinsPreserved).length / dynTrials.length) * 100),
  },
  staticFullResolveSummary: {
    n: staticTrials.length,
    feasibleCount: stOk.length,
    feasiblePct: round2((stOk.length / staticTrials.length) * 100),
    wilsonCI95Pct: wilsonCI95(stOk.length, staticTrials.length),
    meanPerturbed: round2(mean(stOk.map((x) => x.otherPerturbed))),
    sdPerturbed: round2(sampleStd(stOk.map((x) => x.otherPerturbed))),
    meanPerturbationPct: round2(mean(stOk.map((x) => x.perturbationPct))),
    meanLatencyMs: round2(mean(stOk.map((x) => x.latencyMs))),
    sdLatencyMs: round2(sampleStd(stOk.map((x) => x.latencyMs))),
  },
  sequentialChains10x5: {
    chainsCount: chains.length,
    fullChainCompletionPct: round2((chains.filter((x) => x.all5Completed).length / chains.length) * 100),
    totalStepsSucceeded: chains.reduce((a, b) => a + b.stepsSucceeded, 0),
    meanSecondaryPerturbedPerChain: round2(mean(chains.map((x) => x.totalSecondaryPerturbed))),
    meanChainLatencyMs: round2(mean(chains.map((x) => x.totalLatencyMs))),
    chains,
  },
  pairedArrays: {
    ejectionMoves: pairedEjMoves,
    warmStartMoves: pairedWsMoves,
  },
};

fs.writeFileSync(OUT_PATH, JSON.stringify(output, null, 2), 'utf-8');
console.log('[A6-Dyn300] DONE!', JSON.stringify({
  conflictFeas: `${confOk.length}/${confTrials.length} (${output.conflictOnlySummary.ejectionFeasiblePct}%, CI95 ${output.conflictOnlySummary.ejectionWilsonCI95Pct})`,
  warmStartFeas: `${wsOk.length}/${warmStartTrials.length} (${output.conflictOnlySummary.warmStartFeasiblePct}%, CI95 ${output.conflictOnlySummary.warmStartWilsonCI95Pct})`,
  conflictLatMs: output.conflictOnlySummary.ejectionMeanLatencyMs,
  pairedMoves: `${output.conflictOnlySummary.pairedEjectionMeanMoves}±${output.conflictOnlySummary.pairedEjectionSdMoves} vs ${output.conflictOnlySummary.pairedWarmStartMeanMoves}±${output.conflictOnlySummary.pairedWarmStartSdMoves} (n=${bothFeas})`,
  staticN60: `${output.staticFullResolveSummary.meanPerturbed}±${output.staticFullResolveSummary.sdPerturbed} moves (${output.staticFullResolveSummary.meanLatencyMs} ms)`,
}));
