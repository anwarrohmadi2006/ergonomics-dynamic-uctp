/**
 * Pure TypeScript Optuna-Style TPE (Tree-structured Parzen Estimator) Sampler
 * Based on Bergstra et al. (NeurIPS 2011) & Akiba et al. (Optuna, KDD 2019).
 *
 * Designed for 100% client-side execution inside parallel browser Web Workers
 * (zero server compute, zero Python/Pyodide overhead, ~4 KB compiled).
 */
import type { ScheduleAudit, SolverHyperparams, TpeTrialRecord } from './types';

export const DEFAULT_HYPERPARAMS: SolverHyperparams = {
  lahcLength: 65,
  initTemp: 42,
  coolingRate: 0.9992,
  phase2ARatio: 0.58,
  wDay4: 460,
  wGapCls: 130,
  wGapLec: 90,
  wAsprakPartial: 185,
  opScaleSwap: 1.0,
  opScaleConsolidate: 1.3,
  opScaleAsprak: 1.35,
};

export interface TpeParamSpec {
  key: keyof SolverHyperparams;
  min: number;
  max: number;
  isInt?: boolean;
  decimals?: number;
}

export const TPE_PARAM_SPECS: TpeParamSpec[] = [
  { key: 'lahcLength', min: 30, max: 120, isInt: true },
  { key: 'initTemp', min: 22, max: 62, decimals: 1 },
  { key: 'coolingRate', min: 0.9987, max: 0.99965, decimals: 5 },
  { key: 'phase2ARatio', min: 0.45, max: 0.66, decimals: 3 },
  { key: 'wDay4', min: 400, max: 1120, isInt: true },
  { key: 'wGapCls', min: 110, max: 340, isInt: true },
  { key: 'wGapLec', min: 75, max: 270, isInt: true },
  { key: 'wAsprakPartial', min: 85, max: 380, isInt: true },
  { key: 'opScaleSwap', min: 0.75, max: 1.9, decimals: 2 },
  { key: 'opScaleConsolidate', min: 0.9, max: 2.3, decimals: 2 },
  { key: 'opScaleAsprak', min: 0.9, max: 2.4, decimals: 2 },
];

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

function boxMullerNormal(rng: () => number): number {
  const u1 = Math.max(1e-12, rng());
  const u2 = rng();
  return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
}

/**
 * Strict Lexicographic Objective for TPE Ranking:
 *   - Every hard invariant + 100% >=08:40 + 36/36 contiguous + 0 single-course student days + 0 marathons
 *     must hold to earn the `feasiblePerfect` tier (fitness >= 1000).
 *   - Within the feasiblePerfect tier, TPE directly maximizes `humaneScore` (0..100), with a small
 *     tie-breaker favoring fewer lecturer 1-course days and fewer late sessions.
 */
