/**
 * O(1) 160-bit Exact 5-Minute Bitmask Schedule Occupancy Index
 * Discretizes 07:00-20:00 (780 min) into 156 five-minute ticks stored in 5 x 32-bit integers
 * per (entity, day). Handles exact 5-minute sessions (e.g. S192 12:35-15:25) and late
 * evening sessions (e.g. S204 16:20-19:10) with ZERO rounding error.
 *
 * Also models:
 *   - Parent-cohort coupling (e.g., "Praktikum Informatika 3A/3B" <-> "Informatika 3A",
 *     "Praktikum Sains Data 3A" <-> "Sains Data 3A", "Praktikum Sains Data 3B" <-> "Sains Data 3B")
 *   - Bidirectional O(1) Wet-Lab Asprak verification (DEADLOCK = 0 free seniors; PARTIAL = some busy; CLEAR = all free)
 */
import type { DayName, Session } from './types';

export const DAYS: DayName[] = ['Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat'];
export const DAY_INDEX: Record<DayName, number> = {
  Senin: 0,
  Selasa: 1,
  Rabu: 2,
  Kamis: 3,
  Jumat: 4,
};

const TICK_BASE = 420; // 07:00
const TICK_STEP = 5;   // 5-minute exact resolution (covers 12:35-15:25 and 16:20-19:10 exactly!)
const WORDS = 5;       // 5 * 32 = 160 bits = 800 min (07:00 - 20:20)

export interface SlotMask {
  w0: number;
  w1: number;
  w2: number;
  w3: number;
  w4: number;
}

export function makeSlotMask(start: number, end: number): SlotMask {
  const t0 = Math.max(0, Math.floor((start - TICK_BASE) / TICK_STEP));
  const t1 = Math.min(WORDS * 32, Math.ceil((end - TICK_BASE) / TICK_STEP));
  let w0 = 0;
  let w1 = 0;
  let w2 = 0;
  let w3 = 0;
  let w4 = 0;
  for (let t = t0; t < t1; t++) {
    if (t < 32) w0 |= 1 << t;
    else if (t < 64) w1 |= 1 << (t - 32);
    else if (t < 96) w2 |= 1 << (t - 64);
    else if (t < 128) w3 |= 1 << (t - 96);
    else w4 |= 1 << (t - 128);
  }
  return { w0, w1, w2, w3, w4 };
}

/**
 * Expand atomic class list with any parent cohort linked to a "Praktikum ..." sub-section,
 * so a student in "Sains Data 3A" can NEVER be double-booked into "Praktikum Sains Data 3A"
 * simultaneously (and "Informatika 3A" never overlaps "Praktikum Informatika 3A/3B").
 */
export function expandEffectiveClasses(classes: string[], knownClassSet?: Set<string>): string[] {
  const out = new Set<string>(classes);
  for (const c of classes) {
    if (!/^Praktikum\s+/i.test(c)) continue;
    const stripped = c.replace(/^Praktikum\s+/i, '').trim();
    if (!knownClassSet || knownClassSet.has(stripped)) {
      out.add(stripped);
    } else if (/^Informatika\s+3B$/i.test(stripped)) {
      // Informatika 3 only has 1 theory cohort ("Informatika 3A") split into Praktikum 3A & 3B
      out.add('Informatika 3A');
    }
  }
  return Array.from(out);
}

export class BitmaskIndex {
  // Flat Uint32Array per entity group: offset = (entityId * 5 + dayIdx) * WORDS
  private roomBits: Uint32Array;
  private lecBits: Uint32Array;
  private clsBits: Uint32Array;

  public readonly roomToId = new Map<string, number>();
  public readonly lecToId = new Map<string, number>();
  public readonly clsToId = new Map<string, number>();

  public readonly sessionRoomId: Int32Array;
  public readonly sessionLecId: Int32Array;
  public readonly sessionClsIds: number[][];         // Direct atomic classes (for day compactness & gaps)
  public readonly sessionConflictClsIds: number[][]; // Expanded classes incl. parent cohort (for hard clash guard!)
  public readonly sessionDayIdx: Int32Array;
  public readonly sessionStart: Int32Array;
  public readonly sessionEnd: Int32Array;
  public readonly sessionMaskW0: Uint32Array;
  public readonly sessionMaskW1: Uint32Array;
  public readonly sessionMaskW2: Uint32Array;
  public readonly sessionMaskW3: Uint32Array;
  public readonly sessionMaskW4: Uint32Array;

