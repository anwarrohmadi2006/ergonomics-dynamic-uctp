/**
 * Humane Multi-Objective Energy Evaluator & Comprehensive Schedule Auditor
 * Synthesizes 2021-2025 chronobiology, cognitive-fatigue, and commuter literature,
 * ITC-2019 soft constraints, and FST client requirements:
 *   1. Humane Start Time >= 08:40 (520 min); strict elimination of 07:00 fatigue
 *   2. Contiguous 3-4 Active Days (zero alternating hole days like Mon-Wed-Fri)
 *   3. Opsi B <=3 Active Days per class (graceful fallback to 4 contiguous days for TP 5A/5B/3B)
 *   4. Guaranteed ISHOMA 12:00-13:00 lunch break (excluded from "dead gap" count!)
 *   5. Eliminate dead waiting gaps >= 100-120 min (for students & commuter lecturers)
 *   6. Anti-burnout cognitive cap (avoid > 5h continuous back-to-back without break)
 *   7. Avoid isolated single 100-min class days & back-to-back cross-building jumps
 */
import { DAYS, DAY_INDEX, expandEffectiveClasses } from './bitmask-index';
import type {
  AsprakDetail,
  ClassAuditRow,
  ConflictRecord,
  DayName,
  LecturerAuditRow,
  PascaViolation,
  ScheduleAudit,
  Session,
  SolverPolicy,
} from './types';

export const ISHOMA_START = 12 * 60; // 720
export const ISHOMA_END = 13 * 60;   // 780
export const FRIDAY_PRAYER_START = 11 * 60 + 30; // 690 (11:30)
export const FRIDAY_PRAYER_END = 13 * 60;        // 780 (13:00)
export const HUMANE_START = 8 * 60 + 40; // 520 (08:40)
export const EARLY_OVERFLOW_START = 7 * 60 + 50; // 470 (07:50)
export const WORK_END = 16 * 60 + 20; // 980 (16:20)
export const CAMPUS_START = 7 * 60; // 420
export const CAMPUS_END = 18 * 60; // 1080
export const EXTENDED_END = 19 * 60; // 1140 (for 340m mega-practicals 13:00-18:40)
export const PASCA_ALLOWED_DAYS = new Set<DayName>(['Senin', 'Selasa', 'Rabu']);

export const DEFAULT_POLICY: SolverPolicy = {
  enforcePascaMonWed: true,
  enforceAsprakWetLab: true,
  protectIshoma: true,
  maxDaysPerClass: 3,
  minCoursesPerActiveDay: 2,       // Every active day has >= 2 courses (no 1-course commute days!)
  enforceContiguousDays: true,
  preferredMinStart: HUMANE_START, // 08:40
  allowDryLabOverflow: true,       // Shares ONLY LAB. DATA ENGINEER & LAB. DATA SCIENCE with IF/SD theory -> 100% >=08:40
  preferWorkingHours: true,
  minimizeLongGaps: true,
  preventMarathon: true,
  protectFridayPrayer: false,
  hardFridayPrayer: false,
};

