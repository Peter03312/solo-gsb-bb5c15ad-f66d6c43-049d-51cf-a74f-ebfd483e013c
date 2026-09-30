'use strict';
const B = require('./budget');

class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

// 检查并发版本（过期则 409 并返回最新预算）
function requireVersion(db, body) {
  const current = db.prepare('SELECT version FROM meta WHERE id = 1').get().version;
  const got = Number(body && body.version);
  if (!Number.isInteger(got) || got !== current) {
    throw new HttpError(409, 'VERSION_STALE', `版本已过期：当前版本 v${current}，请基于最新预算重新调整`, {
      stale: true,
      state: B.summarize(db),
    });
  }
  return current;
}

const parseId = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) { reject(new HttpError(413, 'BODY_TOO_LARGE', '请求体过大')); req.destroy(); }
      raw += chunk;
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(new HttpError(400, 'BAD_JSON', '请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

// ---------- 作品 ----------
function validateArtwork(body, db, selfId = null) {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) throw new HttpError(422, 'VALIDATION', '作品名称不能为空', { field: 'name' });
  if (name.length > 100) throw new HttpError(422, 'VALIDATION', '作品名称过长（最多 100 字）', { field: 'name' });
  const dup = db.prepare('SELECT id FROM artworks WHERE name = ?').get(name);
  if (dup && dup.id !== selfId) throw new HttpError(422, 'VALIDATION', `作品名称「${name}」已存在`, { field: 'name' });

  const limit = Number(body.limit);
  const existing = Number(body.existing);
  if (!B.isNonNegNumber(limit)) throw new HttpError(422, 'VALIDATION', '曝光上限必须为非负数值', { field: 'limit' });
  if (!B.isNonNegNumber(existing)) throw new HttpError(422, 'VALIDATION', '既有累计量必须为非负数值', { field: 'existing' });
  if (existing > limit + 1e-9) {
    throw new HttpError(422, 'VALIDATION', '既有累计量不得超过展期曝光上限', { field: 'existing' });
  }
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 200) : '';
  return { name, limit, existing, note };
}

function createArtwork(db, body) {
  requireVersion(db, body);
  const d = validateArtwork(body, db);
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO artworks (name, limit_amount, existing_amount, note) VALUES (?, ?, ?, ?)')
      .run(d.name, d.limit, d.existing, d.note);
    B.recomputeBlocked(db);
    B.bumpVersion(db);
    return B.summarize(db);
  });
  return tx.immediate();
}

function updateArtwork(db, id, body) {
  requireVersion(db, body);
  const d = validateArtwork(body, db, id);
  const tx = db.transaction(() => {
    const r = db.prepare('UPDATE artworks SET name = ?, limit_amount = ?, existing_amount = ?, note = ? WHERE id = ?')
      .run(d.name, d.limit, d.existing, d.note, id);
    if (r.changes === 0) throw new HttpError(404, 'NOT_FOUND', `作品 #${id} 不存在`);
    B.recomputeBlocked(db);
    B.bumpVersion(db);
    return B.summarize(db);
  });
  return tx.immediate();
}

function deleteArtwork(db, id, body) {
  requireVersion(db, body);
  const tx = db.transaction(() => {
    const ref = db.prepare('SELECT COUNT(*) AS c FROM slot_artworks WHERE artwork_id = ?').get(id).c;
    if (ref > 0) throw new HttpError(409, 'IN_USE', `作品 #${id} 已被 ${ref} 个时段引用，不能删除；请先调整排期`);
    const r = db.prepare('DELETE FROM artworks WHERE id = ?').run(id);
    if (r.changes === 0) throw new HttpError(404, 'NOT_FOUND', `作品 #${id} 不存在`);
    B.bumpVersion(db);
    return B.summarize(db);
  });
  return tx.immediate();
}

// ---------- 排期整批调整 ----------
function describeSlot(s) {
  return {
    cid: s.cid, hall: s.hall, start: s.start, end: s.end, lux: s.lux,
    artworkIds: s.artworkIds,
    label: `${s.hall || '(未填展厅)'} ${s.start || '?'} ~ ${s.end || '?'}`,
  };
}

