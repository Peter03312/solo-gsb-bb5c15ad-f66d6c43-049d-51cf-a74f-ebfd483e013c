'use strict';

const $ = (sel) => document.querySelector(sel);
let state = { version: null, artworks: [], slots: [] };
let draft = [];          // 未开始时段草稿
let draftSeq = 0;        // 草稿行本地序号
let editingArtworkId = null;
let finishingSlotId = null;

// ---------- 工具 ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
function fmt(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '–';
  return Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
function minutes(s, e) {
  if (!s || !e) return null;
  const ms = new Date(s).getTime(), me = new Date(e).getTime();
  if (Number.isNaN(ms) || Number.isNaN(me)) return null;
  return Math.round((me - ms) / 60000);
}
function statusBadge(s) {
  if (s.status === 'paused') return '<span class="badge badge-paused">已暂停</span>';
  if (s.status === 'running') {
    if (s.pauseCount > 0) return `<span class="badge badge-running">进行中·已暂停${s.pauseCount}次</span>`;
    return '<span class="badge badge-running">进行中·冻结</span>';
  }
  if (s.status === 'finished') return '<span class="badge badge-finished">已结束</span>';
  if (s.blocked) return '<span class="badge badge-blocked">不可启动</span>';
  return '<span class="badge badge-scheduled">未开始</span>';
}
let toastTimer = null;
function toast(kind, text) {
  const el = $('#toast');
  el.className = `toast ${kind}`;
  el.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 8000);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error((data.error && data.error.message) || `请求失败 (${res.status})`);
    err.status = res.status;
    err.payload = data;
    throw err;
  }
  return data;
}

// ---------- 数据加载 ----------
async function loadState(resetDraft = true) {
  state = await api('/api/state');
  $('#versionTag').textContent = `v${state.version}`;
  if (resetDraft) draft = state.slots.filter((s) => s.status === 'scheduled').map(serverRowToDraft);
  renderAll();
}
function serverRowToDraft(s) {
  return {
    cid: `s${s.id}`,
    savedId: s.id,
    hall: s.hall,
    start: s.plannedStart,
    end: s.plannedEnd,
    lux: s.plannedLux,
    artworkIds: s.artworks.map((a) => a.id),
    blocked: s.blocked,
    blockedReason: s.blockedReason,
  };
}
function newDraftRow() {
  return { cid: `d${++draftSeq}`, hall: '', start: '', end: '', lux: 50, artworkIds: [] };
}

// ---------- 渲染：作品 ----------
function renderArtworks() {
  const tb = $('#artworkTable tbody');
  if (!state.artworks.length) {
    tb.innerHTML = '<tr class="empty-row"><td colspan="9">还没有作品，点击「录入作品」开始</td></tr>';
    return;
  }
  tb.innerHTML = state.artworks.map((a) => `
    <tr>
      <td class="art-name">${esc(a.name)}</td>
      <td class="num">${fmt(a.limit)}</td>
      <td class="num">${fmt(a.existing)}</td>
      <td class="num">${fmt(a.used)}</td>
      <td class="num">${fmt(a.reserved)}<span class="reserved-detail">${fmt(a.reservedRunning)} / ${fmt(a.reservedScheduled)}</span></td>
      <td class="num">${fmt(a.committed)}</td>
      <td class="num ${a.over ? 'neg' : 'pos'}">${a.over ? '−' + fmt(Math.abs(a.balance)) : fmt(a.balance)}</td>
      <td class="note-text">${esc(a.note)}</td>
      <td>
        <div class="row-actions">
          <button class="btn btn-sm" data-act="edit-art" data-id="${a.id}">编辑</button>
          <button class="btn btn-sm btn-danger" data-act="del-art" data-id="${a.id}">删除</button>
        </div>
      </td>
    </tr>
  `).join('');
}

// ---------- 渲染：冻结时段（进行中/已结束） ----------
// 分段照度明细：每段 lux 与分钟数
function segmentLuxHtml(segs) {
  if (!segs || !segs.length) return '—';
  return segs.map((g) => `<div class="seg-line num">${fmt(g.lux)}<span class="seg-min">${fmt(g.minutes)} 分</span></div>`).join('');
}
function segmentExpoHtml(total, segs) {
  if (total === null || total === undefined) return '—';
  const detail = (segs && segs.length > 1)
    ? `<span class="reserved-detail">${segs.map((g) => fmt(g.exposure)).join(' + ')}</span>`
    : '';
  return `<div class="seg-total">${fmt(total)}${detail}</div>`;
}

// 暂停/恢复流：已闭合展出区间明细（区间之间的空档不计曝光）
function intervalsHtml(s) {
  const list = s.intervals || [];
  if (!list.length) return null;
  const rows = list.map((it, i) => `
    <div class="int-block">
      <div class="int-head mono-span">区间 ${i + 1}：${esc(it.start.slice(11))}～${esc(it.end.slice(11))}
        <span class="int-mins">${fmt(it.minutes)} 分</span></div>
      ${it.segments.map((g) => `<div class="seg-line mono-span">${esc(g.start.slice(11))}～${esc(g.end.slice(11))} · ${fmt(g.lux)} lux</div>`).join('')}
    </div>`).join('');
  const open = s.status === 'running' && s.resumeStart
    ? `<div class="int-open mono-span">展出中：${esc(s.resumeStart.slice(11))}～${esc(s.estimatedEnd ? s.estimatedEnd.slice(11) : '?')}
         <span class="int-mins">（恢复后预占 ${fmt(s.currentReservation)}）</span></div>`
    : s.status === 'paused'
      ? '<div class="int-open paused-gap mono-span">⏸ 暂停中：空档不曝光，预占已释放</div>'
      : '';
  return rows + open;
}

