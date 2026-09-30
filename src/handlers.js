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

  // 新时段与冻结时段（进行中/已暂停按各展出区间与当前预占区间；已结束按实际/展出区间）之间
  const frozen = B.loadSlots(db).filter((s) => s.status !== 'scheduled');
  const frozenIntMap = B.loadIntervals(db);
  for (const p of proposed) {
    for (const f of frozen) {
      const intersects = p.artworkIds.some((aid) => f.artworkIds.includes(aid));
      if (!intersects) continue;
      const spans = B.slotOccupiedSpans(f, frozenIntMap.get(f.id) || []);
      for (const sp of spans) {
        if (p.startMin < sp.endMin && sp.startMin < p.endMin) {
          const fView = {
            cid: `saved#${f.id}`, hall: f.hall,
            start: sp.start, end: sp.end,
            lux: sp.kind === 'reserve' ? f.planned_lux : null,
            artworkIds: f.artworkIds,
            label: `${f.hall} ${sp.start} ~ ${sp.end}（${B.statusLabel(f.status)}）`,
          };
          for (const aid of p.artworkIds) {
            if (f.artworkIds.includes(aid)) addOverlap(aid, p, fView, 'new-frozen');
          }
        }
      }
    }
  }

  if (overlapConflicts.length) {
    throw new HttpError(422, 'BATCH_REJECTED', '整批已拒绝：存在同作品时段重叠', {
      conflicts: overlapConflicts,
    });
  }

  // 2) 预算：既有 + 已完成区间已用 + 进行中当前预占 + 本批未开始预占 <= 上限
  const used = new Map(artworks.map((a) => [a.id, a.existing_amount]));
  for (const f of frozen) {
    const intervals = frozenIntMap.get(f.id) || [];
    const completed = B.slotCompletedExposure(f, intervals);
    const reserved = f.status === 'running' ? B.slotReservedExposure(f, intervals) : 0;
    const charge = B.round3(completed + reserved);
    for (const aid of f.artworkIds) {
      if (used.has(aid)) used.set(aid, used.get(aid) + charge);
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
    // 暂停/恢复模型时段须按最后展出区间多段结算（settle），单一照度链路不处理
    if ((B.loadIntervals(db).get(id) || []).length > 0) {
      throw new HttpError(422, 'SEGMENTS_REQUIRED',
        '该时段使用过暂停/恢复，请改用多段结算接口提交最后展出区间的完整照度分段');
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

    const slot = db.prepare('SELECT * FROM slots WHERE id = ?').get(id);
    if (!slot) throw new HttpError(404, 'NOT_FOUND', `时段 #${id} 不存在`);
    if (slot.status !== 'running') {
      throw new HttpError(422, 'NOT_RUNNING', `时段 #${id} 当前状态为 ${slot.status}，仅进行中时段可以多段结算`);
    }

    const intervals = B.loadIntervals(db).get(id) || [];
    const active = B.activeInterval(intervals);
    let span;
    if (active) {
      // 暂停/恢复模型：本次提交只覆盖“最后一个展出区间”，起点必须是恢复时间
      span = {
        start: active.start,
        end: null,
        startMin: B.parseDateTime(active.start).minutes,
      };
      const ae = B.parseDateTime(body && body.actualEnd, '实际结束时间');
      if (ae.error) throw new HttpError(422, 'VALIDATION', ae.error);
      if (body && body.actualStart != null && body.actualStart.trim() !== active.start) {
        throw new HttpError(422, 'VALIDATION',
          `最后展出区间已于 ${active.start} 恢复，实际开始必须为该恢复时间`);
      }
      if (ae.minutes <= span.startMin) {
        throw new HttpError(422, 'VALIDATION', '时序无效：实际结束必须晚于恢复时间');
      }
      span.end = body.actualEnd.trim();
      span.endMin = ae.minutes;

      const done = intervals.filter((iv) => !iv.active);
      if (done.length && ae.minutes <= B.parseDateTime(done[done.length - 1].end).minutes) {
        throw new HttpError(422, 'VALIDATION', '时序无效：实际结束必须晚于上次暂停终点');
      }
    } else {
      span = parseActualSpan(body);
    }
    const segments = requireSegments(body, span);
    const exposure = B.sumSegmentExposure(segments);

    // 同作品其他时段不得与最后展出区间重叠
    const artworkIds = B.loadSlots(db).find((x) => x.id === id).artworkIds;
    const artName = new Map(B.loadArtworks(db).map((a) => [a.id, a.name]));
    const overlaps = B.findArtworkOverlaps(db, artworkIds, id, span.startMin, span.endMin, artName);
    if (overlaps.length) throw overlapError(overlaps);

    if (active) {
      const prevCompleted = B.intervalsCompleted(intervals);
      const cumulative = B.round3(prevCompleted + exposure);
      // 完结当前区间
      db.prepare(`
        UPDATE slot_intervals SET int_end = ?, planned_end = ?, exposure = ?, is_active = 0
        WHERE id = ?
      `).run(span.end, active.plannedEnd, exposure, active.id);
      replaceIntervalSegments(db, active.id, segments);
      // 时段最终结束：actual 记录首段起点~最终终点（跨空档仅用于展示），累计为各区间之和
      const firstStart = intervals.slice().sort((a, b) => a.index - b.index)[0].start;
      db.prepare(`
        UPDATE slots SET status = 'finished',
          actual_start = ?, actual_end = ?, actual_lux = NULL, actual_exposure = ?
        WHERE id = ?
      `).run(firstStart, span.end, cumulative, id);

      B.recomputeBlocked(db);
      B.bumpVersion(db);
      const state = B.summarize(db);
      const settled = state.slots.find((s) => s.id === id) || null;
      return {
        ...state,
        justFinishedExposure: exposure,
        justFinishedSegments: segments,
        cumulativeExposure: cumulative,
        justFinishedSlot: settled,
        blockedAfterFinish: blockedAfterMutation(state),
      };
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
    const intervals = B.loadIntervals(db).get(id) || [];
    let span;
    let intervalGroups = null;   // 暂停模型：逐区间的更正分段
    let segmentsLegacy = null;   // 旧模型：覆盖整个实际区间的分段
    let newExposure;
    if (intervals.length) {
      // 暂停/恢复模型：segments 按区间分组提交，每组必须完整覆盖该展出区间（空档不补）
      const groups = body && Array.isArray(body.intervalSegments) ? body.intervalSegments : null;
      if (!groups || groups.length !== intervals.length) {
        throw new HttpError(422, 'SEGMENTS_INVALID',
          `该时段含 ${intervals.length} 个展出区间，请以 intervalSegments 数组逐区间提交完整分段`, {
          errors: [`需要 ${intervals.length} 组分段，收到 ${groups ? groups.length : 0} 组`],
        });
      }
      intervalGroups = [];
      let total = 0;
      intervals.forEach((iv, i) => {
        const ivSpan = {
          start: iv.start, end: iv.end,
          startMin: B.parseDateTime(iv.start).minutes,
          endMin: B.parseDateTime(iv.end).minutes,
        };
        const v = B.validateSegments(groups[i] && groups[i].segments,
          { minutes: ivSpan.startMin, text: ivSpan.start },
          { minutes: ivSpan.endMin, text: ivSpan.end });
        if (v.errors) {
          throw new HttpError(422, 'SEGMENTS_INVALID',
            `整批已拒绝：第 ${i + 1} 个展出区间照度分段不合法`, {
            errors: v.errors.map((m) => `[区间 ${i + 1}] ${m}`),
          });
        }
        intervalGroups.push(v.segments);
        total += B.sumSegmentExposure(v.segments);
      });
      newExposure = B.round3(total);
      span = {
        start: intervals[0].start,
        end: intervals[intervals.length - 1].end,
      };
    } else {
      span = {
        start: slot.actual_start,
        end: slot.actual_end,
        startMin: B.parseDateTime(slot.actual_start).minutes,
        endMin: B.parseDateTime(slot.actual_end).minutes,
      };
      segmentsLegacy = requireSegments(body, span);
      newExposure = B.sumSegmentExposure(segmentsLegacy);
    }
    const beforeExposure = B.round3(slot.actual_exposure || 0);

    db.prepare('UPDATE slots SET actual_exposure = ? WHERE id = ?').run(newExposure, id);
    if (intervalGroups) {
      intervals.forEach((iv, i) => replaceIntervalSegments(db, iv.id, intervalGroups[i]));
      // 同步区间曝光留档
      const updIv = db.prepare('UPDATE slot_intervals SET exposure = ? WHERE id = ?');
      intervals.forEach((iv, i) => updIv.run(B.sumSegmentExposure(intervalGroups[i]), iv.id));
    } else {
      replaceSegments(db, id, segmentsLegacy);
    }
    // 更正快照：暂停模型展平为段序列（标注区间号）；旧模型即原分段
    const snapshotSegments = intervalGroups
      ? intervalGroups.flatMap((list, ii) => list.map((g) => ({ ...g, intervalIndex: ii + 1 })))
      : segmentsLegacy;
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
    snapshotSegments.forEach((s, i) => insCorrSeg.run(correctionId, i + 1, s.start, s.end, s.lux, s.exposure));

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

// ---------- 巡展暂停 / 恢复（临时闭馆） ----------
// 区间模型：每次暂停提交“当前展出区间 [实际开始/恢复时间 → 暂停时间] + 完整衔接分段”，
// 已完成区间计入已用、释放未展预占；恢复提交“恢复时间 + 新预计结束”，从恢复时间起按
// 计划照度预占新的一段。允许多次暂停；最终结束走 settle（多段），分段覆盖最后一个区间。

function overlapError(conflicts) {
  return new HttpError(422, 'OVERLAP_CONFLICT', '整次已拒绝：与同作品其他时段占用区间重叠', {
    conflicts: conflicts.map((c) => ({
      artworkId: c.artworkId,
      artworkName: c.artworkName,
      kind: c.kind,
      other: c.other,
    })),
  });
}

// 在事务内替换某区间的分段
function replaceIntervalSegments(db, intervalId, segments) {
  db.prepare('DELETE FROM slot_interval_segments WHERE interval_id = ?').run(intervalId);
  const ins = db.prepare(`
    INSERT INTO slot_interval_segments (interval_id, seg_index, seg_start, seg_end, lux, exposure)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  segments.forEach((s, i) => ins.run(intervalId, i + 1, s.start, s.end, s.lux, s.exposure));
}

// 暂停：{version, actualStart?, pauseEnd, segments}
// 首次暂停 actualStart 可录实际开始（缺省取冻结计划开始）；再次暂停必须从恢复时间开始。
function pauseSlot(db, id, body) {
  const tx = db.transaction(() => {
    requireVersion(db, body);

    const slot = db.prepare('SELECT * FROM slots WHERE id = ?').get(id);
    if (!slot) throw new HttpError(404, 'NOT_FOUND', `时段 #${id} 不存在`);
    if (slot.status !== 'running') {
      throw new HttpError(422, 'NOT_RUNNING', `时段 #${id} 当前状态为 ${slot.status}，仅进行中时段可以暂停`);
    }

    const intervals = B.loadIntervals(db).get(id) || [];
    const active = B.activeInterval(intervals);

    // 本段起点：已有进行中区间则为其恢复时间（不可改）；首次暂停允许录实际开始
    let startStr, startMin;
    if (active) {
      if (body && body.actualStart != null && body.actualStart.trim() !== active.start) {
        throw new HttpError(422, 'VALIDATION',
          `本段已于 ${active.start} 恢复，暂停时区间起点必须为该恢复时间`);
      }
      startStr = active.start;
      startMin = B.parseDateTime(startStr).minutes;
    } else {
      startStr = body && body.actualStart != null && String(body.actualStart).trim() !== ''
        ? String(body.actualStart).trim() : slot.planned_start;
      const ps = B.parseDateTime(startStr, '实际开始时间');
      if (ps.error) throw new HttpError(422, 'VALIDATION', ps.error);
      startMin = ps.minutes;
    }

    const pe = B.parseDateTime(body && body.pauseEnd, '暂停时间');
    if (pe.error) throw new HttpError(422, 'VALIDATION', pe.error);
    if (pe.minutes <= startMin) {
      throw new HttpError(422, 'VALIDATION', '时序无效：暂停时间必须晚于本段起点');
    }
    const endStr = body.pauseEnd.trim();

    // 与既往已完成区间递增、互不重叠：暂停时间须晚于上一区间终点（起点为恢复时间，本身已更晚）
    const done = intervals.filter((iv) => !iv.active);
    if (done.length) {
      const prev = done[done.length - 1];
      const prevEnd = B.parseDateTime(prev.end).minutes;
      if (pe.minutes <= prevEnd) {
        throw new HttpError(422, 'VALIDATION',
          `时序无效：暂停时间 ${endStr} 必须晚于上次暂停终点 ${prev.end}`);
      }
    }

    // 分段必须首尾衔接、无重叠、完整覆盖 [本段起点, 暂停时间]
    const span = { start: startStr, end: endStr, startMin, endMin: pe.minutes };
    const segments = requireSegments(body, span);
    const exposure = B.sumSegmentExposure(segments);

    // 同作品其他时段（含未开始计划区间）不得与本展出区间重叠
    const artworkIds = B.loadSlots(db).find((x) => x.id === id).artworkIds;
    const artName = new Map(B.loadArtworks(db).map((a) => [a.id, a.name]));
    const overlaps = B.findArtworkOverlaps(db, artworkIds, id, startMin, pe.minutes, artName);
    if (overlaps.length) throw overlapError(overlaps);

    const cumulative = B.round3(B.intervalsCompleted(intervals) + exposure);

    if (active) {
      // 再次暂停：完结当前区间，保留其预计结束留档
      db.prepare(`
        UPDATE slot_intervals SET int_end = ?, planned_end = ?, exposure = ?, is_active = 0
        WHERE id = ?
      `).run(endStr, active.plannedEnd, exposure, active.id);
      replaceIntervalSegments(db, active.id, segments);
    } else {
      // 首次暂停：插入第 1 个已完成区间（planned_end 留档取暂停时间）
      const info = db.prepare(`
        INSERT INTO slot_intervals (slot_id, int_index, int_start, int_end, planned_end, exposure, is_active)
        VALUES (?, ?, ?, ?, ?, ?, 0)
      `).run(id, 1, startStr, endStr, endStr, exposure);
      replaceIntervalSegments(db, info.lastInsertRowid, segments);
    }

    // 暂停：空档释放预占；累计曝光写入 actual_exposure（读取层据此展示累计）
    db.prepare(`
      UPDATE slots SET status = 'paused', actual_start = ?, actual_end = ?,
        actual_lux = NULL, actual_exposure = ?
      WHERE id = ?
    `).run(startStr, endStr, cumulative, id);

    B.recomputeBlocked(db);
    B.bumpVersion(db);
    const state = B.summarize(db);
    const dto = state.slots.find((s) => s.id === id) || null;
    return {
      ...state,
      paused: dto,
      justPausedInterval: { start: startStr, end: endStr, exposure, segments },
      cumulativeExposure: cumulative,
      releasedReservation: true,
      blockedAfterFinish: blockedAfterMutation(state),
    };
  });
  return tx.immediate();
}

// 恢复：{version, resumeAt, newEstimatedEnd}
// 恢复时间晚于上次暂停终点；新预计结束晚于恢复时间；按新时长 × 计划照度重新预占。
function resumeSlot(db, id, body) {
  const tx = db.transaction(() => {
    requireVersion(db, body);

    const slot = db.prepare('SELECT * FROM slots WHERE id = ?').get(id);
    if (!slot) throw new HttpError(404, 'NOT_FOUND', `时段 #${id} 不存在`);
    if (slot.status !== 'paused') {
      throw new HttpError(422, 'NOT_PAUSED', `时段 #${id} 当前状态为 ${slot.status}，仅已暂停时段可以恢复`);
    }

    const intervals = B.loadIntervals(db).get(id) || [];
    const done = intervals.filter((iv) => !iv.active);
    const last = done[done.length - 1];
    if (!last) throw new HttpError(422, 'VALIDATION', '暂停区间数据缺失，无法恢复');

    const rs = B.parseDateTime(body && body.resumeAt, '恢复时间');
    if (rs.error) throw new HttpError(422, 'VALIDATION', rs.error);
    const resumeStr = body.resumeAt.trim();
    const lastEndMin = B.parseDateTime(last.end).minutes;
    if (rs.minutes <= lastEndMin) {
      throw new HttpError(422, 'VALIDATION',
        `时序无效：恢复时间 ${resumeStr} 必须晚于上次暂停终点 ${last.end}`);
    }

    const ne = B.parseDateTime(body && body.newEstimatedEnd, '新预计结束时间');
    if (ne.error) throw new HttpError(422, 'VALIDATION', ne.error);
    if (ne.minutes <= rs.minutes) {
      throw new HttpError(422, 'VALIDATION', '时序无效：新预计结束时间必须晚于恢复时间');
    }
    const newEndStr = body.newEstimatedEnd.trim();

    // 同作品其他时段不得与新预占区间 [恢复时间, 新预计结束) 重叠
    const links = B.loadSlots(db).find((x) => x.id === id).artworkIds;
    const artName = new Map(B.loadArtworks(db).map((a) => [a.id, a.name]));
    const overlaps = B.findArtworkOverlaps(db, links, id, rs.minutes, ne.minutes, artName);
    if (overlaps.length) throw overlapError(overlaps);

    const nextIndex = intervals.length + 1;
    db.prepare(`
      INSERT INTO slot_intervals (slot_id, int_index, int_start, int_end, planned_end, exposure, is_active)
      VALUES (?, ?, ?, NULL, ?, NULL, 1)
    `).run(id, nextIndex, resumeStr, newEndStr);

    // 恢复：status=running，actual_end 清空（展出重新进行中），累计曝光保留
    db.prepare("UPDATE slots SET status = 'running', actual_end = NULL WHERE id = ?").run(id);

    B.recomputeBlocked(db);
    B.bumpVersion(db);
    const state = B.summarize(db);
    const dto = state.slots.find((s) => s.id === id) || null;
    const reservedMins = ne.minutes - rs.minutes;
    return {
      ...state,
      resumed: dto,
      resumeAt: resumeStr,
      newEstimatedEnd: newEndStr,
      reservedExposure: B.round3(reservedMins * slot.planned_lux),
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
