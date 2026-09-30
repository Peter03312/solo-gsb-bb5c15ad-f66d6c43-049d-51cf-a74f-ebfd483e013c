'use strict';

// ---------- 时间 ----------
// 统一使用本地时间字符串 YYYY-MM-DDTHH:mm（HTML datetime-local 的格式）
const DT_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

function parseDateTime(str, field) {
  if (typeof str !== 'string') {
    return { error: `${field || '时间'}格式无效，应为 YYYY-MM-DDTHH:mm` };
  }
  const m = str.trim().match(DT_RE);
  if (!m) return { error: `${field || '时间'}格式无效，应为 YYYY-MM-DDTHH:mm` };
  const [, y, mo, d, h, mi, s] = m;
  const year = +y, month = +mo, day = +d, hour = +h, min = +mi, sec = s ? +s : 0;
  const date = new Date(year, month - 1, day, hour, min, sec, 0);
  // 回卷校验（如 2 月 30 日会被 Date 自动进位，必须拒绝）
  if (
    date.getFullYear() !== year || date.getMonth() !== month - 1 ||
    date.getDate() !== day || date.getHours() !== hour ||
    date.getMinutes() !== min || date.getSeconds() !== sec ||
    month < 1 || month > 12 || day < 1 || day > 31 ||
    hour > 23 || min > 59 || sec > 59
  ) {
    return { error: `${field || '时间'}不是合法日期时间` };
  }
  return { date, minutes: Math.floor(date.getTime() / 60000) };
}

function minutesBetween(startStr, endStr) {
  const s = parseDateTime(startStr);
  const e = parseDateTime(endStr);
  if (s.error || e.error) return null;
  return e.minutes - s.minutes;
}

const round3 = (n) => Math.round((n + Number.EPSILON) * 1000) / 1000;