  // Wet-lab session indices & their senior cohort class IDs for O(1) Asprak checks
  public readonly wetLabIndices: number[] = [];
  public readonly seniorClsIdsBySession: number[][];
  public readonly dependentWetLabsByCls: number[][];
  public hardFridayPrayer = false;
  private readonly fridayPrayerMask: SlotMask = makeSlotMask(690, 780);

  constructor(sessions: Session[], roomNames: string[]) {
    roomNames.forEach((r, i) => this.roomToId.set(r, i));
    let rNext = roomNames.length;
    let lNext = 0;
    let cNext = 0;

    const knownClasses = new Set<string>();
    for (const s of sessions) {
      for (const c of s.classes) knownClasses.add(c);
    }

    for (const s of sessions) {
      if (!this.roomToId.has(s.room)) this.roomToId.set(s.room, rNext++);
      if (s.originalRoom && !this.roomToId.has(s.originalRoom)) this.roomToId.set(s.originalRoom, rNext++);
      if (s.dosen && !this.lecToId.has(s.dosen)) this.lecToId.set(s.dosen, lNext++);
      for (const c of expandEffectiveClasses(s.classes, knownClasses)) {
        if (!this.clsToId.has(c)) this.clsToId.set(c, cNext++);
      }
    }

    this.roomBits = new Uint32Array(rNext * 5 * WORDS);
    this.lecBits = new Uint32Array(Math.max(lNext, 1) * 5 * WORDS);
    this.clsBits = new Uint32Array(Math.max(cNext, 1) * 5 * WORDS);

    const n = sessions.length;
    this.sessionRoomId = new Int32Array(n).fill(-1);
    this.sessionLecId = new Int32Array(n).fill(-1);
    this.sessionClsIds = new Array(n);
    this.sessionConflictClsIds = new Array(n);
    this.sessionDayIdx = new Int32Array(n).fill(-1);
    this.sessionStart = new Int32Array(n);
    this.sessionEnd = new Int32Array(n);
    this.sessionMaskW0 = new Uint32Array(n);
    this.sessionMaskW1 = new Uint32Array(n);
    this.sessionMaskW2 = new Uint32Array(n);
    this.sessionMaskW3 = new Uint32Array(n);
    this.sessionMaskW4 = new Uint32Array(n);

    // Build cohort map for Asprak wet-lab O(1) verification
    const cohortMap = new Map<string, number[]>();
    for (const [clsName, cid] of this.clsToId.entries()) {
      if (/^Praktikum\s+/i.test(clsName)) continue;
      const m = clsName.match(/^(.+?)\s+(\d)[A-Z]$/);
      if (!m) continue;
      const key = `${m[1].trim()}|${m[2]}`;
      const arr = cohortMap.get(key) || [];
      arr.push(cid);
      cohortMap.set(key, arr);
    }

    this.seniorClsIdsBySession = new Array(n);
    this.dependentWetLabsByCls = Array.from({ length: Math.max(cNext, 1) }, () => []);

    for (let i = 0; i < n; i++) {
      const s = sessions[i];
      this.sessionLecId[i] = s.dosen ? (this.lecToId.get(s.dosen) ?? -1) : -1;
      this.sessionClsIds[i] = s.classes.map((c) => this.clsToId.get(c)!);
      this.sessionConflictClsIds[i] = expandEffectiveClasses(s.classes, knownClasses).map(
        (c) => this.clsToId.get(c)!
      );

      if (s.isWetLab && s.semester) {
        this.wetLabIndices.push(i);
        const key = `${s.prodiPrefix}|${s.semester + 2}`;
        const seniors = cohortMap.get(key) || [];
        this.seniorClsIdsBySession[i] = seniors;
        for (const scid of seniors) {
          this.dependentWetLabsByCls[scid].push(i);
        }
      } else {
        this.seniorClsIdsBySession[i] = [];
      }
    }
  }

  private overlapsWords(buf: Uint32Array, off: number, m: SlotMask): boolean {
    return (
      (buf[off] & m.w0) !== 0 ||
      (buf[off + 1] & m.w1) !== 0 ||
      (buf[off + 2] & m.w2) !== 0 ||
      (buf[off + 3] & m.w3) !== 0 ||
      (buf[off + 4] & m.w4) !== 0
    );
  }

