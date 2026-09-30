'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'lightbudget.db');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- 全局版本：任何对作品 / 排期 / 时段生命周期的变更都会使其 +1。
-- 并发调整必须携带当前版本，过期则拒绝（409）。
CREATE TABLE IF NOT EXISTS meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL DEFAULT 1
);

-- 作品：展期曝光上限（lux·min）与既有累计量
CREATE TABLE IF NOT EXISTS artworks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  limit_amount REAL NOT NULL CHECK (limit_amount >= 0),
  existing_amount REAL NOT NULL CHECK (existing_amount >= 0),
  note TEXT NOT NULL DEFAULT ''
);

-- 展厅时段
-- status: scheduled 未开始 / running 进行中(冻结原排期；恢复后亦为 running) /
--         paused 已暂停(临时闭馆，空档不计曝光、不占预占) / finished 已结束(以实际值结算)
CREATE TABLE IF NOT EXISTS slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hall TEXT NOT NULL,
  seq INTEGER NOT NULL,                 -- 编号（按开始时间排序的顺序号）
  status TEXT NOT NULL DEFAULT 'scheduled',
  -- 排期（计划）值：开始后冻结
  planned_start TEXT NOT NULL,
  planned_end TEXT NOT NULL,
  planned_lux REAL NOT NULL CHECK (planned_lux >= 0),
  -- 结束时补记的实际值
  actual_start TEXT,
  actual_end TEXT,
  actual_lux REAL,
  actual_exposure REAL,
  -- 核算结果：该时段按当前预算是否可启动
  blocked INTEGER NOT NULL DEFAULT 0,
  blocked_reason TEXT NOT NULL DEFAULT '{}'
);

-- 时段 <-> 作品（一个时段可同时展出多件作品，同照度下分别计入各作品）
CREATE TABLE IF NOT EXISTS slot_artworks (
  slot_id INTEGER NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
  artwork_id INTEGER NOT NULL REFERENCES artworks(id) ON DELETE CASCADE,
  PRIMARY KEY (slot_id, artwork_id)
);

-- 实际照度分段（多段结算 / 分段更正）：各段首尾衔接、无重叠、完整覆盖实际区间。
-- 曝光 = Σ(段分钟 × 段照度)，与 slots.actual_exposure 总量一致。
-- 旧的单一照度结算（finish）不在此表留痕，读取时由 actual_start/end/lux 合成单段。
CREATE TABLE IF NOT EXISTS slot_segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slot_id INTEGER NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
  seg_index INTEGER NOT NULL,                 -- 从 1 开始，按时间顺序
  seg_start TEXT NOT NULL,
  seg_end TEXT NOT NULL,
  lux REAL NOT NULL CHECK (lux >= 0),
  exposure REAL NOT NULL CHECK (exposure >= 0),
  UNIQUE (slot_id, seg_index)
);

-- 已结束时段的分段更正记录：更正前后的实际起止、曝光总量与理由（新总量替换旧总量，不重复累计）
CREATE TABLE IF NOT EXISTS slot_corrections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slot_id INTEGER NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  before_start TEXT NOT NULL,
  before_end TEXT NOT NULL,
  before_exposure REAL NOT NULL,
  after_start TEXT NOT NULL,
  after_end TEXT NOT NULL,
  after_exposure REAL NOT NULL,
  base_version INTEGER NOT NULL,              -- 发起更正时携带的版本
  created_at TEXT NOT NULL                    -- ISO 时间戳
);
CREATE INDEX IF NOT EXISTS idx_slot_corrections_slot ON slot_corrections(slot_id, id);

-- 每次更正提交的“更正后分段”快照
CREATE TABLE IF NOT EXISTS slot_correction_segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  correction_id INTEGER NOT NULL REFERENCES slot_corrections(id) ON DELETE CASCADE,
  seg_index INTEGER NOT NULL,
  seg_start TEXT NOT NULL,
  seg_end TEXT NOT NULL,
  lux REAL NOT NULL CHECK (lux >= 0),
  exposure REAL NOT NULL CHECK (exposure >= 0)
);
CREATE INDEX IF NOT EXISTS idx_corr_segs_corr ON slot_correction_segments(correction_id, seg_index);

-- 展出区间（暂停/恢复模型）：一个时段可由多个互不重叠、按时间递增的展出区间组成，
-- 暂停空档不是区间、不计曝光。is_active=1：进行中（running）时段“当前未完结”的
-- 最后一段（start=首次实际开始或恢复时间，planned_end=新预计结束，按计划照度预占）；
-- is_active=0：已完成区间（暂停时提交或最终结束的区间，exposure 为该区间分段总量）。
-- 未使用暂停功能的旧时段没有区间行：读取时由 actual/planned 字段合成（兼容单段结算）。
CREATE TABLE IF NOT EXISTS slot_intervals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slot_id INTEGER NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
  int_index INTEGER NOT NULL,                 -- 从 1 开始，按时间递增
  int_start TEXT NOT NULL,                    -- 本段实际开始（首次实际开始 / 恢复时间）
  int_end TEXT,                               -- 本段终点：暂停时为暂停时间；进行中为 NULL
  planned_end TEXT NOT NULL,                  -- 本段新预计结束（预占据此计算；完成后留档）
  exposure REAL,                              -- 已完成区间的分段曝光总量；进行中为 NULL
  is_active INTEGER NOT NULL DEFAULT 0       -- 1 = 当前进行中的未完结区间（每时段至多一条）
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_slot_interval_active
  ON slot_intervals(slot_id) WHERE is_active = 1;
CREATE INDEX IF NOT EXISTS idx_slot_intervals_slot ON slot_intervals(slot_id, int_index);

-- 各展出区间内的实际照度分段（结构与 slot_segments 一致：首尾衔接、无重叠、完整覆盖该区间）。
-- slot_segments 仅保留给未使用暂停功能的旧结算/更正链路；暂停模型以本表为权威数据。
CREATE TABLE IF NOT EXISTS slot_interval_segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  interval_id INTEGER NOT NULL REFERENCES slot_intervals(id) ON DELETE CASCADE,
  seg_index INTEGER NOT NULL,
  seg_start TEXT NOT NULL,
  seg_end TEXT NOT NULL,
  lux REAL NOT NULL CHECK (lux >= 0),
  exposure REAL NOT NULL CHECK (exposure >= 0)
);
CREATE INDEX IF NOT EXISTS idx_int_segs_int ON slot_interval_segments(interval_id, seg_index);
`;

function openDb() {
  if (DB_PATH !== ':memory:') {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  }
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

function resetDb() {
  if (DB_PATH !== ':memory:' && fs.existsSync(DB_PATH)) {
    fs.rmSync(DB_PATH);
    for (const suffix of ['-wal', '-shm']) {
      const f = DB_PATH + suffix;
      if (fs.existsSync(f)) fs.rmSync(f);
    }
  }
  const db = openDb();
  db.close();
  return DB_PATH;
}

module.exports = { openDb, resetDb, DB_PATH };