function renderFrozen() {
  const tb = $('#frozenTable tbody');
  const rows = state.slots
    .filter((s) => s.status === 'running' || s.status === 'paused' || s.status === 'finished')
    .sort((a, b) => a.seq - b.seq);
  if (!rows.length) {
    tb.innerHTML = '<tr class="empty-row"><td colspan="11">暂无进行中、已暂停或已结束时段</td></tr>';
    return;
  }
  tb.innerHTML = rows.map((s) => {
    const iv = intervalsHtml(s);
    const isFlow = !!iv;
    // 实际起止/分段列：暂停流显示展出区间；否则显示旧的实际/冻结视图
    const coverCell = isFlow
      ? iv
      : (s.actualStart
        ? `<div class="seg-cover mono-span">${esc(s.actualStart)}<br>～ ${esc(s.actualEnd)}</div>${
            s.actualSegments.length > 1
              ? s.actualSegments.map((g) => `<div class="seg-line mono-span">${esc(g.start.slice(11))}～${esc(g.end.slice(11))}</div>`).join('')
              : ''}`
        : '—（冻结中）');
    const luxCell = isFlow
      ? (s.intervals.flatMap((it) => it.segments).length
          ? segmentLuxHtml(s.intervals.flatMap((it) => it.segments))
          : '—')
      : (s.actualStart === null ? '—' : segmentLuxHtml(s.actualSegments));
    const expoCell = isFlow
      ? `<div class="seg-total">${fmt(s.accumulatedExposure)}</div>
         <div class="acc-sub">累计已展${s.status === 'finished' ? '' : '（计入已用）'}</div>
         ${(s.status === 'running' || s.status === 'paused')
            ? `<div class="acc-sub ${s.currentReservation === 0 ? 'muted-acc' : ''}">当前预占 ${fmt(s.currentReservation)}</div>`
            : ''}`
      : (s.actualExposure === null ? '—' : segmentExpoHtml(s.actualExposure, s.actualSegments));
    const actions = actionButtons(s);
    return `
    <tr>
      <td>${s.seq}</td>
      <td>${esc(s.hall)}</td>
      <td>${statusBadge(s)}</td>
      <td class="mono" style="font-family:var(--mono);font-size:12.5px;white-space:nowrap">
        ${esc(s.plannedStart)}<br>～ ${esc(s.plannedEnd)}
        ${s.resumeStart ? `<div class="resume-tag mono-span">恢复 ${esc(s.resumeStart)}<br>～ ${esc(s.estimatedEnd)}</div>` : ''}
      </td>
      <td class="num">${fmt(s.plannedLux)}</td>
      <td class="num">${fmt(s.plannedExposure)}</td>
      <td>${coverCell}</td>
      <td class="num">${luxCell}</td>
      <td class="num">${expoCell}</td>
      <td><div class="art-chips">${s.artworks.map((a) => `<span class="chip">${esc(a.name)}</span>`).join('')}</div></td>
      <td>${actions}</td>
    </tr>`;
  }).join('');
}

function actionButtons(s) {
  if (s.status === 'paused') {
    return `<div class="row-actions">
        <button class="btn btn-sm btn-primary" data-act="resume" data-id="${s.id}">▶ 恢复</button>
        <button class="btn btn-sm" data-act="settle-close" data-id="${s.id}">结束（按已展区间）</button>
        <button class="btn btn-sm" data-act="correct" data-id="${s.id}">分段更正</button>
      </div>`;
  }
  if (s.status === 'running') {
    if ((s.intervals || []).length) {
      // 暂停恢复流：暂停 / 最后区间结算 / 区间更正
      return `<div class="row-actions">
        <button class="btn btn-sm btn-warn" data-act="pause" data-id="${s.id}">⏸ 暂停</button>
        <button class="btn btn-sm btn-primary" data-act="settle-interval" data-id="${s.id}">结束并结算</button>
        <button class="btn btn-sm" data-act="correct" data-id="${s.id}">分段更正</button>
      </div>`;
    }
    return `<div class="row-actions">
      <button class="btn btn-sm btn-warn" data-act="pause" data-id="${s.id}">⏸ 暂停</button>
      <button class="btn btn-sm btn-primary" data-act="finish" data-id="${s.id}">结束补记</button>
    </div>`;
  }
  return `<div class="row-actions"><span style="color:var(--muted)">已结算</span>
    <button class="btn btn-sm" data-act="correct" data-id="${s.id}">分段更正</button></div>`;
}

