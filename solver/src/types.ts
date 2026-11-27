export type DayName = 'Senin' | 'Selasa' | 'Rabu' | 'Kamis' | 'Jumat';
export type RoomType = 'PASCA' | 'SAINTEK' | 'WET_LAB' | 'DRY_LAB' | 'OTHER_LAB';

export interface RoomInfo {
  name: string;
  type: RoomType;
  allowedDays: DayName[];
  activeInBaseline?: boolean;
  baselineSessions?: number;
}

export interface Session {
  id: string;
  prodi: string;
  prodiName: string;
  kodeJadwal: string;
  kodeMk: string;
  namaMk: string;
  sks: number;
  kelasRaw: string;
  classes: string[];
  semester: number | null;
  prodiPrefix: string;
  dosen: string;
  day: DayName;
  start: number;
  end: number;
  duration: number;
  room: string;
  originalRoom: string;
  originalDay: DayName;
  originalStart: number;
  roomType: RoomType;
  isPraktikum: boolean;
  isWetLab: boolean;
  isExamEligible: boolean;
  kuota: number;
  pinned: boolean;
  pinReason: string;
  openCrossProdi: boolean;
}

export interface SolverPolicy {
  enforcePascaMonWed: boolean;
  enforceAsprakWetLab: boolean;
  protectIshoma: boolean;
  maxDaysPerClass: number;          // Opsi B: 3 days target, graceful fallback 4
  minCoursesPerActiveDay: number;   // Humane minimum: >=2 courses per active day (no 1-course days!)
  enforceContiguousDays: boolean;   // 3-4 consecutive days, no Mon-Wed-Fri gaps
  preferredMinStart: number;        // 520 = 08:40 humane start floor
  allowDryLabOverflow: boolean;     // Allow IF/SD theory to use idle computing labs to hit 100% >=08:40
  preferWorkingHours: boolean;      // Prefer finishing <= 16:20 where capacity allows
  minimizeLongGaps: boolean;        // Eliminate non-ISHOMA dead gaps >= 100-120 min
  preventMarathon: boolean;         // Avoid > 5h continuous back-to-back without break
  protectFridayPrayer?: boolean;    // Extended Friday midday break (11:30-13:00) soft penalty
  hardFridayPrayer?: boolean;       // Hard exclusion of Friday 11:30-13:00 (salat Jumat)
  lecturerIsolatedWeight?: number;  // Symmetric lecturer single-course day weight across SA, Stage-2 MN-LAHC, & Stage-4
}

export interface ConflictRecord {
  type: 'ROOM' | 'LECTURER' | 'CLASS';
  aId: string;
  bId: string;
  resource: string;
  day: DayName;
  detail: string;
  aName: string;
  bName: string;
}

export interface PascaViolation {
  sessionId: string;
  namaMk: string;
  kelasRaw: string;
  day: DayName;
  time: string;
  room: string;
}

export interface AsprakDetail {
  sessionId: string;
  prodi: string;
  namaMk: string;
  kelasRaw: string;
  day: DayName;
  time: string;
  room: string;
  seniors: string[];
  busySeniors: string[];
  freeSeniors: string[];
  status: 'CLEAR' | 'PARTIAL' | 'DEADLOCK' | 'NO_SENIOR_COHORT';
}

export interface ClassAuditRow {
  className: string;
  activeDays: number;
  daySpan: number;
  holeDays: number;
  isContiguous: boolean;
  days: DayName[];
  sessions: number;
  totalMin: number;
  longGaps: number;
  deadGaps: number;
  totalGapMin: number;
  earlyBefore0840: number;
  marathonDays: number;
  isolatedDays: number;
  isCompact: boolean;
}

export interface LecturerAuditRow {
  lecturer: string;
  activeDays: number;
  daySpan: number;
  isContiguous: boolean;
  sessions: number;
  totalMin: number;
  longGaps: number;
  totalGapMin: number;
  earlyBefore0840: number;
  isolatedDays: number;
  pinnedCount: number;
}

