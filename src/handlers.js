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

  // 新时段与冻结时段（进行中，按冻结的原计划区间；已结束按实际区间）之间
  const frozen = B.loadSlots(db).filter((s) => s.status !== 'scheduled');
  for (const p of proposed) {
    for (const f of frozen) {
      const intersects = p.artworkIds.some((aid) => f.artworkIds.includes(aid));
      if (!intersects) continue;
      let fs, fe;
      if (f.status === 'finished') {
        const a = B.parseDateTime(f.actual_start);
        const b = B.parseDateTime(f.actual_end);
        fs = a.minutes; fe = b.minutes;
      } else {
        const a = B.parseDateTime(f.planned_start);
        const b = B.parseDateTime(f.planned_end);
        fs = a.minutes; fe = b.minutes;
      }
      if (p.startMin < fe && fs < p.endMin) {
        const fView = {
          cid: `saved#${f.id}`, hall: f.hall,
          start: f.status === 'finished' ? f.actual_start : f.planned_start,
          end: f.status === 'finished' ? f.actual_end : f.planned_end,
          lux: f.status === 'finished' ? f.actual_lux : f.planned_lux,
          artworkIds: f.artworkIds,
          label: `${f.hall} ${f.status === 'finished' ? f.actual_start : f.planned_start} ~ ${f.status === 'finished' ? f.actual_end : f.planned_end}（${f.status === 'finished' ? '已结束' : '进行中·冻结'}）`,
        };
        for (const aid of p.artworkIds) {
          if (f.artworkIds.includes(aid)) addOverlap(aid, p, fView, 'new-frozen');
        }
      }
    }
  }

  if (overlapConflicts.length) {
    throw new HttpError(422, 'BATCH_REJECTED', '整批已拒绝：存在同作品时段重叠', {
      conflicts: overlapConflicts,
    });
  }

  // 2) 预算：既有 + 进行中预占 + 本批未开始预占 <= 上限
  const used = new Map(artworks.map((a) => [a.id, a.existing_amount]));
  for (const f of frozen) {
    for (const aid of f.artworkIds) {
      if (!used.has(aid)) continue;
      if (f.status === 'finished') used.set(aid, used.get(aid) + (f.actual_exposure || 0));
      else used.set(aid, used.get(aid) + (B.plannedExposure(f) || 0));
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
    if (slot.status !== 'running') {
      throw new HttpError(422, 'NOT_RUNNING', `时段 #${id} 当前状态为 ${slot.status}，仅进行中时段可以结束补记`);
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

function blockedAfterMutation(state) {
  return state.slots
    .filter((s) => s.status === 'scheduled' && s.blocked)
    .sort((a, b) => a.seq - b.seq);
}

// 进行中时段：按实际起止 + 多段照度完成结算。必须携带当前版本（过期 409 + 最新预算）。
// Σ(段分钟×照度) 作为实际曝光，替换该时段预占；分段不合法则整批拒绝，结算与版本均不变。
function settleSlot(db, id, body) {
  const tx = db.transaction(() => {
    requireVersion(db, body);
    const span = parseActualSpan(body);
    const segments = requireSegments(body, span);
    const exposure = B.sumSegmentExposure(segments);

    const slot = db.prepare('SELECT * FROM slots WHERE id = ?').get(id);
    if (!slot) throw new HttpError(404, 'NOT_FOUND', `时段 #${id} 不存在`);
    if (slot.status !== 'running') {
      throw new HttpError(422, 'NOT_RUNNING', `时段 #${id} 当前状态为 ${slot.status}，仅进行中时段可以多段结算`);
    }

    db.prepare(`
      UPDATE slots SET status = 'finished',
        actual_start = ?, actual_end = ?, actual_lux = NULL, actual_exposure = ?
      WHERE id = ?
    `).run(span.start, span.end, exposure, id);
    replaceSegments(db, id, segments);

    B.recomputeBlocked(db);
    B.bumpVersion(db);
    const state = B.summarize(db);
    const settled = state.slots.find((s) => s.id === id) || null;
    return {
      ...state,
      justFinishedExposure: exposure,
      justFinishedSegments: settled ? settled.actualSegments : segments,
      blockedAfterFinish: blockedAfterMutation(state),
    };
  });
  return tx.immediate();
}

// 已结束时段：按“原实际起止 + 作品提交带理由的完整分段”更正。
// 新总量替换旧总量（不重复累计），同步重算作品已用量、后续不可启动状态与缺口；
// 记录更正前后的实际起止、曝光与理由。必须携带当前版本。
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
    if (slot.status !== 'finished') {
      throw new HttpError(422, 'NOT_FINISHED', `时段 #${id} 当前状态为 ${slot.status}，仅已结束时段可以分段更正`);
    }

    // 沿用原实际起止（更正只改分段照度，不允许改区间）；完整分段必须覆盖原区间
    const span = {
      start: slot.actual_start,
      end: slot.actual_end,
      startMin: B.parseDateTime(slot.actual_start).minutes,
      endMin: B.parseDateTime(slot.actual_end).minutes,
    };
    const segments = requireSegments(body, span);
    const newExposure = B.sumSegmentExposure(segments);
    const beforeExposure = B.round3(slot.actual_exposure || 0);

    db.prepare('UPDATE slots SET actual_exposure = ? WHERE id = ?').run(newExposure, id);
    replaceSegments(db, id, segments);
    db.prepare(`
      INSERT INTO slot_corrections
        (slot_id, reason, before_start, before_end, before_exposure,
         after_start, after_end, after_exposure, base_version, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, reason,
      slot.actual_start, slot.actual_end, beforeExposure,
      span.start, span.end, newExposure, baseVersion,
      new Date().toISOString()
    );
    // 更正记录携带本次“更正后分段”快照，历史记录可逐次还原
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
};