// 整批校验并替换全部“未开始”时段。进行中/已结束时段冻结，不允许改动。
function replaceSchedule(db, body) {
  requireVersion(db, body);
  if (!body || !Array.isArray(body.slots)) {
    throw new HttpError(422, 'VALIDATION', '请求需要 slots 数组（整批未开始时段）');
  }

  const artworks = B.loadArtworks(db);
  const artIds = new Set(artworks.map((a) => a.id));
  const artName = new Map(artworks.map((a) => [a.id, a.name]));

  const proposed = [];
  const errors = [];

  body.slots.forEach((raw, idx) => {
    const cid = raw && raw.cid != null ? String(raw.cid) : `#${idx + 1}`;
    const where = () => `第 ${idx + 1} 行 [${cid}]`;
    const hall = typeof raw.hall === 'string' ? raw.hall.trim() : '';
    if (!hall) errors.push({ cid, message: `${where()}：展厅不能为空` });

    const s = B.parseDateTime(raw.start, `${where()} 开始时间`);
    const e = B.parseDateTime(raw.end, `${where()} 结束时间`);
    if (s.error) errors.push({ cid, message: s.error });
    if (e.error) errors.push({ cid, message: e.error });
    if (!s.error && !e.error && e.minutes <= s.minutes) {
      errors.push({ cid, message: `${where()}：时序无效，结束时间必须晚于开始时间` });
    }

    const lux = Number(raw.lux);
    if (!B.isNonNegNumber(lux)) errors.push({ cid, message: `${where()}：照度必须为非负数值` });

    let ids = raw.artworkIds;
    if (!Array.isArray(ids) || ids.length === 0) {
      errors.push({ cid, message: `${where()}：至少选择一件展出作品` });
      ids = [];
    }
    const numIds = [];
    for (const x of ids || []) {
      const n = Number(x);
      if (!Number.isInteger(n) || !artIds.has(n)) {
        errors.push({ cid, message: `${where()}：作品 #${x} 不存在` });
      } else if (!numIds.includes(n)) numIds.push(n);
    }

    proposed.push({
      cid, hall,
      start: s.error ? null : raw.start,
      startMin: s.error ? null : s.minutes,
      end: e.error ? null : raw.end,
      endMin: e.error ? null : e.minutes,
      lux: B.isNonNegNumber(lux) ? lux : 0,
      artworkIds: numIds,
    });
  });

  if (errors.length) throw new HttpError(422, 'BATCH_REJECTED', '整批已拒绝：存在无效时段', { errors });

  // 1) 同作品时段重叠：新时段之间
  const overlapConflicts = [];
  const byArt = new Map();
  proposed.forEach((s) => s.artworkIds.forEach((aid) => {
    if (!byArt.has(aid)) byArt.set(aid, []);
    byArt.get(aid).push(s);
  }));
  const pairKey = new Set();
  const addOverlap = (aid, a, b, kind) => {
    const k1 = `${aid}|${a.cid}|${b.cid}`;
    if (pairKey.has(k1)) return;
    pairKey.add(k1);
    overlapConflicts.push({
      artworkId: aid, artworkName: artName.get(aid), kind,
      slotA: describeSlot(a), slotB: describeSlot(b),
    });
  };
  for (const [aid, list] of byArt) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        if (a.startMin < b.endMin && b.startMin < a.endMin) addOverlap(aid, a, b, 'new-new');
      }
    }
  }

  // 新时段与冻结/进行中/已暂停/已结束时段之间（暂停空档不占用：暂停时段只比对已闭合展出区间）
  const frozen = B.loadSlots(db).filter((s) => s.status !== 'scheduled');
  const intMap = B.loadIntervals(db);
  for (const p of proposed) {
    for (const f of frozen) {
      const shared = p.artworkIds.filter((aid) => f.artworkIds.includes(aid));
      if (!shared.length) continue;
      const spans = B.occupiedSpans(f, intMap);
      spans.forEach((span) => {
        const a = B.parseDateTime(span.start);
        const b = B.parseDateTime(span.end);
        const fs = a.minutes, fe = b.minutes;
        if (p.startMin < fe && fs < p.endMin) {
          const statusText = f.status === 'finished' ? '已结束'
            : f.status === 'paused' ? '已暂停·已展出区间'
            : (f.resume_start ? '进行中·恢复后预占' : '进行中·冻结');
          const fView = {
            cid: `saved#${f.id}`, hall: f.hall,
            start: span.start, end: span.end,
            lux: f.status === 'finished' ? f.actual_lux : f.planned_lux,
            artworkIds: f.artworkIds,
            label: `${f.hall} ${span.start} ~ ${span.end}（${statusText}）`,
          };
          for (const aid of shared) addOverlap(aid, p, fView, 'new-frozen');
        }
      });
    }
  }

  if (overlapConflicts.length) {
    throw new HttpError(422, 'BATCH_REJECTED', '整批已拒绝：存在同作品时段重叠', {
      conflicts: overlapConflicts,
    });
  }

  // 2) 预算：既有 + 已完成区间/已结束实际 + 进行中（恢复后）预占 + 本批未开始预占 <= 上限
  const used = new Map(artworks.map((a) => [a.id, a.existing_amount]));
  for (const f of frozen) {
    const intervals = intMap.get(f.id) || [];
    for (const aid of f.artworkIds) {
      if (!used.has(aid)) continue;
      if (f.status === 'finished') {
        used.set(aid, used.get(aid) + (intervals.length
          ? B.completedIntervalExposure(f, intMap)
          : (f.actual_exposure || 0)));
      } else if (f.status === 'running' || f.status === 'paused') {
        if (intervals.length) {
          used.set(aid, used.get(aid) + B.completedIntervalExposure(f, intMap) + (B.openReservation(f) || 0));
        } else if (f.status === 'running') {
          used.set(aid, used.get(aid) + (B.plannedExposure(f) || 0));
        }
      }
    }
  }

  const budgetExceeded = [];
  const needByArt = new Map(artworks.map((a) => [a.id, 0]));
  for (const p of proposed) {
    const expo = B.round3((p.endMin - p.startMin) * p.lux);
    for (const aid of p.artworkIds) needByArt.set(aid, (needByArt.get(aid) || 0) + expo);
  }
  for (const a of artworks) {
    const projected = B.round3(used.get(a.id) + needByArt.get(a.id));
    if (projected > a.limit_amount + 1e-9) {
      budgetExceeded.push({
        artworkId: a.id,
        artworkName: a.name,
        limit: a.limit_amount,
        used: B.round3(used.get(a.id)),
        projected,
        overflow: B.round3(projected - a.limit_amount),
      });
    }
  }
  if (budgetExceeded.length) {
    throw new HttpError(422, 'BATCH_REJECTED', '整批已拒绝：有作品预占后将超过展期上限', {
      budgetExceeded,
    });
  }

  // 全部通过：整批替换
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM slot_artworks WHERE slot_id IN (SELECT id FROM slots WHERE status = 'scheduled')").run();
    db.prepare("DELETE FROM slots WHERE status = 'scheduled'").run();

    const insSlot = db.prepare(`
      INSERT INTO slots (hall, seq, status, planned_start, planned_end, planned_lux)
      VALUES (?, 0, 'scheduled', ?, ?, ?)
    `);
    const insLink = db.prepare('INSERT INTO slot_artworks (slot_id, artwork_id) VALUES (?, ?)');
    for (const p of proposed) {
      const sid = insSlot.run(p.hall, p.start, p.end, p.lux).lastInsertRowid;
      p.artworkIds.forEach((aid) => insLink.run(sid, aid));
    }

    // 重新统一编号：开始时间升序，相同则按插入顺序
    const all = B.loadSlots(db).sort((a, b) => {
      const sa = B.parseDateTime(a.planned_start).minutes;
      const sb = B.parseDateTime(b.planned_start).minutes;
      return sa - sb || a.id - b.id;
    });
    const updSeq = db.prepare('UPDATE slots SET seq = ? WHERE id = ?');
    all.forEach((s, i) => updSeq.run(i + 1, s.id));

    B.recomputeBlocked(db);
    B.bumpVersion(db);
    return B.summarize(db);
  });
  return tx.immediate();
}