function isNonNegNumber(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

// ---------- 读取 ----------
function loadArtworks(db) {
  return db.prepare('SELECT * FROM artworks ORDER BY id').all();
}

function loadSlots(db) {
  const slots = db.prepare('SELECT * FROM slots ORDER BY planned_start, seq, id').all();
  const links = db.prepare('SELECT * FROM slot_artworks').all();
  const bySlot = new Map();
  for (const l of links) {
    if (!bySlot.has(l.slot_id)) bySlot.set(l.slot_id, []);
    bySlot.get(l.slot_id).push(l.artwork_id);
  }
  for (const s of slots) {
    s.artworkIds = (bySlot.get(s.id) || []).slice();
  }
  return slots;
}

function plannedExposure(slot) {
  const mins = minutesBetween(slot.planned_start, slot.planned_end);
  if (mins === null || mins < 0) return null;
  return round3(mins * slot.planned_lux);
}

function actualExposure(slot) {
  if (slot.actual_start == null || slot.actual_end == null || slot.actual_lux == null) return null;
  const mins = minutesBetween(slot.actual_start, slot.actual_end);
  if (mins === null || mins < 0) return null;
  return round3(mins * slot.actual_lux);
}

// ---------- 实际照度分段 ----------
// 读取全部时段的分段记录；旧的单一照度结算时段没有分段，读取时由 actual_start/end/lux 合成单段。
function loadSegments(db) {
  const rows = db.prepare(`
    SELECT slot_id, seg_index, seg_start, seg_end, lux, exposure
    FROM slot_segments ORDER BY slot_id, seg_index
  `).all();
  const bySlot = new Map();
  for (const r of rows) {
    if (!bySlot.has(r.slot_id)) bySlot.set(r.slot_id, []);
    bySlot.get(r.slot_id).push(r);
  }
  return bySlot;
}

function segmentDto(seg, idx = null) {
  const minutes = minutesBetween(seg.seg_start, seg.seg_end);
  return {
    index: idx != null ? idx : seg.seg_index,
    start: seg.seg_start,
    end: seg.seg_end,
    minutes: minutes === null ? null : minutes,
    lux: seg.lux,
    exposure: seg.exposure,
  };
}

// 一个已结算时段“生效中”的分段：有分段记录用记录，否则用单一照度结算值合成一段
function effectiveSegments(slot, segMap) {
  const rows = segMap.get(slot.id);
  if (rows && rows.length) return rows.map((r, i) => segmentDto(r, i + 1));
  if (slot.actual_start != null && slot.actual_end != null && slot.actual_lux != null) {
    const minutes = minutesBetween(slot.actual_start, slot.actual_end);
    if (minutes !== null && minutes >= 0) {
      return [{
        index: 1,
        start: slot.actual_start,
        end: slot.actual_end,
        minutes,
        lux: slot.actual_lux,
        exposure: round3(minutes * slot.actual_lux),
      }];
    }
  }
  return [];
}

// ---------- 展出区间（暂停 / 恢复） ----------
// 读取全部时段的展出区间及其分段。返回 Map<slotId, intervals[]>，区间按 int_index 升序，
// 每段结构：{id, index, start, end, plannedEnd, plannedLux, exposure, active, segments:[segmentDto]}。
// plannedLux 取时段计划照度（恢复后仍按原计划照度预占）。
function loadIntervals(db) {
  const rows = db.prepare(`
    SELECT i.id AS iid, i.slot_id, i.int_index, i.int_start, i.int_end, i.planned_end,
           i.exposure, i.is_active, s.planned_lux
    FROM slot_intervals i JOIN slots s ON s.id = i.slot_id
    ORDER BY i.slot_id, i.int_index
  `).all();
  const segRows = db.prepare(`
    SELECT interval_id, seg_index, seg_start, seg_end, lux, exposure
    FROM slot_interval_segments ORDER BY interval_id, seg_index
  `).all();
  const segsByInt = new Map();
  for (const r of segRows) {
    if (!segsByInt.has(r.interval_id)) segsByInt.set(r.interval_id, []);
    segsByInt.get(r.interval_id).push(segmentDto(r, r.seg_index));
  }
  const bySlot = new Map();
  for (const r of rows) {
    if (!bySlot.has(r.slot_id)) bySlot.set(r.slot_id, []);
    bySlot.get(r.slot_id).push({
      id: r.iid,
      index: r.int_index,
      start: r.int_start,
      end: r.int_end,
      plannedEnd: r.planned_end,
      plannedLux: r.planned_lux,
      exposure: r.exposure,
      active: !!r.is_active,
      segments: segsByInt.get(r.iid) || [],
    });
  }
  return bySlot;
}

function hasIntervals(slot, intMap) {
  const list = intMap && intMap.get(slot.id);
  return !!(list && list.length);
}

// 已完成区间曝光合计（暂停空档不计）
function intervalsCompleted(intervals) {
  return round3(intervals.reduce((sum, iv) => sum + (iv.active ? 0 : (iv.exposure || 0)), 0));
}

// 当前进行中区间按“恢复时间 ~ 新预计结束 × 计划照度”的预占
function intervalsReserved(intervals) {
  const act = intervals.find((iv) => iv.active);
  if (!act) return 0;
  const mins = minutesBetween(act.start, act.plannedEnd);
  return mins === null || mins < 0 ? 0 : round3(mins * act.plannedLux);
}

function activeInterval(intervals) {
  return intervals.find((iv) => iv.active) || null;
}

// 一个时段的预占（lux·min）：
// 暂停模型：当前进行中区间（恢复时间~新预计结束 × 计划照度）；暂停中为 0；
// 旧模型（无区间）：running 按冻结原排期；scheduled 按计划区间。
function slotReservedExposure(slot, intervals) {
  if (Array.isArray(intervals) && intervals.length) {
    if (slot.status === 'paused') return 0;
    if (slot.status === 'running') return intervalsReserved(intervals);
    return 0;
  }
  if (slot.status === 'scheduled' || slot.status === 'running') return plannedExposure(slot) || 0;
  return 0;
}

// 一个时段已完成（计入已用）的实际曝光：
// 暂停模型（有区间）：各已完成区间之和（暂停中/恢复后的进行中均有历史已完成区间；最终结束后全部完成）；
// 旧模型：仅 finished 取 actual_exposure。
function slotCompletedExposure(slot, intervals) {
  if (Array.isArray(intervals) && intervals.length) {
    if (slot.status === 'finished' || slot.status === 'paused' || slot.status === 'running') {
      return intervalsCompleted(intervals);
    }
    return 0;
  }
  return slot.status === 'finished' ? (slot.actual_exposure || 0) : 0;
}

// 已结算时段对外展示的分段：暂停模型按区间顺序展平（标注区间号，区间之间的暂停空档自然断开）；
// 旧模型沿用 slot_segments / 单一照度合成。
function flattenedIntervalSegments(intervals) {
  const out = [];
  let n = 0;
  for (const iv of intervals) {
    for (const g of iv.segments) {
      n += 1;
      out.push({ ...g, index: n, intervalIndex: iv.index });
    }
  }
  return out;
}

// 时段对同作品“占用中”的全部时间区间（半开 [start,end)）：
// scheduled：计划区间；running：冻结区间或当前进行中区间（恢复时间~新预计结束）；
// paused：各已完成展出区间（空档不占）；finished：实际区间或各展出区间。
function slotOccupiedSpans(slot, intervals) {
  const mk = (start, end, kind) => {
    const s = parseDateTime(start);
    const e = parseDateTime(end);
    if (s.error || e.error || e.minutes <= s.minutes) return null;
    return { startMin: s.minutes, endMin: e.minutes, start, end, kind };
  };
  if (intervals && intervals.length) {
    const spans = [];
    for (const iv of intervals) {
      if (iv.active) spans.push(mk(iv.start, iv.plannedEnd, 'reserve'));
      else spans.push(mk(iv.start, iv.end, 'interval'));
    }
    return spans.filter(Boolean);
  }
  if (slot.status === 'scheduled' || slot.status === 'running') {
    const sp = mk(slot.planned_start, slot.planned_end, 'reserve');
    return sp ? [sp] : [];
  }
  if (slot.status === 'finished') {
    const sp = mk(slot.actual_start, slot.actual_end, 'interval');
    return sp ? [sp] : [];
  }
  return [];
}

// 检查候选区间（半开重叠）与同作品其他时段占用区间是否冲突。
// 返回 [{artworkId, artworkName, kind, self:{label,...}, other:{label,...}}]
function findArtworkOverlaps(db, artworkIds, selfSlotId, spanStartMin, spanEndMin, artName) {
  const others = loadSlots(db).filter((s) => s.id !== selfSlotId);
  const intMap = loadIntervals(db);
  const conflicts = [];
  for (const other of others) {
    const shared = artworkIds.filter((aid) => other.artworkIds.includes(aid));
    if (!shared.length) continue;
    const spans = slotOccupiedSpans(other, intMap.get(other.id) || []);
    for (const sp of spans) {
      if (spanStartMin < sp.endMin && sp.startMin < spanEndMin) {
        for (const aid of shared) {
          conflicts.push({
            artworkId: aid,
            artworkName: artName ? artName.get(aid) : `#${aid}`,
            kind: sp.kind === 'reserve' ? 'overlap-reserve' : 'overlap-interval',
            other: {
              slotId: other.id, hall: other.hall, status: other.status,
              start: sp.start, end: sp.end,
              label: `${other.hall} ${sp.start} ~ ${sp.end}（${statusLabel(other.status)}）`,
            },
          });
        }
      }
    }
  }
  return conflicts;
}

function statusLabel(status) {
  return { scheduled: '未开始', running: '进行中', paused: '已暂停', finished: '已结束' }[status] || status;
}

function loadCorrections(db) {
  const rows = db.prepare(`
    SELECT id, slot_id, reason, before_start, before_end, before_exposure,
           after_start, after_end, after_exposure, base_version, created_at
    FROM slot_corrections ORDER BY slot_id, id
  `).all();
  const segRows = db.prepare(`
    SELECT correction_id, seg_index, seg_start, seg_end, lux, exposure
    FROM slot_correction_segments ORDER BY correction_id, seg_index
  `).all();
  const segsByCorr = new Map();
  for (const r of segRows) {
    if (!segsByCorr.has(r.correction_id)) segsByCorr.set(r.correction_id, []);
    segsByCorr.get(r.correction_id).push(segmentDto(r, r.seg_index));
  }
  const bySlot = new Map();
  for (const r of rows) {
    if (!bySlot.has(r.slot_id)) bySlot.set(r.slot_id, []);
    bySlot.get(r.slot_id).push({
      id: r.id,
      slotId: r.slot_id,
      reason: r.reason,
      before: { start: r.before_start, end: r.before_end, exposure: r.before_exposure },
      after: {
        start: r.after_start,
        end: r.after_end,
        exposure: r.after_exposure,
        segments: segsByCorr.get(r.id) || [],
      },
      baseVersion: r.base_version,
      createdAt: r.created_at,
    });
  }
  return bySlot;
}

function intervalDto(iv, plannedLux) {
  const mins = (start, end) => minutesBetween(start, end);
  const plannedMins = mins(iv.start, iv.plannedEnd);
  return {
    index: iv.index,
    start: iv.start,
    end: iv.end,
    plannedEnd: iv.plannedEnd,
    plannedLux,
    active: iv.active,
    minutes: iv.end == null ? null : mins(iv.start, iv.end),
    plannedMinutes: plannedMins,
    exposure: iv.exposure,
    reserved: iv.active && plannedMins !== null && plannedMins > 0
      ? round3(plannedMins * plannedLux) : 0,
    segments: iv.segments.map((g) => ({
      index: g.index, start: g.start, end: g.end,
      minutes: g.minutes, lux: g.lux, exposure: g.exposure,
    })),
  };
}

function slotDto(slot, artworksById, segMap = null, corrMap = null, intMap = null) {
  const planned = plannedExposure(slot);
  const intervals = intMap ? (intMap.get(slot.id) || []) : [];
  const pausedModel = intervals.length > 0;
  // actual_exposure 在暂停模型中兼作“已完成区间累计曝光”（暂停中亦有值）
  const actual = slot.status === 'finished'
    ? slot.actual_exposure
    : (pausedModel ? (slot.actual_exposure || 0) : actualExposure(slot));
  let blockedReason = null;
  try { blockedReason = JSON.parse(slot.blocked_reason || '{}'); } catch { blockedReason = {}; }
  const active = activeInterval(intervals);
  const completed = pausedModel ? intervalsCompleted(intervals) : null;
  const reservedNow = slotReservedExposure(slot, pausedModel ? intervals : undefined);
  return {
    id: slot.id,
    hall: slot.hall,
    seq: slot.seq,
    status: slot.status,
    plannedStart: slot.planned_start,
    plannedEnd: slot.planned_end,
    plannedLux: slot.planned_lux,
    plannedMinutes: planned === null ? null : minutesBetween(slot.planned_start, slot.planned_end),
    plannedExposure: planned,
    actualStart: slot.actual_start,
    actualEnd: slot.actual_end,
    actualLux: slot.actual_lux,
    actualMinutes: slot.status === 'finished' && !pausedModel && actual !== null
      ? minutesBetween(slot.actual_start, slot.actual_end)
      : null,
    actualExposure: actual,
    actualSegments: pausedModel
      ? flattenedIntervalSegments(intervals)
      : (segMap ? effectiveSegments(slot, segMap) : []),
    intervals: pausedModel ? intervals.map((iv) => intervalDto(iv, slot.planned_lux)) : [],
    // 暂停次数：暂停中/进行中=已完成区间数；最终结束后=区间数-1（末段为最后一次恢复后结束）
    pauseCount: pausedModel
      ? (slot.status === 'finished' ? Math.max(0, intervals.length - 1) : intervals.filter((iv) => !iv.active).length)
      : 0,
    cumulativeExposure: pausedModel ? completed : (slot.status === 'finished' ? actual : null),
    activeInterval: active && slot.status === 'running' ? intervalDto(active, slot.planned_lux) : null,
    currentReserved: slot.status === 'running' || slot.status === 'scheduled' ? reservedNow : 0,
    corrections: (corrMap && corrMap.get(slot.id)) || [],
    blocked: !!slot.blocked,
    blockedReason,
    artworks: slot.artworkIds.map((id) => {
      const a = artworksById.get(id);
      return { id, name: a ? a.name : `#${id}` };
    }),
  };
}

// ---------- 汇总 ----------
function summarize(db) {
  const artworks = loadArtworks(db);
  const slots = loadSlots(db);
  const segMap = loadSegments(db);
  const corrMap = loadCorrections(db);
  const intMap = loadIntervals(db);
  const artworksById = new Map(artworks.map((a) => [a.id, a]));

  const acc = new Map();
  for (const a of artworks) {
    acc.set(a.id, { used: a.existing_amount, reservedRunning: 0, reservedScheduled: 0 });
  }

  for (const slot of slots) {
    const intervals = intMap.get(slot.id) || [];
    const completed = slotCompletedExposure(slot, intervals);
    for (const aid of slot.artworkIds) {
      if (!acc.has(aid)) continue;
      const row = acc.get(aid);
      if (slot.status === 'finished') row.used += completed;
      else if (slot.status === 'running') {
        row.used += completed;                                     // 暂停前已完成区间计入已用
        row.reservedRunning += slotReservedExposure(slot, intervals); // 当前区间按新预计预占
      } else if (slot.status === 'paused') {
        row.used += completed;                                     // 暂停空档不预占
      } else row.reservedScheduled += plannedExposure(slot) || 0;  // 含被标记为不可启动的时段
    }
  }

  const artworkDtos = artworks.map((a) => {
    const r = acc.get(a.id);
    const used = round3(r.used);
    const reserved = round3(r.reservedRunning + r.reservedScheduled);
    const committed = round3(used + reserved);
    const balance = round3(a.limit_amount - committed);
    return {
      id: a.id,
      name: a.name,
      limit: a.limit_amount,
      existing: a.existing_amount,
      note: a.note,
      used,
      reserved,
      reservedRunning: round3(r.reservedRunning),
      reservedScheduled: round3(r.reservedScheduled),
      committed,
      balance,
      over: balance < 0,
    };
  });

  return {
    version: db.prepare('SELECT version FROM meta WHERE id = 1').get().version,
    artworks: artworkDtos,
    slots: slots.map((s) => slotDto(s, artworksById, segMap, corrMap, intMap)),
  };
}

// ---------- 实际照度分段校验 ----------
// 要求：非空数组；每段 start/end 为合法时间、end 晚于 start、lux 非负；
// 各段按提交顺序首尾衔接（前一段 end 必须等于后一段 start）、无重叠，
// 且完整覆盖 [actualStart, actualEnd]。任一不满足返回错误列表（整批拒绝）。
// 通过时返回规范化分段 [{start, end, minutes, lux, exposure}]。
function validateSegments(segments, spanStart, spanEnd) {
  const errors = [];
  if (!Array.isArray(segments) || segments.length === 0) {
    return { errors: ['照度分段必须为非空数组，每段包含 start、end 与非负 lux'] };
  }
  const parsed = [];
  segments.forEach((raw, i) => {
    const where = `第 ${i + 1} 段`;
    const s = parseDateTime(raw && raw.start, `${where} 开始时间`);
    const e = parseDateTime(raw && raw.end, `${where} 结束时间`);
    let bad = false;
    if (s.error) { errors.push(s.error); bad = true; }
    if (e.error) { errors.push(e.error); bad = true; }
    if (!bad && e.minutes <= s.minutes) {
      errors.push(`${where}：时序无效，结束时间必须晚于开始时间`);
      bad = true;
    }
    const lux = Number(raw && raw.lux);
    if (!isNonNegNumber(lux)) {
      errors.push(`${where}：照度必须为非负数值`);
      bad = true;
    }
    // 非法段保留占位（可能缺分钟），以便继续检测衔接/覆盖；最终有错误即整批拒绝
    parsed.push(bad ? null : {
      start: raw.start.trim(), end: raw.end.trim(),
      startMin: s.minutes, endMin: e.minutes, lux,
    });
  });
  // 段内错误不中断：非法段置 null，仍对可解析分段做衔接/覆盖检查，把问题一次性返回
  const valid = parsed.filter(Boolean);
  // 排序/衔接/覆盖：按提交顺序，第一段必须从区间起点开始，逐段首尾衔接，最后一段结束于区间终点
  if (valid.length && valid[0].startMin !== spanStart.minutes) {
    errors.push(`分段未从实际开始时间开始：首段起点 ${valid[0].start}，实际开始 ${spanStart.text}`);
  }
  for (let i = 1; i < valid.length; i++) {
    const prev = valid[i - 1], cur = valid[i];
    if (cur.startMin < prev.endMin) {
      errors.push(`分段在 ${cur.start} 附近存在重叠，分段必须首尾衔接、无重叠`);
    } else if (cur.startMin > prev.endMin) {
      errors.push(`分段在 ${prev.end} 与 ${cur.start} 之间存在缺口，分段必须首尾衔接`);
    }
  }
  if (valid.length && valid[valid.length - 1].endMin !== spanEnd.minutes) {
    errors.push(`分段未覆盖到实际结束时间：末段终点 ${valid[valid.length - 1].end}，实际结束 ${spanEnd.text}`);
  }
  if (errors.length || valid.length !== parsed.length) return { errors };

  return {
    segments: parsed.map((p, i) => ({
      start: p.start,
      end: p.end,
      minutes: p.endMin - p.startMin,
      lux: p.lux,
      exposure: round3((p.endMin - p.startMin) * p.lux),
    })),
  };
}

function sumSegmentExposure(segments) {
  return round3(segments.reduce((sum, s) => sum + s.exposure, 0));
}

// ---------- 预算核算：按开始时间/编号顺序标记不可启动的时段 ----------
// 规则：按时序逐个尝试放入未开始时段，任一关联作品余额不足即标记为不可启动
// 并记下缺口；被标记的时段视为不会启动，不再占用后续预算。
function recomputeBlocked(db) {
  const slots = loadSlots(db);
  const intMap = loadIntervals(db);
  const artworks = loadArtworks(db);
  const used = new Map(artworks.map((a) => [a.id, a.existing_amount]));
  const names = new Map(artworks.map((a) => [a.id, a.name]));
  const limits = new Map(artworks.map((a) => [a.id, a.limit_amount]));

  // 已用 + 已冻结预占（进行中/已结束/已暂停），暂停空档不预占
  for (const s of slots) {
    if (s.status === 'scheduled') continue;
    const intervals = intMap.get(s.id) || [];
    const completed = slotCompletedExposure(s, intervals);
    const reserved = s.status === 'running' ? slotReservedExposure(s, intervals) : 0;
    const charge = round3(completed + reserved);
    for (const aid of s.artworkIds) if (used.has(aid)) used.set(aid, used.get(aid) + charge);
  }

  const ordered = slots
    .filter((s) => s.status === 'scheduled')
    .sort((a, b) =>
      minutesBetween('2000-01-01T00:00', a.planned_start) - minutesBetween('2000-01-01T00:00', b.planned_start) ||
      a.seq - b.seq || a.id - b.id
    );

  const upd = db.prepare('UPDATE slots SET blocked = ?, blocked_reason = ? WHERE id = ?');
  for (const s of ordered) {
    const expo = plannedExposure(s) || 0;
    const gaps = [];
    for (const aid of s.artworkIds) {
      if (!used.has(aid)) continue;
      const projected = used.get(aid) + expo;
      if (projected > limits.get(aid) + 1e-9) {
        gaps.push({
          artworkId: aid,
          artworkName: names.get(aid),
          has: round3(limits.get(aid) - used.get(aid)),         // 当前可用余额
          need: round3(expo),                                    // 本时段需求
          gap: round3(projected - limits.get(aid)),              // 缺口
        });
      }
    }
    if (gaps.length > 0) {
      upd.run(1, JSON.stringify({ gaps }), s.id);
      // 不可启动：不占用后续预算
    } else {
      upd.run(0, '{}', s.id);
      for (const aid of s.artworkIds) if (used.has(aid)) used.set(aid, used.get(aid) + expo);
    }
  }
  // 进行中 / 已结束时段不参与“不可启动”标记
  db.prepare("UPDATE slots SET blocked = 0, blocked_reason = '{}' WHERE status != 'scheduled'").run();
}

function bumpVersion(db) {
  db.prepare('UPDATE meta SET version = version + 1 WHERE id = 1').run();
}

module.exports = {
  parseDateTime,
  minutesBetween,
  round3,
  isNonNegNumber,
  loadArtworks,
  loadSlots,
  loadSegments,
  loadCorrections,
  loadIntervals,
  hasIntervals,
  activeInterval,
  intervalsCompleted,
  intervalsReserved,
  slotReservedExposure,
  slotCompletedExposure,
  slotOccupiedSpans,
  flattenedIntervalSegments,
  findArtworkOverlaps,
  statusLabel,
  effectiveSegments,
  plannedExposure,
  actualExposure,
  validateSegments,
  sumSegmentExposure,
  summarize,
  recomputeBlocked,
  bumpVersion,
};
