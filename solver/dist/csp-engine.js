/* Auto-compiled from solver/src/*.ts (H-ALNS-LAHC TypeScript Engine) */
"use strict";
var CSPEngineBundle = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/index.ts
  var index_exports = {};
  __export(index_exports, {
    DAYS: () => DAYS,
    DAY_INDEX: () => DAY_INDEX,
    DEFAULT_HYPERPARAMS: () => DEFAULT_HYPERPARAMS,
    DEFAULT_POLICY: () => DEFAULT_POLICY,
    TPE_PARAM_SPECS: () => TPE_PARAM_SPECS,
    TpeSampler: () => TpeSampler,
    auditSchedule: () => auditSchedule,
    autoFixAllConflicts: () => autoFixAllConflicts,
    cloneSessions: () => cloneSessions,
    computeGlobalHumaneEnergy: () => computeGlobalHumaneEnergy,
    computeTpeFitness: () => computeTpeFitness,
    constructiveReset: () => constructiveReset,
    deepPolishSchedule: () => deepPolishSchedule,
    default: () => index_default,
    evaluateCandidateSlots: () => evaluateCandidateSlots,
    expandEffectiveClasses: () => expandEffectiveClasses,
    fmtTime: () => fmtTime,
    generateUasSchedule: () => generateUasSchedule,
    getAllowedRooms: () => getAllowedRooms,
    isPascaRoom: () => isPascaRoom,
    isSaintekRoom: () => isSaintekRoom,
    planMinimalRepair: () => planMinimalRepair
  });

  // src/bitmask-index.ts
  var DAYS = ["Senin", "Selasa", "Rabu", "Kamis", "Jumat"];
  var DAY_INDEX = {
    Senin: 0,
    Selasa: 1,
    Rabu: 2,
    Kamis: 3,
    Jumat: 4
  };
  var TICK_BASE = 420;
  var TICK_STEP = 5;
  var WORDS = 5;
  function makeSlotMask(start, end) {
    const t0 = Math.max(0, Math.floor((start - TICK_BASE) / TICK_STEP));
    const t1 = Math.min(WORDS * 32, Math.ceil((end - TICK_BASE) / TICK_STEP));
    let w0 = 0;
    let w1 = 0;
    let w2 = 0;
    let w3 = 0;
    let w4 = 0;
    for (let t = t0; t < t1; t++) {
      if (t < 32) w0 |= 1 << t;
      else if (t < 64) w1 |= 1 << t - 32;
      else if (t < 96) w2 |= 1 << t - 64;
      else if (t < 128) w3 |= 1 << t - 96;
      else w4 |= 1 << t - 128;
    }
    return { w0, w1, w2, w3, w4 };
  }
  function expandEffectiveClasses(classes, knownClassSet) {
    const out = new Set(classes);
    for (const c of classes) {
      if (!/^Praktikum\s+/i.test(c)) continue;
      const stripped = c.replace(/^Praktikum\s+/i, "").trim();
      if (!knownClassSet || knownClassSet.has(stripped)) {
        out.add(stripped);
      } else if (/^Informatika\s+3B$/i.test(stripped)) {
        out.add("Informatika 3A");
      }
    }
    return Array.from(out);
  }
  var BitmaskIndex = class {
    // Flat Uint32Array per entity group: offset = (entityId * 5 + dayIdx) * WORDS
    roomBits;
    lecBits;
    clsBits;
    roomToId = /* @__PURE__ */ new Map();
    lecToId = /* @__PURE__ */ new Map();
    clsToId = /* @__PURE__ */ new Map();
    sessionRoomId;
    sessionLecId;
    sessionClsIds;
    // Direct atomic classes (for day compactness & gaps)
    sessionConflictClsIds;
    // Expanded classes incl. parent cohort (for hard clash guard!)
    sessionDayIdx;
    sessionStart;
    sessionEnd;
    sessionMaskW0;
    sessionMaskW1;
    sessionMaskW2;
    sessionMaskW3;
    sessionMaskW4;
    // Wet-lab session indices & their senior cohort class IDs for O(1) Asprak checks
    wetLabIndices = [];
    seniorClsIdsBySession;
    dependentWetLabsByCls;
    hardFridayPrayer = false;
    fridayPrayerMask = makeSlotMask(690, 780);
    constructor(sessions, roomNames) {
      roomNames.forEach((r, i) => this.roomToId.set(r, i));
      let rNext = roomNames.length;
      let lNext = 0;
      let cNext = 0;
      const knownClasses = /* @__PURE__ */ new Set();
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
      const cohortMap = /* @__PURE__ */ new Map();
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
        this.sessionLecId[i] = s.dosen ? this.lecToId.get(s.dosen) ?? -1 : -1;
        this.sessionClsIds[i] = s.classes.map((c) => this.clsToId.get(c));
        this.sessionConflictClsIds[i] = expandEffectiveClasses(s.classes, knownClasses).map(
          (c) => this.clsToId.get(c)
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
    overlapsWords(buf, off, m) {
      return (buf[off] & m.w0) !== 0 || (buf[off + 1] & m.w1) !== 0 || (buf[off + 2] & m.w2) !== 0 || (buf[off + 3] & m.w3) !== 0 || (buf[off + 4] & m.w4) !== 0;
    }
    place(idx, dayIdx, start, end, roomId) {
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
    unplace(idx) {
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
    canPlaceHard(idx, dayIdx, roomId, mask, enforceAsprak) {
      if (this.hardFridayPrayer && dayIdx === 4 && ((mask.w0 & this.fridayPrayerMask.w0) !== 0 || (mask.w1 & this.fridayPrayerMask.w1) !== 0 || (mask.w2 & this.fridayPrayerMask.w2) !== 0 || (mask.w3 & this.fridayPrayerMask.w3) !== 0 || (mask.w4 & this.fridayPrayerMask.w4) !== 0)) {
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
            if ((mask.w0 & wsW0) === 0 && (mask.w1 & wsW1) === 0 && (mask.w2 & wsW2) === 0 && (mask.w3 & wsW3) === 0 && (mask.w4 & wsW4) === 0) {
              continue;
            }
            const wsSeniors = this.seniorClsIdsBySession[wsIdx];
            let otherFree = false;
            for (let s = 0; s < wsSeniors.length; s++) {
              const scid = wsSeniors[s];
              if (cids.includes(scid)) continue;
              const sOff = (scid * 5 + dayIdx) * WORDS;
              if ((this.clsBits[sOff] & wsW0) === 0 && (this.clsBits[sOff + 1] & wsW1) === 0 && (this.clsBits[sOff + 2] & wsW2) === 0 && (this.clsBits[sOff + 3] & wsW3) === 0 && (this.clsBits[sOff + 4] & wsW4) === 0) {
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
    countAsprakIssues() {
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
            let v;
            if (m0) {
              v = m0 - (m0 >>> 1 & 1431655765);
              v = (v & 858993459) + (v >>> 2 & 858993459);
              overlapTicks += (v + (v >>> 4) & 252645135) * 16843009 >>> 24;
            }
            if (m1) {
              v = m1 - (m1 >>> 1 & 1431655765);
              v = (v & 858993459) + (v >>> 2 & 858993459);
              overlapTicks += (v + (v >>> 4) & 252645135) * 16843009 >>> 24;
            }
            if (m2) {
              v = m2 - (m2 >>> 1 & 1431655765);
              v = (v & 858993459) + (v >>> 2 & 858993459);
              overlapTicks += (v + (v >>> 4) & 252645135) * 16843009 >>> 24;
            }
            if (m3) {
              v = m3 - (m3 >>> 1 & 1431655765);
              v = (v & 858993459) + (v >>> 2 & 858993459);
              overlapTicks += (v + (v >>> 4) & 252645135) * 16843009 >>> 24;
            }
            if (m4) {
              v = m4 - (m4 >>> 1 & 1431655765);
              v = (v & 858993459) + (v >>> 2 & 858993459);
              overlapTicks += (v + (v >>> 4) & 252645135) * 16843009 >>> 24;
            }
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
    findBlockers(idx, dayIdx, roomId, mask) {
      const out = [];
      const lid = this.sessionLecId[idx];
      const cids = this.sessionConflictClsIds[idx];
      const n = this.sessionDayIdx.length;
      for (let j = 0; j < n; j++) {
        if (j === idx || this.sessionDayIdx[j] !== dayIdx) continue;
        if ((this.sessionMaskW0[j] & mask.w0) === 0 && (this.sessionMaskW1[j] & mask.w1) === 0 && (this.sessionMaskW2[j] & mask.w2) === 0 && (this.sessionMaskW3[j] & mask.w3) === 0 && (this.sessionMaskW4[j] & mask.w4) === 0) {
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
    findSeniorOverlapsForWetLab(wsIdx) {
      const dayIdx = this.sessionDayIdx[wsIdx];
      if (dayIdx < 0) return [];
      const seniors = this.seniorClsIdsBySession[wsIdx];
      if (seniors.length === 0) return [];
      const wsW0 = this.sessionMaskW0[wsIdx];
      const wsW1 = this.sessionMaskW1[wsIdx];
      const wsW2 = this.sessionMaskW2[wsIdx];
      const wsW3 = this.sessionMaskW3[wsIdx];
      const wsW4 = this.sessionMaskW4[wsIdx];
      const out = [];
      const n = this.sessionDayIdx.length;
      for (let j = 0; j < n; j++) {
        if (j === wsIdx || this.sessionDayIdx[j] !== dayIdx) continue;
        if ((this.sessionMaskW0[j] & wsW0) === 0 && (this.sessionMaskW1[j] & wsW1) === 0 && (this.sessionMaskW2[j] & wsW2) === 0 && (this.sessionMaskW3[j] & wsW3) === 0 && (this.sessionMaskW4[j] & wsW4) === 0) {
          continue;
        }
        const oc = this.sessionConflictClsIds[j];
        if (oc.some((c) => seniors.includes(c))) {
          out.push(j);
        }
      }
      return out;
    }
  };

  // src/humane-evaluator.ts
  var ISHOMA_START = 12 * 60;
  var ISHOMA_END = 13 * 60;
  var FRIDAY_PRAYER_START = 11 * 60 + 30;
  var FRIDAY_PRAYER_END = 13 * 60;
  var HUMANE_START = 8 * 60 + 40;
  var EARLY_OVERFLOW_START = 7 * 60 + 50;
  var WORK_END = 16 * 60 + 20;
  var CAMPUS_START = 7 * 60;
  var CAMPUS_END = 18 * 60;
  var EXTENDED_END = 19 * 60;
  var PASCA_ALLOWED_DAYS = /* @__PURE__ */ new Set(["Senin", "Selasa", "Rabu"]);
  var DEFAULT_POLICY = {
    enforcePascaMonWed: true,
    enforceAsprakWetLab: true,
    protectIshoma: true,
    maxDaysPerClass: 3,
    minCoursesPerActiveDay: 2,
    // Every active day has >= 2 courses (no 1-course commute days!)
    enforceContiguousDays: true,
    preferredMinStart: HUMANE_START,
    // 08:40
    allowDryLabOverflow: true,
    // Shares ONLY LAB. DATA ENGINEER & LAB. DATA SCIENCE with IF/SD theory -> 100% >=08:40
    preferWorkingHours: true,
    minimizeLongGaps: true,
    preventMarathon: true,
    protectFridayPrayer: false,
    hardFridayPrayer: false
  };
  function fmtTime(mins) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }
  function isPascaRoom(roomName) {
    return /^Pasca/i.test(roomName || "");
  }
  function isSaintekRoom(roomName) {
    return /^LAB\.\s*4-0[1-4]$/i.test(roomName || "");
  }
  function isGeneralRoom(roomName) {
    return isPascaRoom(roomName) || isSaintekRoom(roomName);
  }
  function buildingGroup(roomName) {
    return isPascaRoom(roomName) ? "PASCA" : "SAINTEK";
  }
  function overlaps(d1, s1, e1, d2, s2, e2) {
    return d1 === d2 && s1 < e2 && s2 < e1;
  }
  function overlapsIshoma(start, end, duration) {
    if (duration > 300) return false;
    return start < ISHOMA_END && end > ISHOMA_START;
  }
  function overlapsFridayPrayer(day, start, end, _duration) {
    if (day !== "Jumat") return false;
    return start < FRIDAY_PRAYER_END && end > FRIDAY_PRAYER_START;
  }
  function effectiveDeadGap(prevEnd, nextStart, day, protectFriday = false) {
    const raw = nextStart - prevEnd;
    if (raw <= 0) return 0;
    const breakStart = day === "Jumat" && protectFriday ? FRIDAY_PRAYER_START : ISHOMA_START;
    const breakEnd = ISHOMA_END;
    const lunchOverlap = Math.max(0, Math.min(nextStart, breakEnd) - Math.max(prevEnd, breakStart));
    return Math.max(0, raw - lunchOverlap);
  }
  function sharesClass(a, b) {
    const ea = expandEffectiveClasses(a);
    const eb = expandEffectiveClasses(b);
    for (let i = 0; i < ea.length; i++) {
      for (let j = 0; j < eb.length; j++) {
        if (ea[i] === eb[j]) return true;
      }
    }
    return false;
  }
  function buildCohortMap(sessions) {
    const map = /* @__PURE__ */ new Map();
    for (const s of sessions) {
      for (const c of s.classes) {
        if (/^Praktikum\s+/i.test(c)) continue;
        const m = c.match(/^(.+?)\s+(\d)[A-Z]$/);
        if (!m) continue;
        const key = `${m[1].trim()}|${m[2]}`;
        if (!map.has(key)) map.set(key, /* @__PURE__ */ new Set());
        map.get(key).add(c);
      }
    }
    const out = /* @__PURE__ */ new Map();
    for (const [k, set] of map.entries()) {
      out.set(k, Array.from(set).sort());
    }
    return out;
  }
  function getSeniorCohortClasses(session, cohortMap) {
    if (!session.isWetLab || !session.semester) return [];
    return cohortMap.get(`${session.prodiPrefix}|${session.semester + 2}`) || [];
  }
  function computeGlobalHumaneEnergy(sessions, policy) {
    let energy = 0;
    const minStart = policy.preferredMinStart ?? HUMANE_START;
    const clsDayBuckets = /* @__PURE__ */ new Map();
    const lecDayBuckets = /* @__PURE__ */ new Map();
    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i];
      const dIdx = DAY_INDEX[s.day];
      if (s.start < EARLY_OVERFLOW_START) {
        energy += 650;
      } else if (s.start < minStart) {
        energy += policy.allowDryLabOverflow ? 980 : 180;
      }
      if (policy.preferWorkingHours && s.end > WORK_END) {
        energy += s.end > CAMPUS_END ? 32 : 14;
      }
      if ((policy.protectFridayPrayer || policy.hardFridayPrayer) && overlapsFridayPrayer(s.day, s.start, s.end, s.duration)) {
        energy += policy.hardFridayPrayer ? 5e3 : 500;
      }
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
            if (policy.minimizeLongGaps) {
              if (deadGap >= 100) energy += 130 + Math.floor((deadGap - 100) / 30) * 20;
              else if (deadGap >= 40) energy += 28;
            }
            if (rawGap === 0 && buildingGroup(prev.room) !== buildingGroup(cur.room)) {
              energy += 16;
            }
            if (rawGap < 40) {
              continuousMin += cur.duration;
              continuousCount++;
            } else {
              continuousMin = cur.duration;
              continuousCount = 1;
            }
            if (policy.preventMarathon && continuousCount >= 2 && continuousMin > 300) {
              energy += 130;
            }
          }
        }
        if (dailyMin > 480) energy += 65;
      }
      const needs4Days = totalWeeklyMin > 1420;
      if (activeCount > policy.maxDaysPerClass) {
        if (activeCount === 4) {
          energy += needs4Days ? 25 : 460;
        } else {
          energy += 1050;
        }
      }
      if (policy.enforceContiguousDays && activeCount >= 2) {
        const span = maxD - minD + 1;
        const holes = span - activeCount;
        if (holes > 0) {
          energy += holes * 3200;
        }
      }
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
      const lecIsoWeight = policy.lecturerIsolatedWeight !== void 0 ? policy.lecturerIsolatedWeight : 95;
      if ((policy.minCoursesPerActiveDay ?? 2) >= 2 && totalLecSess >= 2 && lecIsoWeight > 0) {
        for (let d = 0; d < 5; d++) {
          if (dayArr[d].length === 1) energy += lecIsoWeight;
        }
      }
    }
    return energy;
  }
  function auditSchedule(sessions, policyInput) {
    const policy = { ...DEFAULT_POLICY, ...policyInput || {} };
    const minStart = policy.preferredMinStart ?? HUMANE_START;
    const cohortMap = buildCohortMap(sessions);
    const roomConflicts = [];
    const lecturerConflicts = [];
    const classConflicts = [];
    const pascaViolations = [];
    const asprakDeadlocks = [];
    const asprakPartial = [];
    const ishomaViolations = [];
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
          room: a.room
        });
      }
      if (overlapsIshoma(a.start, a.end, a.duration)) {
        ishomaViolations.push({
          sessionId: a.id,
          namaMk: a.namaMk,
          day: a.day,
          time: `${fmtTime(a.start)}-${fmtTime(a.end)}`,
          room: a.room
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
            type: "ROOM",
            aId: a.id,
            bId: b.id,
            resource: a.room,
            day: a.day,
            detail: `${a.room} (${fmtTime(a.start)}-${fmtTime(a.end)} vs ${fmtTime(b.start)}-${fmtTime(b.end)})`,
            aName: `${a.namaMk} (${a.kelasRaw})`,
            bName: `${b.namaMk} (${b.kelasRaw})`
          });
        }
        if (a.dosen && a.dosen === b.dosen) {
          lecturerConflicts.push({
            type: "LECTURER",
            aId: a.id,
            bId: b.id,
            resource: a.dosen,
            day: a.day,
            detail: `${a.dosen} (${fmtTime(a.start)}-${fmtTime(a.end)})`,
            aName: `${a.namaMk} (${a.room})`,
            bName: `${b.namaMk} (${b.room})`
          });
        }
        if (sharesClass(a.classes, b.classes)) {
          const ea = expandEffectiveClasses(a.classes);
          const eb = expandEffectiveClasses(b.classes);
          const shared = ea.filter((c) => eb.includes(c));
          classConflicts.push({
            type: "CLASS",
            aId: a.id,
            bId: b.id,
            resource: shared.join(", "),
            day: a.day,
            detail: `${shared.join(", ")} (${fmtTime(a.start)}-${fmtTime(a.end)} vs ${fmtTime(b.start)}-${fmtTime(b.end)})`,
            aName: `${a.namaMk} (${a.room})`,
            bName: `${b.namaMk} (${b.room})`
          });
        }
      }
    }
    const asprakDetails = [];
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
          status: "NO_SENIOR_COHORT"
        });
        continue;
      }
      const busySet = /* @__PURE__ */ new Set();
      for (const other of sessions) {
        if (other.id === ws.id) continue;
        if (!overlaps(ws.day, ws.start, ws.end, other.day, other.start, other.end)) continue;
        for (const c of expandEffectiveClasses(other.classes)) {
          if (seniors.includes(c)) busySet.add(c);
        }
      }
      const busySeniors = seniors.filter((c) => busySet.has(c));
      const freeSeniors = seniors.filter((c) => !busySet.has(c));
      const detail = {
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
        status: freeSeniors.length === 0 ? "DEADLOCK" : busySeniors.length > 0 ? "PARTIAL" : "CLEAR"
      };
      asprakDetails.push(detail);
      if (detail.status === "DEADLOCK") asprakDeadlocks.push(detail);
      else if (detail.status === "PARTIAL") asprakPartial.push(detail);
    }
    const classDaysMap = /* @__PURE__ */ new Map();
    const lecDaysMap = /* @__PURE__ */ new Map();
    for (const s of sessions) {
      for (const c of s.classes) {
        if (!classDaysMap.has(c)) classDaysMap.set(c, /* @__PURE__ */ new Map());
        const dm = classDaysMap.get(c);
        if (!dm.has(s.day)) dm.set(s.day, []);
        dm.get(s.day).push(s);
      }
      if (s.dosen) {
        if (!lecDaysMap.has(s.dosen)) lecDaysMap.set(s.dosen, /* @__PURE__ */ new Map());
        const dm = lecDaysMap.get(s.dosen);
        if (!dm.has(s.day)) dm.set(s.day, []);
        dm.get(s.day).push(s);
      }
    }
    const daySpreadHist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    const classSummary = [];
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
      const daySpan = daysSorted.length > 0 ? DAY_INDEX[daysSorted[daysSorted.length - 1]] - DAY_INDEX[daysSorted[0]] + 1 : 0;
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
        isCompact: activeDays <= policy.maxDaysPerClass && isContiguous
      });
    }
    classSummary.sort((a, b) => a.className.localeCompare(b.className));
    let lecturerLongGaps = 0;
    let lecturerTotalGapMin = 0;
    let lecturerIsolatedDayCount = 0;
    const lecturerSummary = [];
    for (const [lec, dm] of lecDaysMap.entries()) {
      const daysSorted = Array.from(dm.keys()).sort((a, b) => DAY_INDEX[a] - DAY_INDEX[b]);
      const daySpan = daysSorted.length > 0 ? DAY_INDEX[daysSorted[daysSorted.length - 1]] - DAY_INDEX[daysSorted[0]] + 1 : 0;
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
        pinnedCount
      });
    }
    lecturerSummary.sort((a, b) => b.totalMin - a.totalMin);
    const totalClasses = classDaysMap.size;
    const classesWithin3Days = classSummary.filter((c) => c.activeDays <= 3).length;
    const hardConflicts = [...roomConflicts, ...lecturerConflicts, ...classConflicts];
    const dayLoad = { Senin: 0, Selasa: 0, Rabu: 0, Kamis: 0, Jumat: 0 };
    const pascaByDay = { Senin: 0, Selasa: 0, Rabu: 0, Kamis: 0, Jumat: 0 };
    for (const s of sessions) {
      dayLoad[s.day] = (dayLoad[s.day] || 0) + 1;
      if (isPascaRoom(s.room)) pascaByDay[s.day] = (pascaByDay[s.day] || 0) + 1;
    }
    const compactClassPct = totalClasses ? Number((classesWithin3Days / totalClasses * 100).toFixed(1)) : 0;
    const contiguousClassPct = totalClasses ? Number((contiguousClassCount / totalClasses * 100).toFixed(1)) : 0;
    const humaneStartPct = sessions.length ? Number(((sessions.length - earlyBefore0840Count) / sessions.length * 100).toFixed(1)) : 0;
    const compactCeiling = Math.max(1, classSummary.filter((c) => c.totalMin <= 1420).length);
    const gapNormRef = Math.max(1, Math.round(totalClasses * 1.8));
    const startScore = (sessions.length ? (sessions.length - earlyBefore0840Count - earlyBefore0750Count * 0.5) / sessions.length : 1) * 25;
    const contigScore = (totalClasses ? contiguousClassCount / totalClasses : 1) * 25;
    const compactScore = (totalClasses ? Math.min(1, classesWithin3Days / compactCeiling) : 1) * 20;
    const gapScore = Math.max(0, 1 - (classLongGaps + lecturerLongGaps) / gapNormRef) * 15;
    const compliancePenalty = hardConflicts.length * 4 + pascaViolations.length * 0.5 + asprakDeadlocks.length * 2.5 + asprakPartial.length * 0.25 + ishomaViolations.length * 1.5 + marathonDayCount * 0.8 + isolatedDayCount * 0.6;
    const complianceScore = Math.max(0, 15 - compliancePenalty);
    const rawHumaneScore = Number(
      Math.max(0, Math.min(100, startScore + contigScore + compactScore + gapScore + complianceScore)).toFixed(1)
    );
    const hardFeasible = hardConflicts.length === 0 && pascaViolations.length === 0 && asprakDeadlocks.length === 0 && (!policy.hardFridayPrayer || fridayPrayerViolationCount === 0);
    const gatedHumaneScore = hardFeasible ? rawHumaneScore : 0;
    const balancedScore03 = hardFeasible ? Number(Math.max(0, rawHumaneScore - 0.3 * lecturerIsolatedDayCount).toFixed(1)) : 0;
    const balancedScore06 = hardFeasible ? Number(Math.max(0, rawHumaneScore - 0.6 * lecturerIsolatedDayCount).toFixed(1)) : 0;
    const humaneScore = rawHumaneScore;
    const asprakClearCount = asprakDetails.filter((d) => d.status === "CLEAR").length;
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
      lecturerSummary
    };
  }

  // src/tpe-tuner.ts
  var DEFAULT_HYPERPARAMS = {
    lahcLength: 65,
    initTemp: 42,
    coolingRate: 0.9992,
    phase2ARatio: 0.58,
    wDay4: 460,
    wGapCls: 130,
    wGapLec: 90,
    wAsprakPartial: 185,
    opScaleSwap: 1,
    opScaleConsolidate: 1.3,
    opScaleAsprak: 1.35
  };
  var TPE_PARAM_SPECS = [
    { key: "lahcLength", min: 30, max: 120, isInt: true },
    { key: "initTemp", min: 22, max: 62, decimals: 1 },
    { key: "coolingRate", min: 0.9987, max: 0.99965, decimals: 5 },
    { key: "phase2ARatio", min: 0.45, max: 0.66, decimals: 3 },
    { key: "wDay4", min: 400, max: 1120, isInt: true },
    { key: "wGapCls", min: 110, max: 340, isInt: true },
    { key: "wGapLec", min: 75, max: 270, isInt: true },
    { key: "wAsprakPartial", min: 85, max: 380, isInt: true },
    { key: "opScaleSwap", min: 0.75, max: 1.9, decimals: 2 },
    { key: "opScaleConsolidate", min: 0.9, max: 2.3, decimals: 2 },
    { key: "opScaleAsprak", min: 0.9, max: 2.4, decimals: 2 }
  ];
  function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
      a |= 0;
      a = a + 1831565813 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function boxMullerNormal(rng) {
    const u1 = Math.max(1e-12, rng());
    const u2 = rng();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
  function computeTpeFitness(audit) {
    const feasiblePerfect = audit.hardConflictCount === 0 && audit.pascaViolationCount === 0 && audit.asprakDeadlockCount === 0 && audit.earlyBefore0840Count === 0 && audit.totalHoleDays === 0 && audit.isolatedDayCount === 0 && audit.marathonDayCount === 0;
    if (feasiblePerfect) {
      const compositeFitness = Number(
        (1e3 + audit.humaneScore * 10 - (audit.lecturerIsolatedDayCount || 0) * 0.08 - audit.lateSessionCount * 5e-3).toFixed(4)
      );
      return { feasiblePerfect: true, compositeFitness };
    }
    const penalty = audit.hardConflictCount * 500 + audit.pascaViolationCount * 150 + audit.asprakDeadlockCount * 350 + audit.earlyBefore0840Count * 18 + audit.totalHoleDays * 95 + audit.isolatedDayCount * 55 + audit.marathonDayCount * 60;
    return {
      feasiblePerfect: false,
      compositeFitness: Number((audit.humaneScore * 10 - penalty).toFixed(4))
    };
  }
  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }
  function normalize(val, spec) {
    return clamp((val - spec.min) / Math.max(1e-9, spec.max - spec.min), 0, 1);
  }
  function denormalize(u, spec) {
    const raw = spec.min + clamp(u, 0, 1) * (spec.max - spec.min);
    if (spec.isInt) return Math.round(raw);
    if (spec.decimals !== void 0) {
      const f = 10 ** spec.decimals;
      return Math.round(raw * f) / f;
    }
    return raw;
  }
  function parzenLogDensity(x, points, bandwidth, priorWeight = 1) {
    const n = points.length;
    const inv2s2 = 1 / (2 * bandwidth * bandwidth);
    const normConst = 1 / (Math.sqrt(2 * Math.PI) * bandwidth);
    let sum = priorWeight;
    for (let i = 0; i < n; i++) {
      const diff = x - points[i];
      sum += normConst * Math.exp(-diff * diff * inv2s2);
    }
    return Math.log(Math.max(1e-15, sum / (n + priorWeight)));
  }
  function scottBandwidth(points) {
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
  var TpeSampler = class {
    nStartupTrials;
    gamma;
    nEICandidates;
    useCuratedStartup;
    trials = [];
    rng;
    nextTrialId = 1;
    // Optional legacy seed anchors only when useCuratedStartup=true
    anchorSeeds = [27, 486, 73, 66, 77, 108, 42, 55, 11, 33, 88, 99, 19, 37, 47, 7, 22, 67, 83, 101];
    constructor(options = {}) {
      this.rng = mulberry32(options.seed ?? 20261122);
      this.nStartupTrials = options.nStartupTrials ?? 8;
      this.gamma = options.gamma ?? 0.25;
      this.nEICandidates = options.nEICandidates ?? 36;
      this.useCuratedStartup = Boolean(options.useCuratedStartup);
    }
    tell(record) {
      this.trials.push(record);
    }
    getBest() {
      if (this.trials.length === 0) return null;
      let best = this.trials[0];
      for (let i = 1; i < this.trials.length; i++) {
        if (this.trials[i].compositeFitness > best.compositeFitness) {
          best = this.trials[i];
        }
      }
      return best;
    }
    suggest() {
      const trialId = this.nextTrialId++;
      const unbiasedSeed = 100 + trialId * 17 + Math.floor(this.rng() * 97);
      const seed = this.useCuratedStartup && trialId <= this.anchorSeeds.length ? this.anchorSeeds[trialId - 1] : unbiasedSeed;
      if (this.useCuratedStartup) {
        if (trialId === 1) {
          return { trialId, seed: 27, params: { ...DEFAULT_HYPERPARAMS }, phase: "STARTUP" };
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
              opScaleAsprak: 1.75
            },
            phase: "STARTUP"
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
              opScaleAsprak: 1.9
            },
            phase: "STARTUP"
          };
        }
      } else if (trialId === 1) {
        return {
          trialId,
          seed: unbiasedSeed,
          params: { ...DEFAULT_HYPERPARAMS },
          phase: "STARTUP"
        };
      }
      if (this.trials.length < this.nStartupTrials) {
        const p = { ...DEFAULT_HYPERPARAMS };
        for (const spec of TPE_PARAM_SPECS) {
          p[spec.key] = denormalize(this.rng(), spec);
        }
        return { trialId, seed, params: p, phase: "STARTUP" };
      }
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
          let u;
          if (this.rng() < 0.85) {
            const center = goodPts[Math.floor(this.rng() * goodPts.length)];
            u = clamp(center + boxMullerNormal(this.rng) * bwL, 0, 1);
          } else {
            u = this.rng();
          }
          const logL = parzenLogDensity(u, goodPts, bwL, 1);
          const logG = parzenLogDensity(u, badPts, bwG, 1);
          const ei = logL - logG;
          if (ei > bestEI) {
            bestEI = ei;
            bestU = u;
          }
        }
        suggested[spec.key] = denormalize(bestU, spec);
      }
      const chosenSeed = this.useCuratedStartup && this.rng() < 0.42 ? goodTrials[Math.floor(this.rng() * goodTrials.length)].seed : unbiasedSeed;
      return { trialId, seed: chosenSeed, params: suggested, phase: "TPE" };
    }
  };

  // src/alns-lahc-solver.ts
  function mulberry322(seed) {
    let a = seed >>> 0;
    return () => {
      a |= 0;
      a = a + 1831565813 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function cloneSessions(sessions) {
    return sessions.map((s) => ({
      ...s,
      classes: Array.isArray(s.classes) ? s.classes.slice() : []
    }));
  }
  function getHumaneStarts(duration, policy, allowOverflow = true) {
    const minPref = policy.preferredMinStart ?? HUMANE_START;
    let primary;
    let overflow;
    if (duration > 300) {
      primary = [780];
      overflow = [420];
    } else if (duration === 170) {
      primary = [520, 550, 780, 880, 910];
      overflow = [470, 420];
    } else if (duration === 150) {
      primary = [780, 930, 520, 570];
      overflow = [470, 420];
    } else if (duration === 100) {
      primary = [520, 620, 780, 880, 980];
      overflow = [470, 570, 420];
    } else {
      primary = [520, 570, 620, 670, 780, 830, 880, 930, 980];
      overflow = [470, 420];
    }
    const maxEnd = duration > 300 ? EXTENDED_END : CAMPUS_END;
    const combined = allowOverflow ? [...primary, ...overflow] : primary;
    const seen = /* @__PURE__ */ new Set();
    const valid = [];
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
  var SD_IF_DRY_LABS = /* @__PURE__ */ new Set(["LAB. DATA ENGINEER", "LAB. DATA SCIENCE"]);
  function getAllowedRooms(session, rooms, policy) {
    if (session.roomType === "WET_LAB" || session.roomType === "DRY_LAB") {
      return [session.originalRoom || session.room];
    }
    const base = rooms.filter((r) => r.type === "PASCA" || r.type === "SAINTEK").map((r) => r.name);
    if (policy.allowDryLabOverflow && (session.prodi === "IF" || session.prodi === "SD")) {
      const dry = rooms.filter((r) => r.type === "DRY_LAB" && SD_IF_DRY_LABS.has(r.name.toUpperCase())).map((r) => r.name);
      return [...base, ...dry];
    }
    return base;
  }
  function buildContiguousClassWindows(sessions, rng) {
    const clsInfo = /* @__PURE__ */ new Map();
    const wetLabProdis = /* @__PURE__ */ new Set();
    const prodiWetMin = /* @__PURE__ */ new Map();
    const prodiSem3Has4Day = /* @__PURE__ */ new Set();
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
          dryRooms: /* @__PURE__ */ new Set()
        };
        prev.count++;
        prev.totalMin += s.duration;
        if (s.isPraktikum) prev.labMin += s.duration;
        if (s.isWetLab) prev.hasWetLab = true;
        if (s.roomType === "DRY_LAB") prev.dryRooms.add(s.originalRoom || s.room);
        clsInfo.set(c, prev);
      }
    }
    for (const info of clsInfo.values()) {
      if (info.sem === 3 && info.totalMin > 1420) prodiSem3Has4Day.add(info.prodi);
    }
    const prodiPhase = /* @__PURE__ */ new Map();
    const non4DayWetProdis = Array.from(wetLabProdis).filter((p) => !prodiSem3Has4Day.has(p)).sort((a, b) => (prodiWetMin.get(b) || 0) - (prodiWetMin.get(a) || 0));
    for (const p of prodiSem3Has4Day) prodiPhase.set(p, 0);
    non4DayWetProdis.forEach((p, idx) => {
      prodiPhase.set(p, (idx + 1) % 2);
    });
    const windows1 = [[0], [1], [2], [3], [4]];
    const windows2 = [
      [0, 1],
      [1, 2],
      [0, 1],
      [1, 2]
    ];
    const nonWetWindows3 = [
      [0, 1, 2],
      [0, 1, 2],
      [1, 2, 3],
      [1, 2, 3],
      [0, 1, 2]
    ];
    const sorted = Array.from(clsInfo.entries()).sort((a, b) => b[1].totalMin - a[1].totalMin);
    const prefs = /* @__PURE__ */ new Map();
    const usedDryRoomDays = /* @__PURE__ */ new Map();
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
          if (info.sem === 3) prefs.set(cls, /* @__PURE__ */ new Set([2, 3, 4]));
          else prefs.set(cls, /* @__PURE__ */ new Set([0, 1, 2]));
        } else {
          if (info.sem === 3) prefs.set(cls, /* @__PURE__ */ new Set([0, 1, 2]));
          else if (info.sem === 5) prefs.set(cls, /* @__PURE__ */ new Set([2, 3, 4]));
          else prefs.set(cls, new Set(has4dSem3 ? [2, 3, 4] : [1, 2, 3]));
        }
        return;
      }
      if (info.count <= 3) {
        if (/^Praktikum\s+/i.test(cls)) {
          const parentName = cls.replace(/^Praktikum\s+/i, "").trim();
          const parentWin = prefs.get(parentName);
          const prefOrder = prakDayIdx++ % 2 === 0 ? [3, 4, 0, 1, 2] : [4, 3, 1, 0, 2];
          const roomFree = (d) => Array.from(info.dryRooms).every((r) => !usedDryRoomDays.get(r)?.has(d));
          const chosen = prefOrder.find((d) => (!parentWin || !parentWin.has(d)) && roomFree(d)) ?? prefOrder.find((d) => roomFree(d)) ?? prefOrder.find((d) => !parentWin || !parentWin.has(d)) ?? 4;
          prefs.set(cls, /* @__PURE__ */ new Set([chosen]));
          for (const r of info.dryRooms) {
            let s = usedDryRoomDays.get(r);
            if (!s) {
              s = /* @__PURE__ */ new Set();
              usedDryRoomDays.set(r, s);
            }
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
  function constructiveReset(initialSessions, rooms, policyInput, options = {}) {
    const t0 = performance.now();
    const policy = { ...DEFAULT_POLICY, ...policyInput || {} };
    const hp = { ...DEFAULT_HYPERPARAMS, ...options.hyperparams || {} };
    const seed = options.seed !== void 0 ? options.seed : 27;
    const ignorePins = Boolean(options.ignorePins);
    const maxIters = options.maxIters !== void 0 ? options.maxIters : 32e3;
    const timeBudgetMs = options.timeBudgetMs !== void 0 ? options.timeBudgetMs : 3500;
    const skipStage2 = Boolean(options.skipStage2);
    const skipStage3 = Boolean(options.skipStage3);
    const useExactObjective = Boolean(options.useExactObjective);
    const wScale = options.weightScale !== void 0 ? options.weightScale : 1;
    const stage2LecIsoWeight = (options.lecturerIsolatedWeight !== void 0 ? options.lecturerIsolatedWeight : policy.lecturerIsolatedWeight !== void 0 ? policy.lecturerIsolatedWeight : 95) * wScale;
    const rng = mulberry322(seed);
    const sessions = cloneSessions(initialSessions);
    const n = sessions.length;
    const roomNames = rooms.map((r) => r.name);
    const bitIdx = new BitmaskIndex(sessions, roomNames);
    bitIdx.hardFridayPrayer = Boolean(policy.hardFridayPrayer);
    const contiguousWindows = buildContiguousClassWindows(sessions, rng);
    const allowedRoomIds = new Array(n);
    const candidateStarts = new Array(n);
    const startMasks = new Array(n);
    const isDryLabById = new Uint8Array(roomNames.length + 10);
    const isPascaById = new Uint8Array(roomNames.length + 10);
    const idToRoomName = [];
    const roomTypeMap = new Map(rooms.map((r) => [r.name, r.type]));
    for (const [rn, rid] of bitIdx.roomToId.entries()) {
      idToRoomName[rid] = rn;
      if (isPascaRoom(rn)) isPascaById[rid] = 1;
      if (roomTypeMap.get(rn) === "DRY_LAB") isDryLabById[rid] = 1;
    }
    for (let i = 0; i < n; i++) {
      const s = sessions[i];
      const rNames = getAllowedRooms(s, rooms, policy);
      allowedRoomIds[i] = rNames.map((rn) => bitIdx.roomToId.get(rn)).filter((id) => id !== void 0);
      const starts = getHumaneStarts(s.duration, policy, true);
      candidateStarts[i] = starts;
      const mMap = /* @__PURE__ */ new Map();
      for (const st of starts) mMap.set(st, makeSlotMask(st, st + s.duration));
      startMasks[i] = mMap;
    }
    const pinnedMask = new Uint8Array(n);
    const toPlace = [];
    for (let i = 0; i < n; i++) {
      if (!ignorePins && sessions[i].pinned) {
        pinnedMask[i] = 1;
        const dIdx = DAY_INDEX[sessions[i].day];
        const rid = bitIdx.roomToId.get(sessions[i].room);
        bitIdx.place(i, dIdx, sessions[i].start, sessions[i].end, rid);
      } else {
        toPlace.push(i);
      }
    }
    const clsLoad = /* @__PURE__ */ new Map();
    const clsMegaCount = /* @__PURE__ */ new Map();
    const lecLoad = /* @__PURE__ */ new Map();
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
        sc += 6700 - mCnt * 260;
      }
      if (s.isWetLab) {
        sc += 4400;
        if (s.semester === 3) sc += 340;
      } else if (s.roomType === "DRY_LAB") sc += 3900;
      else if (s.duration === 150) sc += 1200;
      sc += s.duration * 4;
      sc += s.classes.length * 450;
      sc += Math.max(...s.classes.map((c) => clsLoad.get(c) || 0), 0) * 0.7;
      sc += (lecLoad.get(s.dosen) || 0) * 0.5;
      sc += rng() * 12;
      diffScore[i] = sc;
    }
    toPlace.sort((a, b) => diffScore[b] - diffScore[a]);
    const minPref = policy.preferredMinStart ?? HUMANE_START;
    function stage1SlotCost(idx, dayIdx, start, roomId) {
      const s = sessions[idx];
      let cost = 0;
      if (start < EARLY_OVERFLOW_START) cost += 2500;
      else if (start < minPref) cost += 650;
      if (policy.preferWorkingHours && start + s.duration > WORK_END) cost += 16;
      if (dayIdx === 4 && (policy.protectFridayPrayer || policy.hardFridayPrayer) && overlapsFridayPrayer("Jumat", start, start + s.duration, s.duration)) {
        cost += 1400;
      }
      for (const c of s.classes) {
        const win = contiguousWindows.get(c);
        if (win && !win.has(dayIdx)) cost += win.size === 1 ? 750 : 360;
      }
      if (s.roomType === "DRY_LAB") {
        for (let j = 0; j < n; j++) {
          if (bitIdx.sessionDayIdx[j] === dayIdx && sessions[j].roomType === "DRY_LAB" && sharesClass(s.classes, sessions[j].classes)) {
            cost -= 180;
          }
        }
      }
      if (policy.allowDryLabOverflow && (s.prodi === "IF" || s.prodi === "SD") && (s.roomType === "PASCA" || s.roomType === "SAINTEK")) {
        if (isDryLabById[roomId]) cost -= 28;
      }
      if (dayIdx <= 2 && !isPascaById[roomId] && !isDryLabById[roomId] && (s.roomType === "PASCA" || s.roomType === "SAINTEK")) {
        cost += 9;
      }
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
          if (dayIdx >= 3 && cntOnDay >= 2 && !s.isWetLab && s.roomType !== "DRY_LAB") cost += 135;
        }
        if (s.dosen) {
          let lecOnDay = 0;
          for (let j = 0; j < n; j++) {
            if (bitIdx.sessionDayIdx[j] === dayIdx && sessions[j].dosen === s.dosen) lecOnDay++;
          }
          if (lecOnDay === 1) cost -= 55;
        }
      }
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
        if (gap === 0 || gap === 60 && (end === 720 && oStart === 780 || oEnd === 720 && start === 780)) {
          cost -= 36;
        } else if (gap >= 160) {
          cost += 48;
        }
      }
      return cost;
    }
    function findBestFeasibleSlot(idx, enforceAsprak, minAllowedStart) {
      const rIds = allowedRoomIds[idx];
      const starts = candidateStarts[idx];
      const mMap = startMasks[idx];
      let best = null;
      let bestCost = Infinity;
      for (let d = 0; d < 5; d++) {
        for (let ri = 0; ri < rIds.length; ri++) {
          const rid = rIds[ri];
          if (policy.enforcePascaMonWed && isPascaById[rid] && d > 2) continue;
          for (let si = 0; si < starts.length; si++) {
            const st = starts[si];
            if (st < minAllowedStart) continue;
            const mask = mMap.get(st);
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
    function tryEjectionPlace(idx, enforceAsprak, minAllowedStart) {
      const rIds = allowedRoomIds[idx];
      const starts = candidateStarts[idx];
      const mMap = startMasks[idx];
      for (let d = 0; d < 5; d++) {
        for (const rid of rIds) {
          if (policy.enforcePascaMonWed && isPascaById[rid] && d > 2) continue;
          for (const st of starts) {
            if (st < minAllowedStart) continue;
            const mask = mMap.get(st);
            const blockers = bitIdx.findBlockers(idx, d, rid, mask);
            if (blockers.length === 0 || blockers.length > 2) continue;
            if (blockers.some((b) => pinnedMask[b] === 1)) continue;
            const saved = blockers.map((b) => ({
              b,
              d: bitIdx.sessionDayIdx[b],
              st: bitIdx.sessionStart[b],
              en: bitIdx.sessionEnd[b],
              rid: bitIdx.sessionRoomId[b]
            }));
            for (const sv of saved) bitIdx.unplace(sv.b);
            if (!bitIdx.canPlaceHard(idx, d, rid, mask, enforceAsprak)) {
              for (const sv of saved) bitIdx.place(sv.b, sv.d, sv.st, sv.en, sv.rid);
              continue;
            }
            bitIdx.place(idx, d, st, st + sessions[idx].duration, rid);
            const moved = [];
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
    const unplacedTier1 = [];
    for (const idx of toPlace) {
      const slot = findBestFeasibleSlot(idx, policy.enforceAsprakWetLab, minPref);
      if (slot) {
        bitIdx.place(idx, slot.dayIdx, slot.start, slot.start + sessions[idx].duration, slot.roomId);
      } else {
        unplacedTier1.push(idx);
      }
    }
    const unplacedTier2 = [];
    for (const idx of unplacedTier1) {
      if (!tryEjectionPlace(idx, policy.enforceAsprakWetLab, minPref)) {
        unplacedTier2.push(idx);
      }
    }
    const unplacedTier3 = [];
    for (const idx of unplacedTier2) {
      let slot = findBestFeasibleSlot(idx, policy.enforceAsprakWetLab, EARLY_OVERFLOW_START);
      if (slot) {
        bitIdx.place(idx, slot.dayIdx, slot.start, slot.start + sessions[idx].duration, slot.roomId);
        continue;
      }
      if (sessions[idx].duration === 100 && (sessions[idx].roomType === "PASCA" || sessions[idx].roomType === "SAINTEK")) {
        let opened = false;
        for (let j = 0; j < n && !opened; j++) {
          if (pinnedMask[j] === 1 || bitIdx.sessionDayIdx[j] < 0) continue;
          if (sessions[j].duration !== 150 || bitIdx.sessionStart[j] < 780) continue;
          const jD = bitIdx.sessionDayIdx[j], jSt = bitIdx.sessionStart[j], jEn = bitIdx.sessionEnd[j], jR = bitIdx.sessionRoomId[j];
          bitIdx.unplace(j);
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
      if (tryEjectionPlace(idx, policy.enforceAsprakWetLab, EARLY_OVERFLOW_START)) continue;
      unplacedTier3.push(idx);
    }
    const stillUnplaced = [];
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
        const rid = bitIdx.roomToId.get(sessions[idx].room);
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
    let stage1MinStart = 1440;
    for (let i = 0; i < n; i++) {
      if (bitIdx.sessionStart[i] < stage1MinStart) stage1MinStart = bitIdx.sessionStart[i];
    }
    const floorStart = stage1MinStart >= minPref ? minPref : stage1MinStart >= EARLY_OVERFLOW_START ? EARLY_OVERFLOW_START : CAMPUS_START;
    const stage2Starts = new Array(n);
    for (let i = 0; i < n; i++) {
      const filtered = candidateStarts[i].filter((st) => st >= floorStart);
      stage2Starts[i] = filtered.length > 0 ? filtered : candidateStarts[i];
    }
    function syncSessionsFromIndex(target) {
      for (let i = 0; i < n; i++) {
        const d = bitIdx.sessionDayIdx[i];
        target[i].day = DAYS[d];
        target[i].start = bitIdx.sessionStart[i];
        target[i].end = bitIdx.sessionEnd[i];
        target[i].room = idToRoomName[bitIdx.sessionRoomId[i]];
      }
    }
    syncSessionsFromIndex(sessions);
    const numCls = bitIdx.clsToId.size;
    const numLec = bitIdx.lecToId.size;
    const clsDayBuf = Array.from({ length: numCls * 5 }, () => []);
    const lecDayBuf = Array.from({ length: numLec * 5 }, () => []);
    const sessDur = new Int32Array(n);
    for (let i = 0; i < n; i++) sessDur[i] = sessions[i].duration;
    function sortByStart(arr) {
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
    function fastDeadGap(prevEnd, nextStart, dayIdx = -1) {
      const raw = nextStart - prevEnd;
      if (raw <= 0) return 0;
      const bStart = dayIdx === 4 && friBreakActive ? 690 : 720;
      const lo = prevEnd > bStart ? prevEnd : bStart;
      const hi = nextStart < 780 ? nextStart : 780;
      const lunch = hi > lo ? hi - lo : 0;
      return raw > lunch ? raw - lunch : 0;
    }
    let studentLoneDayPenalty = 0;
    const clsWeeklyTotal = new Int32Array(numCls);
    for (let i = 0; i < n; i++) {
      const cids = bitIdx.sessionClsIds[i];
      for (let k = 0; k < cids.length; k++) clsWeeklyTotal[cids[k]] += sessDur[i];
    }
    let s2CompactCeiling = 0;
    for (let c = 0; c < numCls; c++) if (clsWeeklyTotal[c] <= 1420) s2CompactCeiling++;
    s2CompactCeiling = Math.max(1, s2CompactCeiling);
    const s2GapNormRef = Math.max(1, Math.round(numCls * 1.8));
    function computeFastEnergy() {
      if (useExactObjective) {
        for (let i = 0; i < clsDayBuf.length; i++) clsDayBuf[i].length = 0;
        for (let i = 0; i < lecDayBuf.length; i++) lecDayBuf[i].length = 0;
        let early = 0, early0750 = 0, lateCount = 0, friViol = 0;
        for (let i = 0; i < n; i++) {
          const d = bitIdx.sessionDayIdx[i], st = bitIdx.sessionStart[i], en = bitIdx.sessionEnd[i];
          if (st < minPref) early++;
          if (st < EARLY_OVERFLOW_START) early0750++;
          if (en > WORK_END) lateCount++;
          if (d === 4 && friBreakActive && overlapsFridayPrayer("Jumat", st, en, sessDur[i])) friViol++;
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
              if (k === 0) {
                contMin = dur;
                contCnt = 1;
              } else {
                const prev = list[k - 1], prevEnd = bitIdx.sessionEnd[prev], curSt = bitIdx.sessionStart[cur];
                const rawGap = curSt - prevEnd;
                const dg = fastDeadGap(prevEnd, curSt, d);
                if (dg > 0) {
                  totalDeadGapMin += dg;
                  if (dg >= 100) clsLongGaps++;
                }
                if (rawGap === 0 && isPascaById[bitIdx.sessionRoomId[prev]] !== isPascaById[bitIdx.sessionRoomId[cur]]) bldSwitches++;
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
        const startPts = (n - early - early0750 * 0.5) / n * 25e3;
        const contigPts = (numCls - nonContig) / numCls * 25e3;
        const compactPts = Math.min(1, within3 / s2CompactCeiling) * 2e4;
        const gapPts = Math.max(0, 1 - (clsLongGaps + lecLongGaps) / s2GapNormRef) * 15e3;
        const compPen = asp.deadlocks * 2500 + asp.partials * 250 + marathons * 800 + isolatedCls * 600;
        const compPts = Math.max(0, 15e3 - compPen);
        const exactScore1000 = startPts + contigPts + compactPts + gapPts + compPts;
        const friPenalty = policy.protectFridayPrayer ? friViol * 3500 : 0;
        const wLecNow = studentLoneDayPenalty > 0 ? stage2LecIsoWeight : Math.round(stage2LecIsoWeight * 0.25);
        const smoothGuide = -classes5d * 18 - asp.overlapTicks * 0.45 - totalDeadGapMin * 0.015 - lecIso * wLecNow - bldSwitches * 0.05 - lateCount * 0.02 - friPenalty;
        const barrier = holes * 1200 + (studentLoneDayPenalty > 0 ? isolatedCls * 450 : 0);
        return 1e5 - (exactScore1000 + smoothGuide) + barrier;
      }
      let energy = 0;
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
        if (d === 4 && friBreakActive && overlapsFridayPrayer("Jumat", st, en, sessDur[i])) {
          energy += policy.hardFridayPrayer ? 5e3 : 500;
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
          if (holes > 0) energy += holes * 3200;
        }
        const minPerDay = policy.minCoursesPerActiveDay ?? 2;
        if (minPerDay >= 2) {
          let totalClsSess = 0;
          for (let d = 0; d < 5; d++) totalClsSess += clsDayBuf[base + d].length;
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
        if (minLecPerDay >= 2 && totalLecSess >= 2 && stage2LecIsoWeight > 0) {
          const wLecNow = studentLoneDayPenalty > 0 ? stage2LecIsoWeight : stage2LecIsoWeight >= 200 ? Math.round(stage2LecIsoWeight * 0.25) : 0;
          if (wLecNow > 0) {
            for (let d = 0; d < 5; d++) {
              if (lecDayBuf[base + d].length === 1) energy += wLecNow;
            }
          }
        }
      }
      if (policy.enforceAsprakWetLab) {
        const asp = bitIdx.countAsprakIssues();
        energy += asp.deadlocks * 1500 + asp.partials * hp.wAsprakPartial + asp.overlapTicks * 0.9;
      }
      return energy;
    }
    const movableIndices = [];
    for (let i = 0; i < n; i++) {
      if (pinnedMask[i] === 0) movableIndices.push(i);
    }
    let currentEnergy = computeFastEnergy();
    const initialEnergy = currentEnergy;
    let bestEnergy = currentEnergy;
    const bestDay = new Int32Array(bitIdx.sessionDayIdx);
    const bestStart = new Int32Array(bitIdx.sessionStart);
    const bestEnd = new Int32Array(bitIdx.sessionEnd);
    const bestRoom = new Int32Array(bitIdx.sessionRoomId);
    function saveBest() {
      bestEnergy = currentEnergy;
      bestDay.set(bitIdx.sessionDayIdx);
      bestStart.set(bitIdx.sessionStart);
      bestEnd.set(bitIdx.sessionEnd);
      bestRoom.set(bitIdx.sessionRoomId);
    }
    const L = Math.max(15, Math.round(hp.lahcLength));
    const lahcList = new Float64Array(L).fill(currentEnergy);
    let temp = hp.initTemp;
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
    const opWeights = [
      1,
      1 * hp.opScaleSwap,
      1.1 * hp.opScaleSwap,
      hp.opScaleConsolidate,
      1.4 * hp.opScaleSwap,
      hp.opScaleAsprak
    ];
    function pickOperator() {
      const sum = opWeights[0] + opWeights[1] + opWeights[2] + opWeights[3] + opWeights[4] + opWeights[5];
      let r = rng() * sum;
      for (let i = 0; i < 6; i++) {
        r -= opWeights[i];
        if (r <= 0) return i;
      }
      return 0;
    }
    function acceptCandidate(newEnergy, iter) {
      const v = iter % L;
      if (newEnergy <= currentEnergy || newEnergy <= lahcList[v]) {
        return true;
      }
      const delta = newEnergy - currentEnergy;
      if (temp > 1.5 && Math.exp(-delta / temp) > rng()) {
        return true;
      }
      return false;
    }
    function applySessionUpdate(idx, d, st, rid) {
      const en = st + sessions[idx].duration;
      bitIdx.place(idx, d, st, en, rid);
      sessions[idx].day = DAYS[d];
      sessions[idx].start = st;
      sessions[idx].end = en;
      sessions[idx].room = idToRoomName[rid];
    }
    const classToSessIndices = /* @__PURE__ */ new Map();
    const classTotalMin = /* @__PURE__ */ new Map();
    for (let i = 0; i < n; i++) {
      for (const c of sessions[i].classes) {
        const arr = classToSessIndices.get(c) || [];
        arr.push(i);
        classToSessIndices.set(c, arr);
        classTotalMin.set(c, (classTotalMin.get(c) || 0) + sessions[i].duration);
      }
    }
    const allClassKeys = Array.from(classToSessIndices.keys());
    function tryRandomDaySwap(aIdx, targetDay) {
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
        if (policy.enforcePascaMonWed && (isPascaById[bR] && targetDay > 2 || isPascaById[oR] && oD > 2)) continue;
        tried++;
        const bSt = bitIdx.sessionStart[b];
        bitIdx.unplace(aIdx);
        bitIdx.unplace(b);
        let aNewSt = -1;
        if (aMasks.has(bSt) && bitIdx.canPlaceHard(aIdx, targetDay, bR, aMasks.get(bSt), policy.enforceAsprakWetLab)) {
          aNewSt = bSt;
        } else {
          for (const st of aStarts) {
            if (bitIdx.canPlaceHard(aIdx, targetDay, bR, aMasks.get(st), policy.enforceAsprakWetLab)) {
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
          if (bMasks.has(oSt) && bitIdx.canPlaceHard(b, oD, oR, bMasks.get(oSt), policy.enforceAsprakWetLab)) {
            bNewSt = oSt;
          } else {
            for (const st of bStarts) {
              if (bitIdx.canPlaceHard(b, oD, oR, bMasks.get(st), policy.enforceAsprakWetLab)) {
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
    function tryBestDaySwap(aIdx, targetDay, forbidSameCls) {
      const oD = bitIdx.sessionDayIdx[aIdx];
      const oSt = bitIdx.sessionStart[aIdx];
      const oR = bitIdx.sessionRoomId[aIdx];
      if (oD === targetDay || pinnedMask[aIdx] === 1) return false;
      const aAllowed = allowedRoomIds[aIdx];
      const aStarts = stage2Starts[aIdx];
      const aMasks = startMasks[aIdx];
      let best = null;
      for (const b of movableIndices) {
        if (b === aIdx || bitIdx.sessionDayIdx[b] !== targetDay) continue;
        if (forbidSameCls && sessions[b].classes.includes(forbidSameCls)) continue;
        const bR = bitIdx.sessionRoomId[b];
        if (!aAllowed.includes(bR)) continue;
        if (!allowedRoomIds[b].includes(oR)) continue;
        if (policy.enforcePascaMonWed && (isPascaById[bR] && targetDay > 2 || isPascaById[oR] && oD > 2)) continue;
        const bSt = bitIdx.sessionStart[b];
        bitIdx.unplace(aIdx);
        bitIdx.unplace(b);
        const bMasks = startMasks[b];
        const bStarts = stage2Starts[b];
        const aCandStarts = aMasks.has(bSt) ? [bSt, ...aStarts.filter((x) => x !== bSt)] : aStarts;
        const bCandStarts = bMasks.has(oSt) ? [oSt, ...bStarts.filter((x) => x !== oSt)] : bStarts;
        let aPlacedSt = -1;
        for (const st of aCandStarts) {
          if (bitIdx.canPlaceHard(aIdx, targetDay, bR, aMasks.get(st), policy.enforceAsprakWetLab)) {
            aPlacedSt = st;
            break;
          }
        }
        if (aPlacedSt >= 0) {
          applySessionUpdate(aIdx, targetDay, aPlacedSt, bR);
          for (const bst of bCandStarts) {
            if (!bitIdx.canPlaceHard(b, oD, oR, bMasks.get(bst), policy.enforceAsprakWetLab)) continue;
            applySessionUpdate(b, oD, bst, oR);
            const e = computeFastEnergy();
            bitIdx.unplace(b);
            if (e < currentEnergy && (!best || e < best.energy)) {
              best = { b, aSt: aPlacedSt, bR, bSt: bst, energy: e };
            }
            break;
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
    function tryBridge3Cycle(aIdx, targetDay, forbidSameCls) {
      const oD = bitIdx.sessionDayIdx[aIdx];
      const oSt = bitIdx.sessionStart[aIdx];
      const oR = bitIdx.sessionRoomId[aIdx];
      if (oD === targetDay || pinnedMask[aIdx] === 1) return false;
      const dur = sessions[aIdx].duration;
      const aAllowed = allowedRoomIds[aIdx];
      const clsDayCnt = /* @__PURE__ */ new Map();
      for (const [k, list] of classToSessIndices.entries()) {
        const cnt = [0, 0, 0, 0, 0];
        for (const si of list) cnt[bitIdx.sessionDayIdx[si]]++;
        clsDayCnt.set(k, cnt);
      }
      const midOrder = [1, 2, 3, 0, 4].filter((d) => d !== oD && d !== targetDay);
      for (const midD of midOrder) {
        const bPool = [];
        const cPool = [];
        for (const si of movableIndices) {
          if (si === aIdx || sessions[si].duration !== dur) continue;
          if (forbidSameCls && sessions[si].classes.includes(forbidSameCls)) continue;
          const sd = bitIdx.sessionDayIdx[si];
          const sr = bitIdx.sessionRoomId[si];
          if (sd === targetDay) {
            if (!aAllowed.includes(sr)) continue;
            if (policy.enforcePascaMonWed && isPascaById[sr] && targetDay > 2) continue;
            const okB = sessions[si].classes.every((c) => {
              const cnt = clsDayCnt.get(c);
              return cnt[targetDay] >= 3 && cnt[midD] >= 1;
            });
            if (okB) bPool.push(si);
          } else if (sd === midD) {
            if (!allowedRoomIds[si].includes(oR)) continue;
            if (policy.enforcePascaMonWed && isPascaById[oR] && oD > 2) continue;
            const okC = sessions[si].classes.every((c) => {
              const cnt = clsDayCnt.get(c);
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
    function trySwapEvacuateDay(cls, outD, targetDays) {
      const toEvac = classToSessIndices.get(cls).filter((si) => bitIdx.sessionDayIdx[si] === outD && pinnedMask[si] === 0);
      if (toEvac.length === 0 || toEvac.length > 4) return false;
      const evacSet = new Set(toEvac);
      const savedState = [];
      const touched = /* @__PURE__ */ new Set();
      const snapshotOnce = (si) => {
        if (touched.has(si)) return;
        touched.add(si);
        savedState.push({
          si,
          d: bitIdx.sessionDayIdx[si],
          st: bitIdx.sessionStart[si],
          rid: bitIdx.sessionRoomId[si]
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
        snapshotOnce(aIdx);
        bitIdx.unplace(aIdx);
        let placedFree = false;
        for (const td of targetDays) {
          for (const rid of aAllowed) {
            if (policy.enforcePascaMonWed && isPascaById[rid] && td > 2) continue;
            for (const st of aStarts) {
              if (bitIdx.canPlaceHard(aIdx, td, rid, aMasks.get(st), policy.enforceAsprakWetLab)) {
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
        let bestSwap = null;
        for (const td of targetDays) {
          for (const b of movableIndices) {
            if (evacSet.has(b) || touched.has(b) || bitIdx.sessionDayIdx[b] !== td) continue;
            if (sessions[b].classes.includes(cls)) continue;
            const bR = bitIdx.sessionRoomId[b];
            if (!aAllowed.includes(bR) || !allowedRoomIds[b].includes(oR)) continue;
            if (policy.enforcePascaMonWed && (isPascaById[bR] && td > 2 || isPascaById[oR] && oD > 2)) continue;
            const bSt = bitIdx.sessionStart[b];
            bitIdx.unplace(aIdx);
            bitIdx.unplace(b);
            const bMasks = startMasks[b];
            const bStarts = stage2Starts[b];
            const aCand = aMasks.has(bSt) ? [bSt, ...aStarts.filter((x) => x !== bSt)] : aStarts;
            const bCand = bMasks.has(oSt) ? [oSt, ...bStarts.filter((x) => x !== oSt)] : bStarts;
            let aNewSt = -1;
            for (const st of aCand) {
              if (bitIdx.canPlaceHard(aIdx, td, bR, aMasks.get(st), policy.enforceAsprakWetLab)) {
                aNewSt = st;
                break;
              }
            }
            if (aNewSt >= 0) {
              applySessionUpdate(aIdx, td, aNewSt, bR);
              let bNewSt = -1;
              for (const bst of bCand) {
                if (bitIdx.canPlaceHard(b, oD, oR, bMasks.get(bst), policy.enforceAsprakWetLab)) {
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
    function tryReplaceLongLoneWithTwo100m(cls, ld, active, dayCounts) {
      const sList = classToSessIndices.get(cls);
      const loneSi = sList.find((si) => bitIdx.sessionDayIdx[si] === ld && pinnedMask[si] === 0);
      if (loneSi === void 0) return false;
      if (sessions[loneSi].duration < 150 || sessions[loneSi].roomType === "WET_LAB" || sessions[loneSi].roomType === "DRY_LAB") {
        return false;
      }
      const lOldD = ld, lOldSt = bitIdx.sessionStart[loneSi], lOldR = bitIdx.sessionRoomId[loneSi];
      const isMorningLone = lOldSt < 720;
      const pairSlots = isMorningLone ? [520, 620] : [780, 880];
      const donorDays = active.filter((d) => d !== ld && dayCounts[d] >= 3);
      for (const d2 of donorDays) {
        const d2Theory100 = sList.filter(
          (si) => bitIdx.sessionDayIdx[si] === d2 && pinnedMask[si] === 0 && sessions[si].duration === 100 && sessions[si].roomType !== "WET_LAB" && sessions[si].roomType !== "DRY_LAB" && allowedRoomIds[si].includes(lOldR)
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
            let pairPlaced = false;
            const orders = [
              [s1, s2],
              [s2, s1]
            ];
            for (const [first, second] of orders) {
              const m1 = startMasks[first].get(pairSlots[0]);
              const m2 = startMasks[second].get(pairSlots[1]);
              if (m1 && m2 && bitIdx.canPlaceHard(first, ld, lOldR, m1, policy.enforceAsprakWetLab)) {
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
            let lonePlaced = false;
            for (const rid of [r1, r2, ...allowedRoomIds[loneSi]]) {
              if (!allowedRoomIds[loneSi].includes(rid)) continue;
              if (policy.enforcePascaMonWed && isPascaById[rid] && d2 > 2) continue;
              for (const st of stage2Starts[loneSi]) {
                if (bitIdx.canPlaceHard(loneSi, d2, rid, startMasks[loneSi].get(st), policy.enforceAsprakWetLab)) {
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
            for (const targetRoom of [r1, r2, ...allowedRoomIds[loneSi]]) {
              if (!allowedRoomIds[loneSi].includes(targetRoom)) continue;
              if (policy.enforcePascaMonWed && isPascaById[targetRoom] && d2 > 2) continue;
              for (const st of stage2Starts[loneSi]) {
                const mask = startMasks[loneSi].get(st);
                const blks = bitIdx.findBlockers(loneSi, d2, targetRoom, mask);
                if (blks.length !== 1 || pinnedMask[blks[0]] === 1) continue;
                const x = blks[0];
                if (x === loneSi || x === s1 || x === s2) continue;
                if (bitIdx.sessionRoomId[x] !== targetRoom) continue;
                const xOldD = bitIdx.sessionDayIdx[x], xSt = bitIdx.sessionStart[x], xOldR = bitIdx.sessionRoomId[x];
                bitIdx.unplace(x);
                if (!bitIdx.canPlaceHard(loneSi, d2, targetRoom, mask, policy.enforceAsprakWetLab)) {
                  applySessionUpdate(x, xOldD, xSt, xOldR);
                  continue;
                }
                applySessionUpdate(loneSi, d2, st, targetRoom);
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
                if (!xPlaced) {
                  for (const altSt of stage2Starts[x]) {
                    const mx2 = startMasks[x].get(altSt);
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
    function tryUnlockAsprakAndPull(cls, ld, donors) {
      if (!policy.enforceAsprakWetLab || donors.length === 0) return false;
      const cid = bitIdx.clsToId.get(cls);
      if (cid === void 0) return false;
      const deps = bitIdx.dependentWetLabsByCls[cid];
      if (!deps || deps.length === 0) return false;
      const blockingWets = deps.filter((ws) => bitIdx.sessionDayIdx[ws] === ld);
      if (blockingWets.length === 0) return false;
      const baseEnergy = currentEnergy;
      const attemptPullDonor = () => {
        const prevCur = currentEnergy;
        currentEnergy = baseEnergy;
        for (const dIdx of donors) {
          const oD = bitIdx.sessionDayIdx[dIdx], oSt = bitIdx.sessionStart[dIdx], oR = bitIdx.sessionRoomId[dIdx];
          bitIdx.unplace(dIdx);
          for (const st of stage2Starts[dIdx]) {
            const mask = startMasks[dIdx].get(st);
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
          if (tryBestDaySwap(dIdx, ld, cls) || tryBridge3Cycle(dIdx, ld, cls)) {
            return true;
          }
        }
        currentEnergy = prevCur;
        return false;
      };
      for (const ws of blockingWets) {
        if (pinnedMask[ws] === 1) continue;
        const wsOldD = bitIdx.sessionDayIdx[ws], wsOldSt = bitIdx.sessionStart[ws], wsOldR = bitIdx.sessionRoomId[ws];
        const jrDays = /* @__PURE__ */ new Set([ld]);
        for (const jc of sessions[ws].classes) {
          const jl = classToSessIndices.get(jc);
          if (jl) {
            for (const si of jl) if (si !== ws) jrDays.add(bitIdx.sessionDayIdx[si]);
          }
        }
        const orderedWsDays = [ld, ...Array.from(jrDays).filter((d) => d !== ld)];
        for (const wd of orderedWsDays) {
          for (const wst of stage2Starts[ws]) {
            if (wd === wsOldD && wst === wsOldSt) continue;
            const wMask = startMasks[ws].get(wst);
            bitIdx.unplace(ws);
            if (!bitIdx.canPlaceHard(ws, wd, wsOldR, wMask, true)) {
              applySessionUpdate(ws, wsOldD, wsOldSt, wsOldR);
              continue;
            }
            applySessionUpdate(ws, wd, wst, wsOldR);
            if (attemptPullDonor()) return true;
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
                  for (const b of movableIndices) {
                    if (b === jd || b === ws || bitIdx.sessionDayIdx[b] !== ld) continue;
                    if (sessions[b].classes.includes(jc) || sessions[b].classes.includes(cls)) continue;
                    if (sessions[b].duration !== sessions[jd].duration) continue;
                    const bSt = bitIdx.sessionStart[b], bR = bitIdx.sessionRoomId[b];
                    if (!allowedRoomIds[jd].includes(bR) || !allowedRoomIds[b].includes(jdOldR)) continue;
                    if (policy.enforcePascaMonWed && (isPascaById[bR] && ld > 2 || isPascaById[jdOldR] && jdOldD > 2)) continue;
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
        for (const jc of sessions[ws].classes) {
          const jl = classToSessIndices.get(jc);
          if (!jl) continue;
          const jCounts = [0, 0, 0, 0, 0];
          for (const si of jl) jCounts[bitIdx.sessionDayIdx[si]]++;
          if (jCounts[ld] !== 2) continue;
          const jAct = [];
          for (let d = 0; d < 5; d++) if (jCounts[d] > 0) jAct.push(d);
          if (jAct.length < 2 || ld !== jAct[0] && ld !== jAct[jAct.length - 1]) continue;
          const jOnLd = jl.filter((si) => bitIdx.sessionDayIdx[si] === ld && pinnedMask[si] === 0);
          if (jOnLd.length !== 2) continue;
          const jOthers = jAct.filter((d) => d !== ld);
          const jSaved = jOnLd.map((si) => ({
            si,
            d: bitIdx.sessionDayIdx[si],
            st: bitIdx.sessionStart[si],
            rid: bitIdx.sessionRoomId[si]
          }));
          for (const sv of jSaved) bitIdx.unplace(sv.si);
          const jPlaced = [];
          let okJ = true;
          for (const sv of jSaved) {
            let ch = null;
            for (const td of jOthers) {
              for (const rid of allowedRoomIds[sv.si]) {
                if (policy.enforcePascaMonWed && isPascaById[rid] && td > 2) continue;
                for (const st of stage2Starts[sv.si]) {
                  if (bitIdx.canPlaceHard(sv.si, td, rid, startMasks[sv.si].get(st), true)) {
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
      for (const ws of blockingWets) {
        const ov = bitIdx.findSeniorOverlapsForWetLab(ws).filter(
          (co) => pinnedMask[co] === 0 && !sessions[co].classes.includes(cls) && bitIdx.sessionDayIdx[co] === ld
        );
        for (const co of ov) {
          const cOldD = bitIdx.sessionDayIdx[co], cOldSt = bitIdx.sessionStart[co], cOldR = bitIdx.sessionRoomId[co];
          const wsSt = bitIdx.sessionStart[ws], wsEn = bitIdx.sessionEnd[ws];
          const coCanLeaveLd = sessions[co].classes.every((cc) => {
            const cl = classToSessIndices.get(cc);
            if (!cl) return false;
            let cntLd = 0;
            for (const si of cl) if (bitIdx.sessionDayIdx[si] === ld) cntLd++;
            return cntLd >= 3;
          });
          if (coCanLeaveLd) {
            const coOtherDays = /* @__PURE__ */ new Set();
            for (const cc of sessions[co].classes) {
              const cl = classToSessIndices.get(cc);
              if (cl) {
                for (const si of cl) if (bitIdx.sessionDayIdx[si] !== ld) coOtherDays.add(bitIdx.sessionDayIdx[si]);
              }
            }
            for (const td of coOtherDays) {
              for (const cr of allowedRoomIds[co]) {
                if (policy.enforcePascaMonWed && isPascaById[cr] && td > 2) continue;
                for (const cst of stage2Starts[co]) {
                  const cMask = startMasks[co].get(cst);
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
          for (const cst of stage2Starts[co]) {
            if (cst < wsEn && wsSt < cst + sessions[co].duration) continue;
            const cMask = startMasks[co].get(cst);
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
          for (const b of movableIndices) {
            if (b === co || bitIdx.sessionDayIdx[b] !== ld || sessions[b].duration !== sessions[co].duration) continue;
            const bSt = bitIdx.sessionStart[b], bR = bitIdx.sessionRoomId[b];
            if (bSt < wsEn && wsSt < bSt + sessions[co].duration) continue;
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
    function tryEvacuateDay(cls, outlierDay, targetDays, allowEject) {
      const toEvac = classToSessIndices.get(cls).filter((si) => bitIdx.sessionDayIdx[si] === outlierDay && pinnedMask[si] === 0);
      if (toEvac.length === 0 || toEvac.length > 5) return false;
      const evacSet = new Set(toEvac);
      const saved = toEvac.map((si) => ({
        si,
        d: bitIdx.sessionDayIdx[si],
        st: bitIdx.sessionStart[si],
        rid: bitIdx.sessionRoomId[si]
      }));
      const extraEjected = [];
      for (const sv of saved) bitIdx.unplace(sv.si);
      const relocated = [];
      let allRelocated = true;
      for (const sv of saved) {
        let bestChoice = null;
        const rIds = allowedRoomIds[sv.si];
        const starts = stage2Starts[sv.si];
        const mMap = startMasks[sv.si];
        for (const td of targetDays) {
          for (const rid of rIds) {
            if (policy.enforcePascaMonWed && isPascaById[rid] && td > 2) continue;
            for (const st of starts) {
              if (!bitIdx.canPlaceHard(sv.si, td, rid, mMap.get(st), policy.enforceAsprakWetLab)) continue;
              const pen = (st < EARLY_OVERFLOW_START ? 2e3 : st < minPref ? 350 : 0) + (st + sessions[sv.si].duration > WORK_END ? 15 : 0);
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
        let rescued = false;
        if (allowEject) {
          ejectLoop: for (const td of targetDays) {
            for (const rid of rIds) {
              if (policy.enforcePascaMonWed && isPascaById[rid] && td > 2) continue;
              for (const st of starts) {
                const mask = mMap.get(st);
                const blks = bitIdx.findBlockers(sv.si, td, rid, mask);
                if (blks.length !== 1) continue;
                const blk = blks[0];
                if (pinnedMask[blk] === 1 || evacSet.has(blk) || relocated.includes(blk) || extraEjected.some((x) => x.si === blk)) continue;
                const bOldD = bitIdx.sessionDayIdx[blk], bOldSt = bitIdx.sessionStart[blk], bOldRid = bitIdx.sessionRoomId[blk];
                bitIdx.unplace(blk);
                if (!bitIdx.canPlaceHard(sv.si, td, rid, mask, policy.enforceAsprakWetLab)) {
                  bitIdx.place(blk, bOldD, bOldSt, bOldSt + sessions[blk].duration, bOldRid);
                  continue;
                }
                applySessionUpdate(sv.si, td, st, rid);
                let bAlt = null;
                const bDays = [bOldD, 0, 1, 2, 3, 4];
                const seenBD = /* @__PURE__ */ new Set();
                for (const bd of bDays) {
                  if (seenBD.has(bd)) continue;
                  seenBD.add(bd);
                  if (bd === outlierDay && sessions[blk].classes.includes(cls)) continue;
                  for (const br of allowedRoomIds[blk]) {
                    if (policy.enforcePascaMonWed && isPascaById[br] && bd > 2) continue;
                    for (const bs of stage2Starts[blk]) {
                      if (bitIdx.canPlaceHard(blk, bd, br, startMasks[blk].get(bs), policy.enforceAsprakWetLab)) {
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
            const sList = classToSessIndices.get(cls);
            if (sList.length < 2) continue;
            const dc = [0, 0, 0, 0, 0];
            for (const si of sList) dc[bitIdx.sessionDayIdx[si]]++;
            const act = [];
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
              const ds = /* @__PURE__ */ new Set();
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
        temp = Math.max(24, savedTemp);
      }
      iterations++;
      const op = pickOperator();
      let movedOk = false;
      if (op === 0) {
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
        if (bitIdx.canPlaceHard(idx, newD, newRid, mMap.get(newSt), policy.enforceAsprakWetLab)) {
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
        if (policy.enforcePascaMonWed && (isPascaById[bR] && bD > 2 || isPascaById[aR] && aD > 2)) continue;
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
        const mask = startMasks[idx].get(newSt);
        const blockers = bitIdx.findBlockers(idx, newD, newRid, mask);
        if (blockers.length !== 1 || pinnedMask[blockers[0]] === 1) continue;
        const blk = blockers[0];
        const bOldD = bitIdx.sessionDayIdx[blk], bOldSt = bitIdx.sessionStart[blk], bOldRid = bitIdx.sessionRoomId[blk];
        bitIdx.unplace(idx);
        bitIdx.unplace(blk);
        if (bitIdx.canPlaceHard(idx, newD, newRid, mask, policy.enforceAsprakWetLab)) {
          applySessionUpdate(idx, newD, newSt, newRid);
          let alt = null;
          const bRids = allowedRoomIds[blk];
          const bStarts = stage2Starts[blk];
          for (let tries = 0; tries < 22; tries++) {
            const td = Math.floor(rng() * 5);
            const tr = bRids[Math.floor(rng() * bRids.length)];
            if (policy.enforcePascaMonWed && isPascaById[tr] && td > 2) continue;
            const ts = bStarts[Math.floor(rng() * bStarts.length)];
            if (bitIdx.canPlaceHard(blk, td, tr, startMasks[blk].get(ts), policy.enforceAsprakWetLab)) {
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
        let targetCls = null;
        let outlierDay = -1;
        let loneDay = -1;
        let donorDays = [];
        let targetDays = [];
        const startScan = Math.floor(rng() * allClassKeys.length);
        for (let step = 0; step < allClassKeys.length; step++) {
          const cls = allClassKeys[(startScan + step) % allClassKeys.length];
          const sList = classToSessIndices.get(cls);
          if (sList.length < 2) continue;
          const dayCounts = [0, 0, 0, 0, 0];
          for (const si of sList) dayCounts[bitIdx.sessionDayIdx[si]]++;
          const active = [];
          for (let d = 0; d < 5; d++) if (dayCounts[d] > 0) active.push(d);
          if (active.length <= 1) continue;
          const span = active[active.length - 1] - active[0] + 1;
          const hasHole = span > active.length;
          const targetMax = (classTotalMin.get(cls) || 0) > 1420 ? 4 : policy.maxDaysPerClass;
          const singleDays = active.filter((d) => dayCounts[d] === 1);
          if (hasHole || !enteredPhase2B && active.length > targetMax) {
            targetCls = cls;
            const dFirst = active[0];
            const dLast = active[active.length - 1];
            outlierDay = dayCounts[dFirst] <= dayCounts[dLast] ? dFirst : dLast;
            const remaining = active.filter((d) => d !== outlierDay);
            const rMin = Math.min(...remaining);
            const rMax = Math.max(...remaining);
            const destSet = /* @__PURE__ */ new Set();
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
            const canEvac = outlierDay >= 0 && targetDays.length > 0;
            const canPull = donorDays.length > 0;
            const tryPullFirst = canPull && (!canEvac || rng() < 0.45);
            if (!tryPullFirst && canEvac) {
              const loneSess = classToSessIndices.get(targetCls).find((si) => bitIdx.sessionDayIdx[si] === loneDay && pinnedMask[si] === 0);
              if (loneSess !== void 0) {
                const oD = bitIdx.sessionDayIdx[loneSess], oSt = bitIdx.sessionStart[loneSess], oR = bitIdx.sessionRoomId[loneSess];
                const rIds = allowedRoomIds[loneSess];
                const starts = stage2Starts[loneSess];
                const mMap = startMasks[loneSess];
                bitIdx.unplace(loneSess);
                let found = null;
                for (let tries = 0; tries < 22; tries++) {
                  const td = targetDays[Math.floor(rng() * targetDays.length)];
                  const rid = rIds[Math.floor(rng() * rIds.length)];
                  if (policy.enforcePascaMonWed && isPascaById[rid] && td > 2) continue;
                  const st = starts[Math.floor(rng() * starts.length)];
                  if (bitIdx.canPlaceHard(loneSess, td, rid, mMap.get(st), policy.enforceAsprakWetLab)) {
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
                  const td = targetDays[Math.floor(rng() * targetDays.length)];
                  if (tryRandomDaySwap(loneSess, td)) movedOk = true;
                }
              }
            }
            if (!movedOk && canPull) {
              const donors = classToSessIndices.get(targetCls).filter((si) => donorDays.includes(bitIdx.sessionDayIdx[si]) && pinnedMask[si] === 0);
              if (donors.length > 0) {
                const dIdx = donors[Math.floor(rng() * donors.length)];
                const oD = bitIdx.sessionDayIdx[dIdx], oSt = bitIdx.sessionStart[dIdx], oR = bitIdx.sessionRoomId[dIdx];
                const rIds = allowedRoomIds[dIdx];
                const starts = stage2Starts[dIdx];
                const mMap = startMasks[dIdx];
                bitIdx.unplace(dIdx);
                let found = null;
                for (let tries = 0; tries < 22; tries++) {
                  const rid = rIds[Math.floor(rng() * rIds.length)];
                  if (policy.enforcePascaMonWed && isPascaById[rid] && loneDay > 2) continue;
                  const st = starts[Math.floor(rng() * starts.length)];
                  if (bitIdx.canPlaceHard(dIdx, loneDay, rid, mMap.get(st), policy.enforceAsprakWetLab)) {
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
                  if (tryRandomDaySwap(dIdx, loneDay)) movedOk = true;
                }
              }
            }
          } else if (outlierDay >= 0 && targetDays.length > 0) {
            if (tryEvacuateDay(targetCls, outlierDay, targetDays, false)) {
              movedOk = true;
            } else {
              const outs = classToSessIndices.get(targetCls).filter((si) => bitIdx.sessionDayIdx[si] === outlierDay && pinnedMask[si] === 0);
              if (outs.length > 0) {
                const sOut = outs[Math.floor(rng() * outs.length)];
                const td = targetDays[Math.floor(rng() * targetDays.length)];
                if (tryRandomDaySwap(sOut, td)) movedOk = true;
              }
            }
          }
        }
      } else if (op === 4) {
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
        const dayCandidates = [oldD, Math.max(0, oldD - 1), Math.min(4, oldD + 1)];
        bitIdx.unplace(targetIdx);
        let bestMove = null;
        for (const td of dayCandidates) {
          for (let si = 0; si < humaneStarts.length; si++) {
            const st = humaneStarts[si];
            const mask = mMap.get(st);
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
        const wStart = Math.floor(rng() * bitIdx.wetLabIndices.length);
        let targetWs = -1;
        let overlappingSeniors = [];
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
            const sIdx = movableOv[Math.floor(rng() * movableOv.length)];
            const oD = bitIdx.sessionDayIdx[sIdx], oSt = bitIdx.sessionStart[sIdx], oR = bitIdx.sessionRoomId[sIdx];
            const wsD = bitIdx.sessionDayIdx[targetWs], wsSt = bitIdx.sessionStart[targetWs], wsEn = bitIdx.sessionEnd[targetWs];
            const sRids = allowedRoomIds[sIdx];
            const sStarts = stage2Starts[sIdx];
            const mMap = startMasks[sIdx];
            bitIdx.unplace(sIdx);
            let found = null;
            for (let tries = 0; tries < 20; tries++) {
              const td = Math.floor(rng() * 5);
              const st = sStarts[Math.floor(rng() * sStarts.length)];
              if (td === wsD && st < wsEn && wsSt < st + sessions[sIdx].duration) continue;
              const rid = sRids[Math.floor(rng() * sRids.length)];
              if (policy.enforcePascaMonWed && isPascaById[rid] && td > 2) continue;
              if (bitIdx.canPlaceHard(sIdx, td, rid, mMap.get(st), true)) {
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
            const oD = bitIdx.sessionDayIdx[targetWs], oSt = bitIdx.sessionStart[targetWs], oR = bitIdx.sessionRoomId[targetWs];
            const wStarts = stage2Starts[targetWs];
            const mMap = startMasks[targetWs];
            bitIdx.unplace(targetWs);
            let found = null;
            for (let tries = 0; tries < 15; tries++) {
              const td = Math.floor(rng() * 5);
              const st = wStarts[Math.floor(rng() * wStarts.length)];
              if (td === oD && st === oSt) continue;
              if (bitIdx.canPlaceHard(targetWs, td, oR, mMap.get(st), true)) {
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
        temp = 28;
        stagnant = 0;
        reheats++;
      }
    }
    for (let i = 0; i < n; i++) bitIdx.unplace(i);
    for (let i = 0; i < n; i++) {
      applySessionUpdate(i, bestDay[i], bestStart[i], bestRoom[i]);
    }
    studentLoneDayPenalty = 1650;
    currentEnergy = computeFastEnergy();
    saveBest();
    function findLowestEnergyBlockerSlot(blk, bOldD, forbidDayForCls) {
      const activeDaySet = /* @__PURE__ */ new Set([bOldD]);
      for (const c of sessions[blk].classes) {
        const list = classToSessIndices.get(c);
        if (list) {
          for (const si of list) if (si !== blk && bitIdx.sessionDayIdx[si] >= 0) activeDaySet.add(bitIdx.sessionDayIdx[si]);
        }
      }
      const orderedDays = [bOldD, ...Array.from(activeDaySet).filter((x) => x !== bOldD)];
      const rIds = allowedRoomIds[blk];
      const starts = stage2Starts[blk];
      const mMap = startMasks[blk];
      let best = null;
      for (const bd of orderedDays) {
        if (forbidDayForCls && bd === forbidDayForCls.day && sessions[blk].classes.includes(forbidDayForCls.cls)) continue;
        for (const st of starts) {
          const mask = mMap.get(st);
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
    if (!skipStage2 && !skipStage3) {
      temp = 0;
      lahcList.fill(currentEnergy);
      for (let pass = 0; pass < 8; pass++) {
        let improvedInPass = false;
        for (const cls of allClassKeys) {
          const sList = classToSessIndices.get(cls);
          if (sList.length < 2) continue;
          const dayCounts = [0, 0, 0, 0, 0];
          for (const si of sList) dayCounts[bitIdx.sessionDayIdx[si]]++;
          const active = [];
          for (let d = 0; d < 5; d++) if (dayCounts[d] > 0) active.push(d);
          if (active.length <= 1) continue;
          const span0 = active[active.length - 1] - active[0] + 1;
          if (span0 > active.length) {
            let holeFixed = false;
            const candidates2 = [active[0], active[active.length - 1]];
            if (dayCounts[candidates2[1]] < dayCounts[candidates2[0]]) candidates2.reverse();
            for (const outD of candidates2) {
              const rem = active.filter((d) => d !== outD);
              const rMin = Math.min(...rem);
              const rMax = Math.max(...rem);
              const destSet = /* @__PURE__ */ new Set();
              for (let d = rMin; d <= rMax; d++) destSet.add(d);
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
                if (loneOut !== void 0) {
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
            if (!holeFixed) {
              const holeDays = [];
              for (let hd = active[0] + 1; hd < active[active.length - 1]; hd++) {
                if (dayCounts[hd] === 0) holeDays.push(hd);
              }
              if (holeDays.length === 1) {
                const hDay = holeDays[0];
                const donorPool = sList.filter((si) => dayCounts[bitIdx.sessionDayIdx[si]] >= 3 && pinnedMask[si] === 0);
                if (donorPool.length >= 2) {
                  const snap = [];
                  const seenSnap = /* @__PURE__ */ new Set();
                  const saveSi = (si) => {
                    if (seenSnap.has(si)) return;
                    seenSnap.add(si);
                    snap.push({ si, d: bitIdx.sessionDayIdx[si], st: bitIdx.sessionStart[si], rid: bitIdx.sessionRoomId[si] });
                  };
                  const movedDonors = [];
                  const localCnt = [...dayCounts];
                  for (const dIdx of donorPool) {
                    if (movedDonors.length >= 2) break;
                    const oD = bitIdx.sessionDayIdx[dIdx];
                    if (localCnt[oD] < 3) continue;
                    const oSt = bitIdx.sessionStart[dIdx], oR = bitIdx.sessionRoomId[dIdx];
                    let bestB = null;
                    for (const b of movableIndices) {
                      if (b === dIdx || seenSnap.has(b) || bitIdx.sessionDayIdx[b] !== hDay) continue;
                      if (sessions[b].classes.includes(cls) || sessions[b].duration !== sessions[dIdx].duration) continue;
                      const bR = bitIdx.sessionRoomId[b], bSt = bitIdx.sessionStart[b];
                      if (!allowedRoomIds[dIdx].includes(bR) || !allowedRoomIds[b].includes(oR)) continue;
                      if (policy.enforcePascaMonWed && (isPascaById[bR] && hDay > 2 || isPascaById[oR] && oD > 2)) continue;
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
              if (isExtreme && others.length > 0) {
                const loneSi = sList.find((si) => bitIdx.sessionDayIdx[si] === ld && pinnedMask[si] === 0);
                if (loneSi !== void 0) {
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
              if (sList.length >= 2 && sList.length <= 3 && active.length >= 2 && sList.every((si) => pinnedMask[si] === 0)) {
                const savedAll = sList.map((si) => ({
                  si,
                  d: bitIdx.sessionDayIdx[si],
                  st: bitIdx.sessionStart[si],
                  rid: bitIdx.sessionRoomId[si]
                }));
                const ownSet = new Set(sList);
                let packedAll = false;
                for (let td = 0; td < 5 && !packedAll; td++) {
                  for (const sv of savedAll) bitIdx.unplace(sv.si);
                  const placedHere = [];
                  const ejectedHere = [];
                  let okAll = true;
                  for (const sv of savedAll) {
                    let ch = null;
                    for (const rid of allowedRoomIds[sv.si]) {
                      if (policy.enforcePascaMonWed && isPascaById[rid] && td > 2) continue;
                      for (const st of stage2Starts[sv.si]) {
                        if (bitIdx.canPlaceHard(sv.si, td, rid, startMasks[sv.si].get(st), policy.enforceAsprakWetLab)) {
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
                    let rescued = false;
                    ejectPack: for (const rid of allowedRoomIds[sv.si]) {
                      if (policy.enforcePascaMonWed && isPascaById[rid] && td > 2) continue;
                      for (const st of stage2Starts[sv.si]) {
                        const mask = startMasks[sv.si].get(st);
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
              if (!isExtreme && active.length === 3 && dayCounts[active[0]] === 2 && dayCounts[active[2]] === 2) {
                if (tryEvacuateDay(cls, active[0], [active[1], active[2]], true) || tryEvacuateDay(cls, active[2], [active[0], active[1]], true)) {
                  improvedInPass = true;
                  lahcList.fill(currentEnergy);
                  break;
                }
              }
              const donors = sList.filter((si) => dayCounts[bitIdx.sessionDayIdx[si]] >= 3 && pinnedMask[si] === 0).sort((a, b) => sessions[a].duration - sessions[b].duration);
              let pulled = false;
              for (const dIdx of donors) {
                const oD = bitIdx.sessionDayIdx[dIdx], oSt = bitIdx.sessionStart[dIdx], oR = bitIdx.sessionRoomId[dIdx];
                bitIdx.unplace(dIdx);
                let bestP = null;
                for (const st of stage2Starts[dIdx]) {
                  const mask = startMasks[dIdx].get(st);
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
                let ejectedOk = false;
                ejectPull: for (const st of stage2Starts[dIdx]) {
                  const mask = startMasks[dIdx].get(st);
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
                if (tryBestDaySwap(dIdx, ld, cls) || tryBridge3Cycle(dIdx, ld, cls)) {
                  lahcList.fill(currentEnergy);
                  improvedInPass = true;
                  pulled = true;
                  break;
                }
              }
              if (pulled) break;
              if (tryReplaceLongLoneWithTwo100m(cls, ld, active, dayCounts)) {
                lahcList.fill(currentEnergy);
                improvedInPass = true;
                break;
              }
              if (tryUnlockAsprakAndPull(cls, ld, donors)) {
                lahcList.fill(currentEnergy);
                improvedInPass = true;
                break;
              }
            }
          }
          dayCounts.fill(0);
          for (const si of sList) dayCounts[bitIdx.sessionDayIdx[si]]++;
          active.length = 0;
          for (let d = 0; d < 5; d++) if (dayCounts[d] > 0) active.push(d);
          if (active.length <= 1) continue;
          const span = active[active.length - 1] - active[0] + 1;
          const hasHole = span > active.length;
          const targetMax = (classTotalMin.get(cls) || 0) > 1420 ? 4 : policy.maxDaysPerClass;
          if (!hasHole && active.length <= targetMax) continue;
          const candidates = [active[0], active[active.length - 1]];
          if (dayCounts[candidates[1]] < dayCounts[candidates[0]]) candidates.reverse();
          for (const outD of candidates) {
            const rem = active.filter((d) => d !== outD);
            const rMin = Math.min(...rem);
            const rMax = Math.max(...rem);
            const destSet = /* @__PURE__ */ new Set();
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
        if ((policy.minCoursesPerActiveDay ?? 2) >= 2) {
          const lecToSess = /* @__PURE__ */ new Map();
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
              if (loneSi === void 0) continue;
              const otherLecDays = [];
              for (let od = 0; od < 5; od++) if (od !== d && lCounts[od] > 0) otherLecDays.push(od);
              if (otherLecDays.length === 0) continue;
              const oD = bitIdx.sessionDayIdx[loneSi], oSt = bitIdx.sessionStart[loneSi], oR = bitIdx.sessionRoomId[loneSi];
              bitIdx.unplace(loneSi);
              let bestL = null;
              for (const td of otherLecDays) {
                for (const st of stage2Starts[loneSi]) {
                  const mask = startMasks[loneSi].get(st);
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
        if (policy.enforceAsprakWetLab) {
          for (const ws of bitIdx.wetLabIndices) {
            const ov = bitIdx.findSeniorOverlapsForWetLab(ws);
            if (ov.length === 0) continue;
            if (pinnedMask[ws] === 0) {
              const oD = bitIdx.sessionDayIdx[ws], oSt = bitIdx.sessionStart[ws], oR = bitIdx.sessionRoomId[ws];
              const wStarts = stage2Starts[ws];
              const mMap = startMasks[ws];
              bitIdx.unplace(ws);
              let bestW = null;
              for (let td = 0; td < 5; td++) {
                for (const st of wStarts) {
                  if (td === oD && st === oSt) continue;
                  if (!bitIdx.canPlaceHard(ws, td, oR, mMap.get(st), true)) continue;
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
            for (const sIdx of ov) {
              if (pinnedMask[sIdx] === 1) continue;
              const oD = bitIdx.sessionDayIdx[sIdx], oSt = bitIdx.sessionStart[sIdx], oR = bitIdx.sessionRoomId[sIdx];
              const rIds = allowedRoomIds[sIdx];
              const starts = stage2Starts[sIdx];
              const mMap = startMasks[sIdx];
              bitIdx.unplace(sIdx);
              let bestS = null;
              for (let td = 0; td < 5; td++) {
                for (const st of starts) {
                  const mask = mMap.get(st);
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
        for (const idx of movableIndices) {
          const oldD = bitIdx.sessionDayIdx[idx];
          const oldSt = bitIdx.sessionStart[idx];
          const oldRid = bitIdx.sessionRoomId[idx];
          const rIds = allowedRoomIds[idx];
          const starts = stage2Starts[idx];
          const mMap = startMasks[idx];
          bitIdx.unplace(idx);
          let bestLocal = null;
          for (const st of starts) {
            if (st === oldSt) continue;
            const mask = mMap.get(st);
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
    for (let i = 0; i < n; i++) {
      sessions[i].day = DAYS[bestDay[i]];
      sessions[i].start = bestStart[i];
      sessions[i].end = bestEnd[i];
      sessions[i].room = idToRoomName[bestRoom[i]];
    }
    const moves = [];
    for (let i = 0; i < n; i++) {
      const a = initialSessions[i];
      const b = sessions[i];
      if (a.day !== b.day || a.start !== b.start || a.room !== b.room) {
        moves.push({
          id: b.id,
          namaMk: b.namaMk,
          kelasRaw: b.kelasRaw,
          from: { day: a.day, start: a.start, end: a.end, room: a.room },
          to: { day: b.day, start: b.start, end: b.end, room: b.room }
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
        algorithm: "IFS-CBS + H-ALNS-LAHC+SA+Kempe (TypeScript 160-bit 5m Bitmask)",
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
        finalEnergy: Math.round(bestEnergy)
      }
    };
  }
  function inspectPlacementDynamic(session, day, start, room, placed, cohortMap, policy) {
    const end = start + session.duration;
    const policyErrors = [];
    const maxEnd = session.duration > 300 || session.end > CAMPUS_END ? 1160 : CAMPUS_END;
    if (start < CAMPUS_START || end > maxEnd) policyErrors.push("Di luar jam kampus");
    if (policy.protectIshoma && overlapsIshoma(start, end, session.duration)) {
      policyErrors.push("Melanggar jam ISHOMA 12:00-13:00");
    }
    if (session.roomType === "WET_LAB" || session.roomType === "DRY_LAB") {
      if (room !== (session.originalRoom || session.room)) {
        policyErrors.push(`Praktikum wajib di ${session.originalRoom || session.room}`);
      }
    } else if (!isGeneralRoom(room) && !(policy.allowDryLabOverflow && (session.prodi === "IF" || session.prodi === "SD") && SD_IF_DRY_LABS.has(room.toUpperCase()))) {
      policyErrors.push("Kuliah teori tidak boleh memakai lab milik prodi lain");
    }
    if (policy.enforcePascaMonWed && isPascaRoom(room) && !PASCA_ALLOWED_DAYS.has(day)) {
      policyErrors.push("Gedung Pasca hanya diizinkan Senin-Rabu");
    }
    const hardBlockers = [];
    const blockerSet = /* @__PURE__ */ new Set();
    const addBlocker = (other, reason) => {
      if (!blockerSet.has(other.id)) {
        blockerSet.add(other.id);
        hardBlockers.push({ session: other, reasons: [reason] });
      }
    };
    for (const o of placed) {
      if (!o || o.id === session.id) continue;
      if (!overlaps(day, start, end, o.day, o.start, o.end)) continue;
      if (o.room === room) addBlocker(o, "Ruang bentrok");
      if (session.dosen && o.dosen === session.dosen) addBlocker(o, "Dosen bentrok");
      if (sharesClass(session.classes, o.classes)) addBlocker(o, "Kelas bentrok");
    }
    let asprakDeadlock = false;
    let asprakPartial = false;
    const asprakBlockers = [];
    if (policy.hardFridayPrayer && overlapsFridayPrayer(day, start, end, session.duration)) {
      policyErrors.push("Melanggar Jeda Salat Jumat (11:30-13:00)");
    }
    if (policy.enforceAsprakWetLab && session.isWetLab) {
      const seniors = getSeniorCohortClasses(session, cohortMap);
      if (seniors.length > 0) {
        const busyBySenior = /* @__PURE__ */ new Map();
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
        const busySeniors = /* @__PURE__ */ new Set();
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
    if (asprakDeadlock) policyErrors.push("Deadlock Asprak Wet Lab");
    return { hardBlockers, policyErrors, asprakDeadlock, asprakPartial, asprakBlockers };
  }
  function quickHumaneSlotCost(session, day, start, room, placed, policy) {
    const minPref = policy.preferredMinStart ?? HUMANE_START;
    let cost = 0;
    if (start < EARLY_OVERFLOW_START) cost += 600;
    else if (start < minPref) cost += 180;
    if (policy.preferWorkingHours && start + session.duration > WORK_END) cost += 20;
    const dIdx = DAY_INDEX[day];
    for (const c of session.classes) {
      const activeSet = /* @__PURE__ */ new Set([dIdx]);
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
  function evaluateCandidateSlots(sessions, sessionId, rooms, policyInput) {
    const t0 = performance.now();
    const policy = { ...DEFAULT_POLICY, ...policyInput || {} };
    const target = sessions.find((s) => s.id === sessionId);
    if (!target) return { sessionId, slots: [], topSafeSlots: [], safeCount: 0, repairableCount: 0, latencyMs: 0 };
    const cohortMap = buildCohortMap(sessions);
    const allowedRooms = new Set(getAllowedRooms(target, rooms, policy));
    const starts = getHumaneStarts(target.duration, policy, true);
    const slots = [];
    const safeList = [];
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
              day,
              start,
              end,
              room,
              status: "FORBIDDEN",
              reason: target.isPraktikum ? `Praktikum wajib di ${target.originalRoom || target.room}` : "Ruang lab khusus",
              blockerCount: 0,
              softCost: Infinity,
              isCurrent
            });
            continue;
          }
          if (pascaBlocked) {
            slots.push({
              day,
              start,
              end,
              room,
              status: "FORBIDDEN",
              reason: "Regulasi Pasca: hanya Senin-Rabu",
              blockerCount: 0,
              softCost: Infinity,
              isCurrent
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
            const item = {
              day,
              start,
              end,
              room,
              status: "SAFE",
              reason: start < (policy.preferredMinStart ?? HUMANE_START) ? "Slot aman (jam pagi <08:40)" : "Slot aman manusiawi (>=08:40)",
              blockerCount: 0,
              softCost,
              isCurrent
            };
            slots.push(item);
            if (!isCurrent) safeList.push(item);
          } else if (!hasPinnedBlocker && uniqueBlockers.length > 0 && uniqueBlockers.length <= 2 && chk.policyErrors.every((e) => e.includes("Asprak"))) {
            const softCost = quickHumaneSlotCost(target, day, start, room, sessions, policy) + uniqueBlockers.length * 45;
            slots.push({
              day,
              start,
              end,
              room,
              status: "REPAIRABLE",
              reason: `Auto-geser ${uniqueBlockers.length} sesi (${uniqueBlockers.map((b) => b.namaMk).join(", ")})`,
              blockerCount: uniqueBlockers.length,
              blockerIds: uniqueBlockers.map((b) => b.id),
              softCost,
              isCurrent
            });
          } else {
            slots.push({
              day,
              start,
              end,
              room,
              status: "FORBIDDEN",
              reason: hasPinnedBlocker ? "Bentrok dengan slot terkunci (Pin Dosen S3)" : chk.policyErrors[0] || "Melanggar aturan keras",
              blockerCount: uniqueBlockers.length,
              softCost: Infinity,
              isCurrent
            });
          }
        }
      }
    }
    safeList.sort((a, b) => a.softCost - b.softCost);
    const topSafeSlots = [];
    const seenKey = /* @__PURE__ */ new Set();
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
      repairableCount: slots.filter((x) => x.status === "REPAIRABLE").length,
      latencyMs: Number((performance.now() - t0).toFixed(2))
    };
  }
  function planMinimalRepair(initialSessions, sessionId, targetDay, targetStart, targetRoom, rooms, policyInput) {
    const t0 = performance.now();
    const policy = { ...DEFAULT_POLICY, ...policyInput || {} };
    const working = cloneSessions(initialSessions);
    const cohortMap = buildCohortMap(working);
    const idx = working.findIndex((s) => s.id === sessionId);
    if (idx < 0) return { feasible: false, reason: "Sesi tidak ditemukan", latencyMs: 0 };
    const target = working[idx];
    const orig = { day: target.day, start: target.start, end: target.end, room: target.room };
    const targetEnd = targetStart + target.duration;
    const chkInit = inspectPlacementDynamic(target, targetDay, targetStart, targetRoom, working, cohortMap, policy);
    const nonAsprakErr = chkInit.policyErrors.filter((e) => !e.includes("Asprak"));
    if (nonAsprakErr.length > 0) {
      return { feasible: false, reason: nonAsprakErr.join("; "), latencyMs: Number((performance.now() - t0).toFixed(2)) };
    }
    const directBlockers = Array.from(
      new Map([...chkInit.hardBlockers.map((b) => b.session), ...chkInit.asprakBlockers].map((b) => [b.id, b])).values()
    );
    if (directBlockers.some((b) => b.pinned)) {
      return { feasible: false, reason: "Slot bentrok dengan jadwal terkunci (Pin Dosen S3)", latencyMs: Number((performance.now() - t0).toFixed(2)) };
    }
    working[idx] = { ...target, day: targetDay, start: targetStart, end: targetEnd, room: targetRoom };
    const moves = [
      {
        id: target.id,
        namaMk: target.namaMk,
        kelasRaw: target.kelasRaw,
        role: "PRIMARY",
        from: orig,
        to: { day: targetDay, start: targetStart, end: targetEnd, room: targetRoom }
      }
    ];
    if (directBlockers.length === 0) {
      const directAudit = auditSchedule(working, policy);
      if (!directAudit.hardFeasible) {
        return {
          feasible: false,
          reason: "Post-repair hard feasibility gate rejected direct placement (Asprak/Policy)",
          latencyMs: Number((performance.now() - t0).toFixed(2))
        };
      }
      return {
        feasible: true,
        strategy: "DIRECT_SAFE",
        perturbationCount: 0,
        totalMoved: 1,
        moves,
        sessions: working,
        latencyMs: Number((performance.now() - t0).toFixed(2))
      };
    }
    const lockedIds = /* @__PURE__ */ new Set([target.id, ...working.filter((s) => s.pinned).map((s) => s.id)]);
    function findFreeSlot(sess, list) {
      const allowed = getAllowedRooms(sess, rooms, policy);
      const starts = getHumaneStarts(sess.duration, policy, true);
      let best = null;
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
    let strategy = "LOCAL_1_STEP";
    for (const blk of directBlockers) {
      const free = findFreeSlot(blk, pool);
      if (free) {
        pool.push({ ...blk, day: free.day, start: free.start, end: free.start + blk.duration, room: free.room });
        lockedIds.add(blk.id);
        moves.push({
          id: blk.id,
          namaMk: blk.namaMk,
          kelasRaw: blk.kelasRaw,
          role: "REPAIRED_1STEP",
          from: { day: blk.day, start: blk.start, end: blk.end, room: blk.room },
          to: { day: free.day, start: free.start, end: free.start + blk.duration, room: free.room }
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
            if (chk.policyErrors.some((e) => !e.includes("Asprak"))) continue;
            const cList = Array.from(
              new Map([...chk.hardBlockers.map((x) => x.session), ...chk.asprakBlockers].map((x) => [x.id, x])).values()
            );
            if (cList.length !== 1 || lockedIds.has(cList[0].id)) continue;
            const cSess = cList[0];
            const tempPool = pool.filter((p) => p.id !== cSess.id);
            const placedBlk = { ...blk, day, start, end: start + blk.duration, room };
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
              strategy = "KEMPE_2_STEP";
              moves.push({
                id: blk.id,
                namaMk: blk.namaMk,
                kelasRaw: blk.kelasRaw,
                role: "REPAIRED_2STEP",
                from: { day: blk.day, start: blk.start, end: blk.end, room: blk.room },
                to: { day, start, end: start + blk.duration, room }
              });
              moves.push({
                id: cSess.id,
                namaMk: cSess.namaMk,
                kelasRaw: cSess.kelasRaw,
                role: "KEMPE_CHAIN",
                from: { day: cSess.day, start: cSess.start, end: cSess.end, room: cSess.room },
                to: { day: freeC.day, start: freeC.start, end: freeC.start + cSess.duration, room: freeC.room }
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
        reason: "Post-repair hard feasibility gate rejected repair chain (Asprak/Policy)",
        latencyMs: Number((performance.now() - t0).toFixed(2))
      };
    }
    return {
      feasible: true,
      strategy,
      perturbationCount: moves.length - 1,
      totalMoved: moves.length,
      moves,
      sessions: pool,
      latencyMs: Number((performance.now() - t0).toFixed(2))
    };
  }
  function autoFixAllConflicts(initialSessions, rooms, policyInput, options = {}) {
    const t0 = performance.now();
    const policy = { ...DEFAULT_POLICY, ...policyInput || {} };
    const fixPoliciesToo = options.fixPoliciesToo !== void 0 ? Boolean(options.fixPoliciesToo) : true;
    const working = cloneSessions(initialSessions);
    const cohortMap = buildCohortMap(working);
    const movedMap = /* @__PURE__ */ new Map();
    const skipped = /* @__PURE__ */ new Set();
    function recordMove(orig, day, start, room, role) {
      const prev = movedMap.get(orig.id);
      if (!prev) {
        movedMap.set(orig.id, {
          id: orig.id,
          namaMk: orig.namaMk,
          kelasRaw: orig.kelasRaw,
          role,
          from: { day: orig.day, start: orig.start, end: orig.end, room: orig.room },
          to: { day, start, end: start + orig.duration, room }
        });
      } else {
        prev.to = { day, start, end: start + orig.duration, room };
      }
    }
    function findBestDirectSlot(s, evalPol) {
      const allowed = getAllowedRooms(s, rooms, evalPol);
      const starts = getHumaneStarts(s.duration, evalPol, true);
      let best = null;
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
    function tryKempeRepairForSession(s, evalPol, role) {
      const allowed = getAllowedRooms(s, rooms, evalPol);
      const starts = getHumaneStarts(s.duration, evalPol, true);
      for (const day of DAYS) {
        for (const room of allowed) {
          if (evalPol.enforcePascaMonWed && isPascaRoom(room) && !PASCA_ALLOWED_DAYS.has(day)) continue;
          for (const start of starts) {
            const chk = inspectPlacementDynamic(s, day, start, room, working, cohortMap, evalPol);
            if (chk.policyErrors.some((e) => !e.includes("Asprak"))) continue;
            const blks = Array.from(
              new Map([...chk.hardBlockers.map((b) => b.session), ...chk.asprakBlockers].map((b) => [b.id, b])).values()
            );
            if (blks.length !== 1 || blks[0].pinned) continue;
            const blk = blks[0];
            const sIdx = working.findIndex((x) => x.id === s.id);
            const bIdx = working.findIndex((x) => x.id === blk.id);
            const origS = { ...working[sIdx] };
            const origB = { ...working[bIdx] };
            const tempPlaced = working.filter((x) => x.id !== blk.id);
            tempPlaced[tempPlaced.findIndex((x) => x.id === s.id)] = {
              ...s,
              day,
              start,
              end: start + s.duration,
              room
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
            const bAllowed = getAllowedRooms(blk, rooms, evalPol);
            const bStarts = getHumaneStarts(blk.duration, evalPol, true);
            let bestB = null;
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
      let chosen = null;
      if (aud.hardConflicts.length > 0) {
        const deg = /* @__PURE__ */ new Map();
        for (const c of aud.hardConflicts) {
          deg.set(c.aId, (deg.get(c.aId) || 0) + 1);
          deg.set(c.bId, (deg.get(c.bId) || 0) + 1);
        }
        const ids = Array.from(deg.entries()).sort((a, b) => b[1] - a[1]).map(([id]) => id);
        for (const id of ids) {
          if (skipped.has(`H:${id}`)) continue;
          const s2 = working.find((x) => x.id === id);
          if (s2 && !s2.pinned) {
            chosen = { session: s2, role: "AUTO_FIX_CONFLICT", phase: "H" };
            break;
          }
        }
      } else if (fixPoliciesToo && policy.enforcePascaMonWed && aud.pascaViolations.length > 0) {
        for (const pv of aud.pascaViolations) {
          if (skipped.has(`P:${pv.sessionId}`)) continue;
          const s2 = working.find((x) => x.id === pv.sessionId);
          if (s2 && !s2.pinned) {
            chosen = { session: s2, role: "FIX_PASCA_POLICY", phase: "P" };
            break;
          }
        }
      } else if (fixPoliciesToo && policy.enforceAsprakWetLab && aud.asprakDeadlocks.length > 0) {
        for (const ad of aud.asprakDeadlocks) {
          if (skipped.has(`A:${ad.sessionId}`)) continue;
          const s2 = working.find((x) => x.id === ad.sessionId);
          if (s2 && !s2.pinned) {
            chosen = { session: s2, role: "FIX_ASPRAK_DEADLOCK", phase: "A" };
            break;
          }
        }
      } else {
        break;
      }
      if (!chosen) break;
      const { session: s, role, phase } = chosen;
      const evalPol = {
        ...policy,
        enforcePascaMonWed: fixPoliciesToo ? policy.enforcePascaMonWed : false,
        enforceAsprakWetLab: fixPoliciesToo ? policy.enforceAsprakWetLab : false
      };
      const best = findBestDirectSlot(s, evalPol);
      if (best) {
        const idx = working.findIndex((x) => x.id === s.id);
        recordMove(s, best.day, best.start, best.room, role);
        working[idx] = { ...s, day: best.day, start: best.start, end: best.start + s.duration, room: best.room };
        continue;
      }
      if (tryKempeRepairForSession(s, evalPol, role)) {
        continue;
      }
      if (phase === "A") {
        const seniors = getSeniorCohortClasses(s, cohortMap);
        let unlockedBySenior = false;
        for (const seniorCls of seniors) {
          const blockingSeniorSessions = working.filter(
            (o) => o.id !== s.id && !o.pinned && overlaps(s.day, s.start, s.end, o.day, o.start, o.end) && o.classes.includes(seniorCls)
          );
          if (blockingSeniorSessions.length === 0 || blockingSeniorSessions.length > 2) continue;
          const snapshot = cloneSessions(working);
          let allMoved = true;
          const seniorMoves = [];
          for (const bs of blockingSeniorSessions) {
            const curBs = working.find((x) => x.id === bs.id);
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
              recordMove(sm.orig, sm.to.day, sm.to.start, sm.to.room, "FIX_ASPRAK_SENIOR_SHIFT");
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
      feasible: afterAudit.hardConflictCount === 0 && (!fixPoliciesToo || afterAudit.pascaViolationCount === 0 && afterAudit.asprakDeadlockCount === 0),
      perturbationCount: moves.length,
      moves,
      sessions: working,
      audit: afterAudit,
      latencyMs: Number((performance.now() - t0).toFixed(2))
    };
  }
  function generateUasSchedule(sessions, rooms, options = {}) {
    const t0 = performance.now();
    const durationMin = options.durationMin === 60 ? 60 : 100;
    const maxExamsPerDay = options.maxExamsPerDay || 2;
    const enforcePascaMonWed = options.enforcePascaMonWed !== void 0 ? options.enforcePascaMonWed : true;
    const examWeeks = options.examWeeks || 2;
    const examSlots = durationMin === 60 ? [
      { idx: 0, start: 520, end: 580, label: "08:40 - 09:40" },
      { idx: 1, start: 600, end: 660, label: "10:00 - 11:00" },
      { idx: 2, start: 780, end: 840, label: "13:00 - 14:00" },
      { idx: 3, start: 860, end: 920, label: "14:20 - 15:20" },
      { idx: 4, start: 940, end: 1e3, label: "15:40 - 16:40" }
    ] : [
      { idx: 0, start: 520, end: 620, label: "08:40 - 10:20" },
      { idx: 1, start: 620, end: 720, label: "10:20 - 12:00" },
      { idx: 2, start: 780, end: 880, label: "13:00 - 14:40" },
      { idx: 3, start: 890, end: 990, label: "14:50 - 16:30" }
    ];
    const examDays = [];
    for (let w = 1; w <= examWeeks; w++) {
      for (const d of DAYS) {
        examDays.push({
          key: `M${w}-${d}`,
          week: w,
          day: d,
          label: `Minggu ${w}, ${d}`,
          isPascaOpen: !enforcePascaMonWed || PASCA_ALLOWED_DAYS.has(d)
        });
      }
    }
    const examRooms = rooms.filter((r) => r.type === "PASCA" || r.type === "SAINTEK");
    const examCourses = sessions.filter((s) => s.isExamEligible !== false && !/^Praktikum\s+/i.test(s.namaMk));
    const clsCount = /* @__PURE__ */ new Map();
    const lecCount = /* @__PURE__ */ new Map();
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
    const roomBusy = /* @__PURE__ */ new Set();
    const lecBusy = /* @__PURE__ */ new Set();
    const clsSlotBusy = /* @__PURE__ */ new Set();
    const clsDayCount = /* @__PURE__ */ new Map();
    const dayTotalLoad = /* @__PURE__ */ new Map();
    const placedExams = [];
    const unplacedExams = [];
    for (const course of ordered) {
      let best = null;
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
        const availRooms = examRooms.filter((r) => ed.isPascaOpen || r.type !== "PASCA");
        for (const sl of examSlots) {
          if (ed.day === "Jumat" && sl.start < 780 && sl.end > 690) continue;
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
            const score = maxCurrentOnDay * 40 + (dayTotalLoad.get(ed.key) || 0) * 1.4 + sl.idx * 3 + (ed.isPascaOpen && rm.type === "SAINTEK" ? 2 : 0);
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
          room
        });
      } else {
        unplacedExams.push(course);
      }
    }
    let maxObservedPerDay = 0;
    for (const v of clsDayCount.values()) if (v > maxObservedPerDay) maxObservedPerDay = v;
    placedExams.sort((a, b) => {
      if (a.week !== b.week) return Number(a.week) - Number(b.week);
      if (DAY_INDEX[a.day] !== DAY_INDEX[b.day]) {
        return DAY_INDEX[a.day] - DAY_INDEX[b.day];
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
        isPascaOpen: ed.isPascaOpen
      })),
      latencyMs: Number((performance.now() - t0).toFixed(2))
    };
  }
  function deepPolishSchedule(initialSessions, rooms, policyInput, options = {}) {
    const t0 = performance.now();
    const policy = { ...DEFAULT_POLICY, ...policyInput || {} };
    const seed = options.seed !== void 0 ? options.seed : 27;
    const maxIters = options.maxIters !== void 0 ? options.maxIters : 24e4;
    const timeBudgetMs = options.timeBudgetMs !== void 0 ? options.timeBudgetMs : 2600;
    const wScale = options.weightScale !== void 0 ? options.weightScale : 1;
    const lecIsoWeight = (options.lecturerIsolatedWeight !== void 0 ? options.lecturerIsolatedWeight : 0.35) * wScale;
    const useSurrogateObjective = Boolean(options.useSurrogateObjective);
    const disableHalfDayRepack = Boolean(options.disableHalfDayRepack);
    const disableOscillation = Boolean(options.disableOscillation);
    const rng = mulberry322(seed + 7919);
    const sessions = cloneSessions(initialSessions);
    const diffRef = options.baselineForDiff || initialSessions;
    const n = sessions.length;
    const roomNames = rooms.map((r) => r.name);
    const bitIdx = new BitmaskIndex(sessions, roomNames);
    bitIdx.hardFridayPrayer = Boolean(policy.hardFridayPrayer);
    const isPascaById = new Uint8Array(roomNames.length + 10);
    const idToRoomName = [];
    for (const [rn, rid] of bitIdx.roomToId.entries()) {
      idToRoomName[rid] = rn;
      if (isPascaRoom(rn)) isPascaById[rid] = 1;
    }
    const allowedRoomIds = new Array(n);
    const candidateStarts = new Array(n);
    const startMasks = new Array(n);
    const pinnedMask = new Uint8Array(n);
    const sessDur = new Int32Array(n);
    const minPref = policy.preferredMinStart ?? HUMANE_START;
    let initMinStart = 1440;
    for (let i = 0; i < n; i++) {
      const s = sessions[i];
      sessDur[i] = s.duration;
      if (s.pinned) pinnedMask[i] = 1;
      if (s.start < initMinStart) initMinStart = s.start;
      const rid = bitIdx.roomToId.get(s.room);
      bitIdx.place(i, DAY_INDEX[s.day], s.start, s.end, rid);
    }
    const floorStart = initMinStart >= minPref ? minPref : initMinStart >= EARLY_OVERFLOW_START ? EARLY_OVERFLOW_START : CAMPUS_START;
    for (let i = 0; i < n; i++) {
      const s = sessions[i];
      const rNames = getAllowedRooms(s, rooms, policy);
      allowedRoomIds[i] = rNames.map((rn) => bitIdx.roomToId.get(rn)).filter((id) => id !== void 0);
      const starts = getHumaneStarts(s.duration, policy, true).filter((st) => st >= floorStart);
      candidateStarts[i] = starts.length > 0 ? starts : [s.start];
      const mMap = /* @__PURE__ */ new Map();
      for (const st of candidateStarts[i]) mMap.set(st, makeSlotMask(st, st + s.duration));
      if (!mMap.has(s.start)) mMap.set(s.start, makeSlotMask(s.start, s.end));
      startMasks[i] = mMap;
    }
    const movableIndices = [];
    const classToSessIndices = /* @__PURE__ */ new Map();
    const classTotalMin = /* @__PURE__ */ new Map();
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
    const clsDayBuf = Array.from({ length: numCls * 5 }, () => []);
    const lecDayBuf = Array.from({ length: numLec * 5 }, () => []);
    const friBreakActive = Boolean(policy.protectFridayPrayer || policy.hardFridayPrayer);
    let dynamicCompactCeiling = 0;
    for (const [, tot] of classTotalMin.entries()) {
      if (tot <= 1420) dynamicCompactCeiling++;
    }
    dynamicCompactCeiling = Math.max(1, dynamicCompactCeiling);
    const dynamicGapNormRef = Math.max(1, Math.round(numCls * 1.8));
    function sortByStart(arr) {
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
    function fastDeadGap(prevEnd, nextStart, dayIdx = -1) {
      const raw = nextStart - prevEnd;
      if (raw <= 0) return 0;
      const bStart = dayIdx === 4 && friBreakActive ? 690 : 720;
      const lo = prevEnd > bStart ? prevEnd : bStart;
      const hi = nextStart < 780 ? nextStart : 780;
      const lunch = hi > lo ? hi - lo : 0;
      return raw > lunch ? raw - lunch : 0;
    }
    function applyUpdate(idx, d, st, rid) {
      const en = st + sessDur[idx];
      bitIdx.place(idx, d, st, en, rid);
      sessions[idx].day = DAYS[d];
      sessions[idx].start = st;
      sessions[idx].end = en;
      sessions[idx].room = idToRoomName[rid];
    }
    let capEarly = 999;
    let capHoles = 999;
    let capIso = 999;
    let capMar = 999;
    let capAspDead = 999;
    let tunnelMode = false;
    function evalState() {
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
        if (d === 4 && friBreakActive && overlapsFridayPrayer("Jumat", st, en, sessDur[i])) friViol++;
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
      const maxH = tunnelMode ? capHoles + 2 : capHoles;
      const maxI = tunnelMode ? capIso + 3 : capIso;
      if (early > capEarly || holes > maxH || isolatedCls > maxI || marathons > capMar || asp.deadlocks > capAspDead || policy.hardFridayPrayer && friViol > 0) {
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
          obj: -1e9
        };
      }
      const startPts = (n - early - early0750 * 0.5) / n * 25e3;
      const contigPts = (numCls - nonContig) / numCls * 25e3;
      const compactPts = Math.min(1, within3 / dynamicCompactCeiling) * 2e4;
      const gapPts = Math.max(0, 1 - (clsLongGaps + lecLongGaps) / dynamicGapNormRef) * 15e3;
      const compPen = asp.deadlocks * 2500 + asp.partials * 250 + marathons * 800 + isolatedCls * 600;
      const compPts = Math.max(0, 15e3 - compPen);
      const exactScore1000 = startPts + contigPts + compactPts + gapPts + compPts;
      const invariantPenalty = tunnelMode ? holes * 1150 + isolatedCls * 520 : holes * 45e3 + isolatedCls * 35e3;
      const friPenalty = policy.protectFridayPrayer ? friViol * 3500 : 0;
      const smoothGuide = -classes5d * 18 - asp.overlapTicks * 0.45 - totalDeadGapMin * 0.015 - lecIso * lecIsoWeight - bldSwitches * 0.05 - lateCount * 0.02 - friPenalty;
      let finalObj = exactScore1000 - invariantPenalty + smoothGuide;
      if (useSurrogateObjective) {
        const classes4d = Math.max(0, numCls - within3 - classes5d);
        const surrEnergy = holes * 3200 + classes5d * 1050 + classes4d * (460 * wScale) + (clsLongGaps + lecLongGaps) * (280 * wScale) + totalDeadGapMin * 0.15 + early0750 * 980 + (early - early0750) * 180 + lateCount * (110 * wScale) + isolatedCls * (920 * wScale) + marathons * 130 + asp.deadlocks * 1500 + asp.partials * (95 * wScale) + asp.overlapTicks * 0.9 + lecIso * lecIsoWeight + (policy.protectFridayPrayer ? friViol * 500 : 0);
        finalObj = 1e5 - surrEnergy - (tunnelMode ? holes * 600 + isolatedCls * 320 : 0);
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
        obj: finalObj
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
    function saveBestMentok(ev) {
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
    function runCollapse4To3Pass() {
      let improvedAny = false;
      for (const cls of allClassKeys) {
        const sList = classToSessIndices.get(cls);
        const dc = [0, 0, 0, 0, 0];
        for (const si of sList) dc[bitIdx.sessionDayIdx[si]]++;
        const active = [];
        for (let d = 0; d < 5; d++) if (dc[d] > 0) active.push(d);
        if (active.length <= 1) continue;
        const hasHoleHere = active[active.length - 1] - active[0] + 1 > active.length;
        if (!hasHoleHere && active.length <= 3) continue;
        if (!hasHoleHere && active.length === 4 && (classTotalMin.get(cls) || 0) > 1490) continue;
        const extremes = [active[0], active[active.length - 1]];
        if (dc[extremes[1]] < dc[extremes[0]]) extremes.reverse();
        for (const outD of extremes) {
          const toEvac = sList.filter((si) => bitIdx.sessionDayIdx[si] === outD && pinnedMask[si] === 0);
          if (toEvac.length === 0 || toEvac.length > 4) continue;
          const rem = active.filter((d) => d !== outD);
          const rMin = Math.min(...rem), rMax = Math.max(...rem);
          const destSet = new Set(rem);
          if (hasHoleHere) {
            for (let d = rMin; d <= rMax; d++) destSet.add(d);
            if (rMin > 0) destSet.add(rMin - 1);
            if (rMax < 4) destSet.add(rMax + 1);
            destSet.delete(outD);
          }
          const targetDays = Array.from(destSet);
          const evacSet = new Set(toEvac);
          const saved = [];
          const touched = /* @__PURE__ */ new Set();
          const snap = (si) => {
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
            let placed = false;
            for (const td of targetDays) {
              for (const rid of aAllowed) {
                if (policy.enforcePascaMonWed && isPascaById[rid] && td > 2) continue;
                for (const st of aStarts) {
                  if (bitIdx.canPlaceHard(aIdx, td, rid, aMasks.get(st), policy.enforceAsprakWetLab)) {
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
            let bestSw = null;
            for (const td of targetDays) {
              for (const b of movableIndices) {
                if (evacSet.has(b) || touched.has(b) || bitIdx.sessionDayIdx[b] !== td) continue;
                if (sessions[b].classes.includes(cls)) continue;
                const bR = bitIdx.sessionRoomId[b];
                if (!aAllowed.includes(bR) || !allowedRoomIds[b].includes(oR)) continue;
                if (policy.enforcePascaMonWed && (isPascaById[bR] && td > 2 || isPascaById[oR] && oD > 2)) continue;
                const bSt = bitIdx.sessionStart[b];
                bitIdx.unplace(aIdx);
                bitIdx.unplace(b);
                const bMasks = startMasks[b];
                const bStarts = candidateStarts[b];
                const aCand = aMasks.has(bSt) ? [bSt, ...aStarts.filter((x) => x !== bSt)] : aStarts;
                const bCand = bMasks.has(oSt) ? [oSt, ...bStarts.filter((x) => x !== oSt)] : bStarts;
                let aNewSt = -1;
                for (const st of aCand) {
                  if (bitIdx.canPlaceHard(aIdx, td, bR, aMasks.get(st), policy.enforceAsprakWetLab)) {
                    aNewSt = st;
                    break;
                  }
                }
                if (aNewSt >= 0) {
                  applyUpdate(aIdx, td, aNewSt, bR);
                  for (const bst of bCand) {
                    if (!bitIdx.canPlaceHard(b, oD, oR, bMasks.get(bst), policy.enforceAsprakWetLab)) continue;
                    applyUpdate(b, oD, bst, oR);
                    const bClsOk = sessions[b].classes.every((bc) => {
                      const bl = classToSessIndices.get(bc);
                      const bcCnt = [0, 0, 0, 0, 0];
                      for (const si of bl) bcCnt[bitIdx.sessionDayIdx[si]]++;
                      let mn = 5, mx = -1, act = 0;
                      for (let d = 0; d < 5; d++) if (bcCnt[d] > 0) {
                        act++;
                        if (d < mn) mn = d;
                        if (d > mx) mx = d;
                      }
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
              let bridged = false;
              const durA = sessDur[aIdx];
              const mids = [1, 2, 3, 0, 4].filter((md) => md !== oD && !targetDays.includes(md));
              const allMids = [...mids, ...targetDays.filter((md) => md !== oD)];
              bridgeSearch: for (const td of targetDays) {
                for (const midD of allMids) {
                  if (midD === td || midD === oD) continue;
                  const bCand = [];
                  const cCand = [];
                  for (const si of movableIndices) {
                    if (evacSet.has(si) || touched.has(si) || sessDur[si] !== durA) continue;
                    if (sessions[si].classes.includes(cls)) continue;
                    const sd = bitIdx.sessionDayIdx[si], sr = bitIdx.sessionRoomId[si];
                    if (sd === td) {
                      if (!aAllowed.includes(sr)) continue;
                      if (policy.enforcePascaMonWed && isPascaById[sr] && td > 2) continue;
                      const okB = sessions[si].classes.every((bc) => {
                        const bl = classToSessIndices.get(bc);
                        let cTd = 0, cMid = 0;
                        for (const x of bl) {
                          const xd = bitIdx.sessionDayIdx[x];
                          if (xd === td) cTd++;
                          else if (xd === midD) cMid++;
                        }
                        return cTd >= 3 && cMid >= 1;
                      });
                      if (okB) bCand.push(si);
                    } else if (sd === midD) {
                      if (!allowedRoomIds[si].includes(oR)) continue;
                      if (policy.enforcePascaMonWed && isPascaById[oR] && oD > 2) continue;
                      const okC = sessions[si].classes.every((cc) => {
                        const cl = classToSessIndices.get(cc);
                        let cMid = 0, cOd = 0;
                        for (const x of cl) {
                          const xd = bitIdx.sessionDayIdx[x];
                          if (xd === midD) cMid++;
                          else if (xd === oD) cOd++;
                        }
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
    function tryBlockSlideCollapse() {
      let improvedAny = false;
      for (const cls of allClassKeys) {
        const sList = classToSessIndices.get(cls);
        const dc = [0, 0, 0, 0, 0];
        for (const si of sList) dc[bitIdx.sessionDayIdx[si]]++;
        const active = [];
        for (let d = 0; d < 5; d++) if (dc[d] > 0) active.push(d);
        if (active.length <= 3) continue;
        if (active.length === 4 && (classTotalMin.get(cls) || 0) > 1490) continue;
        const extremes = [active[0], active[active.length - 1]];
        if (dc[extremes[1]] < dc[extremes[0]]) extremes.reverse();
        let shrunkCls = false;
        for (const outD of extremes) {
          const toEvac = sList.filter(
            (si) => bitIdx.sessionDayIdx[si] === outD && pinnedMask[si] === 0 && sessions[si].classes.length === 1
          );
          const k = toEvac.length;
          if (k < 2 || k > 3 || k !== dc[outD]) continue;
          const rem = active.filter((d) => d !== outD);
          const remSet = new Set(rem);
          for (const bc of allClassKeys) {
            if (bc === cls) continue;
            const bList = classToSessIndices.get(bc);
            if (bList.length < 4) continue;
            const bdc = [0, 0, 0, 0, 0];
            for (const si of bList) bdc[bitIdx.sessionDayIdx[si]]++;
            const bAct = [];
            for (let d = 0; d < 5; d++) if (bdc[d] > 0) bAct.push(d);
            if (bAct.length < 2) continue;
            const bMin = bAct[0], bMax = bAct[bAct.length - 1];
            if (bMax - bMin + 1 !== bAct.length) continue;
            const donorDays = [];
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
                (si) => bitIdx.sessionDayIdx[si] === bEdge && pinnedMask[si] === 0 && sessions[si].classes.length === 1
              );
              if (bPool.length < k) continue;
              const subsets = [];
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
                const allIds = [...toEvac, ...bSub];
                const saved = allIds.map((si) => ({
                  si,
                  d: bitIdx.sessionDayIdx[si],
                  st: bitIdx.sessionStart[si],
                  rid: bitIdx.sessionRoomId[si]
                }));
                const perms = k === 2 ? [
                  [0, 1],
                  [1, 0]
                ] : [
                  [0, 1, 2],
                  [0, 2, 1],
                  [1, 0, 2],
                  [1, 2, 0],
                  [2, 0, 1],
                  [2, 1, 0]
                ];
                for (const perm of perms) {
                  for (const sv of saved) bitIdx.unplace(sv.si);
                  let okAll = true;
                  const placedSoFar = [];
                  for (let p = 0; p < k && okAll; p++) {
                    const aIdx = toEvac[p];
                    const bIdx = bSub[perm[p]];
                    const bOrigR = saved[k + perm[p]].rid;
                    const bOrigSt = saved[k + perm[p]].st;
                    const rOrder = allowedRoomIds[aIdx].includes(bOrigR) ? [bOrigR, ...allowedRoomIds[aIdx].filter((r) => r !== bOrigR)] : allowedRoomIds[aIdx];
                    const sOrder = startMasks[aIdx].has(bOrigSt) ? [bOrigSt, ...candidateStarts[aIdx].filter((s) => s !== bOrigSt)] : candidateStarts[aIdx];
                    let placedA = false;
                    for (const rid of rOrder) {
                      if (policy.enforcePascaMonWed && isPascaById[rid] && bEdge > 2) continue;
                      for (const st of sOrder) {
                        if (bitIdx.canPlaceHard(aIdx, bEdge, rid, startMasks[aIdx].get(st), policy.enforceAsprakWetLab)) {
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
                  for (let p = 0; p < k && okAll; p++) {
                    const aOrigR = saved[p].rid;
                    const aOrigSt = saved[p].st;
                    const bIdx = bSub[perm[p]];
                    const rOrder = allowedRoomIds[bIdx].includes(aOrigR) ? [aOrigR, ...allowedRoomIds[bIdx].filter((r) => r !== aOrigR)] : allowedRoomIds[bIdx];
                    const sOrder = startMasks[bIdx].has(aOrigSt) ? [aOrigSt, ...candidateStarts[bIdx].filter((s) => s !== aOrigSt)] : candidateStarts[bIdx];
                    let placedB = false;
                    for (const rid of rOrder) {
                      if (policy.enforcePascaMonWed && isPascaById[rid] && outD > 2) continue;
                      for (const st of sOrder) {
                        if (bitIdx.canPlaceHard(bIdx, outD, rid, startMasks[bIdx].get(st), policy.enforceAsprakWetLab)) {
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
    function runKempeCollapse4To3Pass() {
      let improvedAny = false;
      for (const cls of allClassKeys) {
        const sList = classToSessIndices.get(cls);
        const dc = [0, 0, 0, 0, 0];
        for (const si of sList) dc[bitIdx.sessionDayIdx[si]]++;
        const active = [];
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
          const saved = [];
          const touched = /* @__PURE__ */ new Set();
          const snap = (si) => {
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
            let placed = false;
            for (const td of rem) {
              for (const rid of allowedRoomIds[aIdx]) {
                if (policy.enforcePascaMonWed && isPascaById[rid] && td > 2) continue;
                for (const st of candidateStarts[aIdx]) {
                  if (bitIdx.canPlaceHard(aIdx, td, rid, startMasks[aIdx].get(st), policy.enforceAsprakWetLab)) {
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
            kempeSearch: for (const td of rem) {
              for (const rid of allowedRoomIds[aIdx]) {
                if (policy.enforcePascaMonWed && isPascaById[rid] && td > 2) continue;
                for (const st of candidateStarts[aIdx]) {
                  const aMask = startMasks[aIdx].get(st);
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
                  const bDestDays = [bD];
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
                        if (bitIdx.canPlaceHard(b, bd, brid, startMasks[b].get(bst), policy.enforceAsprakWetLab)) {
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
    function runAsprakAtomicClearPass() {
      if (!policy.enforceAsprakWetLab || bitIdx.wetLabIndices.length === 0) return false;
      let improvedAny = false;
      for (const ws of bitIdx.wetLabIndices) {
        const ovList = bitIdx.findSeniorOverlapsForWetLab(ws);
        if (ovList.length === 0 || ovList.length > 4) continue;
        if (ovList.some((x) => pinnedMask[x] === 1)) continue;
        const wsD = bitIdx.sessionDayIdx[ws], wsSt = bitIdx.sessionStart[ws], wsEn = bitIdx.sessionEnd[ws];
        const ovSet = new Set(ovList);
        const saved = [];
        const touched = /* @__PURE__ */ new Set();
        const snap = (si) => {
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
          const destDays = [sD];
          if (sessions[sIdx].classes.length === 1) {
            const sCls = sessions[sIdx].classes[0];
            const sList = classToSessIndices.get(sCls) || [];
            const sdc = [0, 0, 0, 0, 0];
            for (const x of sList) if (x !== sIdx) sdc[bitIdx.sessionDayIdx[x]]++;
            if (sdc[sD] >= 2) {
              for (let d = 0; d < 5; d++) if (d !== sD && sdc[d] > 0) destDays.push(d);
            }
          }
          let movedS = false;
          for (const td of destDays) {
            for (const rid of allowedRoomIds[sIdx]) {
              if (policy.enforcePascaMonWed && isPascaById[rid] && td > 2) continue;
              for (const st of candidateStarts[sIdx]) {
                if (td === wsD && st < wsEn && wsSt < st + sDur) continue;
                if (bitIdx.canPlaceHard(sIdx, td, rid, startMasks[sIdx].get(st), true)) {
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
          applyUpdate(sIdx, sD, sSt, sR);
          swapS: for (const td of destDays) {
            for (const b of movableIndices) {
              if (b === sIdx || ovSet.has(b) || touched.has(b) || bitIdx.sessionDayIdx[b] !== td) continue;
              if (sessDur[b] !== sDur) continue;
              const bSt = bitIdx.sessionStart[b], bR = bitIdx.sessionRoomId[b];
              if (td === wsD && bSt < wsEn && wsSt < bSt + sDur) continue;
              if (!allowedRoomIds[sIdx].includes(bR) || !allowedRoomIds[b].includes(sR)) continue;
              if (policy.enforcePascaMonWed && (isPascaById[bR] && td > 2 || isPascaById[sR] && sD > 2)) continue;
              if (td !== sD) {
                const bSafe = sessions[b].classes.every((bc) => {
                  const bl = classToSessIndices.get(bc) || [];
                  const bdc = [0, 0, 0, 0, 0];
                  for (const x of bl) bdc[bitIdx.sessionDayIdx[x]]++;
                  bdc[td]--;
                  bdc[sD]++;
                  let mn = 5, mx = -1, act = 0;
                  for (let d = 0; d < 5; d++) if (bdc[d] > 0) {
                    act++;
                    if (d < mn) mn = d;
                    if (d > mx) mx = d;
                  }
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
      const involvedClasses = /* @__PURE__ */ new Set();
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
        const active = [];
        for (let d = 0; d < 5; d++) if (dc[d] > 0) active.push(d);
        if (active.length < 2 || active.length > 4) continue;
        const minD = active[0], maxD = active[active.length - 1];
        if (maxD - minD + 1 !== active.length) continue;
        const slideDirs = [];
        if (maxD < 4) slideDirs.push({ outD: minD, inD: maxD + 1 });
        if (minD > 0) slideDirs.push({ outD: maxD, inD: minD - 1 });
        for (const { outD, inD } of slideDirs) {
          const toMove = sList.filter((si) => bitIdx.sessionDayIdx[si] === outD && pinnedMask[si] === 0 && sessions[si].classes.length === 1);
          if (toMove.length === 0 || toMove.length !== dc[outD]) continue;
          const moveSet = new Set(toMove);
          const saved = [];
          const touched = /* @__PURE__ */ new Set();
          const snap = (si) => {
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
            for (const rid of allowedRoomIds[aIdx]) {
              if (policy.enforcePascaMonWed && isPascaById[rid] && inD > 2) continue;
              for (const st of candidateStarts[aIdx]) {
                if (bitIdx.canPlaceHard(aIdx, inD, rid, startMasks[aIdx].get(st), true)) {
                  applyUpdate(aIdx, inD, st, rid);
                  ok = true;
                  break;
                }
              }
              if (ok) break;
            }
            if (!ok) {
              kempeIn: for (const rid of allowedRoomIds[aIdx]) {
                if (policy.enforcePascaMonWed && isPascaById[rid] && inD > 2) continue;
                for (const st of candidateStarts[aIdx]) {
                  const mA = startMasks[aIdx].get(st);
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
                      if (bitIdx.canPlaceHard(b, bD, brid, startMasks[b].get(bst), true)) {
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
    const byDay = [[], [], [], [], []];
    function rebuildByDay() {
      for (let d = 0; d < 5; d++) byDay[d].length = 0;
      for (const si of movableIndices) byDay[bitIdx.sessionDayIdx[si]].push(si);
    }
    rebuildByDay();
    function runClassRuinAndRepackPass() {
      let improvedAny = false;
      const targetCls = /* @__PURE__ */ new Set();
      for (const cls of allClassKeys) {
        const sList = classToSessIndices.get(cls);
        if (sList.length < 4) continue;
        const dc = [0, 0, 0, 0, 0];
        for (const si of sList) dc[bitIdx.sessionDayIdx[si]]++;
        let act = 0;
        for (let d = 0; d < 5; d++) if (dc[d] > 0) act++;
        const totM = classTotalMin.get(cls) || 0;
        if (act >= 5 || act === 4 && totM <= 1490) targetCls.add(cls);
      }
      if (policy.enforceAsprakWetLab) {
        for (const ws of bitIdx.wetLabIndices) {
          const ov = bitIdx.findSeniorOverlapsForWetLab(ws);
          if (ov.length === 0) continue;
          for (const c of sessions[ws].classes) targetCls.add(c);
          for (const si of ov) for (const c of sessions[si].classes) targetCls.add(c);
        }
      }
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
        const toRepack = sList.filter((si) => pinnedMask[si] === 0 && sessions[si].classes.length === 1);
        if (toRepack.length < 4) continue;
        const anchoredDays = /* @__PURE__ */ new Set();
        for (const si of sList) {
          if (!toRepack.includes(si)) anchoredDays.add(bitIdx.sessionDayIdx[si]);
        }
        const totM = classTotalMin.get(cls) || 0;
        const candWindows = totM > 1490 ? [
          [0, 1, 2, 3],
          [1, 2, 3, 4]
        ] : [
          [0, 1, 2],
          [1, 2, 3],
          [2, 3, 4]
        ];
        const validWindows = candWindows.filter((win) => Array.from(anchoredDays).every((ad) => win.includes(ad)));
        if (validWindows.length === 0) continue;
        const causesMarathon = (sameDay, st, dur) => {
          if (sameDay.length === 0) return false;
          const items = [{ s: st, e: st + dur, d: dur }];
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
        const makeShuffled = () => {
          const arr = [...toRepack];
          for (let k = arr.length - 1; k > 0; k--) {
            const j = Math.floor(rng() * (k + 1));
            const tmp = arr[k];
            arr[k] = arr[j];
            arr[j] = tmp;
          }
          arr.sort((a, b) => (sessions[b].duration > 300 ? 1 : 0) - (sessions[a].duration > 300 ? 1 : 0));
          return arr;
        };
        const orderings = [
          [...toRepack].sort((a, b) => {
            const sa = sessions[a], sb = sessions[b];
            const pa = (sa.isWetLab ? 1e3 : sa.roomType === "DRY_LAB" ? 400 : 0) + sa.duration;
            const pb = (sb.isWetLab ? 1e3 : sb.roomType === "DRY_LAB" ? 400 : 0) + sb.duration;
            return pb - pa;
          }),
          [...toRepack].sort((a, b) => {
            const sa = sessions[a], sb = sessions[b];
            const pa = sa.duration > 300 ? 2e3 : sa.duration === 100 ? 1200 : sa.duration === 150 ? 900 : 400;
            const pb = sb.duration > 300 ? 2e3 : sb.duration === 100 ? 1200 : sb.duration === 150 ? 900 : 400;
            return pb - pa;
          }),
          [...toRepack].sort((a, b) => {
            const sa = sessions[a], sb = sessions[b];
            const pa = (sa.isWetLab ? 50 : sa.roomType === "DRY_LAB" ? 200 : 800) + sa.duration;
            const pb = (sb.isWetLab ? 50 : sb.roomType === "DRY_LAB" ? 200 : 800) + sb.duration;
            return pb - pa;
          }),
          makeShuffled(),
          makeShuffled(),
          makeShuffled()
        ];
        const repackSet = new Set(toRepack);
        let repackedCls = false;
        for (const win of validWindows) {
          for (let ordIdx = 0; ordIdx < orderings.length; ordIdx++) {
            const ordered = orderings[ordIdx];
            const saved = [];
            const touched = /* @__PURE__ */ new Set();
            const snap = (si) => {
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
            const winDayCount = /* @__PURE__ */ new Map();
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
              let deficitAll = 0;
              let deficitOnes = 0;
              for (const d of win) {
                const c = winDayCount.get(d) || 0;
                if (c < 2) deficitAll += 2 - c;
                if (c === 1) deficitOnes += 1;
              }
              const dayPriorityPool = remCount <= deficitOnes ? win.filter((d) => (winDayCount.get(d) || 0) === 1) : remCount <= deficitAll ? win.filter((d) => (winDayCount.get(d) || 0) < 2) : win;
              const daysToTry = dayPriorityPool.length > 0 ? dayPriorityPool : win;
              let bestFree = null;
              for (const td of daysToTry) {
                const dayCnt = winDayCount.get(td) || 0;
                const sameDayPlaced = sList.filter((x) => bitIdx.sessionDayIdx[x] === td);
                for (const rid of allowedRoomIds[aIdx]) {
                  if (policy.enforcePascaMonWed && isPascaById[rid] && td > 2) continue;
                  for (const st of candidateStarts[aIdx]) {
                    if (causesMarathon(sameDayPlaced, st, sa.duration)) continue;
                    const mask = startMasks[aIdx].get(st);
                    if (!bitIdx.canPlaceHard(aIdx, td, rid, mask, policy.enforceAsprakWetLab)) continue;
                    let sc = 0;
                    if (dayCnt === 1) sc += 260;
                    else if (dayCnt === 0) sc += 140;
                    else if (dayCnt >= 4) sc -= 180;
                    if (sa.duration === 150 && st >= 780) sc += 220;
                    if (sa.duration === 100 && st < 720) sc += 120;
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
              let placedK = false;
              const kDays = daysToTry === win ? win : [...daysToTry, ...win.filter((d) => !daysToTry.includes(d))];
              kempeRepack: for (const td of kDays) {
                const sameDayPlaced = sList.filter((x) => bitIdx.sessionDayIdx[x] === td);
                for (const rid of allowedRoomIds[aIdx]) {
                  if (policy.enforcePascaMonWed && isPascaById[rid] && td > 2) continue;
                  for (const st of candidateStarts[aIdx]) {
                    if (causesMarathon(sameDayPlaced, st, sa.duration)) continue;
                    const mask = startMasks[aIdx].get(st);
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
                    const bDestDays = [bD];
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
                          if (bitIdx.canPlaceHard(b, bd, brid, startMasks[b].get(bst), policy.enforceAsprakWetLab)) {
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
    function runLoneDayRepairPass() {
      let improvedAny = false;
      for (const cls of allClassKeys) {
        const sList = classToSessIndices.get(cls);
        if (sList.length < 2) continue;
        const dc = [0, 0, 0, 0, 0];
        for (const si of sList) dc[bitIdx.sessionDayIdx[si]]++;
        const active = [];
        for (let d = 0; d < 5; d++) if (dc[d] > 0) active.push(d);
        if (active.length <= 1) continue;
        for (const ld of active) {
          if (dc[ld] !== 1) continue;
          const isExt = ld === active[0] || ld === active[active.length - 1];
          const others = active.filter((d) => d !== ld);
          let fixed = false;
          if (isExt) {
            const loneSi = sList.find((si) => bitIdx.sessionDayIdx[si] === ld && pinnedMask[si] === 0);
            if (loneSi !== void 0) {
              const oSt = bitIdx.sessionStart[loneSi], oR = bitIdx.sessionRoomId[loneSi];
              bitIdx.unplace(loneSi);
              let bestF = null;
              for (const td of others) {
                for (const rid of allowedRoomIds[loneSi]) {
                  if (policy.enforcePascaMonWed && isPascaById[rid] && td > 2) continue;
                  for (const st of candidateStarts[loneSi]) {
                    if (!bitIdx.canPlaceHard(loneSi, td, rid, startMasks[loneSi].get(st), policy.enforceAsprakWetLab)) continue;
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
          if (!fixed) {
            const donors = sList.filter((si) => dc[bitIdx.sessionDayIdx[si]] >= 3 && pinnedMask[si] === 0);
            for (const dIdx of donors) {
              const oD = bitIdx.sessionDayIdx[dIdx], oSt = bitIdx.sessionStart[dIdx], oR = bitIdx.sessionRoomId[dIdx];
              bitIdx.unplace(dIdx);
              let bestP = null;
              for (const rid of allowedRoomIds[dIdx]) {
                if (policy.enforcePascaMonWed && isPascaById[rid] && ld > 2) continue;
                for (const st of candidateStarts[dIdx]) {
                  if (!bitIdx.canPlaceHard(dIdx, ld, rid, startMasks[dIdx].get(st), policy.enforceAsprakWetLab)) continue;
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
    const L = Math.max(20, Math.round(options.lahcLength ?? 65));
    const lahc = new Float64Array(L).fill(curObj);
    const startTemp = Math.max(480, options.initTemp ?? 520);
    let temp = startTemp;
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
    function acceptMentok(newObj, iter) {
      if (newObj <= -1e8) return false;
      const v = iter % L;
      if (newObj >= curObj || newObj >= lahc[v]) return true;
      const diff = curObj - newObj;
      if (temp > 4 && Math.exp(-diff / temp) > rng()) return true;
      return false;
    }
    rebuildByDay();
    const gappedSessions = [];
    function refreshGappedSessions() {
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
              if (pinnedMask[u] === 0 && !seen[u]) {
                seen[u] = 1;
                gappedSessions.push(u);
              }
              if (pinnedMask[w] === 0 && !seen[w]) {
                seen[w] = 1;
                gappedSessions.push(w);
              }
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
              if (pinnedMask[u] === 0 && !seen[u]) {
                seen[u] = 1;
                gappedSessions.push(u);
              }
              if (pinnedMask[w] === 0 && !seen[w]) {
                seen[w] = 1;
                gappedSessions.push(w);
              }
            }
          }
        }
      }
    }
    refreshGappedSessions();
    while (iterations < maxIters && performance.now() < deadline && movableIndices.length > 0) {
      iterations++;
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
      if (r < 0.3) {
        const useGap = gappedSessions.length > 0 && rng() < 0.8;
        const a = useGap ? gappedSessions[Math.floor(rng() * gappedSessions.length)] : movableIndices[Math.floor(rng() * movableIndices.length)];
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
        const useGap = gappedSessions.length > 0 && rng() < 0.7;
        const a = useGap ? gappedSessions[Math.floor(rng() * gappedSessions.length)] : movableIndices[Math.floor(rng() * movableIndices.length)];
        const b = movableIndices[Math.floor(rng() * movableIndices.length)];
        if (a === b || sessDur[a] !== sessDur[b]) continue;
        const aD = bitIdx.sessionDayIdx[a], aSt = bitIdx.sessionStart[a], aR = bitIdx.sessionRoomId[a];
        const bD = bitIdx.sessionDayIdx[b], bSt = bitIdx.sessionStart[b], bR = bitIdx.sessionRoomId[b];
        if (aD === bD) continue;
        if (!allowedRoomIds[a].includes(bR) || !allowedRoomIds[b].includes(aR)) continue;
        if (policy.enforcePascaMonWed && (isPascaById[bR] && bD > 2 || isPascaById[aR] && aD > 2)) continue;
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
        const wStart = Math.floor(rng() * bitIdx.wetLabIndices.length);
        let ws = -1;
        let ov = [];
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
              if (bitIdx.canPlaceHard(ws, td, oR, startMasks[ws].get(st), true)) {
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
                  if (bitIdx.canPlaceHard(sIdx, td, rid, startMasks[sIdx].get(st), true)) {
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
                if (policy.enforcePascaMonWed && (isPascaById[bR] && bD > 2 || isPascaById[sR] && sD > 2)) continue;
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
        if ((iterations & 63) === 0 && (runAsprakAtomicClearPass() || runKempeCollapse4To3Pass() || runCollapse4To3Pass() || tryBlockSlideCollapse())) {
          movedOk = true;
          rebuildByDay();
        }
      } else {
        let idx = movableIndices[Math.floor(rng() * movableIndices.length)];
        let forcedTargetDay = -1;
        if (tunnelMode) {
          const loneSessions = [];
          const shrinkSessions = [];
          for (const cls of allClassKeys) {
            const sList = classToSessIndices.get(cls);
            if (sList.length < 2) continue;
            const dc = [0, 0, 0, 0, 0];
            for (const si of sList) dc[bitIdx.sessionDayIdx[si]]++;
            const active = [];
            for (let d = 0; d < 5; d++) if (dc[d] > 0) active.push(d);
            for (const d of active) {
              if (dc[d] === 1) {
                const lone = sList.find((si) => bitIdx.sessionDayIdx[si] === d && pinnedMask[si] === 0);
                if (lone !== void 0) {
                  const others = active.filter((ad) => ad !== d);
                  if (others.length > 0) loneSessions.push({ si: lone, targetDays: others });
                }
              }
            }
            const totM = classTotalMin.get(cls) || 0;
            if (active.length >= 5 || active.length === 4 && totM <= 1490) {
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
        if (bitIdx.canPlaceHard(idx, td, rid, startMasks[idx].get(st), policy.enforceAsprakWetLab)) {
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
    tunnelMode = false;
    for (let i = 0; i < n; i++) bitIdx.unplace(i);
    for (let i = 0; i < n; i++) applyUpdate(i, bestDay[i], bestStart[i], bestRoom[i]);
    curObj = evalState().obj;
    bestObj = curObj;
    rebuildByDay();
    for (let pass = 0; pass < 6; pass++) {
      let imp = false;
      for (const idx of movableIndices) {
        const oD = bitIdx.sessionDayIdx[idx], oSt = bitIdx.sessionStart[idx], oR = bitIdx.sessionRoomId[idx];
        let bestFree = null;
        bitIdx.unplace(idx);
        for (let td = 0; td < 5; td++) {
          for (const rid of allowedRoomIds[idx]) {
            if (policy.enforcePascaMonWed && isPascaById[rid] && td > 2) continue;
            for (const st of candidateStarts[idx]) {
              if (td === oD && st === oSt && rid === oR) continue;
              if (!bitIdx.canPlaceHard(idx, td, rid, startMasks[idx].get(st), policy.enforceAsprakWetLab)) continue;
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
      if (policy.enforceAsprakWetLab) {
        for (const ws of bitIdx.wetLabIndices) {
          const ovList = bitIdx.findSeniorOverlapsForWetLab(ws);
          if (ovList.length === 0) continue;
          if (pinnedMask[ws] === 0) {
            const oD = bitIdx.sessionDayIdx[ws], oSt = bitIdx.sessionStart[ws], oR = bitIdx.sessionRoomId[ws];
            let bestW = null;
            bitIdx.unplace(ws);
            for (let td = 0; td < 5; td++) {
              for (const st of candidateStarts[ws]) {
                if (td === oD && st === oSt) continue;
                if (!bitIdx.canPlaceHard(ws, td, oR, startMasks[ws].get(st), true)) continue;
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
          const wsSt = bitIdx.sessionStart[ws], wsEn = bitIdx.sessionEnd[ws];
          for (const sIdx of ovList) {
            if (pinnedMask[sIdx] === 1) continue;
            const sD = bitIdx.sessionDayIdx[sIdx], sSt = bitIdx.sessionStart[sIdx], sR = bitIdx.sessionRoomId[sIdx];
            let bestS = null;
            for (const b of movableIndices) {
              if (b === sIdx || sessDur[b] !== sessDur[sIdx]) continue;
              const bD = bitIdx.sessionDayIdx[b], bSt = bitIdx.sessionStart[b], bR = bitIdx.sessionRoomId[b];
              if (bD === sD && bSt < wsEn && wsSt < bSt + sessDur[sIdx]) continue;
              if (!allowedRoomIds[sIdx].includes(bR) || !allowedRoomIds[b].includes(sR)) continue;
              if (policy.enforcePascaMonWed && (isPascaById[bR] && bD > 2 || isPascaById[sR] && sD > 2)) continue;
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
          if (pinnedMask[ws] === 0 && bitIdx.findSeniorOverlapsForWetLab(ws).length > 0 && sessions[ws].classes.length === 1) {
            const jc = sessions[ws].classes[0];
            const jl = classToSessIndices.get(jc) || [];
            const oD = bitIdx.sessionDayIdx[ws], oSt = bitIdx.sessionStart[ws], oR = bitIdx.sessionRoomId[ws];
            const otherDays = Array.from(new Set(jl.map((si) => bitIdx.sessionDayIdx[si]))).filter((d) => d !== oD);
            let exchanged = false;
            exchLoop: for (const td of otherDays) {
              const jrCands = jl.filter(
                (si) => si !== ws && pinnedMask[si] === 0 && bitIdx.sessionDayIdx[si] === td && sessions[si].roomType !== "WET_LAB"
              );
              if (jrCands.length === 0) continue;
              for (const wst of candidateStarts[ws]) {
                const wMask = startMasks[ws].get(wst);
                for (const sJr of jrCands) {
                  const jSt = bitIdx.sessionStart[sJr], jR = bitIdx.sessionRoomId[sJr], jDur = sessDur[sJr];
                  for (const b of byDay[oD]) {
                    if (b === ws || b === sJr || sessDur[b] !== jDur || sessions[b].classes.includes(jc)) continue;
                    const bSt = bitIdx.sessionStart[b], bR = bitIdx.sessionRoomId[b];
                    if (!allowedRoomIds[sJr].includes(bR) || !allowedRoomIds[b].includes(jR)) continue;
                    if (policy.enforcePascaMonWed && (isPascaById[bR] && oD > 2 || isPascaById[jR] && td > 2)) continue;
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
                      if (!bitIdx.canPlaceHard(sIdx, td, sr, startMasks[sIdx].get(sst), true)) continue;
                      applyUpdate(sIdx, td, sst, sr);
                      for (const orid of allowedRoomIds[sOther]) {
                        if (policy.enforcePascaMonWed && isPascaById[orid] && sD > 2) continue;
                        for (const ost of candidateStarts[sOther]) {
                          if (ost < wEnH && wStH < ost + oDur) continue;
                          if (!bitIdx.canPlaceHard(sOther, sD, orid, startMasks[sOther].get(ost), true)) continue;
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
                      for (const b of byDay[sD]) {
                        if (b === sIdx || b === sOther || sessDur[b] !== oDur || sessions[b].classes.includes(sc)) continue;
                        const bSt = bitIdx.sessionStart[b], bR = bitIdx.sessionRoomId[b];
                        if (bSt < wEnH && wStH < bSt + oDur) continue;
                        if (!allowedRoomIds[sOther].includes(bR) || !allowedRoomIds[b].includes(oR)) continue;
                        if (policy.enforcePascaMonWed && (isPascaById[bR] && sD > 2 || isPascaById[oR] && td > 2)) continue;
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
                    if (policy.enforcePascaMonWed && (isPascaById[bR] && td > 2 || isPascaById[sR] && sD > 2)) continue;
                    const bOk = sessions[b].classes.every((bc) => {
                      const bl = classToSessIndices.get(bc) || [];
                      const cnt = [0, 0, 0, 0, 0];
                      for (const x of bl) cnt[bitIdx.sessionDayIdx[x]]++;
                      cnt[td]--;
                      cnt[sD]++;
                      let mn = 5, mx = -1, act = 0;
                      for (let d = 0; d < 5; d++) if (cnt[d] > 0) {
                        act++;
                        if (d < mn) mn = d;
                        if (d > mx) mx = d;
                      }
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
          for (const sIdx of bitIdx.findSeniorOverlapsForWetLab(ws)) {
            if (pinnedMask[sIdx] === 1) continue;
            const sD = bitIdx.sessionDayIdx[sIdx], sSt = bitIdx.sessionStart[sIdx], sR = bitIdx.sessionRoomId[sIdx];
            const sDur = sessDur[sIdx];
            const sameDaySameDur = byDay[sD].filter((x) => x !== sIdx && sessDur[x] === sDur);
            let cycled = false;
            cycAsp: for (const b of sameDaySameDur) {
              const bSt = bitIdx.sessionStart[b], bR = bitIdx.sessionRoomId[b];
              if (bSt < wsEn && wsSt < bSt + sDur) continue;
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
      refreshGappedSessions();
      for (const a of gappedSessions) {
        const aD = bitIdx.sessionDayIdx[a], aSt = bitIdx.sessionStart[a], aR = bitIdx.sessionRoomId[a];
        let bestX = null;
        for (const b of movableIndices) {
          if (b === a || sessDur[b] !== sessDur[a]) continue;
          const bD = bitIdx.sessionDayIdx[b];
          if (bD === aD) continue;
          const bSt = bitIdx.sessionStart[b], bR = bitIdx.sessionRoomId[b];
          if (!allowedRoomIds[a].includes(bR) || !allowedRoomIds[b].includes(aR)) continue;
          if (policy.enforcePascaMonWed && (isPascaById[bR] && bD > 2 || isPascaById[aR] && aD > 2)) continue;
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
      if (runAsprakAtomicClearPass()) {
        imp = true;
        rebuildByDay();
      }
      if (runClassRuinAndRepackPass() || runKempeCollapse4To3Pass() || runCollapse4To3Pass() || tryBlockSlideCollapse()) {
        imp = true;
        rebuildByDay();
      }
      if (!imp) break;
    }
    for (let i = 0; i < n; i++) {
      sessions[i].day = DAYS[bestDay[i]];
      sessions[i].start = bestStart[i];
      sessions[i].end = bestEnd[i];
      sessions[i].room = idToRoomName[bestRoom[i]];
    }
    const moves = [];
    for (let i = 0; i < n; i++) {
      const a = diffRef[i];
      const b = sessions[i];
      if (a.day !== b.day || a.start !== b.start || a.room !== b.room) {
        moves.push({
          id: b.id,
          namaMk: b.namaMk,
          kelasRaw: b.kelasRaw,
          from: { day: a.day, start: a.start, end: a.end, room: a.room },
          to: { day: b.day, start: b.start, end: b.end, room: b.room }
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
        algorithm: "TPE + Stage-4 Mentok Deep Polish (Invariant-Locked LAHC+SA+3-Cycle)",
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
        finalEnergy: Math.round(bestObj)
      }
    };
  }

  // src/index.ts
  var CSPEngine = {
    DAYS,
    DAY_INDEX,
    expandEffectiveClasses,
    DEFAULT_POLICY,
    DEFAULT_HYPERPARAMS,
    TPE_PARAM_SPECS,
    TpeSampler,
    computeTpeFitness,
    fmtTime,
    isPascaRoom,
    isSaintekRoom,
    getAllowedRooms,
    cloneSessions,
    auditSchedule,
    computeGlobalHumaneEnergy,
    constructiveReset,
    deepPolishSchedule,
    evaluateCandidateSlots,
    planMinimalRepair,
    autoFixAllConflicts,
    generateUasSchedule
  };
  var index_default = CSPEngine;
  return __toCommonJS(index_exports);
})();
(function(r){var a=CSPEngineBundle.default||CSPEngineBundle;if(typeof module==='object'&&module.exports)module.exports=a;if(typeof r!=='undefined')r.CSPEngine=a;})(typeof globalThis!=='undefined'?globalThis:self);
