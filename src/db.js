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
-- status: scheduled 未开始 / running 进行中(冻结原排期) / finished 已结束(以实际值结算)
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