  public place(idx: number, dayIdx: number, start: number, end: number, roomId: number): void {
    if (this.sessionDayIdx[idx] >= 0) this.unplace(idx);
    const mask = makeSlotMask(start, end);
    this.sessionDayIdx[idx] = dayIdx;
    this.sessionStart[idx] = start;
    this.sessionEnd[idx] = end;
    this.sessionRoomId[idx] = roomId;
    this.sessionMaskW0[idx] = mask.w0;
    this.sessionMaskW1[idx] = mask.w1;
    this.sessionMaskW2[idx] = mask.w2;
    this.sessionMaskW3[idx] = mask.w3;
    this.sessionMaskW4[idx] = mask.w4;

    const rOff = (roomId * 5 + dayIdx) * WORDS;
    this.roomBits[rOff] |= mask.w0;
    this.roomBits[rOff + 1] |= mask.w1;
    this.roomBits[rOff + 2] |= mask.w2;
    this.roomBits[rOff + 3] |= mask.w3;
    this.roomBits[rOff + 4] |= mask.w4;

    const lid = this.sessionLecId[idx];
    if (lid >= 0) {
      const lOff = (lid * 5 + dayIdx) * WORDS;
      this.lecBits[lOff] |= mask.w0;
      this.lecBits[lOff + 1] |= mask.w1;
      this.lecBits[lOff + 2] |= mask.w2;
      this.lecBits[lOff + 3] |= mask.w3;
      this.lecBits[lOff + 4] |= mask.w4;
    }

    const cids = this.sessionConflictClsIds[idx];
    for (let k = 0; k < cids.length; k++) {
      const cOff = (cids[k] * 5 + dayIdx) * WORDS;
      this.clsBits[cOff] |= mask.w0;
      this.clsBits[cOff + 1] |= mask.w1;
      this.clsBits[cOff + 2] |= mask.w2;
      this.clsBits[cOff + 3] |= mask.w3;
      this.clsBits[cOff + 4] |= mask.w4;
    }
  }

  public unplace(idx: number): void {
    const dayIdx = this.sessionDayIdx[idx];
    if (dayIdx < 0) return;
    const roomId = this.sessionRoomId[idx];
    const w0 = ~this.sessionMaskW0[idx];
    const w1 = ~this.sessionMaskW1[idx];
    const w2 = ~this.sessionMaskW2[idx];
    const w3 = ~this.sessionMaskW3[idx];
    const w4 = ~this.sessionMaskW4[idx];

    const rOff = (roomId * 5 + dayIdx) * WORDS;
    this.roomBits[rOff] &= w0;
    this.roomBits[rOff + 1] &= w1;
    this.roomBits[rOff + 2] &= w2;
    this.roomBits[rOff + 3] &= w3;
    this.roomBits[rOff + 4] &= w4;

    const lid = this.sessionLecId[idx];
    if (lid >= 0) {
      const lOff = (lid * 5 + dayIdx) * WORDS;
      this.lecBits[lOff] &= w0;
      this.lecBits[lOff + 1] &= w1;
      this.lecBits[lOff + 2] &= w2;
      this.lecBits[lOff + 3] &= w3;
      this.lecBits[lOff + 4] &= w4;
    }

    const cids = this.sessionConflictClsIds[idx];
    for (let k = 0; k < cids.length; k++) {
      const cOff = (cids[k] * 5 + dayIdx) * WORDS;
      this.clsBits[cOff] &= w0;
      this.clsBits[cOff + 1] &= w1;
      this.clsBits[cOff + 2] &= w2;
      this.clsBits[cOff + 3] &= w3;
      this.clsBits[cOff + 4] &= w4;
    }

    this.sessionDayIdx[idx] = -1;
    this.sessionRoomId[idx] = -1;
  }