// ---------- 渲染：分段更正记录 ----------
function renderCorrections() {
  const tb = $('#correctionTable tbody');
  const records = [];
  for (const s of state.slots) {
    for (const c of (s.corrections || [])) records.push({ slot: s, c });
  }
  records.sort((a, b) => (a.c.createdAt < b.c.createdAt ? 1 : -1));
  if (!records.length) {
    tb.innerHTML = '<tr class="empty-row"><td colspan="8">暂无分段更正记录</td></tr>';
    return;
  }
  tb.innerHTML = records.map(({ slot, c }) => {
    const delta = c.after.exposure - c.before.exposure;
    const deltaHtml = delta > 0
      ? `<span class="neg">＋${fmt(B_round(delta))}</span>`
      : delta < 0 ? `<span class="pos">−${fmt(B_round(Math.abs(delta)))}</span>` : '0';
    return `
      <tr>
        <td class="mono-span" style="white-space:nowrap">${esc(formatTs(c.createdAt))}</td>
        <td>#${slot.seq} ${esc(slot.hall)}${c.intervalIndex != null ? `<br><span class="int-tag">区间 ${c.intervalIndex}</span>` : ''}</td>
        <td style="max-width:240px">${esc(c.reason)}</td>
        <td class="mono-span" style="white-space:nowrap">${esc(c.before.start)}<br>～ ${esc(c.before.end)}</td>
        <td class="num">${fmt(c.before.exposure)}</td>
        <td class="num">${fmt(c.after.exposure)}</td>
        <td class="num">${deltaHtml}</td>
        <td>${segmentCorrectionHtml(slot, c)}</td>
      </tr>`;
  }).join('');
}
// 更正记录中分段明细：展示该次更正提交的“更正后分段”快照
function segmentCorrectionHtml(slot, c) {
  const segs = (c.after && c.after.segments) || [];
  if (!segs.length) return `整段照度结算 ${fmt(c.after.exposure)}`;
  return segs.map((g) => `<div class="seg-line mono-span">${esc(g.start)}～${esc(g.end)} · ${fmt(g.lux)} lux · ${fmt(g.exposure)}</div>`).join('');
}
const B_round = (n) => Math.round((n + Number.EPSILON) * 1000) / 1000;
function formatTs(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ---------- 渲染：未开始草稿 ----------
function renderDraft() {
  const tb = $('#scheduleTable tbody');
  if (!draft.length) {
    tb.innerHTML = '<tr class="empty-row"><td colspan="8">没有未开始时段，点击「新增时段」，或从下方整批保存</td></tr>';
    return;
  }
  const artOptions = (selected) => state.artworks
    .map((a) => `<option value="${a.id}" ${selected.includes(a.id) ? 'selected' : ''}>${esc(a.name)}</option>`)
    .join('');

  tb.innerHTML = draft.map((r) => {
    const mins = minutes(r.start, r.end);
    const expo = mins !== null && mins >= 0 && Number(r.lux) >= 0 ? Math.round(mins * Number(r.lux)) : null;
    const gaps = (r.blockedReason && r.blockedReason.gaps) || [];
    const gapHtml = gaps.length ? `
      <tr class="blocked-tag-row">
        <td colspan="8" class="blocked-cell">
          <strong>⛔ 预算不足，禁止启动。</strong> 调整排期后重新核算。
          <ul class="gap-list">
            ${gaps.map((g) => `<li>作品「${esc(g.artworkName)}」：当前可用余额 ${fmt(g.has)}，本时段需要 ${fmt(g.need)}，缺口 <strong>${fmt(g.gap)}</strong> lux·min</li>`).join('')}
          </ul>
        </td>
      </tr>` : '';
    return `
      <tr data-cid="${esc(r.cid)}">
        <td><input type="text" value="${esc(r.hall)}" data-f="hall" placeholder="如：一号厅" style="width:110px" /></td>
        <td><input type="datetime-local" class="mono" value="${esc(r.start)}" data-f="start" /></td>
        <td><input type="datetime-local" class="mono" value="${esc(r.end)}" data-f="end" /></td>
        <td><input type="number" min="0" step="1" value="${esc(r.lux)}" data-f="lux" /></td>
        <td class="num">${mins === null ? '–' : mins < 0 ? '✗' : mins}</td>
        <td class="cell-expo ${r.blocked ? 'neg' : ''}">${expo === null || expo < 0 ? '–' : fmt(expo)}</td>
        <td><select multiple size="3" data-f="artworkIds">${artOptions(r.artworkIds)}</select></td>
        <td>
          <div class="row-actions">
            ${r.savedId ? `<button class="btn btn-sm btn-primary" data-act="start" data-id="${r.savedId}">▶ 启动</button>` : ''}
            <button class="btn btn-sm btn-danger" data-act="del-draft">删除</button>
          </div>
        </td>
      </tr>
      ${gapHtml}
    `;
  }).join('');
}

function renderAll() {
  renderArtworks();
  renderFrozen();
  renderCorrections();
  renderDraft();
}

// ---------- 草稿交互 ----------
function syncRowFromDom(tr) {
  const cid = tr.dataset.cid;
  const row = draft.find((r) => r.cid === cid);
  if (!row) return;
  tr.querySelectorAll('[data-f]').forEach((el) => {
    const f = el.dataset.f;
    if (f === 'artworkIds') {
      row.artworkIds = Array.from(el.selectedOptions).map((o) => Number(o.value));
    } else if (f === 'lux') {
      row.lux = el.value;
    } else {
      row[f] = el.value;
    }
  });
  // 草稿一旦被改动，清除服务端的核算标记，保存后以服务端结果为准
  row.blocked = false;
  row.blockedReason = null;
  row.savedId = undefined;
}

$('#addSlotBtn').addEventListener('click', () => {
  if (!state.artworks.length) return toast('warn', '请先录入至少一件作品');
  draft.push(newDraftRow());
  renderDraft();
});
$('#resetDraftBtn').addEventListener('click', () => {
  draft = state.slots.filter((s) => s.status === 'scheduled').map(serverRowToDraft);
  renderDraft();
});

$('#scheduleTable').addEventListener('change', (e) => {
  const tr = e.target.closest('tr[data-cid]');
  if (tr) { syncRowFromDom(tr); renderDraft(); }
});
$('#scheduleTable').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const tr = e.target.closest('tr[data-cid]');
  if (btn.dataset.act === 'del-draft' && tr) {
    syncRowFromDom(tr);
    draft = draft.filter((r) => r.cid !== tr.dataset.cid);
    renderDraft();
  }
  if (btn.dataset.act === 'start') {
    syncRowFromDom(tr);
    await startSlot(Number(btn.dataset.id));
  }
});

