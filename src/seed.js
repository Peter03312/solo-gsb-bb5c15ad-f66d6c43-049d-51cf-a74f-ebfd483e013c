'use strict';
const { recomputeBlocked } = require('./budget');

// 以 2026-09-30 为“今天”的演示数据：含已结束 / 进行中（冻结）/ 未开始时段。
// 初始数据满足全部预算约束。
// 演示超量：在页面把进行中时段（一号厅 09:00–13:00）以更高实际照度结束，
// 例如实际照度 300 lux（240 分钟 = 72000 lux·min），
// 随后的二号厅时段会因《山水轴》《星夜手稿》缺口被标记为“不可启动”。
function seed(db) {
  const hasMeta = db.prepare('SELECT COUNT(*) AS c FROM meta').get().c;
  if (!hasMeta) db.prepare('INSERT INTO meta (id, version) VALUES (1, 1)').run();
  const hasData = db.prepare('SELECT COUNT(*) AS c FROM artworks').get().c;
  if (hasData) return false;

  const insArt = db.prepare(
    'INSERT INTO artworks (name, limit_amount, existing_amount, note) VALUES (?, ?, ?, ?)'
  );
  const artIds = {};
  artIds.w1 = insArt.run('《山水轴》纸本水墨', 120000, 12000, '对光敏感').lastInsertRowid;
  artIds.w2 = insArt.run('《星夜手稿》水彩', 100000, 20000, '').lastInsertRowid;
  artIds.w3 = insArt.run('《青铜纹样》摄影', 120000, 30000, '耐照度较高').lastInsertRowid;

  const insSlot = db.prepare(`
    INSERT INTO slots (hall, seq, status, planned_start, planned_end, planned_lux,
                       actual_start, actual_end, actual_lux, actual_exposure, blocked, blocked_reason)
    VALUES (@hall, @seq, @status, @planned_start, @planned_end, @planned_lux,
            @actual_start, @actual_end, @actual_lux, @actual_exposure, 0, '{}')
  `);
  const link = db.prepare('INSERT INTO slot_artworks (slot_id, artwork_id) VALUES (?, ?)');
  const addLinks = (slotId, ids) => ids.forEach((aid) => link.run(slotId, aid));

  // 1. 已结束时段（实际曝光已补记并替换预占）：160 分钟 * 140 = 22400
  const s1 = insSlot.run({
    hall: '一号厅', seq: 1, status: 'finished',
    planned_start: '2026-09-29T09:00', planned_end: '2026-09-29T12:00', planned_lux: 150,
    actual_start: '2026-09-29T09:10', actual_end: '2026-09-29T11:50', actual_lux: 140,
    actual_exposure: 22400,
  }).lastInsertRowid;
  addLinks(s1, [artIds.w1]);

  // 2. 进行中时段：已开始，原排期冻结、预占保留（240 分钟 * 200 = 48000/件）
  const s2 = insSlot.run({
    hall: '一号厅', seq: 2, status: 'running',
    planned_start: '2026-09-30T09:00', planned_end: '2026-09-30T13:00', planned_lux: 200,
    actual_start: null, actual_end: null, actual_lux: null, actual_exposure: null,
  }).lastInsertRowid;
  addLinks(s2, [artIds.w1, artIds.w2]);

  // 3. 未开始（120 分钟 * 180 = 21600）：W1 当前预算足够
  const s3 = insSlot.run({
    hall: '二号厅', seq: 3, status: 'scheduled',
    planned_start: '2026-10-01T10:00', planned_end: '2026-10-01T12:00', planned_lux: 180,
    actual_start: null, actual_end: null, actual_lux: null, actual_exposure: null,
  }).lastInsertRowid;
  addLinks(s3, [artIds.w1]);

  // 4. 未开始（180 分钟 * 150 = 27000/件）：W2 / W3 联展
  const s4 = insSlot.run({
    hall: '二号厅', seq: 4, status: 'scheduled',
    planned_start: '2026-10-02T10:00', planned_end: '2026-10-02T13:00', planned_lux: 150,
    actual_start: null, actual_end: null, actual_lux: null, actual_exposure: null,
  }).lastInsertRowid;
  addLinks(s4, [artIds.w2, artIds.w3]);

  // 5. 未开始（90 分钟 * 220 = 19800）：W3 独享
  const s5 = insSlot.run({
    hall: '三号厅', seq: 5, status: 'scheduled',
    planned_start: '2026-10-03T09:30', planned_end: '2026-10-03T11:00', planned_lux: 220,
    actual_start: null, actual_end: null, actual_lux: null, actual_exposure: null,
  }).lastInsertRowid;
  addLinks(s5, [artIds.w3]);

  const tx = db.transaction(() => recomputeBlocked(db));
  tx.immediate();
  return true;
}

module.exports = { seed };