  /**
   * O(1) Hard Conflict + Bidirectional Asprak Check (assumes session `idx` is currently unplaced!)
   */
  public canPlaceHard(
    idx: number,
    dayIdx: number,
    roomId: number,
    mask: SlotMask,
    enforceAsprak: boolean
  ): boolean {
    if (
      this.hardFridayPrayer &&
      dayIdx === 4 &&
      ((mask.w0 & this.fridayPrayerMask.w0) !== 0 ||
        (mask.w1 & this.fridayPrayerMask.w1) !== 0 ||
        (mask.w2 & this.fridayPrayerMask.w2) !== 0 ||
        (mask.w3 & this.fridayPrayerMask.w3) !== 0 ||
        (mask.w4 & this.fridayPrayerMask.w4) !== 0)
    ) {
      return false;
    }

    if (this.overlapsWords(this.roomBits, (roomId * 5 + dayIdx) * WORDS, mask)) return false;

    const lid = this.sessionLecId[idx];
    if (lid >= 0 && this.overlapsWords(this.lecBits, (lid * 5 + dayIdx) * WORDS, mask)) return false;

    const cids = this.sessionConflictClsIds[idx];
    for (let k = 0; k < cids.length; k++) {
      if (this.overlapsWords(this.clsBits, (cids[k] * 5 + dayIdx) * WORDS, mask)) return false;
    }

    if (enforceAsprak) {
      // Direction 1: if idx is a wet lab, at least ONE senior class must be 100% free during mask!
      const seniors = this.seniorClsIdsBySession[idx];
      if (seniors.length > 0) {
        let freeFound = false;
        for (let k = 0; k < seniors.length; k++) {
          if (!this.overlapsWords(this.clsBits, (seniors[k] * 5 + dayIdx) * WORDS, mask)) {
            freeFound = true;
            break;
          }
        }
        if (!freeFound) return false;
      }

      // Direction 2: if idx belongs to a senior cohort, ensure no placed wet-lab becomes deadlocked!
      for (let k = 0; k < cids.length; k++) {
        const cid = cids[k];
        const deps = this.dependentWetLabsByCls[cid];
        for (let d = 0; d < deps.length; d++) {
          const wsIdx = deps[d];
          if (this.sessionDayIdx[wsIdx] !== dayIdx) continue;
          const wsW0 = this.sessionMaskW0[wsIdx];
          const wsW1 = this.sessionMaskW1[wsIdx];
          const wsW2 = this.sessionMaskW2[wsIdx];
          const wsW3 = this.sessionMaskW3[wsIdx];
          const wsW4 = this.sessionMaskW4[wsIdx];

          if (
            (mask.w0 & wsW0) === 0 &&
            (mask.w1 & wsW1) === 0 &&
            (mask.w2 & wsW2) === 0 &&
            (mask.w3 & wsW3) === 0 &&
            (mask.w4 & wsW4) === 0
          ) {
            continue;
          }
          const wsSeniors = this.seniorClsIdsBySession[wsIdx];
          let otherFree = false;
          for (let s = 0; s < wsSeniors.length; s++) {
            const scid = wsSeniors[s];
            if (cids.includes(scid)) continue;
            const sOff = (scid * 5 + dayIdx) * WORDS;
            if (
              (this.clsBits[sOff] & wsW0) === 0 &&
              (this.clsBits[sOff + 1] & wsW1) === 0 &&
              (this.clsBits[sOff + 2] & wsW2) === 0 &&
              (this.clsBits[sOff + 3] & wsW3) === 0 &&
              (this.clsBits[sOff + 4] & wsW4) === 0
            ) {
              otherFree = true;
              break;
            }
          }
          if (!otherFree) return false;
        }
      }
    }

    return true;
  }