// ---------- 整批保存 ----------
function formatBatchError(payload) {
  const lines = [];
  (payload.errors || []).forEach((x) => lines.push(`• ${x.message}`));
  (payload.conflicts || []).forEach((c) => {
    lines.push(`• 作品「${c.artworkName}」时段重叠：\n    ${c.slotA.label}\n    ${c.slotB.label}`);
  });
  (payload.budgetExceeded || []).forEach((b) => {
    lines.push(`• 作品「${b.artworkName}」预算超限：已用 ${fmt(b.used)} + 预占 = ${fmt(b.projected)}，上限 ${fmt(b.limit)}，超出 ${fmt(b.overflow)} lux·min`);
  });
  return lines.join('\n') || '整批校验失败';
}

$('#saveScheduleBtn').addEventListener('click', async () => {
  // 先把 DOM 中未触发 change 的输入同步进来
  document.querySelectorAll('#scheduleTable tbody tr[data-cid]').forEach(syncRowFromDom);
  try {
    const body = {
      version: state.version,
      slots: draft.map((r) => ({
        cid: r.cid, hall: r.hall, start: r.start, end: r.end,
        lux: r.lux === '' ? null : Number(r.lux),
        artworkIds: r.artworkIds,
      })),
    };
    const next = await api('/api/schedule', { method: 'POST', body });
    applyNewState(next);
    const blocked = next.slots.filter((s) => s.blocked);
    if (blocked.length) {
      const detail = blocked.map((s) => {
        const gaps = (s.blockedReason.gaps || []).map((g) =>
          `「${g.artworkName}」缺口 ${fmt(g.gap)}（可用 ${fmt(g.has)} / 需 ${fmt(g.need)}）`).join('；');
        return `#${s.seq} ${s.hall} ${s.plannedStart}~${s.plannedEnd}：${gaps}`;
      }).join('\n');
      toast('warn', `整批已保存并重新核算，以下时段按开始顺序不可启动：\n${detail}`);
    } else {
      toast('success', '整批校验通过，排期已保存');
    }
  } catch (err) {
    await handleMutationError(err);
  }
});

async function startSlot(id) {
  try {
    const next = await api(`/api/slots/${id}/start`, { method: 'POST' });
    applyNewState(next);
    toast('success', '时段已启动：原排期冻结，预占保留');
  } catch (err) {
    if (err.status === 422 && err.payload && err.payload.blockedReason) {
      const gaps = (err.payload.blockedReason.gaps || []).map((g) =>
        `「${g.artworkName}」缺口 ${fmt(g.gap)}（可用 ${fmt(g.has)} / 需 ${fmt(g.need)}）`).join('\n');
      toast('error', `禁止启动：预算不足\n${gaps}\n请调整排期后重新核算`);
    } else {
      toast('error', err.message);
    }
  }
}

// ---------- 结束补记（单一照度 / 多段照度） ----------
let fnSegments = [];

// 通用：分段编辑器。rows: [{start,end,lux}]；返回 HTML
function segmentEditorRowsHtml(rows, prefix) {
  return rows.map((r, i) => `
    <div class="seg-row" data-i="${i}">
      <span class="seg-no">${i + 1}</span>
      <input type="datetime-local" class="mono" data-f="start" value="${esc(r.start || '')}" />
      <span class="seg-arrow">～</span>
      <input type="datetime-local" class="mono" data-f="end" value="${esc(r.end || '')}" />
      <input type="number" min="0" step="1" data-f="lux" value="${esc(r.lux ?? '')}" placeholder="lux" title="照度 lux" />
      <button type="button" class="btn btn-sm btn-danger" data-act="rm">删</button>
    </div>`).join('');
}
function collectSegmentRows(container) {
  const out = [];
  container.querySelectorAll('.seg-row').forEach((row) => {
    out.push({
      start: row.querySelector('[data-f="start"]').value,
      end: row.querySelector('[data-f="end"]').value,
      lux: row.querySelector('[data-f="lux"]').value,
    });
  });
  return out;
}
// 计算 Σ 分段曝光：任一时间/照度非法返回 null
function segmentsExposure(rows) {
  let total = 0;
  for (const r of rows) {
    const m = minutes(r.start, r.end);
    const lux = Number(r.lux);
    if (m === null || m <= 0 || !(lux >= 0)) return null;
    total += m * lux;
  }
  return Math.round(total * 1000) / 1000;
}

$('#frozenTable').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = Number(btn.dataset.id);
  const slot = state.slots.find((s) => s.id === id);
  if (btn.dataset.act === 'finish') openFinishModal(slot);
  if (btn.dataset.act === 'correct') openCorrectModal(slot);
  if (btn.dataset.act === 'pause') openPauseModal(slot);
  if (btn.dataset.act === 'resume') openResumeModal(slot);
  if (btn.dataset.act === 'settle-interval') openSettleIntervalModal(slot);
  if (btn.dataset.act === 'settle-close') settleClose(slot);
});