// ---------- 时段生命周期 ----------
function startSlot(db, id) {
  const tx = db.transaction(() => {
    const slot = db.prepare('SELECT * FROM slots WHERE id = ?').get(id);
    if (!slot) throw new HttpError(404, 'NOT_FOUND', `时段 #${id} 不存在`);
    if (slot.status !== 'scheduled') {
      throw new HttpError(422, 'NOT_STARTABLE', `时段 #${id} 当前状态为 ${slot.status}，仅未开始时段可以启动`);
    }
    if (slot.blocked) {
      let reason = {};
      try { reason = JSON.parse(slot.blocked_reason || '{}'); } catch { /* noop */ }
      throw new HttpError(422, 'BLOCKED', `时段 #${id} 预算不足，禁止启动；请先调整排期后重新核算`, {
        blockedReason: reason,
      });
    }
    // 开始：冻结原排期，预占保留
    db.prepare("UPDATE slots SET status = 'running' WHERE id = ?").run(id);
    B.recomputeBlocked(db);
    B.bumpVersion(db);
    return B.summarize(db);
  });
  return tx.immediate();
}

function finishSlot(db, id, body) {
  const as = B.parseDateTime(body.actualStart, '实际开始时间');
  const ae = B.parseDateTime(body.actualEnd, '实际结束时间');
  if (as.error) throw new HttpError(422, 'VALIDATION', as.error);
  if (ae.error) throw new HttpError(422, 'VALIDATION', ae.error);
  if (ae.minutes <= as.minutes) throw new HttpError(422, 'VALIDATION', '时序无效：实际结束必须晚于实际开始');
  const lux = Number(body.actualLux);
  if (!B.isNonNegNumber(lux)) throw new HttpError(422, 'VALIDATION', '实际照度必须为非负数值');
  const minutes = ae.minutes - as.minutes;
  const exposure = B.round3(minutes * lux);

  const tx = db.transaction(() => {
    const slot = db.prepare('SELECT * FROM slots WHERE id = ?').get(id);
    if (!slot) throw new HttpError(404, 'NOT_FOUND', `时段 #${id} 不存在`);
    if (slot.status === 'paused') {
      throw new HttpError(422, 'NOT_RUNNING', `时段 #${id} 当前已暂停，请先恢复，或使用多段结算（settle）按已展出区间结束`);
    }
    if (slot.status !== 'running') {
      throw new HttpError(422, 'NOT_RUNNING', `时段 #${id} 当前状态为 ${slot.status}，仅进行中时段可以结束补记`);
    }
    const hasIntervals = db.prepare('SELECT COUNT(*) AS c FROM slot_intervals WHERE slot_id = ?').get(id).c > 0;
    if (hasIntervals) {
      throw new HttpError(422, 'NOT_RUNNING',
        `时段 #${id} 已存在暂停/恢复的展出区间，单一照度补记不适用；请用多段结算（settle）提交恢复时间起的最后区间，或在暂停状态下不带区间直接收尾`);
    }
    // 实际曝光替换该时段预占
    db.prepare(`
      UPDATE slots SET status = 'finished',
        actual_start = ?, actual_end = ?, actual_lux = ?, actual_exposure = ?
      WHERE id = ?
    `).run(body.actualStart, body.actualEnd, lux, exposure, id);

    B.recomputeBlocked(db);
    B.bumpVersion(db);
    const state = B.summarize(db);
    const blocked = state.slots
      .filter((s) => s.status === 'scheduled' && s.blocked)
      .sort((a, b) => a.seq - b.seq);
    return { ...state, justFinishedExposure: exposure, blockedAfterFinish: blocked };
  });
  return tx.immediate();
}

