'use strict';
// 端到端规则验证（使用临时内存数据库逻辑通过 HTTP 接口验证）
const BASE = process.env.BASE || 'http://localhost:8080';

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗ FAIL:', msg); }
}
async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({})).then((j) => j || {});
  return { status: res.status, json };
}
const getState = async () => (await call('GET', '/api/state')).json;

(async () => {
  console.log('# 1. 整批校验：负值 / 无效时序');
  let r = await call('POST', '/api/schedule', { version: 1, slots: [
    { cid: 'a', hall: 'X', start: '2026-10-05T10:00', end: '2026-10-05T09:00', lux: 100, artworkIds: [3] },
    { cid: 'b', hall: 'Y', start: '2026-10-06T10:00', end: '2026-10-06T11:00', lux: -5, artworkIds: [3] },
    { cid: 'c', hall: 'Z', start: '2026-02-30T10:00', end: '2026-10-06T11:00', lux: 5, artworkIds: [3] },
  ]});
  ok(r.status === 422 && r.json.errors.length === 3, `拒绝三种无效输入（得到 ${r.status}, ${r.json.errors?.length} 条）`);
  let st = await getState();
  ok(st.version === 1, '被拒绝后版本不变、数据不变');

  console.log('# 2. 同作品时段重叠（新-新 / 新-冻结）');
  r = await call('POST', '/api/schedule', { version: 1, slots: [
    { cid: 'p1', hall: '二号厅', start: '2026-10-10T10:00', end: '2026-10-10T12:00', lux: 100, artworkIds: [3] },
    { cid: 'p2', hall: '三号厅', start: '2026-10-10T11:00', end: '2026-10-10T13:00', lux: 100, artworkIds: [3] },
  ]});
  ok(r.status === 422 && r.json.conflicts?.length === 1, '新时段互相重叠被拒绝');
  ok(r.json.conflicts[0].artworkId === 3 && r.json.conflicts[0].slotA.cid === 'p1', '冲突指出作品与两个时段');

  r = await call('POST', '/api/schedule', { version: 1, slots: [
    { cid: 'f1', hall: '一号厅', start: '2026-09-30T10:00', end: '2026-09-30T11:00', lux: 100, artworkIds: [1] },
  ]});
  ok(r.status === 422 && r.json.conflicts?.[0]?.kind === 'new-frozen', '与进行中冻结时段重叠被拒绝');
  // 不同作品同一时间允许
  r = await call('POST', '/api/schedule', { version: 1, slots: [
    { cid: 'ok1', hall: '一号厅', start: '2026-09-30T10:00', end: '2026-09-30T11:00', lux: 100, artworkIds: [3] },
  ]});
  ok(r.status === 200, '不同作品同展厅时间重叠允许（仅按作品约束）');

  console.log('# 3. 预算超限整批拒绝');
  st = await getState(); // version 现在 2
  r = await call('POST', '/api/schedule', { version: st.version, slots: [
    { cid: 'big', hall: '四号厅', start: '2026-11-01T08:00', end: '2026-11-01T20:00', lux: 500, artworkIds: [2] },
  ]});
  ok(r.status === 422 && r.json.budgetExceeded?.[0]?.artworkId === 2,
     `超量拒绝并指出作品与超出值（overflow=${r.json.budgetExceeded?.[0]?.overflow}）`);
  st = await getState();
  ok(st.version === 2, '超量拒绝后版本不变');

  console.log('# 4. 过期版本并发拒绝');
  r = await call('POST', '/api/schedule', { version: 1, slots: [
    { cid: 'v', hall: '五号厅', start: '2026-12-01T10:00', end: '2026-12-01T11:00', lux: 10, artworkIds: [3] },
  ]});
  ok(r.status === 409 && r.json.error?.code === 'VERSION_STALE' && r.json.state.version === 2,
     `过期版本返回 409 与最新预算（state v${r.json.state?.version}）`);

  console.log('# 5. 合法整批保存 + 版本递增 + 重新编号');
  r = await call('POST', '/api/schedule', { version: 2, slots: [
    { cid: 'x', hall: '二号厅', start: '2026-10-20T10:00', end: '2026-10-20T12:00', lux: 120, artworkIds: [1, 2] },
    { cid: 'y', hall: '三号厅', start: '2026-10-19T09:00', end: '2026-10-19T10:00', lux: 80, artworkIds: [3] },
  ]});
  ok(r.status === 200 && r.json.version === 3, `整批保存成功，版本→${r.json.version}`);
  const sched = r.json.slots.filter((s) => s.status === 'scheduled').sort((a, b) => a.seq - b.seq);
  ok(sched.length === 2 && sched[0].hall === '三号厅' && sched[0].seq === 3 && sched[1].seq === 4,
     '按开始时间重新编号（冻结时段在前）');
  ok(sched.every((s) => !s.blocked), '预算充足：无不可启动时段');

  console.log('# 6. 启动进行中时段不允许 / 启动未开始时段');
  const target = sched[0]; // 三号厅 W3
  r = await call('POST', `/api/slots/2/start`);
  ok(r.status === 422 && r.json.error?.code === 'NOT_STARTABLE', '已在进行中的时段不能再次启动');
  r = await call('POST', `/api/slots/${target.id}/start`);
  ok(r.status === 200, '未开始时段可启动');
  st = r.json;
  const running3 = st.slots.find((s) => s.id === target.id);
  ok(running3.status === 'running', '状态变为进行中');
  ok(st.version === 4, '启动后版本 +1');
  // 启动后再保存排期：该时段必须从可编辑集合消失，且仍不可被重叠
  r = await call('POST', '/api/schedule', { version: 4, slots: [
    { cid: 'ov', hall: '三号厅', start: '2026-10-19T09:30', end: '2026-10-19T10:30', lux: 50, artworkIds: [3] },
  ]});
  ok(r.status === 422 && r.json.conflicts?.[0]?.kind === 'new-frozen', '启动后冻结：新排期与其重叠被拒');
  // 空批次合法
  r = await call('POST', '/api/schedule', { version: 4, slots: [] });
  ok(r.status === 200 && r.json.slots.filter((s) => s.status === 'scheduled').length === 0, '空批次合法（清空未开始排期）');

  console.log('# 7. 结束补记：无效时序拒绝');
  r = await call('POST', `/api/slots/${target.id}/finish`, {
    actualStart: '2026-10-19T10:00', actualEnd: '2026-10-19T09:00', actualLux: 100,
  });
  ok(r.status === 422, '实际结束早于开始被拒绝');
  r = await call('POST', `/api/slots/${target.id}/finish`, {
    actualStart: '2026-10-19T09:00', actualEnd: '2026-10-19T10:00', actualLux: -1,
  });
  ok(r.status === 422, '负照度被拒绝');

  console.log('# 8. 超量结算 → 后续时段按顺序标为不可启动并禁止启动');
  // 先重建排期：W1、W2 在进行中时段(2号 240min*200)之后
  st = await getState();
  r = await call('POST', '/api/schedule', { version: st.version, slots: [
    { cid: 'w1s', hall: '二号厅', start: '2026-10-01T10:00', end: '2026-10-01T12:00', lux: 180, artworkIds: [1] }, // 21600
    { cid: 'w2s', hall: '二号厅', start: '2026-10-02T10:00', end: '2026-10-02T13:00', lux: 150, artworkIds: [2, 3] }, // 27000
    { cid: 'w3s', hall: '三号厅', start: '2026-10-03T09:30', end: '2026-10-03T11:00', lux: 220, artworkIds: [3] }, // 19800
  ]});
  ok(r.status === 200, '恢复三条未开始时段');
  const beforeFinish = r.json;
  const w1Slot = beforeFinish.slots.find((s) => s.hall === '二号厅' && s.plannedStart.startsWith('2026-10-01'));
  const w2Slot = beforeFinish.slots.find((s) => s.hall === '二号厅' && s.plannedStart.startsWith('2026-10-02'));
  ok(!w1Slot.blocked && !w2Slot.blocked, '结算前均可启动');

  // 结束 slot 2（W1+W2），实际 300 lux × 240 = 72000，远超冻结预占 48000
  r = await call('POST', '/api/slots/2/finish', {
    actualStart: '2026-09-30T09:00', actualEnd: '2026-09-30T13:00', actualLux: 300,
  });
  ok(r.status === 200 && r.json.justFinishedExposure === 72000, `实际曝光 ${r.json.justFinishedExposure} 替换预占`);
  // W1: 12000+22400+72000 = 106400, 余 13600 < 21600 → 缺口 8000
  // W2: 20000+72000 = 92000, 余 8000 < 27000 → 缺口 19000
  const blockedIds = r.json.blockedAfterFinish.map((s) => s.id);
  ok(blockedIds.length === 2 && blockedIds[0] === w1Slot.id,
     `按开始顺序标出不可开始时段：#${r.json.blockedAfterFinish.map((s) => s.seq).join(', #')}`);
  const g1 = w1Slot ? r.json.blockedAfterFinish.find((s) => s.id === w1Slot.id).blockedReason.gaps[0] : null;
  ok(g1 && g1.artworkId === 1 && g1.gap === 8000 && g1.has === 13600 && g1.need === 21600,
     `W1 缺口数据正确（has=${g1?.has}, need=${g1?.need}, gap=${g1?.gap}）`);

  // 尝试启动被拦截时段
  r = await call('POST', `/api/slots/${w1Slot.id}/start`);
  ok(r.status === 422 && r.json.error?.code === 'BLOCKED' && r.json.blockedReason.gaps[0].gap === 8000,
     '预算不足时段禁止启动并返回缺口');

  // W3 时段（10-03）：由于 w2s 联展 W3 但被跳过（不占预算），W3 独立时段应仍可启动
  const w3Only = r.json ? null : null;
  st = await getState();
  const w3slot = st.slots.find((s) => s.plannedStart.startsWith('2026-10-03'));
  ok(!w3slot.blocked, '被拦截时段不占预算，后续预算充足的时段仍标记可启动（贪婪核算）');

  console.log('# 9. 调整排期后重新核算，缺口消除');
  r = await call('POST', '/api/schedule', { version: st.version, slots: [
    // W1 缩短到 60 分钟 × 180 = 10800 <= 13600
    { cid: 'w1f', hall: '二号厅', start: '2026-10-01T10:00', end: '2026-10-01T11:00', lux: 180, artworkIds: [1] },
    // W2 降到 50 lux × 60 = 3000 <= 8000，同时联展 W3
    { cid: 'w2f', hall: '二号厅', start: '2026-10-02T10:00', end: '2026-10-02T11:00', lux: 50, artworkIds: [2, 3] },
    { cid: 'w3f', hall: '三号厅', start: '2026-10-03T09:30', end: '2026-10-03T11:00', lux: 220, artworkIds: [3] },
  ]});
  ok(r.status === 200 && r.json.slots.filter((s) => s.status === 'scheduled').every((s) => !s.blocked),
     '调整后重新核算：所有时段均可启动');
  st = r.json;
  const w1Final = st.slots.find((s) => s.plannedStart.startsWith('2026-10-01'));
  r = await call('POST', `/api/slots/${w1Final.id}/start`);
  ok(r.status === 200, '调整后时段可以启动');

  console.log('# 10. 作品校验：既有>上限拒绝；重复名拒绝；被引用时删除拒绝');
  st = await getState(); // #9 的启动操作又递增过版本，重新取最新版本
  r = await call('POST', '/api/artworks', { version: st.version, name: '测试品', limit: 100, existing: 200 });
  ok(r.status === 422, '既有累计超过上限拒绝');
  r = await call('POST', '/api/artworks', { version: st.version, name: '《山水轴》纸本水墨', limit: 100, existing: 0 });
  ok(r.status === 422, '作品名重复拒绝');
  r = await call('DELETE', '/api/artworks/1', { version: st.version });
  ok(r.status === 409 && r.json.error?.code === 'IN_USE', '被时段引用的作品不可删除');

  console.log('# 11. 合法作品增删改');
  r = await call('POST', '/api/artworks', { version: st.version, name: '新增测试品', limit: 5000, existing: 100, note: 'hi' });
  ok(r.status === 200, '新作品录入成功');
  const newId = r.json.artworks.at(-1).id;
  r = await call('PUT', `/api/artworks/${newId}`, { version: r.json.version, name: '新增测试品改', limit: 6000, existing: 200, note: 'x' });
  ok(r.status === 200 && r.json.artworks.at(-1).limit === 6000, '作品更新成功');
  r = await call('DELETE', `/api/artworks/${newId}`, { version: r.json.version });
  ok(r.status === 200 && !r.json.artworks.some((a) => a.id === newId), '未被引用的作品可删除');

  // ---------- 本轮：多段照度结算（进行中时段） ----------
  console.log('# 12. 多段结算：版本、分段校验（缺口/重叠/未覆盖整批拒绝）');
  st = await getState();
  // 此时段 6（原 s2，一号厅 09-30）在 #8 已被单一照度结算为 finished；另找一个进行中时段：
  // #9 启动的是 10-01 的 W1 时段（#9 后又被 #10 等改动）。直接重建排期并启动一条新时段。
  r = await call('POST', '/api/schedule', { version: st.version, slots: [
    { cid: 'm1', hall: '六号厅', start: '2026-10-15T10:00', end: '2026-10-15T12:00', lux: 100, artworkIds: [3] },
  ]});
  ok(r.status === 200, '排入多段结算用时段');
  const mSlotId = r.json.slots.find((s) => s.plannedStart.startsWith('2026-10-15')).id;
  r = await call('POST', `/api/slots/${mSlotId}/start`);
  ok(r.status === 200, '多段结算用时段已启动');
  const vStarted = r.json.version;

  // 12.1 缺/错版本 -> 409 + 最新预算
  r = await call('POST', `/api/slots/${mSlotId}/settle`, {
    actualStart: '2026-10-15T10:00', actualEnd: '2026-10-15T12:00',
    segments: [{ start: '2026-10-15T10:00', end: '2026-10-15T12:00', lux: 100 }],
  });
  ok(r.status === 409 && r.json.error?.code === 'VERSION_STALE' && r.json.state.version === vStarted,
     '多段结算缺版本返回 409 与最新预算');

  // 12.2 分段不合法（缺口 + 重叠 + 未覆盖 + 负照度）整批拒绝
  r = await call('POST', `/api/slots/${mSlotId}/settle`, {
    version: vStarted,
    actualStart: '2026-10-15T10:00', actualEnd: '2026-10-15T12:00',
    segments: [
      { start: '2026-10-15T10:00', end: '2026-10-15T11:00', lux: 200 },
      { start: '2026-10-15T11:30', end: '2026-10-15T11:40', lux: 100 },
      { start: '2026-10-15T11:00', end: '2026-10-15T11:50', lux: -5 },
    ],
  });
  ok(r.status === 422 && r.json.error?.code === 'SEGMENTS_INVALID' && r.json.errors?.length >= 3,
     `分段缺口/重叠/未覆盖/负值整批拒绝（${r.json.errors?.length} 条错误）`);
  st = await getState();
  ok(st.version === vStarted && st.slots.find((s) => s.id === mSlotId).status === 'running',
     '分段被拒后结算与版本均不变');

  // 12.3 合法两段：60×200 + 60×80 = 16800
  r = await call('POST', `/api/slots/${mSlotId}/settle`, {
    version: vStarted,
    actualStart: '2026-10-15T10:00', actualEnd: '2026-10-15T12:00',
    segments: [
      { start: '2026-10-15T10:00', end: '2026-10-15T11:00', lux: 200 },
      { start: '2026-10-15T11:00', end: '2026-10-15T12:00', lux: 80 },
    ],
  });
  ok(r.status === 200 && r.json.justFinishedExposure === 16800, `多段结算成功，总量 ${r.json.justFinishedExposure}`);
  const settled = r.json.slots.find((s) => s.id === mSlotId);
  ok(settled.status === 'finished' && settled.actualSegments.length === 2 &&
     settled.actualSegments[0].exposure === 12000 && settled.actualSegments[1].exposure === 4800,
     '返回两段明细（分钟×照度）且首尾衔接完整覆盖');
  ok(settled.actualLux === null, '多段结算不写单一照度字段（以分段为准）');
  ok(r.json.version === vStarted + 1, '多段结算成功后版本 +1');
  const w3After = r.json.artworks.find((a) => a.id === 3);
  ok(w3After.used >= 16800, '作品已用量按多段总量计入');

  // 12.4 已结束时段不能再 settle
  r = await call('POST', `/api/slots/${mSlotId}/settle`, {
    version: r.json.version,
    actualStart: '2026-10-15T10:00', actualEnd: '2026-10-15T12:00',
    segments: [{ start: '2026-10-15T10:00', end: '2026-10-15T12:00', lux: 1 }],
  });
  ok(r.status === 422 && r.json.error?.code === 'NOT_RUNNING', '已结束时段不能再次多段结算');

  // ---------- 本轮：已结束时段分段更正 ----------
  console.log('# 13. 已结束时段分段更正：理由/版本/分段校验，更正前后曝光留痕，新总量替换旧总量');
  st = await getState();
  // slot 1：seed 单一照度结算（09-29 09:10~11:50 140lux = 22400），W1 展出
  // 13.1 缺理由
  r = await call('POST', '/api/slots/1/correct', {
    version: st.version,
    segments: [{ start: '2026-09-29T09:10', end: '2026-09-29T11:50', lux: 140 }],
  });
  ok(r.status === 422 && r.json.error?.code === 'VALIDATION', '更正缺理由被拒绝');
  // 13.2 分段不覆盖原区间
  r = await call('POST', '/api/slots/1/correct', {
    version: st.version, reason: '试填',
    segments: [{ start: '2026-09-29T09:10', end: '2026-09-29T11:00', lux: 140 }],
  });
  ok(r.status === 422 && r.json.error?.code === 'SEGMENTS_INVALID', '更正分段未完整覆盖原实际区间被整批拒绝');
  // 13.3 过期版本
  r = await call('POST', '/api/slots/1/correct', {
    version: 1, reason: '试填',
    segments: [{ start: '2026-09-29T09:10', end: '2026-09-29T11:50', lux: 140 }],
  });
  ok(r.status === 409 && r.json.state.version === st.version, '更正过期版本返回 409 与最新预算');
  // 失败均不改变总量与版本
  const st2 = await getState();
  const s1before = st2.slots.find((s) => s.id === 1);
  ok(st2.version === st.version && s1before.actualExposure === 22400 && s1before.corrections.length === 0,
     '更正失败不改变结算、分段与版本');
  // 13.4 非 finished 时段不能更正
  r = await call('POST', `/api/slots/${mSlotId + 1000}/correct`, { version: st.version, reason: 'x', segments: [] });
  ok(r.status === 404, '更正不存在时段返回 404');

  // 13.5 合法更正：140 整段(22400) -> 两段 60×100 + 100×150 = 21000
  r = await call('POST', '/api/slots/1/correct', {
    version: st.version,
    reason: '照度计复核：开场一小时 100 lux，之后恢复 150 lux',
    segments: [
      { start: '2026-09-29T09:10', end: '2026-09-29T10:10', lux: 100 },
      { start: '2026-09-29T10:10', end: '2026-09-29T11:50', lux: 150 },
    ],
  });
  ok(r.status === 200 && r.json.beforeExposure === 22400 && r.json.afterExposure === 21000,
     `更正成功：${r.json.beforeExposure} -> ${r.json.afterExposure}（替换而非累加）`);
  ok(r.json.correction && r.json.correction.before.exposure === 22400 &&
     r.json.correction.after.exposure === 21000 && r.json.correction.after.segments.length === 2 &&
     r.json.correction.baseVersion === st.version && !!r.json.correction.createdAt && !!r.json.correction.reason,
     '更正记录含更正前后曝光/时间、理由、版本、时间戳与分段快照');
  const s1after = r.json.slots.find((s) => s.id === 1);
  ok(s1after.actualSegments.length === 2 && s1after.corrections.length === 1 &&
     s1after.actualStart === '2026-09-29T09:10' && s1after.actualEnd === '2026-09-29T11:50',
     '时段展示新分段，原实际起止不变，更正历史 +1');
  const w1UsedAfterCorrect = r.json.artworks.find((a) => a.id === 1).used;
  st = await getState();
  ok(Math.abs(st.artworks.find((a) => a.id === 1).used - w1UsedAfterCorrect) < 1e-6, '作品已用量按替换后的总量同步重算');

  // 13.6 再次更正（回到更低值），历史累计两条；旧总量不重复计入
  r = await call('POST', '/api/slots/1/correct', {
    version: st.version,
    reason: '设备校准后最终核定为全程 90 lux',
    segments: [{ start: '2026-09-29T09:10', end: '2026-09-29T11:50', lux: 90 }],
  });
  ok(r.status === 200 && r.json.beforeExposure === 21000 && r.json.afterExposure === 14400,
     `二次更正：${r.json.beforeExposure} -> ${r.json.afterExposure}`);
  const s1two = r.json.slots.find((s) => s.id === 1);
  ok(s1two.corrections.length === 2 && s1two.actualSegments.length === 1,
     '更正历史累计 2 条，当前分段为最新一次提交');
  const w1Two = r.json.artworks.find((a) => a.id === 1).used;
  st = await getState();
  const w1Expect = 12000 + 14400 + (72000) /* slot2 已在 #8 按 72000 结算 */;
  ok(Math.abs(st.artworks.find((a) => a.id === 1).used - w1Expect) < 1e-6,
     `多次更正后 W1 已用 = 既有 + 各已结束时段最新总量（${w1Expect}），无重复累计`);

  // ---------- 本轮：更正触发后续时段不可启动重算 ----------
  console.log('# 14. 向上更正导致超量：同步重算后续时段不可启动状态与缺口，下调后解除');
  // 此时 W1：used=98400（12000 + slot1 的14400 + slot2 的72000），
  // 另有进行中冻结预占 10800（#9 启动的 2026-10-01 时段 60分×180），可用 10800。
  // g1 需 6000（放入后余 4800），g2 需 6000（更正前缺口1200？——实际预算校验按总量 21600 允许，
  // 但贪婪核算逐时段占用：10800 先给 g1 后余 4800，g2 即缺口 1200）。
  // 故更正前取 g1=6000 单段可启动、再加一条 4000 的 g2 均可启动（合计 10000 <= 10800）。
  st = await getState();
  r = await call('POST', '/api/schedule', { version: st.version, slots: [
    { cid: 'g1', hall: '七号厅', start: '2026-11-05T09:00', end: '2026-11-05T10:00', lux: 100, artworkIds: [1] }, // 6000
    { cid: 'g2', hall: '七号厅', start: '2026-11-06T09:00', end: '2026-11-06T09:40', lux: 100, artworkIds: [1] }, // 4000
  ]});
  ok(r.status === 200 && r.json.slots.filter((s) => s.status === 'scheduled').every((s) => !s.blocked),
     '更正前预算充足，后续时段均可启动');
  // 向上更正 slot1：14400 -> 22400（+8000）。可用余量 10800-8000=2800；
  // g1 需 6000 即缺口 3200，g2 顺延继续被标。
  r = await call('POST', '/api/slots/1/correct', {
    version: r.json.version,
    reason: '复核：实际照度高于初值',
    segments: [{ start: '2026-09-29T09:10', end: '2026-09-29T11:50', lux: 140 }],
  });
  ok(r.status === 200, '向上更正成功');
  const blockedAfter = r.json.blockedAfterFinish || [];
  const blk2 = r.json.slots.find((s) => s.plannedStart.startsWith('2026-11-06'));
  const blk1 = r.json.slots.find((s) => s.plannedStart.startsWith('2026-11-05'));
  ok(blk1.blocked && blk2.blocked && blockedAfter.length === 2, '更正后按开始顺序重算：预算不足的后续时段均被标不可启动');
  const gap = blk1.blockedReason.gaps[0];
  ok(gap && gap.artworkId === 1 && gap.gap === 3200 && gap.has === 2800 && gap.need === 6000,
     `更正后缺口数据正确（has=${gap?.has}, need=${gap?.need}, gap=${gap?.gap}）`);
  r = await call('POST', `/api/slots/${blk1.id}/start`);
  ok(r.status === 422 && r.json.error?.code === 'BLOCKED', '更正导致的不可启动时段禁止启动');
  // 下调更正解除
  st = await getState();
  r = await call('POST', '/api/slots/1/correct', {
    version: st.version,
    reason: '再次校准，恢复低值',
    segments: [{ start: '2026-09-29T09:10', end: '2026-09-29T11:50', lux: 90 }],
  });
  ok(r.status === 200 && (r.json.blockedAfterFinish || []).length === 0, '下调更正后缺口消除、后续时段恢复可启动');

  // ---------- 本轮：旧单一照度 finish 语义保持 ----------
  console.log('# 15. 旧 POST /finish（actualStart/End/Lux）单一照度结算语义保持');
  st = await getState();
  r = await call('POST', '/api/schedule', { version: st.version, slots: [
    { cid: 'leg', hall: '八号厅', start: '2026-12-10T09:00', end: '2026-12-10T10:00', lux: 100, artworkIds: [3] },
  ]});
  const legId = r.json.slots.find((s) => s.plannedStart.startsWith('2026-12-10')).id;
  r = await call('POST', `/api/slots/${legId}/start`);
  ok(r.status === 200, '旧链路：时段启动（不需要版本）');
  r = await call('POST', `/api/slots/${legId}/finish`, {
    actualStart: '2026-12-10T09:05', actualEnd: '2026-12-10T10:20', actualLux: 60,
  });
  ok(r.status === 200 && r.json.justFinishedExposure === 4500 && Array.isArray(r.json.blockedAfterFinish),
     `旧 finish 行为不变：75 分×60 = ${r.json.justFinishedExposure}，返回 justFinishedExposure/blockedAfterFinish（无需版本）`);
  const leg = r.json.slots.find((s) => s.id === legId);
  ok(leg.actualLux === 60 && leg.actualSegments.length === 1 && leg.actualSegments[0].lux === 60,
     '旧单一照度结算在分段视图中合成单段展示');

  // ---------- 本轮：巡展临时闭馆 暂停 / 恢复 ----------
  console.log('# 16. 暂停/恢复：区间闭合、空档释放预占、恢复重占、账目与缺口重算、区间更正');
  st = await getState();
  r = await call('POST', '/api/schedule', { version: st.version, slots: [
    { cid: 'pa', hall: '九号厅', start: '2028-03-01T09:00', end: '2028-03-01T17:00', lux: 100, artworkIds: [3] },
  ]});
  ok(r.status === 200, '排入暂停/恢复用时段');
  const paId = r.json.slots.find((s) => s.plannedStart.startsWith('2028-03-01')).id;
  r = await call('POST', `/api/slots/${paId}/start`);
  ok(r.status === 200, '暂停用时段已启动');
  let pv = r.json.version;

  // 16.1 缺/错版本 -> 409 + 最新预算
  r = await call('POST', `/api/slots/${paId}/pause`, {
    start: '2028-03-01T09:00', end: '2028-03-01T11:00',
    segments: [{ start: '2028-03-01T09:00', end: '2028-03-01T11:00', lux: 100 }],
  });
  ok(r.status === 409 && r.json.error?.code === 'VERSION_STALE' && r.json.state.version === pv,
     '暂停缺版本返回 409 与最新预算');

  // 16.2 分段非法整次拒绝（时序/缺口/负值）
  r = await call('POST', `/api/slots/${paId}/pause`, {
    version: pv, start: '2028-03-01T09:00', end: '2028-03-01T11:00',
    segments: [
      { start: '2028-03-01T09:00', end: '2028-03-01T10:00', lux: 200 },
      { start: '2028-03-01T10:30', end: '2028-03-01T11:00', lux: -5 },
    ],
  });
  ok(r.status === 422 && r.json.error?.code === 'SEGMENTS_INVALID', '暂停分段缺口/负值整次拒绝');
  // 暂停终点不晚于本段起点
  r = await call('POST', `/api/slots/${paId}/pause`, {
    version: pv, start: '2028-03-01T11:00', end: '2028-03-01T09:00',
    segments: [{ start: '2028-03-01T11:00', end: '2028-03-01T09:00', lux: 100 }],
  });
  ok(r.status === 422, '暂停终点早于起点被拒');
  st = await getState();
  ok(st.version === pv && st.slots.find((s) => s.id === paId).status === 'running' &&
     st.slots.find((s) => s.id === paId).currentReservation === 48000,
     '暂停被拒后状态/账目/版本不变（仍预占 480 分×100=48000）');

  // 16.3 首次暂停（可录实际开始）：60×200 + 60×100 = 18000
  r = await call('POST', `/api/slots/${paId}/pause`, {
    version: pv, start: '2028-03-01T09:00', end: '2028-03-01T11:00',
    segments: [
      { start: '2028-03-01T09:00', end: '2028-03-01T10:00', lux: 200 },
      { start: '2028-03-01T10:00', end: '2028-03-01T11:00', lux: 100 },
    ],
  });
  ok(r.status === 200 && r.json.pausedInterval.exposure === 18000, `首次暂停成功，本段=${r.json.pausedInterval?.exposure}`);
  const p1 = r.json.slots.find((s) => s.id === paId);
  ok(p1.status === 'paused' && p1.pauseCount === 1 && p1.currentReservation === 0 &&
     p1.accumulatedExposure === 18000 && p1.intervals.length === 1,
     '暂停态：预占释放为 0，累计已展 18000，区间 1 个');
  pv = r.json.version;

  // 16.4 暂停态不能再暂停/旧 finish；非暂停态不能恢复
  r = await call('POST', `/api/slots/${paId}/pause`, { version: pv, start: '2028-03-01T11:00', end: '2028-03-01T12:00',
    segments: [{ start: '2028-03-01T11:00', end: '2028-03-01T12:00', lux: 50 }] });
  ok(r.status === 422 && r.json.error.code === 'NOT_RUNNING', '暂停态再暂停被拒');
  r = await call('POST', `/api/slots/${paId}/finish`, { actualStart: '2028-03-01T09:00', actualEnd: '2028-03-01T15:00', actualLux: 1 });
  ok(r.status === 422 && r.json.error.code === 'NOT_RUNNING', '暂停态旧 finish 被拒');

  // 16.5 非法恢复时序
  r = await call('POST', `/api/slots/${paId}/resume`, { version: pv, resumeTime: '2028-03-01T11:00', estimatedEnd: '2028-03-01T18:00' });
  ok(r.status === 422, '恢复时间必须严格晚于上次暂停终点');
  r = await call('POST', `/api/slots/${paId}/resume`, { version: pv, resumeTime: '2028-03-01T13:00', estimatedEnd: '2028-03-01T12:00' });
  ok(r.status === 422, '新预计结束必须晚于恢复时间');

  // 16.6 暂停空档（11:00~13:00）允许同作品排期；已展区间不允许
  r = await call('POST', '/api/schedule', { version: pv, slots: [
    { cid: 'gapok', hall: '十号厅', start: '2028-03-01T11:30', end: '2028-03-01T12:30', lux: 100, artworkIds: [3] },
  ]});
  ok(r.status === 200, '暂停空档可排入同作品其他时段（空档不占用）');
  pv = r.json.version;
  r = await call('POST', '/api/schedule', { version: pv, slots: [
    { cid: 'gapbad', hall: '十号厅', start: '2028-03-01T10:30', end: '2028-03-01T11:30', lux: 100, artworkIds: [3] },
  ]});
  ok(r.status === 422 && r.json.conflicts?.[0]?.kind === 'new-frozen', '与已闭合展出区间重叠的排期被拒');

  // 16.7 合法恢复：13:00 -> 17:00 = 240 分 × 100 = 24000 重新预占（空档时段 11:30~12:30 已结束、不冲突）
  r = await call('POST', `/api/slots/${paId}/resume`, { version: pv, resumeTime: '2028-03-01T13:00', estimatedEnd: '2028-03-01T17:00' });
  ok(r.status === 200 && r.json.currentReservation === 24000 && r.json.resumedAt === '2028-03-01T13:00',
     `恢复成功，重新预占 ${r.json.currentReservation}`);
  const p2 = r.json.slots.find((s) => s.id === paId);
  ok(p2.status === 'running' && p2.resumeStart === '2028-03-01T13:00' && p2.estimatedEnd === '2028-03-01T17:00' &&
     p2.accumulatedExposure === 18000, '恢复后 running，已展区间保留 18000');
  pv = r.json.version;

  // 16.8 恢复后暂停：起点必须等于恢复时间；分段完整
  r = await call('POST', `/api/slots/${paId}/pause`, { version: pv, start: '2028-03-01T13:30', end: '2028-03-01T15:00',
    segments: [{ start: '2028-03-01T13:30', end: '2028-03-01T15:00', lux: 100 }] });
  ok(r.status === 422, '恢复后再暂停，起点≠恢复时间被拒');
  r = await call('POST', `/api/slots/${paId}/pause`, { version: pv, start: '2028-03-01T13:00', end: '2028-03-01T15:00',
    segments: [
      { start: '2028-03-01T13:00', end: '2028-03-01T14:00', lux: 100 },
      { start: '2028-03-01T14:00', end: '2028-03-01T15:00', lux: 50 },
    ] });
  ok(r.status === 200 && r.json.pausedInterval.exposure === 9000, `第二次暂停 60×100+60×50=${r.json.pausedInterval?.exposure}`);
  const p3 = r.json.slots.find((s) => s.id === paId);
  ok(p3.pauseCount === 2 && p3.accumulatedExposure === 27000 && p3.currentReservation === 0 &&
     p3.intervals[1].start === '2028-03-01T13:00',
     '区间按时间递增、互不重叠；累计 27000，预占再次释放');
  pv = r.json.version;

  // 16.9 在第二个暂停空档（15:00 之后）排同作品时段，再恢复时预占与之重叠 -> INTERVAL_OVERLAP 整次拒绝
  r = await call('POST', '/api/schedule', { version: pv, slots: [
    { cid: 'gap2', hall: '十二号厅', start: '2028-03-01T15:30', end: '2028-03-01T16:30', lux: 100, artworkIds: [3] },
  ]});
  ok(r.status === 200, '第二个暂停空档排入同作品时段');
  pv = r.json.version;
  r = await call('POST', `/api/slots/${paId}/resume`, { version: pv, resumeTime: '2028-03-01T15:00', estimatedEnd: '2028-03-01T15:00' });
  ok(r.status === 422, '新预计结束不晚于恢复时间被拒');
  r = await call('POST', `/api/slots/${paId}/resume`, { version: pv, resumeTime: '2028-03-01T15:20', estimatedEnd: '2028-03-01T17:00' });
  ok(r.status === 422 && r.json.error?.code === 'INTERVAL_OVERLAP' && r.json.conflicts?.length >= 1,
     '恢复预占与空档时段重叠整次拒绝');
  st = await getState();
  ok(st.version === pv && st.slots.find((s) => s.id === paId).status === 'paused', '恢复被拒：状态/版本不变');

  // 16.10 暂停中按已展区间直接收尾（不恢复）
  r = await call('POST', `/api/slots/${paId}/settle`, { version: pv });
  ok(r.status === 200 && r.json.justFinishedExposure === 27000 && r.json.justIntervals.length === 2,
     `暂停中直接收尾：累计 ${r.json.justFinishedExposure}，区间数 ${r.json.justIntervals?.length}`);
  const pf = r.json.slots.find((s) => s.id === paId);
  ok(pf.status === 'finished' && pf.pauseCount === 2 && pf.actualStart === '2028-03-01T09:00' &&
     pf.actualEnd === '2028-03-01T15:00' && pf.actualExposure === 27000 && pf.currentReservation === null,
     '收尾后 finished：首段起点/末段终点，总量=区间累计，暂停 2 次');
  pv = r.json.version;

  // 16.11 收尾后不能再 pause/resume；settle 拒绝
  r = await call('POST', `/api/slots/${paId}/pause`, { version: pv, start: '2028-03-01T15:00', end: '2028-03-01T16:00',
    segments: [{ start: '2028-03-01T15:00', end: '2028-03-01T16:00', lux: 1 }] });
  ok(r.status === 422 && r.json.error.code === 'NOT_RUNNING', '已结束不能暂停');
  r = await call('POST', `/api/slots/${paId}/resume`, { version: pv, resumeTime: '2028-03-01T15:00', estimatedEnd: '2028-03-01T16:00' });
  ok(r.status === 422 && r.json.error.code === 'NOT_PAUSED', '已结束不能恢复');

  // 16.12 按区间更正（必须带 intervalIndex，覆盖该区间原起止）
  r = await call('POST', `/api/slots/${paId}/correct`, { version: pv, reason: '区间1复核',
    segments: [{ start: '2028-03-01T09:00', end: '2028-03-01T11:00', lux: 50 }] });
  ok(r.status === 422, '暂停流时段更正必须指定 intervalIndex');
  r = await call('POST', `/api/slots/${paId}/correct`, { version: pv, reason: '区间1复核', intervalIndex: 9,
    segments: [{ start: '2028-03-01T09:00', end: '2028-03-01T11:00', lux: 50 }] });
  ok(r.status === 422, 'intervalIndex 越界被拒');
  r = await call('POST', `/api/slots/${paId}/correct`, { version: pv, reason: '区间1复核', intervalIndex: 1,
    segments: [{ start: '2028-03-01T09:00', end: '2028-03-01T10:00', lux: 50 }] });
  ok(r.status === 422 && r.json.error.code === 'SEGMENTS_INVALID', '区间更正分段未覆盖该区间被整批拒绝');
  // 18000 -> 6000；总量 27000 -> 15000
  r = await call('POST', `/api/slots/${paId}/correct`, { version: pv, reason: '区间1复核降为50lux', intervalIndex: 1,
    segments: [{ start: '2028-03-01T09:00', end: '2028-03-01T11:00', lux: 50 }] });
  ok(r.status === 200 && r.json.beforeExposure === 18000 && r.json.afterExposure === 6000 &&
     r.json.correction.intervalIndex === 1,
     `区间1 更正 ${r.json.beforeExposure} -> ${r.json.afterExposure}，留痕标注区间号`);
  const pc = r.json.slots.find((s) => s.id === paId);
  ok(pc.actualExposure === 15000 && pc.intervals[0].exposure === 6000 && pc.intervals[1].exposure === 9000,
     '更正后：区间1=6000、区间2=9000、总量15000（替换不累计）');

  // 16.13 暂停流 running 收尾的另一条路径：恢复后提交最后区间结算
  st = await getState();
  r = await call('POST', '/api/schedule', { version: st.version, slots: [
    { cid: 'pb', hall: '十一号厅', start: '2028-05-01T09:00', end: '2028-05-01T12:00', lux: 100, artworkIds: [3] },
  ]});
  ok(r.status === 200, `排入 B 路径时段（${r.status}）`);
  const pbId = r.json.slots.find((s) => s.plannedStart.startsWith('2028-05-01')).id;
  r = await call('POST', `/api/slots/${pbId}/start`);
  pv = r.json.version;
  r = await call('POST', `/api/slots/${pbId}/pause`, { version: pv, start: '2028-05-01T09:00', end: '2028-05-01T10:00',
    segments: [{ start: '2028-05-01T09:00', end: '2028-05-01T10:00', lux: 100 }] });
  ok(r.status === 200, 'B 时段暂停 6000');
  pv = r.json.version;
  r = await call('POST', `/api/slots/${pbId}/resume`, { version: pv, resumeTime: '2028-05-01T11:00', estimatedEnd: '2028-05-01T12:00' });
  ok(r.status === 200, 'B 时段恢复 11:00~12:00 预占 6000');
  pv = r.json.version;
  // 最后区间起点必须等于恢复时间
  r = await call('POST', `/api/slots/${pbId}/settle`, { version: pv, start: '2028-05-01T11:30', end: '2028-05-01T12:00',
    segments: [{ start: '2028-05-01T11:30', end: '2028-05-01T12:00', lux: 100 }] });
  ok(r.status === 422, '最后区间起点≠恢复时间被拒');
  // 暂停流 running 上旧 finish 被拒（避免账实不符）
  r = await call('POST', `/api/slots/${pbId}/finish`, { actualStart: '2028-05-01T11:00', actualEnd: '2028-05-01T12:00', actualLux: 100 });
  ok(r.status === 422 && r.json.error.code === 'NOT_RUNNING', '已有展出区间的时段拒绝旧单一照度 finish');
  // 合法最后区间：11:00~12:00 = 6000；总 12000
  r = await call('POST', `/api/slots/${pbId}/settle`, { version: pv, start: '2028-05-01T11:00', end: '2028-05-01T12:00',
    segments: [{ start: '2028-05-01T11:00', end: '2028-05-01T12:00', lux: 100 }] });
  ok(r.status === 200 && r.json.justFinishedExposure === 12000 && r.json.justIntervals.length === 2,
     `恢复后提交最后区间结算成功，总=${r.json.justFinishedExposure}`);
  const pbf = r.json.slots.find((s) => s.id === pbId);
  ok(pbf.status === 'finished' && pbf.pauseCount === 1 && pbf.actualStart === '2028-05-01T09:00' &&
     pbf.actualEnd === '2028-05-01T12:00', 'B 收尾：1 次暂停，跨空档的起止与区间累计一致');

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