export function fmtTime(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function isPascaRoom(roomName: string): boolean {
  return /^Pasca/i.test(roomName || '');
}

export function isSaintekRoom(roomName: string): boolean {
  return /^LAB\.\s*4-0[1-4]$/i.test(roomName || '');
}

export function isGeneralRoom(roomName: string): boolean {
  return isPascaRoom(roomName) || isSaintekRoom(roomName);
}

export function buildingGroup(roomName: string): 'PASCA' | 'SAINTEK' {
  return isPascaRoom(roomName) ? 'PASCA' : 'SAINTEK';
}

export function overlaps(
  d1: DayName,
  s1: number,
  e1: number,
  d2: DayName,
  s2: number,
  e2: number
): boolean {
  return d1 === d2 && s1 < e2 && s2 < e1;
}

export function overlapsIshoma(start: number, end: number, duration: number): boolean {
  if (duration > 300) return false;
  return start < ISHOMA_END && end > ISHOMA_START;
}

export function overlapsFridayPrayer(day: DayName, start: number, end: number, _duration?: number): boolean {
  if (day !== 'Jumat') return false;
  return start < FRIDAY_PRAYER_END && end > FRIDAY_PRAYER_START;
}

/**
 * Effective "dead gap" between two consecutive sessions on the same day.
 * Subtracts the healthy 60-minute ISHOMA lunch block (12:00-13:00), or the extended
 * 90-minute Friday prayer break (11:30-13:00) on Friday when protectFridayPrayer/hardFridayPrayer is active.
 */
export function effectiveDeadGap(
  prevEnd: number,
  nextStart: number,
  day?: DayName,
  protectFriday = false
): number {
  const raw = nextStart - prevEnd;
  if (raw <= 0) return 0;
  const breakStart = day === 'Jumat' && protectFriday ? FRIDAY_PRAYER_START : ISHOMA_START;
  const breakEnd = ISHOMA_END;
  const lunchOverlap = Math.max(0, Math.min(nextStart, breakEnd) - Math.max(prevEnd, breakStart));
  return Math.max(0, raw - lunchOverlap);
}

export function sharesClass(a: string[], b: string[]): boolean {
  const ea = expandEffectiveClasses(a);
  const eb = expandEffectiveClasses(b);
  for (let i = 0; i < ea.length; i++) {
    for (let j = 0; j < eb.length; j++) {
      if (ea[i] === eb[j]) return true;
    }
  }
  return false;
}

export function buildCohortMap(sessions: Session[]): Map<string, string[]> {
  const map = new Map<string, Set<string>>();
  for (const s of sessions) {
    for (const c of s.classes) {
      if (/^Praktikum\s+/i.test(c)) continue;
      const m = c.match(/^(.+?)\s+(\d)[A-Z]$/);
      if (!m) continue;
      const key = `${m[1].trim()}|${m[2]}`;
      if (!map.has(key)) map.set(key, new Set());
      map.get(key)!.add(c);
    }
  }
  const out = new Map<string, string[]>();
  for (const [k, set] of map.entries()) {
    out.set(k, Array.from(set).sort());
  }
  return out;
}

export function getSeniorCohortClasses(session: Session, cohortMap: Map<string, string[]>): string[] {
  if (!session.isWetLab || !session.semester) return [];
  return cohortMap.get(`${session.prodiPrefix}|${session.semester + 2}`) || [];
}

/**
 * Fast Global Humane Energy Function used inside H-ALNS-LAHC inner loop.
 * Lower is better (0 = utopian schedule).
 */
export function computeGlobalHumaneEnergy(
  sessions: Session[],
  policy: SolverPolicy
): number {
  let energy = 0;
  const minStart = policy.preferredMinStart ?? HUMANE_START;

  // Group sessions by atomic class and by lecturer
  const clsDayBuckets = new Map<string, Session[][]>();
  const lecDayBuckets = new Map<string, Session[][]>();

  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    const dIdx = DAY_INDEX[s.day];

    // 1. Humane Start Time Penalty (Unified with Stage-2 computeFastEnergy!)
    if (s.start < EARLY_OVERFLOW_START) {
      energy += 650; // 07:00 class: almost banned!
    } else if (s.start < minStart) {
      energy += policy.allowDryLabOverflow ? 980 : 180;
    }

    // 2. Late afternoon preference (soft, after 16:20)
    if (policy.preferWorkingHours && s.end > WORK_END) {
      energy += s.end > CAMPUS_END ? 32 : 14;
    }

    // 2b. Optional Friday midday prayer window (11:30-13:00)
    if ((policy.protectFridayPrayer || policy.hardFridayPrayer) && overlapsFridayPrayer(s.day, s.start, s.end, s.duration)) {
      energy += policy.hardFridayPrayer ? 5000 : 500;
    }

    // Populate class & lecturer day buckets
    for (let k = 0; k < s.classes.length; k++) {
      const c = s.classes[k];
      let arr = clsDayBuckets.get(c);
      if (!arr) {
        arr = [[], [], [], [], []];
        clsDayBuckets.set(c, arr);
      }
      arr[dIdx].push(s);
    }
    if (s.dosen) {
      let arr = lecDayBuckets.get(s.dosen);
      if (!arr) {
        arr = [[], [], [], [], []];
        lecDayBuckets.set(s.dosen, arr);
      }
      arr[dIdx].push(s);
    }
  }

  // Evaluate every student class (contiguous days, <=3 days Opsi B, dead gaps, marathon, isolation, building jumps)
  for (const dayArr of clsDayBuckets.values()) {
    let activeCount = 0;
    let minD = 5;
    let maxD = -1;
    let totalWeeklyMin = 0;

    for (let d = 0; d < 5; d++) {
      const list = dayArr[d];
      if (list.length === 0) continue;
      activeCount++;
      if (d < minD) minD = d;
      if (d > maxD) maxD = d;

      if (list.length > 1) list.sort((a, b) => a.start - b.start);

      let dailyMin = 0;
      let continuousMin = 0;
      let continuousCount = 0;

      for (let k = 0; k < list.length; k++) {
        const cur = list[k];
        dailyMin += cur.duration;
        totalWeeklyMin += cur.duration;

        if (k === 0) {
          continuousMin = cur.duration;
          continuousCount = 1;
        } else {
          const prev = list[k - 1];
          const rawGap = cur.start - prev.end;
          const deadGap = effectiveDeadGap(prev.end, cur.start, DAYS[d], Boolean(policy.protectFridayPrayer || policy.hardFridayPrayer));

          // Dead gap penalty (outside healthy ISHOMA lunch!)
          if (policy.minimizeLongGaps) {
            if (deadGap >= 100) energy += 130 + Math.floor((deadGap - 100) / 30) * 20;
            else if (deadGap >= 40) energy += 28;
          }

          // Back-to-back building switch (Pasca <-> Saintek with zero gap)
          if (rawGap === 0 && buildingGroup(prev.room) !== buildingGroup(cur.room)) {
            energy += 16;
          }

          // Continuous cognitive burnout tracking (resets if >= 40 min break including ISHOMA)
          if (rawGap < 40) {
            continuousMin += cur.duration;
            continuousCount++;
          } else {
            continuousMin = cur.duration;
            continuousCount = 1;
          }
          // Marathon = 2+ chained sessions without >=40m break exceeding 5 hours (300 min)
          if (policy.preventMarathon && continuousCount >= 2 && continuousMin > 300) {
            energy += 130;
          }
        }
      }

      // Daily overload (> 8h/day)
      if (dailyMin > 480) energy += 65;
    }

    // Active day compactness (Unified with Stage-2 computeFastEnergy!)
    const needs4Days = totalWeeklyMin > 1420; // TP 5B (1750), TP 5A (1700), TP 3B (1580)
    if (activeCount > policy.maxDaysPerClass) {
      if (activeCount === 4) {
        energy += needs4Days ? 25 : 460;
      } else {
        energy += 1050; // 5 active days strictly discouraged
      }
    }

    // CONTIGUOUS DAYS CONSTRAINT (Unified lexicographic weight 3200!)
    if (policy.enforceContiguousDays && activeCount >= 2) {
      const span = maxD - minD + 1;
      const holes = span - activeCount;
      if (holes > 0) {
        energy += holes * 3200;
      }
    }

    // MINIMUM 2 COURSES PER ACTIVE DAY (Unified weight 920!)
    const minPerDay = policy.minCoursesPerActiveDay ?? 2;
    let totalClassSess = 0;
    for (let d = 0; d < 5; d++) totalClassSess += dayArr[d].length;
    if (minPerDay >= 2 && totalClassSess >= 2) {
      for (let d = 0; d < 5; d++) {
        if (dayArr[d].length === 1) {
          energy += 920;
        }
      }
    }
  }

  // Evaluate commuter lecturers (gaps, contiguity, min 2 courses/day, daily burnout)
  for (const dayArr of lecDayBuckets.values()) {
    let activeCount = 0;
    let minD = 5;
    let maxD = -1;
    let totalLecSess = 0;
    for (let d = 0; d < 5; d++) {
      const list = dayArr[d];
      if (list.length === 0) continue;
      activeCount++;
      totalLecSess += list.length;
      if (d < minD) minD = d;
      if (d > maxD) maxD = d;
      if (list.length > 1) list.sort((a, b) => a.start - b.start);

      let dailyMin = 0;
      for (let k = 0; k < list.length; k++) {
        dailyMin += list[k].duration;
        if (k > 0) {
          const deadGap = effectiveDeadGap(list[k - 1].end, list[k].start, DAYS[d], Boolean(policy.protectFridayPrayer || policy.hardFridayPrayer));
          if (policy.minimizeLongGaps) {
            if (deadGap >= 100) energy += 75 + Math.floor((deadGap - 100) / 30) * 14;
            else if (deadGap >= 40) energy += 16;
          }
          if (list[k].start - list[k - 1].end === 0 && buildingGroup(list[k - 1].room) !== buildingGroup(list[k].room)) {
            energy += 12;
          }
        }
      }
      if (dailyMin > 420) energy += 55;
    }
    if (activeCount >= 2 && activeCount <= 4) {
      const holes = maxD - minD + 1 - activeCount;
      if (holes > 0) energy += holes * 22;
    }
    const lecIsoWeight = policy.lecturerIsolatedWeight !== undefined ? policy.lecturerIsolatedWeight : 95;
    if ((policy.minCoursesPerActiveDay ?? 2) >= 2 && totalLecSess >= 2 && lecIsoWeight > 0) {
      for (let d = 0; d < 5; d++) {
        if (dayArr[d].length === 1) energy += lecIsoWeight;
      }
    }
  }

  return energy;
}