export function computeTpeFitness(audit: ScheduleAudit): {
  feasiblePerfect: boolean;
  compositeFitness: number;
} {
  const feasiblePerfect =
    audit.hardConflictCount === 0 &&
    audit.pascaViolationCount === 0 &&
    audit.asprakDeadlockCount === 0 &&
    audit.earlyBefore0840Count === 0 &&
    audit.totalHoleDays === 0 &&
    audit.isolatedDayCount === 0 &&
    audit.marathonDayCount === 0;

  if (feasiblePerfect) {
    const compositeFitness = Number(
      (
        1000 +
        audit.humaneScore * 10 -
        (audit.lecturerIsolatedDayCount || 0) * 0.08 -
        audit.lateSessionCount * 0.005
      ).toFixed(4)
    );
    return { feasiblePerfect: true, compositeFitness };
  }

  const penalty =
    audit.hardConflictCount * 500 +
    audit.pascaViolationCount * 150 +
    audit.asprakDeadlockCount * 350 +
    audit.earlyBefore0840Count * 18 +
    audit.totalHoleDays * 95 +
    audit.isolatedDayCount * 55 +
    audit.marathonDayCount * 60;

  return {
    feasiblePerfect: false,
    compositeFitness: Number((audit.humaneScore * 10 - penalty).toFixed(4)),
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function normalize(val: number, spec: TpeParamSpec): number {
  return clamp((val - spec.min) / Math.max(1e-9, spec.max - spec.min), 0, 1);
}

function denormalize(u: number, spec: TpeParamSpec): number {
  const raw = spec.min + clamp(u, 0, 1) * (spec.max - spec.min);
  if (spec.isInt) return Math.round(raw);
  if (spec.decimals !== undefined) {
    const f = 10 ** spec.decimals;
    return Math.round(raw * f) / f;
  }
  return raw;
}

/**
 * Compute 1D Truncated Gaussian Parzen KDE density (with uniform prior weight = 1.0,
 * matching Optuna's `TPESampler(prior_weight=1.0)`).
 */
function parzenLogDensity(x: number, points: number[], bandwidth: number, priorWeight = 1.0): number {
  const n = points.length;
  const inv2s2 = 1 / (2 * bandwidth * bandwidth);
  const normConst = 1 / (Math.sqrt(2 * Math.PI) * bandwidth);
  let sum = priorWeight; // uniform prior on [0, 1] has density 1.0
  for (let i = 0; i < n; i++) {
    const diff = x - points[i];
    sum += normConst * Math.exp(-diff * diff * inv2s2);
  }
  return Math.log(Math.max(1e-15, sum / (n + priorWeight)));
}

function scottBandwidth(points: number[]): number {
  const n = points.length;
  if (n <= 1) return 0.28;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += points[i];
  mean /= n;
  let variance = 0;
  for (let i = 0; i < n; i++) {
    const d = points[i] - mean;
    variance += d * d;
  }
  const sd = Math.sqrt(variance / Math.max(1, n - 1));
  const bw = 1.06 * Math.max(sd, 0.08) * Math.pow(n, -0.2);
  return clamp(bw, 0.065, 0.35);
}

export class TpeSampler {
  public readonly nStartupTrials: number;
  public readonly gamma: number;
  public readonly nEICandidates: number;
  public readonly useCuratedStartup: boolean;
  public readonly trials: TpeTrialRecord[] = [];
  private readonly rng: () => number;
  private nextTrialId = 1;

  // Optional legacy seed anchors only when useCuratedStartup=true
  private readonly anchorSeeds = [27, 486, 73, 66, 77, 108, 42, 55, 11, 33, 88, 99, 19, 37, 47, 7, 22, 67, 83, 101];

  constructor(options: { seed?: number; nStartupTrials?: number; gamma?: number; nEICandidates?: number; useCuratedStartup?: boolean } = {}) {
    this.rng = mulberry32(options.seed ?? 20261122);
    this.nStartupTrials = options.nStartupTrials ?? 8;
    this.gamma = options.gamma ?? 0.25;
    this.nEICandidates = options.nEICandidates ?? 36;
    this.useCuratedStartup = Boolean(options.useCuratedStartup);
  }

  public tell(record: TpeTrialRecord): void {
    this.trials.push(record);
  }

  public getBest(): TpeTrialRecord | null {
    if (this.trials.length === 0) return null;
    let best = this.trials[0];
    for (let i = 1; i < this.trials.length; i++) {
      if (this.trials[i].compositeFitness > best.compositeFitness) {
        best = this.trials[i];
      }
    }
    return best;
  }

  public suggest(): { trialId: number; seed: number; params: SolverHyperparams; phase: 'STARTUP' | 'TPE' } {
    const trialId = this.nextTrialId++;
    const unbiasedSeed = 100 + trialId * 17 + Math.floor(this.rng() * 97);
    const seed = this.useCuratedStartup && trialId <= this.anchorSeeds.length
      ? this.anchorSeeds[trialId - 1]
      : unbiasedSeed;

    if (this.useCuratedStartup) {
      if (trialId === 1) {
        return { trialId, seed: 27, params: { ...DEFAULT_HYPERPARAMS }, phase: 'STARTUP' };
      }
      if (trialId === 2) {
        return {
          trialId,
          seed: 486,
          params: {
            lahcLength: 75,
            initTemp: 38,
            coolingRate: 0.99935,
            phase2ARatio: 0.56,
            wDay4: 720,
            wGapCls: 210,
            wGapLec: 150,
            wAsprakPartial: 240,
            opScaleSwap: 1.35,
            opScaleConsolidate: 1.65,
            opScaleAsprak: 1.75,
          },
          phase: 'STARTUP',
        };
      }
      if (trialId === 3) {
        return {
          trialId,
          seed: 27,
          params: {
            lahcLength: 82,
            initTemp: 36,
            coolingRate: 0.99935,
            phase2ARatio: 0.54,
            wDay4: 860,
            wGapCls: 220,
            wGapLec: 165,
            wAsprakPartial: 280,
            opScaleSwap: 1.25,
            opScaleConsolidate: 1.85,
            opScaleAsprak: 1.9,
          },
          phase: 'STARTUP',
        };
      }
    } else if (trialId === 1) {
      return {
        trialId,
        seed: unbiasedSeed,
        params: { ...DEFAULT_HYPERPARAMS },
        phase: 'STARTUP',
      };
    }

    // Startup exploration phase: uniform random coverage across the 11-D search space
    if (this.trials.length < this.nStartupTrials) {
      const p = { ...DEFAULT_HYPERPARAMS };
      for (const spec of TPE_PARAM_SPECS) {
        (p as Record<string, number>)[spec.key] = denormalize(this.rng(), spec);
      }
      return { trialId, seed, params: p, phase: 'STARTUP' };
    }

    // True TPE Bayesian sampling: split completed observations into good D_l (top gamma) vs bad D_g
    const sorted = this.trials.toSorted((a, b) => b.compositeFitness - a.compositeFitness);
    const nGood = Math.max(3, Math.min(sorted.length - 1, Math.ceil(sorted.length * this.gamma)));
    const goodTrials = sorted.slice(0, nGood);
    const badTrials = sorted.slice(nGood);

    const suggested = { ...DEFAULT_HYPERPARAMS };

    for (const spec of TPE_PARAM_SPECS) {
      const goodPts = goodTrials.map((t) => normalize(t.params[spec.key], spec));
      const badPts = badTrials.map((t) => normalize(t.params[spec.key], spec));
      const bwL = scottBandwidth(goodPts);
      const bwG = scottBandwidth(badPts);

      let bestU = 0.5;
      let bestEI = -Infinity;

      for (let c = 0; c < this.nEICandidates; c++) {
        let u: number;
        if (this.rng() < 0.85) {
          const center = goodPts[Math.floor(this.rng() * goodPts.length)];
          u = clamp(center + boxMullerNormal(this.rng) * bwL, 0, 1);
        } else {
          u = this.rng();
        }
        const logL = parzenLogDensity(u, goodPts, bwL, 1.0);
        const logG = parzenLogDensity(u, badPts, bwG, 1.0);
        const ei = logL - logG;
        if (ei > bestEI) {
          bestEI = ei;
          bestU = u;
        }
      }

      (suggested as Record<string, number>)[spec.key] = denormalize(bestU, spec);
    }

    const chosenSeed =
      this.useCuratedStartup && this.rng() < 0.42
        ? goodTrials[Math.floor(this.rng() * goodTrials.length)].seed
        : unbiasedSeed;

    return { trialId, seed: chosenSeed, params: suggested, phase: 'TPE' };
  }
}