function openFinishModal(slot) {
  finishingSlotId = slot.id;
  fnIsInterval = false;
  $('#fn_multi').checked = false;
  $('#fn_multi').disabled = false;
  $('#fn_singleBox').classList.remove('hidden');
  $('#fn_multiBox').classList.add('hidden');
  $('#fn_start').value = slot.actualStart || slot.plannedStart;
  $('#fn_end').value = slot.actualEnd || slot.plannedEnd;
  $('#fn_lux').value = slot.plannedLux;
  fnSegments = [{
    start: slot.actualStart || slot.plannedStart,
    end: slot.actualEnd || slot.plannedEnd,
    lux: slot.plannedLux,
  }];
  renderFnSegments();
  $('#fn_error').classList.add('hidden');
  updateFinishPreview();
  $('#finishModal').classList.remove('hidden');
}
function renderFnSegments() {
  $('#fn_segments').innerHTML = segmentEditorRowsHtml(fnSegments, 'fn');
}
function updateFinishPreview() {
  const el = $('#fn_preview');
  if ($('#fn_multi').checked) {
    const v = segmentsExposure(collectSegmentRows($('#fn_segments')));
    el.textContent = v === null ? '–' : fmt(v);
  } else {
    const mins = minutes($('#fn_start').value, $('#fn_end').value);
    const lux = Number($('#fn_lux').value);
    if (mins !== null && mins > 0 && lux >= 0) el.textContent = fmt(Math.round(mins * lux));
    else el.textContent = '–';
  }
}
$('#fn_multi').addEventListener('change', () => {
  const multi = $('#fn_multi').checked;
  $('#fn_singleBox').classList.toggle('hidden', multi);
  $('#fn_multiBox').classList.toggle('hidden', !multi);
  if (multi) {
    // 切换时把整体起止同步给唯一段
    if (fnSegments.length === 1) {
      fnSegments[0].start = $('#fn_start').value;
      fnSegments[0].end = $('#fn_end').value;
      renderFnSegments();
    }
  }
  updateFinishPreview();
});
['fn_start', 'fn_end', 'fn_lux'].forEach((id) => $('#' + id).addEventListener('input', updateFinishPreview));
$('#fn_addSeg').addEventListener('click', () => {
  const rows = collectSegmentRows($('#fn_segments'));
  const prev = rows[rows.length - 1] || {};
  fnSegments = rows;
  fnSegments.push({ start: prev.end || '', end: $('#fn_end').value || '', lux: '' });
  renderFnSegments();
  updateFinishPreview();
});
$('#fn_segments').addEventListener('click', (e) => {
  if (!e.target.closest('button[data-act="rm"]')) return;
  fnSegments = collectSegmentRows($('#fn_segments'));
  fnSegments.splice(Number(e.target.closest('.seg-row').dataset.i), 1);
  renderFnSegments();
  updateFinishPreview();
});
$('#fn_segments').addEventListener('input', () => updateFinishPreview());
// 多段模式下编辑整体起止时同步首段起点 / 末段终点
$('#fn_start').addEventListener('change', () => {
  if (!$('#fn_multi').checked) return;
  const rows = collectSegmentRows($('#fn_segments'));
  if (rows[0]) { rows[0].start = $('#fn_start').value; fnSegments = rows; renderFnSegments(); updateFinishPreview(); }
});
$('#fn_end').addEventListener('change', () => {
  if (!$('#fn_multi').checked) return;
  const rows = collectSegmentRows($('#fn_segments'));
  if (rows.length) { rows[rows.length - 1].end = $('#fn_end').value; fnSegments = rows; renderFnSegments(); updateFinishPreview(); }
});

function blockedToastDetail(blocked) {
  return blocked.map((s) => {
    const gaps = (s.blockedReason.gaps || []).map((g) =>
      `「${g.artworkName}」缺口 ${fmt(g.gap)}（可用 ${fmt(g.has)} / 需 ${fmt(g.need)}）`).join('；');
    return `#${s.seq} ${s.hall} ${s.plannedStart}~${s.plannedEnd}：${gaps}`;
  }).join('\n');
}

$('#fn_save').addEventListener('click', async () => {
  const multi = $('#fn_multi').checked;
  const actualStart = $('#fn_start').value;
  const actualEnd = $('#fn_end').value;
  let payload, path;
  if (fnIsInterval) {
    // 暂停恢复流：提交恢复时间起的最后区间（字段为 start/end）
    path = 'settle';
    payload = {
      version: state.version,
      start: actualStart,
      end: actualEnd,
      segments: collectSegmentRows($('#fn_segments')).map((r) => ({
        start: r.start, end: r.end, lux: r.lux === '' ? null : Number(r.lux),
      })),
    };
  } else if (multi) {
    path = 'settle';
    payload = {
      version: state.version,
      actualStart,
      actualEnd,
      segments: collectSegmentRows($('#fn_segments')).map((r) => ({
        start: r.start, end: r.end, lux: r.lux === '' ? null : Number(r.lux),
      })),
    };
  } else {
    path = 'finish';
    payload = { actualStart, actualEnd, actualLux: Number($('#fn_lux').value) };
  }
  try {
    const next = await api(`/api/slots/${fnIsInterval ? settlingSlotId : finishingSlotId}/${path}`, {
      method: 'POST',
      body: payload,
    });
    $('#finishModal').classList.add('hidden');
    applyNewState(next);
    if (next.blockedAfterFinish && next.blockedAfterFinish.length) {
      toast('warn', `已结算，累计实际曝光 ${fmt(next.justFinishedExposure)} lux·min 已替换预占。\n超量导致以下后续时段预算不足、不可开始：\n${blockedToastDetail(next.blockedAfterFinish)}\n请调整排期或更正分段后重新核算`);
    } else {
      toast('success', `已结束并结算，实际曝光 ${fmt(next.justFinishedExposure)} lux·min 已替换预占`);
    }
  } catch (err) {
    if (err.status === 409) {
      $('#finishModal').classList.add('hidden');
      await handleMutationError(err);
      return;
    }
    $('#fn_error').textContent = formatSegmentError(err);
    $('#fn_error').classList.remove('hidden');
  }
});