// ---------- 多段照度结算 / 分段更正 ----------
// 解析实际区间（actualStart/actualEnd），返回 {start, end} 或抛出 VALIDATION
function parseActualSpan(body, prefix) {
  const as = B.parseDateTime(body && body.actualStart, '实际开始时间');
  const ae = B.parseDateTime(body && body.actualEnd, '实际结束时间');
  if (as.error) throw new HttpError(422, 'VALIDATION', as.error);
  if (ae.error) throw new HttpError(422, 'VALIDATION', ae.error);
  if (ae.minutes <= as.minutes) {
    throw new HttpError(422, 'VALIDATION', '时序无效：实际结束必须晚于实际开始');
  }
  return {
    start: body.actualStart.trim(),
    end: body.actualEnd.trim(),
    startMin: as.minutes,
    endMin: ae.minutes,
  };
}

// 校验分段；不通过则整批拒绝（422 SEGMENTS_INVALID），不改变任何数据
function requireSegments(body, span) {
  const v = B.validateSegments(body && body.segments, {
    minutes: span.startMin, text: span.start,
  }, {
    minutes: span.endMin, text: span.end,
  });
  if (v.errors) throw new HttpError(422, 'SEGMENTS_INVALID', '整批已拒绝：照度分段不合法（须首尾衔接、无重叠且完整覆盖实际区间）', {
    errors: v.errors,
  });
  return v.segments;
}