  /**
   * Fast O(32) count of wet-lab Asprak deadlocks, partial overlaps, and exact overlapping
   * 5-minute ticks (for smooth multi-senior gradient guidance toward 0 partials!).
   */
  public countAsprakIssues(): { deadlocks: number; partials: number; overlapTicks: number } {
    let deadlocks = 0;
    let partials = 0;
    let overlapTicks = 0;
    for (let i = 0; i < this.wetLabIndices.length; i++) {
      const wsIdx = this.wetLabIndices[i];
      const dayIdx = this.sessionDayIdx[wsIdx];
      if (dayIdx < 0) continue;
      const seniors = this.seniorClsIdsBySession[wsIdx];
      if (seniors.length === 0) continue;

      const wsW0 = this.sessionMaskW0[wsIdx];
      const wsW1 = this.sessionMaskW1[wsIdx];
      const wsW2 = this.sessionMaskW2[wsIdx];
      const wsW3 = this.sessionMaskW3[wsIdx];
      const wsW4 = this.sessionMaskW4[wsIdx];

      let busyCount = 0;
      for (let k = 0; k < seniors.length; k++) {
        const sOff = (seniors[k] * 5 + dayIdx) * WORDS;
        const m0 = this.clsBits[sOff] & wsW0;
        const m1 = this.clsBits[sOff + 1] & wsW1;
        const m2 = this.clsBits[sOff + 2] & wsW2;
        const m3 = this.clsBits[sOff + 3] & wsW3;
        const m4 = this.clsBits[sOff + 4] & wsW4;
        if ((m0 | m1 | m2 | m3 | m4) !== 0) {
          busyCount++;
          // Inline SWAR popcount across 5 words -> exact overlapping 5-min ticks
          let v: number;
          if (m0) { v = m0 - ((m0 >>> 1) & 0x55555555); v = (v & 0x33333333) + ((v >>> 2) & 0x33333333); overlapTicks += (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24; }
          if (m1) { v = m1 - ((m1 >>> 1) & 0x55555555); v = (v & 0x33333333) + ((v >>> 2) & 0x33333333); overlapTicks += (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24; }
          if (m2) { v = m2 - ((m2 >>> 1) & 0x55555555); v = (v & 0x33333333) + ((v >>> 2) & 0x33333333); overlapTicks += (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24; }
          if (m3) { v = m3 - ((m3 >>> 1) & 0x55555555); v = (v & 0x33333333) + ((v >>> 2) & 0x33333333); overlapTicks += (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24; }
          if (m4) { v = m4 - ((m4 >>> 1) & 0x55555555); v = (v & 0x33333333) + ((v >>> 2) & 0x33333333); overlapTicks += (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24; }
        }
      }
      if (busyCount >= seniors.length) deadlocks++;
      else if (busyCount > 0) partials++;
    }
    return { deadlocks, partials, overlapTicks };
  }

  /**
   * Find indices of all currently placed sessions that conflict with placing `idx` at (dayIdx, roomId, mask).
   */
  public findBlockers(idx: number, dayIdx: number, roomId: number, mask: SlotMask): number[] {
    const out: number[] = [];
    const lid = this.sessionLecId[idx];
    const cids = this.sessionConflictClsIds[idx];
    const n = this.sessionDayIdx.length;

    for (let j = 0; j < n; j++) {
      if (j === idx || this.sessionDayIdx[j] !== dayIdx) continue;
      if (
        (this.sessionMaskW0[j] & mask.w0) === 0 &&
        (this.sessionMaskW1[j] & mask.w1) === 0 &&
        (this.sessionMaskW2[j] & mask.w2) === 0 &&
        (this.sessionMaskW3[j] & mask.w3) === 0 &&
        (this.sessionMaskW4[j] & mask.w4) === 0
      ) {
        continue;
      }
      if (this.sessionRoomId[j] === roomId) {
        out.push(j);
        continue;
      }
      if (lid >= 0 && this.sessionLecId[j] === lid) {
        out.push(j);
        continue;
      }
      const oc = this.sessionConflictClsIds[j];
      let shared = false;
      for (let a = 0; a < cids.length && !shared; a++) {
        for (let b = 0; b < oc.length; b++) {
          if (cids[a] === oc[b]) {
            shared = true;
            break;
          }
        }
      }
      if (shared) out.push(j);
    }
    return out;
  }

  /**
   * Find senior-cohort sessions overlapping a specific wet-lab session (for Asprak clearance moves!)
   */
  public findSeniorOverlapsForWetLab(wsIdx: number): number[] {
    const dayIdx = this.sessionDayIdx[wsIdx];
    if (dayIdx < 0) return [];
    const seniors = this.seniorClsIdsBySession[wsIdx];
    if (seniors.length === 0) return [];
    const wsW0 = this.sessionMaskW0[wsIdx];
    const wsW1 = this.sessionMaskW1[wsIdx];
    const wsW2 = this.sessionMaskW2[wsIdx];
    const wsW3 = this.sessionMaskW3[wsIdx];
    const wsW4 = this.sessionMaskW4[wsIdx];
    const out: number[] = [];
    const n = this.sessionDayIdx.length;

    for (let j = 0; j < n; j++) {
      if (j === wsIdx || this.sessionDayIdx[j] !== dayIdx) continue;
      if (
        (this.sessionMaskW0[j] & wsW0) === 0 &&
        (this.sessionMaskW1[j] & wsW1) === 0 &&
        (this.sessionMaskW2[j] & wsW2) === 0 &&
        (this.sessionMaskW3[j] & wsW3) === 0 &&
        (this.sessionMaskW4[j] & wsW4) === 0
      ) {
        continue;
      }
      const oc = this.sessionConflictClsIds[j];
      if (oc.some((c) => seniors.includes(c))) {
        out.push(j);
      }
    }
    return out;
  }
}