// ---------- 暂停 / 恢复 ----------
let pausingSlotId = null;
let paSegments = [];

function openPauseModal(slot) {
  pausingSlotId = slot.id;
  const resumed = slot.resumeStart || null;
  // 本段起点：恢复后必须从恢复时间开始；首次可录实际开始（默认计划开始）
  const startDefault = resumed || slot.plannedStart;
  const endDefault = resumed ? slot.estimatedEnd : slot.plannedEnd;
  $('#pa_title').textContent = resumed
    ? `#${slot.seq} ${slot.hall} · 再次暂停（本段自恢复时间开始）`
    : `#${slot.seq} ${slot.hall} · 暂停展出（临时闭馆）`;
  $('#pa_start').value = startDefault;
  $('#pa_end').value = endDefault;
  paSegments = [{ start: startDefault, end: endDefault, lux: slot.plannedLux }];
  renderPaSegments();
  $('#pa_error').classList.add('hidden');
  updatePaPreview();
  $('#pauseModal').classList.remove('hidden');
}
function renderPaSegments() { $('#pa_segments').innerHTML = segmentEditorRowsHtml(paSegments, 'pa'); }
function updatePaPreview() {
  const v = segmentsExposure(collectSegmentRows($('#pa_segments')));
  $('#pa_preview').textContent = v === null ? '–' : fmt(v);
}
$('#pa_addSeg').addEventListener('click', () => {
  paSegments = collectSegmentRows($('#pa_segments'));
  const prev = paSegments[paSegments.length - 1] || {};
  paSegments.push({ start: prev.end || '', end: $('#pa_end').value || '', lux: '' });
  renderPaSegments();
  updatePaPreview();
});
$('#pa_segments').addEventListener('click', (e) => {
  if (!e.target.closest('button[data-act="rm"]')) return;
  paSegments = collectSegmentRows($('#pa_segments'));
  paSegments.splice(Number(e.target.closest('.seg-row').dataset.i), 1);
  renderPaSegments();
  updatePaPreview();
});
$('#pa_segments').addEventListener('input', updatePaPreview);
$('#pa_start').addEventListener('change', () => {
  const rows = collectSegmentRows($('#pa_segments'));
  if (rows[0]) { rows[0].start = $('#pa_start').value; paSegments = rows; renderPaSegments(); updatePaPreview(); }
});
$('#pa_end').addEventListener('change', () => {
  const rows = collectSegmentRows($('#pa_segments'));
  if (rows.length) { rows[rows.length - 1].end = $('#pa_end').value; paSegments = rows; renderPaSegments(); updatePaPreview(); }
});
$('#pa_save').addEventListener('click', async () => {
  const payload = {
    version: state.version,
    start: $('#pa_start').value,
    end: $('#pa_end').value,
    segments: collectSegmentRows($('#pa_segments')).map((r) => ({
      start: r.start, end: r.end, lux: r.lux === '' ? null : Number(r.lux),
    })),
  };
  try {
    const next = await api(`/api/slots/${pausingSlotId}/pause`, { method: 'POST', body: payload });
    $('#pauseModal').classList.add('hidden');
    applyNewState(next);
    const tail = next.blockedAfterFinish && next.blockedAfterFinish.length
      ? `\n预占释放后重算，以下后续时段状态变化：\n${blockedToastDetail(next.blockedAfterFinish)}`
      : '\n后续时段缺口已重算';
    toast('success', `已暂停：本段曝光 ${fmt(next.pausedInterval.exposure)} 计入已用，暂停空档不曝光、预占已释放；累计 ${fmt(next.accumulatedExposure)}${tail}`);
  } catch (err) {
    if (err.status === 409) { $('#pauseModal').classList.add('hidden'); return handleMutationError(err); }
    $('#pa_error').textContent = formatSegmentError(err);
    $('#pa_error').classList.remove('hidden');
  }
});

let resumingSlotId = null;
function openResumeModal(slot) {
  resumingSlotId = slot.id;
  const last = (slot.intervals || []).at(-1);
  $('#rs_title').textContent = `#${slot.seq} ${slot.hall} · 恢复展出`;
  $('#rs_info').innerHTML = `已暂停 ${slot.pauseCount} 次 · 累计已展 ${fmt(slot.accumulatedExposure)} lux·min` +
    (last ? `<br>上次暂停终点：${esc(last.end)}` : '');
  $('#rs_time').value = last ? last.end : '';
  $('#rs_end').value = slot.plannedEnd || '';
  $('#rs_error').classList.add('hidden');
  updateResumePreview();
  $('#resumeModal').classList.remove('hidden');
}
function updateResumePreview() {
  const m = minutes($('#rs_time').value, $('#rs_end').value);
  const slot = state.slots.find((s) => s.id === resumingSlotId);
  const lux = slot ? slot.plannedLux : 0;
  $('#rs_preview').textContent = (m !== null && m > 0) ? fmt(Math.round(m * lux)) : '–';
}
['rs_time', 'rs_end'].forEach((id) => $('#' + id).addEventListener('input', updateResumePreview));
$('#rs_save').addEventListener('click', async () => {
  const payload = {
    version: state.version,
    resumeTime: $('#rs_time').value,
    estimatedEnd: $('#rs_end').value,
  };
  try {
    const next = await api(`/api/slots/${resumingSlotId}/resume`, { method: 'POST', body: payload });
    $('#resumeModal').classList.add('hidden');
    applyNewState(next);
    toast('success', `已恢复：自 ${next.resumedAt} 起按计划照度重新预占 ${fmt(next.currentReservation)} lux·min（至 ${next.estimatedEnd}）`);
  } catch (err) {
    if (err.status === 409) { $('#resumeModal').classList.add('hidden'); return handleMutationError(err); }
    $('#rs_error').textContent = formatSegmentError(err);
    $('#rs_error').classList.remove('hidden');
  }
});