// 整批替换某时段的分段（调用方须在事务内）
function replaceSegments(db, slotId, segments) {
  db.prepare('DELETE FROM slot_segments WHERE slot_id = ?').run(slotId);
  const ins = db.prepare(`
    INSERT INTO slot_segments (slot_id, seg_index, seg_start, seg_end, lux, exposure)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  segments.forEach((s, i) => ins.run(slotId, i + 1, s.start, s.end, s.lux, s.exposure));
}

// ---------- 暂停 / 恢复：展出区间 ----------
// 解析显式起止字段（暂停用 start/end，区别于老结算的 actualStart/actualEnd）
function parseNamedSpan(body, startField, endField) {
  const as = B.parseDateTime(body && body[startField], '本次展出区间开始时间');
  const ae = B.parseDateTime(body && body[endField], '本次展出区间结束时间');
  if (as.error) throw new HttpError(422, 'VALIDATION', as.error);
  if (ae.error) throw new HttpError(422, 'VALIDATION', ae.error);
  if (ae.minutes <= as.minutes) {
    throw new HttpError(422, 'VALIDATION', '时序无效：区间结束时间必须晚于开始时间');
  }
  return {
    start: String(body[startField]).trim(),
    end: String(body[endField]).trim(),
    startMin: as.minutes,
    endMin: ae.minutes,
  };
}

// 写入一个已闭合展出区间及其完整衔接分段，返回区间总曝光
function insertInterval(db, slotId, intIndex, span, segments) {
  const exposure = B.sumSegmentExposure(segments);
  const intervalId = db.prepare(`
    INSERT INTO slot_intervals (slot_id, int_index, int_start, int_end, exposure)
    VALUES (?, ?, ?, ?, ?)
  `).run(slotId, intIndex, span.start, span.end, exposure).lastInsertRowid;
  const ins = db.prepare(`
    INSERT INTO slot_interval_segments (interval_id, seg_index, seg_start, seg_end, lux, exposure)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  segments.forEach((s, i) => ins.run(intervalId, i + 1, s.start, s.end, s.lux, s.exposure));
  return exposure;
}

function replaceIntervalSegments(db, intervalRowId, span, segments) {
  db.prepare('DELETE FROM slot_interval_segments WHERE interval_id = ?').run(intervalRowId);
  const ins = db.prepare(`
    INSERT INTO slot_interval_segments (interval_id, seg_index, seg_start, seg_end, lux, exposure)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  segments.forEach((s, i) => ins.run(intervalRowId, i + 1, s.start, s.end, s.lux, s.exposure));
  db.prepare('UPDATE slot_intervals SET exposure = ? WHERE id = ?')
    .run(B.sumSegmentExposure(segments), intervalRowId);
}

// 校验本时段提交的一组时间跨度是否与“同作品其他时段”的占用区间重叠
// （已结束=实际/已闭合区间；进行中=冻结或恢复后预占；已暂停=仅已闭合区间，空档不占用；未开始=计划区间）。
function intervalOverlapConflicts(db, selfSlotId, artworkIds, spans, kind) {
  const intMap = B.loadIntervals(db);
  const others = B.loadSlots(db).filter((s) => s.id !== selfSlotId);
  const artName = new Map(B.loadArtworks(db).map((a) => [a.id, a.name]));
  const conflicts = [];
  const seen = new Set();
  for (const span of spans) {
    if (span.startMin == null || span.endMin == null) continue;
    for (const f of others) {
      const shared = artworkIds.filter((aid) => f.artworkIds.includes(aid));
      if (!shared.length) continue;
      for (const fs of B.occupiedSpans(f, intMap)) {
        const a = B.parseDateTime(fs.start);
        const b = B.parseDateTime(fs.end);
        if (a.error || b.error) continue;
        if (span.startMin < b.minutes && a.minutes < span.endMin) {
          const statusText = f.status === 'finished' ? '已结束'
            : f.status === 'paused' ? '已暂停·已展出区间'
            : f.status === 'running' ? '进行中'
            : '未开始';
          for (const aid of shared) {
            const key = `${aid}|${span.start}|${span.end}|${f.id}|${fs.start}|${fs.end}`;
            if (seen.has(key)) continue;
            seen.add(key);
            conflicts.push({
              artworkId: aid,
              artworkName: artName.get(aid),
              kind,
              slotA: {
                cid: 'submitted', hall: '', start: span.start, end: span.end, artworkIds,
                label: `${span.start} ~ ${span.end}（本次提交）`,
              },
              slotB: {
                cid: `saved#${f.id}`, hall: f.hall, start: fs.start, end: fs.end,
                artworkIds: f.artworkIds,
                label: `${f.hall} ${fs.start} ~ ${fs.end}（${statusText}）`,
              },
            });
          }
        }
      }
    }
  }
  return conflicts;
}

// 读取时段关联作品 id（事务内）
function slotArtworkIds(db, slotId) {
  return db.prepare('SELECT artwork_id FROM slot_artworks WHERE slot_id = ?')
    .all(slotId).map((r) => r.artwork_id);
}

function blockedAfterMutation(state) {
  return state.slots
    .filter((s) => s.status === 'scheduled' && s.blocked)
    .sort((a, b) => a.seq - b.seq);
}