/**
 * Full Forensic & Humane Ergonomics Schedule Audit (used by UI + Paper Benchmarks)
 */
export function auditSchedule(
  sessions: Session[],
  policyInput?: Partial<SolverPolicy>
): ScheduleAudit {
  const policy: SolverPolicy = { ...DEFAULT_POLICY, ...(policyInput || {}) };
  const minStart = policy.preferredMinStart ?? HUMANE_START;
  const cohortMap = buildCohortMap(sessions);

  const roomConflicts: ConflictRecord[] = [];
  const lecturerConflicts: ConflictRecord[] = [];
  const classConflicts: ConflictRecord[] = [];
  const pascaViolations: PascaViolation[] = [];
  const asprakDeadlocks: AsprakDetail[] = [];
  const asprakPartial: AsprakDetail[] = [];
  const ishomaViolations: Array<{ sessionId: string; namaMk: string; day: DayName; time: string; room: string }> = [];
  let fridayPrayerViolationCount = 0;
  let lateSessionCount = 0;
  let earlyBefore0840Count = 0;
  let earlyBefore0750Count = 0;

  for (let i = 0; i < sessions.length; i++) {
    const a = sessions[i];
    if (isPascaRoom(a.room) && !PASCA_ALLOWED_DAYS.has(a.day)) {
      pascaViolations.push({
        sessionId: a.id,
        namaMk: a.namaMk,
        kelasRaw: a.kelasRaw,
        day: a.day,
        time: `${fmtTime(a.start)}-${fmtTime(a.end)}`,
        room: a.room,
      });
    }
    if (overlapsIshoma(a.start, a.end, a.duration)) {
      ishomaViolations.push({
        sessionId: a.id,
        namaMk: a.namaMk,
        day: a.day,
        time: `${fmtTime(a.start)}-${fmtTime(a.end)}`,
        room: a.room,
      });
    }
    if (overlapsFridayPrayer(a.day, a.start, a.end, a.duration)) {
      fridayPrayerViolationCount++;
    }
    if (a.end > WORK_END) lateSessionCount++;
    if (a.start < minStart) earlyBefore0840Count++;
    if (a.start < EARLY_OVERFLOW_START) earlyBefore0750Count++;

    for (let j = i + 1; j < sessions.length; j++) {
      const b = sessions[j];
      if (!overlaps(a.day, a.start, a.end, b.day, b.start, b.end)) continue;
      if (a.room === b.room) {
        roomConflicts.push({
          type: 'ROOM',
          aId: a.id,
          bId: b.id,
          resource: a.room,
          day: a.day,
          detail: `${a.room} (${fmtTime(a.start)}-${fmtTime(a.end)} vs ${fmtTime(b.start)}-${fmtTime(b.end)})`,
          aName: `${a.namaMk} (${a.kelasRaw})`,
          bName: `${b.namaMk} (${b.kelasRaw})`,
        });
      }
      if (a.dosen && a.dosen === b.dosen) {
        lecturerConflicts.push({
          type: 'LECTURER',
          aId: a.id,
          bId: b.id,
          resource: a.dosen,
          day: a.day,
          detail: `${a.dosen} (${fmtTime(a.start)}-${fmtTime(a.end)})`,
          aName: `${a.namaMk} (${a.room})`,
          bName: `${b.namaMk} (${b.room})`,
        });
      }
      if (sharesClass(a.classes, b.classes)) {
        const ea = expandEffectiveClasses(a.classes);
        const eb = expandEffectiveClasses(b.classes);
        const shared = ea.filter((c) => eb.includes(c));
        classConflicts.push({
          type: 'CLASS',
          aId: a.id,
          bId: b.id,
          resource: shared.join(', '),
          day: a.day,
          detail: `${shared.join(', ')} (${fmtTime(a.start)}-${fmtTime(a.end)} vs ${fmtTime(b.start)}-${fmtTime(b.end)})`,
          aName: `${a.namaMk} (${a.room})`,
          bName: `${b.namaMk} (${b.room})`,
        });
      }
    }
  }

  // Wet-lab Asprak check
  const asprakDetails: AsprakDetail[] = [];
  for (const ws of sessions.filter((s) => s.isWetLab)) {
    const seniors = getSeniorCohortClasses(ws, cohortMap);
    if (seniors.length === 0) {
      asprakDetails.push({
        sessionId: ws.id,
        prodi: ws.prodi,
        namaMk: ws.namaMk,
        kelasRaw: ws.kelasRaw,
        day: ws.day,
        time: `${fmtTime(ws.start)}-${fmtTime(ws.end)}`,
        room: ws.room,
        seniors: [],
        busySeniors: [],
        freeSeniors: [],
        status: 'NO_SENIOR_COHORT',
      });
      continue;
    }
    const busySet = new Set<string>();
    for (const other of sessions) {
      if (other.id === ws.id) continue;
      if (!overlaps(ws.day, ws.start, ws.end, other.day, other.start, other.end)) continue;
      for (const c of expandEffectiveClasses(other.classes)) {
        if (seniors.includes(c)) busySet.add(c);
      }
    }
    const busySeniors = seniors.filter((c) => busySet.has(c));
    const freeSeniors = seniors.filter((c) => !busySet.has(c));
    const detail: AsprakDetail = {
      sessionId: ws.id,
      prodi: ws.prodi,
      namaMk: ws.namaMk,
      kelasRaw: ws.kelasRaw,
      day: ws.day,
      time: `${fmtTime(ws.start)}-${fmtTime(ws.end)}`,
      room: ws.room,
      seniors,
      busySeniors,
      freeSeniors,
      status: freeSeniors.length === 0 ? 'DEADLOCK' : busySeniors.length > 0 ? 'PARTIAL' : 'CLEAR',
    };
    asprakDetails.push(detail);
    if (detail.status === 'DEADLOCK') asprakDeadlocks.push(detail);
    else if (detail.status === 'PARTIAL') asprakPartial.push(detail);
  }

  // Class & Lecturer ergonomic audits
  const classDaysMap = new Map<string, Map<DayName, Session[]>>();
  const lecDaysMap = new Map<string, Map<DayName, Session[]>>();
  for (const s of sessions) {
    for (const c of s.classes) {
      if (!classDaysMap.has(c)) classDaysMap.set(c, new Map());
      const dm = classDaysMap.get(c)!;
      if (!dm.has(s.day)) dm.set(s.day, []);
      dm.get(s.day)!.push(s);
    }
    if (s.dosen) {
      if (!lecDaysMap.has(s.dosen)) lecDaysMap.set(s.dosen, new Map());
      const dm = lecDaysMap.get(s.dosen)!;
      if (!dm.has(s.day)) dm.set(s.day, []);
      dm.get(s.day)!.push(s);
    }
  }

  const daySpreadHist: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const classSummary: ClassAuditRow[] = [];
  let classLongGaps = 0;
  let classTotalGapMin = 0;
  let contiguousClassCount = 0;
  let totalHoleDays = 0;
  let marathonDayCount = 0;
  let isolatedDayCount = 0;
  let buildingSwitchCount = 0;

  for (const [cls, dm] of classDaysMap.entries()) {
    const activeDays = dm.size;
    daySpreadHist[activeDays] = (daySpreadHist[activeDays] || 0) + 1;
    const daysSorted = Array.from(dm.keys()).sort((a, b) => DAY_INDEX[a] - DAY_INDEX[b]);
    const daySpan =
      daysSorted.length > 0
        ? DAY_INDEX[daysSorted[daysSorted.length - 1]] - DAY_INDEX[daysSorted[0]] + 1
        : 0;
    const holeDays = Math.max(0, daySpan - activeDays);
    const isContiguous = holeDays === 0;
    if (isContiguous) contiguousClassCount++;
    totalHoleDays += holeDays;

    let clsLong = 0;
    let clsDead = 0;
    let clsGapMin = 0;
    let totalMin = 0;
    let sessCount = 0;
    let earlyCnt = 0;
    let marathons = 0;
    let isolated = 0;

    let totalClassSessions = 0;
    for (const list of dm.values()) totalClassSessions += list.length;

    for (const list of dm.values()) {
      list.sort((a, b) => a.start - b.start);
      sessCount += list.length;
      // Count EVERY 1-course day whenever this class has >= 2 total courses in the week!
      if (totalClassSessions >= 2 && list.length === 1) {
        isolated++;
        isolatedDayCount++;
      }

      let continuousMin = 0;
      let continuousCount = 0;
      let dayHasMarathon = false;
      for (let k = 0; k < list.length; k++) {
        const cur = list[k];
        totalMin += cur.duration;
        if (cur.start < minStart) earlyCnt++;
        if (k === 0) {
          continuousMin = cur.duration;
          continuousCount = 1;
        } else {
          const prev = list[k - 1];
          const rawGap = cur.start - prev.end;
          const dead = effectiveDeadGap(prev.end, cur.start, cur.day, Boolean(policy.protectFridayPrayer || policy.hardFridayPrayer));
          if (dead > 0) {
            clsGapMin += dead;
            classTotalGapMin += dead;
            if (dead >= 100) {
              clsDead++;
              clsLong++;
              classLongGaps++;
            }
          }
          if (rawGap === 0 && buildingGroup(prev.room) !== buildingGroup(cur.room)) {
            buildingSwitchCount++;
          }
          if (rawGap < 40) {
            continuousMin += cur.duration;
            continuousCount++;
          } else {
            continuousMin = cur.duration;
            continuousCount = 1;
          }
          if (continuousCount >= 2 && continuousMin > 300) dayHasMarathon = true;
        }
      }
      if (dayHasMarathon) {
        marathons++;
        marathonDayCount++;
      }
    }

    classSummary.push({
      className: cls,
      activeDays,
      daySpan,
      holeDays,
      isContiguous,
      days: daysSorted,
      sessions: sessCount,
      totalMin,
      longGaps: clsLong,
      deadGaps: clsDead,
      totalGapMin: clsGapMin,
      earlyBefore0840: earlyCnt,
      marathonDays: marathons,
      isolatedDays: isolated,
      isCompact: activeDays <= policy.maxDaysPerClass && isContiguous,
    });
  }
  classSummary.sort((a, b) => a.className.localeCompare(b.className));

  let lecturerLongGaps = 0;
  let lecturerTotalGapMin = 0;
  let lecturerIsolatedDayCount = 0;
  const lecturerSummary: LecturerAuditRow[] = [];
  for (const [lec, dm] of lecDaysMap.entries()) {
    const daysSorted = Array.from(dm.keys()).sort((a, b) => DAY_INDEX[a] - DAY_INDEX[b]);
    const daySpan =
      daysSorted.length > 0
        ? DAY_INDEX[daysSorted[daysSorted.length - 1]] - DAY_INDEX[daysSorted[0]] + 1
        : 0;
    let lLong = 0;
    let lGapMin = 0;
    let totalMin = 0;
    let sessCount = 0;
    let pinnedCount = 0;
    let earlyCnt = 0;
    let lecIsolated = 0;
    let totalLecSess = 0;
    for (const list of dm.values()) totalLecSess += list.length;

    for (const list of dm.values()) {
      list.sort((a, b) => a.start - b.start);
      sessCount += list.length;
      if (totalLecSess >= 2 && list.length === 1) {
        lecIsolated++;
        lecturerIsolatedDayCount++;
      }
      for (let k = 0; k < list.length; k++) {
        totalMin += list[k].duration;
        if (list[k].pinned) pinnedCount++;
        if (list[k].start < minStart) earlyCnt++;
        if (k > 0) {
          const dead = effectiveDeadGap(list[k - 1].end, list[k].start, list[k].day, Boolean(policy.protectFridayPrayer || policy.hardFridayPrayer));
          if (dead > 0) {
            lGapMin += dead;
            lecturerTotalGapMin += dead;
            if (dead >= 100) {
              lLong++;
              lecturerLongGaps++;
            }
          }
        }
      }
    }
    lecturerSummary.push({
      lecturer: lec,
      activeDays: dm.size,
      daySpan,
      isContiguous: daySpan - dm.size === 0,
      sessions: sessCount,
      totalMin,
      longGaps: lLong,
      totalGapMin: lGapMin,
      earlyBefore0840: earlyCnt,
      isolatedDays: lecIsolated,
      pinnedCount,
    });
  }
  lecturerSummary.sort((a, b) => b.totalMin - a.totalMin);

  const totalClasses = classDaysMap.size;
  const classesWithin3Days = classSummary.filter((c) => c.activeDays <= 3).length;
  const hardConflicts = [...roomConflicts, ...lecturerConflicts, ...classConflicts];

  const dayLoad: Record<DayName, number> = { Senin: 0, Selasa: 0, Rabu: 0, Kamis: 0, Jumat: 0 };
  const pascaByDay: Record<DayName, number> = { Senin: 0, Selasa: 0, Rabu: 0, Kamis: 0, Jumat: 0 };
  for (const s of sessions) {
    dayLoad[s.day] = (dayLoad[s.day] || 0) + 1;
    if (isPascaRoom(s.room)) pascaByDay[s.day] = (pascaByDay[s.day] || 0) + 1;
  }

  const compactClassPct = totalClasses ? Number(((classesWithin3Days / totalClasses) * 100).toFixed(1)) : 0;
  const contiguousClassPct = totalClasses
    ? Number(((contiguousClassCount / totalClasses) * 100).toFixed(1))
    : 0;
  const humaneStartPct = sessions.length
    ? Number((((sessions.length - earlyBefore0840Count) / sessions.length) * 100).toFixed(1))
    : 0;

  // Composite Humane Index (0-100): transparent multi-dimensional quality score
  // Weights: 25% Start >=08:40 | 25% Contiguous Days | 20% <=3 Days | 15% Dead-Gap Free | 15% Compliance & Anti-Burnout
  const compactCeiling = Math.max(1, classSummary.filter((c) => c.totalMin <= 1420).length);
  const gapNormRef = Math.max(1, Math.round(totalClasses * 1.8));
  const startScore = (sessions.length ? (sessions.length - earlyBefore0840Count - earlyBefore0750Count * 0.5) / sessions.length : 1) * 25;
  const contigScore = (totalClasses ? contiguousClassCount / totalClasses : 1) * 25;
  const compactScore = (totalClasses ? Math.min(1, classesWithin3Days / compactCeiling) : 1) * 20;
  const gapScore = Math.max(0, 1 - (classLongGaps + lecturerLongGaps) / gapNormRef) * 15;
  const compliancePenalty =
    hardConflicts.length * 4 +
    pascaViolations.length * 0.5 +
    asprakDeadlocks.length * 2.5 +
    asprakPartial.length * 0.25 +
    ishomaViolations.length * 1.5 +
    marathonDayCount * 0.8 +
    isolatedDayCount * 0.6;
  const complianceScore = Math.max(0, 15 - compliancePenalty);
  const rawHumaneScore = Number(
    Math.max(0, Math.min(100, startScore + contigScore + compactScore + gapScore + complianceScore)).toFixed(1)
  );
  const hardFeasible =
    hardConflicts.length === 0 &&
    pascaViolations.length === 0 &&
    asprakDeadlocks.length === 0 &&
    (!policy.hardFridayPrayer || fridayPrayerViolationCount === 0);
  const gatedHumaneScore = hardFeasible ? rawHumaneScore : 0;
  const balancedScore03 = hardFeasible
    ? Number(Math.max(0, rawHumaneScore - 0.3 * lecturerIsolatedDayCount).toFixed(1))
    : 0;
  const balancedScore06 = hardFeasible
    ? Number(Math.max(0, rawHumaneScore - 0.6 * lecturerIsolatedDayCount).toFixed(1))
    : 0;
  const humaneScore = rawHumaneScore;
  const asprakClearCount = asprakDetails.filter((d) => d.status === 'CLEAR').length;

  return {
    totalSessions: sessions.length,
    totalClasses,
    totalLecturers: lecDaysMap.size,
    hardConflictCount: hardConflicts.length,
    roomConflictCount: roomConflicts.length,
    lecturerConflictCount: lecturerConflicts.length,
    classConflictCount: classConflicts.length,
    hardConflicts,
    pascaViolationCount: pascaViolations.length,
    pascaViolations,
    asprakDeadlockCount: asprakDeadlocks.length,
    asprakPartialCount: asprakPartial.length,
    asprakClearCount,
    asprakDeadlocks,
    asprakDetails,
    ishomaViolationCount: ishomaViolations.length,
    ishomaViolations,
    lateSessionCount,
    classesWithin3Days,
    compactClassPct,
    contiguousClassCount,
    contiguousClassPct,
    totalHoleDays,
    earlyBefore0840Count,
    earlyBefore0750Count,
    humaneStartPct,
    marathonDayCount,
    isolatedDayCount,
    lecturerIsolatedDayCount,
    buildingSwitchCount,
    humaneScore,
    hardFeasible,
    rawHumaneScore,
    gatedHumaneScore,
    balancedScore03,
    balancedScore06,
    fridayPrayerViolationCount,
    daySpreadHist,
    classLongGaps,
    classTotalGapMin,
    lecturerLongGaps,
    lecturerTotalGapMin,
    dayLoad,
    pascaByDay,
    pinnedCount: sessions.filter((s) => s.pinned).length,
    classSummary,
    lecturerSummary,
  };
}