// 暂停流最终结算：恢复后提交最后一个区间
let settlingSlotId = null;
let fnIsInterval = false;
function openSettleIntervalModal(slot) {
  settlingSlotId = slot.id;
  fnIsInterval = true;
  $('#fn_multi').checked = true;
  $('#fn_multi').disabled = true;
  $('#fn_singleBox').classList.add('hidden');
  $('#fn_multiBox').classList.remove('hidden');
  // 最后区间：起点=恢复时间，默认终点=新预计结束
  const st0 = slot.resumeStart || '';
  const en0 = slot.estimatedEnd || slot.plannedEnd || '';
  $('#fn_start').value = st0;
  $('#fn_end').value = en0;
  $('#fn_lux').value = slot.plannedLux;
  fnSegments = [{ start: st0, end: en0, lux: slot.plannedLux }];
  renderFnSegments();
  $('#fn_error').classList.add('hidden');
  updateFinishPreview();
  $('#finishModal').classList.remove('hidden');
}
// 暂停中直接按已展出区间收尾
async function settleClose(slot) {
  if (!confirm(`按已提交的 ${slot.intervals.length} 个展出区间（累计 ${fmt(slot.accumulatedExposure)} lux·min）结束该时段？`)) return;
  try {
    const next = await api(`/api/slots/${slot.id}/settle`, { method: 'POST', body: { version: state.version } });
    applyNewState(next);
    toast('success', `已结束：${next.justIntervals.length} 个展出区间累计 ${fmt(next.justFinishedExposure)} lux·min（暂停空档不计）`);
  } catch (err) { await handleMutationError(err); }
}

// ---------- 已结束时段：分段更正 ----------
let correctingSlotId = null;
let crSegments = [];
let crIntervalIndex = null;   // 暂停/恢复流：当前选择的区间编号；老链路为 null
let crIntervals = [];

function openCorrectModal(slot) {
  correctingSlotId = slot.id;
  crIntervals = slot.intervals || [];
  $('#cr_title').textContent = `#${slot.seq} ${slot.hall} · 分段更正`;

  const sel = $('#cr_interval');
  const row = $('#cr_intervalRow');
  if (crIntervals.length) {
    row.classList.remove('hidden');
    sel.innerHTML = crIntervals.map((it, i) =>
      `<option value="${i + 1}">区间 ${i + 1}：${it.start.slice(11)}～${it.end.slice(11)}（${fmt(it.exposure)} lux·min）</option>`
    ).join('');
    sel.value = '1';
    sel.onchange = () => loadCrInterval(Number(sel.value));
    $('#cr_span').textContent = '该时段含多次暂停/恢复，请在右侧选择要更正的已闭合展出区间（区间起止不可改）';
    loadCrInterval(1);
  } else {
    row.classList.add('hidden');
    crIntervalIndex = null;
    $('#cr_span').textContent = `${slot.actualStart} ～ ${slot.actualEnd}（原实际曝光 ${slot.actualExposure} lux·min）`;
    crSegments = (slot.actualSegments && slot.actualSegments.length
      ? slot.actualSegments
      : [{ start: slot.actualStart, end: slot.actualEnd, lux: slot.actualLux }]
    ).map((g) => ({ start: g.start, end: g.end, lux: g.lux }));
    renderCrSegments();
    updateCorrectPreview();
  }
  $('#cr_reason').value = '';
  $('#cr_error').classList.add('hidden');
  $('#correctModal').classList.remove('hidden');
}

// 载入某个已闭合区间的分段到编辑器
function loadCrInterval(index) {
  crIntervalIndex = index;
  const it = crIntervals[index - 1];
  $('#cr_span').textContent = `区间 ${index}（起止不可改）：${it.start} ～ ${it.end}，原曝光 ${fmt(it.exposure)} lux·min`;
  crSegments = (it.segments && it.segments.length
    ? it.segments
    : [{ start: it.start, end: it.end, lux: null }]
  ).map((g) => ({ start: g.start, end: g.end, lux: g.lux }));
  renderCrSegments();
  updateCorrectPreview();
}
function renderCrSegments() {
  $('#cr_segments').innerHTML = segmentEditorRowsHtml(crSegments, 'cr');
}
function updateCorrectPreview() {
  const v = segmentsExposure(collectSegmentRows($('#cr_segments')));
  $('#cr_preview').textContent = v === null ? '–' : fmt(v);
}
$('#cr_addSeg').addEventListener('click', () => {
  crSegments = collectSegmentRows($('#cr_segments'));
  const prev = crSegments[crSegments.length - 1] || {};
  crSegments.push({ start: prev.end || '', end: '', lux: '' });
  renderCrSegments();
  updateCorrectPreview();
});
$('#cr_segments').addEventListener('click', (e) => {
  if (!e.target.closest('button[data-act="rm"]')) return;
  crSegments = collectSegmentRows($('#cr_segments'));
  crSegments.splice(Number(e.target.closest('.seg-row').dataset.i), 1);
  renderCrSegments();
  updateCorrectPreview();
});
$('#cr_segments').addEventListener('input', updateCorrectPreview);