// 进行中时段：按实际起止 + 多段照度完成结算。必须携带当前版本（过期 409 + 最新预算）。
// Σ(段分钟×照度) 作为实际曝光，替换该时段预占；分段不合法则整批拒绝，结算与版本均不变。
// 暂停/恢复流（已有已闭合展出区间）：
//   - running（恢复后）：用 start/end + segments 闭合最后一段，新起点须等于恢复时间；
//   - paused：不带区间参数，按已提交的各展出区间累计直接收尾（暂停空档不曝光）。
function settleSlot(db, id, body) {
  const tx = db.transaction(() => {
    requireVersion(db, body);

    const slot = db.prepare('SELECT * FROM slots WHERE id = ?').get(id);
    if (!slot) throw new HttpError(404, 'NOT_FOUND', `时段 #${id} 不存在`);
    if (slot.status !== 'running' && slot.status !== 'paused') {
      throw new HttpError(422, 'NOT_RUNNING', `时段 #${id} 当前状态为 ${slot.status}，仅进行中/已暂停时段可以结算`);
    }

    const intMap = B.loadIntervals(db);
    const existing = intMap.get(id) || [];
    const isPauseFlow = existing.length > 0;
    const artworkIds = slotArtworkIds(db, id);

    // 已暂停且未提交新区间：直接按已闭合区间累计收尾（暂停空档不曝光）
    const wantsClose =
      slot.status === 'paused' &&
      body.start == null && body.end == null &&
      body.actualStart == null && body.actualEnd == null &&
      !Array.isArray(body.segments);

    let finalSegments = null;
    let exposure;

    if (isPauseFlow) {
      if (wantsClose) {
        // 不新增区间
      } else if (slot.status === 'running') {
        // 恢复后闭合最后一段：用 start/end，起点必须等于恢复时间
        const span = parseNamedSpan(body, 'start', 'end');
        const resumeMin = B.parseDateTime(slot.resume_start).minutes;
        if (span.startMin !== resumeMin) {
          throw new HttpError(422, 'VALIDATION',
            `时序无效：最终区间起点必须等于恢复时间 ${slot.resume_start}（收到 ${span.start}）`);
        }
        const lastEndMin = B.parseDateTime(existing[existing.length - 1].end).minutes;
        if (resumeMin <= lastEndMin) {
          throw new HttpError(422, 'VALIDATION', '时序无效：最终区间起点必须晚于上次暂停终点');
        }
        const segments = requireSegments(body, span);
        const conflicts = intervalOverlapConflicts(db, id, artworkIds, [span], 'settle-frozen');
        if (conflicts.length) {
          throw new HttpError(422, 'INTERVAL_OVERLAP', '整次已拒绝：本次展出区间与同作品其他时段重叠', { conflicts });
        }
        insertInterval(db, id, existing.length + 1, span, segments);
        finalSegments = segments;
      } else {
        throw new HttpError(422, 'VALIDATION', '时段已暂停：请先恢复并展出后再提交最后区间；或直接提交不带起止/分段的请求按已展出区间收尾');
      }

      const intervalsAfter = B.loadIntervals(db).get(id) || [];
      exposure = B.round3(intervalsAfter.reduce((s, it) => s + it.exposure, 0));
      const firstStart = intervalsAfter[0].start;
      const lastEnd = intervalsAfter[intervalsAfter.length - 1].end;
      db.prepare(`
        UPDATE slots SET status = 'finished', resume_start = NULL, estimated_end = NULL,
          actual_start = ?, actual_end = ?, actual_lux = NULL, actual_exposure = ?
        WHERE id = ?
      `).run(firstStart, lastEnd, exposure, id);
    } else {
      // 从未暂停的老链路：actualStart/actualEnd + segments（行为与上一版完全一致）
      if (slot.status !== 'running') {
        throw new HttpError(422, 'NOT_RUNNING', '该时段没有已闭合展出区间，不能按暂停流收尾');
      }
      const span = parseActualSpan(body);
      const segments = requireSegments(body, span);
      const conflicts = intervalOverlapConflicts(db, id, artworkIds,
        [{ start: span.start, end: span.end, startMin: span.startMin, endMin: span.endMin }], 'settle-frozen');
      if (conflicts.length) {
        throw new HttpError(422, 'INTERVAL_OVERLAP', '整次已拒绝：本次展出区间与同作品其他时段重叠', { conflicts });
      }
      exposure = B.sumSegmentExposure(segments);
      db.prepare(`
        UPDATE slots SET status = 'finished',
          actual_start = ?, actual_end = ?, actual_lux = NULL, actual_exposure = ?
        WHERE id = ?
      `).run(span.start, span.end, exposure, id);
      replaceSegments(db, id, segments);
      finalSegments = segments;
    }

    B.recomputeBlocked(db);
    B.bumpVersion(db);
    const state = B.summarize(db);
    const settled = state.slots.find((s) => s.id === id) || null;
    return {
      ...state,
      justFinishedExposure: exposure,
      justFinishedSegments: settled
        ? (settled.intervals && settled.intervals.length
            ? settled.intervals.flatMap((it) => it.segments)
            : settled.actualSegments)
        : finalSegments,
      justIntervals: settled ? settled.intervals : [],
      accumulatedExposure: settled ? settled.accumulatedExposure : exposure,
      blockedAfterFinish: blockedAfterMutation(state),
    };
  });
  return tx.immediate();
}