export interface ScheduleAudit {
  totalSessions: number;
  totalClasses: number;
  totalLecturers: number;
  hardConflictCount: number;
  roomConflictCount: number;
  lecturerConflictCount: number;
  classConflictCount: number;
  hardConflicts: ConflictRecord[];
  pascaViolationCount: number;
  pascaViolations: PascaViolation[];
  asprakDeadlockCount: number;
  asprakPartialCount: number;
  asprakClearCount: number;
  asprakDeadlocks: AsprakDetail[];
  asprakDetails: AsprakDetail[];
  ishomaViolationCount: number;
  ishomaViolations: Array<{ sessionId: string; namaMk: string; day: DayName; time: string; room: string }>;
  lateSessionCount: number;
  classesWithin3Days: number;
  compactClassPct: number;
  contiguousClassCount: number;
  contiguousClassPct: number;
  totalHoleDays: number;
  earlyBefore0840Count: number;
  earlyBefore0750Count: number;
  humaneStartPct: number;
  marathonDayCount: number;
  isolatedDayCount: number;
  lecturerIsolatedDayCount: number;
  buildingSwitchCount: number;
  humaneScore: number;
  hardFeasible: boolean;
  rawHumaneScore: number;
  gatedHumaneScore: number;
  balancedScore03: number;
  balancedScore06: number;
  fridayPrayerViolationCount: number;
  daySpreadHist: Record<number, number>;
  classLongGaps: number;
  classTotalGapMin: number;
  lecturerLongGaps: number;
  lecturerTotalGapMin: number;
  dayLoad: Record<DayName, number>;
  pascaByDay: Record<DayName, number>;
  pinnedCount: number;
  classSummary: ClassAuditRow[];
  lecturerSummary: LecturerAuditRow[];
}

export interface SessionMove {
  id: string;
  namaMk: string;
  kelasRaw: string;
  role?: string;
  from: { day: DayName; start: number; end: number; room: string };
  to: { day: DayName; start: number; end: number; room: string };
}

export interface SolverHyperparams {
  lahcLength: number;        // LAHC circular fitness list length (25..150, default 65)
  initTemp: number;          // SA initial reheat temperature (15..75, default 42)
  coolingRate: number;       // SA cooling factor per iter (0.9985..0.9998, default 0.9992)
  phase2ARatio: number;      // Fraction of budget for Phase 2A before loneDay hardening (0.42..0.72, default 0.58)
  wDay4: number;             // Penalty weight for 4th active day on <=1420m classes (350..1150, default 460)
  wGapCls: number;           // Penalty weight for student dead gaps >=100m (110..380, default 130)
  wGapLec: number;           // Penalty weight for lecturer dead gaps >=100m (75..320, default 90)
  wAsprakPartial: number;    // Penalty weight for partial wet-lab Asprak overlap (80..340, default 95)
  opScaleSwap: number;       // ALNS initial weight multiplier for Swap/Kempe/Gap ops (0.6..2.2, default 1.0)
  opScaleConsolidate: number;// ALNS initial weight multiplier for Day Consolidation op (0.7..2.4, default 1.3)
  opScaleAsprak: number;     // ALNS initial weight multiplier for Asprak Clear op (0.7..2.4, default 1.25)
}

export interface TpeTrialRecord {
  trialId: number;
  seed: number;
  params: SolverHyperparams;
  humaneScore: number;
  compositeFitness: number;
  feasiblePerfect: boolean;
  hardConflicts: number;
  pascaViolations: number;
  asprakDeadlocks: number;
  asprakClear: number;
  asprakPartial: number;
  earlyBefore0840: number;
  contiguousClassCount: number;
  totalHoleDays: number;
  isolatedDayCount: number;
  lecturerIsolatedDayCount: number;
  classesWithin3Days: number;
  classLongGaps: number;
  lecturerLongGaps: number;
  latencyMs: number;
}

export interface ConstructiveResult {
  sessions: Session[];
  moves: SessionMove[];
  perturbationCount: number;
  latencyMs: number;
  audit: ScheduleAudit;
  metaheuristic: {
    algorithm: string;
    iterations: number;
    acceptedMoves: number;
    improvingMoves: number;
    kempeSwaps: number;
    dayConsolidations: number;
    earlyFixes: number;
    asprakClears: number;
    cbsRestarts: number;
    reheats: number;
    initialEnergy: number;
    finalEnergy: number;
  };
}

export interface CandidateSlot {
  day: DayName;
  start: number;
  end: number;
  room: string;
  status: 'SAFE' | 'REPAIRABLE' | 'FORBIDDEN';
  reason: string;
  blockerCount: number;
  blockerIds?: string[];
  softCost: number;
  isCurrent: boolean;
}

export interface RepairPlan {
  feasible: boolean;
  reason?: string;
  strategy?: 'DIRECT_SAFE' | 'LOCAL_1_STEP' | 'KEMPE_2_STEP';
  perturbationCount?: number;
  totalMoved?: number;
  moves?: SessionMove[];
  sessions?: Session[];
  latencyMs: number;
}