$('#cr_save').addEventListener('click', async () => {
  const payload = {
    version: state.version,
    reason: $('#cr_reason').value,
    segments: collectSegmentRows($('#cr_segments')).map((r) => ({
      start: r.start, end: r.end, lux: r.lux === '' ? null : Number(r.lux),
    })),
  };
  if (crIntervalIndex != null) payload.intervalIndex = crIntervalIndex;
  try {
    const next = await api(`/api/slots/${correctingSlotId}/correct`, { method: 'POST', body: payload });
    $('#correctModal').classList.add('hidden');
    applyNewState(next);
    const which = next.intervalIndex != null ? `区间 ${next.intervalIndex}：` : '';
    if (next.blockedAfterFinish && next.blockedAfterFinish.length) {
      toast('warn', `${which}更正完成：曝光 ${fmt(next.beforeExposure)} → ${fmt(next.afterExposure)} lux·min（新总量替换旧总量）。\n重算后以下后续时段不可启动：\n${blockedToastDetail(next.blockedAfterFinish)}`);
    } else {
      toast('success', `${which}更正完成：曝光 ${fmt(next.beforeExposure)} → ${fmt(next.afterExposure)} lux·min，作品账目已同步重算`);
    }
  } catch (err) {
    if (err.status === 409) {
      $('#correctModal').classList.add('hidden');
      await handleMutationError(err);
      return;
    }
    $('#cr_error').textContent = formatSegmentError(err);
    $('#cr_error').classList.remove('hidden');
  }
});

function formatSegmentError(err) {
  const p = err.payload || {};
  const lines = [];
  if (p.errors && p.errors.length) p.errors.forEach((x) => lines.push(`• ${typeof x === 'string' ? x : x.message}`));
  else if (err.message) lines.push(err.message);
  return lines.join('\n') || '提交失败';
}

// ---------- 作品弹窗 ----------
function openArtworkModal(a) {
  editingArtworkId = a ? a.id : null;
  $('#artworkModalTitle').textContent = a ? '编辑作品' : '录入作品';
  $('#aw_name').value = a ? a.name : '';
  $('#aw_limit').value = a ? a.limit : '';
  $('#aw_existing').value = a ? a.existing : '';
  $('#aw_note').value = a ? a.note : '';
  $('#aw_error').classList.add('hidden');
  $('#artworkModal').classList.remove('hidden');
}
$('#addArtworkBtn').addEventListener('click', () => openArtworkModal(null));

$('#artworkTable').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = Number(btn.dataset.id);
  if (btn.dataset.act === 'edit-art') {
    openArtworkModal(state.artworks.find((a) => a.id === id));
  }
  if (btn.dataset.act === 'del-art') {
    const a = state.artworks.find((x) => x.id === id);
    if (!confirm(`确定删除作品「${a.name}」吗？`)) return;
    try {
      const next = await api(`/api/artworks/${id}`, { method: 'DELETE', body: { version: state.version } });
      applyNewState(next);
      toast('success', '作品已删除');
    } catch (err) { await handleMutationError(err); }
  }
});

$('#aw_save').addEventListener('click', async () => {
  const payload = {
    version: state.version,
    name: $('#aw_name').value,
    limit: Number($('#aw_limit').value),
    existing: Number($('#aw_existing').value),
    note: $('#aw_note').value,
  };
  try {
    const next = editingArtworkId
      ? await api(`/api/artworks/${editingArtworkId}`, { method: 'PUT', body: payload })
      : await api('/api/artworks', { method: 'POST', body: payload });
    applyNewState(next);
    $('#artworkModal').classList.add('hidden');
    toast('success', editingArtworkId ? '作品已更新' : '作品已录入');
  } catch (err) {
    if (err.status === 409) { $('#artworkModal').classList.add('hidden'); }
    await handleMutationError(err);
  }
});

// ---------- 通用 ----------
function applyNewState(next) {
  state = next;
  $('#versionTag').textContent = `v${state.version}`;
  draft = state.slots.filter((s) => s.status === 'scheduled').map(serverRowToDraft);
  renderAll();
}
async function handleMutationError(err) {
  if (err.status === 409 && err.payload && err.payload.state) {
    applyNewState(err.payload.state);
    toast('error', `${err.message}\n本地草稿已被服务端最新预算替换，请重新调整后再提交`);
    return;
  }
  if (err.status === 422 && err.payload) toast('error', formatBatchError(err.payload));
  else toast('error', err.message);
}

document.querySelectorAll('[data-close]').forEach((b) =>
  b.addEventListener('click', () => b.closest('.modal-mask').classList.add('hidden')));
document.querySelectorAll('.modal-mask').forEach((m) =>
  m.addEventListener('click', (e) => { if (e.target === m) m.classList.add('hidden'); }));

$('#refreshBtn').addEventListener('click', () => loadState(true).then(() => toast('success', '已刷新为最新预算')));

loadState().catch((err) => toast('error', `初始化加载失败：${err.message}`));