// 暂停展出（临时闭馆）：提交本段展出区间 [start, end] 与完整衔接照度分段。
// 首次可录实际开始；其后 start 必须等于当前恢复时间；end 晚于本段起点。
// 暂停空档不计曝光：已完成区间计入已用，释放该时段未展预占。
function pauseSlot(db, id, body) {
  const tx = db.transaction(() => {
    requireVersion(db, body);

    const slot = db.prepare('SELECT * FROM slots WHERE id = ?').get(id);
    if (!slot) throw new HttpError(404, 'NOT_FOUND', `时段 #${id} 不存在`);
    if (slot.status !== 'running') {
      throw new HttpError(422, 'NOT_RUNNING', `时段 #${id} 当前状态为 ${slot.status}，仅进行中时段可以暂停`);
    }

    const span = parseNamedSpan(body, 'start', 'end');
    const segments = requireSegments(body, span);

    const existing = B.loadIntervals(db).get(id) || [];
    if (existing.length) {
      // 恢复后再次暂停：起点必须等于恢复时间，且晚于上次暂停终点
      const resumeMin = B.parseDateTime(slot.resume_start).minutes;
      const lastEndMin = B.parseDateTime(existing[existing.length - 1].end).minutes;
      if (span.startMin !== resumeMin) {
        throw new HttpError(422, 'VALIDATION',
          `时序无效：本次区间起点必须等于恢复时间 ${slot.resume_start}（收到 ${span.start}）`);
      }
      if (resumeMin <= lastEndMin) {
        throw new HttpError(422, 'VALIDATION', '时序无效：恢复时间必须晚于上次暂停终点');
      }
    }

    const artworkIds = slotArtworkIds(db, id);
    const conflicts = intervalOverlapConflicts(db, id, artworkIds, [span], 'pause-frozen');
    if (conflicts.length) {
      throw new HttpError(422, 'INTERVAL_OVERLAP', '整次已拒绝：本次展出区间与同作品其他时段重叠', { conflicts });
    }

    const intervalExposure = insertInterval(db, id, existing.length + 1, span, segments);

    // 释放未展预占；已完成区间在账目中计入已用；暂停次数 +1
    db.prepare("UPDATE slots SET status = 'paused', resume_start = NULL, estimated_end = NULL, pause_count = pause_count + 1 WHERE id = ?").run(id);

    B.recomputeBlocked(db);
    B.bumpVersion(db);
    const state = B.summarize(db);
    const paused = state.slots.find((s) => s.id === id) || null;
    return {
      ...state,
      pausedInterval: paused ? paused.intervals[paused.intervals.length - 1] : null,
      accumulatedExposure: paused ? paused.accumulatedExposure : null,
      currentReservation: paused ? paused.currentReservation : null,
      releasedReservation: intervalExposure,
      blockedAfterFinish: blockedAfterMutation(state),
    };
  });
  return tx.immediate();
}

// 恢复展出：提交恢复时间与新预计结束时间（按冻结的计划照度、新预计时长重新预占）。
// 恢复时间必须晚于上次暂停终点；新预计结束必须晚于恢复时间；
// 恢复后的预占区间不得与同作品其他时段重叠。
function resumeSlot(db, id, body) {
  const tx = db.transaction(() => {
    requireVersion(db, body);

    const slot = db.prepare('SELECT * FROM slots WHERE id = ?').get(id);
    if (!slot) throw new HttpError(404, 'NOT_FOUND', `时段 #${id} 不存在`);
    if (slot.status !== 'paused') {
      throw new HttpError(422, 'NOT_PAUSED', `时段 #${id} 当前状态为 ${slot.status}，仅已暂停时段可以恢复`);
    }

    const rs = B.parseDateTime(body && body.resumeTime, '恢复时间');
    const ee = B.parseDateTime(body && body.estimatedEnd, '新预计结束时间');
    if (rs.error) throw new HttpError(422, 'VALIDATION', rs.error);
    if (ee.error) throw new HttpError(422, 'VALIDATION', ee.error);
    if (ee.minutes <= rs.minutes) {
      throw new HttpError(422, 'VALIDATION', '时序无效：新预计结束时间必须晚于恢复时间');
    }

    const existing = B.loadIntervals(db).get(id) || [];
    if (!existing.length) throw new HttpError(422, 'VALIDATION', '该时段没有已闭合的展出区间，不能恢复');
    const lastEnd = existing[existing.length - 1].end;
    const lastEndMin = B.parseDateTime(lastEnd).minutes;
    if (rs.minutes <= lastEndMin) {
      throw new HttpError(422, 'VALIDATION', `时序无效：恢复时间必须晚于上次暂停终点 ${lastEnd}（收到 ${String(body.resumeTime).trim()}）`);
    }

    const artworkIds = slotArtworkIds(db, id);
    const span = { start: String(body.resumeTime).trim(), end: String(body.estimatedEnd).trim(), startMin: rs.minutes, endMin: ee.minutes };
    const conflicts = intervalOverlapConflicts(db, id, artworkIds, [span], 'resume-frozen');
    if (conflicts.length) {
      throw new HttpError(422, 'INTERVAL_OVERLAP', '整次已拒绝：恢复后的预占区间与同作品其他时段重叠', { conflicts });
    }

    db.prepare("UPDATE slots SET status = 'running', resume_start = ?, estimated_end = ? WHERE id = ?")
      .run(span.start, span.end, id);

    B.recomputeBlocked(db);
    B.bumpVersion(db);
    const state = B.summarize(db);
    const running = state.slots.find((s) => s.id === id) || null;
    return {
      ...state,
      resumedAt: span.start,
      estimatedEnd: span.end,
      currentReservation: running ? running.currentReservation : null,
      accumulatedExposure: running ? running.accumulatedExposure : null,
      blockedAfterFinish: blockedAfterMutation(state),
    };
  });
  return tx.immediate();
}

