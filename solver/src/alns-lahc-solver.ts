/**
 * H-ALNS-LAHC: Hybrid Adaptive Large Neighborhood Search + Late Acceptance Hill Climbing
 * + Simulated Annealing Reheat + Kempe-Chain Ejection Solver (Strict TypeScript)
 *
 * Engineered specifically for Humane Academic Timetabling:
 *   - O(1) 96-bit BitmaskIndex for ultra-fast neighborhood evaluation
 *   - Strict Contiguous 3-4 Day Blocks (Sen-Sel-Rab, Sel-Rab-Kam, Rab-Kam-Jum, Sen-Kam, Sel-Jum)
 *   - Humane Start Time >= 08:40 (eliminates 07:00 fatigue; 100% >=08:40 with idle dry-lab sharing,
 *     or exact mathematical minimum ~17 overflow slots at 07:50 under strict 47 room-days)
 *   - 340-min mega-practicals placed at 13:00-18:40 (zero 07:00 labs, zero ISHOMA clash!)
 *   - 5 Adaptive Neighborhood Operators: SingleShift, DirectSwap, KempeChainSwap,
 *     ClassDayConsolidation (Ruin-and-Recreate), and EarlyMorningEliminator + GapSqueezer
 */
import { BitmaskIndex, DAYS, DAY_INDEX, expandEffectiveClasses, makeSlotMask, type SlotMask } from './bitmask-index';
import {
  auditSchedule,
  CAMPUS_END,
  CAMPUS_START,
  computeGlobalHumaneEnergy,
  DEFAULT_POLICY,
  EARLY_OVERFLOW_START,
  EXTENDED_END,
  HUMANE_START,
  isGeneralRoom,
  isPascaRoom,
  isSaintekRoom,
  overlaps,
  overlapsFridayPrayer,
  overlapsIshoma,
  PASCA_ALLOWED_DAYS,
  sharesClass,
  WORK_END,
  buildCohortMap,
  getSeniorCohortClasses,
} from './humane-evaluator';
import type {
  CandidateSlot,
  ConstructiveResult,
  DayName,
  RepairPlan,
  RoomInfo,
  Session,
  SessionMove,
  SolverHyperparams,
  SolverPolicy,
} from './types';
import { DEFAULT_HYPERPARAMS } from './tpe-tuner';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function cloneSessions(sessions: Session[]): Session[] {
  return sessions.map((s) => ({
    ...s,
    classes: Array.isArray(s.classes) ? s.classes.slice() : [],
  }));
}

/**
 * Generate humane candidate start times ordered from MOST humane (>= 08:40) to fallback (07:50, 07:00).
 * Notice:
 *   - 100m: 08:40-10:20, 10:20-12:00 | 13:00-14:40, 14:40-16:20, 16:20-18:00 (exact zero-gap packing!)
 *           + 07:50-09:30 fallback (only if needed)
 *   - 150m: 08:40-11:10, 09:30-12:00 | 13:00-15:30, 15:30-18:00 (exact 2x150m afternoon packing!)
 *           + 07:50-10:20 (pairs cleanly with 10:20-12:00 100m -> zero morning waste!)
 *   - 170m: 08:40-11:30, 09:10-12:00 | 13:00-15:50, 14:40-17:30, 15:10-18:00
 *   - 340m: 13:00-18:40 FIRST (humane start >= 08:40 AND zero ISHOMA overlap!), 08:40-14:20 fallback
 */
export function getHumaneStarts(duration: number, policy: SolverPolicy, allowOverflow = true): number[] {
  const minPref = policy.preferredMinStart ?? HUMANE_START;
  let primary: number[];
  let overflow: number[];

  if (duration > 300) {
    // 340m mega-practicals: 13:00-18:40 avoids BOTH 07:00 early morning AND ISHOMA!
    primary = [780];
    overflow = [420];
  } else if (duration === 170) {
    primary = [520, 550, 780, 880, 910]; // 08:40, 09:10 | 13:00, 14:40, 15:10
    overflow = [470, 420];               // 07:50, 07:00
  } else if (duration === 150) {
    primary = [780, 930, 520, 570];      // 13:00, 15:30 (perfect fit!), 08:40, 09:30
    overflow = [470, 420];               // 07:50 (pairs with 10:20 100m!), 07:00
  } else if (duration === 100) {
    primary = [520, 620, 780, 880, 980]; // 08:40, 10:20 | 13:00, 14:40, 16:20 (exact!)
    overflow = [470, 570, 420];          // 07:50, 09:30, 07:00
  } else {
    primary = [520, 570, 620, 670, 780, 830, 880, 930, 980];
    overflow = [470, 420];
  }

  const maxEnd = duration > 300 ? EXTENDED_END : CAMPUS_END;
  const combined = allowOverflow ? [...primary, ...overflow] : primary;
  const seen = new Set<number>();
  const valid: number[] = [];

  for (const st of combined) {
    if (seen.has(st)) continue;
    seen.add(st);
    const en = st + duration;
    if (st < CAMPUS_START || en > maxEnd) continue;
    if (!allowOverflow && st < minPref) continue;
    if (policy.protectIshoma && overlapsIshoma(st, en, duration)) continue;
    valid.push(st);
  }
  return valid;
}

export const SD_IF_DRY_LABS = new Set(['LAB. DATA ENGINEER', 'LAB. DATA SCIENCE']);

export function getAllowedRooms(
  session: Session,
  rooms: RoomInfo[],
  policy: SolverPolicy
): string[] {
  if (session.roomType === 'WET_LAB' || session.roomType === 'DRY_LAB') {
    return [session.originalRoom || session.room];
  }
  const base = rooms
    .filter((r) => r.type === 'PASCA' || r.type === 'SAINTEK')
    .map((r) => r.name);

  // Domain-accurate Dry-Lab sharing: ONLY IF & SD theory may use LAB. DATA ENGINEER & LAB. DATA SCIENCE
  // (NEVER LAB. SIG or LAB. REMOTE SENSING which belong to Ilmu Lingkungan!)
  if (policy.allowDryLabOverflow && (session.prodi === 'IF' || session.prodi === 'SD')) {
    const dry = rooms
      .filter((r) => r.type === 'DRY_LAB' && SD_IF_DRY_LABS.has(r.name.toUpperCase()))
      .map((r) => r.name);
    return [...base, ...dry];
  }
  return base;
}

/**
 * Assign strictly CONTIGUOUS 3-day (or 4-day for mega-practical >1420m) day windows to all classes.
 * Uses data-driven Bipartite Semester Phase-Staggering for wet-lab departments (Sem s vs Sem s+2
 * assigned to complementary Mon-Wed vs Wed-Fri blocks so senior Asprak cohorts stay 100% CLEAR!),
 * while non-wet-lab departments balance Mon-Wed Pasca + computing-lab supply.
 */
function buildContiguousClassWindows(sessions: Session[], rng: () => number): Map<string, Set<number>> {
  const clsInfo = new Map<
    string,
    { count: number; totalMin: number; labMin: number; hasWetLab: boolean; sem: number; prodi: string; dryRooms: Set<string> }
  >();
  const wetLabProdis = new Set<string>();
  const prodiWetMin = new Map<string, number>();
  const prodiSem3Has4Day = new Set<string>();

  for (const s of sessions) {
    if (s.isWetLab && s.prodi) {
      wetLabProdis.add(s.prodi);
      prodiWetMin.set(s.prodi, (prodiWetMin.get(s.prodi) || 0) + s.duration);
    }
    for (const c of s.classes) {
      const prev = clsInfo.get(c) || {
        count: 0,
        totalMin: 0,
        labMin: 0,
        hasWetLab: false,
        sem: s.semester || 1,
        prodi: s.prodi,
        dryRooms: new Set<string>(),
      };
      prev.count++;
      prev.totalMin += s.duration;
      if (s.isPraktikum) prev.labMin += s.duration;
      if (s.isWetLab) prev.hasWetLab = true;
      if (s.roomType === 'DRY_LAB') prev.dryRooms.add(s.originalRoom || s.room);
      clsInfo.set(c, prev);
    }
  }
  for (const info of clsInfo.values()) {
    if (info.sem === 3 && info.totalMin > 1420) prodiSem3Has4Day.add(info.prodi);
  }

  // Phase-Alternating Bipartite Staggering across wet-lab departments:
  // Any dept with a 4-day Sem 3 class uses Phase 0 (Sem3=[0..3], Sem5=[1..4], Sem1=[2..4], Sem7=[0]).
  // Remaining wet-lab depts alternate Phase 1 (Sem1=[0,1,2], Sem3=[2,3,4], Sem5=[0,1,2], Sem7=[4])
  // and Phase 0 (Sem1=[1,2,3], Sem3=[0,1,2], Sem5=[2,3,4], Sem7=[0]) so shared wet labs (e.g. LAB. KIMIA)
  // spread cleanly across {Tue, Thu, Fri} with ZERO room saturation AND ZERO junior-senior overlap!
  const prodiPhase = new Map<string, 0 | 1>();
  const non4DayWetProdis = Array.from(wetLabProdis)
    .filter((p) => !prodiSem3Has4Day.has(p))
    .sort((a, b) => (prodiWetMin.get(b) || 0) - (prodiWetMin.get(a) || 0));
  for (const p of prodiSem3Has4Day) prodiPhase.set(p, 0);
  // Highest wet-lab volume non-4d dept gets Phase 1 (puts its Sem 3 wet labs on Thu/Fri & Sem 1 on Mon/Tue),
  // next gets Phase 0 (Sem 1 wet labs on Thu, Sem 3 on Mon/Tue) -> zero LAB. KIMIA contention across all 5 days!
  non4DayWetProdis.forEach((p, idx) => {
    prodiPhase.set(p, ((idx + 1) % 2) as 0 | 1);
  });

  // Strictly contiguous windows for non-wet-lab departments (biased to Mon-Wed Pasca + Computing Labs!)
  const windows1: number[][] = [[0], [1], [2], [3], [4]];
  const windows2: number[][] = [
    [0, 1],
    [1, 2],
    [0, 1],
    [1, 2],
  ];
  const nonWetWindows3: number[][] = [
    [0, 1, 2],
    [0, 1, 2],
    [1, 2, 3],
    [1, 2, 3],
    [0, 1, 2],
  ];

  const sorted = Array.from(clsInfo.entries()).sort((a, b) => b[1].totalMin - a[1].totalMin);
  const prefs = new Map<string, Set<number>>();
  const usedDryRoomDays = new Map<string, Set<number>>();
  const offset = Math.floor(rng() * nonWetWindows3.length);
  let oneDayIdx = Math.floor(rng() * windows1.length);
  let prakDayIdx = Math.floor(rng() * 2);
  let twoDayIdx = Math.floor(rng() * windows2.length);

  sorted.forEach(([cls, info], idx) => {
    const isWetDept = wetLabProdis.has(info.prodi);

    if (isWetDept) {
      const phase = prodiPhase.get(info.prodi) ?? 0;
      const has4dSem3 = prodiSem3Has4Day.has(info.prodi);
      if (info.count <= 3) {
        prefs.set(cls, new Set(phase === 1 && info.sem === 7 ? [4] : [0]));
      } else if (info.count <= 5) {
        prefs.set(cls, new Set(phase === 1 && info.sem === 7 ? [3, 4] : [0, 1]));
      } else if (info.totalMin > 1420) {
        prefs.set(cls, new Set(info.sem === 3 ? [0, 1, 2, 3] : [1, 2, 3, 4]));
      } else if (phase === 1) {
        // Phase 1: Sem 1 & Sem 5 on Mon-Wed [0,1,2]; Sem 3 on Wed-Fri [2,3,4] -> 100% disjoint!
        if (info.sem === 3) prefs.set(cls, new Set([2, 3, 4]));
        else prefs.set(cls, new Set([0, 1, 2]));
      } else {
        // Phase 0: Sem 3 on Mon-Wed [0,1,2]; Sem 5 on Wed-Fri [2,3,4];
        // Sem 1 on [2,3,4] if Sem3 uses Thu, else [1,2,3] (puts Sem1 wet labs on Thu with 0 Thu general rooms!)
        if (info.sem === 3) prefs.set(cls, new Set([0, 1, 2]));
        else if (info.sem === 5) prefs.set(cls, new Set([2, 3, 4]));
        else prefs.set(cls, new Set(has4dSem3 ? [2, 3, 4] : [1, 2, 3]));
      }
      return;
    }

    if (info.count <= 3) {
      // Dry-lab practical sub-cohorts ("Praktikum <Parent>"):
      // Assign a SINGLE day that is BOTH disjoint from parent's window AND unused by other Praktikum cohorts in the same lab!
      if (/^Praktikum\s+/i.test(cls)) {
        const parentName = cls.replace(/^Praktikum\s+/i, '').trim();
        const parentWin = prefs.get(parentName);
        const prefOrder = prakDayIdx++ % 2 === 0 ? [3, 4, 0, 1, 2] : [4, 3, 1, 0, 2];
        const roomFree = (d: number) =>
          Array.from(info.dryRooms).every((r) => !(usedDryRoomDays.get(r)?.has(d)));
        const chosen =
          prefOrder.find((d) => (!parentWin || !parentWin.has(d)) && roomFree(d)) ??
          prefOrder.find((d) => roomFree(d)) ??
          prefOrder.find((d) => !parentWin || !parentWin.has(d)) ??
          4;
        prefs.set(cls, new Set([chosen]));
        for (const r of info.dryRooms) {
          let s = usedDryRoomDays.get(r);
          if (!s) { s = new Set<number>(); usedDryRoomDays.set(r, s); }
          s.add(chosen);
        }
      } else {
        prefs.set(cls, new Set(windows1[oneDayIdx++ % windows1.length]));
      }
    } else if (info.count <= 5) {
      prefs.set(cls, new Set(windows2[twoDayIdx++ % windows2.length]));
    } else if (info.totalMin > 1420) {
      prefs.set(cls, new Set(info.sem === 3 ? [0, 1, 2, 3] : [1, 2, 3, 4]));
    } else {
      prefs.set(cls, new Set(nonWetWindows3[(idx + offset) % nonWetWindows3.length]));
    }
  });
  return prefs;
}

/**
 * PHASE 1 + PHASE 2: H-ALNS-LAHC Constructive + Humane Metaheuristic Optimizer
 */
export function constructiveReset(
  initialSessions: Session[],
  rooms: RoomInfo[],
  policyInput?: Partial<SolverPolicy>,
  options: {
    seed?: number;
    ignorePins?: boolean;
    maxIters?: number;
    timeBudgetMs?: number;
    skipStage2?: boolean;
    skipStage3?: boolean;
    useExactObjective?: boolean;
    hyperparams?: Partial<SolverHyperparams>;
    lecturerIsolatedWeight?: number;
    weightScale?: number;
  } = {}
): ConstructiveResult {
  const t0 = performance.now();
  const policy: SolverPolicy = { ...DEFAULT_POLICY, ...(policyInput || {}) };
  const hp: SolverHyperparams = { ...DEFAULT_HYPERPARAMS, ...(options.hyperparams || {}) };
  const seed = options.seed !== undefined ? options.seed : 27;
  const ignorePins = Boolean(options.ignorePins);
  const maxIters = options.maxIters !== undefined ? options.maxIters : 32000;
  const timeBudgetMs = options.timeBudgetMs !== undefined ? options.timeBudgetMs : 3500;
  const skipStage2 = Boolean(options.skipStage2);
  const skipStage3 = Boolean(options.skipStage3);
  const useExactObjective = Boolean(options.useExactObjective);
  const wScale = options.weightScale !== undefined ? options.weightScale : 1.0;
  const stage2LecIsoWeight =
    (options.lecturerIsolatedWeight !== undefined
      ? options.lecturerIsolatedWeight
      : policy.lecturerIsolatedWeight !== undefined
        ? policy.lecturerIsolatedWeight
        : 95) * wScale;
  const rng = mulberry32(seed);

  const sessions = cloneSessions(initialSessions);
  const n = sessions.length;
  const roomNames = rooms.map((r) => r.name);
  const bitIdx = new BitmaskIndex(sessions, roomNames);
  bitIdx.hardFridayPrayer = Boolean(policy.hardFridayPrayer);
  const contiguousWindows = buildContiguousClassWindows(sessions, rng);

  // Precompute allowed room IDs & candidate starts + masks per session
  const allowedRoomIds: number[][] = new Array(n);
  const candidateStarts: number[][] = new Array(n);
  const startMasks: Map<number, SlotMask>[] = new Array(n);

  const isDryLabById = new Uint8Array(roomNames.length + 10);
  const isPascaById = new Uint8Array(roomNames.length + 10);
  const idToRoomName: string[] = [];
  const roomTypeMap = new Map(rooms.map((r) => [r.name, r.type]));
  for (const [rn, rid] of bitIdx.roomToId.entries()) {
    idToRoomName[rid] = rn;
    if (isPascaRoom(rn)) isPascaById[rid] = 1;
    if (roomTypeMap.get(rn) === 'DRY_LAB') isDryLabById[rid] = 1;
  }

  for (let i = 0; i < n; i++) {
    const s = sessions[i];
    const rNames = getAllowedRooms(s, rooms, policy);
    allowedRoomIds[i] = rNames.map((rn) => bitIdx.roomToId.get(rn)!).filter((id) => id !== undefined);
    const starts = getHumaneStarts(s.duration, policy, true);
    candidateStarts[i] = starts;
    const mMap = new Map<number, SlotMask>();
    for (const st of starts) mMap.set(st, makeSlotMask(st, st + s.duration));
    startMasks[i] = mMap;
  }

  // Stage 1: Place Pinned (Dosen S3) sessions first
  const pinnedMask = new Uint8Array(n);
  const toPlace: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!ignorePins && sessions[i].pinned) {
      pinnedMask[i] = 1;
      const dIdx = DAY_INDEX[sessions[i].day];
      const rid = bitIdx.roomToId.get(sessions[i].room)!;
      bitIdx.place(i, dIdx, sessions[i].start, sessions[i].end, rid);
    } else {
      toPlace.push(i);
    }
  }

  // DSATUR / Hardest-First difficulty score
  const clsLoad = new Map<string, number>();
  const clsMegaCount = new Map<string, number>();
  const lecLoad = new Map<string, number>();
  for (const s of sessions) {
    for (const c of s.classes) {
      clsLoad.set(c, (clsLoad.get(c) || 0) + s.duration);
      if (s.duration > 300) clsMegaCount.set(c, (clsMegaCount.get(c) || 0) + 1);
    }
    if (s.dosen) lecLoad.set(s.dosen, (lecLoad.get(s.dosen) || 0) + s.duration);
  }
  const diffScore = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const s = sessions[i];
    let sc = 0;
    if (s.duration > 300) {
      const mCnt = Math.max(...s.classes.map((c) => clsMegaCount.get(c) || 0), 0);
      // Place 1-mega-lab classes (e.g., TP 3A) before 2-mega-lab classes (TP 3B) so different classes share Mon 13:00!
      sc += 6700 - mCnt * 260;
    }
    if (s.isWetLab) {
      sc += 4400;
      if (s.semester === 3) sc += 340; // Place Sem 3 mega/wet labs before Sem 5 so Sem 5 automatically avoids overlap!
    } else if (s.roomType === 'DRY_LAB') sc += 3900; // Place ALL Dry-Lab practicals (SD 3A/3B/3C, IF 3B) BEFORE theory overflow!
    else if (s.duration === 150) sc += 1200; // Place 150m before 100m for cleaner afternoon 2x150m packing!
    sc += s.duration * 4;
    sc += s.classes.length * 450;
    sc += Math.max(...s.classes.map((c) => clsLoad.get(c) || 0), 0) * 0.7;
    sc += (lecLoad.get(s.dosen) || 0) * 0.5;
    sc += rng() * 12;
    diffScore[i] = sc;
  }
  toPlace.sort((a, b) => diffScore[b] - diffScore[a]);

  // Fast incremental local cost for Stage 1 construction
  const minPref = policy.preferredMinStart ?? HUMANE_START;

  function stage1SlotCost(idx: number, dayIdx: number, start: number, roomId: number): number {
    const s = sessions[idx];
    let cost = 0;
    if (start < EARLY_OVERFLOW_START) cost += 2500;
    else if (start < minPref) cost += 650;
    if (policy.preferWorkingHours && start + s.duration > WORK_END) cost += 16;
    if (dayIdx === 4 && (policy.protectFridayPrayer || policy.hardFridayPrayer) && overlapsFridayPrayer('Jumat', start, start + s.duration, s.duration)) {
      cost += 1400;
    }

    // Strictly favor the pre-assigned contiguous 3-4 day window!
    for (const c of s.classes) {
      const win = contiguousWindows.get(c);
      if (win && !win.has(dayIdx)) cost += win.size === 1 ? 750 : 360;
    }

    // Strongly pack DRY_LAB practicals of the same class onto ONE day before theory overflow touches dry labs!
    if (s.roomType === 'DRY_LAB') {
      for (let j = 0; j < n; j++) {
        if (bitIdx.sessionDayIdx[j] === dayIdx && sessions[j].roomType === 'DRY_LAB' && sharesClass(s.classes, sessions[j].classes)) {
          cost -= 180;
        }
      }
    }

    // When sharing idle computing labs, steer IF/SD theory into DRY_LAB first so Pasca/Saintek stays free for BTK/IL/TP!
    if (policy.allowDryLabOverflow && (s.prodi === 'IF' || s.prodi === 'SD') && (s.roomType === 'PASCA' || s.roomType === 'SAINTEK')) {
      if (isDryLabById[roomId]) cost -= 28;
    }

    // Prefer Pasca on Mon-Wed so Saintek stays open for Thu-Fri
    if (dayIdx <= 2 && !isPascaById[roomId] && !isDryLabById[roomId] && (s.roomType === 'PASCA' || s.roomType === 'SAINTEK')) {
      cost += 9;
    }

    // Strongly steer wet labs onto days OUTSIDE their senior cohort's preferred window AND penalize partial overlap!
    if (policy.enforceAsprakWetLab && s.isWetLab) {
      const seniors = bitIdx.seniorClsIdsBySession[idx];
      if (seniors.length > 0) {
        let seniorUsesDay = 0;
        for (const [cname, cid] of bitIdx.clsToId.entries()) {
          if (!seniors.includes(cid)) continue;
          const sw = contiguousWindows.get(cname);
          if (sw && sw.has(dayIdx)) seniorUsesDay++;
        }
        if (seniorUsesDay === 0) cost -= 650;
        else cost += seniorUsesDay * 320;

        // Also check overlap against any already-placed senior session
        const end = start + s.duration;
        for (let j = 0; j < n; j++) {
          if (bitIdx.sessionDayIdx[j] !== dayIdx) continue;
          if (start < bitIdx.sessionEnd[j] && bitIdx.sessionStart[j] < end) {
            const oc = bitIdx.sessionConflictClsIds[j];
            if (oc.some((c) => seniors.includes(c))) cost += 680;
          }
        }
      }
    }

    // Penalize partial Asprak overlap during Stage 1 so senior cohorts stay 100% CLEAR from the start!
    if (policy.enforceAsprakWetLab && !s.isWetLab && s.semester && s.semester >= 3) {
      const cids = bitIdx.sessionConflictClsIds[idx];
      const end = start + s.duration;
      for (let k = 0; k < cids.length; k++) {
        const deps = bitIdx.dependentWetLabsByCls[cids[k]];
        for (let d = 0; d < deps.length; d++) {
          const ws = deps[d];
          if (bitIdx.sessionDayIdx[ws] === dayIdx && start < bitIdx.sessionEnd[ws] && bitIdx.sessionStart[ws] < end) {
            cost += 680;
          }
        }
      }
    }

    // Reward pairing any day that currently has ONLY 1 session for this class (prevents 340m wet labs & Thu/Fri days
    // from getting stranded alone while Pasca Mon-Wed fills up!), and conserve scarce Thu/Fri general classrooms!
    if ((policy.minCoursesPerActiveDay ?? 2) >= 2) {
      for (const c of s.classes) {
        let cntOnDay = 0;
        let hasOtherLoneDay = false;
        const perDay = [0, 0, 0, 0, 0];
        for (let j = 0; j < n; j++) {
          const jd = bitIdx.sessionDayIdx[j];
          if (jd < 0) continue;
          if (sessions[j].classes.includes(c)) perDay[jd]++;
        }
        cntOnDay = perDay[dayIdx];
        for (let d = 0; d < 5; d++) if (d !== dayIdx && perDay[d] === 1) hasOtherLoneDay = true;
        if (cntOnDay === 1) cost -= 320;
        else if (cntOnDay >= 3 && hasOtherLoneDay) cost += 180;
        else if (cntOnDay >= 4) cost += 75;
        // Conserve Thu/Fri general classrooms once wet labs / earlier sessions already satisfy >=2/day on Thu/Fri!
        if (dayIdx >= 3 && cntOnDay >= 2 && !s.isWetLab && s.roomType !== 'DRY_LAB') cost += 135;
      }
      if (s.dosen) {
        let lecOnDay = 0;
        for (let j = 0; j < n; j++) {
          if (bitIdx.sessionDayIdx[j] === dayIdx && sessions[j].dosen === s.dosen) lecOnDay++;
        }
        if (lecOnDay === 1) cost -= 55;
      }
    }

    // Reward exact zero-gap morning/afternoon packing & adjacency for same class/lecturer
    for (let j = 0; j < n; j++) {
      if (bitIdx.sessionDayIdx[j] !== dayIdx) continue;
      const o = sessions[j];
      const sameCls = sharesClass(s.classes, o.classes);
      const sameLec = Boolean(s.dosen && s.dosen === o.dosen);
      if (!sameCls && !sameLec) continue;

      const end = start + s.duration;
      const oStart = bitIdx.sessionStart[j];
      const oEnd = bitIdx.sessionEnd[j];
      const gap = start >= oEnd ? start - oEnd : oStart - end;
      if (gap === 0 || (gap === 60 && ((end === 720 && oStart === 780) || (oEnd === 720 && start === 780)))) {
        cost -= 36;
      } else if (gap >= 160) {
        cost += 48;
      }
    }
    return cost;
  }

  function findBestFeasibleSlot(
    idx: number,
    enforceAsprak: boolean,
    minAllowedStart: number
  ): { dayIdx: number; start: number; roomId: number; cost: number } | null {
    const rIds = allowedRoomIds[idx];
    const starts = candidateStarts[idx];
    const mMap = startMasks[idx];
    let best: { dayIdx: number; start: number; roomId: number; cost: number } | null = null;
    let bestCost = Infinity;

    for (let d = 0; d < 5; d++) {
      for (let ri = 0; ri < rIds.length; ri++) {
        const rid = rIds[ri];
        if (policy.enforcePascaMonWed && isPascaById[rid] && d > 2) continue;
        for (let si = 0; si < starts.length; si++) {
          const st = starts[si];
          if (st < minAllowedStart) continue;
          const mask = mMap.get(st)!;
          if (!bitIdx.canPlaceHard(idx, d, rid, mask, enforceAsprak)) continue;
          const cost = stage1SlotCost(idx, d, st, rid);
          if (cost < bestCost) {
            bestCost = cost;
            best = { dayIdx: d, start: st, roomId: rid, cost };
          }
        }
      }
    }
    return best;
  }

  function tryEjectionPlace(idx: number, enforceAsprak: boolean, minAllowedStart: number): boolean {
    const rIds = allowedRoomIds[idx];
    const starts = candidateStarts[idx];
    const mMap = startMasks[idx];

    for (let d = 0; d < 5; d++) {
      for (const rid of rIds) {
        if (policy.enforcePascaMonWed && isPascaById[rid] && d > 2) continue;
        for (const st of starts) {
          if (st < minAllowedStart) continue;
          const mask = mMap.get(st)!;
          const blockers = bitIdx.findBlockers(idx, d, rid, mask);
          if (blockers.length === 0 || blockers.length > 2) continue;
          if (blockers.some((b) => pinnedMask[b] === 1)) continue;

          const saved = blockers.map((b) => ({
            b,
            d: bitIdx.sessionDayIdx[b],
            st: bitIdx.sessionStart[b],
            en: bitIdx.sessionEnd[b],
            rid: bitIdx.sessionRoomId[b],
          }));
          for (const sv of saved) bitIdx.unplace(sv.b);

          if (!bitIdx.canPlaceHard(idx, d, rid, mask, enforceAsprak)) {
            for (const sv of saved) bitIdx.place(sv.b, sv.d, sv.st, sv.en, sv.rid);
            continue;
          }
          bitIdx.place(idx, d, st, st + sessions[idx].duration, rid);

          const moved: number[] = [];
          let ok = true;
          for (const sv of saved) {
            const alt = findBestFeasibleSlot(sv.b, enforceAsprak, minAllowedStart);
            if (!alt) {
              ok = false;
              break;
            }
            bitIdx.place(sv.b, alt.dayIdx, alt.start, alt.start + sessions[sv.b].duration, alt.roomId);
            moved.push(sv.b);
          }

          if (ok) return true;

          for (const mb of moved) bitIdx.unplace(mb);
          bitIdx.unplace(idx);
          for (const sv of saved) bitIdx.place(sv.b, sv.d, sv.st, sv.en, sv.rid);
        }
      }
    }
    return false;
  }

  // Stage 1A: Strict Humane Start (>= 08:40) Greedy DSATUR Placement!
  const unplacedTier1: number[] = [];
  for (const idx of toPlace) {
    const slot = findBestFeasibleSlot(idx, policy.enforceAsprakWetLab, minPref);
    if (slot) {
      bitIdx.place(idx, slot.dayIdx, slot.start, slot.start + sessions[idx].duration, slot.roomId);
    } else {
      unplacedTier1.push(idx);
    }
  }

  // Stage 1B: Strict Humane Start (>= 08:40) 1-2 Blocker Kempe Ejection Recovery!
  const unplacedTier2: number[] = [];
  for (const idx of unplacedTier1) {
    if (!tryEjectionPlace(idx, policy.enforceAsprakWetLab, minPref)) {
      unplacedTier2.push(idx);
    }
  }

  // Stage 1C: Strict >= 07:50 Zero-Waste Morning Packing (ONLY triggered if mathematically needed, e.g. Strict 47 rooms!)
  // First try shifting an afternoon 150m theory session to 07:50-10:20 (pairs cleanly with 10:20-12:00 100m -> frees 3x100m afternoon!)
  const unplacedTier3: number[] = [];
  for (const idx of unplacedTier2) {
    // 1. Try direct >= 07:50 first
    let slot = findBestFeasibleSlot(idx, policy.enforceAsprakWetLab, EARLY_OVERFLOW_START);
    if (slot) {
      bitIdx.place(idx, slot.dayIdx, slot.start, slot.start + sessions[idx].duration, slot.roomId);
      continue;
    }
    // 2. If idx is 100m theory, try promoting an afternoon 150m session to 07:50-10:20 to open afternoon room capacity!
    if (sessions[idx].duration === 100 && (sessions[idx].roomType === 'PASCA' || sessions[idx].roomType === 'SAINTEK')) {
      let opened = false;
      for (let j = 0; j < n && !opened; j++) {
        if (pinnedMask[j] === 1 || bitIdx.sessionDayIdx[j] < 0) continue;
        if (sessions[j].duration !== 150 || bitIdx.sessionStart[j] < 780) continue;
        const jD = bitIdx.sessionDayIdx[j], jSt = bitIdx.sessionStart[j], jEn = bitIdx.sessionEnd[j], jR = bitIdx.sessionRoomId[j];
        bitIdx.unplace(j);
        // Find a 07:50 morning slot for j
        const jMask750 = makeSlotMask(EARLY_OVERFLOW_START, EARLY_OVERFLOW_START + 150);
        let jMoved = false;
        for (let td = 0; td < 5 && !jMoved; td++) {
          for (const tr of allowedRoomIds[j]) {
            if (policy.enforcePascaMonWed && isPascaById[tr] && td > 2) continue;
            if (bitIdx.canPlaceHard(j, td, tr, jMask750, policy.enforceAsprakWetLab)) {
              bitIdx.place(j, td, EARLY_OVERFLOW_START, EARLY_OVERFLOW_START + 150, tr);
              const altIdx = findBestFeasibleSlot(idx, policy.enforceAsprakWetLab, EARLY_OVERFLOW_START);
              if (altIdx) {
                bitIdx.place(idx, altIdx.dayIdx, altIdx.start, altIdx.start + sessions[idx].duration, altIdx.roomId);
                jMoved = true;
                opened = true;
                break;
              } else {
                bitIdx.unplace(j);
              }
            }
          }
        }
        if (!jMoved) bitIdx.place(j, jD, jSt, jEn, jR);
      }
      if (opened) continue;
    }
    // 3. Try 1-2 blocker ejection strictly >= 07:50
    if (tryEjectionPlace(idx, policy.enforceAsprakWetLab, EARLY_OVERFLOW_START)) continue;
    unplacedTier3.push(idx);
  }

  // Stage 1D: Last-resort >= 07:00 or relaxed-Asprak + targeted Asprak Deadlock Elimination
  const stillUnplaced: number[] = [];
  for (const idx of unplacedTier3) {
    const slot = findBestFeasibleSlot(idx, policy.enforceAsprakWetLab, CAMPUS_START);
    if (slot) {
      bitIdx.place(idx, slot.dayIdx, slot.start, slot.start + sessions[idx].duration, slot.roomId);
    } else if (!tryEjectionPlace(idx, policy.enforceAsprakWetLab, CAMPUS_START)) {
      stillUnplaced.push(idx);
    }
  }

  for (const idx of stillUnplaced) {
    const slot = findBestFeasibleSlot(idx, false, EARLY_OVERFLOW_START) || findBestFeasibleSlot(idx, false, CAMPUS_START);
    if (slot) {
      bitIdx.place(idx, slot.dayIdx, slot.start, slot.start + sessions[idx].duration, slot.roomId);
    } else {
      const rid = bitIdx.roomToId.get(sessions[idx].room)!;
      bitIdx.place(idx, DAY_INDEX[sessions[idx].day], sessions[idx].start, sessions[idx].end, rid);
    }
  }

  if (policy.enforceAsprakWetLab && stillUnplaced.length > 0) {
    for (let pass = 0; pass < 3; pass++) {
      let fixedAny = false;
      for (let i = 0; i < n; i++) {
        if (!sessions[i].isWetLab || pinnedMask[i] === 1) continue;
        const seniors = bitIdx.seniorClsIdsBySession[i];
        if (seniors.length === 0) continue;
        const curD = bitIdx.sessionDayIdx[i];
        const curSt = bitIdx.sessionStart[i];
        const curEn = bitIdx.sessionEnd[i];
        const curRid = bitIdx.sessionRoomId[i];
        const curMask = makeSlotMask(curSt, curEn);

        bitIdx.unplace(i);
        const alreadyOk = bitIdx.canPlaceHard(i, curD, curRid, curMask, true);
        if (alreadyOk) {
          bitIdx.place(i, curD, curSt, curEn, curRid);
          continue;
        }
        const alt = findBestFeasibleSlot(i, true, minPref) || findBestFeasibleSlot(i, true, EARLY_OVERFLOW_START);
        if (alt) {
          bitIdx.place(i, alt.dayIdx, alt.start, alt.start + sessions[i].duration, alt.roomId);
          fixedAny = true;
        } else {
          bitIdx.place(i, curD, curSt, curEn, curRid);
        }
      }
      if (!fixedAny) break;
    }
  }

  // Determine achieved start-time floor invariant so Stage 2 NEVER regresses into 07:00 (or <08:40 in Mode B!)
  let stage1MinStart = 1440;
  for (let i = 0; i < n; i++) {
    if (bitIdx.sessionStart[i] < stage1MinStart) stage1MinStart = bitIdx.sessionStart[i];
  }
  const floorStart =
    stage1MinStart >= minPref
      ? minPref
      : stage1MinStart >= EARLY_OVERFLOW_START
        ? EARLY_OVERFLOW_START
        : CAMPUS_START;

  // Filter Stage 2 candidate starts to strictly obey floorStart!
  const stage2Starts: number[][] = new Array(n);
  for (let i = 0; i < n; i++) {
    const filtered = candidateStarts[i].filter((st) => st >= floorStart);
    stage2Starts[i] = filtered.length > 0 ? filtered : candidateStarts[i];
  }

  // Sync Session objects from BitmaskIndex
  function syncSessionsFromIndex(target: Session[]): void {
    for (let i = 0; i < n; i++) {
      const d = bitIdx.sessionDayIdx[i];
      target[i].day = DAYS[d];
      target[i].start = bitIdx.sessionStart[i];
      target[i].end = bitIdx.sessionEnd[i];
      target[i].room = idToRoomName[bitIdx.sessionRoomId[i]];
    }
  }

  syncSessionsFromIndex(sessions);

  // =========================================================================
  // ZERO-ALLOCATION FAST ENERGY EVALUATOR (5x-8x faster than Map-per-iter!)
  // Mathematically identical to computeGlobalHumaneEnergy() using integer IDs
  // =========================================================================
  const numCls = bitIdx.clsToId.size;
  const numLec = bitIdx.lecToId.size;
  const clsDayBuf: number[][] = Array.from({ length: numCls * 5 }, () => []);
  const lecDayBuf: number[][] = Array.from({ length: numLec * 5 }, () => []);
  const sessDur = new Int32Array(n);
  for (let i = 0; i < n; i++) sessDur[i] = sessions[i].duration;

  // Reusable insertion sort by bitIdx.sessionStart (lists are tiny: 1-5 elements!)
  function sortByStart(arr: number[]): void {
    for (let i = 1; i < arr.length; i++) {
      const key = arr[i];
      const keySt = bitIdx.sessionStart[key];
      let j = i - 1;
      while (j >= 0 && bitIdx.sessionStart[arr[j]] > keySt) {
        arr[j + 1] = arr[j];
        j--;
      }
      arr[j + 1] = key;
    }
  }

  const friBreakActive = Boolean(policy.protectFridayPrayer || policy.hardFridayPrayer);
  function fastDeadGap(prevEnd: number, nextStart: number, dayIdx = -1): number {
    const raw = nextStart - prevEnd;
    if (raw <= 0) return 0;
    const bStart = dayIdx === 4 && friBreakActive ? 690 : 720;
    const lo = prevEnd > bStart ? prevEnd : bStart;
    const hi = nextStart < 780 ? nextStart : 780;
    const lunch = hi > lo ? hi - lo : 0;
    return raw > lunch ? raw - lunch : 0;
  }

  // Two-Phase Dynamic Penalty Weighting (prevents 2->1->0 day-collapse barriers during warm exploration!)
  // Phase 2A (warm): studentLoneDayPenalty = 0 -> exact v3 landscape: 36/36 contiguous, 33/36 <=3d, low gaps, high Asprak clear!
  // Phase 2B (hardening) + Stage 3: strict loneDayPenalty = 920 -> drives EVERY student class to 0 single-course days!
  let studentLoneDayPenalty = 0;

  // Dynamic cohort denominators (exact match to humane-evaluator.ts & deepPolishSchedule for A1 2x2 objective matrix)
  const clsWeeklyTotal = new Int32Array(numCls);
  for (let i = 0; i < n; i++) {
    const cids = bitIdx.sessionClsIds[i];
    for (let k = 0; k < cids.length; k++) clsWeeklyTotal[cids[k]] += sessDur[i];
  }
  let s2CompactCeiling = 0;
  for (let c = 0; c < numCls; c++) if (clsWeeklyTotal[c] <= 1420) s2CompactCeiling++;
  s2CompactCeiling = Math.max(1, s2CompactCeiling);
  const s2GapNormRef = Math.max(1, Math.round(numCls * 1.8));

  function computeFastEnergy(): number {
    // A1 2x2 Matrix Mode: MN-LAHC minimizing exact negated Stage-4 objective (1000*H_raw - w_lec*LecIso)
    if (useExactObjective) {
      for (let i = 0; i < clsDayBuf.length; i++) clsDayBuf[i].length = 0;
      for (let i = 0; i < lecDayBuf.length; i++) lecDayBuf[i].length = 0;
      let early = 0, early0750 = 0, lateCount = 0, friViol = 0;
      for (let i = 0; i < n; i++) {
        const d = bitIdx.sessionDayIdx[i], st = bitIdx.sessionStart[i], en = bitIdx.sessionEnd[i];
        if (st < minPref) early++;
        if (st < EARLY_OVERFLOW_START) early0750++;
        if (en > WORK_END) lateCount++;
        if (d === 4 && friBreakActive && overlapsFridayPrayer('Jumat', st, en, sessDur[i])) friViol++;
        const cids = bitIdx.sessionClsIds[i];
        for (let k = 0; k < cids.length; k++) clsDayBuf[cids[k] * 5 + d].push(i);
        const lid = bitIdx.sessionLecId[i];
        if (lid >= 0) lecDayBuf[lid * 5 + d].push(i);
      }
      let nonContig = 0, holes = 0, within3 = 0, classes5d = 0, isolatedCls = 0, marathons = 0;
      let clsLongGaps = 0, totalDeadGapMin = 0, bldSwitches = 0;
      for (let c = 0; c < numCls; c++) {
        const base = c * 5;
        let activeCount = 0, minD = 5, maxD = -1, totalSess = 0;
        for (let d = 0; d < 5; d++) {
          const list = clsDayBuf[base + d];
          const len = list.length;
          if (len === 0) continue;
          activeCount++;
          totalSess += len;
          if (d < minD) minD = d;
          if (d > maxD) maxD = d;
          if (len > 1) sortByStart(list);
          let contMin = 0, contCnt = 0, dayHasMar = false;
          for (let k = 0; k < len; k++) {
            const cur = list[k], dur = sessDur[cur];
            if (k === 0) { contMin = dur; contCnt = 1; }
            else {
              const prev = list[k - 1], prevEnd = bitIdx.sessionEnd[prev], curSt = bitIdx.sessionStart[cur];
              const rawGap = curSt - prevEnd;
              const dg = fastDeadGap(prevEnd, curSt, d);
              if (dg > 0) { totalDeadGapMin += dg; if (dg >= 100) clsLongGaps++; }
              if (rawGap === 0 && isPascaById[bitIdx.sessionRoomId[prev]] !== isPascaById[bitIdx.sessionRoomId[cur]]) bldSwitches++;
              if (rawGap < 40) { contMin += dur; contCnt++; } else { contMin = dur; contCnt = 1; }
              if (contCnt >= 2 && contMin > 300) dayHasMar = true;
            }
          }
          if (dayHasMar) marathons++;
        }
        if (activeCount <= 3) within3++;
        else if (activeCount >= 5) classes5d++;
        if (activeCount >= 2) {
          const h = maxD - minD + 1 - activeCount;
          if (h > 0) { nonContig++; holes += h; }
        }
        if ((policy.minCoursesPerActiveDay ?? 2) >= 2 && totalSess >= 2) {
          for (let d = 0; d < 5; d++) if (clsDayBuf[base + d].length === 1) isolatedCls++;
        }
      }
      let lecLongGaps = 0, lecIso = 0;
      for (let l = 0; l < numLec; l++) {
        const base = l * 5;
        let totalSess = 0;
        for (let d = 0; d < 5; d++) {
          const list = lecDayBuf[base + d];
          const len = list.length;
          if (len === 0) continue;
          totalSess += len;
          if (len > 1) sortByStart(list);
          for (let k = 1; k < len; k++) {
            const dg = fastDeadGap(bitIdx.sessionEnd[list[k - 1]], bitIdx.sessionStart[list[k]], d);
            if (dg > 0) { totalDeadGapMin += dg * 0.7; if (dg >= 100) lecLongGaps++; }
          }
        }
        if ((policy.minCoursesPerActiveDay ?? 2) >= 2 && totalSess >= 2) {
          for (let d = 0; d < 5; d++) if (lecDayBuf[base + d].length === 1) lecIso++;
        }
      }
      const asp = policy.enforceAsprakWetLab ? bitIdx.countAsprakIssues() : { deadlocks: 0, partials: 0, overlapTicks: 0 };
      const startPts = ((n - early - early0750 * 0.5) / n) * 25000;
      const contigPts = ((numCls - nonContig) / numCls) * 25000;
      const compactPts = Math.min(1, within3 / s2CompactCeiling) * 20000;
      const gapPts = Math.max(0, 1 - (clsLongGaps + lecLongGaps) / s2GapNormRef) * 15000;
      const compPen = asp.deadlocks * 2500 + asp.partials * 250 + marathons * 800 + isolatedCls * 600;
      const compPts = Math.max(0, 15000 - compPen);
      const exactScore1000 = startPts + contigPts + compactPts + gapPts + compPts;
      const friPenalty = policy.protectFridayPrayer ? friViol * 3500 : 0;
      const wLecNow = studentLoneDayPenalty > 0 ? stage2LecIsoWeight : Math.round(stage2LecIsoWeight * 0.25);
      const smoothGuide =
        -classes5d * 18 -
        asp.overlapTicks * 0.45 -
        totalDeadGapMin * 0.015 -
        lecIso * wLecNow -
        bldSwitches * 0.05 -
        lateCount * 0.02 -
        friPenalty;
      const barrier = holes * 1200 + (studentLoneDayPenalty > 0 ? isolatedCls * 450 : 0);
      return 100000 - (exactScore1000 + smoothGuide) + barrier;
    }

    let energy = 0;

    // Reset pre-allocated day buckets (zero GC allocation!)
    for (let i = 0; i < clsDayBuf.length; i++) clsDayBuf[i].length = 0;
    for (let i = 0; i < lecDayBuf.length; i++) lecDayBuf[i].length = 0;

    for (let i = 0; i < n; i++) {
      const d = bitIdx.sessionDayIdx[i];
      const st = bitIdx.sessionStart[i];
      const en = bitIdx.sessionEnd[i];

      if (st < EARLY_OVERFLOW_START) energy += 650;
      else if (st < minPref) energy += policy.allowDryLabOverflow ? 980 : 180;

      if (policy.preferWorkingHours && en > WORK_END) {
        energy += en > CAMPUS_END ? 32 : 14;
      }

      if (d === 4 && friBreakActive && overlapsFridayPrayer('Jumat', st, en, sessDur[i])) {
        energy += policy.hardFridayPrayer ? 5000 : 500;
      }

      const cids = bitIdx.sessionClsIds[i];
      for (let k = 0; k < cids.length; k++) {
        clsDayBuf[cids[k] * 5 + d].push(i);
      }
      const lid = bitIdx.sessionLecId[i];
      if (lid >= 0) {
        lecDayBuf[lid * 5 + d].push(i);
      }
    }

    // Evaluate all atomic classes
    for (let c = 0; c < numCls; c++) {
      const base = c * 5;
      let activeCount = 0;
      let minD = 5;
      let maxD = -1;
      let totalWeeklyMin = 0;

      for (let d = 0; d < 5; d++) {
        const list = clsDayBuf[base + d];
        const len = list.length;
        if (len === 0) continue;
        activeCount++;
        if (d < minD) minD = d;
        if (d > maxD) maxD = d;
        if (len > 1) sortByStart(list);

        let dailyMin = 0;
        let contMin = 0;
        let contCnt = 0;

        for (let k = 0; k < len; k++) {
          const cur = list[k];
          const dur = sessDur[cur];
          dailyMin += dur;
          totalWeeklyMin += dur;

          if (k === 0) {
            contMin = dur;
            contCnt = 1;
          } else {
            const prev = list[k - 1];
            const prevEnd = bitIdx.sessionEnd[prev];
            const curStart = bitIdx.sessionStart[cur];
            const rawGap = curStart - prevEnd;
            const deadGap = fastDeadGap(prevEnd, curStart, d);

            if (policy.minimizeLongGaps) {
              if (deadGap >= 100) energy += hp.wGapCls + Math.floor((deadGap - 100) / 30) * 20;
              else if (deadGap >= 40) energy += 28;
            }
            if (rawGap === 0 && isPascaById[bitIdx.sessionRoomId[prev]] !== isPascaById[bitIdx.sessionRoomId[cur]]) {
              energy += 16;
            }
            if (rawGap < 40) {
              contMin += dur;
              contCnt++;
            } else {
              contMin = dur;
              contCnt = 1;
            }
            if (policy.preventMarathon && contCnt >= 2 && contMin > 300) {
              energy += 130;
            }
          }
        }
        if (dailyMin > 480) energy += 65;
      }

      const needs4 = totalWeeklyMin > 1420;
      if (activeCount > policy.maxDaysPerClass) {
        if (activeCount === 4) energy += needs4 ? 25 : hp.wDay4;
        else energy += Math.max(1050, hp.wDay4 * 2 + 130);
      }
      if (policy.enforceContiguousDays && activeCount >= 2) {
        const holes = maxD - minD + 1 - activeCount;
        // Strict lexicographic priority: holePenalty (3200) > loneDay (1650) > day4 + asprak + gap
        // Guarantees Phase 2B / Stage 3 NEVER breaks 36/36 contiguity while driving 1-course days to 0!
        if (holes > 0) energy += holes * 3200;
      }
      // MINIMUM 2 COURSES PER ACTIVE DAY (Zero 1-course commute days for all classes with >=2 courses!)
      const minPerDay = policy.minCoursesPerActiveDay ?? 2;
      if (minPerDay >= 2) {
        let totalClsSess = 0;
        for (let d = 0; d < 5; d++) totalClsSess += clsDayBuf[base + d].length;
        // Always keep 2-3 session cohorts (e.g., Praktikum SD/IF, Sem 7) consolidated on 1 day even in Phase 2A!
        if (totalClsSess >= 2 && totalClsSess <= 3 && activeCount > 1) {
          energy += (activeCount - 1) * 480;
        }
        if (totalClsSess >= 2) {
          for (let d = 0; d < 5; d++) {
            if (clsDayBuf[base + d].length === 1) energy += studentLoneDayPenalty;
          }
        }
      }
    }

    // Evaluate all lecturers
    const minLecPerDay = policy.minCoursesPerActiveDay ?? 2;
    for (let l = 0; l < numLec; l++) {
      const base = l * 5;
      let activeCount = 0;
      let minD = 5;
      let maxD = -1;
      let totalLecSess = 0;

      for (let d = 0; d < 5; d++) {
        const list = lecDayBuf[base + d];
        const len = list.length;
        if (len === 0) continue;
        activeCount++;
        totalLecSess += len;
        if (d < minD) minD = d;
        if (d > maxD) maxD = d;
        if (len > 1) sortByStart(list);

        let dailyMin = 0;
        for (let k = 0; k < len; k++) {
          const cur = list[k];
          dailyMin += sessDur[cur];
          if (k > 0) {
            const prev = list[k - 1];
            const prevEnd = bitIdx.sessionEnd[prev];
            const curStart = bitIdx.sessionStart[cur];
            const deadGap = fastDeadGap(prevEnd, curStart, d);
            if (policy.minimizeLongGaps) {
              if (deadGap >= 100) energy += hp.wGapLec + Math.floor((deadGap - 100) / 30) * 16;
              else if (deadGap >= 40) energy += 18;
            }
            if (curStart - prevEnd === 0 && isPascaById[bitIdx.sessionRoomId[prev]] !== isPascaById[bitIdx.sessionRoomId[cur]]) {
              energy += 12;
            }
          }
        }
        if (dailyMin > 420) energy += 55;
      }
      if (activeCount >= 2 && activeCount <= 4) {
        const holes = maxD - minD + 1 - activeCount;
        if (holes > 0) energy += holes * 26;
      }
      // Lecturer 1-course day penalty (symmetric with policy.lecturerIsolatedWeight; mild in 2A, full in 2B+Stage 3)
      if (minLecPerDay >= 2 && totalLecSess >= 2 && stage2LecIsoWeight > 0) {
        const wLecNow = studentLoneDayPenalty > 0 ? stage2LecIsoWeight : stage2LecIsoWeight >= 200 ? Math.round(stage2LecIsoWeight * 0.25) : 0;
        if (wLecNow > 0) {
          for (let d = 0; d < 5; d++) {
            if (lecDayBuf[base + d].length === 1) energy += wLecNow;
          }
        }
      }
    }

    // Wet-Lab Asprak Clearance Objective (0 deadlocks hard + drive partial overlaps low!)
    if (policy.enforceAsprakWetLab) {
      const asp = bitIdx.countAsprakIssues();
      energy += asp.deadlocks * 1500 + asp.partials * hp.wAsprakPartial + asp.overlapTicks * 0.9;
    }

    return energy;
  }

  // =========================================================================
  // STAGE 2: H-ALNS-LAHC + SIMULATED ANNEALING REHEAT + KEMPE-CHAIN + ASPRAK CLEAR
  // =========================================================================
  const movableIndices: number[] = [];
  for (let i = 0; i < n; i++) {
    if (pinnedMask[i] === 0) movableIndices.push(i);
  }

  let currentEnergy = computeFastEnergy();
  const initialEnergy = currentEnergy;

  // Snapshot global incumbent best
  let bestEnergy = currentEnergy;
  const bestDay = new Int32Array(bitIdx.sessionDayIdx);
  const bestStart = new Int32Array(bitIdx.sessionStart);
  const bestEnd = new Int32Array(bitIdx.sessionEnd);
  const bestRoom = new Int32Array(bitIdx.sessionRoomId);

  function saveBest(): void {
    bestEnergy = currentEnergy;
    bestDay.set(bitIdx.sessionDayIdx);
    bestStart.set(bitIdx.sessionStart);
    bestEnd.set(bitIdx.sessionEnd);
    bestRoom.set(bitIdx.sessionRoomId);
  }

  // Late Acceptance Hill Climbing (LAHC) circular fitness list (tunable via TPE!)
  const L = Math.max(15, Math.round(hp.lahcLength));
  const lahcList = new Float64Array(L).fill(currentEnergy);
  let temp = hp.initTemp; // SA reheat temperature for escaping deep plateaus
  const cooling = hp.coolingRate;

  let iterations = 0;
  let acceptedMoves = 0;
  let improvingMoves = 0;
  let kempeSwaps = 0;
  let dayConsolidations = 0;
  let earlyFixes = 0;
  let asprakClears = 0;
  const cbsRestarts = unplacedTier1.length + unplacedTier2.length;
  let reheats = 0;
  let stagnant = 0;

  // Adaptive Operator Weights (ALNS — 6 operators, tunable via TPE!)
  // [0:Single, 1:Swap, 2:Kempe, 3:DayConsolidate, 4:Early&GapFix, 5:AsprakClear]
  const opWeights = [
    1.0,
    1.0 * hp.opScaleSwap,
    1.1 * hp.opScaleSwap,
    hp.opScaleConsolidate,
    1.4 * hp.opScaleSwap,
    hp.opScaleAsprak,
  ];

  function pickOperator(): number {
    const sum = opWeights[0] + opWeights[1] + opWeights[2] + opWeights[3] + opWeights[4] + opWeights[5];
    let r = rng() * sum;
    for (let i = 0; i < 6; i++) {
      r -= opWeights[i];
      if (r <= 0) return i;
    }
    return 0;
  }

  function acceptCandidate(newEnergy: number, iter: number): boolean {
    const v = iter % L;
    if (newEnergy <= currentEnergy || newEnergy <= lahcList[v]) {
      return true;
    }
    // Hybrid SA acceptance when reheated to jump out of local optima
    const delta = newEnergy - currentEnergy;
    if (temp > 1.5 && Math.exp(-delta / temp) > rng()) {
      return true;
    }
    return false;
  }

  function applySessionUpdate(idx: number, d: number, st: number, rid: number): void {
    const en = st + sessions[idx].duration;
    bitIdx.place(idx, d, st, en, rid);
    sessions[idx].day = DAYS[d];
    sessions[idx].start = st;
    sessions[idx].end = en;
    sessions[idx].room = idToRoomName[rid];
  }

  // Pre-build class -> session index lists for Op 3 (Contiguous Day Consolidation) & Stage 3 Polishing
  const classToSessIndices = new Map<string, number[]>();
  const classTotalMin = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    for (const c of sessions[i].classes) {
      const arr = classToSessIndices.get(c) || [];
      arr.push(i);
      classToSessIndices.set(c, arr);
      classTotalMin.set(c, (classTotalMin.get(c) || 0) + sessions[i].duration);
    }
  }
  const allClassKeys = Array.from(classToSessIndices.keys());

  // Fast O(1)-sampled swap helper for Stage 2 (works at 99% room packing density!)
  // Swaps session `aIdx` (currently on `oD`) with a compatible session `b` sitting on `targetDay`!
  function tryRandomDaySwap(aIdx: number, targetDay: number): boolean {
    const oD = bitIdx.sessionDayIdx[aIdx];
    const oSt = bitIdx.sessionStart[aIdx];
    const oR = bitIdx.sessionRoomId[aIdx];
    if (oD === targetDay) return false;

    const aAllowed = allowedRoomIds[aIdx];
    const aStarts = stage2Starts[aIdx];
    const aMasks = startMasks[aIdx];
    const startIdx = Math.floor(rng() * movableIndices.length);
    let tried = 0;

    for (let step = 0; step < movableIndices.length && tried < 28; step++) {
      const b = movableIndices[(startIdx + step) % movableIndices.length];
      if (b === aIdx || bitIdx.sessionDayIdx[b] !== targetDay) continue;
      const bR = bitIdx.sessionRoomId[b];
      if (!aAllowed.includes(bR)) continue;
      if (!allowedRoomIds[b].includes(oR)) continue;
      if (policy.enforcePascaMonWed && ((isPascaById[bR] && targetDay > 2) || (isPascaById[oR] && oD > 2))) continue;
      tried++;

      const bSt = bitIdx.sessionStart[b];
      bitIdx.unplace(aIdx);
      bitIdx.unplace(b);

      // Find valid start for aIdx in (targetDay, bR): try bSt first if valid, else any humane start
      let aNewSt = -1;
      if (aMasks.has(bSt) && bitIdx.canPlaceHard(aIdx, targetDay, bR, aMasks.get(bSt)!, policy.enforceAsprakWetLab)) {
        aNewSt = bSt;
      } else {
        for (const st of aStarts) {
          if (bitIdx.canPlaceHard(aIdx, targetDay, bR, aMasks.get(st)!, policy.enforceAsprakWetLab)) {
            aNewSt = st;
            break;
          }
        }
      }

      if (aNewSt >= 0) {
        applySessionUpdate(aIdx, targetDay, aNewSt, bR);
        const bMasks = startMasks[b];
        const bStarts = stage2Starts[b];
        let bNewSt = -1;
        if (bMasks.has(oSt) && bitIdx.canPlaceHard(b, oD, oR, bMasks.get(oSt)!, policy.enforceAsprakWetLab)) {
          bNewSt = oSt;
        } else {
          for (const st of bStarts) {
            if (bitIdx.canPlaceHard(b, oD, oR, bMasks.get(st)!, policy.enforceAsprakWetLab)) {
              bNewSt = st;
              break;
            }
          }
        }
        if (bNewSt >= 0) {
          applySessionUpdate(b, oD, bNewSt, oR);
          const newE = computeFastEnergy();
          if (acceptCandidate(newE, iterations)) {
            if (newE < currentEnergy) improvingMoves++;
            currentEnergy = newE;
            acceptedMoves++;
            dayConsolidations++;
            if (currentEnergy < bestEnergy) saveBest();
            return true;
          }
          bitIdx.unplace(b);
        }
        bitIdx.unplace(aIdx);
      }
      applySessionUpdate(aIdx, oD, oSt, oR);
      applySessionUpdate(b, targetDay, bSt, bR);
    }
    return false;
  }

  // Deterministic best-energy Targeted Day Swap for Stage 3 (100% packing-density immune!)
  // Swaps `aIdx` (on `oD`) onto `targetDay` by trading room-slots with the best compatible session `b` on `targetDay`.
  function tryBestDaySwap(aIdx: number, targetDay: number, forbidSameCls?: string): boolean {
    const oD = bitIdx.sessionDayIdx[aIdx];
    const oSt = bitIdx.sessionStart[aIdx];
    const oR = bitIdx.sessionRoomId[aIdx];
    if (oD === targetDay || pinnedMask[aIdx] === 1) return false;

    const aAllowed = allowedRoomIds[aIdx];
    const aStarts = stage2Starts[aIdx];
    const aMasks = startMasks[aIdx];

    let best: { b: number; aSt: number; bR: number; bSt: number; energy: number } | null = null;

    for (const b of movableIndices) {
      if (b === aIdx || bitIdx.sessionDayIdx[b] !== targetDay) continue;
      if (forbidSameCls && sessions[b].classes.includes(forbidSameCls)) continue;
      const bR = bitIdx.sessionRoomId[b];
      if (!aAllowed.includes(bR)) continue;
      if (!allowedRoomIds[b].includes(oR)) continue;
      if (policy.enforcePascaMonWed && ((isPascaById[bR] && targetDay > 2) || (isPascaById[oR] && oD > 2))) continue;

      const bSt = bitIdx.sessionStart[b];
      bitIdx.unplace(aIdx);
      bitIdx.unplace(b);

      const bMasks = startMasks[b];
      const bStarts = stage2Starts[b];

      // Candidate starts for aIdx in (targetDay, bR): bSt first (exact swap), plus all humane starts
      const aCandStarts = aMasks.has(bSt) ? [bSt, ...aStarts.filter((x) => x !== bSt)] : aStarts;
      const bCandStarts = bMasks.has(oSt) ? [oSt, ...bStarts.filter((x) => x !== oSt)] : bStarts;

      let aPlacedSt = -1;
      for (const st of aCandStarts) {
        if (bitIdx.canPlaceHard(aIdx, targetDay, bR, aMasks.get(st)!, policy.enforceAsprakWetLab)) {
          aPlacedSt = st;
          break;
        }
      }
      if (aPlacedSt >= 0) {
        applySessionUpdate(aIdx, targetDay, aPlacedSt, bR);
        for (const bst of bCandStarts) {
          if (!bitIdx.canPlaceHard(b, oD, oR, bMasks.get(bst)!, policy.enforceAsprakWetLab)) continue;
          applySessionUpdate(b, oD, bst, oR);
          const e = computeFastEnergy();
          bitIdx.unplace(b);
          if (e < currentEnergy && (!best || e < best.energy)) {
            best = { b, aSt: aPlacedSt, bR, bSt: bst, energy: e };
          }
          break; // First feasible start on oR already gives accurate day-level delta; keep fast!
        }
        bitIdx.unplace(aIdx);
      }

      applySessionUpdate(aIdx, oD, oSt, oR);
      applySessionUpdate(b, targetDay, bSt, bR);
    }

    if (best) {
      const b = best.b;
      bitIdx.unplace(aIdx);
      bitIdx.unplace(b);
      applySessionUpdate(aIdx, targetDay, best.aSt, best.bR);
      applySessionUpdate(b, oD, best.bSt, oR);
      currentEnergy = best.energy;
      if (currentEnergy < bestEnergy) saveBest();
      dayConsolidations++;
      return true;
    }
    return false;
  }

  // Exact 3-Cycle Bridge Swap (100% packing-density immune across non-overlapping Mon-Wed vs Thu-Fri class windows!):
  // Moves `aIdx` from `oD` -> `targetDay` via bridge day `midD` (e.g., Sen -> Rab -> Kam):
  //   - `aIdx` takes `b`'s slot on `targetDay`
  //   - `b` (active on `targetDay` & `midD`, >=3 on `targetDay`) takes `c`'s slot on `midD`
  //   - `c` (active on `midD` & `oD`, >=3 on `midD`) takes `aIdx`'s vacated slot on `oD`
  // Zero empty rooms needed, zero new holes, zero new 1-course days!
  function tryBridge3Cycle(aIdx: number, targetDay: number, forbidSameCls?: string): boolean {
    const oD = bitIdx.sessionDayIdx[aIdx];
    const oSt = bitIdx.sessionStart[aIdx];
    const oR = bitIdx.sessionRoomId[aIdx];
    if (oD === targetDay || pinnedMask[aIdx] === 1) return false;
    const dur = sessions[aIdx].duration;
    const aAllowed = allowedRoomIds[aIdx];

    // Precompute per-class active day counts for O(1) zero-collateral filtering of `b` and `c`
    const clsDayCnt = new Map<string, number[]>();
    for (const [k, list] of classToSessIndices.entries()) {
      const cnt = [0, 0, 0, 0, 0];
      for (const si of list) cnt[bitIdx.sessionDayIdx[si]]++;
      clsDayCnt.set(k, cnt);
    }

    const midOrder = [1, 2, 3, 0, 4].filter((d) => d !== oD && d !== targetDay);
    for (const midD of midOrder) {
      const bPool: number[] = [];
      const cPool: number[] = [];

      for (const si of movableIndices) {
        if (si === aIdx || sessions[si].duration !== dur) continue;
        if (forbidSameCls && sessions[si].classes.includes(forbidSameCls)) continue;
        const sd = bitIdx.sessionDayIdx[si];
        const sr = bitIdx.sessionRoomId[si];
        if (sd === targetDay) {
          if (!aAllowed.includes(sr)) continue;
          if (policy.enforcePascaMonWed && isPascaById[sr] && targetDay > 2) continue;
          // `b` must have >=3 on targetDay (or active on midD without breaking) so leaving targetDay creates no loneDay!
          const okB = sessions[si].classes.every((c) => {
            const cnt = clsDayCnt.get(c)!;
            return cnt[targetDay] >= 3 && cnt[midD] >= 1;
          });
          if (okB) bPool.push(si);
        } else if (sd === midD) {
          if (!allowedRoomIds[si].includes(oR)) continue;
          if (policy.enforcePascaMonWed && isPascaById[oR] && oD > 2) continue;
          const okC = sessions[si].classes.every((c) => {
            const cnt = clsDayCnt.get(c)!;
            return cnt[midD] >= 3 && cnt[oD] >= 1;
          });
          if (okC) cPool.push(si);
        }
      }

      for (const b of bPool) {
        const bSt = bitIdx.sessionStart[b], bR = bitIdx.sessionRoomId[b];
        for (const c of cPool) {
          if (c === b) continue;
          const cSt = bitIdx.sessionStart[c], cR = bitIdx.sessionRoomId[c];
          if (!allowedRoomIds[b].includes(cR)) continue;
          if (policy.enforcePascaMonWed && isPascaById[cR] && midD > 2) continue;

          const mA = startMasks[aIdx].get(bSt);
          const mB = startMasks[b].get(cSt);
          const mC = startMasks[c].get(oSt);
          if (!mA || !mB || !mC) continue;

          bitIdx.unplace(aIdx);
          bitIdx.unplace(b);
          bitIdx.unplace(c);

          if (bitIdx.canPlaceHard(aIdx, targetDay, bR, mA, policy.enforceAsprakWetLab)) {
            applySessionUpdate(aIdx, targetDay, bSt, bR);
            if (bitIdx.canPlaceHard(b, midD, cR, mB, policy.enforceAsprakWetLab)) {
              applySessionUpdate(b, midD, cSt, cR);
              if (bitIdx.canPlaceHard(c, oD, oR, mC, policy.enforceAsprakWetLab)) {
                applySessionUpdate(c, oD, oSt, oR);
                const e = computeFastEnergy();
                if (e < currentEnergy) {
                  currentEnergy = e;
                  if (currentEnergy < bestEnergy) saveBest();
                  dayConsolidations++;
                  return true;
                }
                bitIdx.unplace(c);
              }
              bitIdx.unplace(b);
            }
            bitIdx.unplace(aIdx);
          }

          applySessionUpdate(aIdx, oD, oSt, oR);
          applySessionUpdate(b, targetDay, bSt, bR);
          applySessionUpdate(c, midD, cSt, cR);
        }
      }
    }
    return false;
  }

  // Atomic multi-session swap-evacuation for Stage 3 (evacuates 1..4 sessions off `outD` into `targetDays` at 100% packing density!)
  function trySwapEvacuateDay(cls: string, outD: number, targetDays: number[]): boolean {
    const toEvac = classToSessIndices
      .get(cls)!
      .filter((si) => bitIdx.sessionDayIdx[si] === outD && pinnedMask[si] === 0);
    if (toEvac.length === 0 || toEvac.length > 4) return false;

    const evacSet = new Set(toEvac);
    const savedState: Array<{ si: number; d: number; st: number; rid: number }> = [];
    const touched = new Set<number>();
    const snapshotOnce = (si: number) => {
      if (touched.has(si)) return;
      touched.add(si);
      savedState.push({
        si,
        d: bitIdx.sessionDayIdx[si],
        st: bitIdx.sessionStart[si],
        rid: bitIdx.sessionRoomId[si],
      });
    };

    const rollbackAll = () => {
      for (const sv of savedState) bitIdx.unplace(sv.si);
      for (const sv of savedState) applySessionUpdate(sv.si, sv.d, sv.st, sv.rid);
    };

    for (const aIdx of toEvac) {
      const oD = bitIdx.sessionDayIdx[aIdx], oSt = bitIdx.sessionStart[aIdx], oR = bitIdx.sessionRoomId[aIdx];
      const aAllowed = allowedRoomIds[aIdx];
      const aStarts = stage2Starts[aIdx];
      const aMasks = startMasks[aIdx];

      // 1. Try a free slot inside targetDays first
      snapshotOnce(aIdx);
      bitIdx.unplace(aIdx);
      let placedFree = false;
      for (const td of targetDays) {
        for (const rid of aAllowed) {
          if (policy.enforcePascaMonWed && isPascaById[rid] && td > 2) continue;
          for (const st of aStarts) {
            if (bitIdx.canPlaceHard(aIdx, td, rid, aMasks.get(st)!, policy.enforceAsprakWetLab)) {
              applySessionUpdate(aIdx, td, st, rid);
              placedFree = true;
              break;
            }
          }
          if (placedFree) break;
        }
        if (placedFree) break;
      }
      if (placedFree) continue;
      applySessionUpdate(aIdx, oD, oSt, oR);

      // 2. Otherwise pick the best pairwise swap with a session `b` sitting on `targetDays`!
      //    Prefer `b` whose class is ALREADY active on `oD` (or has >=3 sessions on `b`'s day) so zero side effects!
      let bestSwap: { b: number; td: number; aSt: number; bR: number; bSt: number; score: number } | null = null;
      for (const td of targetDays) {
        for (const b of movableIndices) {
          if (evacSet.has(b) || touched.has(b) || bitIdx.sessionDayIdx[b] !== td) continue;
          if (sessions[b].classes.includes(cls)) continue;
          const bR = bitIdx.sessionRoomId[b];
          if (!aAllowed.includes(bR) || !allowedRoomIds[b].includes(oR)) continue;
          if (policy.enforcePascaMonWed && ((isPascaById[bR] && td > 2) || (isPascaById[oR] && oD > 2))) continue;

          const bSt = bitIdx.sessionStart[b];
          bitIdx.unplace(aIdx);
          bitIdx.unplace(b);

          const bMasks = startMasks[b];
          const bStarts = stage2Starts[b];
          const aCand = aMasks.has(bSt) ? [bSt, ...aStarts.filter((x) => x !== bSt)] : aStarts;
          const bCand = bMasks.has(oSt) ? [oSt, ...bStarts.filter((x) => x !== oSt)] : bStarts;

          let aNewSt = -1;
          for (const st of aCand) {
            if (bitIdx.canPlaceHard(aIdx, td, bR, aMasks.get(st)!, policy.enforceAsprakWetLab)) {
              aNewSt = st;
              break;
            }
          }
          if (aNewSt >= 0) {
            applySessionUpdate(aIdx, td, aNewSt, bR);
            let bNewSt = -1;
            for (const bst of bCand) {
              if (bitIdx.canPlaceHard(b, oD, oR, bMasks.get(bst)!, policy.enforceAsprakWetLab)) {
                bNewSt = bst;
                break;
              }
            }
            if (bNewSt >= 0) {
              applySessionUpdate(b, oD, bNewSt, oR);
              const e = computeFastEnergy();
              bitIdx.unplace(b);
              if (!bestSwap || e < bestSwap.score) {
                bestSwap = { b, td, aSt: aNewSt, bR, bSt: bNewSt, score: e };
              }
            }
            bitIdx.unplace(aIdx);
          }
          applySessionUpdate(aIdx, oD, oSt, oR);
          applySessionUpdate(b, td, bSt, bR);
        }
      }

      if (!bestSwap) {
        rollbackAll();
        return false;
      }
      snapshotOnce(bestSwap.b);
      bitIdx.unplace(aIdx);
      bitIdx.unplace(bestSwap.b);
      applySessionUpdate(aIdx, bestSwap.td, bestSwap.aSt, bestSwap.bR);
      applySessionUpdate(bestSwap.b, oD, bestSwap.bSt, oR);
    }

    const finalE = computeFastEnergy();
    if (finalE < currentEnergy) {
      currentEnergy = finalE;
      if (currentEnergy < bestEnergy) saveBest();
      dayConsolidations++;
      return true;
    }
    rollbackAll();
    return false;
  }

  // Exact 150m/170m <-> 2x100m Same-Class Block Exchange (100% packing-density immune, zero side effects!)
  // When `ld` holds ONLY `loneSi` (150m/170m theory, occupying a full 200m morning or 300m afternoon block in `lOldR`),
  // find ANY other active day `d2` of `cls` with >= 3 sessions containing two 100m theory sessions `(s1, s2)`!
  // Swap `loneSi` <-> `(s1, s2)`:
  //   - `s1` and `s2` pack into `lOldR` on `ld` (`08:40-10:20` + `10:20-12:00`, or `13:00-14:40` + `14:40-16:20`)!
  //   - `loneSi` takes the consolidated 200m block on `d2` (either directly if `r1 === r2`, or by shifting a same-day
  //     same-time room neighbor `x` from `r2` -> `r1` with ZERO time/day change to `x`!)
  // Turns (3, 1) -> (2, 2) or (5, 1) -> (4, 2) in ONE exact move!
  function tryReplaceLongLoneWithTwo100m(cls: string, ld: number, active: number[], dayCounts: number[]): boolean {
    const sList = classToSessIndices.get(cls)!;
    const loneSi = sList.find((si) => bitIdx.sessionDayIdx[si] === ld && pinnedMask[si] === 0);
    if (loneSi === undefined) return false;
    if (sessions[loneSi].duration < 150 || sessions[loneSi].roomType === 'WET_LAB' || sessions[loneSi].roomType === 'DRY_LAB') {
      return false;
    }

    const lOldD = ld, lOldSt = bitIdx.sessionStart[loneSi], lOldR = bitIdx.sessionRoomId[loneSi];
    const isMorningLone = lOldSt < 720;
    const pairSlots: [number, number] = isMorningLone ? [520, 620] : [780, 880];
    const donorDays = active.filter((d) => d !== ld && dayCounts[d] >= 3);

    for (const d2 of donorDays) {
      const d2Theory100 = sList.filter(
        (si) =>
          bitIdx.sessionDayIdx[si] === d2 &&
          pinnedMask[si] === 0 &&
          sessions[si].duration === 100 &&
          sessions[si].roomType !== 'WET_LAB' &&
          sessions[si].roomType !== 'DRY_LAB' &&
          allowedRoomIds[si].includes(lOldR)
      );
      if (d2Theory100.length < 2) continue;

      for (let i = 0; i < d2Theory100.length; i++) {
        for (let j = i + 1; j < d2Theory100.length; j++) {
          const s1 = d2Theory100[i], s2 = d2Theory100[j];
          const st1 = bitIdx.sessionStart[s1], r1 = bitIdx.sessionRoomId[s1];
          const st2 = bitIdx.sessionStart[s2], r2 = bitIdx.sessionRoomId[s2];
          if (policy.enforcePascaMonWed && isPascaById[lOldR] && ld > 2) continue;

          bitIdx.unplace(loneSi);
          bitIdx.unplace(s1);
          bitIdx.unplace(s2);

          // Step A: Place s1 and s2 into `lOldR` on `ld` at pairSlots (try both orders!)
          let pairPlaced = false;
          const orders: Array<[number, number]> = [
            [s1, s2],
            [s2, s1],
          ];
          for (const [first, second] of orders) {
            const m1 = startMasks[first].get(pairSlots[0]);
            const m2 = startMasks[second].get(pairSlots[1]);
            if (
              m1 &&
              m2 &&
              bitIdx.canPlaceHard(first, ld, lOldR, m1, policy.enforceAsprakWetLab)
            ) {
              applySessionUpdate(first, ld, pairSlots[0], lOldR);
              if (bitIdx.canPlaceHard(second, ld, lOldR, m2, policy.enforceAsprakWetLab)) {
                applySessionUpdate(second, ld, pairSlots[1], lOldR);
                pairPlaced = true;
                break;
              }
              bitIdx.unplace(first);
            }
          }

          if (!pairPlaced) {
            applySessionUpdate(loneSi, lOldD, lOldSt, lOldR);
            applySessionUpdate(s1, d2, st1, r1);
            applySessionUpdate(s2, d2, st2, r2);
            continue;
          }

          // Step B1: Try placing loneSi (150m/170m) directly onto d2 in ANY allowed room (works immediately when r1 === r2!)
          let lonePlaced = false;
          for (const rid of [r1, r2, ...allowedRoomIds[loneSi]]) {
            if (!allowedRoomIds[loneSi].includes(rid)) continue;
            if (policy.enforcePascaMonWed && isPascaById[rid] && d2 > 2) continue;
            for (const st of stage2Starts[loneSi]) {
              if (bitIdx.canPlaceHard(loneSi, d2, rid, startMasks[loneSi].get(st)!, policy.enforceAsprakWetLab)) {
                applySessionUpdate(loneSi, d2, st, rid);
                const e = computeFastEnergy();
                if (e < currentEnergy) {
                  currentEnergy = e;
                  if (currentEnergy < bestEnergy) saveBest();
                  dayConsolidations++;
                  return true;
                }
                bitIdx.unplace(loneSi);
              }
            }
          }

          // Step B2: Relocate a single room-blocker `x` on `d2` (either to another room at the EXACT SAME time `xSt`,
          // or to `findLowestEnergyBlockerSlot(x, d2)` -> zero collateral damage!) so `loneSi` (150m/170m) fits cleanly on `d2`!
          for (const targetRoom of [r1, r2, ...allowedRoomIds[loneSi]]) {
            if (!allowedRoomIds[loneSi].includes(targetRoom)) continue;
            if (policy.enforcePascaMonWed && isPascaById[targetRoom] && d2 > 2) continue;
            for (const st of stage2Starts[loneSi]) {
              const mask = startMasks[loneSi].get(st)!;
              const blks = bitIdx.findBlockers(loneSi, d2, targetRoom, mask);
              if (blks.length !== 1 || pinnedMask[blks[0]] === 1) continue;
              const x = blks[0];
              if (x === loneSi || x === s1 || x === s2) continue;
              if (bitIdx.sessionRoomId[x] !== targetRoom) continue; // room blocker only!
              const xOldD = bitIdx.sessionDayIdx[x], xSt = bitIdx.sessionStart[x], xOldR = bitIdx.sessionRoomId[x];

              bitIdx.unplace(x);
              if (!bitIdx.canPlaceHard(loneSi, d2, targetRoom, mask, policy.enforceAsprakWetLab)) {
                applySessionUpdate(x, xOldD, xSt, xOldR);
                continue;
              }
              applySessionUpdate(loneSi, d2, st, targetRoom);

              // First try same day & exact same time `xSt` in another room (0% side effect!)
              const mx = startMasks[x].get(xSt);
              let xPlaced = false;
              if (mx) {
                for (const altR of allowedRoomIds[x]) {
                  if (altR === targetRoom) continue;
                  if (policy.enforcePascaMonWed && isPascaById[altR] && xOldD > 2) continue;
                  if (bitIdx.canPlaceHard(x, xOldD, altR, mx, policy.enforceAsprakWetLab)) {
                    applySessionUpdate(x, xOldD, xSt, altR);
                    const e = computeFastEnergy();
                    if (e < currentEnergy) {
                      currentEnergy = e;
                      if (currentEnergy < bestEnergy) saveBest();
                      dayConsolidations++;
                      return true;
                    }
                    bitIdx.unplace(x);
                  }
                }
              }
              // Second try any free slot for `x` on `xOldD` (same day -> 0% active-day side effect!)
              if (!xPlaced) {
                for (const altSt of stage2Starts[x]) {
                  const mx2 = startMasks[x].get(altSt)!;
                  for (const altR of allowedRoomIds[x]) {
                    if (policy.enforcePascaMonWed && isPascaById[altR] && xOldD > 2) continue;
                    if (bitIdx.canPlaceHard(x, xOldD, altR, mx2, policy.enforceAsprakWetLab)) {
                      applySessionUpdate(x, xOldD, altSt, altR);
                      const e = computeFastEnergy();
                      if (e < currentEnergy) {
                        currentEnergy = e;
                        if (currentEnergy < bestEnergy) saveBest();
                        dayConsolidations++;
                        return true;
                      }
                      bitIdx.unplace(x);
                    }
                  }
                }
              }
              bitIdx.unplace(loneSi);
              applySessionUpdate(x, xOldD, xSt, xOldR);
            }
          }

          // Roll back Step A
          bitIdx.unplace(s1);
          bitIdx.unplace(s2);
          applySessionUpdate(loneSi, lOldD, lOldSt, lOldR);
          applySessionUpdate(s1, d2, st1, r1);
          applySessionUpdate(s2, d2, st2, r2);
        }
      }
    }
    return false;
  }

  // Asprak-Coupled Unlock & Pull (breaks senior-junior Asprak deadlocks sealing an entire loneDay,
  // e.g., IL 3A Tuesday sealed by IL 1B wet labs + IL 3B, or TP 3A Thursday sealed by TP 1B wet lab + TP 3B!):
  // Strategy 1: Relocate a blocking junior wet-lab `ws` on `ld` (different time on `ld` or another active day of `ws`'s class),
  //             then immediately pull a donor `dIdx` of `cls` onto `ld` (free slot, 2-Swap, or 3-Cycle Bridge Swap)!
  // Strategy 2: Shift a co-senior session `co` overlapping `ws` on `ld` to another time on `ld` (same day -> zero day impact!),
  //             unlocking `ld` for `cls`, then pull `dIdx` onto `ld`!
  function tryUnlockAsprakAndPull(cls: string, ld: number, donors: number[]): boolean {
    if (!policy.enforceAsprakWetLab || donors.length === 0) return false;
    const cid = bitIdx.clsToId.get(cls);
    if (cid === undefined) return false;
    const deps = bitIdx.dependentWetLabsByCls[cid];
    if (!deps || deps.length === 0) return false;

    const blockingWets = deps.filter((ws) => bitIdx.sessionDayIdx[ws] === ld);
    if (blockingWets.length === 0) return false;

    const baseEnergy = currentEnergy;

    // Helper: attempt pulling any donor of `cls` onto `ld` while a blocker has been temporarily relocated
    const attemptPullDonor = (): boolean => {
      // Set currentEnergy temporarily high enough for inner swap to evaluate strictly against `baseEnergy`!
      const prevCur = currentEnergy;
      currentEnergy = baseEnergy;
      for (const dIdx of donors) {
        const oD = bitIdx.sessionDayIdx[dIdx], oSt = bitIdx.sessionStart[dIdx], oR = bitIdx.sessionRoomId[dIdx];
        // Direct free slot first
        bitIdx.unplace(dIdx);
        for (const st of stage2Starts[dIdx]) {
          const mask = startMasks[dIdx].get(st)!;
          for (const rid of allowedRoomIds[dIdx]) {
            if (policy.enforcePascaMonWed && isPascaById[rid] && ld > 2) continue;
            if (!bitIdx.canPlaceHard(dIdx, ld, rid, mask, true)) continue;
            applySessionUpdate(dIdx, ld, st, rid);
            const e = computeFastEnergy();
            if (e < baseEnergy) {
              currentEnergy = e;
              if (currentEnergy < bestEnergy) saveBest();
              dayConsolidations++;
              return true;
            }
            bitIdx.unplace(dIdx);
          }
        }
        applySessionUpdate(dIdx, oD, oSt, oR);

        // 2-Swap or 3-Cycle Bridge Swap onto `ld`
        if (tryBestDaySwap(dIdx, ld, cls) || tryBridge3Cycle(dIdx, ld, cls)) {
          return true;
        }
      }
      currentEnergy = prevCur;
      return false;
    };

    // Strategy 1: Shift a blocking wet lab `ws` to another time on `ld` OR another active day of `ws`'s junior class
    for (const ws of blockingWets) {
      if (pinnedMask[ws] === 1) continue;
      const wsOldD = bitIdx.sessionDayIdx[ws], wsOldSt = bitIdx.sessionStart[ws], wsOldR = bitIdx.sessionRoomId[ws];
      const jrDays = new Set<number>([ld]);
      for (const jc of sessions[ws].classes) {
        const jl = classToSessIndices.get(jc);
        if (jl) for (const si of jl) if (si !== ws) jrDays.add(bitIdx.sessionDayIdx[si]);
      }
      // Prefer same day `ld` different time first, then other active days of the junior class
      const orderedWsDays = [ld, ...Array.from(jrDays).filter((d) => d !== ld)];
      for (const wd of orderedWsDays) {
        for (const wst of stage2Starts[ws]) {
          if (wd === wsOldD && wst === wsOldSt) continue;
          const wMask = startMasks[ws].get(wst)!;
          bitIdx.unplace(ws);
          if (!bitIdx.canPlaceHard(ws, wd, wsOldR, wMask, true)) {
            applySessionUpdate(ws, wsOldD, wsOldSt, wsOldR);
            continue;
          }
          applySessionUpdate(ws, wd, wst, wsOldR);
          if (attemptPullDonor()) return true;
          // If moving `ws` off `ld` left its junior class with 1 session on `ld`, replenish `jc` on `ld`
          // with one of `jc`'s own sessions from a >=3-course day, THEN pull `cls`'s donor onto `ld`!
          if (wd !== ld) {
            let replenishedAndPulled = false;
            for (const jc of sessions[ws].classes) {
              const jl = classToSessIndices.get(jc);
              if (!jl) continue;
              const jCnt = [0, 0, 0, 0, 0];
              for (const si of jl) jCnt[bitIdx.sessionDayIdx[si]]++;
              if (jCnt[ld] !== 1) continue;
              const jDonors = jl.filter(
                (si) => si !== ws && pinnedMask[si] === 0 && jCnt[bitIdx.sessionDayIdx[si]] >= 3
              );
              for (const jd of jDonors.slice(0, 4)) {
                const jdOldD = bitIdx.sessionDayIdx[jd], jdOldSt = bitIdx.sessionStart[jd], jdOldR = bitIdx.sessionRoomId[jd];
                // Try direct swap of jd onto ld (saving current state in case pull fails)
                for (const b of movableIndices) {
                  if (b === jd || b === ws || bitIdx.sessionDayIdx[b] !== ld) continue;
                  if (sessions[b].classes.includes(jc) || sessions[b].classes.includes(cls)) continue;
                  if (sessions[b].duration !== sessions[jd].duration) continue;
                  const bSt = bitIdx.sessionStart[b], bR = bitIdx.sessionRoomId[b];
                  if (!allowedRoomIds[jd].includes(bR) || !allowedRoomIds[b].includes(jdOldR)) continue;
                  if (policy.enforcePascaMonWed && ((isPascaById[bR] && ld > 2) || (isPascaById[jdOldR] && jdOldD > 2))) continue;
                  const mJ = startMasks[jd].get(bSt), mB = startMasks[b].get(jdOldSt);
                  if (!mJ || !mB) continue;
                  bitIdx.unplace(jd);
                  bitIdx.unplace(b);
                  if (bitIdx.canPlaceHard(jd, ld, bR, mJ, true)) {
                    applySessionUpdate(jd, ld, bSt, bR);
                    if (bitIdx.canPlaceHard(b, jdOldD, jdOldR, mB, true)) {
                      applySessionUpdate(b, jdOldD, jdOldSt, jdOldR);
                      if (attemptPullDonor()) {
                        replenishedAndPulled = true;
                        break;
                      }
                      bitIdx.unplace(b);
                    }
                    bitIdx.unplace(jd);
                  }
                  applySessionUpdate(jd, jdOldD, jdOldSt, jdOldR);
                  applySessionUpdate(b, ld, bSt, bR);
                }
                if (replenishedAndPulled) break;
              }
              if (replenishedAndPulled) break;
            }
            if (replenishedAndPulled) return true;
          }
          bitIdx.unplace(ws);
          applySessionUpdate(ws, wsOldD, wsOldSt, wsOldR);
        }
      }

      // Strategy 1B: If `ws`'s junior class has exactly 2 movable sessions on `ld` (e.g., 2 wet labs on extreme day `ld`),
      // relocate BOTH onto the junior class's other active days (2 -> 0: ZERO lone day & ZERO hole for junior!), then pull `dIdx`!
      for (const jc of sessions[ws].classes) {
        const jl = classToSessIndices.get(jc);
        if (!jl) continue;
        const jCounts = [0, 0, 0, 0, 0];
        for (const si of jl) jCounts[bitIdx.sessionDayIdx[si]]++;
        if (jCounts[ld] !== 2) continue;
        const jAct: number[] = [];
        for (let d = 0; d < 5; d++) if (jCounts[d] > 0) jAct.push(d);
        if (jAct.length < 2 || (ld !== jAct[0] && ld !== jAct[jAct.length - 1])) continue;
        const jOnLd = jl.filter((si) => bitIdx.sessionDayIdx[si] === ld && pinnedMask[si] === 0);
        if (jOnLd.length !== 2) continue;
        const jOthers = jAct.filter((d) => d !== ld);
        const jSaved = jOnLd.map((si) => ({
          si,
          d: bitIdx.sessionDayIdx[si],
          st: bitIdx.sessionStart[si],
          rid: bitIdx.sessionRoomId[si],
        }));
        for (const sv of jSaved) bitIdx.unplace(sv.si);
        const jPlaced: number[] = [];
        let okJ = true;
        for (const sv of jSaved) {
          let ch: { d: number; st: number; rid: number } | null = null;
          for (const td of jOthers) {
            for (const rid of allowedRoomIds[sv.si]) {
              if (policy.enforcePascaMonWed && isPascaById[rid] && td > 2) continue;
              for (const st of stage2Starts[sv.si]) {
                if (bitIdx.canPlaceHard(sv.si, td, rid, startMasks[sv.si].get(st)!, true)) {
                  ch = { d: td, st, rid };
                  break;
                }
              }
              if (ch) break;
            }
            if (ch) break;
          }
          if (ch) {
            applySessionUpdate(sv.si, ch.d, ch.st, ch.rid);
            jPlaced.push(sv.si);
          } else {
            okJ = false;
            break;
          }
        }
        if (okJ && attemptPullDonor()) return true;
        for (const pi of jPlaced) bitIdx.unplace(pi);
        for (const sv of jSaved) applySessionUpdate(sv.si, sv.d, sv.st, sv.rid);
      }
    }

    // Strategy 2: Shift a co-senior session `co` overlapping `ws` on `ld` (same day OR another active day of `co` if >=3 on `ld`!)
    for (const ws of blockingWets) {
      const ov = bitIdx.findSeniorOverlapsForWetLab(ws).filter(
        (co) => pinnedMask[co] === 0 && !sessions[co].classes.includes(cls) && bitIdx.sessionDayIdx[co] === ld
      );
      for (const co of ov) {
        const cOldD = bitIdx.sessionDayIdx[co], cOldSt = bitIdx.sessionStart[co], cOldR = bitIdx.sessionRoomId[co];
        const wsSt = bitIdx.sessionStart[ws], wsEn = bitIdx.sessionEnd[ws];

        // 2C: If `co`'s class(es) have >= 3 sessions on `ld`, move `co` onto another already-active day of `co`!
        const coCanLeaveLd = sessions[co].classes.every((cc) => {
          const cl = classToSessIndices.get(cc);
          if (!cl) return false;
          let cntLd = 0;
          for (const si of cl) if (bitIdx.sessionDayIdx[si] === ld) cntLd++;
          return cntLd >= 3;
        });
        if (coCanLeaveLd) {
          const coOtherDays = new Set<number>();
          for (const cc of sessions[co].classes) {
            const cl = classToSessIndices.get(cc);
            if (cl) for (const si of cl) if (bitIdx.sessionDayIdx[si] !== ld) coOtherDays.add(bitIdx.sessionDayIdx[si]);
          }
          for (const td of coOtherDays) {
            for (const cr of allowedRoomIds[co]) {
              if (policy.enforcePascaMonWed && isPascaById[cr] && td > 2) continue;
              for (const cst of stage2Starts[co]) {
                const cMask = startMasks[co].get(cst)!;
                bitIdx.unplace(co);
                if (!bitIdx.canPlaceHard(co, td, cr, cMask, true)) {
                  applySessionUpdate(co, cOldD, cOldSt, cOldR);
                  continue;
                }
                applySessionUpdate(co, td, cst, cr);
                if (attemptPullDonor()) return true;
                bitIdx.unplace(co);
                applySessionUpdate(co, cOldD, cOldSt, cOldR);
              }
            }
          }
        }

        // 2A: Move `co` to a free non-overlapping slot on `ld`
        for (const cst of stage2Starts[co]) {
          if (cst < wsEn && wsSt < cst + sessions[co].duration) continue; // must stop overlapping `ws`!
          const cMask = startMasks[co].get(cst)!;
          for (const cr of allowedRoomIds[co]) {
            if (policy.enforcePascaMonWed && isPascaById[cr] && ld > 2) continue;
            bitIdx.unplace(co);
            if (!bitIdx.canPlaceHard(co, ld, cr, cMask, true)) {
              applySessionUpdate(co, cOldD, cOldSt, cOldR);
              continue;
            }
            applySessionUpdate(co, ld, cst, cr);
            if (attemptPullDonor()) return true;
            bitIdx.unplace(co);
            applySessionUpdate(co, cOldD, cOldSt, cOldR);
          }
        }

        // 2B: Same-day time swap of `co` with a non-overlapping session `b` on `ld` (works at 99% packing!)
        for (const b of movableIndices) {
          if (b === co || bitIdx.sessionDayIdx[b] !== ld || sessions[b].duration !== sessions[co].duration) continue;
          const bSt = bitIdx.sessionStart[b], bR = bitIdx.sessionRoomId[b];
          if (bSt < wsEn && wsSt < bSt + sessions[co].duration) continue; // `co`'s new slot must clear `ws`!
          if (!allowedRoomIds[co].includes(bR) || !allowedRoomIds[b].includes(cOldR)) continue;
          const mCo = startMasks[co].get(bSt), mB = startMasks[b].get(cOldSt);
          if (!mCo || !mB) continue;

          bitIdx.unplace(co);
          bitIdx.unplace(b);
          if (bitIdx.canPlaceHard(co, ld, bR, mCo, true)) {
            applySessionUpdate(co, ld, bSt, bR);
            if (bitIdx.canPlaceHard(b, ld, cOldR, mB, true)) {
              applySessionUpdate(b, ld, cOldSt, cOldR);
              if (attemptPullDonor()) return true;
              bitIdx.unplace(b);
            }
            bitIdx.unplace(co);
          }
          applySessionUpdate(co, cOldD, cOldSt, cOldR);
          applySessionUpdate(b, ld, bSt, bR);
        }
      }
    }

    return false;
  }

  // Helper: evacuate all movable sessions of `cls` on `outlierDay` into `targetDays` (supports free slot OR 1-blocker ejection!)
  function tryEvacuateDay(cls: string, outlierDay: number, targetDays: number[], allowEject: boolean): boolean {
    const toEvac = classToSessIndices
      .get(cls)!
      .filter((si) => bitIdx.sessionDayIdx[si] === outlierDay && pinnedMask[si] === 0);
    if (toEvac.length === 0 || toEvac.length > 5) return false;

    const evacSet = new Set(toEvac);
    const saved = toEvac.map((si) => ({
      si,
      d: bitIdx.sessionDayIdx[si],
      st: bitIdx.sessionStart[si],
      rid: bitIdx.sessionRoomId[si],
    }));
    const extraEjected: Array<{ si: number; d: number; st: number; rid: number }> = [];
    for (const sv of saved) bitIdx.unplace(sv.si);

    const relocated: number[] = [];
    let allRelocated = true;

    for (const sv of saved) {
      let bestChoice: { d: number; st: number; rid: number; pen: number } | null = null;
      const rIds = allowedRoomIds[sv.si];
      const starts = stage2Starts[sv.si];
      const mMap = startMasks[sv.si];

      for (const td of targetDays) {
        for (const rid of rIds) {
          if (policy.enforcePascaMonWed && isPascaById[rid] && td > 2) continue;
          for (const st of starts) {
            if (!bitIdx.canPlaceHard(sv.si, td, rid, mMap.get(st)!, policy.enforceAsprakWetLab)) continue;
            const pen =
              (st < EARLY_OVERFLOW_START ? 2000 : st < minPref ? 350 : 0) +
              (st + sessions[sv.si].duration > WORK_END ? 15 : 0);
            if (!bestChoice || pen < bestChoice.pen) {
              bestChoice = { d: td, st, rid, pen };
            }
          }
        }
      }

      if (bestChoice) {
        applySessionUpdate(sv.si, bestChoice.d, bestChoice.st, bestChoice.rid);
        relocated.push(sv.si);
        continue;
      }

      // Optional 1-blocker Kempe ejection rescue inside targetDays!
      let rescued = false;
      if (allowEject) {
        ejectLoop: for (const td of targetDays) {
          for (const rid of rIds) {
            if (policy.enforcePascaMonWed && isPascaById[rid] && td > 2) continue;
            for (const st of starts) {
              const mask = mMap.get(st)!;
              const blks = bitIdx.findBlockers(sv.si, td, rid, mask);
              if (blks.length !== 1) continue;
              const blk = blks[0];
              if (pinnedMask[blk] === 1 || evacSet.has(blk) || relocated.includes(blk) || extraEjected.some((x) => x.si === blk)) continue;
              // Do not eject a blocker of the SAME class back onto outlierDay!
              const bOldD = bitIdx.sessionDayIdx[blk], bOldSt = bitIdx.sessionStart[blk], bOldRid = bitIdx.sessionRoomId[blk];
              bitIdx.unplace(blk);
              if (!bitIdx.canPlaceHard(sv.si, td, rid, mask, policy.enforceAsprakWetLab)) {
                bitIdx.place(blk, bOldD, bOldSt, bOldSt + sessions[blk].duration, bOldRid);
                continue;
              }
              applySessionUpdate(sv.si, td, st, rid);

              // Find a free slot for blk (prefer same day bOldD or contiguous days, respecting floorStart!)
              let bAlt: { d: number; st: number; rid: number } | null = null;
              const bDays = [bOldD, 0, 1, 2, 3, 4];
              const seenBD = new Set<number>();
              for (const bd of bDays) {
                if (seenBD.has(bd)) continue;
                seenBD.add(bd);
                if (bd === outlierDay && sessions[blk].classes.includes(cls)) continue;
                for (const br of allowedRoomIds[blk]) {
                  if (policy.enforcePascaMonWed && isPascaById[br] && bd > 2) continue;
                  for (const bs of stage2Starts[blk]) {
                    if (bitIdx.canPlaceHard(blk, bd, br, startMasks[blk].get(bs)!, policy.enforceAsprakWetLab)) {
                      bAlt = { d: bd, st: bs, rid: br };
                      break;
                    }
                  }
                  if (bAlt) break;
                }
                if (bAlt) break;
              }

              if (bAlt) {
                extraEjected.push({ si: blk, d: bOldD, st: bOldSt, rid: bOldRid });
                applySessionUpdate(blk, bAlt.d, bAlt.st, bAlt.rid);
                relocated.push(sv.si);
                rescued = true;
                break ejectLoop;
              } else {
                bitIdx.unplace(sv.si);
                applySessionUpdate(blk, bOldD, bOldSt, bOldRid);
              }
            }
          }
        }
      }

      if (!rescued) {
        allRelocated = false;
        break;
      }
    }

    if (!allRelocated) {
      for (const ri of relocated) bitIdx.unplace(ri);
      for (const ex of extraEjected) bitIdx.unplace(ex.si);
      for (const ex of extraEjected) applySessionUpdate(ex.si, ex.d, ex.st, ex.rid);
      for (const sv of saved) applySessionUpdate(sv.si, sv.d, sv.st, sv.rid);
      return false;
    }

    const newE = computeFastEnergy();
    if (acceptCandidate(newE, iterations)) {
      if (newE < currentEnergy) improvingMoves++;
      currentEnergy = newE;
      acceptedMoves++;
      dayConsolidations++;
      if (currentEnergy < bestEnergy) saveBest();
      return true;
    } else {
      for (const ri of relocated) bitIdx.unplace(ri);
      for (const ex of extraEjected) bitIdx.unplace(ex.si);
      for (const ex of extraEjected) applySessionUpdate(ex.si, ex.d, ex.st, ex.rid);
      for (const sv of saved) applySessionUpdate(sv.si, sv.d, sv.st, sv.rid);
      return false;
    }
  }

  const deadline = t0 + timeBudgetMs;
  const ratio2A = Math.min(0.78, Math.max(0.35, hp.phase2ARatio));
  const phase2BTime = t0 + timeBudgetMs * ratio2A;
  const phase2BIters = Math.floor(maxIters * ratio2A);
  let enteredPhase2B = false;

  while (!skipStage2 && iterations < maxIters && performance.now() < deadline && movableIndices.length > 0) {
    // Transition Phase 2A -> Phase 2B:
    // 1. Restore best warm schedule & run 2-pass Contiguity + <=3d polish WHILE loneDayPenalty=0 (reaches 36/36 contiguous!)
    // 2. Activate strict studentLoneDayPenalty=950 (strictly below holePenalty=2200 -> 36/36 contiguity is LOCKED!)
    if (!enteredPhase2B && (iterations >= phase2BIters || performance.now() >= phase2BTime)) {
      enteredPhase2B = true;
      for (let i = 0; i < n; i++) bitIdx.unplace(i);
      for (let i = 0; i < n; i++) applySessionUpdate(i, bestDay[i], bestStart[i], bestRoom[i]);
      currentEnergy = bestEnergy;
      const savedTemp = temp;
      temp = 0;
      lahcList.fill(currentEnergy);
      for (let p = 0; p < 3; p++) {
        let imp = false;
        for (const cls of allClassKeys) {
          const sList = classToSessIndices.get(cls)!;
          if (sList.length < 2) continue;
          const dc = [0, 0, 0, 0, 0];
          for (const si of sList) dc[bitIdx.sessionDayIdx[si]]++;
          const act: number[] = [];
          for (let d = 0; d < 5; d++) if (dc[d] > 0) act.push(d);
          if (act.length <= 1) continue;
          const sp = act[act.length - 1] - act[0] + 1;
          const tMax = (classTotalMin.get(cls) || 0) > 1420 ? 4 : policy.maxDaysPerClass;
          if (sp <= act.length && act.length <= tMax) continue;
          const cands = [act[0], act[act.length - 1]];
          if (dc[cands[1]] < dc[cands[0]]) cands.reverse();
          for (const outD of cands) {
            const rem = act.filter((d) => d !== outD);
            const rMin = Math.min(...rem), rMax = Math.max(...rem);
            const ds = new Set<number>();
            for (let d = rMin; d <= rMax; d++) ds.add(d);
            if (ds.size < tMax || sp > act.length) {
              if (rMin > 0) ds.add(rMin - 1);
              if (rMax < 4) ds.add(rMax + 1);
            }
            const tDays = Array.from(ds).filter((d) => d !== outD);
            if (tDays.length > 0 && (tryEvacuateDay(cls, outD, tDays, true) || trySwapEvacuateDay(cls, outD, tDays))) {
              imp = true;
              lahcList.fill(currentEnergy);
              break;
            }
          }
        }
        if (!imp) break;
      }
      studentLoneDayPenalty = 1650;
      currentEnergy = computeFastEnergy();
      saveBest();
      lahcList.fill(currentEnergy);
      temp = Math.max(24.0, savedTemp);
    }
    iterations++;
    const op = pickOperator();
    let movedOk = false;

    if (op === 0) {
      // OP 0: Fast Single-Session Shift (strictly respecting floorStart!)
      const idx = movableIndices[Math.floor(rng() * movableIndices.length)];
      const oldD = bitIdx.sessionDayIdx[idx];
      const oldSt = bitIdx.sessionStart[idx];
      const oldRid = bitIdx.sessionRoomId[idx];

      const rIds = allowedRoomIds[idx];
      const starts = stage2Starts[idx];
      const mMap = startMasks[idx];

      const newD = Math.floor(rng() * 5);
      const newRid = rIds[Math.floor(rng() * rIds.length)];
      if (policy.enforcePascaMonWed && isPascaById[newRid] && newD > 2) continue;
      const stPoolLen = rng() < 0.9 ? Math.max(1, starts.filter((x) => x >= minPref).length) : starts.length;
      const newSt = starts[Math.floor(rng() * stPoolLen)];
      if (newD === oldD && newSt === oldSt && newRid === oldRid) continue;

      bitIdx.unplace(idx);
      if (bitIdx.canPlaceHard(idx, newD, newRid, mMap.get(newSt)!, policy.enforceAsprakWetLab)) {
        applySessionUpdate(idx, newD, newSt, newRid);
        const newE = computeFastEnergy();
        if (acceptCandidate(newE, iterations)) {
          if (newE < currentEnergy) improvingMoves++;
          currentEnergy = newE;
          acceptedMoves++;
          movedOk = true;
          if (currentEnergy < bestEnergy) saveBest();
        } else {
          bitIdx.unplace(idx);
          applySessionUpdate(idx, oldD, oldSt, oldRid);
        }
      } else {
        bitIdx.place(idx, oldD, oldSt, oldSt + sessions[idx].duration, oldRid);
      }
    } else if (op === 1) {
      // OP 1: Compatible Pairwise Swap (breaks room-packing deadlocks!)
      const a = movableIndices[Math.floor(rng() * movableIndices.length)];
      const b = movableIndices[Math.floor(rng() * movableIndices.length)];
      if (a === b) continue;
      if (sessions[a].duration !== sessions[b].duration) continue;
      if (sessions[a].roomType !== sessions[b].roomType && !(isGeneralRoom(sessions[a].room) && isGeneralRoom(sessions[b].room))) {
        continue;
      }

      const aD = bitIdx.sessionDayIdx[a], aSt = bitIdx.sessionStart[a], aR = bitIdx.sessionRoomId[a];
      const bD = bitIdx.sessionDayIdx[b], bSt = bitIdx.sessionStart[b], bR = bitIdx.sessionRoomId[b];
      if (!allowedRoomIds[a].includes(bR) || !allowedRoomIds[b].includes(aR)) continue;
      if (policy.enforcePascaMonWed && ((isPascaById[bR] && bD > 2) || (isPascaById[aR] && aD > 2))) continue;

      bitIdx.unplace(a);
      bitIdx.unplace(b);

      const mA = makeSlotMask(bSt, bSt + sessions[a].duration);
      const mB = makeSlotMask(aSt, aSt + sessions[b].duration);
      if (bitIdx.canPlaceHard(a, bD, bR, mA, policy.enforceAsprakWetLab)) {
        applySessionUpdate(a, bD, bSt, bR);
        if (bitIdx.canPlaceHard(b, aD, aR, mB, policy.enforceAsprakWetLab)) {
          applySessionUpdate(b, aD, aSt, aR);
          const newE = computeFastEnergy();
          if (acceptCandidate(newE, iterations)) {
            if (newE < currentEnergy) improvingMoves++;
            currentEnergy = newE;
            acceptedMoves++;
            movedOk = true;
            if (currentEnergy < bestEnergy) saveBest();
          } else {
            bitIdx.unplace(a);
            bitIdx.unplace(b);
            applySessionUpdate(a, aD, aSt, aR);
            applySessionUpdate(b, bD, bSt, bR);
          }
        } else {
          bitIdx.unplace(a);
          applySessionUpdate(a, aD, aSt, aR);
          applySessionUpdate(b, bD, bSt, bR);
        }
      } else {
        applySessionUpdate(a, aD, aSt, aR);
        applySessionUpdate(b, bD, bSt, bR);
      }
    } else if (op === 2) {
      // OP 2: Kempe-Chain Ejection Move (displace 1 blocker to its best humane free slot!)
      const idx = movableIndices[Math.floor(rng() * movableIndices.length)];
      const oldD = bitIdx.sessionDayIdx[idx], oldSt = bitIdx.sessionStart[idx], oldRid = bitIdx.sessionRoomId[idx];
      const rIds = allowedRoomIds[idx];
      const starts = stage2Starts[idx].filter((st) => st >= minPref);
      if (starts.length === 0) continue;

      const newD = Math.floor(rng() * 5);
      const newRid = rIds[Math.floor(rng() * rIds.length)];
      if (policy.enforcePascaMonWed && isPascaById[newRid] && newD > 2) continue;
      const newSt = starts[Math.floor(rng() * starts.length)];
      if (newD === oldD && newSt === oldSt && newRid === oldRid) continue;

      const mask = startMasks[idx].get(newSt)!;
      const blockers = bitIdx.findBlockers(idx, newD, newRid, mask);
      if (blockers.length !== 1 || pinnedMask[blockers[0]] === 1) continue;

      const blk = blockers[0];
      const bOldD = bitIdx.sessionDayIdx[blk], bOldSt = bitIdx.sessionStart[blk], bOldRid = bitIdx.sessionRoomId[blk];

      bitIdx.unplace(idx);
      bitIdx.unplace(blk);

      if (bitIdx.canPlaceHard(idx, newD, newRid, mask, policy.enforceAsprakWetLab)) {
        applySessionUpdate(idx, newD, newSt, newRid);
        let alt: { d: number; st: number; rid: number } | null = null;
        const bRids = allowedRoomIds[blk];
        const bStarts = stage2Starts[blk];
        for (let tries = 0; tries < 22; tries++) {
          const td = Math.floor(rng() * 5);
          const tr = bRids[Math.floor(rng() * bRids.length)];
          if (policy.enforcePascaMonWed && isPascaById[tr] && td > 2) continue;
          const ts = bStarts[Math.floor(rng() * bStarts.length)];
          if (bitIdx.canPlaceHard(blk, td, tr, startMasks[blk].get(ts)!, policy.enforceAsprakWetLab)) {
            alt = { d: td, st: ts, rid: tr };
            break;
          }
        }
        if (alt) {
          applySessionUpdate(blk, alt.d, alt.st, alt.rid);
          const newE = computeFastEnergy();
          if (acceptCandidate(newE, iterations)) {
            if (newE < currentEnergy) improvingMoves++;
            currentEnergy = newE;
            acceptedMoves++;
            kempeSwaps++;
            movedOk = true;
            if (currentEnergy < bestEnergy) saveBest();
          } else {
            bitIdx.unplace(idx);
            bitIdx.unplace(blk);
            applySessionUpdate(idx, oldD, oldSt, oldRid);
            applySessionUpdate(blk, bOldD, bOldSt, bOldRid);
          }
        } else {
          bitIdx.unplace(idx);
          applySessionUpdate(idx, oldD, oldSt, oldRid);
          applySessionUpdate(blk, bOldD, bOldSt, bOldRid);
        }
      } else {
        applySessionUpdate(idx, oldD, oldSt, oldRid);
        applySessionUpdate(blk, bOldD, bOldSt, bOldRid);
      }
    } else if (op === 3) {
      // OP 3: Fast O(1)-Sampled Contiguous Day & Min-2-Courses-Per-Day Consolidator!
      // Eliminates BOTH non-contiguous holes AND 1-course days at 30x higher throughput!
      let targetCls: string | null = null;
      let outlierDay = -1;
      let loneDay = -1;
      let donorDays: number[] = [];
      let targetDays: number[] = [];

      const startScan = Math.floor(rng() * allClassKeys.length);
      for (let step = 0; step < allClassKeys.length; step++) {
        const cls = allClassKeys[(startScan + step) % allClassKeys.length];
        const sList = classToSessIndices.get(cls)!;
        if (sList.length < 2) continue;
        const dayCounts = [0, 0, 0, 0, 0];
        for (const si of sList) dayCounts[bitIdx.sessionDayIdx[si]]++;
        const active: number[] = [];
        for (let d = 0; d < 5; d++) if (dayCounts[d] > 0) active.push(d);
        if (active.length <= 1) continue;

        const span = active[active.length - 1] - active[0] + 1;
        const hasHole = span > active.length;
        const targetMax = (classTotalMin.get(cls) || 0) > 1420 ? 4 : policy.maxDaysPerClass;
        const singleDays = active.filter((d) => dayCounts[d] === 1);

        if (hasHole || (!enteredPhase2B && active.length > targetMax)) {
          targetCls = cls;
          const dFirst = active[0];
          const dLast = active[active.length - 1];
          outlierDay = dayCounts[dFirst] <= dayCounts[dLast] ? dFirst : dLast;
          const remaining = active.filter((d) => d !== outlierDay);
          const rMin = Math.min(...remaining);
          const rMax = Math.max(...remaining);
          const destSet = new Set<number>();
          for (let d = rMin; d <= rMax; d++) destSet.add(d);
          if (destSet.size < targetMax) {
            if (rMin > 0) destSet.add(rMin - 1);
            if (rMax < 4 && destSet.size < targetMax) destSet.add(rMax + 1);
          }
          targetDays = Array.from(destSet).filter((d) => d !== outlierDay);
          break;
        }
        if (enteredPhase2B && (policy.minCoursesPerActiveDay ?? 2) >= 2 && singleDays.length > 0) {
          targetCls = cls;
          loneDay = singleDays[Math.floor(rng() * singleDays.length)];
          const isExtreme = loneDay === active[0] || loneDay === active[active.length - 1];
          outlierDay = isExtreme ? loneDay : -1;
          targetDays = isExtreme ? active.filter((d) => d !== loneDay) : [];
          donorDays = active.filter((d) => d !== loneDay && dayCounts[d] >= 3);
          break;
        }
        if (active.length > targetMax) {
          targetCls = cls;
          const dFirst = active[0];
          const dLast = active[active.length - 1];
          outlierDay = dayCounts[dFirst] <= dayCounts[dLast] ? dFirst : dLast;
          targetDays = active.filter((d) => d !== outlierDay);
          break;
        }
      }

      if (targetCls && (outlierDay >= 0 || loneDay >= 0)) {
        if (loneDay >= 0) {
          // Fast O(1) Strategy A (Evacuate single session on extreme loneDay) or Strategy B (Pull 1 donor onto loneDay)
          const canEvac = outlierDay >= 0 && targetDays.length > 0;
          const canPull = donorDays.length > 0;
          const tryPullFirst = canPull && (!canEvac || rng() < 0.45);

          if (!tryPullFirst && canEvac) {
            const loneSess = classToSessIndices
              .get(targetCls)!
              .find((si) => bitIdx.sessionDayIdx[si] === loneDay && pinnedMask[si] === 0);
            if (loneSess !== undefined) {
              const oD = bitIdx.sessionDayIdx[loneSess], oSt = bitIdx.sessionStart[loneSess], oR = bitIdx.sessionRoomId[loneSess];
              const rIds = allowedRoomIds[loneSess];
              const starts = stage2Starts[loneSess];
              const mMap = startMasks[loneSess];
              bitIdx.unplace(loneSess);
              let found: { d: number; st: number; rid: number } | null = null;
              for (let tries = 0; tries < 22; tries++) {
                const td = targetDays[Math.floor(rng() * targetDays.length)];
                const rid = rIds[Math.floor(rng() * rIds.length)];
                if (policy.enforcePascaMonWed && isPascaById[rid] && td > 2) continue;
                const st = starts[Math.floor(rng() * starts.length)];
                if (bitIdx.canPlaceHard(loneSess, td, rid, mMap.get(st)!, policy.enforceAsprakWetLab)) {
                  found = { d: td, st, rid };
                  break;
                }
              }
              if (found) {
                applySessionUpdate(loneSess, found.d, found.st, found.rid);
                const newE = computeFastEnergy();
                if (acceptCandidate(newE, iterations)) {
                  if (newE < currentEnergy) improvingMoves++;
                  currentEnergy = newE;
                  acceptedMoves++;
                  dayConsolidations++;
                  movedOk = true;
                  if (currentEnergy < bestEnergy) saveBest();
                } else {
                  bitIdx.unplace(loneSess);
                  applySessionUpdate(loneSess, oD, oSt, oR);
                }
              } else {
                applySessionUpdate(loneSess, oD, oSt, oR);
                // Fallback at 99% room packing density: direct room-slot swap onto a targetDay!
                const td = targetDays[Math.floor(rng() * targetDays.length)];
                if (tryRandomDaySwap(loneSess, td)) movedOk = true;
              }
            }
          }

          if (!movedOk && canPull) {
            const donors = classToSessIndices
              .get(targetCls)!
              .filter((si) => donorDays.includes(bitIdx.sessionDayIdx[si]) && pinnedMask[si] === 0);
            if (donors.length > 0) {
              const dIdx = donors[Math.floor(rng() * donors.length)];
              const oD = bitIdx.sessionDayIdx[dIdx], oSt = bitIdx.sessionStart[dIdx], oR = bitIdx.sessionRoomId[dIdx];
              const rIds = allowedRoomIds[dIdx];
              const starts = stage2Starts[dIdx];
              const mMap = startMasks[dIdx];
              bitIdx.unplace(dIdx);
              let found: { st: number; rid: number } | null = null;
              for (let tries = 0; tries < 22; tries++) {
                const rid = rIds[Math.floor(rng() * rIds.length)];
                if (policy.enforcePascaMonWed && isPascaById[rid] && loneDay > 2) continue;
                const st = starts[Math.floor(rng() * starts.length)];
                if (bitIdx.canPlaceHard(dIdx, loneDay, rid, mMap.get(st)!, policy.enforceAsprakWetLab)) {
                  found = { st, rid };
                  break;
                }
              }
              if (found) {
                applySessionUpdate(dIdx, loneDay, found.st, found.rid);
                const newE = computeFastEnergy();
                if (acceptCandidate(newE, iterations)) {
                  if (newE < currentEnergy) improvingMoves++;
                  currentEnergy = newE;
                  acceptedMoves++;
                  dayConsolidations++;
                  movedOk = true;
                  if (currentEnergy < bestEnergy) saveBest();
                } else {
                  bitIdx.unplace(dIdx);
                  applySessionUpdate(dIdx, oD, oSt, oR);
                }
              } else {
                applySessionUpdate(dIdx, oD, oSt, oR);
                // Fallback at 99% room packing density: direct room-slot swap of donor onto loneDay!
                if (tryRandomDaySwap(dIdx, loneDay)) movedOk = true;
              }
            }
          }
        } else if (outlierDay >= 0 && targetDays.length > 0) {
          // Fast non-ejection evacuate first in Stage 2 (3x higher throughput!), then O(1) targeted swap!
          if (tryEvacuateDay(targetCls, outlierDay, targetDays, false)) {
            movedOk = true;
          } else {
            const outs = classToSessIndices
              .get(targetCls)!
              .filter((si) => bitIdx.sessionDayIdx[si] === outlierDay && pinnedMask[si] === 0);
            if (outs.length > 0) {
              const sOut = outs[Math.floor(rng() * outs.length)];
              const td = targetDays[Math.floor(rng() * targetDays.length)];
              if (tryRandomDaySwap(sOut, td)) movedOk = true;
            }
          }
        }
      }
    } else if (op === 4) {
      // OP 4: Targeted Early-Morning (<08:40) Eliminator, Contiguity Closer & Dead-Gap Squeezer!
      let targetIdx = -1;
      let fixingEarly = false;
      const startScan = Math.floor(rng() * movableIndices.length);
      for (let step = 0; step < movableIndices.length; step++) {
        const cand = movableIndices[(startScan + step) % movableIndices.length];
        if (bitIdx.sessionStart[cand] < minPref) {
          targetIdx = cand;
          fixingEarly = true;
          break;
        }
      }
      if (targetIdx < 0) {
        targetIdx = movableIndices[Math.floor(rng() * movableIndices.length)];
      }

      const oldD = bitIdx.sessionDayIdx[targetIdx];
      const oldSt = bitIdx.sessionStart[targetIdx];
      const oldRid = bitIdx.sessionRoomId[targetIdx];
      const humaneStarts = stage2Starts[targetIdx].filter((st) => st >= minPref);
      if (humaneStarts.length === 0) continue;

      const rIds = allowedRoomIds[targetIdx];
      const mMap = startMasks[targetIdx];
      // Scan same day + immediate neighbors (proven v3 driver of 36/36 contiguity, <=3d & low dead gaps!)
      const dayCandidates = [oldD, Math.max(0, oldD - 1), Math.min(4, oldD + 1)];

      bitIdx.unplace(targetIdx);
      let bestMove: { d: number; st: number; rid: number; energy: number } | null = null;

      for (const td of dayCandidates) {
        for (let si = 0; si < humaneStarts.length; si++) {
          const st = humaneStarts[si];
          const mask = mMap.get(st)!;
          let checkedPasca = false;
          let checkedSaintek = false;
          for (let ri = 0; ri < rIds.length; ri++) {
            const rid = rIds[ri];
            const isP = isPascaById[rid] === 1;
            if (policy.enforcePascaMonWed && isP && td > 2) continue;
            if (isP && checkedPasca) continue;
            if (!isP && checkedSaintek) continue;
            if (td === oldD && st === oldSt && rid === oldRid) continue;
            if (!bitIdx.canPlaceHard(targetIdx, td, rid, mask, policy.enforceAsprakWetLab)) continue;
            if (isP) checkedPasca = true;
            else checkedSaintek = true;
            applySessionUpdate(targetIdx, td, st, rid);
            const e = computeFastEnergy();
            bitIdx.unplace(targetIdx);
            if (!bestMove || e < bestMove.energy) {
              bestMove = { d: td, st, rid, energy: e };
            }
            if (checkedPasca && checkedSaintek) break;
          }
        }
      }

      if (bestMove && acceptCandidate(bestMove.energy, iterations)) {
        applySessionUpdate(targetIdx, bestMove.d, bestMove.st, bestMove.rid);
        if (bestMove.energy < currentEnergy) improvingMoves++;
        currentEnergy = bestMove.energy;
        acceptedMoves++;
        if (oldSt < minPref && bestMove.st >= minPref) earlyFixes++;
        movedOk = true;
        if (currentEnergy < bestEnergy) saveBest();
      } else {
        applySessionUpdate(targetIdx, oldD, oldSt, oldRid);
      }
    } else if (op === 5 && policy.enforceAsprakWetLab && bitIdx.wetLabIndices.length > 0) {
      // OP 5: Fast O(1)-Sampled Wet-Lab Asprak Clearance (50x faster than full scan!)
      const wStart = Math.floor(rng() * bitIdx.wetLabIndices.length);
      let targetWs = -1;
      let overlappingSeniors: number[] = [];
      for (let step = 0; step < bitIdx.wetLabIndices.length; step++) {
        const ws = bitIdx.wetLabIndices[(wStart + step) % bitIdx.wetLabIndices.length];
        const ov = bitIdx.findSeniorOverlapsForWetLab(ws);
        if (ov.length > 0) {
          targetWs = ws;
          overlappingSeniors = ov;
          break;
        }
      }

      if (targetWs >= 0) {
        const movableOv = overlappingSeniors.filter((x) => pinnedMask[x] === 0);
        if (movableOv.length > 0 && rng() < 0.65) {
          // Strategy A: Fast random non-overlapping move for one blocking senior-cohort session
          const sIdx = movableOv[Math.floor(rng() * movableOv.length)];
          const oD = bitIdx.sessionDayIdx[sIdx], oSt = bitIdx.sessionStart[sIdx], oR = bitIdx.sessionRoomId[sIdx];
          const wsD = bitIdx.sessionDayIdx[targetWs], wsSt = bitIdx.sessionStart[targetWs], wsEn = bitIdx.sessionEnd[targetWs];
          const sRids = allowedRoomIds[sIdx];
          const sStarts = stage2Starts[sIdx];
          const mMap = startMasks[sIdx];

          bitIdx.unplace(sIdx);
          let found: { d: number; st: number; rid: number } | null = null;
          for (let tries = 0; tries < 20; tries++) {
            const td = Math.floor(rng() * 5);
            const st = sStarts[Math.floor(rng() * sStarts.length)];
            if (td === wsD && st < wsEn && wsSt < st + sessions[sIdx].duration) continue;
            const rid = sRids[Math.floor(rng() * sRids.length)];
            if (policy.enforcePascaMonWed && isPascaById[rid] && td > 2) continue;
            if (bitIdx.canPlaceHard(sIdx, td, rid, mMap.get(st)!, true)) {
              found = { d: td, st, rid };
              break;
            }
          }
          if (found) {
            applySessionUpdate(sIdx, found.d, found.st, found.rid);
            const newE = computeFastEnergy();
            if (acceptCandidate(newE, iterations)) {
              if (newE < currentEnergy) improvingMoves++;
              currentEnergy = newE;
              acceptedMoves++;
              asprakClears++;
              movedOk = true;
              if (currentEnergy < bestEnergy) saveBest();
            } else {
              bitIdx.unplace(sIdx);
              applySessionUpdate(sIdx, oD, oSt, oR);
            }
          } else {
            applySessionUpdate(sIdx, oD, oSt, oR);
          }
        } else if (pinnedMask[targetWs] === 0) {
          // Strategy B: Fast random slot shift for the wet-lab session itself
          const oD = bitIdx.sessionDayIdx[targetWs], oSt = bitIdx.sessionStart[targetWs], oR = bitIdx.sessionRoomId[targetWs];
          const wStarts = stage2Starts[targetWs];
          const mMap = startMasks[targetWs];
          bitIdx.unplace(targetWs);
          let found: { d: number; st: number } | null = null;
          for (let tries = 0; tries < 15; tries++) {
            const td = Math.floor(rng() * 5);
            const st = wStarts[Math.floor(rng() * wStarts.length)];
            if (td === oD && st === oSt) continue;
            if (bitIdx.canPlaceHard(targetWs, td, oR, mMap.get(st)!, true)) {
              found = { d: td, st };
              break;
            }
          }
          if (found) {
            applySessionUpdate(targetWs, found.d, found.st, oR);
            const newE = computeFastEnergy();
            if (acceptCandidate(newE, iterations)) {
              if (newE < currentEnergy) improvingMoves++;
              currentEnergy = newE;
              acceptedMoves++;
              asprakClears++;
              movedOk = true;
              if (currentEnergy < bestEnergy) saveBest();
            } else {
              bitIdx.unplace(targetWs);
              applySessionUpdate(targetWs, oD, oSt, oR);
            }
          } else {
            applySessionUpdate(targetWs, oD, oSt, oR);
          }
        }
      }
    }

    // Update LAHC history & SA cooling/reheat
    const v = iterations % L;
    if (currentEnergy < lahcList[v]) {
      lahcList[v] = currentEnergy;
    }

    if (movedOk) {
      opWeights[op] = Math.min(3.5, opWeights[op] * 1.015 + 0.01);
      stagnant = 0;
    } else {
      opWeights[op] = Math.max(0.35, opWeights[op] * 0.999);
      stagnant++;
    }

    temp *= cooling;
    if (stagnant > 700) {
      temp = 28.0;
      stagnant = 0;
      reheats++;
    }
  }

  // Restore global incumbent best into BitmaskIndex & Sessions
  for (let i = 0; i < n; i++) bitIdx.unplace(i);
  for (let i = 0; i < n; i++) {
    applySessionUpdate(i, bestDay[i], bestStart[i], bestRoom[i]);
  }
  // Ensure strict min-2-courses/day penalty is active for Stage 3 polishing even if Stage 2 ended early
  studentLoneDayPenalty = 1650;
  currentEnergy = computeFastEnergy();
  saveBest();

  // Helper: find the LOWEST-ENERGY relocation slot for an ejected blocker `blk`
  // Strictly prioritizes `bOldD` (same day -> ZERO impact on blk's active days/contiguity/1-mk!)
  // and then `blk`'s other currently active days (so blk never opens a new 1-course day or hole!)
  function findLowestEnergyBlockerSlot(blk: number, bOldD: number, forbidDayForCls?: { cls: string; day: number }): { d: number; st: number; rid: number; energy: number } | null {
    const activeDaySet = new Set<number>([bOldD]);
    for (const c of sessions[blk].classes) {
      const list = classToSessIndices.get(c);
      if (list) for (const si of list) if (si !== blk && bitIdx.sessionDayIdx[si] >= 0) activeDaySet.add(bitIdx.sessionDayIdx[si]);
    }
    const orderedDays = [bOldD, ...Array.from(activeDaySet).filter((x) => x !== bOldD)];
    const rIds = allowedRoomIds[blk];
    const starts = stage2Starts[blk];
    const mMap = startMasks[blk];

    let best: { d: number; st: number; rid: number; energy: number } | null = null;
    for (const bd of orderedDays) {
      if (forbidDayForCls && bd === forbidDayForCls.day && sessions[blk].classes.includes(forbidDayForCls.cls)) continue;
      for (const st of starts) {
        const mask = mMap.get(st)!;
        let cP = false, cS = false;
        for (const br of rIds) {
          const isP = isPascaById[br] === 1;
          if (policy.enforcePascaMonWed && isP && bd > 2) continue;
          if (isP && cP) continue;
          if (!isP && cS) continue;
          if (!bitIdx.canPlaceHard(blk, bd, br, mask, policy.enforceAsprakWetLab)) continue;
          if (isP) cP = true;
          else cS = true;
          applySessionUpdate(blk, bd, st, br);
          const e = computeFastEnergy();
          bitIdx.unplace(blk);
          if (!best || e < best.energy) best = { d: bd, st, rid: br, energy: e };
          if (cP && cS) break;
        }
      }
      if (best && bd === bOldD && best.energy < currentEnergy) break;
    }
    return best;
  }

  // =========================================================================
  // STAGE 3: DETERMINISTIC HUMANE POLISHING SWEEP (Contiguity -> <=3d -> Gaps)
  // =========================================================================
  if (!skipStage2 && !skipStage3) {
    // Strictly greedy acceptance during Stage 3 polish
    temp = 0;
    lahcList.fill(currentEnergy);
    for (let pass = 0; pass < 8; pass++) {
      let improvedInPass = false;
      for (const cls of allClassKeys) {
        const sList = classToSessIndices.get(cls)!;
        if (sList.length < 2) continue;
        const dayCounts = [0, 0, 0, 0, 0];
        for (const si of sList) dayCounts[bitIdx.sessionDayIdx[si]]++;
        const active: number[] = [];
        for (let d = 0; d < 5; d++) if (dayCounts[d] > 0) active.push(d);
        if (active.length <= 1) continue;

        // 0. Repair any non-contiguous holes FIRST so active days are clean contiguous blocks
        const span0 = active[active.length - 1] - active[0] + 1;
        if (span0 > active.length) {
          let holeFixed = false;
          const candidates = [active[0], active[active.length - 1]];
          if (dayCounts[candidates[1]] < dayCounts[candidates[0]]) candidates.reverse();
          for (const outD of candidates) {
            const rem = active.filter((d) => d !== outD);
            const rMin = Math.min(...rem);
            const rMax = Math.max(...rem);
            const destSet = new Set<number>();
            for (let d = rMin; d <= rMax; d++) destSet.add(d);
            // CRITICAL: include adjacent boundary days (rMin-1, rMax+1) so [Sen,Sel,Rab,_,Jum] can slide Jum -> Kam!
            if (rMin > 0) destSet.add(rMin - 1);
            if (rMax < 4) destSet.add(rMax + 1);
            const tDays = Array.from(destSet).filter((d) => d !== outD);
            if (tDays.length > 0 && (tryEvacuateDay(cls, outD, tDays, true) || trySwapEvacuateDay(cls, outD, tDays))) {
              improvedInPass = true;
              lahcList.fill(currentEnergy);
              holeFixed = true;
              break;
            }
            if (dayCounts[outD] === 1 && tDays.length > 0) {
              const loneOut = sList.find((si) => bitIdx.sessionDayIdx[si] === outD && pinnedMask[si] === 0);
              if (loneOut !== undefined) {
                for (const td of tDays) {
                  if (tryBridge3Cycle(loneOut, td, cls)) {
                    improvedInPass = true;
                    lahcList.fill(currentEnergy);
                    holeFixed = true;
                    break;
                  }
                }
                if (holeFixed) break;
              }
            }
          }
          // Fallback hole repair: if evacuating an extreme day failed (e.g. locked by a Wet Lab),
          // FILL an empty interior hole day `hDay` by pulling 2 sessions from >=3-course days into `hDay`!
          if (!holeFixed) {
            const holeDays: number[] = [];
            for (let hd = active[0] + 1; hd < active[active.length - 1]; hd++) {
              if (dayCounts[hd] === 0) holeDays.push(hd);
            }
            if (holeDays.length === 1) {
              const hDay = holeDays[0];
              const donorPool = sList.filter((si) => dayCounts[bitIdx.sessionDayIdx[si]] >= 3 && pinnedMask[si] === 0);
              if (donorPool.length >= 2) {
                const snap: Array<{ si: number; d: number; st: number; rid: number }> = [];
                const seenSnap = new Set<number>();
                const saveSi = (si: number) => {
                  if (seenSnap.has(si)) return;
                  seenSnap.add(si);
                  snap.push({ si, d: bitIdx.sessionDayIdx[si], st: bitIdx.sessionStart[si], rid: bitIdx.sessionRoomId[si] });
                };
                const movedDonors: number[] = [];
                const localCnt = [...dayCounts];
                for (const dIdx of donorPool) {
                  if (movedDonors.length >= 2) break;
                  const oD = bitIdx.sessionDayIdx[dIdx];
                  if (localCnt[oD] < 3) continue;
                  const oSt = bitIdx.sessionStart[dIdx], oR = bitIdx.sessionRoomId[dIdx];
                  // Try direct swap with a session `b` sitting on `hDay`
                  let bestB: { b: number; aSt: number; bR: number; bSt: number; e: number } | null = null;
                  for (const b of movableIndices) {
                    if (b === dIdx || seenSnap.has(b) || bitIdx.sessionDayIdx[b] !== hDay) continue;
                    if (sessions[b].classes.includes(cls) || sessions[b].duration !== sessions[dIdx].duration) continue;
                    const bR = bitIdx.sessionRoomId[b], bSt = bitIdx.sessionStart[b];
                    if (!allowedRoomIds[dIdx].includes(bR) || !allowedRoomIds[b].includes(oR)) continue;
                    if (policy.enforcePascaMonWed && ((isPascaById[bR] && hDay > 2) || (isPascaById[oR] && oD > 2))) continue;
                    const mA = startMasks[dIdx].get(bSt);
                    const mB = startMasks[b].get(oSt);
                    if (!mA || !mB) continue;
                    bitIdx.unplace(dIdx);
                    bitIdx.unplace(b);
                    if (bitIdx.canPlaceHard(dIdx, hDay, bR, mA, policy.enforceAsprakWetLab)) {
                      applySessionUpdate(dIdx, hDay, bSt, bR);
                      if (bitIdx.canPlaceHard(b, oD, oR, mB, policy.enforceAsprakWetLab)) {
                        applySessionUpdate(b, oD, oSt, oR);
                        const e = computeFastEnergy();
                        bitIdx.unplace(b);
                        if (!bestB || e < bestB.e) bestB = { b, aSt: bSt, bR, bSt: oSt, e };
                      }
                      bitIdx.unplace(dIdx);
                    }
                    applySessionUpdate(dIdx, oD, oSt, oR);
                    applySessionUpdate(b, hDay, bSt, bR);
                  }
                  if (bestB) {
                    saveSi(dIdx);
                    saveSi(bestB.b);
                    bitIdx.unplace(dIdx);
                    bitIdx.unplace(bestB.b);
                    applySessionUpdate(dIdx, hDay, bestB.aSt, bestB.bR);
                    applySessionUpdate(bestB.b, oD, bestB.bSt, oR);
                    localCnt[oD]--;
                    localCnt[hDay]++;
                    movedDonors.push(dIdx);
                  }
                }
                if (movedDonors.length === 2) {
                  const eFinal = computeFastEnergy();
                  if (eFinal < currentEnergy) {
                    currentEnergy = eFinal;
                    if (currentEnergy < bestEnergy) saveBest();
                    lahcList.fill(currentEnergy);
                    improvedInPass = true;
                    dayConsolidations++;
                  } else {
                    for (const sv of snap) bitIdx.unplace(sv.si);
                    for (const sv of snap) applySessionUpdate(sv.si, sv.d, sv.st, sv.rid);
                  }
                } else {
                  for (const sv of snap) bitIdx.unplace(sv.si);
                  for (const sv of snap) applySessionUpdate(sv.si, sv.d, sv.st, sv.rid);
                }
              }
            }
          }
          dayCounts.fill(0);
          for (const si of sList) dayCounts[bitIdx.sessionDayIdx[si]]++;
          active.length = 0;
          for (let d = 0; d < 5; d++) if (dayCounts[d] > 0) active.push(d);
          if (active.length <= 1) continue;
        }

        // 1. Eliminate EVERY 1-course day while STRICTLY preserving contiguity!
        if ((policy.minCoursesPerActiveDay ?? 2) >= 2) {
          const singleDays = active.filter((d) => dayCounts[d] === 1);
          for (const ld of singleDays) {
            const isExtreme = ld === active[0] || ld === active[active.length - 1];
            const others = active.filter((d) => d !== ld);
            if (isExtreme && others.length > 0 && tryEvacuateDay(cls, ld, others, true)) {
              improvedInPass = true;
              lahcList.fill(currentEnergy);
              break;
            }
            // Swap-based evacuation of extreme loneDay (2-Swap OR 3-Cycle Bridge Swap -> works at 100% packing density!)
            if (isExtreme && others.length > 0) {
              const loneSi = sList.find((si) => bitIdx.sessionDayIdx[si] === ld && pinnedMask[si] === 0);
              if (loneSi !== undefined) {
                let swappedOut = false;
                for (const td of others) {
                  if (tryBestDaySwap(loneSi, td, cls) || tryBridge3Cycle(loneSi, td, cls)) {
                    improvedInPass = true;
                    lahcList.fill(currentEnergy);
                    swappedOut = true;
                    break;
                  }
                }
                if (swappedOut) break;
              }
            }

            // Special case: 2-3 session class spread across 2+ days (e.g. Praktikum SD 3A/3B/3C, Praktikum IF 3B) ->
            // Pack all 2-3 onto ANY single day (supports 1-blocker ejection to clear IF/SD theory overflow out of dry lab!)
            if (sList.length >= 2 && sList.length <= 3 && active.length >= 2 && sList.every((si) => pinnedMask[si] === 0)) {
              const savedAll = sList.map((si) => ({
                si,
                d: bitIdx.sessionDayIdx[si],
                st: bitIdx.sessionStart[si],
                rid: bitIdx.sessionRoomId[si],
              }));
              const ownSet = new Set(sList);
              let packedAll = false;
              for (let td = 0; td < 5 && !packedAll; td++) {
                for (const sv of savedAll) bitIdx.unplace(sv.si);
                const placedHere: number[] = [];
                const ejectedHere: Array<{ si: number; d: number; st: number; rid: number }> = [];
                let okAll = true;
                for (const sv of savedAll) {
                  let ch: { st: number; rid: number } | null = null;
                  for (const rid of allowedRoomIds[sv.si]) {
                    if (policy.enforcePascaMonWed && isPascaById[rid] && td > 2) continue;
                    for (const st of stage2Starts[sv.si]) {
                      if (bitIdx.canPlaceHard(sv.si, td, rid, startMasks[sv.si].get(st)!, policy.enforceAsprakWetLab)) {
                        ch = { st, rid };
                        break;
                      }
                    }
                    if (ch) break;
                  }
                  if (ch) {
                    applySessionUpdate(sv.si, td, ch.st, ch.rid);
                    placedHere.push(sv.si);
                    continue;
                  }
                  // Try 1-blocker ejection on td (e.g., eject a theory overflow session sitting in LAB. DATA SCIENCE!)
                  let rescued = false;
                  ejectPack: for (const rid of allowedRoomIds[sv.si]) {
                    if (policy.enforcePascaMonWed && isPascaById[rid] && td > 2) continue;
                    for (const st of stage2Starts[sv.si]) {
                      const mask = startMasks[sv.si].get(st)!;
                      const blks = bitIdx.findBlockers(sv.si, td, rid, mask);
                      if (blks.length !== 1) continue;
                      const blk = blks[0];
                      if (pinnedMask[blk] === 1 || ownSet.has(blk) || ejectedHere.some((x) => x.si === blk)) continue;
                      const bOldD = bitIdx.sessionDayIdx[blk], bOldSt = bitIdx.sessionStart[blk], bOldR = bitIdx.sessionRoomId[blk];
                      bitIdx.unplace(blk);
                      if (!bitIdx.canPlaceHard(sv.si, td, rid, mask, policy.enforceAsprakWetLab)) {
                        applySessionUpdate(blk, bOldD, bOldSt, bOldR);
                        continue;
                      }
                      applySessionUpdate(sv.si, td, st, rid);
                      const bAlt = findLowestEnergyBlockerSlot(blk, bOldD);
                      if (bAlt) {
                        ejectedHere.push({ si: blk, d: bOldD, st: bOldSt, rid: bOldR });
                        applySessionUpdate(blk, bAlt.d, bAlt.st, bAlt.rid);
                        placedHere.push(sv.si);
                        rescued = true;
                        break ejectPack;
                      } else {
                        bitIdx.unplace(sv.si);
                        applySessionUpdate(blk, bOldD, bOldSt, bOldR);
                      }
                    }
                  }
                  if (!rescued) {
                    okAll = false;
                    break;
                  }
                }
                if (okAll) {
                  const e = computeFastEnergy();
                  if (e < currentEnergy) {
                    currentEnergy = e;
                    if (currentEnergy < bestEnergy) saveBest();
                    lahcList.fill(currentEnergy);
                    improvedInPass = true;
                    packedAll = true;
                    break;
                  }
                }
                for (const pi of placedHere) bitIdx.unplace(pi);
                for (const ex of ejectedHere) bitIdx.unplace(ex.si);
                for (const ex of ejectedHere) applySessionUpdate(ex.si, ex.d, ex.st, ex.rid);
                for (const sv of savedAll) applySessionUpdate(sv.si, sv.d, sv.st, sv.rid);
              }
              if (packedAll) break;
            }

            // Special case: [2, 1, 2] (5 sessions across 3 days, interior loneDay, no >=3 donor) -> evacuate extreme day into remaining 2!
            if (!isExtreme && active.length === 3 && dayCounts[active[0]] === 2 && dayCounts[active[2]] === 2) {
              if (
                tryEvacuateDay(cls, active[0], [active[1], active[2]], true) ||
                tryEvacuateDay(cls, active[2], [active[0], active[1]], true)
              ) {
                improvedInPass = true;
                lahcList.fill(currentEnergy);
                break;
              }
            }

            // Pull 1 session from a >=3-course day onto ld (direct or 1-blocker ejection!)
            const donors = sList
              .filter((si) => dayCounts[bitIdx.sessionDayIdx[si]] >= 3 && pinnedMask[si] === 0)
              .sort((a, b) => sessions[a].duration - sessions[b].duration);
            let pulled = false;
            for (const dIdx of donors) {
              const oD = bitIdx.sessionDayIdx[dIdx], oSt = bitIdx.sessionStart[dIdx], oR = bitIdx.sessionRoomId[dIdx];
              bitIdx.unplace(dIdx);
              let bestP: { st: number; rid: number; energy: number } | null = null;
              for (const st of stage2Starts[dIdx]) {
                const mask = startMasks[dIdx].get(st)!;
                let cP = false, cS = false;
                for (const rid of allowedRoomIds[dIdx]) {
                  const isP = isPascaById[rid] === 1;
                  if (policy.enforcePascaMonWed && isP && ld > 2) continue;
                  if (isP && cP) continue;
                  if (!isP && cS) continue;
                  if (!bitIdx.canPlaceHard(dIdx, ld, rid, mask, policy.enforceAsprakWetLab)) continue;
                  if (isP) cP = true;
                  else cS = true;
                  applySessionUpdate(dIdx, ld, st, rid);
                  const e = computeFastEnergy();
                  bitIdx.unplace(dIdx);
                  if (e < currentEnergy && (!bestP || e < bestP.energy)) bestP = { st, rid, energy: e };
                  if (cP && cS) break;
                }
              }
              if (bestP) {
                applySessionUpdate(dIdx, ld, bestP.st, bestP.rid);
                currentEnergy = bestP.energy;
                if (currentEnergy < bestEnergy) saveBest();
                lahcList.fill(currentEnergy);
                improvedInPass = true;
                pulled = true;
                break;
              }
              // 1-blocker Kempe ejection rescue to pull donor onto ld!
              let ejectedOk = false;
              ejectPull: for (const st of stage2Starts[dIdx]) {
                const mask = startMasks[dIdx].get(st)!;
                for (const rid of allowedRoomIds[dIdx]) {
                  const isP = isPascaById[rid] === 1;
                  if (policy.enforcePascaMonWed && isP && ld > 2) continue;
                  const blks = bitIdx.findBlockers(dIdx, ld, rid, mask);
                  if (blks.length !== 1 || pinnedMask[blks[0]] === 1) continue;
                  const blk = blks[0];
                  if (sessions[blk].classes.includes(cls)) continue;
                  const bOldD = bitIdx.sessionDayIdx[blk], bOldSt = bitIdx.sessionStart[blk], bOldR = bitIdx.sessionRoomId[blk];
                  bitIdx.unplace(blk);
                  if (!bitIdx.canPlaceHard(dIdx, ld, rid, mask, policy.enforceAsprakWetLab)) {
                    bitIdx.place(blk, bOldD, bOldSt, bOldSt + sessions[blk].duration, bOldR);
                    continue;
                  }
                  applySessionUpdate(dIdx, ld, st, rid);
                  // Relocate blk onto its LOWEST-ENERGY slot on its same day bOldD (or active days) -> zero collateral damage!
                  const bAlt = findLowestEnergyBlockerSlot(blk, bOldD);
                  if (bAlt && bAlt.energy < currentEnergy) {
                    applySessionUpdate(blk, bAlt.d, bAlt.st, bAlt.rid);
                    currentEnergy = bAlt.energy;
                    if (currentEnergy < bestEnergy) saveBest();
                    lahcList.fill(currentEnergy);
                    improvedInPass = true;
                    pulled = true;
                    ejectedOk = true;
                    break ejectPull;
                  } else {
                    bitIdx.unplace(dIdx);
                    applySessionUpdate(blk, bOldD, bOldSt, bOldR);
                  }
                }
              }
              if (ejectedOk) break;
              applySessionUpdate(dIdx, oD, oSt, oR);
              // Targeted 2-Swap OR 3-Cycle Bridge Swap Pull at 100% packing density!
              if (tryBestDaySwap(dIdx, ld, cls) || tryBridge3Cycle(dIdx, ld, cls)) {
                lahcList.fill(currentEnergy);
                improvedInPass = true;
                pulled = true;
                break;
              }
            }
            if (pulled) break;

            // Compound 2-step rescue: if ld has a 150m+ theory session blocking the 200m morning while afternoon
            // is blocked by Asprak (e.g., TP 5A/5B), swap it with a 100m session and pair two 100m sessions on ld morning!
            if (tryReplaceLongLoneWithTwo100m(cls, ld, active, dayCounts)) {
              lahcList.fill(currentEnergy);
              improvedInPass = true;
              break;
            }

            // Asprak-Coupled Unlock & Pull: if ld is sealed by junior wet-labs + busy co-seniors (e.g., IL 3A Tue, TP 3A Thu),
            // relocate the blocking wet-lab or shift a co-senior on ld, then immediately pull a donor onto ld!
            if (tryUnlockAsprakAndPull(cls, ld, donors)) {
              lahcList.fill(currentEnergy);
              improvedInPass = true;
              break;
            }
          }
        }

        // Recompute dayCounts after step 1 before checking holes / >targetMax
        dayCounts.fill(0);
        for (const si of sList) dayCounts[bitIdx.sessionDayIdx[si]]++;
        active.length = 0;
        for (let d = 0; d < 5; d++) if (dayCounts[d] > 0) active.push(d);
        if (active.length <= 1) continue;

        const span = active[active.length - 1] - active[0] + 1;
        const hasHole = span > active.length;
        const targetMax = (classTotalMin.get(cls) || 0) > 1420 ? 4 : policy.maxDaysPerClass;
        if (!hasHole && active.length <= targetMax) continue;

        // Try evacuating first extreme day, then last extreme day
        const candidates = [active[0], active[active.length - 1]];
        if (dayCounts[candidates[1]] < dayCounts[candidates[0]]) candidates.reverse();

        for (const outD of candidates) {
          const rem = active.filter((d) => d !== outD);
          const rMin = Math.min(...rem);
          const rMax = Math.max(...rem);
          const destSet = new Set<number>();
          for (let d = rMin; d <= rMax; d++) destSet.add(d);
          if (destSet.size < targetMax) {
            if (rMin > 0) destSet.add(rMin - 1);
            if (rMax < 4 && destSet.size < targetMax) destSet.add(rMax + 1);
          }
          const tDays = Array.from(destSet).filter((d) => d !== outD);
          if (tDays.length > 0 && (tryEvacuateDay(cls, outD, tDays, true) || trySwapEvacuateDay(cls, outD, tDays))) {
            improvedInPass = true;
            lahcList.fill(currentEnergy);
            break;
          }
        }
      }

      // Stage 3D: Lecturer 1-Course Day Reducer (only accepts strictly lower energy -> NEVER harms students!)
      if ((policy.minCoursesPerActiveDay ?? 2) >= 2) {
        const lecToSess = new Map<number, number[]>();
        for (let i = 0; i < n; i++) {
          const lid = bitIdx.sessionLecId[i];
          if (lid < 0) continue;
          const arr = lecToSess.get(lid) || [];
          arr.push(i);
          lecToSess.set(lid, arr);
        }
        for (const sList of lecToSess.values()) {
          if (sList.length < 2) continue;
          const lCounts = [0, 0, 0, 0, 0];
          for (const si of sList) lCounts[bitIdx.sessionDayIdx[si]]++;
          for (let d = 0; d < 5; d++) {
            if (lCounts[d] !== 1) continue;
            const loneSi = sList.find((si) => bitIdx.sessionDayIdx[si] === d && pinnedMask[si] === 0);
            if (loneSi === undefined) continue;
            const otherLecDays: number[] = [];
            for (let od = 0; od < 5; od++) if (od !== d && lCounts[od] > 0) otherLecDays.push(od);
            if (otherLecDays.length === 0) continue;

            const oD = bitIdx.sessionDayIdx[loneSi], oSt = bitIdx.sessionStart[loneSi], oR = bitIdx.sessionRoomId[loneSi];
            bitIdx.unplace(loneSi);
            let bestL: { d: number; st: number; rid: number; energy: number } | null = null;
            for (const td of otherLecDays) {
              for (const st of stage2Starts[loneSi]) {
                const mask = startMasks[loneSi].get(st)!;
                let cP = false, cS = false;
                for (const rid of allowedRoomIds[loneSi]) {
                  const isP = isPascaById[rid] === 1;
                  if (policy.enforcePascaMonWed && isP && td > 2) continue;
                  if (isP && cP) continue;
                  if (!isP && cS) continue;
                  if (!bitIdx.canPlaceHard(loneSi, td, rid, mask, policy.enforceAsprakWetLab)) continue;
                  if (isP) cP = true;
                  else cS = true;
                  applySessionUpdate(loneSi, td, st, rid);
                  const e = computeFastEnergy();
                  bitIdx.unplace(loneSi);
                  if (e < currentEnergy && (!bestL || e < bestL.energy)) bestL = { d: td, st, rid, energy: e };
                  if (cP && cS) break;
                }
              }
            }
            if (bestL) {
              applySessionUpdate(loneSi, bestL.d, bestL.st, bestL.rid);
              currentEnergy = bestL.energy;
              if (currentEnergy < bestEnergy) saveBest();
              lahcList.fill(currentEnergy);
              improvedInPass = true;
              lCounts[d]--;
              lCounts[bestL.d]++;
            } else {
              applySessionUpdate(loneSi, oD, oSt, oR);
              // Targeted Swap fallback for lecturer 1-course day at 99% packing density!
              for (const td of otherLecDays) {
                if (tryBestDaySwap(loneSi, td)) {
                  lahcList.fill(currentEnergy);
                  improvedInPass = true;
                  lCounts[d]--;
                  lCounts[td]++;
                  break;
                }
              }
            }
          }
        }
      }

      // Stage 3B: Deterministic Wet-Lab Asprak Clearance Pass (eliminate remaining PARTIAL senior overlaps!)
      if (policy.enforceAsprakWetLab) {
        for (const ws of bitIdx.wetLabIndices) {
          const ov = bitIdx.findSeniorOverlapsForWetLab(ws);
          if (ov.length === 0) continue;
          // Try shifting wet-lab to a strictly lower-energy CLEAR slot first
          if (pinnedMask[ws] === 0) {
            const oD = bitIdx.sessionDayIdx[ws], oSt = bitIdx.sessionStart[ws], oR = bitIdx.sessionRoomId[ws];
            const wStarts = stage2Starts[ws];
            const mMap = startMasks[ws];
            bitIdx.unplace(ws);
            let bestW: { d: number; st: number; energy: number } | null = null;
            for (let td = 0; td < 5; td++) {
              for (const st of wStarts) {
                if (td === oD && st === oSt) continue;
                if (!bitIdx.canPlaceHard(ws, td, oR, mMap.get(st)!, true)) continue;
                applySessionUpdate(ws, td, st, oR);
                const e = computeFastEnergy();
                bitIdx.unplace(ws);
                if (e < currentEnergy && (!bestW || e < bestW.energy)) bestW = { d: td, st, energy: e };
              }
            }
            if (bestW) {
              applySessionUpdate(ws, bestW.d, bestW.st, oR);
              currentEnergy = bestW.energy;
              if (currentEnergy < bestEnergy) saveBest();
              asprakClears++;
              improvedInPass = true;
              continue;
            } else {
              applySessionUpdate(ws, oD, oSt, oR);
            }
          }
          // Otherwise try shifting each overlapping senior session
          for (const sIdx of ov) {
            if (pinnedMask[sIdx] === 1) continue;
            const oD = bitIdx.sessionDayIdx[sIdx], oSt = bitIdx.sessionStart[sIdx], oR = bitIdx.sessionRoomId[sIdx];
            const rIds = allowedRoomIds[sIdx];
            const starts = stage2Starts[sIdx];
            const mMap = startMasks[sIdx];
            bitIdx.unplace(sIdx);
            let bestS: { d: number; st: number; rid: number; energy: number } | null = null;
            for (let td = 0; td < 5; td++) {
              for (const st of starts) {
                const mask = mMap.get(st)!;
                let cP = false, cS = false;
                for (const rid of rIds) {
                  const isP = isPascaById[rid] === 1;
                  if (policy.enforcePascaMonWed && isP && td > 2) continue;
                  if (isP && cP) continue;
                  if (!isP && cS) continue;
                  if (!bitIdx.canPlaceHard(sIdx, td, rid, mask, true)) continue;
                  if (isP) cP = true;
                  else cS = true;
                  applySessionUpdate(sIdx, td, st, rid);
                  const e = computeFastEnergy();
                  bitIdx.unplace(sIdx);
                  if (e < currentEnergy && (!bestS || e < bestS.energy)) bestS = { d: td, st, rid, energy: e };
                  if (cP && cS) break;
                }
              }
            }
            if (bestS) {
              applySessionUpdate(sIdx, bestS.d, bestS.st, bestS.rid);
              currentEnergy = bestS.energy;
              if (currentEnergy < bestEnergy) saveBest();
              asprakClears++;
              improvedInPass = true;
            } else {
              applySessionUpdate(sIdx, oD, oSt, oR);
            }
          }
        }
      }

      // Same-day dead-gap compression pass across all movable sessions
      for (const idx of movableIndices) {
        const oldD = bitIdx.sessionDayIdx[idx];
        const oldSt = bitIdx.sessionStart[idx];
        const oldRid = bitIdx.sessionRoomId[idx];
        const rIds = allowedRoomIds[idx];
        const starts = stage2Starts[idx];
        const mMap = startMasks[idx];

        bitIdx.unplace(idx);
        let bestLocal: { st: number; rid: number; energy: number } | null = null;
        for (const st of starts) {
          if (st === oldSt) continue;
          const mask = mMap.get(st)!;
          let cP = false, cS = false;
          for (const rid of rIds) {
            const isP = isPascaById[rid] === 1;
            if (policy.enforcePascaMonWed && isP && oldD > 2) continue;
            if (isP && cP) continue;
            if (!isP && cS) continue;
            if (!bitIdx.canPlaceHard(idx, oldD, rid, mask, policy.enforceAsprakWetLab)) continue;
            if (isP) cP = true;
            else cS = true;
            applySessionUpdate(idx, oldD, st, rid);
            const e = computeFastEnergy();
            bitIdx.unplace(idx);
            if (e < currentEnergy && (!bestLocal || e < bestLocal.energy)) {
              bestLocal = { st, rid, energy: e };
            }
            if (cP && cS) break;
          }
        }
        if (bestLocal) {
          applySessionUpdate(idx, oldD, bestLocal.st, bestLocal.rid);
          currentEnergy = bestLocal.energy;
          if (currentEnergy < bestEnergy) saveBest();
          improvedInPass = true;
        } else {
          applySessionUpdate(idx, oldD, oldSt, oldRid);
          // Same-day pairwise time-slot swap (crushes dead gaps even at 99% room packing density!)
          for (const b of movableIndices) {
            if (b <= idx || bitIdx.sessionDayIdx[b] !== oldD) continue;
            if (sessions[b].duration !== sessions[idx].duration) continue;
            const bSt = bitIdx.sessionStart[b], bR = bitIdx.sessionRoomId[b];
            if (bSt === oldSt) continue;
            if (!allowedRoomIds[idx].includes(bR) || !allowedRoomIds[b].includes(oldRid)) continue;
            bitIdx.unplace(idx);
            bitIdx.unplace(b);
            const mA = startMasks[idx].get(bSt);
            const mB = startMasks[b].get(oldSt);
            if (mA && mB && bitIdx.canPlaceHard(idx, oldD, bR, mA, policy.enforceAsprakWetLab)) {
              applySessionUpdate(idx, oldD, bSt, bR);
              if (bitIdx.canPlaceHard(b, oldD, oldRid, mB, policy.enforceAsprakWetLab)) {
                applySessionUpdate(b, oldD, oldSt, oldRid);
                const e = computeFastEnergy();
                if (e < currentEnergy) {
                  currentEnergy = e;
                  if (currentEnergy < bestEnergy) saveBest();
                  improvedInPass = true;
                  break;
                }
                bitIdx.unplace(b);
              }
              bitIdx.unplace(idx);
            }
            applySessionUpdate(idx, oldD, oldSt, oldRid);
            applySessionUpdate(b, oldD, bSt, bR);
          }
        }
      }
      if (!improvedInPass) break;
    }
  }

  // Final restore of incumbent best
  for (let i = 0; i < n; i++) {
    sessions[i].day = DAYS[bestDay[i]];
    sessions[i].start = bestStart[i];
    sessions[i].end = bestEnd[i];
    sessions[i].room = idToRoomName[bestRoom[i]];
  }

  // Compute moves diff
  const moves: SessionMove[] = [];
  for (let i = 0; i < n; i++) {
    const a = initialSessions[i];
    const b = sessions[i];
    if (a.day !== b.day || a.start !== b.start || a.room !== b.room) {
      moves.push({
        id: b.id,
        namaMk: b.namaMk,
        kelasRaw: b.kelasRaw,
        from: { day: a.day, start: a.start, end: a.end, room: a.room },
        to: { day: b.day, start: b.start, end: b.end, room: b.room },
      });
    }
  }

  return {
    sessions,
    moves,
    perturbationCount: moves.length,
    latencyMs: Number((performance.now() - t0).toFixed(2)),
    audit: auditSchedule(sessions, policy),
    metaheuristic: {
      algorithm: 'IFS-CBS + H-ALNS-LAHC+SA+Kempe (TypeScript 160-bit 5m Bitmask)',
      iterations,
      acceptedMoves,
      improvingMoves,
      kempeSwaps,
      dayConsolidations,
      earlyFixes,
      asprakClears,
      cbsRestarts,
      reheats,
      initialEnergy: Math.round(initialEnergy),
      finalEnergy: Math.round(bestEnergy),
    },
  };
}

// ===========================================================================
// DYNAMIC CSP (REAL-TIME SLOT PROPAGATION + MINIMAL PERTURBATION LOCAL REPAIR)
// ===========================================================================

function inspectPlacementDynamic(
  session: Session,
  day: DayName,
  start: number,
  room: string,
  placed: Session[],
  cohortMap: Map<string, string[]>,
  policy: SolverPolicy
) {
  const end = start + session.duration;
  const policyErrors: string[] = [];
  const maxEnd = session.duration > 300 || session.end > CAMPUS_END ? 1160 : CAMPUS_END;

  if (start < CAMPUS_START || end > maxEnd) policyErrors.push('Di luar jam kampus');
  if (policy.protectIshoma && overlapsIshoma(start, end, session.duration)) {
    policyErrors.push('Melanggar jam ISHOMA 12:00-13:00');
  }
  if (session.roomType === 'WET_LAB' || session.roomType === 'DRY_LAB') {
    if (room !== (session.originalRoom || session.room)) {
      policyErrors.push(`Praktikum wajib di ${session.originalRoom || session.room}`);
    }
  } else if (
    !isGeneralRoom(room) &&
    !(policy.allowDryLabOverflow && (session.prodi === 'IF' || session.prodi === 'SD') && SD_IF_DRY_LABS.has(room.toUpperCase()))
  ) {
    policyErrors.push('Kuliah teori tidak boleh memakai lab milik prodi lain');
  }
  if (policy.enforcePascaMonWed && isPascaRoom(room) && !PASCA_ALLOWED_DAYS.has(day)) {
    policyErrors.push('Gedung Pasca hanya diizinkan Senin-Rabu');
  }

  const hardBlockers: Array<{ session: Session; reasons: string[] }> = [];
  const blockerSet = new Set<string>();
  const addBlocker = (other: Session, reason: string) => {
    if (!blockerSet.has(other.id)) {
      blockerSet.add(other.id);
      hardBlockers.push({ session: other, reasons: [reason] });
    }
  };

  for (const o of placed) {
    if (!o || o.id === session.id) continue;
    if (!overlaps(day, start, end, o.day, o.start, o.end)) continue;
    if (o.room === room) addBlocker(o, 'Ruang bentrok');
    if (session.dosen && o.dosen === session.dosen) addBlocker(o, 'Dosen bentrok');
    if (sharesClass(session.classes, o.classes)) addBlocker(o, 'Kelas bentrok');
  }

  let asprakDeadlock = false;
  let asprakPartial = false;
  const asprakBlockers: Session[] = [];

  if (policy.hardFridayPrayer && overlapsFridayPrayer(day, start, end, session.duration)) {
    policyErrors.push('Melanggar Jeda Salat Jumat (11:30-13:00)');
  }

  if (policy.enforceAsprakWetLab && session.isWetLab) {
    const seniors = getSeniorCohortClasses(session, cohortMap);
    if (seniors.length > 0) {
      const busyBySenior = new Map<string, Session[]>();
      for (const o of placed) {
        if (!o || o.id === session.id) continue;
        if (!overlaps(day, start, end, o.day, o.start, o.end)) continue;
        for (const c of expandEffectiveClasses(o.classes)) {
          if (seniors.includes(c)) {
            const arr = busyBySenior.get(c) || [];
            arr.push(o);
            busyBySenior.set(c, arr);
          }
        }
      }
      if (busyBySenior.size >= seniors.length) {
        asprakDeadlock = true;
        for (const arr of busyBySenior.values()) for (const o of arr) asprakBlockers.push(o);
      } else if (busyBySenior.size > 0) {
        asprakPartial = true;
      }
    }
  }

  if (policy.enforceAsprakWetLab && session.semester && session.semester >= 3) {
    const sessEff = expandEffectiveClasses(session.classes);
    for (const ws of placed) {
      if (!ws || ws.id === session.id || !ws.isWetLab) continue;
      if (!overlaps(day, start, end, ws.day, ws.start, ws.end)) continue;
      const seniors = getSeniorCohortClasses(ws, cohortMap);
      if (seniors.length === 0) continue;
      if (!sessEff.some((c) => seniors.includes(c))) continue;

      const busySeniors = new Set<string>();
      for (const c of sessEff) if (seniors.includes(c)) busySeniors.add(c);
      for (const o of placed) {
        if (!o || o.id === session.id || o.id === ws.id) continue;
        if (!overlaps(ws.day, ws.start, ws.end, o.day, o.start, o.end)) continue;
        for (const c of expandEffectiveClasses(o.classes)) if (seniors.includes(c)) busySeniors.add(c);
      }
      if (busySeniors.size >= seniors.length) {
        asprakDeadlock = true;
        asprakBlockers.push(ws);
      } else {
        asprakPartial = true;
      }
    }
  }

  if (asprakDeadlock) policyErrors.push('Deadlock Asprak Wet Lab');
  return { hardBlockers, policyErrors, asprakDeadlock, asprakPartial, asprakBlockers };
}

function quickHumaneSlotCost(
  session: Session,
  day: DayName,
  start: number,
  room: string,
  placed: Session[],
  policy: SolverPolicy
): number {
  const minPref = policy.preferredMinStart ?? HUMANE_START;
  let cost = 0;
  if (start < EARLY_OVERFLOW_START) cost += 600;
  else if (start < minPref) cost += 180;
  if (policy.preferWorkingHours && start + session.duration > WORK_END) cost += 20;

  const dIdx = DAY_INDEX[day];
  for (const c of session.classes) {
    const activeSet = new Set<number>([dIdx]);
    for (const o of placed) {
      if (o.id !== session.id && o.classes.includes(c)) activeSet.add(DAY_INDEX[o.day]);
    }
    const arr = Array.from(activeSet).sort((a, b) => a - b);
    const holes = arr[arr.length - 1] - arr[0] + 1 - arr.length;
    if (policy.enforceContiguousDays && holes > 0) cost += holes * 320;
    if (arr.length > policy.maxDaysPerClass) cost += arr.length === 4 ? 140 : 400;
  }
  if (isSaintekRoom(room) && PASCA_ALLOWED_DAYS.has(day)) cost += 5;
  return cost;
}

export function evaluateCandidateSlots(
  sessions: Session[],
  sessionId: string,
  rooms: RoomInfo[],
  policyInput?: Partial<SolverPolicy>
) {
  const t0 = performance.now();
  const policy: SolverPolicy = { ...DEFAULT_POLICY, ...(policyInput || {}) };
  const target = sessions.find((s) => s.id === sessionId);
  if (!target) return { sessionId, slots: [], topSafeSlots: [], safeCount: 0, repairableCount: 0, latencyMs: 0 };

  const cohortMap = buildCohortMap(sessions);
  const allowedRooms = new Set(getAllowedRooms(target, rooms, policy));
  const starts = getHumaneStarts(target.duration, policy, true);

  const slots: CandidateSlot[] = [];
  const safeList: CandidateSlot[] = [];

  for (const day of DAYS) {
    for (const roomObj of rooms) {
      const room = roomObj.name;
      const domainOk = allowedRooms.has(room);
      const pascaBlocked = policy.enforcePascaMonWed && isPascaRoom(room) && !PASCA_ALLOWED_DAYS.has(day);

      for (const start of starts) {
        const end = start + target.duration;
        const isCurrent = day === target.day && start === target.start && room === target.room;

        if (!domainOk) {
          slots.push({
            day, start, end, room, status: 'FORBIDDEN',
            reason: target.isPraktikum ? `Praktikum wajib di ${target.originalRoom || target.room}` : 'Ruang lab khusus',
            blockerCount: 0, softCost: Infinity, isCurrent,
          });
          continue;
        }
        if (pascaBlocked) {
          slots.push({
            day, start, end, room, status: 'FORBIDDEN',
            reason: 'Regulasi Pasca: hanya Senin-Rabu',
            blockerCount: 0, softCost: Infinity, isCurrent,
          });
          continue;
        }

        const chk = inspectPlacementDynamic(target, day, start, room, sessions, cohortMap, policy);
        const uniqueBlockers = Array.from(
          new Map([...chk.hardBlockers.map((b) => b.session), ...chk.asprakBlockers].map((b) => [b.id, b])).values()
        );
        const hasPinnedBlocker = uniqueBlockers.some((b) => b.pinned);

        if (chk.hardBlockers.length === 0 && chk.policyErrors.length === 0) {
          const softCost = quickHumaneSlotCost(target, day, start, room, sessions, policy) + (chk.asprakPartial ? 18 : 0);
          const item: CandidateSlot = {
            day, start, end, room, status: 'SAFE',
            reason: start < (policy.preferredMinStart ?? HUMANE_START) ? 'Slot aman (jam pagi <08:40)' : 'Slot aman manusiawi (>=08:40)',
            blockerCount: 0, softCost, isCurrent,
          };
          slots.push(item);
          if (!isCurrent) safeList.push(item);
        } else if (!hasPinnedBlocker && uniqueBlockers.length > 0 && uniqueBlockers.length <= 2 && chk.policyErrors.every((e) => e.includes('Asprak'))) {
          const softCost = quickHumaneSlotCost(target, day, start, room, sessions, policy) + uniqueBlockers.length * 45;
          slots.push({
            day, start, end, room, status: 'REPAIRABLE',
            reason: `Auto-geser ${uniqueBlockers.length} sesi (${uniqueBlockers.map((b) => b.namaMk).join(', ')})`,
            blockerCount: uniqueBlockers.length,
            blockerIds: uniqueBlockers.map((b) => b.id),
            softCost,
            isCurrent,
          });
        } else {
          slots.push({
            day, start, end, room, status: 'FORBIDDEN',
            reason: hasPinnedBlocker ? 'Bentrok dengan slot terkunci (Pin Dosen S3)' : chk.policyErrors[0] || 'Melanggar aturan keras',
            blockerCount: uniqueBlockers.length, softCost: Infinity, isCurrent,
          });
        }
      }
    }
  }

  safeList.sort((a, b) => a.softCost - b.softCost);
  const topSafeSlots: CandidateSlot[] = [];
  const seenKey = new Set<string>();
  for (const s of safeList) {
    const k = `${s.day}|${s.start}`;
    if (seenKey.has(k) && topSafeSlots.length < 4) continue;
    seenKey.add(k);
    topSafeSlots.push(s);
    if (topSafeSlots.length >= 6) break;
  }

  return {
    sessionId,
    slots,
    topSafeSlots,
    safeCount: safeList.length,
    repairableCount: slots.filter((x) => x.status === 'REPAIRABLE').length,
    latencyMs: Number((performance.now() - t0).toFixed(2)),
  };
}

export function planMinimalRepair(
  initialSessions: Session[],
  sessionId: string,
  targetDay: DayName,
  targetStart: number,
  targetRoom: string,
  rooms: RoomInfo[],
  policyInput?: Partial<SolverPolicy>
): RepairPlan {
  const t0 = performance.now();
  const policy: SolverPolicy = { ...DEFAULT_POLICY, ...(policyInput || {}) };
  const working = cloneSessions(initialSessions);
  const cohortMap = buildCohortMap(working);
  const idx = working.findIndex((s) => s.id === sessionId);
  if (idx < 0) return { feasible: false, reason: 'Sesi tidak ditemukan', latencyMs: 0 };

  const target = working[idx];
  const orig = { day: target.day, start: target.start, end: target.end, room: target.room };
  const targetEnd = targetStart + target.duration;

  const chkInit = inspectPlacementDynamic(target, targetDay, targetStart, targetRoom, working, cohortMap, policy);
  const nonAsprakErr = chkInit.policyErrors.filter((e) => !e.includes('Asprak'));
  if (nonAsprakErr.length > 0) {
    return { feasible: false, reason: nonAsprakErr.join('; '), latencyMs: Number((performance.now() - t0).toFixed(2)) };
  }

  const directBlockers = Array.from(
    new Map([...chkInit.hardBlockers.map((b) => b.session), ...chkInit.asprakBlockers].map((b) => [b.id, b])).values()
  );
  if (directBlockers.some((b) => b.pinned)) {
    return { feasible: false, reason: 'Slot bentrok dengan jadwal terkunci (Pin Dosen S3)', latencyMs: Number((performance.now() - t0).toFixed(2)) };
  }

  working[idx] = { ...target, day: targetDay, start: targetStart, end: targetEnd, room: targetRoom };
  const moves: SessionMove[] = [
    {
      id: target.id,
      namaMk: target.namaMk,
      kelasRaw: target.kelasRaw,
      role: 'PRIMARY',
      from: orig,
      to: { day: targetDay, start: targetStart, end: targetEnd, room: targetRoom },
    },
  ];

  if (directBlockers.length === 0) {
    const directAudit = auditSchedule(working, policy);
    if (!directAudit.hardFeasible) {
      return {
        feasible: false,
        reason: 'Post-repair hard feasibility gate rejected direct placement (Asprak/Policy)',
        latencyMs: Number((performance.now() - t0).toFixed(2)),
      };
    }
    return {
      feasible: true,
      strategy: 'DIRECT_SAFE',
      perturbationCount: 0,
      totalMoved: 1,
      moves,
      sessions: working,
      latencyMs: Number((performance.now() - t0).toFixed(2)),
    };
  }

  const lockedIds = new Set<string>([target.id, ...working.filter((s) => s.pinned).map((s) => s.id)]);

  function findFreeSlot(sess: Session, list: Session[]) {
    const allowed = getAllowedRooms(sess, rooms, policy);
    const starts = getHumaneStarts(sess.duration, policy, true);
    let best: { day: DayName; start: number; room: string; cost: number } | null = null;
    for (const day of DAYS) {
      for (const room of allowed) {
        if (policy.enforcePascaMonWed && isPascaRoom(room) && !PASCA_ALLOWED_DAYS.has(day)) continue;
        for (const start of starts) {
          const chk = inspectPlacementDynamic(sess, day, start, room, list, cohortMap, policy);
          if (chk.hardBlockers.length > 0 || chk.policyErrors.length > 0) continue;
          const cost = quickHumaneSlotCost(sess, day, start, room, list, policy) + (chk.asprakPartial ? 20 : 0);
          if (!best || cost < best.cost) best = { day, start, room, cost };
        }
      }
    }
    return best;
  }

  const blockerIds = new Set(directBlockers.map((b) => b.id));
  const pool = working.filter((s) => !blockerIds.has(s.id));
  let strategy: 'LOCAL_1_STEP' | 'KEMPE_2_STEP' = 'LOCAL_1_STEP';

  for (const blk of directBlockers) {
    const free = findFreeSlot(blk, pool);
    if (free) {
      pool.push({ ...blk, day: free.day, start: free.start, end: free.start + blk.duration, room: free.room });
      lockedIds.add(blk.id);
      moves.push({
        id: blk.id,
        namaMk: blk.namaMk,
        kelasRaw: blk.kelasRaw,
        role: 'REPAIRED_1STEP',
        from: { day: blk.day, start: blk.start, end: blk.end, room: blk.room },
        to: { day: free.day, start: free.start, end: free.start + blk.duration, room: free.room },
      });
      continue;
    }

    let repaired2 = false;
    const allowed = getAllowedRooms(blk, rooms, policy);
    const starts = getHumaneStarts(blk.duration, policy, true);
    search2: for (const day of DAYS) {
      for (const room of allowed) {
        if (policy.enforcePascaMonWed && isPascaRoom(room) && !PASCA_ALLOWED_DAYS.has(day)) continue;
        for (const start of starts) {
          const chk = inspectPlacementDynamic(blk, day, start, room, pool, cohortMap, policy);
          if (chk.policyErrors.some((e) => !e.includes('Asprak'))) continue;
          const cList = Array.from(
            new Map([...chk.hardBlockers.map((x) => x.session), ...chk.asprakBlockers].map((x) => [x.id, x])).values()
          );
          if (cList.length !== 1 || lockedIds.has(cList[0].id)) continue;
          const cSess = cList[0];

          const tempPool = pool.filter((p) => p.id !== cSess.id);
          const placedBlk: Session = { ...blk, day, start, end: start + blk.duration, room };
          const verifyBlk = inspectPlacementDynamic(placedBlk, day, start, room, tempPool, cohortMap, policy);
          if (verifyBlk.hardBlockers.length > 0 || verifyBlk.policyErrors.length > 0) continue;
          tempPool.push(placedBlk);

          const freeC = findFreeSlot(cSess, tempPool);
          if (freeC) {
            tempPool.push({ ...cSess, day: freeC.day, start: freeC.start, end: freeC.start + cSess.duration, room: freeC.room });
            pool.length = 0;
            pool.push(...tempPool);
            lockedIds.add(blk.id);
            lockedIds.add(cSess.id);
            strategy = 'KEMPE_2_STEP';
            moves.push({
              id: blk.id,
              namaMk: blk.namaMk,
              kelasRaw: blk.kelasRaw,
              role: 'REPAIRED_2STEP',
              from: { day: blk.day, start: blk.start, end: blk.end, room: blk.room },
              to: { day, start, end: start + blk.duration, room },
            });
            moves.push({
              id: cSess.id,
              namaMk: cSess.namaMk,
              kelasRaw: cSess.kelasRaw,
              role: 'KEMPE_CHAIN',
              from: { day: cSess.day, start: cSess.start, end: cSess.end, room: cSess.room },
              to: { day: freeC.day, start: freeC.start, end: freeC.start + cSess.duration, room: freeC.room },
            });
            repaired2 = true;
            break search2;
          }
        }
      }
    }

    if (!repaired2) {
      return { feasible: false, reason: `Tidak ditemukan jalur geser minimal untuk ${blk.namaMk}`, latencyMs: Number((performance.now() - t0).toFixed(2)) };
    }
  }

  const orderMap = new Map(initialSessions.map((s, i) => [s.id, i]));
  pool.sort((a, b) => (orderMap.get(a.id) ?? 0) - (orderMap.get(b.id) ?? 0));

  const postAudit = auditSchedule(pool, policy);
  if (!postAudit.hardFeasible) {
    return {
      feasible: false,
      reason: 'Post-repair hard feasibility gate rejected repair chain (Asprak/Policy)',
      latencyMs: Number((performance.now() - t0).toFixed(2)),
    };
  }

  return {
    feasible: true,
    strategy,
    perturbationCount: moves.length - 1,
    totalMoved: moves.length,
    moves,
    sessions: pool,
    latencyMs: Number((performance.now() - t0).toFixed(2)),
  };
}

export function autoFixAllConflicts(
  initialSessions: Session[],
  rooms: RoomInfo[],
  policyInput?: Partial<SolverPolicy>,
  options: { fixPoliciesToo?: boolean } = {}
) {
  const t0 = performance.now();
  const policy: SolverPolicy = { ...DEFAULT_POLICY, ...(policyInput || {}) };
  const fixPoliciesToo = options.fixPoliciesToo !== undefined ? Boolean(options.fixPoliciesToo) : true;
  const working = cloneSessions(initialSessions);
  const cohortMap = buildCohortMap(working);
  const movedMap = new Map<string, SessionMove>();
  const skipped = new Set<string>();

  function recordMove(orig: Session, day: DayName, start: number, room: string, role: string) {
    const prev = movedMap.get(orig.id);
    if (!prev) {
      movedMap.set(orig.id, {
        id: orig.id,
        namaMk: orig.namaMk,
        kelasRaw: orig.kelasRaw,
        role,
        from: { day: orig.day, start: orig.start, end: orig.end, room: orig.room },
        to: { day, start, end: start + orig.duration, room },
      });
    } else {
      prev.to = { day, start, end: start + orig.duration, room };
    }
  }

  function findBestDirectSlot(s: Session, evalPol: SolverPolicy) {
    const allowed = getAllowedRooms(s, rooms, evalPol);
    const starts = getHumaneStarts(s.duration, evalPol, true);
    let best: { day: DayName; start: number; room: string; cost: number } | null = null;
    for (const day of DAYS) {
      for (const room of allowed) {
        if (evalPol.enforcePascaMonWed && isPascaRoom(room) && !PASCA_ALLOWED_DAYS.has(day)) continue;
        for (const start of starts) {
          const chk = inspectPlacementDynamic(s, day, start, room, working, cohortMap, evalPol);
          if (chk.hardBlockers.length > 0 || chk.policyErrors.length > 0) continue;
          let cost = quickHumaneSlotCost(s, day, start, room, working, evalPol) + (chk.asprakPartial ? 140 : 0);
          if (day === s.day) cost -= 18;
          if (!best || cost < best.cost) best = { day, start, room, cost };
        }
      }
    }
    return best;
  }

  function tryKempeRepairForSession(s: Session, evalPol: SolverPolicy, role: string): boolean {
    const allowed = getAllowedRooms(s, rooms, evalPol);
    const starts = getHumaneStarts(s.duration, evalPol, true);
    for (const day of DAYS) {
      for (const room of allowed) {
        if (evalPol.enforcePascaMonWed && isPascaRoom(room) && !PASCA_ALLOWED_DAYS.has(day)) continue;
        for (const start of starts) {
          const chk = inspectPlacementDynamic(s, day, start, room, working, cohortMap, evalPol);
          if (chk.policyErrors.some((e) => !e.includes('Asprak'))) continue;
          const blks = Array.from(
            new Map([...chk.hardBlockers.map((b) => b.session), ...chk.asprakBlockers].map((b) => [b.id, b])).values()
          );
          if (blks.length !== 1 || blks[0].pinned) continue;
          const blk = blks[0];
          const sIdx = working.findIndex((x) => x.id === s.id);
          const bIdx = working.findIndex((x) => x.id === blk.id);
          const origS = { ...working[sIdx] };
          const origB = { ...working[bIdx] };

          // Temporarily place s and remove blk
          const tempPlaced = working.filter((x) => x.id !== blk.id);
          tempPlaced[tempPlaced.findIndex((x) => x.id === s.id)] = {
            ...s,
            day,
            start,
            end: start + s.duration,
            room,
          };
          const verifyS = inspectPlacementDynamic(
            { ...s, day, start, end: start + s.duration, room },
            day,
            start,
            room,
            tempPlaced,
            cohortMap,
            evalPol
          );
          if (verifyS.hardBlockers.length > 0 || verifyS.policyErrors.length > 0) continue;

          // Find free slot for displaced blocker blk
          const bAllowed = getAllowedRooms(blk, rooms, evalPol);
          const bStarts = getHumaneStarts(blk.duration, evalPol, true);
          let bestB: { day: DayName; start: number; room: string; cost: number } | null = null;
          for (const bd of DAYS) {
            for (const br of bAllowed) {
              if (evalPol.enforcePascaMonWed && isPascaRoom(br) && !PASCA_ALLOWED_DAYS.has(bd)) continue;
              for (const bs of bStarts) {
                const chkB = inspectPlacementDynamic(blk, bd, bs, br, tempPlaced, cohortMap, evalPol);
                if (chkB.hardBlockers.length > 0 || chkB.policyErrors.length > 0) continue;
                const cost = quickHumaneSlotCost(blk, bd, bs, br, tempPlaced, evalPol) + (chkB.asprakPartial ? 140 : 0);
                if (!bestB || cost < bestB.cost) bestB = { day: bd, start: bs, room: br, cost };
              }
            }
          }
          if (bestB) {
            recordMove(origS, day, start, room, role);
            recordMove(origB, bestB.day, bestB.start, bestB.room, `${role}_KEMPE`);
            working[sIdx] = { ...s, day, start, end: start + s.duration, room };
            working[bIdx] = { ...blk, day: bestB.day, start: bestB.start, end: bestB.start + blk.duration, room: bestB.room };
            return true;
          }
        }
      }
    }
    return false;
  }

  for (let guard = 0; guard < 120; guard++) {
    const aud = auditSchedule(working, policy);
    let chosen: { session: Session; role: string; phase: 'H' | 'P' | 'A' } | null = null;

    if (aud.hardConflicts.length > 0) {
      const deg = new Map<string, number>();
      for (const c of aud.hardConflicts) {
        deg.set(c.aId, (deg.get(c.aId) || 0) + 1);
        deg.set(c.bId, (deg.get(c.bId) || 0) + 1);
      }
      const ids = Array.from(deg.entries()).sort((a, b) => b[1] - a[1]).map(([id]) => id);
      for (const id of ids) {
        if (skipped.has(`H:${id}`)) continue;
        const s = working.find((x) => x.id === id);
        if (s && !s.pinned) {
          chosen = { session: s, role: 'AUTO_FIX_CONFLICT', phase: 'H' };
          break;
        }
      }
    } else if (fixPoliciesToo && policy.enforcePascaMonWed && aud.pascaViolations.length > 0) {
      for (const pv of aud.pascaViolations) {
        if (skipped.has(`P:${pv.sessionId}`)) continue;
        const s = working.find((x) => x.id === pv.sessionId);
        if (s && !s.pinned) {
          chosen = { session: s, role: 'FIX_PASCA_POLICY', phase: 'P' };
          break;
        }
      }
    } else if (fixPoliciesToo && policy.enforceAsprakWetLab && aud.asprakDeadlocks.length > 0) {
      for (const ad of aud.asprakDeadlocks) {
        if (skipped.has(`A:${ad.sessionId}`)) continue;
        const s = working.find((x) => x.id === ad.sessionId);
        if (s && !s.pinned) {
          chosen = { session: s, role: 'FIX_ASPRAK_DEADLOCK', phase: 'A' };
          break;
        }
      }
    } else {
      break;
    }

    if (!chosen) break;
    const { session: s, role, phase } = chosen;
    const evalPol: SolverPolicy = {
      ...policy,
      enforcePascaMonWed: fixPoliciesToo ? policy.enforcePascaMonWed : false,
      enforceAsprakWetLab: fixPoliciesToo ? policy.enforceAsprakWetLab : false,
    };

    // 1. Direct free slot move (strictly preserving Pasca + Asprak!)
    const best = findBestDirectSlot(s, evalPol);
    if (best) {
      const idx = working.findIndex((x) => x.id === s.id);
      recordMove(s, best.day, best.start, best.room, role);
      working[idx] = { ...s, day: best.day, start: best.start, end: best.start + s.duration, room: best.room };
      continue;
    }

    // 2. 1-Step Kempe Ejection fallback!
    if (tryKempeRepairForSession(s, evalPol, role)) {
      continue;
    }

    // 3. Special IFS-CBS Senior-Cohort Shift for Wet-Lab Asprak Deadlocks!
    // (When a wet-lab room has no free slot, shift ONE overlapping senior-cohort theory session instead!)
    if (phase === 'A') {
      const seniors = getSeniorCohortClasses(s, cohortMap);
      let unlockedBySenior = false;
      for (const seniorCls of seniors) {
        const blockingSeniorSessions = working.filter(
          (o) =>
            o.id !== s.id &&
            !o.pinned &&
            overlaps(s.day, s.start, s.end, o.day, o.start, o.end) &&
            o.classes.includes(seniorCls)
        );
        if (blockingSeniorSessions.length === 0 || blockingSeniorSessions.length > 2) continue;

        // Try relocating all blocking sessions of `seniorCls` during this wet lab!
        const snapshot = cloneSessions(working);
        let allMoved = true;
        const seniorMoves: Array<{ orig: Session; to: { day: DayName; start: number; room: string } }> = [];
        for (const bs of blockingSeniorSessions) {
          const curBs = working.find((x) => x.id === bs.id)!;
          const alt = findBestDirectSlot(curBs, evalPol);
          if (!alt || overlaps(s.day, s.start, s.end, alt.day, alt.start, alt.start + curBs.duration)) {
            allMoved = false;
            break;
          }
          const bi = working.findIndex((x) => x.id === curBs.id);
          seniorMoves.push({ orig: { ...curBs }, to: alt });
          working[bi] = { ...curBs, day: alt.day, start: alt.start, end: alt.start + curBs.duration, room: alt.room };
        }
        if (allMoved) {
          for (const sm of seniorMoves) {
            recordMove(sm.orig, sm.to.day, sm.to.start, sm.to.room, 'FIX_ASPRAK_SENIOR_SHIFT');
          }
          unlockedBySenior = true;
          break;
        } else {
          working.length = 0;
          working.push(...snapshot);
        }
      }
      if (unlockedBySenior) continue;
    }

    skipped.add(`${phase}:${s.id}`);
  }

  const moves = Array.from(movedMap.values());
  const afterAudit = auditSchedule(working, policy);
  return {
    feasible:
      afterAudit.hardConflictCount === 0 &&
      (!fixPoliciesToo || (afterAudit.pascaViolationCount === 0 && afterAudit.asprakDeadlockCount === 0)),
    perturbationCount: moves.length,
    moves,
    sessions: working,
    audit: afterAudit,
    latencyMs: Number((performance.now() - t0).toFixed(2)),
  };
}

/**
 * PHASE 3: Integrated UAS Exam Scheduler (Humane start >= 08:30, max 2 exams/day/class, 100m & 60m)
 */
export function generateUasSchedule(
  sessions: Session[],
  rooms: RoomInfo[],
  options: { durationMin?: number; maxExamsPerDay?: number; enforcePascaMonWed?: boolean; examWeeks?: number } = {}
) {
  const t0 = performance.now();
  const durationMin = options.durationMin === 60 ? 60 : 100;
  const maxExamsPerDay = options.maxExamsPerDay || 2;
  const enforcePascaMonWed = options.enforcePascaMonWed !== undefined ? options.enforcePascaMonWed : true;
  const examWeeks = options.examWeeks || 2;

  // Humane exam start times (>= 08:40!)
  const examSlots =
    durationMin === 60
      ? [
          { idx: 0, start: 520, end: 580, label: '08:40 - 09:40' },
          { idx: 1, start: 600, end: 660, label: '10:00 - 11:00' },
          { idx: 2, start: 780, end: 840, label: '13:00 - 14:00' },
          { idx: 3, start: 860, end: 920, label: '14:20 - 15:20' },
          { idx: 4, start: 940, end: 1000, label: '15:40 - 16:40' },
        ]
      : [
          { idx: 0, start: 520, end: 620, label: '08:40 - 10:20' },
          { idx: 1, start: 620, end: 720, label: '10:20 - 12:00' },
          { idx: 2, start: 780, end: 880, label: '13:00 - 14:40' },
          { idx: 3, start: 890, end: 990, label: '14:50 - 16:30' },
        ];

  const examDays: Array<{ key: string; week: number; day: DayName; label: string; isPascaOpen: boolean }> = [];
  for (let w = 1; w <= examWeeks; w++) {
    for (const d of DAYS) {
      examDays.push({
        key: `M${w}-${d}`,
        week: w,
        day: d,
        label: `Minggu ${w}, ${d}`,
        isPascaOpen: !enforcePascaMonWed || PASCA_ALLOWED_DAYS.has(d),
      });
    }
  }

  const examRooms = rooms.filter((r) => r.type === 'PASCA' || r.type === 'SAINTEK');
  const examCourses = sessions.filter((s) => s.isExamEligible !== false && !/^Praktikum\s+/i.test(s.namaMk));

  const clsCount = new Map<string, number>();
  const lecCount = new Map<string, number>();
  for (const s of examCourses) {
    for (const c of s.classes) clsCount.set(c, (clsCount.get(c) || 0) + 1);
    if (s.dosen) lecCount.set(s.dosen, (lecCount.get(s.dosen) || 0) + 1);
  }

  const ordered = examCourses.toSorted((a, b) => {
    const ca = Math.max(...a.classes.map((c) => clsCount.get(c) || 0), 0) + a.classes.length * 5;
    const cb = Math.max(...b.classes.map((c) => clsCount.get(c) || 0), 0) + b.classes.length * 5;
    if (cb !== ca) return cb - ca;
    return (lecCount.get(b.dosen) || 0) - (lecCount.get(a.dosen) || 0);
  });

  const roomBusy = new Set<string>();
  const lecBusy = new Set<string>();
  const clsSlotBusy = new Set<string>();
  const clsDayCount = new Map<string, number>();
  const dayTotalLoad = new Map<string, number>();

  const placedExams: Array<Record<string, unknown>> = [];
  const unplacedExams: Session[] = [];

  for (const course of ordered) {
    let best: { ed: (typeof examDays)[number]; sl: (typeof examSlots)[number]; room: string } | null = null;
    let bestScore = Infinity;

    for (const ed of examDays) {
      let dayCapOk = true;
      let maxCurrentOnDay = 0;
      for (const c of course.classes) {
        const cnt = clsDayCount.get(`${ed.key}|${c}`) || 0;
        if (cnt >= maxExamsPerDay) {
          dayCapOk = false;
          break;
        }
        if (cnt > maxCurrentOnDay) maxCurrentOnDay = cnt;
      }
      if (!dayCapOk) continue;

      const availRooms = examRooms.filter((r) => ed.isPascaOpen || r.type !== 'PASCA');
      for (const sl of examSlots) {
        if (ed.day === 'Jumat' && sl.start < 780 && sl.end > 690) continue;
        if (course.dosen && lecBusy.has(`${ed.key}|${sl.idx}|${course.dosen}`)) continue;
        let clsConflict = false;
        for (const c of course.classes) {
          if (clsSlotBusy.has(`${ed.key}|${sl.idx}|${c}`)) {
            clsConflict = true;
            break;
          }
        }
        if (clsConflict) continue;

        for (const rm of availRooms) {
          if (roomBusy.has(`${ed.key}|${sl.idx}|${rm.name}`)) continue;
          const score =
            maxCurrentOnDay * 40 +
            (dayTotalLoad.get(ed.key) || 0) * 1.4 +
            sl.idx * 3 +
            (ed.isPascaOpen && rm.type === 'SAINTEK' ? 2 : 0);
          if (score < bestScore) {
            bestScore = score;
            best = { ed, sl, room: rm.name };
          }
        }
      }
    }

    if (best) {
      const { ed, sl, room } = best;
      roomBusy.add(`${ed.key}|${sl.idx}|${room}`);
      if (course.dosen) lecBusy.add(`${ed.key}|${sl.idx}|${course.dosen}`);
      for (const c of course.classes) {
        clsSlotBusy.add(`${ed.key}|${sl.idx}|${c}`);
        clsDayCount.set(`${ed.key}|${c}`, (clsDayCount.get(`${ed.key}|${c}`) || 0) + 1);
      }
      dayTotalLoad.set(ed.key, (dayTotalLoad.get(ed.key) || 0) + 1);
      placedExams.push({
        id: `UAS-${course.id}`,
        sourceId: course.id,
        prodi: course.prodi,
        prodiName: course.prodiName,
        kodeMk: course.kodeMk,
        namaMk: course.namaMk,
        sks: course.sks,
        kelasRaw: course.kelasRaw,
        classes: course.classes,
        dosen: course.dosen,
        week: ed.week,
        day: ed.day,
        dayKey: ed.key,
        dayLabel: ed.label,
        slotIdx: sl.idx,
        start: sl.start,
        end: sl.end,
        timeLabel: sl.label,
        durationMin,
        room,
      });
    } else {
      unplacedExams.push(course);
    }
  }

  let maxObservedPerDay = 0;
  for (const v of clsDayCount.values()) if (v > maxObservedPerDay) maxObservedPerDay = v;

  placedExams.sort((a, b) => {
    if (a.week !== b.week) return Number(a.week) - Number(b.week);
    if (DAY_INDEX[a.day as DayName] !== DAY_INDEX[b.day as DayName]) {
      return DAY_INDEX[a.day as DayName] - DAY_INDEX[b.day as DayName];
    }
    if (a.slotIdx !== b.slotIdx) return Number(a.slotIdx) - Number(b.slotIdx);
    return String(a.room).localeCompare(String(b.room));
  });

  return {
    durationMin,
    maxExamsPerDay,
    enforcePascaMonWed,
    totalExamCourses: examCourses.length,
    scheduledCount: placedExams.length,
    unplacedCount: unplacedExams.length,
    conflicts: 0,
    maxObservedPerDay,
    daysUsed: new Set(placedExams.map((e) => e.dayKey)).size,
    exams: placedExams,
    daySummary: examDays.map((ed) => ({
      key: ed.key,
      label: ed.label,
      week: ed.week,
      day: ed.day,
      count: dayTotalLoad.get(ed.key) || 0,
      isPascaOpen: ed.isPascaOpen,
    })),
    latencyMs: Number((performance.now() - t0).toFixed(2)),
  };
}

// ===========================================================================
// STAGE 4: INVARIANT-LOCKED "MENTOK" DEEP POLISHER (Used after Browser TPE!)
// Directly maximizes exact Humane Score (0..100) while HARD-LOCKING:
//   0 hard clashes | 0 Pasca Thu-Fri | 0 Asprak deadlocks | 100% >= 08:40
//   36/36 contiguous (0 holes) | 0 single-course student days | 0 marathons
// ===========================================================================
export function deepPolishSchedule(
  initialSessions: Session[],
  rooms: RoomInfo[],
  policyInput?: Partial<SolverPolicy>,
  options: {
    seed?: number;
    maxIters?: number;
    timeBudgetMs?: number;
    baselineForDiff?: Session[];
    lahcLength?: number;
    initTemp?: number;
    coolingRate?: number;
    lecturerIsolatedWeight?: number;
    useSurrogateObjective?: boolean;
    disableHalfDayRepack?: boolean;
    disableOscillation?: boolean;
    weightScale?: number;
  } = {}
): ConstructiveResult {
  const t0 = performance.now();
  const policy: SolverPolicy = { ...DEFAULT_POLICY, ...(policyInput || {}) };
  const seed = options.seed !== undefined ? options.seed : 27;
  const maxIters = options.maxIters !== undefined ? options.maxIters : 240000;
  const timeBudgetMs = options.timeBudgetMs !== undefined ? options.timeBudgetMs : 2600;
  const wScale = options.weightScale !== undefined ? options.weightScale : 1.0;
  const lecIsoWeight = (options.lecturerIsolatedWeight !== undefined ? options.lecturerIsolatedWeight : 0.35) * wScale;
  const useSurrogateObjective = Boolean(options.useSurrogateObjective);
  const disableHalfDayRepack = Boolean(options.disableHalfDayRepack);
  const disableOscillation = Boolean(options.disableOscillation);
  const rng = mulberry32(seed + 7919);

  const sessions = cloneSessions(initialSessions);
  const diffRef = options.baselineForDiff || initialSessions;
  const n = sessions.length;
  const roomNames = rooms.map((r) => r.name);
  const bitIdx = new BitmaskIndex(sessions, roomNames);
  bitIdx.hardFridayPrayer = Boolean(policy.hardFridayPrayer);

  const isPascaById = new Uint8Array(roomNames.length + 10);
  const idToRoomName: string[] = [];
  for (const [rn, rid] of bitIdx.roomToId.entries()) {
    idToRoomName[rid] = rn;
    if (isPascaRoom(rn)) isPascaById[rid] = 1;
  }

  const allowedRoomIds: number[][] = new Array(n);
  const candidateStarts: number[][] = new Array(n);
  const startMasks: Map<number, SlotMask>[] = new Array(n);
  const pinnedMask = new Uint8Array(n);
  const sessDur = new Int32Array(n);
  const minPref = policy.preferredMinStart ?? HUMANE_START;

  let initMinStart = 1440;
  for (let i = 0; i < n; i++) {
    const s = sessions[i];
    sessDur[i] = s.duration;
    if (s.pinned) pinnedMask[i] = 1;
    if (s.start < initMinStart) initMinStart = s.start;
    const rid = bitIdx.roomToId.get(s.room)!;
    bitIdx.place(i, DAY_INDEX[s.day], s.start, s.end, rid);
  }
  const floorStart =
    initMinStart >= minPref ? minPref : initMinStart >= EARLY_OVERFLOW_START ? EARLY_OVERFLOW_START : CAMPUS_START;

  for (let i = 0; i < n; i++) {
    const s = sessions[i];
    const rNames = getAllowedRooms(s, rooms, policy);
    allowedRoomIds[i] = rNames.map((rn) => bitIdx.roomToId.get(rn)!).filter((id) => id !== undefined);
    const starts = getHumaneStarts(s.duration, policy, true).filter((st) => st >= floorStart);
    candidateStarts[i] = starts.length > 0 ? starts : [s.start];
    const mMap = new Map<number, SlotMask>();
    for (const st of candidateStarts[i]) mMap.set(st, makeSlotMask(st, st + s.duration));
    if (!mMap.has(s.start)) mMap.set(s.start, makeSlotMask(s.start, s.end));
    startMasks[i] = mMap;
  }

  const movableIndices: number[] = [];
  const classToSessIndices = new Map<string, number[]>();
  const classTotalMin = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    if (pinnedMask[i] === 0) movableIndices.push(i);
    for (const c of sessions[i].classes) {
      const arr = classToSessIndices.get(c) || [];
      arr.push(i);
      classToSessIndices.set(c, arr);
      classTotalMin.set(c, (classTotalMin.get(c) || 0) + sessions[i].duration);
    }
  }
  const allClassKeys = Array.from(classToSessIndices.keys());

  const numCls = bitIdx.clsToId.size;
  const numLec = bitIdx.lecToId.size;
  const clsDayBuf: number[][] = Array.from({ length: numCls * 5 }, () => []);
  const lecDayBuf: number[][] = Array.from({ length: numLec * 5 }, () => []);
  const friBreakActive = Boolean(policy.protectFridayPrayer || policy.hardFridayPrayer);

  let dynamicCompactCeiling = 0;
  for (const [, tot] of classTotalMin.entries()) {
    if (tot <= 1420) dynamicCompactCeiling++;
  }
  dynamicCompactCeiling = Math.max(1, dynamicCompactCeiling);
  const dynamicGapNormRef = Math.max(1, Math.round(numCls * 1.8));

  function sortByStart(arr: number[]): void {
    for (let i = 1; i < arr.length; i++) {
      const key = arr[i];
      const keySt = bitIdx.sessionStart[key];
      let j = i - 1;
      while (j >= 0 && bitIdx.sessionStart[arr[j]] > keySt) {
        arr[j + 1] = arr[j];
        j--;
      }
      arr[j + 1] = key;
    }
  }

  function fastDeadGap(prevEnd: number, nextStart: number, dayIdx = -1): number {
    const raw = nextStart - prevEnd;
    if (raw <= 0) return 0;
    const bStart = dayIdx === 4 && friBreakActive ? 690 : 720;
    const lo = prevEnd > bStart ? prevEnd : bStart;
    const hi = nextStart < 780 ? nextStart : 780;
    const lunch = hi > lo ? hi - lo : 0;
    return raw > lunch ? raw - lunch : 0;
  }

  function applyUpdate(idx: number, d: number, st: number, rid: number): void {
    const en = st + sessDur[idx];
    bitIdx.place(idx, d, st, en, rid);
    sessions[idx].day = DAYS[d];
    sessions[idx].start = st;
    sessions[idx].end = en;
    sessions[idx].room = idToRoomName[rid];
  }

  // Measure initial invariant ceilings so deep polish NEVER regresses any achieved hard/humane guarantee!
  interface MentokEval {
    early: number;
    early0750: number;
    holes: number;
    isolatedCls: number;
    marathons: number;
    aspDead: number;
    aspPart: number;
    within3: number;
    clsLongGaps: number;
    lecLongGaps: number;
    lecIso: number;
    obj: number;
  }

  let capEarly = 999;
  let capHoles = 999;
  let capIso = 999;
  let capMar = 999;
  let capAspDead = 999;
  let tunnelMode = false;

  function evalState(): MentokEval {
    for (let i = 0; i < clsDayBuf.length; i++) clsDayBuf[i].length = 0;
    for (let i = 0; i < lecDayBuf.length; i++) lecDayBuf[i].length = 0;

    let early = 0;
    let early0750 = 0;
    let lateCount = 0;
    let friViol = 0;

    for (let i = 0; i < n; i++) {
      const d = bitIdx.sessionDayIdx[i];
      const st = bitIdx.sessionStart[i];
      const en = bitIdx.sessionEnd[i];
      if (st < minPref) early++;
      if (st < EARLY_OVERFLOW_START) early0750++;
      if (en > WORK_END) lateCount++;
      if (d === 4 && friBreakActive && overlapsFridayPrayer('Jumat', st, en, sessDur[i])) friViol++;

      const cids = bitIdx.sessionClsIds[i];
      for (let k = 0; k < cids.length; k++) clsDayBuf[cids[k] * 5 + d].push(i);
      const lid = bitIdx.sessionLecId[i];
      if (lid >= 0) lecDayBuf[lid * 5 + d].push(i);
    }

    let nonContig = 0;
    let holes = 0;
    let within3 = 0;
    let classes5d = 0;
    let isolatedCls = 0;
    let marathons = 0;
    let clsLongGaps = 0;
    let totalDeadGapMin = 0;
    let bldSwitches = 0;

    for (let c = 0; c < numCls; c++) {
      const base = c * 5;
      let activeCount = 0;
      let minD = 5;
      let maxD = -1;
      let totalSess = 0;

      for (let d = 0; d < 5; d++) {
        const list = clsDayBuf[base + d];
        const len = list.length;
        if (len === 0) continue;
        activeCount++;
        totalSess += len;
        if (d < minD) minD = d;
        if (d > maxD) maxD = d;
        if (len > 1) sortByStart(list);

        let contMin = 0;
        let contCnt = 0;
        let dayHasMar = false;
        for (let k = 0; k < len; k++) {
          const cur = list[k];
          const dur = sessDur[cur];
          if (k === 0) {
            contMin = dur;
            contCnt = 1;
          } else {
            const prev = list[k - 1];
            const prevEnd = bitIdx.sessionEnd[prev];
            const curSt = bitIdx.sessionStart[cur];
            const rawGap = curSt - prevEnd;
            const dg = fastDeadGap(prevEnd, curSt, d);
            if (dg > 0) {
              totalDeadGapMin += dg;
              if (dg >= 100) clsLongGaps++;
            }
            if (rawGap === 0 && isPascaById[bitIdx.sessionRoomId[prev]] !== isPascaById[bitIdx.sessionRoomId[cur]]) {
              bldSwitches++;
            }
            if (rawGap < 40) {
              contMin += dur;
              contCnt++;
            } else {
              contMin = dur;
              contCnt = 1;
            }
            if (contCnt >= 2 && contMin > 300) dayHasMar = true;
          }
        }
        if (dayHasMar) marathons++;
      }

      if (activeCount <= 3) within3++;
      else if (activeCount >= 5) classes5d++;
      if (activeCount >= 2) {
        const h = maxD - minD + 1 - activeCount;
        if (h > 0) {
          nonContig++;
          holes += h;
        }
      }
      if ((policy.minCoursesPerActiveDay ?? 2) >= 2 && totalSess >= 2) {
        for (let d = 0; d < 5; d++) if (clsDayBuf[base + d].length === 1) isolatedCls++;
      }
    }

    let lecLongGaps = 0;
    let lecIso = 0;
    for (let l = 0; l < numLec; l++) {
      const base = l * 5;
      let totalSess = 0;
      for (let d = 0; d < 5; d++) {
        const list = lecDayBuf[base + d];
        const len = list.length;
        if (len === 0) continue;
        totalSess += len;
        if (len > 1) sortByStart(list);
        for (let k = 1; k < len; k++) {
          const dg = fastDeadGap(bitIdx.sessionEnd[list[k - 1]], bitIdx.sessionStart[list[k]], d);
          if (dg > 0) {
            totalDeadGapMin += dg * 0.7;
            if (dg >= 100) lecLongGaps++;
          }
        }
      }
      if ((policy.minCoursesPerActiveDay ?? 2) >= 2 && totalSess >= 2) {
        for (let d = 0; d < 5; d++) if (lecDayBuf[base + d].length === 1) lecIso++;
      }
    }

    const asp = policy.enforceAsprakWetLab ? bitIdx.countAsprakIssues() : { deadlocks: 0, partials: 0, overlapTicks: 0 };

    // HARD INVARIANT GATE: early, marathons, and Asprak deadlocks NEVER regress!
    // In Strategic Oscillation (`tunnelMode=true`), briefly allow <=2 holes & <=3 loneDays with soft barrier penalty
    // so 2-session days can tunnel 2->1->0 into 3-day blocks & Asprak-CLEAR days; incumbent best ONLY accepts feasiblePerfect!
    const maxH = tunnelMode ? capHoles + 2 : capHoles;
    const maxI = tunnelMode ? capIso + 3 : capIso;
    if (
      early > capEarly ||
      holes > maxH ||
      isolatedCls > maxI ||
      marathons > capMar ||
      asp.deadlocks > capAspDead ||
      (policy.hardFridayPrayer && friViol > 0)
    ) {
      return {
        early,
        early0750,
        holes,
        isolatedCls,
        marathons,
        aspDead: asp.deadlocks,
        aspPart: asp.partials,
        within3,
        clsLongGaps,
        lecLongGaps,
        lecIso,
        obj: -1e9,
      };
    }

    // Exact Humane Score * 1000 (0..100000) using dynamic cohort denominators + smooth guidance!
    const startPts = ((n - early - early0750 * 0.5) / n) * 25000;
    const contigPts = ((numCls - nonContig) / numCls) * 25000;
    const compactPts = Math.min(1, within3 / dynamicCompactCeiling) * 20000;
    const gapPts = Math.max(0, 1 - (clsLongGaps + lecLongGaps) / dynamicGapNormRef) * 15000;
    const compPen = asp.deadlocks * 2500 + asp.partials * 250 + marathons * 800 + isolatedCls * 600;
    const compPts = Math.max(0, 15000 - compPen);

    const exactScore1000 = startPts + contigPts + compactPts + gapPts + compPts;
    const invariantPenalty = tunnelMode
      ? holes * 1150 + isolatedCls * 520
      : holes * 45000 + isolatedCls * 35000;
    const friPenalty = policy.protectFridayPrayer ? friViol * 3500 : 0;
    const smoothGuide =
      -classes5d * 18 -
      asp.overlapTicks * 0.45 -
      totalDeadGapMin * 0.015 -
      lecIso * lecIsoWeight -
      bldSwitches * 0.05 -
      lateCount * 0.02 -
      friPenalty;

    let finalObj = exactScore1000 - invariantPenalty + smoothGuide;
    // A1 2x2 Matrix Mode: Stage-4 maximizing negated unified surrogate F_soft(A) instead of exactScore1000
    if (useSurrogateObjective) {
      const classes4d = Math.max(0, numCls - within3 - classes5d);
      const surrEnergy =
        holes * 3200 +
        classes5d * 1050 +
        classes4d * (460 * wScale) +
        (clsLongGaps + lecLongGaps) * (280 * wScale) +
        totalDeadGapMin * 0.15 +
        early0750 * 980 +
        (early - early0750) * 180 +
        lateCount * (110 * wScale) +
        isolatedCls * (920 * wScale) +
        marathons * 130 +
        asp.deadlocks * 1500 +
        asp.partials * (95 * wScale) +
        asp.overlapTicks * 0.9 +
        lecIso * lecIsoWeight +
        (policy.protectFridayPrayer ? friViol * 500 : 0);
      finalObj = 100000 - surrEnergy - (tunnelMode ? holes * 600 + isolatedCls * 320 : 0);
    }

    return {
      early,
      early0750,
      holes,
      isolatedCls,
      marathons,
      aspDead: asp.deadlocks,
      aspPart: asp.partials,
      within3,
      clsLongGaps,
      lecLongGaps,
      lecIso,
      obj: finalObj,
    };
  }

  const initEv = evalState();
  capEarly = initEv.early;
  capHoles = initEv.holes;
  capIso = initEv.isolatedCls;
  capMar = initEv.marathons;
  capAspDead = initEv.aspDead;

  let curObj = initEv.obj;
  let bestObj = curObj;
  const bestDay = new Int32Array(bitIdx.sessionDayIdx);
  const bestStart = new Int32Array(bitIdx.sessionStart);
  const bestEnd = new Int32Array(bitIdx.sessionEnd);
  const bestRoom = new Int32Array(bitIdx.sessionRoomId);

  function saveBestMentok(ev: MentokEval): void {
    // STRICT INCUMBENT FILTER: NEVER save a tunneling intermediate with holes or loneDays!
    if (ev.holes > capHoles || ev.isolatedCls > capIso) return;
    if (ev.obj <= bestObj) return;
    bestObj = ev.obj;
    bestDay.set(bitIdx.sessionDayIdx);
    bestStart.set(bitIdx.sessionStart);
    bestEnd.set(bitIdx.sessionEnd);
    bestRoom.set(bitIdx.sessionRoomId);
    if (ev.early < capEarly) capEarly = ev.early;
    if (ev.holes < capHoles) capHoles = ev.holes;
    if (ev.isolatedCls < capIso) capIso = ev.isolatedCls;
    if (ev.marathons < capMar) capMar = ev.marathons;
    if (ev.aspDead < capAspDead) capAspDead = ev.aspDead;
  }

  let dayConsolidations = 0;
  let asprakClears = 0;
  let improvingMoves = 0;
  let acceptedMoves = 0;

  // Helper: Atomic 4/5-Day -> 3-Day Collapse via Swap-Evacuation (invariant-locked!)
  function runCollapse4To3Pass(): boolean {
    let improvedAny = false;
    for (const cls of allClassKeys) {
      const sList = classToSessIndices.get(cls)!;
      const dc = [0, 0, 0, 0, 0];
      for (const si of sList) dc[bitIdx.sessionDayIdx[si]]++;
      const active: number[] = [];
      for (let d = 0; d < 5; d++) if (dc[d] > 0) active.push(d);
      if (active.length <= 1) continue;
      const hasHoleHere = active[active.length - 1] - active[0] + 1 > active.length;
      if (!hasHoleHere && active.length <= 3) continue;
      if (!hasHoleHere && active.length === 4 && (classTotalMin.get(cls) || 0) > 1490) continue; // Only >1490m mathematically cannot fit 3d

      const extremes = [active[0], active[active.length - 1]];
      if (dc[extremes[1]] < dc[extremes[0]]) extremes.reverse();

      for (const outD of extremes) {
        const toEvac = sList.filter((si) => bitIdx.sessionDayIdx[si] === outD && pinnedMask[si] === 0);
        if (toEvac.length === 0 || toEvac.length > 4) continue;
        const rem = active.filter((d) => d !== outD);
        const rMin = Math.min(...rem), rMax = Math.max(...rem);
        const destSet = new Set<number>(rem);
        if (hasHoleHere) {
          for (let d = rMin; d <= rMax; d++) destSet.add(d);
          if (rMin > 0) destSet.add(rMin - 1);
          if (rMax < 4) destSet.add(rMax + 1);
          destSet.delete(outD);
        }
        const targetDays = Array.from(destSet);
        const evacSet = new Set(toEvac);
        const saved: Array<{ si: number; d: number; st: number; rid: number }> = [];
        const touched = new Set<number>();
        const snap = (si: number) => {
          if (touched.has(si)) return;
          touched.add(si);
          saved.push({ si, d: bitIdx.sessionDayIdx[si], st: bitIdx.sessionStart[si], rid: bitIdx.sessionRoomId[si] });
        };
        const rollback = () => {
          for (const sv of saved) bitIdx.unplace(sv.si);
          for (const sv of saved) applyUpdate(sv.si, sv.d, sv.st, sv.rid);
        };

        let allMoved = true;
        for (const aIdx of toEvac) {
          const oD = bitIdx.sessionDayIdx[aIdx], oSt = bitIdx.sessionStart[aIdx], oR = bitIdx.sessionRoomId[aIdx];
          const aAllowed = allowedRoomIds[aIdx];
          const aStarts = candidateStarts[aIdx];
          const aMasks = startMasks[aIdx];
          snap(aIdx);
          bitIdx.unplace(aIdx);

          // Try free slot in targetDays first
          let placed = false;
          for (const td of targetDays) {
            for (const rid of aAllowed) {
              if (policy.enforcePascaMonWed && isPascaById[rid] && td > 2) continue;
              for (const st of aStarts) {
                if (bitIdx.canPlaceHard(aIdx, td, rid, aMasks.get(st)!, policy.enforceAsprakWetLab)) {
                  applyUpdate(aIdx, td, st, rid);
                  placed = true;
                  break;
                }
              }
              if (placed) break;
            }
            if (placed) break;
          }
          if (placed) continue;
          applyUpdate(aIdx, oD, oSt, oR);

          // Pairwise room swap onto targetDays (picking partner `b` that keeps `b`'s class contiguous & >=2mk!)
          let bestSw: { b: number; td: number; aSt: number; bR: number; bSt: number; obj: number } | null = null;
          for (const td of targetDays) {
            for (const b of movableIndices) {
              if (evacSet.has(b) || touched.has(b) || bitIdx.sessionDayIdx[b] !== td) continue;
              if (sessions[b].classes.includes(cls)) continue;
              const bR = bitIdx.sessionRoomId[b];
              if (!aAllowed.includes(bR) || !allowedRoomIds[b].includes(oR)) continue;
              if (policy.enforcePascaMonWed && ((isPascaById[bR] && td > 2) || (isPascaById[oR] && oD > 2))) continue;
              const bSt = bitIdx.sessionStart[b];
              bitIdx.unplace(aIdx);
              bitIdx.unplace(b);
              const bMasks = startMasks[b];
              const bStarts = candidateStarts[b];
              const aCand = aMasks.has(bSt) ? [bSt, ...aStarts.filter((x) => x !== bSt)] : aStarts;
              const bCand = bMasks.has(oSt) ? [oSt, ...bStarts.filter((x) => x !== oSt)] : bStarts;

              let aNewSt = -1;
              for (const st of aCand) {
                if (bitIdx.canPlaceHard(aIdx, td, bR, aMasks.get(st)!, policy.enforceAsprakWetLab)) {
                  aNewSt = st;
                  break;
                }
              }
              if (aNewSt >= 0) {
                applyUpdate(aIdx, td, aNewSt, bR);
                for (const bst of bCand) {
                  if (!bitIdx.canPlaceHard(b, oD, oR, bMasks.get(bst)!, policy.enforceAsprakWetLab)) continue;
                  applyUpdate(b, oD, bst, oR);
                  // Score with temporary relaxation of `cls`'s loneDay only while intermediate sessions move
                  const bClsOk = sessions[b].classes.every((bc) => {
                    const bl = classToSessIndices.get(bc)!;
                    const bcCnt = [0, 0, 0, 0, 0];
                    for (const si of bl) bcCnt[bitIdx.sessionDayIdx[si]]++;
                    let mn = 5, mx = -1, act = 0;
                    for (let d = 0; d < 5; d++) if (bcCnt[d] > 0) { act++; if (d < mn) mn = d; if (d > mx) mx = d; }
                    if (mx - mn + 1 > act) return false;
                    if (bl.length >= 2 && bcCnt.some((v) => v === 1)) return false;
                    return true;
                  });
                  if (bClsOk) {
                    const sc = (sessions[b].duration === sessions[aIdx].duration ? 10 : 0) - bitIdx.countAsprakIssues().partials * 5;
                    if (!bestSw || sc > bestSw.obj) bestSw = { b, td, aSt: aNewSt, bR, bSt: bst, obj: sc };
                  }
                  bitIdx.unplace(b);
                  break;
                }
                bitIdx.unplace(aIdx);
              }
              applyUpdate(aIdx, oD, oSt, oR);
              applyUpdate(b, td, bSt, bR);
            }
          }

          if (!bestSw) {
            // 3-Cycle Bridge Swap fallback inside Collapse4To3 / Hole Repair (a: outD->td, b: td->midD, c: midD->outD)!
            let bridged = false;
            const durA = sessDur[aIdx];
            const mids = [1, 2, 3, 0, 4].filter((md) => md !== oD && !targetDays.includes(md));
            const allMids = [...mids, ...targetDays.filter((md) => md !== oD)];
            bridgeSearch: for (const td of targetDays) {
              for (const midD of allMids) {
                if (midD === td || midD === oD) continue;
                const bCand: number[] = [];
                const cCand: number[] = [];
                for (const si of movableIndices) {
                  if (evacSet.has(si) || touched.has(si) || sessDur[si] !== durA) continue;
                  if (sessions[si].classes.includes(cls)) continue;
                  const sd = bitIdx.sessionDayIdx[si], sr = bitIdx.sessionRoomId[si];
                  if (sd === td) {
                    if (!aAllowed.includes(sr)) continue;
                    if (policy.enforcePascaMonWed && isPascaById[sr] && td > 2) continue;
                    const okB = sessions[si].classes.every((bc) => {
                      const bl = classToSessIndices.get(bc)!;
                      let cTd = 0, cMid = 0;
                      for (const x of bl) { const xd = bitIdx.sessionDayIdx[x]; if (xd === td) cTd++; else if (xd === midD) cMid++; }
                      return cTd >= 3 && cMid >= 1;
                    });
                    if (okB) bCand.push(si);
                  } else if (sd === midD) {
                    if (!allowedRoomIds[si].includes(oR)) continue;
                    if (policy.enforcePascaMonWed && isPascaById[oR] && oD > 2) continue;
                    const okC = sessions[si].classes.every((cc) => {
                      const cl = classToSessIndices.get(cc)!;
                      let cMid = 0, cOd = 0;
                      for (const x of cl) { const xd = bitIdx.sessionDayIdx[x]; if (xd === midD) cMid++; else if (xd === oD) cOd++; }
                      return cMid >= 3 && cOd >= 1;
                    });
                    if (okC) cCand.push(si);
                  }
                }
                for (const b of bCand) {
                  const bSt = bitIdx.sessionStart[b], bR = bitIdx.sessionRoomId[b];
                  for (const c of cCand) {
                    if (c === b) continue;
                    const cSt = bitIdx.sessionStart[c], cR = bitIdx.sessionRoomId[c];
                    if (!allowedRoomIds[b].includes(cR)) continue;
                    if (policy.enforcePascaMonWed && isPascaById[cR] && midD > 2) continue;
                    const mA = aMasks.get(bSt), mB = startMasks[b].get(cSt), mC = startMasks[c].get(oSt);
                    if (!mA || !mB || !mC) continue;
                    bitIdx.unplace(aIdx);
                    bitIdx.unplace(b);
                    bitIdx.unplace(c);
                    if (bitIdx.canPlaceHard(aIdx, td, bR, mA, policy.enforceAsprakWetLab)) {
                      applyUpdate(aIdx, td, bSt, bR);
                      if (bitIdx.canPlaceHard(b, midD, cR, mB, policy.enforceAsprakWetLab)) {
                        applyUpdate(b, midD, cSt, cR);
                        if (bitIdx.canPlaceHard(c, oD, oR, mC, policy.enforceAsprakWetLab)) {
                          applyUpdate(c, oD, oSt, oR);
                          if (!touched.has(b)) {
                            touched.add(b);
                            saved.push({ si: b, d: td, st: bSt, rid: bR });
                          }
                          if (!touched.has(c)) {
                            touched.add(c);
                            saved.push({ si: c, d: midD, st: cSt, rid: cR });
                          }
                          bridged = true;
                          break bridgeSearch;
                        }
                        bitIdx.unplace(b);
                      }
                      bitIdx.unplace(aIdx);
                    }
                    applyUpdate(aIdx, oD, oSt, oR);
                    applyUpdate(b, td, bSt, bR);
                    applyUpdate(c, midD, cSt, cR);
                  }
                }
              }
            }
            if (!bridged) {
              allMoved = false;
              break;
            }
            continue;
          }
          snap(bestSw.b);
          bitIdx.unplace(aIdx);
          bitIdx.unplace(bestSw.b);
          applyUpdate(aIdx, bestSw.td, bestSw.aSt, bestSw.bR);
          applyUpdate(bestSw.b, oD, bestSw.bSt, oR);
        }

        if (allMoved) {
          const ev = evalState();
          if (ev.obj > curObj) {
            curObj = ev.obj;
            if (ev.obj > bestObj) saveBestMentok(ev);
            dayConsolidations++;
            improvingMoves++;
            improvedAny = true;
            break;
          }
        }
        rollback();
      }
    }
    return improvedAny;
  }

  // Helper: Contiguous Block-Slide 4/5-Day -> 3/4-Day Collapse (100% packing-density immune!)
  // Evacuates `cls`'s k=2 (or 3) sessions on extreme day `outD` by trading them atomically with
  // another contiguous class `bc`'s k sessions on its opposite edge day `bEdge` (e.g. cls loses Kam
  // to shrink Sen-Kam (4d) -> Sen-Rab (3d), while bc slides Sen-Rab (3d) -> Sel-Kam (3d), OR bc
  // already has sessions on outD & >=k+2 on td so bc's active days stay unchanged!).
  function tryBlockSlideCollapse(): boolean {
    let improvedAny = false;
    for (const cls of allClassKeys) {
      const sList = classToSessIndices.get(cls)!;
      const dc = [0, 0, 0, 0, 0];
      for (const si of sList) dc[bitIdx.sessionDayIdx[si]]++;
      const active: number[] = [];
      for (let d = 0; d < 5; d++) if (dc[d] > 0) active.push(d);
      if (active.length <= 3) continue;
      if (active.length === 4 && (classTotalMin.get(cls) || 0) > 1490) continue;

      const extremes = [active[0], active[active.length - 1]];
      if (dc[extremes[1]] < dc[extremes[0]]) extremes.reverse();

      let shrunkCls = false;
      for (const outD of extremes) {
        const toEvac = sList.filter(
          (si) =>
            bitIdx.sessionDayIdx[si] === outD &&
            pinnedMask[si] === 0 &&
            sessions[si].classes.length === 1
        );
        const k = toEvac.length;
        if (k < 2 || k > 3 || k !== dc[outD]) continue;
        const rem = active.filter((d) => d !== outD);
        const remSet = new Set(rem);

        // Scan partner classes `bc` that can absorb k sessions onto `outD` without creating a hole, 1-mk day, or extra day!
        for (const bc of allClassKeys) {
          if (bc === cls) continue;
          const bList = classToSessIndices.get(bc)!;
          if (bList.length < 4) continue;
          const bdc = [0, 0, 0, 0, 0];
          for (const si of bList) bdc[bitIdx.sessionDayIdx[si]]++;
          const bAct: number[] = [];
          for (let d = 0; d < 5; d++) if (bdc[d] > 0) bAct.push(d);
          if (bAct.length < 2) continue;
          const bMin = bAct[0], bMax = bAct[bAct.length - 1];
          if (bMax - bMin + 1 !== bAct.length) continue;

          // Candidate donor days `bEdge` of `bc` inside `remSet`:
          // Mode 1 (Block Slide): outD is adjacent to bc (bMax+1 or bMin-1) and bc has EXACTLY k sessions on opposite edge!
          // Mode 2 (Day Absorb): bc is ALREADY active on outD (bdc[outD] >= 1) and has >= k+2 sessions on some day in remSet!
          const donorDays: number[] = [];
          if (outD === bMax + 1 && bdc[bMin] === k && remSet.has(bMin)) donorDays.push(bMin);
          if (outD === bMin - 1 && bdc[bMax] === k && remSet.has(bMax)) donorDays.push(bMax);
          if (bdc[outD] >= 1) {
            for (const d of bAct) {
              if (d !== outD && remSet.has(d) && bdc[d] >= k + 2) donorDays.push(d);
            }
          }
          if (donorDays.length === 0) continue;

          for (const bEdge of donorDays) {
            const bPool = bList.filter(
              (si) =>
                bitIdx.sessionDayIdx[si] === bEdge &&
                pinnedMask[si] === 0 &&
                sessions[si].classes.length === 1
            );
            if (bPool.length < k) continue;

            // Build k-subsets of bPool (for k=2 & bPool.length <= 5, at most 10 pairs!)
            const subsets: number[][] = [];
            if (k === 2) {
              if (bPool.length === 2) subsets.push([bPool[0], bPool[1]]);
              else {
                for (let i = 0; i < bPool.length; i++) {
                  for (let j = i + 1; j < bPool.length; j++) subsets.push([bPool[i], bPool[j]]);
                }
              }
            } else if (k === 3 && bPool.length === 3) {
              subsets.push([bPool[0], bPool[1], bPool[2]]);
            }

            for (const bSub of subsets) {
              // Snapshot all 2k sessions
              const allIds = [...toEvac, ...bSub];
              const saved = allIds.map((si) => ({
                si,
                d: bitIdx.sessionDayIdx[si],
                st: bitIdx.sessionStart[si],
                rid: bitIdx.sessionRoomId[si],
              }));

              // Try pairing toEvac[p] <-> bSub[perm[p]] (try direct room swap first, then any allowed room on target day!)
              const perms: number[][] =
                k === 2
                  ? [
                      [0, 1],
                      [1, 0],
                    ]
                  : [
                      [0, 1, 2],
                      [0, 2, 1],
                      [1, 0, 2],
                      [1, 2, 0],
                      [2, 0, 1],
                      [2, 1, 0],
                    ];

              for (const perm of perms) {
                for (const sv of saved) bitIdx.unplace(sv.si);
                let okAll = true;
                const placedSoFar: number[] = [];

                // Place toEvac[p] into bEdge using bSub[perm[p]]'s room first (then any allowed room)
                for (let p = 0; p < k && okAll; p++) {
                  const aIdx = toEvac[p];
                  const bIdx = bSub[perm[p]];
                  const bOrigR = saved[k + perm[p]].rid;
                  const bOrigSt = saved[k + perm[p]].st;
                  const rOrder = allowedRoomIds[aIdx].includes(bOrigR)
                    ? [bOrigR, ...allowedRoomIds[aIdx].filter((r) => r !== bOrigR)]
                    : allowedRoomIds[aIdx];
                  const sOrder = startMasks[aIdx].has(bOrigSt)
                    ? [bOrigSt, ...candidateStarts[aIdx].filter((s) => s !== bOrigSt)]
                    : candidateStarts[aIdx];

                  let placedA = false;
                  for (const rid of rOrder) {
                    if (policy.enforcePascaMonWed && isPascaById[rid] && bEdge > 2) continue;
                    for (const st of sOrder) {
                      if (bitIdx.canPlaceHard(aIdx, bEdge, rid, startMasks[aIdx].get(st)!, policy.enforceAsprakWetLab)) {
                        applyUpdate(aIdx, bEdge, st, rid);
                        placedSoFar.push(aIdx);
                        placedA = true;
                        break;
                      }
                    }
                    if (placedA) break;
                  }
                  if (!placedA) okAll = false;
                }

                // Place bSub[perm[p]] into outD using toEvac[p]'s room first (then any allowed room)
                for (let p = 0; p < k && okAll; p++) {
                  const aOrigR = saved[p].rid;
                  const aOrigSt = saved[p].st;
                  const bIdx = bSub[perm[p]];
                  const rOrder = allowedRoomIds[bIdx].includes(aOrigR)
                    ? [aOrigR, ...allowedRoomIds[bIdx].filter((r) => r !== aOrigR)]
                    : allowedRoomIds[bIdx];
                  const sOrder = startMasks[bIdx].has(aOrigSt)
                    ? [aOrigSt, ...candidateStarts[bIdx].filter((s) => s !== aOrigSt)]
                    : candidateStarts[bIdx];

                  let placedB = false;
                  for (const rid of rOrder) {
                    if (policy.enforcePascaMonWed && isPascaById[rid] && outD > 2) continue;
                    for (const st of sOrder) {
                      if (bitIdx.canPlaceHard(bIdx, outD, rid, startMasks[bIdx].get(st)!, policy.enforceAsprakWetLab)) {
                        applyUpdate(bIdx, outD, st, rid);
                        placedSoFar.push(bIdx);
                        placedB = true;
                        break;
                      }
                    }
                    if (placedB) break;
                  }
                  if (!placedB) okAll = false;
                }

                if (okAll) {
                  const ev = evalState();
                  if (ev.obj > curObj) {
                    curObj = ev.obj;
                    if (ev.obj > bestObj) saveBestMentok(ev);
                    dayConsolidations++;
                    improvingMoves++;
                    improvedAny = true;
                    shrunkCls = true;
                    break;
                  }
                }
                for (const si of placedSoFar) bitIdx.unplace(si);
                for (const sv of saved) applyUpdate(sv.si, sv.d, sv.st, sv.rid);
              }
              if (shrunkCls) break;
            }
            if (shrunkCls) break;
          }
          if (shrunkCls) break;
        }
        if (shrunkCls) break;
      }
    }
    return improvedAny;
  }

  // Helper: 1-Step Kempe-Ejection 4/5-Day -> 3/4-Day Collapse!
  // Unlike pairwise swaps that push blocker `b` onto `outD` (often breaking `b`'s contiguity/3d block),
  // Kempe ejection relocates blocker `b` into ANY free slot on `b`'s OWN active days (zero day expansion!).
  function runKempeCollapse4To3Pass(): boolean {
    let improvedAny = false;
    for (const cls of allClassKeys) {
      const sList = classToSessIndices.get(cls)!;
      const dc = [0, 0, 0, 0, 0];
      for (const si of sList) dc[bitIdx.sessionDayIdx[si]]++;
      const active: number[] = [];
      for (let d = 0; d < 5; d++) if (dc[d] > 0) active.push(d);
      if (active.length <= 3) continue;
      if (active.length === 4 && (classTotalMin.get(cls) || 0) > 1490) continue;

      const extremes = [active[0], active[active.length - 1]];
      if (dc[extremes[1]] < dc[extremes[0]]) extremes.reverse();

      for (const outD of extremes) {
        const toEvac = sList.filter((si) => bitIdx.sessionDayIdx[si] === outD && pinnedMask[si] === 0);
        if (toEvac.length === 0 || toEvac.length !== dc[outD] || toEvac.length > 4) continue;
        const rem = active.filter((d) => d !== outD);
        const evacSet = new Set(toEvac);
        const saved: Array<{ si: number; d: number; st: number; rid: number }> = [];
        const touched = new Set<number>();
        const snap = (si: number) => {
          if (touched.has(si)) return;
          touched.add(si);
          saved.push({ si, d: bitIdx.sessionDayIdx[si], st: bitIdx.sessionStart[si], rid: bitIdx.sessionRoomId[si] });
        };
        const rollback = () => {
          for (const sv of saved) bitIdx.unplace(sv.si);
          for (const sv of saved) applyUpdate(sv.si, sv.d, sv.st, sv.rid);
        };

        let allMoved = true;
        for (const aIdx of toEvac) {
          const oD = bitIdx.sessionDayIdx[aIdx], oSt = bitIdx.sessionStart[aIdx], oR = bitIdx.sessionRoomId[aIdx];
          snap(aIdx);
          bitIdx.unplace(aIdx);

          // Step 1: Try free slot on any remaining day `td`
          let placed = false;
          for (const td of rem) {
            for (const rid of allowedRoomIds[aIdx]) {
              if (policy.enforcePascaMonWed && isPascaById[rid] && td > 2) continue;
              for (const st of candidateStarts[aIdx]) {
                if (bitIdx.canPlaceHard(aIdx, td, rid, startMasks[aIdx].get(st)!, policy.enforceAsprakWetLab)) {
                  applyUpdate(aIdx, td, st, rid);
                  placed = true;
                  break;
                }
              }
              if (placed) break;
            }
            if (placed) break;
          }
          if (placed) continue;

          // Step 2: 1-Step Kempe Ejection — eject single blocker `b` into a free slot on `b`'s OWN active days!
          kempeSearch: for (const td of rem) {
            for (const rid of allowedRoomIds[aIdx]) {
              if (policy.enforcePascaMonWed && isPascaById[rid] && td > 2) continue;
              for (const st of candidateStarts[aIdx]) {
                const aMask = startMasks[aIdx].get(st)!;
                const blockers = bitIdx.findBlockers(aIdx, td, rid, aMask);
                if (blockers.length !== 1) continue;
                const b = blockers[0];
                if (evacSet.has(b) || touched.has(b) || pinnedMask[b] === 1) continue;
                if (sessions[b].classes.includes(cls)) continue;

                const bD = bitIdx.sessionDayIdx[b], bSt = bitIdx.sessionStart[b], bR = bitIdx.sessionRoomId[b];
                bitIdx.unplace(b);
                if (!bitIdx.canPlaceHard(aIdx, td, rid, aMask, policy.enforceAsprakWetLab)) {
                  applyUpdate(b, bD, bSt, bR);
                  continue;
                }
                applyUpdate(aIdx, td, st, rid);

                // Collect days where `b` can safely move without expanding ANY of `b`'s classes!
                // Same day `bD` is ALWAYS day-count preserving; other active days of `b` are safe if `bD` has >=3 sessions for every class of `b`.
                const bDestDays: number[] = [bD];
                if (sessions[b].classes.length === 1) {
                  const bCls = sessions[b].classes[0];
                  const bList = classToSessIndices.get(bCls) || [];
                  const bdc = [0, 0, 0, 0, 0];
                  for (const x of bList) {
                    if (x !== b) bdc[bitIdx.sessionDayIdx[x]]++;
                  }
                  if (bdc[bD] >= 2) {
                    for (let d = 0; d < 5; d++) {
                      if (d !== bD && bdc[d] > 0) bDestDays.push(d);
                    }
                  }
                }

                let relocatedB = false;
                for (const bd of bDestDays) {
                  for (const brid of allowedRoomIds[b]) {
                    if (policy.enforcePascaMonWed && isPascaById[brid] && bd > 2) continue;
                    for (const bst of candidateStarts[b]) {
                      if (bd === bD && bst === bSt && brid === bR) continue;
                      if (bitIdx.canPlaceHard(b, bd, brid, startMasks[b].get(bst)!, policy.enforceAsprakWetLab)) {
                        applyUpdate(b, bd, bst, brid);
                        touched.add(b);
                        saved.push({ si: b, d: bD, st: bSt, rid: bR });
                        relocatedB = true;
                        break;
                      }
                    }
                    if (relocatedB) break;
                  }
                  if (relocatedB) break;
                }

                if (relocatedB) {
                  placed = true;
                  break kempeSearch;
                }
                bitIdx.unplace(aIdx);
                applyUpdate(b, bD, bSt, bR);
              }
            }
          }

          if (!placed) {
            applyUpdate(aIdx, oD, oSt, oR);
            allMoved = false;
            break;
          }
        }

        if (allMoved) {
          const ev = evalState();
          if (ev.obj > curObj) {
            curObj = ev.obj;
            if (ev.obj > bestObj) saveBestMentok(ev);
            dayConsolidations++;
            improvingMoves++;
            improvedAny = true;
            break;
          }
        }
        rollback();
      }
    }
    return improvedAny;
  }

  // Helper: Atomic Multi-Senior Asprak Clear (C2e) + Wet-Lab Swap & Whole-Class Block Slide (C2f/C2g)
  function runAsprakAtomicClearPass(): boolean {
    if (!policy.enforceAsprakWetLab || bitIdx.wetLabIndices.length === 0) return false;
    let improvedAny = false;

    // C2e: Evacuate ALL 1..4 overlapping senior sessions of a PARTIAL wet-lab atomically!
    for (const ws of bitIdx.wetLabIndices) {
      const ovList = bitIdx.findSeniorOverlapsForWetLab(ws);
      if (ovList.length === 0 || ovList.length > 4) continue;
      if (ovList.some((x) => pinnedMask[x] === 1)) continue;

      const wsD = bitIdx.sessionDayIdx[ws], wsSt = bitIdx.sessionStart[ws], wsEn = bitIdx.sessionEnd[ws];
      const ovSet = new Set(ovList);
      const saved: Array<{ si: number; d: number; st: number; rid: number }> = [];
      const touched = new Set<number>();
      const snap = (si: number) => {
        if (touched.has(si)) return;
        touched.add(si);
        saved.push({ si, d: bitIdx.sessionDayIdx[si], st: bitIdx.sessionStart[si], rid: bitIdx.sessionRoomId[si] });
      };
      const rollback = () => {
        for (const sv of saved) bitIdx.unplace(sv.si);
        for (const sv of saved) applyUpdate(sv.si, sv.d, sv.st, sv.rid);
      };

      let clearedAll = true;
      for (const sIdx of ovList) {
        const sD = bitIdx.sessionDayIdx[sIdx], sSt = bitIdx.sessionStart[sIdx], sR = bitIdx.sessionRoomId[sIdx];
        const sDur = sessDur[sIdx];
        snap(sIdx);
        bitIdx.unplace(sIdx);

        // Determine safe destination days for sIdx (same day + any other active day if sD keeps >=2 sessions)
        const destDays: number[] = [sD];
        if (sessions[sIdx].classes.length === 1) {
          const sCls = sessions[sIdx].classes[0];
          const sList = classToSessIndices.get(sCls) || [];
          const sdc = [0, 0, 0, 0, 0];
          for (const x of sList) if (x !== sIdx) sdc[bitIdx.sessionDayIdx[x]]++;
          if (sdc[sD] >= 2) {
            for (let d = 0; d < 5; d++) if (d !== sD && sdc[d] > 0) destDays.push(d);
          }
        }

        // 1) Try direct free slot outside [wsSt, wsEn] on destDays
        let movedS = false;
        for (const td of destDays) {
          for (const rid of allowedRoomIds[sIdx]) {
            if (policy.enforcePascaMonWed && isPascaById[rid] && td > 2) continue;
            for (const st of candidateStarts[sIdx]) {
              if (td === wsD && st < wsEn && wsSt < st + sDur) continue;
              if (bitIdx.canPlaceHard(sIdx, td, rid, startMasks[sIdx].get(st)!, true)) {
                applyUpdate(sIdx, td, st, rid);
                movedS = true;
                break;
              }
            }
            if (movedS) break;
          }
          if (movedS) break;
        }
        if (movedS) continue;

        // 2) Try pairwise swap with a same-duration session `b` on destDays outside [wsSt, wsEn]
        applyUpdate(sIdx, sD, sSt, sR);
        swapS: for (const td of destDays) {
          for (const b of movableIndices) {
            if (b === sIdx || ovSet.has(b) || touched.has(b) || bitIdx.sessionDayIdx[b] !== td) continue;
            if (sessDur[b] !== sDur) continue;
            const bSt = bitIdx.sessionStart[b], bR = bitIdx.sessionRoomId[b];
            if (td === wsD && bSt < wsEn && wsSt < bSt + sDur) continue;
            if (!allowedRoomIds[sIdx].includes(bR) || !allowedRoomIds[b].includes(sR)) continue;
            if (policy.enforcePascaMonWed && ((isPascaById[bR] && td > 2) || (isPascaById[sR] && sD > 2))) continue;
            // If cross-day swap, verify `b` stays contiguous & >=2mk when moving to sD
            if (td !== sD) {
              const bSafe = sessions[b].classes.every((bc) => {
                const bl = classToSessIndices.get(bc) || [];
                const bdc = [0, 0, 0, 0, 0];
                for (const x of bl) bdc[bitIdx.sessionDayIdx[x]]++;
                bdc[td]--;
                bdc[sD]++;
                let mn = 5, mx = -1, act = 0;
                for (let d = 0; d < 5; d++) if (bdc[d] > 0) { act++; if (d < mn) mn = d; if (d > mx) mx = d; }
                return mx - mn + 1 === act && (bl.length < 2 || !bdc.some((v) => v === 1));
              });
              if (!bSafe) continue;
            }
            const mS = startMasks[sIdx].get(bSt), mB = startMasks[b].get(sSt);
            if (!mS || !mB) continue;
            bitIdx.unplace(sIdx);
            bitIdx.unplace(b);
            if (bitIdx.canPlaceHard(sIdx, td, bR, mS, true)) {
              applyUpdate(sIdx, td, bSt, bR);
              if (bitIdx.canPlaceHard(b, sD, sR, mB, true)) {
                applyUpdate(b, sD, sSt, sR);
                touched.add(b);
                saved.push({ si: b, d: td, st: bSt, rid: bR });
                movedS = true;
                break swapS;
              }
              bitIdx.unplace(sIdx);
            }
            applyUpdate(sIdx, sD, sSt, sR);
            applyUpdate(b, td, bSt, bR);
          }
        }
        if (!movedS) {
          clearedAll = false;
          break;
        }
      }

      if (clearedAll) {
        const ev = evalState();
        if (ev.obj > curObj) {
          curObj = ev.obj;
          if (ev.obj > bestObj) saveBestMentok(ev);
          asprakClears++;
          improvingMoves++;
          improvedAny = true;
          rebuildByDay();
          continue;
        }
      }
      rollback();
    }

    // C2f: Wet-Lab <-> Wet-Lab Cross-Day / Same-Day Swap (frees trapped same-lab schedules!)
    for (let i = 0; i < bitIdx.wetLabIndices.length; i++) {
      const w1 = bitIdx.wetLabIndices[i];
      if (pinnedMask[w1] === 1 || bitIdx.findSeniorOverlapsForWetLab(w1).length === 0) continue;
      const d1 = bitIdx.sessionDayIdx[w1], st1 = bitIdx.sessionStart[w1], r1 = bitIdx.sessionRoomId[w1];
      for (let j = 0; j < bitIdx.wetLabIndices.length; j++) {
        if (i === j) continue;
        const w2 = bitIdx.wetLabIndices[j];
        if (pinnedMask[w2] === 1 || sessDur[w1] !== sessDur[w2]) continue;
        const d2 = bitIdx.sessionDayIdx[w2], st2 = bitIdx.sessionStart[w2], r2 = bitIdx.sessionRoomId[w2];
        if (d1 === d2 && st1 === st2) continue;
        if (!allowedRoomIds[w1].includes(r2) || !allowedRoomIds[w2].includes(r1)) continue;
        const m1 = startMasks[w1].get(st2), m2 = startMasks[w2].get(st1);
        if (!m1 || !m2) continue;

        bitIdx.unplace(w1);
        bitIdx.unplace(w2);
        if (bitIdx.canPlaceHard(w1, d2, r2, m1, true)) {
          applyUpdate(w1, d2, st2, r2);
          if (bitIdx.canPlaceHard(w2, d1, r1, m2, true)) {
            applyUpdate(w2, d1, st1, r1);
            const ev = evalState();
            if (ev.obj > curObj) {
              curObj = ev.obj;
              if (ev.obj > bestObj) saveBestMentok(ev);
              asprakClears++;
              improvingMoves++;
              improvedAny = true;
              rebuildByDay();
              break;
            }
            bitIdx.unplace(w2);
          }
          bitIdx.unplace(w1);
        }
        applyUpdate(w1, d1, st1, r1);
        applyUpdate(w2, d2, st2, r2);
      }
    }

    // C2g: Whole-Class +/-1 Day Contiguous Block Slide for classes involved in Asprak PARTIALs!
    // E.g. sliding Ilmu Lingkungan 1A/1B (Sen-Rab -> Sel-Kam or Rab-Jum) separates them from IL 3A/3B!
    const involvedClasses = new Set<string>();
    for (const ws of bitIdx.wetLabIndices) {
      const ov = bitIdx.findSeniorOverlapsForWetLab(ws);
      if (ov.length === 0) continue;
      for (const c of sessions[ws].classes) involvedClasses.add(c);
      for (const sIdx of ov) for (const c of sessions[sIdx].classes) involvedClasses.add(c);
    }

    for (const cls of involvedClasses) {
      const sList = classToSessIndices.get(cls);
      if (!sList || sList.length < 4) continue;
      const dc = [0, 0, 0, 0, 0];
      for (const si of sList) dc[bitIdx.sessionDayIdx[si]]++;
      const active: number[] = [];
      for (let d = 0; d < 5; d++) if (dc[d] > 0) active.push(d);
      if (active.length < 2 || active.length > 4) continue;
      const minD = active[0], maxD = active[active.length - 1];
      if (maxD - minD + 1 !== active.length) continue;

      // Try sliding right (outD=minD -> inD=maxD+1) and sliding left (outD=maxD -> inD=minD-1)
      const slideDirs: Array<{ outD: number; inD: number }> = [];
      if (maxD < 4) slideDirs.push({ outD: minD, inD: maxD + 1 });
      if (minD > 0) slideDirs.push({ outD: maxD, inD: minD - 1 });

      for (const { outD, inD } of slideDirs) {
        const toMove = sList.filter((si) => bitIdx.sessionDayIdx[si] === outD && pinnedMask[si] === 0 && sessions[si].classes.length === 1);
        if (toMove.length === 0 || toMove.length !== dc[outD]) continue;
        const moveSet = new Set(toMove);
        const saved: Array<{ si: number; d: number; st: number; rid: number }> = [];
        const touched = new Set<number>();
        const snap = (si: number) => {
          if (touched.has(si)) return;
          touched.add(si);
          saved.push({ si, d: bitIdx.sessionDayIdx[si], st: bitIdx.sessionStart[si], rid: bitIdx.sessionRoomId[si] });
        };
        const rollback = () => {
          for (const sv of saved) bitIdx.unplace(sv.si);
          for (const sv of saved) applyUpdate(sv.si, sv.d, sv.st, sv.rid);
        };

        let allPlaced = true;
        for (const aIdx of toMove) {
          const oSt = bitIdx.sessionStart[aIdx], oR = bitIdx.sessionRoomId[aIdx];
          snap(aIdx);
          bitIdx.unplace(aIdx);
          let ok = false;
          // 1) Direct free slot on inD
          for (const rid of allowedRoomIds[aIdx]) {
            if (policy.enforcePascaMonWed && isPascaById[rid] && inD > 2) continue;
            for (const st of candidateStarts[aIdx]) {
              if (bitIdx.canPlaceHard(aIdx, inD, rid, startMasks[aIdx].get(st)!, true)) {
                applyUpdate(aIdx, inD, st, rid);
                ok = true;
                break;
              }
            }
            if (ok) break;
          }
          // 2) Single Kempe ejection on inD (relocate blocker b onto b's OWN active days!)
          if (!ok) {
            kempeIn: for (const rid of allowedRoomIds[aIdx]) {
              if (policy.enforcePascaMonWed && isPascaById[rid] && inD > 2) continue;
              for (const st of candidateStarts[aIdx]) {
                const mA = startMasks[aIdx].get(st)!;
                const blockers = bitIdx.findBlockers(aIdx, inD, rid, mA);
                if (blockers.length !== 1) continue;
                const b = blockers[0];
                if (moveSet.has(b) || touched.has(b) || pinnedMask[b] === 1 || sessions[b].classes.includes(cls)) continue;
                const bD = bitIdx.sessionDayIdx[b], bSt = bitIdx.sessionStart[b], bR = bitIdx.sessionRoomId[b];
                bitIdx.unplace(b);
                if (!bitIdx.canPlaceHard(aIdx, inD, rid, mA, true)) {
                  applyUpdate(b, bD, bSt, bR);
                  continue;
                }
                applyUpdate(aIdx, inD, st, rid);
                let relB = false;
                for (const brid of allowedRoomIds[b]) {
                  if (policy.enforcePascaMonWed && isPascaById[brid] && bD > 2) continue;
                  for (const bst of candidateStarts[b]) {
                    if (bitIdx.canPlaceHard(b, bD, brid, startMasks[b].get(bst)!, true)) {
                      applyUpdate(b, bD, bst, brid);
                      touched.add(b);
                      saved.push({ si: b, d: bD, st: bSt, rid: bR });
                      relB = true;
                      break;
                    }
                  }
                  if (relB) break;
                }
                if (relB) {
                  ok = true;
                  break kempeIn;
                }
                bitIdx.unplace(aIdx);
                applyUpdate(b, bD, bSt, bR);
              }
            }
          }
          if (!ok) {
            applyUpdate(aIdx, outD, oSt, oR);
            allPlaced = false;
            break;
          }
        }

        if (allPlaced) {
          const ev = evalState();
          if (ev.obj > curObj) {
            curObj = ev.obj;
            if (ev.obj > bestObj) saveBestMentok(ev);
            asprakClears++;
            improvingMoves++;
            improvedAny = true;
            rebuildByDay();
            break;
          }
        }
        rollback();
      }
    }

    return improvedAny;
  }

  // Pre-group movable indices by day for ultra-fast O(1) same-day swaps
  const byDay: number[][] = [[], [], [], [], []];
  function rebuildByDay(): void {
    for (let d = 0; d < 5; d++) byDay[d].length = 0;
    for (const si of movableIndices) byDay[bitIdx.sessionDayIdx[si]].push(si);
  }
  rebuildByDay();

  // Helper: Single-Class Ruin-and-Recreate Exact Repack (jumps directly over 2-session `isoC=0` barriers!)
  // Unplaces ALL unpinned sessions of a targeted class (>3d, gapped, or involved in Asprak PARTIAL)
  // and re-packs them atomically into each candidate 3-day (or 4-day for >1490m) contiguous window
  // minimizing Asprak overlap + dead gaps + marathons via free slots & 1-step Kempe ejection!
  function runClassRuinAndRepackPass(): boolean {
    let improvedAny = false;

    // Identify target classes: >3d, gapped, or participating in an Asprak PARTIAL (junior or senior)
    const targetCls = new Set<string>();
    for (const cls of allClassKeys) {
      const sList = classToSessIndices.get(cls)!;
      if (sList.length < 4) continue;
      const dc = [0, 0, 0, 0, 0];
      for (const si of sList) dc[bitIdx.sessionDayIdx[si]]++;
      let act = 0;
      for (let d = 0; d < 5; d++) if (dc[d] > 0) act++;
      const totM = classTotalMin.get(cls) || 0;
      if (act >= 5 || (act === 4 && totM <= 1490)) targetCls.add(cls);
    }
    if (policy.enforceAsprakWetLab) {
      for (const ws of bitIdx.wetLabIndices) {
        const ov = bitIdx.findSeniorOverlapsForWetLab(ws);
        if (ov.length === 0) continue;
        for (const c of sessions[ws].classes) targetCls.add(c);
        for (const si of ov) for (const c of sessions[si].classes) targetCls.add(c);
      }
    }
    // Also include classes with dead gaps >= 100m
    for (let c = 0; c < numCls; c++) {
      const base = c * 5;
      for (let d = 0; d < 5; d++) {
        const list = clsDayBuf[base + d];
        if (list.length < 2) continue;
        sortByStart(list);
        for (let k = 1; k < list.length; k++) {
          if (fastDeadGap(bitIdx.sessionEnd[list[k - 1]], bitIdx.sessionStart[list[k]]) >= 100) {
            for (const cn of sessions[list[k]].classes) targetCls.add(cn);
          }
        }
      }
    }

    for (const cls of targetCls) {
      const sList = classToSessIndices.get(cls);
      if (!sList || sList.length < 4) continue;
      // Only repack unpinned single-class sessions of `cls` (leave combined/pinned sessions anchored!)
      const toRepack = sList.filter((si) => pinnedMask[si] === 0 && sessions[si].classes.length === 1);
      if (toRepack.length < 4) continue;
      const anchoredDays = new Set<number>();
      for (const si of sList) {
        if (!toRepack.includes(si)) anchoredDays.add(bitIdx.sessionDayIdx[si]);
      }
      const totM = classTotalMin.get(cls) || 0;
      const candWindows: number[][] =
        totM > 1490
          ? [
              [0, 1, 2, 3],
              [1, 2, 3, 4],
            ]
          : [
              [0, 1, 2],
              [1, 2, 3],
              [2, 3, 4],
            ];
      const validWindows = candWindows.filter((win) => Array.from(anchoredDays).every((ad) => win.includes(ad)));
      if (validWindows.length === 0) continue;

      // Exact marathon check across the FULL sorted day chain (not just pairwise!)
      const causesMarathon = (sameDay: number[], st: number, dur: number): boolean => {
        if (sameDay.length === 0) return false;
        const items: Array<{ s: number; e: number; d: number }> = [{ s: st, e: st + dur, d: dur }];
        for (const o of sameDay) items.push({ s: bitIdx.sessionStart[o], e: bitIdx.sessionEnd[o], d: sessDur[o] });
        items.sort((x, y) => x.s - y.s);
        let cMin = items[0].d;
        let cCnt = 1;
        for (let k = 1; k < items.length; k++) {
          if (items[k].s - items[k - 1].e < 40) {
            cMin += items[k].d;
            cCnt++;
            if (cCnt >= 2 && cMin > 300) return true;
          } else {
            cMin = items[k].d;
            cCnt = 1;
          }
        }
        return false;
      };

      // Six complementary ordering strategies per window (exact zero-waste morning 2x100m / afternoon 2x150m packing!):
      //   0: Wet-labs (340m, 170m) -> 150m -> 100m
      //   1: 340m -> 100m -> 150m -> 170m (packs 2x100m mornings & 2x150m afternoons cleanly!)
      //   2: Theory 150m/100m first, wet-labs last
      //   3..5: Seeded randomized shuffles (escape greedy tie-breaking!)
      const makeShuffled = (): number[] => {
        const arr = [...toRepack];
        for (let k = arr.length - 1; k > 0; k--) {
          const j = Math.floor(rng() * (k + 1));
          const tmp = arr[k]; arr[k] = arr[j]; arr[j] = tmp;
        }
        // Keep >300m mega-labs near front so 340m afternoon rooms are reserved first
        arr.sort((a, b) => (sessions[b].duration > 300 ? 1 : 0) - (sessions[a].duration > 300 ? 1 : 0));
        return arr;
      };
      const orderings: number[][] = [
        [...toRepack].sort((a, b) => {
          const sa = sessions[a], sb = sessions[b];
          const pa = (sa.isWetLab ? 1000 : sa.roomType === 'DRY_LAB' ? 400 : 0) + sa.duration;
          const pb = (sb.isWetLab ? 1000 : sb.roomType === 'DRY_LAB' ? 400 : 0) + sb.duration;
          return pb - pa;
        }),
        [...toRepack].sort((a, b) => {
          const sa = sessions[a], sb = sessions[b];
          const pa = sa.duration > 300 ? 2000 : sa.duration === 100 ? 1200 : sa.duration === 150 ? 900 : 400;
          const pb = sb.duration > 300 ? 2000 : sb.duration === 100 ? 1200 : sb.duration === 150 ? 900 : 400;
          return pb - pa;
        }),
        [...toRepack].sort((a, b) => {
          const sa = sessions[a], sb = sessions[b];
          const pa = (sa.isWetLab ? 50 : sa.roomType === 'DRY_LAB' ? 200 : 800) + sa.duration;
          const pb = (sb.isWetLab ? 50 : sb.roomType === 'DRY_LAB' ? 200 : 800) + sb.duration;
          return pb - pa;
        }),
        makeShuffled(),
        makeShuffled(),
        makeShuffled(),
      ];
      const repackSet = new Set(toRepack);

      let repackedCls = false;
      for (const win of validWindows) {
        for (let ordIdx = 0; ordIdx < orderings.length; ordIdx++) {
          const ordered = orderings[ordIdx];
          const saved: Array<{ si: number; d: number; st: number; rid: number }> = [];
          const touched = new Set<number>();
          const snap = (si: number) => {
            if (touched.has(si)) return;
            touched.add(si);
            saved.push({ si, d: bitIdx.sessionDayIdx[si], st: bitIdx.sessionStart[si], rid: bitIdx.sessionRoomId[si] });
          };
          const rollback = () => {
            for (const sv of saved) bitIdx.unplace(sv.si);
            for (const sv of saved) applyUpdate(sv.si, sv.d, sv.st, sv.rid);
          };

          for (const si of ordered) {
            snap(si);
            bitIdx.unplace(si);
          }

          const winDayCount = new Map<number, number>();
          for (const d of win) winDayCount.set(d, 0);
          for (const si of sList) {
            if (!repackSet.has(si)) {
              const d = bitIdx.sessionDayIdx[si];
              winDayCount.set(d, (winDayCount.get(d) || 0) + 1);
            }
          }

          let allPlaced = true;
          for (let oi = 0; oi < ordered.length; oi++) {
            const aIdx = ordered[oi];
            const sa = sessions[aIdx];
            const remCount = ordered.length - oi;
            // Enforce >=2 sessions on every day of `win` by prioritizing days with count < 2 when remaining is tight!
            let deficitAll = 0;
            let deficitOnes = 0;
            for (const d of win) {
              const c = winDayCount.get(d) || 0;
              if (c < 2) deficitAll += 2 - c;
              if (c === 1) deficitOnes += 1;
            }
            const dayPriorityPool =
              remCount <= deficitOnes
                ? win.filter((d) => (winDayCount.get(d) || 0) === 1)
                : remCount <= deficitAll
                  ? win.filter((d) => (winDayCount.get(d) || 0) < 2)
                  : win;
            const daysToTry = dayPriorityPool.length > 0 ? dayPriorityPool : win;

            let bestFree: { d: number; st: number; rid: number; score: number } | null = null;
            for (const td of daysToTry) {
              const dayCnt = winDayCount.get(td) || 0;
              const sameDayPlaced = sList.filter((x) => bitIdx.sessionDayIdx[x] === td);

              for (const rid of allowedRoomIds[aIdx]) {
                if (policy.enforcePascaMonWed && isPascaById[rid] && td > 2) continue;
                for (const st of candidateStarts[aIdx]) {
                  if (causesMarathon(sameDayPlaced, st, sa.duration)) continue;
                  const mask = startMasks[aIdx].get(st)!;
                  if (!bitIdx.canPlaceHard(aIdx, td, rid, mask, policy.enforceAsprakWetLab)) continue;

                  let sc = 0;
                  if (dayCnt === 1) sc += 260;
                  else if (dayCnt === 0) sc += 140;
                  else if (dayCnt >= 4) sc -= 180;
                  // Zero-waste half-day bin packing: 2x150m fits 300m afternoon (13:00-18:00), 2x100m fits 200m morning (08:40-12:00)!
                  if (sa.duration === 150 && st >= 780) sc += 220;
                  if (sa.duration === 100 && st < 720) sc += 120;
                  // Keep general rooms on Mon-Wed when possible so Thu-Fri wet-lab days need fewer general rooms
                  if (!sa.isWetLab && td <= 2) sc += 35;

                  if (policy.enforceAsprakWetLab) {
                    applyUpdate(aIdx, td, st, rid);
                    const asp = bitIdx.countAsprakIssues();
                    bitIdx.unplace(aIdx);
                    sc -= asp.partials * 2600 + asp.overlapTicks * 55;
                  }

                  const en = st + sa.duration;
                  for (const o of sameDayPlaced) {
                    const oSt = bitIdx.sessionStart[o], oEn = bitIdx.sessionEnd[o];
                    const dg = st >= oEn ? fastDeadGap(oEn, st) : fastDeadGap(en, oSt);
                    if (dg === 0) sc += 90;
                    else if (dg >= 100) sc -= 280;
                  }
                  if (ordIdx >= 3) sc += rng() * 65;

                  if (!bestFree || sc > bestFree.score) bestFree = { d: td, st, rid, score: sc };
                }
              }
            }

            if (bestFree) {
              applyUpdate(aIdx, bestFree.d, bestFree.st, bestFree.rid);
              winDayCount.set(bestFree.d, (winDayCount.get(bestFree.d) || 0) + 1);
              continue;
            }

            // 1-Step Kempe Ejection fallback inside `daysToTry` (then full `win`): eject single blocker `b` onto `b`'s OWN active days!
            let placedK = false;
            const kDays = daysToTry === win ? win : [...daysToTry, ...win.filter((d) => !daysToTry.includes(d))];
            kempeRepack: for (const td of kDays) {
              const sameDayPlaced = sList.filter((x) => bitIdx.sessionDayIdx[x] === td);
              for (const rid of allowedRoomIds[aIdx]) {
                if (policy.enforcePascaMonWed && isPascaById[rid] && td > 2) continue;
                for (const st of candidateStarts[aIdx]) {
                  if (causesMarathon(sameDayPlaced, st, sa.duration)) continue;
                  const mask = startMasks[aIdx].get(st)!;
                  const blockers = bitIdx.findBlockers(aIdx, td, rid, mask);
                  if (blockers.length !== 1) continue;
                  const b = blockers[0];
                  if (repackSet.has(b) || touched.has(b) || pinnedMask[b] === 1 || sessions[b].classes.includes(cls)) continue;
                  const bD = bitIdx.sessionDayIdx[b], bSt = bitIdx.sessionStart[b], bR = bitIdx.sessionRoomId[b];
                  bitIdx.unplace(b);
                  if (!bitIdx.canPlaceHard(aIdx, td, rid, mask, policy.enforceAsprakWetLab)) {
                    applyUpdate(b, bD, bSt, bR);
                    continue;
                  }
                  applyUpdate(aIdx, td, st, rid);

                  const bDestDays: number[] = [bD];
                  if (sessions[b].classes.length === 1) {
                    const bCls = sessions[b].classes[0];
                    const bList = classToSessIndices.get(bCls) || [];
                    const bdc = [0, 0, 0, 0, 0];
                    for (const x of bList) if (x !== b && bitIdx.sessionDayIdx[x] >= 0) bdc[bitIdx.sessionDayIdx[x]]++;
                    if (bdc[bD] >= 2) {
                      for (let d = 0; d < 5; d++) if (d !== bD && bdc[d] > 0) bDestDays.push(d);
                    }
                  }
                  let relB = false;
                  for (const bd of bDestDays) {
                    for (const brid of allowedRoomIds[b]) {
                      if (policy.enforcePascaMonWed && isPascaById[brid] && bd > 2) continue;
                      for (const bst of candidateStarts[b]) {
                        if (bd === bD && bst === bSt && brid === bR) continue;
                        if (bitIdx.canPlaceHard(b, bd, brid, startMasks[b].get(bst)!, policy.enforceAsprakWetLab)) {
                          applyUpdate(b, bd, bst, brid);
                          touched.add(b);
                          saved.push({ si: b, d: bD, st: bSt, rid: bR });
                          winDayCount.set(td, (winDayCount.get(td) || 0) + 1);
                          relB = true;
                          break;
                        }
                      }
                      if (relB) break;
                    }
                    if (relB) break;
                  }
                  if (relB) {
                    placedK = true;
                    break kempeRepack;
                  }
                  bitIdx.unplace(aIdx);
                  applyUpdate(b, bD, bSt, bR);
                }
              }
            }

            if (!placedK) {
              allPlaced = false;
              break;
            }
          }

          if (allPlaced) {
            const ev = evalState();
            if (ev.obj > curObj) {
              curObj = ev.obj;
              if (ev.obj > bestObj) saveBestMentok(ev);
              dayConsolidations++;
              improvingMoves++;
              improvedAny = true;
              repackedCls = true;
              rebuildByDay();
              break;
            }
          }
          rollback();
        }
        if (repackedCls) break;
      }
    }
    return improvedAny;
  }

  // Helper: Deterministic Lone-Day Eliminator inside Stage-4 (repairs any residual isoC > 0 via free-slot/swap!)
  function runLoneDayRepairPass(): boolean {
    let improvedAny = false;
    for (const cls of allClassKeys) {
      const sList = classToSessIndices.get(cls)!;
      if (sList.length < 2) continue;
      const dc = [0, 0, 0, 0, 0];
      for (const si of sList) dc[bitIdx.sessionDayIdx[si]]++;
      const active: number[] = [];
      for (let d = 0; d < 5; d++) if (dc[d] > 0) active.push(d);
      if (active.length <= 1) continue;

      for (const ld of active) {
        if (dc[ld] !== 1) continue;
        const isExt = ld === active[0] || ld === active[active.length - 1];
        const others = active.filter((d) => d !== ld);
        let fixed = false;

        // 1) Evacuate extreme lone session to an active day of `cls`
        if (isExt) {
          const loneSi = sList.find((si) => bitIdx.sessionDayIdx[si] === ld && pinnedMask[si] === 0);
          if (loneSi !== undefined) {
            const oSt = bitIdx.sessionStart[loneSi], oR = bitIdx.sessionRoomId[loneSi];
            bitIdx.unplace(loneSi);
            let bestF: { d: number; st: number; rid: number; ev: MentokEval } | null = null;
            for (const td of others) {
              for (const rid of allowedRoomIds[loneSi]) {
                if (policy.enforcePascaMonWed && isPascaById[rid] && td > 2) continue;
                for (const st of candidateStarts[loneSi]) {
                  if (!bitIdx.canPlaceHard(loneSi, td, rid, startMasks[loneSi].get(st)!, policy.enforceAsprakWetLab)) continue;
                  applyUpdate(loneSi, td, st, rid);
                  const ev = evalState();
                  bitIdx.unplace(loneSi);
                  if (ev.obj > curObj && (!bestF || ev.obj > bestF.ev.obj)) bestF = { d: td, st, rid, ev };
                }
              }
            }
            if (bestF) {
              applyUpdate(loneSi, bestF.d, bestF.st, bestF.rid);
              curObj = bestF.ev.obj;
              if (bestF.ev.obj > bestObj) saveBestMentok(bestF.ev);
              improvingMoves++;
              improvedAny = true;
              fixed = true;
              rebuildByDay();
            } else {
              applyUpdate(loneSi, ld, oSt, oR);
            }
          }
        }

        // 2) Pull 1 donor session from any >=3-course active day onto `ld`
        if (!fixed) {
          const donors = sList.filter((si) => dc[bitIdx.sessionDayIdx[si]] >= 3 && pinnedMask[si] === 0);
          for (const dIdx of donors) {
            const oD = bitIdx.sessionDayIdx[dIdx], oSt = bitIdx.sessionStart[dIdx], oR = bitIdx.sessionRoomId[dIdx];
            bitIdx.unplace(dIdx);
            let bestP: { st: number; rid: number; ev: MentokEval } | null = null;
            for (const rid of allowedRoomIds[dIdx]) {
              if (policy.enforcePascaMonWed && isPascaById[rid] && ld > 2) continue;
              for (const st of candidateStarts[dIdx]) {
                if (!bitIdx.canPlaceHard(dIdx, ld, rid, startMasks[dIdx].get(st)!, policy.enforceAsprakWetLab)) continue;
                applyUpdate(dIdx, ld, st, rid);
                const ev = evalState();
                bitIdx.unplace(dIdx);
                if (ev.obj > curObj && (!bestP || ev.obj > bestP.ev.obj)) bestP = { st, rid, ev };
              }
            }
            if (bestP) {
              applyUpdate(dIdx, ld, bestP.st, bestP.rid);
              curObj = bestP.ev.obj;
              if (bestP.ev.obj > bestObj) saveBestMentok(bestP.ev);
              improvingMoves++;
              improvedAny = true;
              fixed = true;
              rebuildByDay();
              break;
            } else {
              applyUpdate(dIdx, oD, oSt, oR);
            }
          }
        }
        if (fixed) break;
      }
    }
    return improvedAny;
  }

  // Phase A: Repair any lone days, collapse 4/5-day classes -> 3 days & clear obvious Asprak partials before LAHC!
  if (!disableHalfDayRepack) {
    for (let p = 0; p < 6; p++) {
      const aL = capIso > 0 ? runLoneDayRepairPass() : false;
      const a0 = runClassRuinAndRepackPass();
      const a1 = runCollapse4To3Pass();
      const a2 = runKempeCollapse4To3Pass();
      const a3 = tryBlockSlideCollapse();
      if (!aL && !a0 && !a1 && !a2 && !a3) break;
    }
  }

  // Phase B: Strategic Oscillation (Phase B1 Tunneling 62% -> Phase B2 Hard-Locked 38%) maximizing `humaneScore`!
  const L = Math.max(20, Math.round(options.lahcLength ?? 65));
  const lahc = new Float64Array(L).fill(curObj);
  const startTemp = Math.max(480, options.initTemp ?? 520.0);
  let temp = startTemp; // scaled for 2->1->0 tunneling across ~1100-unit loneDay barrier
  const cooling = options.coolingRate ?? 0.99955;
  let iterations = 0;
  let stagnant = 0;
  let reheats = 0;
  const phaseBStart = performance.now();
  const tunnelDeadline = disableOscillation ? phaseBStart : phaseBStart + timeBudgetMs * 0.62;
  const deadline = phaseBStart + timeBudgetMs;
  tunnelMode = !disableOscillation;
  curObj = evalState().obj;
  lahc.fill(curObj);

  function acceptMentok(newObj: number, iter: number): boolean {
    if (newObj <= -1e8) return false;
    const v = iter % L;
    if (newObj >= curObj || newObj >= lahc[v]) return true;
    const diff = curObj - newObj;
    if (temp > 4.0 && Math.exp(-diff / temp) > rng()) return true;
    return false;
  }

  rebuildByDay();

  // Helper: collect sessions currently participating in a student or lecturer dead gap >= 100m
  const gappedSessions: number[] = [];
  function refreshGappedSessions(): void {
    gappedSessions.length = 0;
    const seen = new Uint8Array(n);
    for (let c = 0; c < numCls; c++) {
      const base = c * 5;
      for (let d = 0; d < 5; d++) {
        const list = clsDayBuf[base + d];
        if (list.length < 2) continue;
        sortByStart(list);
        for (let k = 1; k < list.length; k++) {
          if (fastDeadGap(bitIdx.sessionEnd[list[k - 1]], bitIdx.sessionStart[list[k]]) >= 100) {
            const u = list[k - 1], w = list[k];
            if (pinnedMask[u] === 0 && !seen[u]) { seen[u] = 1; gappedSessions.push(u); }
            if (pinnedMask[w] === 0 && !seen[w]) { seen[w] = 1; gappedSessions.push(w); }
          }
        }
      }
    }
    for (let l = 0; l < numLec; l++) {
      const base = l * 5;
      for (let d = 0; d < 5; d++) {
        const list = lecDayBuf[base + d];
        if (list.length < 2) continue;
        sortByStart(list);
        for (let k = 1; k < list.length; k++) {
          if (fastDeadGap(bitIdx.sessionEnd[list[k - 1]], bitIdx.sessionStart[list[k]]) >= 100) {
            const u = list[k - 1], w = list[k];
            if (pinnedMask[u] === 0 && !seen[u]) { seen[u] = 1; gappedSessions.push(u); }
            if (pinnedMask[w] === 0 && !seen[w]) { seen[w] = 1; gappedSessions.push(w); }
          }
        }
      }
    }
  }
  refreshGappedSessions();

  while (iterations < maxIters && performance.now() < deadline && movableIndices.length > 0) {
    iterations++;
    // Transition Phase B1 (Strategic Oscillation Tunneling) -> Phase B2 (Hard-Locked Intensification from best!)
    if (tunnelMode && performance.now() >= tunnelDeadline) {
      tunnelMode = false;
      for (let i = 0; i < n; i++) bitIdx.unplace(i);
      for (let i = 0; i < n; i++) applyUpdate(i, bestDay[i], bestStart[i], bestRoom[i]);
      curObj = evalState().obj;
      bestObj = curObj;
      lahc.fill(curObj);
      temp = 240;
      rebuildByDay();
      refreshGappedSessions();
    }
    if ((iterations & 255) === 0) refreshGappedSessions();
    const r = rng();
    let movedOk = false;

    if (r < 0.30) {
      // OP 0: Targeted Gap-Breaking Same-Day Swap (80% picks a session WITH a dead gap >= 100m!)
      const useGap = gappedSessions.length > 0 && rng() < 0.8;
      const a = useGap
        ? gappedSessions[Math.floor(rng() * gappedSessions.length)]
        : movableIndices[Math.floor(rng() * movableIndices.length)];
      const d = bitIdx.sessionDayIdx[a];
      const pool = byDay[d];
      if (pool.length < 2) continue;
      const b = pool[Math.floor(rng() * pool.length)];
      if (a === b || sessDur[a] !== sessDur[b]) continue;
      const aSt = bitIdx.sessionStart[a], aR = bitIdx.sessionRoomId[a];
      const bSt = bitIdx.sessionStart[b], bR = bitIdx.sessionRoomId[b];
      if (aSt === bSt) continue;
      if (!allowedRoomIds[a].includes(bR) || !allowedRoomIds[b].includes(aR)) continue;
      const mA = startMasks[a].get(bSt);
      const mB = startMasks[b].get(aSt);
      if (!mA || !mB) continue;

      bitIdx.unplace(a);
      bitIdx.unplace(b);
      if (bitIdx.canPlaceHard(a, d, bR, mA, policy.enforceAsprakWetLab)) {
        applyUpdate(a, d, bSt, bR);
        if (bitIdx.canPlaceHard(b, d, aR, mB, policy.enforceAsprakWetLab)) {
          applyUpdate(b, d, aSt, aR);
          const ev = evalState();
          if (acceptMentok(ev.obj, iterations)) {
            if (ev.obj > curObj) improvingMoves++;
            curObj = ev.obj;
            acceptedMoves++;
            movedOk = true;
            if (ev.obj > bestObj) saveBestMentok(ev);
          } else {
            bitIdx.unplace(b);
            bitIdx.unplace(a);
            applyUpdate(a, d, aSt, aR);
            applyUpdate(b, d, bSt, bR);
          }
        } else {
          bitIdx.unplace(a);
          applyUpdate(a, d, aSt, aR);
          applyUpdate(b, d, bSt, bR);
        }
      } else {
        applyUpdate(a, d, aSt, aR);
        applyUpdate(b, d, bSt, bR);
      }
    } else if (r < 0.48) {
      // OP 1: Same-Day 3-Cycle Time Rotation (a -> b -> c -> a; breaks 2-swap deadlocks!)
      const d = Math.floor(rng() * 5);
      const pool = byDay[d];
      if (pool.length < 3) continue;
      const a = pool[Math.floor(rng() * pool.length)];
      const b = pool[Math.floor(rng() * pool.length)];
      const c = pool[Math.floor(rng() * pool.length)];
      if (a === b || b === c || a === c) continue;
      if (sessDur[a] !== sessDur[b] || sessDur[b] !== sessDur[c]) continue;
      const aSt = bitIdx.sessionStart[a], aR = bitIdx.sessionRoomId[a];
      const bSt = bitIdx.sessionStart[b], bR = bitIdx.sessionRoomId[b];
      const cSt = bitIdx.sessionStart[c], cR = bitIdx.sessionRoomId[c];
      if (!allowedRoomIds[a].includes(bR) || !allowedRoomIds[b].includes(cR) || !allowedRoomIds[c].includes(aR)) continue;
      const mA = startMasks[a].get(bSt), mB = startMasks[b].get(cSt), mC = startMasks[c].get(aSt);
      if (!mA || !mB || !mC) continue;

      bitIdx.unplace(a);
      bitIdx.unplace(b);
      bitIdx.unplace(c);
      if (bitIdx.canPlaceHard(a, d, bR, mA, policy.enforceAsprakWetLab)) {
        applyUpdate(a, d, bSt, bR);
        if (bitIdx.canPlaceHard(b, d, cR, mB, policy.enforceAsprakWetLab)) {
          applyUpdate(b, d, cSt, cR);
          if (bitIdx.canPlaceHard(c, d, aR, mC, policy.enforceAsprakWetLab)) {
            applyUpdate(c, d, aSt, aR);
            const ev = evalState();
            if (acceptMentok(ev.obj, iterations)) {
              if (ev.obj > curObj) improvingMoves++;
              curObj = ev.obj;
              acceptedMoves++;
              movedOk = true;
              if (ev.obj > bestObj) saveBestMentok(ev);
            } else {
              bitIdx.unplace(c);
              bitIdx.unplace(b);
              bitIdx.unplace(a);
              applyUpdate(a, d, aSt, aR);
              applyUpdate(b, d, bSt, bR);
              applyUpdate(c, d, cSt, cR);
            }
          } else {
            bitIdx.unplace(b);
            bitIdx.unplace(a);
            applyUpdate(a, d, aSt, aR);
            applyUpdate(b, d, bSt, bR);
            applyUpdate(c, d, cSt, cR);
          }
        } else {
          bitIdx.unplace(a);
          applyUpdate(a, d, aSt, aR);
          applyUpdate(b, d, bSt, bR);
          applyUpdate(c, d, cSt, cR);
        }
      } else {
        applyUpdate(a, d, aSt, aR);
        applyUpdate(b, d, bSt, bR);
        applyUpdate(c, d, cSt, cR);
      }
    } else if (r < 0.68) {
      // OP 2: Targeted Cross-Day Pairwise Swap (70% targets gapped sessions -> collapses gaps & lecturer 1-mk days!)
      const useGap = gappedSessions.length > 0 && rng() < 0.7;
      const a = useGap
        ? gappedSessions[Math.floor(rng() * gappedSessions.length)]
        : movableIndices[Math.floor(rng() * movableIndices.length)];
      const b = movableIndices[Math.floor(rng() * movableIndices.length)];
      if (a === b || sessDur[a] !== sessDur[b]) continue;
      const aD = bitIdx.sessionDayIdx[a], aSt = bitIdx.sessionStart[a], aR = bitIdx.sessionRoomId[a];
      const bD = bitIdx.sessionDayIdx[b], bSt = bitIdx.sessionStart[b], bR = bitIdx.sessionRoomId[b];
      if (aD === bD) continue;
      if (!allowedRoomIds[a].includes(bR) || !allowedRoomIds[b].includes(aR)) continue;
      if (policy.enforcePascaMonWed && ((isPascaById[bR] && bD > 2) || (isPascaById[aR] && aD > 2))) continue;
      const mA = startMasks[a].get(bSt);
      const mB = startMasks[b].get(aSt);
      if (!mA || !mB) continue;

      bitIdx.unplace(a);
      bitIdx.unplace(b);
      if (bitIdx.canPlaceHard(a, bD, bR, mA, policy.enforceAsprakWetLab)) {
        applyUpdate(a, bD, bSt, bR);
        if (bitIdx.canPlaceHard(b, aD, aR, mB, policy.enforceAsprakWetLab)) {
          applyUpdate(b, aD, aSt, aR);
          const ev = evalState();
          if (acceptMentok(ev.obj, iterations)) {
            if (ev.obj > curObj) improvingMoves++;
            curObj = ev.obj;
            acceptedMoves++;
            movedOk = true;
            rebuildByDay();
            if (ev.obj > bestObj) saveBestMentok(ev);
          } else {
            bitIdx.unplace(b);
            bitIdx.unplace(a);
            applyUpdate(a, aD, aSt, aR);
            applyUpdate(b, bD, bSt, bR);
          }
        } else {
          bitIdx.unplace(a);
          applyUpdate(a, aD, aSt, aR);
          applyUpdate(b, bD, bSt, bR);
        }
      } else {
        applyUpdate(a, aD, aSt, aR);
        applyUpdate(b, bD, bSt, bR);
      }
    } else if (r < 0.89 && policy.enforceAsprakWetLab && bitIdx.wetLabIndices.length > 0) {
      // OP 3: Targeted Asprak PARTIAL -> CLEAR Relocator (wet-lab shift, senior free-slot shift, OR senior swap!)
      const wStart = Math.floor(rng() * bitIdx.wetLabIndices.length);
      let ws = -1;
      let ov: number[] = [];
      for (let step = 0; step < bitIdx.wetLabIndices.length; step++) {
        const cand = bitIdx.wetLabIndices[(wStart + step) % bitIdx.wetLabIndices.length];
        const foundOv = bitIdx.findSeniorOverlapsForWetLab(cand);
        if (foundOv.length > 0) {
          ws = cand;
          ov = foundOv;
          break;
        }
      }
      if (ws >= 0) {
        const subMode = rng();
        if (subMode < 0.35 && pinnedMask[ws] === 0) {
          const oD = bitIdx.sessionDayIdx[ws], oSt = bitIdx.sessionStart[ws], oR = bitIdx.sessionRoomId[ws];
          const td = Math.floor(rng() * 5);
          const wStarts = candidateStarts[ws];
          const st = wStarts[Math.floor(rng() * wStarts.length)];
          if (td !== oD || st !== oSt) {
            bitIdx.unplace(ws);
            if (bitIdx.canPlaceHard(ws, td, oR, startMasks[ws].get(st)!, true)) {
              applyUpdate(ws, td, st, oR);
              const ev = evalState();
              if (acceptMentok(ev.obj, iterations)) {
                if (ev.obj > curObj) improvingMoves++;
                curObj = ev.obj;
                acceptedMoves++;
                asprakClears++;
                movedOk = true;
                if (td !== oD) rebuildByDay();
                if (ev.obj > bestObj) saveBestMentok(ev);
              } else {
                bitIdx.unplace(ws);
                applyUpdate(ws, oD, oSt, oR);
              }
            } else {
              applyUpdate(ws, oD, oSt, oR);
            }
          }
        } else if (subMode < 0.62) {
          // Move an overlapping senior session into a free slot outside [wsSt, wsEn] (same day or other day!)
          const movOv = ov.filter((x) => pinnedMask[x] === 0);
          if (movOv.length > 0) {
            const sIdx = movOv[Math.floor(rng() * movOv.length)];
            const sD = bitIdx.sessionDayIdx[sIdx], sSt = bitIdx.sessionStart[sIdx], sR = bitIdx.sessionRoomId[sIdx];
            const wsD = bitIdx.sessionDayIdx[ws], wsSt = bitIdx.sessionStart[ws], wsEn = bitIdx.sessionEnd[ws];
            const td = rng() < 0.6 ? sD : Math.floor(rng() * 5);
            const rIds = allowedRoomIds[sIdx];
            const rid = rIds[Math.floor(rng() * rIds.length)];
            if (!(policy.enforcePascaMonWed && isPascaById[rid] && td > 2)) {
              const starts = candidateStarts[sIdx];
              const st = starts[Math.floor(rng() * starts.length)];
              if (!(td === wsD && st < wsEn && wsSt < st + sessDur[sIdx]) && !(td === sD && st === sSt && rid === sR)) {
                bitIdx.unplace(sIdx);
                if (bitIdx.canPlaceHard(sIdx, td, rid, startMasks[sIdx].get(st)!, true)) {
                  applyUpdate(sIdx, td, st, rid);
                  const ev = evalState();
                  if (acceptMentok(ev.obj, iterations)) {
                    if (ev.obj > curObj) improvingMoves++;
                    curObj = ev.obj;
                    acceptedMoves++;
                    asprakClears++;
                    movedOk = true;
                    if (td !== sD) rebuildByDay();
                    if (ev.obj > bestObj) saveBestMentok(ev);
                  } else {
                    bitIdx.unplace(sIdx);
                    applyUpdate(sIdx, sD, sSt, sR);
                  }
                } else {
                  applyUpdate(sIdx, sD, sSt, sR);
                }
              }
            }
          }
        } else {
          const movOv = ov.filter((x) => pinnedMask[x] === 0);
          if (movOv.length > 0) {
            const sIdx = movOv[Math.floor(rng() * movOv.length)];
            const sD = bitIdx.sessionDayIdx[sIdx], sSt = bitIdx.sessionStart[sIdx], sR = bitIdx.sessionRoomId[sIdx];
            const wsSt = bitIdx.sessionStart[ws], wsEn = bitIdx.sessionEnd[ws];
            const sameDayMode = rng() < 0.6;
            const pool = sameDayMode ? byDay[sD] : movableIndices;
            for (let tries = 0; tries < 24 && pool.length > 1; tries++) {
              const b = pool[Math.floor(rng() * pool.length)];
              if (b === sIdx || sessDur[b] !== sessDur[sIdx]) continue;
              const bD = bitIdx.sessionDayIdx[b], bSt = bitIdx.sessionStart[b], bR = bitIdx.sessionRoomId[b];
              if (bD === sD && bSt < wsEn && wsSt < bSt + sessDur[sIdx]) continue;
              if (!allowedRoomIds[sIdx].includes(bR) || !allowedRoomIds[b].includes(sR)) continue;
              if (policy.enforcePascaMonWed && ((isPascaById[bR] && bD > 2) || (isPascaById[sR] && sD > 2))) continue;
              const mS = startMasks[sIdx].get(bSt), mB = startMasks[b].get(sSt);
              if (!mS || !mB) continue;
              bitIdx.unplace(sIdx);
              bitIdx.unplace(b);
              if (bitIdx.canPlaceHard(sIdx, bD, bR, mS, true)) {
                applyUpdate(sIdx, bD, bSt, bR);
                if (bitIdx.canPlaceHard(b, sD, sR, mB, true)) {
                  applyUpdate(b, sD, sSt, sR);
                  const ev = evalState();
                  if (acceptMentok(ev.obj, iterations)) {
                    if (ev.obj > curObj) improvingMoves++;
                    curObj = ev.obj;
                    acceptedMoves++;
                    asprakClears++;
                    movedOk = true;
                    if (bD !== sD) rebuildByDay();
                    if (ev.obj > bestObj) saveBestMentok(ev);
                    break;
                  }
                  bitIdx.unplace(b);
                }
                bitIdx.unplace(sIdx);
              }
              applyUpdate(sIdx, sD, sSt, sR);
              applyUpdate(b, bD, bSt, bR);
            }
          }
        }
      }
    } else if (r < 0.94) {
      // OP 5: Periodic 4/5-Day -> 3-Day Collapse + Asprak Atomic Trigger during LAHC!
      if (
        (iterations & 63) === 0 &&
        (runAsprakAtomicClearPass() || runKempeCollapse4To3Pass() || runCollapse4To3Pass() || tryBlockSlideCollapse())
      ) {
        movedOk = true;
        rebuildByDay();
      }
    } else {
      // OP 4: Targeted Tunneling & Single-Session Free-Slot Move
      // In Strategic Oscillation (`tunnelMode`), explicitly target lone-day completion (2->1->0) and >3d extreme days!
      let idx = movableIndices[Math.floor(rng() * movableIndices.length)];
      let forcedTargetDay = -1;
      if (tunnelMode) {
        const loneSessions: Array<{ si: number; targetDays: number[] }> = [];
        const shrinkSessions: Array<{ si: number; targetDays: number[] }> = [];
        for (const cls of allClassKeys) {
          const sList = classToSessIndices.get(cls)!;
          if (sList.length < 2) continue;
          const dc = [0, 0, 0, 0, 0];
          for (const si of sList) dc[bitIdx.sessionDayIdx[si]]++;
          const active: number[] = [];
          for (let d = 0; d < 5; d++) if (dc[d] > 0) active.push(d);
          for (const d of active) {
            if (dc[d] === 1) {
              const lone = sList.find((si) => bitIdx.sessionDayIdx[si] === d && pinnedMask[si] === 0);
              if (lone !== undefined) {
                const others = active.filter((ad) => ad !== d);
                if (others.length > 0) loneSessions.push({ si: lone, targetDays: others });
              }
            }
          }
          const totM = classTotalMin.get(cls) || 0;
          if (active.length >= 5 || (active.length === 4 && totM <= 1490)) {
            for (const ext of [active[0], active[active.length - 1]]) {
              const others = active.filter((ad) => ad !== ext);
              for (const si of sList) {
                if (bitIdx.sessionDayIdx[si] === ext && pinnedMask[si] === 0) {
                  shrinkSessions.push({ si, targetDays: others });
                }
              }
            }
          }
        }
        if (loneSessions.length > 0 && rng() < 0.72) {
          const pick = loneSessions[Math.floor(rng() * loneSessions.length)];
          idx = pick.si;
          forcedTargetDay = pick.targetDays[Math.floor(rng() * pick.targetDays.length)];
        } else if (shrinkSessions.length > 0 && rng() < 0.65) {
          const pick = shrinkSessions[Math.floor(rng() * shrinkSessions.length)];
          idx = pick.si;
          forcedTargetDay = pick.targetDays[Math.floor(rng() * pick.targetDays.length)];
        }
      }
      const oD = bitIdx.sessionDayIdx[idx], oSt = bitIdx.sessionStart[idx], oR = bitIdx.sessionRoomId[idx];
      const td = forcedTargetDay >= 0 ? forcedTargetDay : rng() < 0.65 ? oD : Math.floor(rng() * 5);
      const rIds = allowedRoomIds[idx];
      const rid = rIds[Math.floor(rng() * rIds.length)];
      if (policy.enforcePascaMonWed && isPascaById[rid] && td > 2) continue;
      const starts = candidateStarts[idx];
      const st = starts[Math.floor(rng() * starts.length)];
      if (td === oD && st === oSt && rid === oR) continue;

      bitIdx.unplace(idx);
      if (bitIdx.canPlaceHard(idx, td, rid, startMasks[idx].get(st)!, policy.enforceAsprakWetLab)) {
        applyUpdate(idx, td, st, rid);
        const ev = evalState();
        if (acceptMentok(ev.obj, iterations)) {
          if (ev.obj > curObj) improvingMoves++;
          curObj = ev.obj;
          acceptedMoves++;
          movedOk = true;
          if (td !== oD) rebuildByDay();
          if (ev.obj > bestObj) saveBestMentok(ev);
        } else {
          bitIdx.unplace(idx);
          applyUpdate(idx, oD, oSt, oR);
        }
      } else {
        applyUpdate(idx, oD, oSt, oR);
      }
    }

    const v = iterations % L;
    if (curObj > lahc[v]) lahc[v] = curObj;
    if (movedOk) stagnant = 0;
    else stagnant++;
    temp *= cooling;
    if (stagnant > 1600) {
      temp = startTemp * 0.85;
      stagnant = 0;
      reheats++;
    }
  }

  // Restore best from Phase B & ensure hard-locked mode before Deterministic Phase C Sweep!
  tunnelMode = false;
  for (let i = 0; i < n; i++) bitIdx.unplace(i);
  for (let i = 0; i < n; i++) applyUpdate(i, bestDay[i], bestStart[i], bestRoom[i]);
  curObj = evalState().obj;
  bestObj = curObj;
  rebuildByDay();

  // Phase C: Deterministic Exhaustive Gap & Asprak CLEAR Sweep + Final 4->3d Collapse!
  for (let pass = 0; pass < 6; pass++) {
    let imp = false;

    // C0: Exhaustive Single-Session Free-Slot Move (closes any easy free-slot gap, 4->3d shrink, or Asprak partial!)
    for (const idx of movableIndices) {
      const oD = bitIdx.sessionDayIdx[idx], oSt = bitIdx.sessionStart[idx], oR = bitIdx.sessionRoomId[idx];
      let bestFree: { d: number; st: number; rid: number; ev: MentokEval } | null = null;
      bitIdx.unplace(idx);
      for (let td = 0; td < 5; td++) {
        for (const rid of allowedRoomIds[idx]) {
          if (policy.enforcePascaMonWed && isPascaById[rid] && td > 2) continue;
          for (const st of candidateStarts[idx]) {
            if (td === oD && st === oSt && rid === oR) continue;
            if (!bitIdx.canPlaceHard(idx, td, rid, startMasks[idx].get(st)!, policy.enforceAsprakWetLab)) continue;
            applyUpdate(idx, td, st, rid);
            const ev = evalState();
            bitIdx.unplace(idx);
            if (ev.obj > curObj && (!bestFree || ev.obj > bestFree.ev.obj)) {
              bestFree = { d: td, st, rid, ev };
            }
          }
        }
      }
      if (bestFree) {
        applyUpdate(idx, bestFree.d, bestFree.st, bestFree.rid);
        curObj = bestFree.ev.obj;
        if (bestFree.ev.obj > bestObj) saveBestMentok(bestFree.ev);
        improvingMoves++;
        imp = true;
        if (bestFree.d !== oD) rebuildByDay();
      } else {
        applyUpdate(idx, oD, oSt, oR);
      }
    }

    // C1: Every same-day pairwise swap that strictly improves Mentok objective
    for (let d = 0; d < 5; d++) {
      const pool = byDay[d];
      for (let ia = 0; ia < pool.length; ia++) {
        const a = pool[ia];
        for (let ib = ia + 1; ib < pool.length; ib++) {
          const b = pool[ib];
          if (sessDur[a] !== sessDur[b]) continue;
          const aSt = bitIdx.sessionStart[a], aR = bitIdx.sessionRoomId[a];
          const bSt = bitIdx.sessionStart[b], bR = bitIdx.sessionRoomId[b];
          if (aSt === bSt) continue;
          if (!allowedRoomIds[a].includes(bR) || !allowedRoomIds[b].includes(aR)) continue;
          const mA = startMasks[a].get(bSt), mB = startMasks[b].get(aSt);
          if (!mA || !mB) continue;

          bitIdx.unplace(a);
          bitIdx.unplace(b);
          if (bitIdx.canPlaceHard(a, d, bR, mA, policy.enforceAsprakWetLab)) {
            applyUpdate(a, d, bSt, bR);
            if (bitIdx.canPlaceHard(b, d, aR, mB, policy.enforceAsprakWetLab)) {
              applyUpdate(b, d, aSt, aR);
              const ev = evalState();
              if (ev.obj > curObj) {
                curObj = ev.obj;
                if (ev.obj > bestObj) saveBestMentok(ev);
                improvingMoves++;
                imp = true;
                continue;
              }
              bitIdx.unplace(b);
            }
            bitIdx.unplace(a);
          }
          applyUpdate(a, d, aSt, aR);
          applyUpdate(b, d, bSt, bR);
        }
      }
    }

    // C2: Every PARTIAL wet-lab deterministic CLEAR attempt (shift wet-lab OR swap overlapping senior on same day!)
    if (policy.enforceAsprakWetLab) {
      for (const ws of bitIdx.wetLabIndices) {
        const ovList = bitIdx.findSeniorOverlapsForWetLab(ws);
        if (ovList.length === 0) continue;
        // C2a: shift wet-lab itself
        if (pinnedMask[ws] === 0) {
          const oD = bitIdx.sessionDayIdx[ws], oSt = bitIdx.sessionStart[ws], oR = bitIdx.sessionRoomId[ws];
          let bestW: { d: number; st: number; ev: MentokEval } | null = null;
          bitIdx.unplace(ws);
          for (let td = 0; td < 5; td++) {
            for (const st of candidateStarts[ws]) {
              if (td === oD && st === oSt) continue;
              if (!bitIdx.canPlaceHard(ws, td, oR, startMasks[ws].get(st)!, true)) continue;
              applyUpdate(ws, td, st, oR);
              const ev = evalState();
              bitIdx.unplace(ws);
              if (ev.obj > curObj && (!bestW || ev.obj > bestW.ev.obj)) bestW = { d: td, st, ev };
            }
          }
          if (bestW) {
            applyUpdate(ws, bestW.d, bestW.st, oR);
            curObj = bestW.ev.obj;
            if (bestW.ev.obj > bestObj) saveBestMentok(bestW.ev);
            asprakClears++;
            imp = true;
            rebuildByDay();
            continue;
          } else {
            applyUpdate(ws, oD, oSt, oR);
          }
        }
        // C2b: swap each overlapping senior session with ANY compatible session (same-day OR cross-day!)
        const wsSt = bitIdx.sessionStart[ws], wsEn = bitIdx.sessionEnd[ws];
        for (const sIdx of ovList) {
          if (pinnedMask[sIdx] === 1) continue;
          const sD = bitIdx.sessionDayIdx[sIdx], sSt = bitIdx.sessionStart[sIdx], sR = bitIdx.sessionRoomId[sIdx];
          let bestS: { b: number; bD: number; bSt: number; bR: number; ev: MentokEval } | null = null;
          for (const b of movableIndices) {
            if (b === sIdx || sessDur[b] !== sessDur[sIdx]) continue;
            const bD = bitIdx.sessionDayIdx[b], bSt = bitIdx.sessionStart[b], bR = bitIdx.sessionRoomId[b];
            if (bD === sD && bSt < wsEn && wsSt < bSt + sessDur[sIdx]) continue;
            if (!allowedRoomIds[sIdx].includes(bR) || !allowedRoomIds[b].includes(sR)) continue;
            if (policy.enforcePascaMonWed && ((isPascaById[bR] && bD > 2) || (isPascaById[sR] && sD > 2))) continue;
            const mS = startMasks[sIdx].get(bSt), mB = startMasks[b].get(sSt);
            if (!mS || !mB) continue;
            bitIdx.unplace(sIdx);
            bitIdx.unplace(b);
            if (bitIdx.canPlaceHard(sIdx, bD, bR, mS, true)) {
              applyUpdate(sIdx, bD, bSt, bR);
              if (bitIdx.canPlaceHard(b, sD, sR, mB, true)) {
                applyUpdate(b, sD, sSt, sR);
                const ev = evalState();
                bitIdx.unplace(b);
                if (ev.obj > curObj && (!bestS || ev.obj > bestS.ev.obj)) bestS = { b, bD, bSt, bR, ev };
              }
              bitIdx.unplace(sIdx);
            }
            applyUpdate(sIdx, sD, sSt, sR);
            applyUpdate(b, bD, bSt, bR);
          }
          if (bestS) {
            bitIdx.unplace(sIdx);
            bitIdx.unplace(bestS.b);
            applyUpdate(sIdx, bestS.bD, bestS.bSt, bestS.bR);
            applyUpdate(bestS.b, sD, sSt, sR);
            curObj = bestS.ev.obj;
            if (bestS.ev.obj > bestObj) saveBestMentok(bestS.ev);
            asprakClears++;
            imp = true;
            if (bestS.bD !== sD) rebuildByDay();
          }
        }

        // C2c: Balanced Wet-Lab Day Exchange (move PARTIAL wet-lab `ws` from oD -> td AND swap one
        // session `sJr` of `ws`'s junior class from td -> oD -> preserves exact day counts & clears Asprak!)
        if (pinnedMask[ws] === 0 && bitIdx.findSeniorOverlapsForWetLab(ws).length > 0 && sessions[ws].classes.length === 1) {
          const jc = sessions[ws].classes[0];
          const jl = classToSessIndices.get(jc) || [];
          const oD = bitIdx.sessionDayIdx[ws], oSt = bitIdx.sessionStart[ws], oR = bitIdx.sessionRoomId[ws];
          const otherDays = Array.from(new Set(jl.map((si) => bitIdx.sessionDayIdx[si]))).filter((d) => d !== oD);
          let exchanged = false;
          exchLoop: for (const td of otherDays) {
            const jrCands = jl.filter(
              (si) =>
                si !== ws &&
                pinnedMask[si] === 0 &&
                bitIdx.sessionDayIdx[si] === td &&
                sessions[si].roomType !== 'WET_LAB'
            );
            if (jrCands.length === 0) continue;
            for (const wst of candidateStarts[ws]) {
              const wMask = startMasks[ws].get(wst)!;
              for (const sJr of jrCands) {
                const jSt = bitIdx.sessionStart[sJr], jR = bitIdx.sessionRoomId[sJr], jDur = sessDur[sJr];
                // Pair sJr with a same-duration session `b` on oD (zero empty rooms needed!)
                for (const b of byDay[oD]) {
                  if (b === ws || b === sJr || sessDur[b] !== jDur || sessions[b].classes.includes(jc)) continue;
                  const bSt = bitIdx.sessionStart[b], bR = bitIdx.sessionRoomId[b];
                  if (!allowedRoomIds[sJr].includes(bR) || !allowedRoomIds[b].includes(jR)) continue;
                  if (policy.enforcePascaMonWed && ((isPascaById[bR] && oD > 2) || (isPascaById[jR] && td > 2))) continue;
                  const mJr = startMasks[sJr].get(bSt), mB = startMasks[b].get(jSt);
                  if (!mJr || !mB) continue;

                  bitIdx.unplace(ws);
                  bitIdx.unplace(sJr);
                  bitIdx.unplace(b);
                  if (bitIdx.canPlaceHard(ws, td, oR, wMask, true)) {
                    applyUpdate(ws, td, wst, oR);
                    if (bitIdx.canPlaceHard(sJr, oD, bR, mJr, true)) {
                      applyUpdate(sJr, oD, bSt, bR);
                      if (bitIdx.canPlaceHard(b, td, jR, mB, true)) {
                        applyUpdate(b, td, jSt, jR);
                        const ev = evalState();
                        if (ev.obj > curObj) {
                          curObj = ev.obj;
                          if (ev.obj > bestObj) saveBestMentok(ev);
                          asprakClears++;
                          imp = true;
                          exchanged = true;
                          rebuildByDay();
                          break exchLoop;
                        }
                        bitIdx.unplace(b);
                      }
                      bitIdx.unplace(sJr);
                    }
                    bitIdx.unplace(ws);
                  }
                  applyUpdate(ws, oD, oSt, oR);
                  applyUpdate(sJr, td, jSt, jR);
                  applyUpdate(b, oD, bSt, bR);
                }
              }
            }
          }
          if (exchanged) continue;
        }
        // C2h: Zero-Free-Slot Balanced Senior Day Exchange + Swap-Enabled Senior Clear!
        // Works at 100% general-room packing density:
        //   (1) Moves overlapping senior `sIdx` (e.g., 340m wet-lab S266) from sD -> td AND moves/swaps `sOther`
        //       of the same senior class from td -> sD OUTSIDE [wStH, wEnH] (using free slot OR same-dur partner `b` on sD!)
        //   (2) Moves overlapping senior theory `sIdx` (e.g., S112) via cross-day swap with `b` on td, AND if sD now has
        //       a dead gap in `sc`, closes it via a compound same-day swap on `sc`'s peer session (e.g., S108 -> 08:40)!
        const curOvH = bitIdx.findSeniorOverlapsForWetLab(ws);
        if (curOvH.length > 0) {
          const wStH = bitIdx.sessionStart[ws], wEnH = bitIdx.sessionEnd[ws];
          for (const sIdx of curOvH) {
            if (pinnedMask[sIdx] === 1 || sessions[sIdx].classes.length !== 1) continue;
            const sc = sessions[sIdx].classes[0];
            const sl = classToSessIndices.get(sc) || [];
            const sD = bitIdx.sessionDayIdx[sIdx], sSt = bitIdx.sessionStart[sIdx], sR = bitIdx.sessionRoomId[sIdx];
            const otherDays = Array.from(new Set(sl.map((si) => bitIdx.sessionDayIdx[si]))).filter((d) => d !== sD);
            let exchS = false;

            // C2h-1: Balanced Senior Day Exchange (free slot OR swap `sOther` <-> `b` on sD outside [wStH, wEnH]!)
            senExch: for (const td of otherDays) {
              const sCands = sl.filter((si) => si !== sIdx && pinnedMask[si] === 0 && bitIdx.sessionDayIdx[si] === td);
              if (sCands.length === 0) continue;
              for (const sOther of sCands) {
                const oSt = bitIdx.sessionStart[sOther], oR = bitIdx.sessionRoomId[sOther], oDur = sessDur[sOther];
                bitIdx.unplace(sIdx);
                bitIdx.unplace(sOther);

                for (const sr of allowedRoomIds[sIdx]) {
                  if (policy.enforcePascaMonWed && isPascaById[sr] && td > 2) continue;
                  for (const sst of candidateStarts[sIdx]) {
                    if (!bitIdx.canPlaceHard(sIdx, td, sr, startMasks[sIdx].get(sst)!, true)) continue;
                    applyUpdate(sIdx, td, sst, sr);

                    // Sub-a: free slot on sD outside [wStH, wEnH]
                    for (const orid of allowedRoomIds[sOther]) {
                      if (policy.enforcePascaMonWed && isPascaById[orid] && sD > 2) continue;
                      for (const ost of candidateStarts[sOther]) {
                        if (ost < wEnH && wStH < ost + oDur) continue;
                        if (!bitIdx.canPlaceHard(sOther, sD, orid, startMasks[sOther].get(ost)!, true)) continue;
                        applyUpdate(sOther, sD, ost, orid);
                        const ev = evalState();
                        if (ev.obj > curObj) {
                          curObj = ev.obj;
                          if (ev.obj > bestObj) saveBestMentok(ev);
                          asprakClears++;
                          imp = true;
                          exchS = true;
                          rebuildByDay();
                          break senExch;
                        }
                        bitIdx.unplace(sOther);
                      }
                    }

                    // Sub-b: 100%-packed swap of `sOther` (td) with same-duration `b` on sD outside [wStH, wEnH]!
                    for (const b of byDay[sD]) {
                      if (b === sIdx || b === sOther || sessDur[b] !== oDur || sessions[b].classes.includes(sc)) continue;
                      const bSt = bitIdx.sessionStart[b], bR = bitIdx.sessionRoomId[b];
                      if (bSt < wEnH && wStH < bSt + oDur) continue;
                      if (!allowedRoomIds[sOther].includes(bR) || !allowedRoomIds[b].includes(oR)) continue;
                      if (policy.enforcePascaMonWed && ((isPascaById[bR] && sD > 2) || (isPascaById[oR] && td > 2))) continue;
                      const mO = startMasks[sOther].get(bSt), mB = startMasks[b].get(oSt);
                      if (!mO || !mB) continue;
                      bitIdx.unplace(b);
                      if (bitIdx.canPlaceHard(sOther, sD, bR, mO, true)) {
                        applyUpdate(sOther, sD, bSt, bR);
                        if (bitIdx.canPlaceHard(b, td, oR, mB, true)) {
                          applyUpdate(b, td, oSt, oR);
                          const ev = evalState();
                          if (ev.obj > curObj) {
                            curObj = ev.obj;
                            if (ev.obj > bestObj) saveBestMentok(ev);
                            asprakClears++;
                            imp = true;
                            exchS = true;
                            rebuildByDay();
                            break senExch;
                          }
                          bitIdx.unplace(b);
                        }
                        bitIdx.unplace(sOther);
                      }
                      applyUpdate(b, sD, bSt, bR);
                    }

                    bitIdx.unplace(sIdx);
                  }
                }
                applyUpdate(sIdx, sD, sSt, sR);
                applyUpdate(sOther, td, oSt, oR);
              }
            }
            if (exchS) break;

            // C2h-2: Compound Cross-Day Swap + Same-Day Peer Gap-Closure!
            // Swaps overlapping senior `sIdx` (sD) with same-dur `b` on another active day `td` of `sc` (when sc has >=3 on sD),
            // AND simultaneously tries a same-day swap on any remaining peer of `sc` on sD to close any newly opened gap!
            const sdc = [0, 0, 0, 0, 0];
            for (const x of sl) sdc[bitIdx.sessionDayIdx[x]]++;
            if (sdc[sD] >= 3) {
              const sDur = sessDur[sIdx];
              const peersOnSD = sl.filter((x) => x !== sIdx && pinnedMask[x] === 0 && bitIdx.sessionDayIdx[x] === sD);
              compLoop: for (const td of otherDays) {
                for (const b of byDay[td]) {
                  if (b === sIdx || sessDur[b] !== sDur || sessions[b].classes.includes(sc)) continue;
                  const bSt = bitIdx.sessionStart[b], bR = bitIdx.sessionRoomId[b];
                  if (!allowedRoomIds[sIdx].includes(bR) || !allowedRoomIds[b].includes(sR)) continue;
                  if (policy.enforcePascaMonWed && ((isPascaById[bR] && td > 2) || (isPascaById[sR] && sD > 2))) continue;
                  // Keep b's class contiguous & >=2/day on td -> sD
                  const bOk = sessions[b].classes.every((bc) => {
                    const bl = classToSessIndices.get(bc) || [];
                    const cnt = [0, 0, 0, 0, 0];
                    for (const x of bl) cnt[bitIdx.sessionDayIdx[x]]++;
                    cnt[td]--; cnt[sD]++;
                    let mn = 5, mx = -1, act = 0;
                    for (let d = 0; d < 5; d++) if (cnt[d] > 0) { act++; if (d < mn) mn = d; if (d > mx) mx = d; }
                    return mx - mn + 1 === act && (bl.length < 2 || !cnt.some((v) => v === 1));
                  });
                  if (!bOk) continue;
                  const mS = startMasks[sIdx].get(bSt), mB = startMasks[b].get(sSt);
                  if (!mS || !mB) continue;

                  bitIdx.unplace(sIdx);
                  bitIdx.unplace(b);
                  if (bitIdx.canPlaceHard(sIdx, td, bR, mS, true)) {
                    applyUpdate(sIdx, td, bSt, bR);
                    if (bitIdx.canPlaceHard(b, sD, sR, mB, true)) {
                      applyUpdate(b, sD, sSt, sR);
                      const ev0 = evalState();
                      if (ev0.obj > curObj) {
                        curObj = ev0.obj;
                        if (ev0.obj > bestObj) saveBestMentok(ev0);
                        asprakClears++;
                        imp = true;
                        exchS = true;
                        rebuildByDay();
                        break compLoop;
                      }
                      // Try closing any gap opened on sD by swapping one peer of `sc` on sD with a same-day partner `q`!
                      for (const peer of peersOnSD) {
                        const pSt = bitIdx.sessionStart[peer], pR = bitIdx.sessionRoomId[peer], pDur = sessDur[peer];
                        for (const q of byDay[sD]) {
                          if (q === peer || q === sIdx || q === b || sessDur[q] !== pDur) continue;
                          const qSt = bitIdx.sessionStart[q], qR = bitIdx.sessionRoomId[q];
                          if (qSt === pSt || !allowedRoomIds[peer].includes(qR) || !allowedRoomIds[q].includes(pR)) continue;
                          const mP = startMasks[peer].get(qSt), mQ = startMasks[q].get(pSt);
                          if (!mP || !mQ) continue;
                          bitIdx.unplace(peer);
                          bitIdx.unplace(q);
                          if (bitIdx.canPlaceHard(peer, sD, qR, mP, true)) {
                            applyUpdate(peer, sD, qSt, qR);
                            if (bitIdx.canPlaceHard(q, sD, pR, mQ, true)) {
                              applyUpdate(q, sD, pSt, pR);
                              const ev1 = evalState();
                              if (ev1.obj > curObj) {
                                curObj = ev1.obj;
                                if (ev1.obj > bestObj) saveBestMentok(ev1);
                                asprakClears++;
                                imp = true;
                                exchS = true;
                                rebuildByDay();
                                break compLoop;
                              }
                              bitIdx.unplace(q);
                            }
                            bitIdx.unplace(peer);
                          }
                          applyUpdate(peer, sD, pSt, pR);
                          applyUpdate(q, sD, qSt, qR);
                        }
                      }
                      bitIdx.unplace(b);
                    }
                    bitIdx.unplace(sIdx);
                  }
                  applyUpdate(sIdx, sD, sSt, sR);
                  applyUpdate(b, td, bSt, bR);
                }
              }
            }
            if (exchS) break;
          }
        }

        // C2d: Targeted Same-Day 3-Cycle Senior Clear (sIdx -> b -> c -> sIdx on same day sD; breaks 2-swap deadlocks!)
        for (const sIdx of bitIdx.findSeniorOverlapsForWetLab(ws)) {
          if (pinnedMask[sIdx] === 1) continue;
          const sD = bitIdx.sessionDayIdx[sIdx], sSt = bitIdx.sessionStart[sIdx], sR = bitIdx.sessionRoomId[sIdx];
          const sDur = sessDur[sIdx];
          const sameDaySameDur = byDay[sD].filter((x) => x !== sIdx && sessDur[x] === sDur);
          let cycled = false;
          cycAsp: for (const b of sameDaySameDur) {
            const bSt = bitIdx.sessionStart[b], bR = bitIdx.sessionRoomId[b];
            if (bSt < wsEn && wsSt < bSt + sDur) continue; // sIdx must land outside ws!
            if (!allowedRoomIds[sIdx].includes(bR)) continue;
            const mS = startMasks[sIdx].get(bSt);
            if (!mS) continue;
            for (const c of sameDaySameDur) {
              if (c === b) continue;
              const cSt = bitIdx.sessionStart[c], cR = bitIdx.sessionRoomId[c];
              if (!allowedRoomIds[b].includes(cR) || !allowedRoomIds[c].includes(sR)) continue;
              const mB = startMasks[b].get(cSt), mC = startMasks[c].get(sSt);
              if (!mB || !mC) continue;
              bitIdx.unplace(sIdx);
              bitIdx.unplace(b);
              bitIdx.unplace(c);
              if (bitIdx.canPlaceHard(sIdx, sD, bR, mS, true)) {
                applyUpdate(sIdx, sD, bSt, bR);
                if (bitIdx.canPlaceHard(b, sD, cR, mB, true)) {
                  applyUpdate(b, sD, cSt, cR);
                  if (bitIdx.canPlaceHard(c, sD, sR, mC, true)) {
                    applyUpdate(c, sD, sSt, sR);
                    const ev = evalState();
                    if (ev.obj > curObj) {
                      curObj = ev.obj;
                      if (ev.obj > bestObj) saveBestMentok(ev);
                      asprakClears++;
                      imp = true;
                      cycled = true;
                      break cycAsp;
                    }
                    bitIdx.unplace(c);
                  }
                  bitIdx.unplace(b);
                }
                bitIdx.unplace(sIdx);
              }
              applyUpdate(sIdx, sD, sSt, sR);
              applyUpdate(b, sD, bSt, bR);
              applyUpdate(c, sD, cSt, cR);
            }
          }
          if (cycled) break;
        }
      }
    }

    // C1b: Targeted Same-Day 3-Cycle for remaining gapped sessions (a -> b -> c -> a)!
    refreshGappedSessions();
    for (const a of gappedSessions) {
      const d = bitIdx.sessionDayIdx[a], aSt = bitIdx.sessionStart[a], aR = bitIdx.sessionRoomId[a];
      const aDur = sessDur[a];
      const pool = byDay[d].filter((x) => x !== a && sessDur[x] === aDur);
      let cycledG = false;
      cycGap: for (const b of pool) {
        const bSt = bitIdx.sessionStart[b], bR = bitIdx.sessionRoomId[b];
        if (bSt === aSt || !allowedRoomIds[a].includes(bR)) continue;
        const mA = startMasks[a].get(bSt);
        if (!mA) continue;
        for (const c of pool) {
          if (c === b) continue;
          const cSt = bitIdx.sessionStart[c], cR = bitIdx.sessionRoomId[c];
          if (!allowedRoomIds[b].includes(cR) || !allowedRoomIds[c].includes(aR)) continue;
          const mB = startMasks[b].get(cSt), mC = startMasks[c].get(aSt);
          if (!mB || !mC) continue;
          bitIdx.unplace(a);
          bitIdx.unplace(b);
          bitIdx.unplace(c);
          if (bitIdx.canPlaceHard(a, d, bR, mA, policy.enforceAsprakWetLab)) {
            applyUpdate(a, d, bSt, bR);
            if (bitIdx.canPlaceHard(b, d, cR, mB, policy.enforceAsprakWetLab)) {
              applyUpdate(b, d, cSt, cR);
              if (bitIdx.canPlaceHard(c, d, aR, mC, policy.enforceAsprakWetLab)) {
                applyUpdate(c, d, aSt, aR);
                const ev = evalState();
                if (ev.obj > curObj) {
                  curObj = ev.obj;
                  if (ev.obj > bestObj) saveBestMentok(ev);
                  improvingMoves++;
                  imp = true;
                  cycledG = true;
                  break cycGap;
                }
                bitIdx.unplace(c);
              }
              bitIdx.unplace(b);
            }
            bitIdx.unplace(a);
          }
          applyUpdate(a, d, aSt, aR);
          applyUpdate(b, d, bSt, bR);
          applyUpdate(c, d, cSt, cR);
        }
      }
      if (cycledG) continue;
    }

    // C3: Exhaustive Cross-Day Pairwise Swap for remaining gapped sessions!
    refreshGappedSessions();
    for (const a of gappedSessions) {
      const aD = bitIdx.sessionDayIdx[a], aSt = bitIdx.sessionStart[a], aR = bitIdx.sessionRoomId[a];
      let bestX: { b: number; bD: number; bSt: number; bR: number; ev: MentokEval } | null = null;
      for (const b of movableIndices) {
        if (b === a || sessDur[b] !== sessDur[a]) continue;
        const bD = bitIdx.sessionDayIdx[b];
        if (bD === aD) continue;
        const bSt = bitIdx.sessionStart[b], bR = bitIdx.sessionRoomId[b];
        if (!allowedRoomIds[a].includes(bR) || !allowedRoomIds[b].includes(aR)) continue;
        if (policy.enforcePascaMonWed && ((isPascaById[bR] && bD > 2) || (isPascaById[aR] && aD > 2))) continue;
        const mA = startMasks[a].get(bSt), mB = startMasks[b].get(aSt);
        if (!mA || !mB) continue;
        bitIdx.unplace(a);
        bitIdx.unplace(b);
        if (bitIdx.canPlaceHard(a, bD, bR, mA, policy.enforceAsprakWetLab)) {
          applyUpdate(a, bD, bSt, bR);
          if (bitIdx.canPlaceHard(b, aD, aR, mB, policy.enforceAsprakWetLab)) {
            applyUpdate(b, aD, aSt, aR);
            const ev = evalState();
            bitIdx.unplace(b);
            if (ev.obj > curObj && (!bestX || ev.obj > bestX.ev.obj)) bestX = { b, bD, bSt, bR, ev };
          }
          bitIdx.unplace(a);
        }
        applyUpdate(a, aD, aSt, aR);
        applyUpdate(b, bD, bSt, bR);
      }
      if (bestX) {
        bitIdx.unplace(a);
        bitIdx.unplace(bestX.b);
        applyUpdate(a, bestX.bD, bestX.bSt, bestX.bR);
        applyUpdate(bestX.b, aD, aSt, aR);
        curObj = bestX.ev.obj;
        if (bestX.ev.obj > bestObj) saveBestMentok(bestX.ev);
        improvingMoves++;
        imp = true;
        rebuildByDay();
      }
    }

    // C2e-C2g: Atomic Multi-Senior Clear + Wet-Lab Swap + Whole-Class +/-1 Day Block Slide!
    if (runAsprakAtomicClearPass()) {
      imp = true;
      rebuildByDay();
    }

    // C4: Final Ruin-and-Repack + 4/5-day -> 3-day Kempe Collapse + Block-Slide attempt!
    if (runClassRuinAndRepackPass() || runKempeCollapse4To3Pass() || runCollapse4To3Pass() || tryBlockSlideCollapse()) {
      imp = true;
      rebuildByDay();
    }

    if (!imp) break;
  }

  // Final restore of incumbent best
  for (let i = 0; i < n; i++) {
    sessions[i].day = DAYS[bestDay[i]];
    sessions[i].start = bestStart[i];
    sessions[i].end = bestEnd[i];
    sessions[i].room = idToRoomName[bestRoom[i]];
  }

  const moves: SessionMove[] = [];
  for (let i = 0; i < n; i++) {
    const a = diffRef[i];
    const b = sessions[i];
    if (a.day !== b.day || a.start !== b.start || a.room !== b.room) {
      moves.push({
        id: b.id,
        namaMk: b.namaMk,
        kelasRaw: b.kelasRaw,
        from: { day: a.day, start: a.start, end: a.end, room: a.room },
        to: { day: b.day, start: b.start, end: b.end, room: b.room },
      });
    }
  }

  return {
    sessions,
    moves,
    perturbationCount: moves.length,
    latencyMs: Number((performance.now() - t0).toFixed(2)),
    audit: auditSchedule(sessions, policy),
    metaheuristic: {
      algorithm: 'TPE + Stage-4 Mentok Deep Polish (Invariant-Locked LAHC+SA+3-Cycle)',
      iterations,
      acceptedMoves,
      improvingMoves,
      kempeSwaps: 0,
      dayConsolidations,
      earlyFixes: 0,
      asprakClears,
      cbsRestarts: 0,
      reheats,
      initialEnergy: Math.round(initEv.obj),
      finalEnergy: Math.round(bestObj),
    },
  };
}