// 已结束时段：按“原实际起止 + 作品提交带理由的完整分段”更正。
// 新总量替换旧总量（不重复累计），同步重算作品已用量、后续不可启动状态与缺口；
// 记录更正前后的实际起止、曝光与理由。必须携带当前版本。
// 暂停/恢复流：body.intervalIndex 指定要更正的已闭合展出区间（暂停中/进行中/已结束均可），
// 新分段须完整覆盖该区间原起止；不传且非暂停流时沿用整段原实际起止（老链路兼容）。
function correctSlot(db, id, body) {
  const tx = db.transaction(() => {
    const baseVersion = requireVersion(db, body);

    const reason = body && typeof body.reason === 'string' ? body.reason.trim() : '';
    if (!reason) {
      throw new HttpError(422, 'VALIDATION', '更正必须填写理由（reason）', { field: 'reason' });
    }
    if (reason.length > 200) {
      throw new HttpError(422, 'VALIDATION', '更正理由过长（最多 200 字）', { field: 'reason' });
    }

    const slot = db.prepare('SELECT * FROM slots WHERE id = ?').get(id);
    if (!slot) throw new HttpError(404, 'NOT_FOUND', `时段 #${id} 不存在`);
    if (slot.status !== 'finished' && slot.status !== 'running' && slot.status !== 'paused') {
      throw new HttpError(422, 'NOT_FINISHED', `时段 #${id} 当前状态为 ${slot.status}，没有可更正的已展出区间`);
    }

    const intervalRows = db.prepare(`
      SELECT id, int_index, int_start, int_end, exposure FROM slot_intervals
      WHERE slot_id = ? ORDER BY int_index
    `).all(id);

    let span, beforeExposure, mode, targetInterval = null;
    let intervalIndex = null;
    if (intervalRows.length) {
      // 暂停/恢复流：必须指定区间
      intervalIndex = Number(body && body.intervalIndex);
      if (!Number.isInteger(intervalIndex) || intervalIndex < 1 || intervalIndex > intervalRows.length) {
        throw new HttpError(422, 'VALIDATION',
          `intervalIndex 必须为 1~${intervalRows.length} 的已闭合展出区间编号`);
      }
      targetInterval = intervalRows[intervalIndex - 1];
      span = {
        start: targetInterval.int_start,
        end: targetInterval.int_end,
        startMin: B.parseDateTime(targetInterval.int_start).minutes,
        endMin: B.parseDateTime(targetInterval.int_end).minutes,
      };
      beforeExposure = B.round3(targetInterval.exposure || 0);
      mode = 'interval';
    } else {
      if (slot.status !== 'finished') {
        throw new HttpError(422, 'NOT_FINISHED', `时段 #${id} 当前状态为 ${slot.status}，仅已结束时段可以分段更正`);
      }
      span = {
        start: slot.actual_start,
        end: slot.actual_end,
        startMin: B.parseDateTime(slot.actual_start).minutes,
        endMin: B.parseDateTime(slot.actual_end).minutes,
      };
      beforeExposure = B.round3(slot.actual_exposure || 0);
      mode = 'legacy';
    }

    const segments = requireSegments(body, span);
    const newExposure = B.sumSegmentExposure(segments);

    if (mode === 'interval') {
      replaceIntervalSegments(db, targetInterval.id, span, segments);
    } else {
      db.prepare('UPDATE slots SET actual_exposure = ? WHERE id = ?').run(newExposure, id);
      replaceSegments(db, id, segments);
    }

    db.prepare(`
      INSERT INTO slot_corrections
        (slot_id, reason, before_start, before_end, before_exposure,
         after_start, after_end, after_exposure, base_version, created_at, interval_index)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, reason,
      span.start, span.end, beforeExposure,
      span.start, span.end, newExposure, baseVersion,
      new Date().toISOString(), intervalIndex
    );
    const correctionId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
    const insCorrSeg = db.prepare(`
      INSERT INTO slot_correction_segments
        (correction_id, seg_index, seg_start, seg_end, lux, exposure)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    segments.forEach((s, i) => insCorrSeg.run(correctionId, i + 1, s.start, s.end, s.lux, s.exposure));

    B.recomputeBlocked(db);
    B.bumpVersion(db);
    const state = B.summarize(db);
    const corrected = state.slots.find((s) => s.id === id) || null;
    const record = corrected && corrected.corrections.length
      ? corrected.corrections[corrected.corrections.length - 1]
      : null;
    return {
      ...state,
      correction: record,
      intervalIndex,
      beforeExposure,
      afterExposure: newExposure,
      blockedAfterFinish: blockedAfterMutation(state),
    };
  });
  return tx.immediate();
}

module.exports = {
  HttpError, readBody, parseId,
  createArtwork, updateArtwork, deleteArtwork,
  replaceSchedule, startSlot, finishSlot, settleSlot, correctSlot,
  pauseSlot, resumeSlot,
};
