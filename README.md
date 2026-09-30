# 巡展作品光照预算 Web 工作台

为巡展作品管理展期曝光预算的本地 Web 工具：Node.js + SQLite + 浏览器页面，单机本地运行。

- **作品维度**：录入展期曝光上限与既有累计量，实时显示已用 / 预占 / 余额（单位 lux·min）。
- **时段维度**：为展厅时段录入起止时间、照度（lux）和展出作品，按 **实际经过分钟 × 照度** 计算曝光。
- **多段照度结算**：巡展时段的实际照度可能随时间变化。进行中时段可按实际起止提交**多段照度**完成结算，曝光 = Σ（各段实际分钟 × 段照度）；每段含起止与非负照度，分段须首尾衔接、无重叠且完整覆盖实际区间，否则**整批拒绝**。
- **分段更正**：已结束时段可按**原实际起止**提交带理由的完整分段更正；记录更正前后曝光和时间，**新总量替换旧总量、不重复累计**，并同步重算作品已用量、后续时段不可启动状态与缺口。
- **整批排期**：未开始时段在草稿中统一编辑后整批提交；同一作品时段重叠、或“已用 + 预占”超上限时 **拒绝整批**，逐条指出冲突作品与时段。
- **生命周期**：时段开始即冻结原排期并保留预占；结束时补记实际起止与照度（单一照度或多段），**实际曝光替换该时段预占**；结算超量后按开始时间/编号顺序标出不可启动时段与缺口并禁止启动。
- **临时闭馆：暂停 / 恢复（本轮新增）**：进行中时段可多次暂停；每次暂停提交**本段展出区间起止与完整衔接的照度分段**（首次可录实际开始），已完成区间计入已用、**暂停空档不计曝光并释放未展预占**；恢复时提交**恢复时间与新预计结束时间**，按冻结的计划照度 × 新预计时长重新预占，并重算作品余额与后续时段缺口；最终结束按各展出区间累计结算。各展出区间按时间递增、互不重叠，且不与同作品其他时段重叠。
- **乐观并发**：所有调整（含多段结算、暂停/恢复与分段更正）携带当前版本号，过期版本返回 409 与最新预算，失败不改变结算和版本。

## 一键启动（Docker Compose，推荐）

```bash
docker compose up -d --build
```

启动后打开：

- **页面地址**：http://localhost:8080
- 初始化：首次启动自动建表并写入演示数据（3 件作品 + 已结束/进行中/未开始时段）。

如需更换宿主机端口：

```bash
PORT=9090 docker compose up -d --build   # 页面变为 http://localhost:9090
```

停止与重置初始数据：

```bash
docker compose down            # 停止，数据保留在命名卷中
docker compose down -v         # 同时删除数据卷，下次启动重新初始化
```

## 本地直接运行（需要 Node.js ≥ 20）

```bash
npm install
npm start
# 打开 http://localhost:8080
```

## 配置（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8080` | HTTP 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址（本地直跑可设 `127.0.0.1`） |
| `DB_PATH` | `./data/lightbudget.db`（Docker 内为 `/app/data/lightbudget.db`） | SQLite 数据库文件路径；文件不存在时自动建库并初始化 |

## 计算与校验规则

- **曝光量** = （结束 − 开始，分钟）× 照度 lux，单位 **lux·min**。
- **已用** = 作品既有累计量 + 所有已结束时段的**实际**曝光 + 暂停/进行中时段**已闭合展出区间**的曝光。
- **预占** = 进行中时段的（冻结）计划曝光（暂停/恢复后为「恢复时间→新预计结束」按冻结计划照度计算）+ 所有未开始时段的计划曝光之和；**暂停期间该时段预占释放为 0**。
- **余额** = 上限 − 已用 − 预占；余额为负即超量。
- 排期整批保存时校验：
  1. 时间格式合法、结束晚于开始、照度/累计量非负（无效时序或负值一律拒绝）；
  2. 同一作品在任意两个未开始时段、以及与进行中（冻结区间）/已结束（实际区间）时段之间不得重叠；
  3. 每件作品「既有 + 已结束实际 + 进行中预占 + 本批未开始预占」不得超过展期上限。
- 任一条不满足则整批不落库，响应中给出作品、冲突时段对或超量数值。
- **不可启动核算**：每次调整/启动/结算/分段更正后，未开始时段按开始时间（再按编号）顺序尝试占用预算；任一关联作品余额不足即标记为“不可启动”并列出每件作品的可用余额、需求与缺口，启动接口对该时段返回 422。调整排期保存后自动重新核算。
- **多段照度结算（进行中时段）**：
  1. 必须携带当前 `version`；实际开始早于实际结束；
  2. `segments` 为非空数组，每段含 `start`、`end`（合法时间，结束晚于开始）与非负 `lux`；
  3. 按提交顺序，第一段起点必须等于实际开始、相邻段首尾必须相接（前段 `end` = 次段 `start`）、最后一段终点必须等于实际结束——即**无重叠、无缺口、完整覆盖**；
  4. 曝光 = Σ（段分钟 × 段照度），替换该时段预占并触发不可启动重算；
  5. 任一段非法或不满足衔接/覆盖 → `422 SEGMENTS_INVALID` 并逐条给出原因，**整批拒绝，结算与版本均不变**；版本过期 → `409 VERSION_STALE` 与最新预算。
- **分段更正（已结束时段）**：
  1. 必须携带当前 `version` 与非空 `reason`（≤200 字）；
  2. 实际区间沿用时段**原实际起止，不可更改**；提交的完整分段须按上述同样规则覆盖该区间；
  3. 新曝光总量**替换**旧总量（非累加），同步重算作品已用量、后续时段不可启动状态与缺口；
  4. 每次更正留痕：更正前后的实际起止、曝光总量、理由、所基于版本、时间戳及“更正后分段”快照，可在页面「分段更正记录」中查看，也随该时段在 `GET /api/state` 的 `corrections` 字段返回。
- **并发版本**：每次成功变更版本号 +1。请求必须携带当前 `version`；不匹配时返回 `409 VERSION_STALE` 与最新完整预算，前端自动刷新后需重新调整提交。

### 暂停 / 恢复（临时闭馆）规则

1. 时段状态在 `scheduled → running →（paused ⇄ running，可多次）→ finished` 间流转；`paused` 为本轮新增。
2. **暂停 `POST /api/slots/:id/pause`**（必须携带 `version`）：提交 `{version, start, end, segments[]}`。
   - 首次暂停：`start` 可录实际开始；其后各次：`start` 必须**等于当前恢复时间**；
   - `end`（暂停时间）必须严格晚于本段 `start`；`segments` 须首尾衔接、无重叠、完整覆盖 `[start, end]`；
   - 成功后写入一个已闭合展出区间：区间曝光 = Σ(段分钟×照度)，**计入作品已用**；时段转 `paused`，**未展部分预占释放（=0）**，暂停空档不曝光；
   - 本区间还不得与同作品其他时段（未开始计划区间 / 进行中冻结或恢复后预占区间 / 已结束实际区间 / 其他已闭合区间）重叠，否则 `422 INTERVAL_OVERLAP` 整次拒绝。
3. **恢复 `POST /api/slots/:id/resume`**（必须携带 `version`）：提交 `{version, resumeTime, estimatedEnd}`。
   - `resumeTime` 必须严格晚于上次暂停终点；`estimatedEnd` 必须严格晚于 `resumeTime`；
   - 时段转 `running`，按冻结的**计划照度**与「新预计时长」重新预占：(estimatedEnd − resumeTime) × plannedLux；
   - 恢复后的预占区间不得与同作品其他时段重叠，否则 `422 INTERVAL_OVERLAP`；恢复后自动重算作品余额与后续未开始时段缺口。
4. **最终结束**：
   - 恢复后处于 `running`：`POST /api/slots/:id/settle` 提交最后区间 `{version, start, end, segments[]}`，`start` 必须等于恢复时间；总量 = 各区间曝光之和；
   - 处于 `paused`：可直接 `POST /api/slots/:id/settle`（仅带 `version`，不带起止/分段），按已提交的各展出区间累计收尾，暂停空档不计曝光。
5. 各展出区间**按时间递增、互不重叠**；时间或分段无效、版本过期时整次拒绝——**状态、账目与版本均不变**（版本过期返回 409 与最新预算）。
6. **区间更正**：含已闭合展出区间的时段（暂停中 / 恢复后 / 已结束均可）调 `POST /api/slots/:id/correct` 时必须带 `intervalIndex`，新分段完整覆盖该区间原起止；新区间曝光替换旧值，总量与作品账目、后续缺口同步重算，更正记录标注区间号。
7. 旧的单一照度 `finish` 与未暂停时段的多段 `settle` / `correct` 行为保持不变；对已有展出区间的 running 时段调用旧 `finish` 会被拒绝（请用区间结算，避免账实不符）。

## 接口一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/state` | 最新版本、作品预算汇总、全部时段（含 `actualSegments` / `corrections` / `intervals` / 暂停字段）及不可启动核算结果 |
| POST | `/api/artworks` | 录入作品（body 带 `version`） |
| PUT | `/api/artworks/:id` | 修改作品上限/既有量等 |
| DELETE | `/api/artworks/:id` | 删除作品（被时段引用时拒绝） |
| POST | `/api/schedule` | **整批替换未开始时段**（body：`{version, slots:[...]}`） |
| POST | `/api/slots/:id/start` | 启动时段：冻结原排期、保留预占 |
| POST | `/api/slots/:id/pause` | **暂停（临时闭馆）**：`{version, start, end, segments[]}` 闭合本段展出区间，计入已用、释放预占 |
| POST | `/api/slots/:id/resume` | **恢复展出**：`{version, resumeTime, estimatedEnd}`，按新预计时长与计划照度重新预占 |
| POST | `/api/slots/:id/finish` | 结束补记（保持可用，仅限未暂停过的时段）：`{actualStart, actualEnd, actualLux}` 单一照度结算，无需版本 |
| POST | `/api/slots/:id/settle` | **多段照度结算**：未暂停用 `{version, actualStart, actualEnd, segments[]}`；暂停恢复后用 `{version, start, end, segments[]}` 闭合最后区间；暂停中可仅带 `{version}` 按已展区间直接收尾 |
| POST | `/api/slots/:id/correct` | **分段更正**：`{version, reason, segments[]}`（区间沿用原实际起止）；含展出区间的时段须带 `intervalIndex` |

### 多段结算与分段更正：HTTP 调用示例

先取当前版本：

```bash
curl -s http://localhost:8080/api/state | jq '.version, .slots[] | {id,status}'
```

进行中时段按多段实际照度结算（09:00–11:00 为 200 lux，11:00–13:00 降为 100 lux）：

```bash
curl -s -X POST http://localhost:8080/api/slots/2/settle \
  -H 'Content-Type: application/json' \
  -d '{
    "version": 1,
    "actualStart": "2026-09-30T09:00",
    "actualEnd":   "2026-09-30T13:00",
    "segments": [
      { "start": "2026-09-30T09:00", "end": "2026-09-30T11:00", "lux": 200 },
      { "start": "2026-09-30T11:00", "end": "2026-09-30T13:00", "lux": 100 }
    ]
  }'
```

返回为完整预算状态，另含：`justFinishedExposure`（总量 36000 = 120×200 + 120×100）、
`justFinishedSegments`（各段分钟/照度/曝光）、`blockedAfterFinish`（结算后被标不可启动的后续时段及缺口）。

分段不合法（缺口/重叠/未覆盖/负值）时返回 `422 SEGMENTS_INVALID`：

```json
{ "error": { "code": "SEGMENTS_INVALID", "message": "整批已拒绝：照度分段不合法…" },
  "errors": ["第 2 段：照度必须为非负数值", "分段在 … 之间存在缺口，分段必须首尾衔接"] }
```

对已结束时段按原实际起止提交带理由的完整分段更正：

```bash
curl -s -X POST http://localhost:8080/api/slots/1/correct \
  -H 'Content-Type: application/json' \
  -d '{
    "version": 3,
    "reason": "照度计复核：开场一小时 100 lux，之后恢复 150 lux",
    "segments": [
      { "start": "2026-09-29T09:10", "end": "2026-09-29T10:10", "lux": 100 },
      { "start": "2026-09-29T10:10", "end": "2026-09-29T11:50", "lux": 150 }
    ]
  }'
```

返回完整预算状态，另含 `correction`（更正记录）、`beforeExposure` / `afterExposure`、
`blockedAfterFinish`。版本过期时两接口均返回 `409` 与最新预算：

```json
{ "error": { "code": "VERSION_STALE", "message": "版本已过期：当前版本 v4…" },
  "state": { "version": 4, "artworks": [], "slots": [] } }
```

`GET /api/state` 中已结算时段结构（旧单一照度结算会合成单段）：

```json
{
  "id": 1, "status": "finished",
  "actualStart": "2026-09-29T09:10", "actualEnd": "2026-09-29T11:50",
  "actualLux": null, "actualExposure": 21000,
  "actualSegments": [
    { "index": 1, "start": "2026-09-29T09:10", "end": "2026-09-29T10:10", "minutes": 60,  "lux": 100, "exposure": 6000 },
    { "index": 2, "start": "2026-09-29T10:10", "end": "2026-09-29T11:50", "minutes": 100, "lux": 150, "exposure": 15000 }
  ],
  "corrections": [
    { "id": 1, "intervalIndex": null, "reason": "…", "baseVersion": 2, "createdAt": "2026-09-30T12:00:00.000Z",
      "before": { "start": "…", "end": "…", "exposure": 22400 },
      "after":  { "start": "…", "end": "…", "exposure": 21000, "segments": [ /* 同上分段快照 */ ] } }
  ]
}
```

### 暂停 / 恢复：HTTP 调用示例

临时闭馆，暂停进行中时段（首次可录实际开始；本段 09:00–10:00 为 200 lux，10:00–11:00 降为 100 lux）：

```bash
curl -s -X POST http://localhost:8080/api/slots/2/pause \
  -H 'Content-Type: application/json' \
  -d '{
    "version": 4,
    "start": "2026-09-30T09:00",
    "end":   "2026-09-30T11:00",
    "segments": [
      { "start": "2026-09-30T09:00", "end": "2026-09-30T10:00", "lux": 200 },
      { "start": "2026-09-30T10:00", "end": "2026-09-30T11:00", "lux": 100 }
    ]
  }'
```

返回完整预算状态，另含 `pausedInterval`（刚闭合的区间与分段）、`accumulatedExposure`（累计已展）、
`currentReservation`（暂停期间为 **0**，即预占已释放）、`blockedAfterFinish`（重算后的后续缺口）。
此时段在 `GET /api/state` 中：

```json
{
  "id": 2, "status": "paused",
  "resumeStart": null, "estimatedEnd": null, "pauseCount": 1,
  "accumulatedExposure": 18000, "currentReservation": 0,
  "intervals": [
    { "index": 1, "start": "2026-09-30T09:00", "end": "2026-09-30T11:00",
      "minutes": 120, "exposure": 18000,
      "segments": [
        { "index": 1, "start": "…09:00", "end": "…10:00", "minutes": 60, "lux": 200, "exposure": 12000 },
        { "index": 2, "start": "…10:00", "end": "…11:00", "minutes": 60, "lux": 100, "exposure": 6000 }
      ] }
  ]
}
```

13:00 恢复展出，新预计 17:00 结束（按冻结计划照度 200 lux × 240 分钟重新预占 48000）：

```bash
curl -s -X POST http://localhost:8080/api/slots/2/resume \
  -H 'Content-Type: application/json' \
  -d '{"version": 5, "resumeTime": "2026-09-30T13:00", "estimatedEnd": "2026-09-30T17:00"}'
```

返回 `{ …state, resumedAt, estimatedEnd, currentReservation, accumulatedExposure, blockedAfterFinish }`；
时段回到 `running` 且带 `resumeStart/estimatedEnd`。恢复后再次暂停时，本段 `start` 必须等于 `resumeTime`。

最终结束有两种方式：

```bash
# A) 恢复后（running）闭合最后区间，start 必须等于恢复时间
curl -s -X POST http://localhost:8080/api/slots/2/settle \
  -H 'Content-Type: application/json' \
  -d '{
    "version": 6,
    "start": "2026-09-30T13:00", "end": "2026-09-30T17:00",
    "segments": [ { "start": "2026-09-30T13:00", "end": "2026-09-30T17:00", "lux": 200 } ]
  }'

# B) 暂停中（paused）直接按已提交区间累计收尾，暂停空档不曝光
curl -s -X POST http://localhost:8080/api/slots/2/settle \
  -H 'Content-Type: application/json' -d '{"version": 5}'
```

两种方式返回均含 `justFinishedExposure`（全部展出区间累计）、`justIntervals`（各区间明细）与
`blockedAfterFinish`。对暂停流时段的某一已闭合区间做分段更正时带 `intervalIndex`：

```bash
curl -s -X POST http://localhost:8080/api/slots/2/correct \
  -H 'Content-Type: application/json' \
  -d '{
    "version": 7,
    "intervalIndex": 1,
    "reason": "首段照度计复核为 180 lux",
    "segments": [
      { "start": "2026-09-30T09:00", "end": "2026-09-30T10:00", "lux": 180 },
      { "start": "2026-09-30T10:00", "end": "2026-09-30T11:00", "lux": 100 }
    ]
  }'
```

时序/分段/区间编号或同作品时段重叠不合法时，暂停、恢复、结算、更正均返回 422 整次拒绝
（错误码 `VALIDATION` / `SEGMENTS_INVALID` / `INTERVAL_OVERLAP` / `NOT_RUNNING` / `NOT_PAUSED`），
**状态、账目与版本不变**；版本过期统一 `409 VERSION_STALE` 并返回最新预算。

## 页面用法

### 暂停 / 恢复（本轮新增）

- **进行中 / 已暂停 / 已结束时段**表新增暂停状态展示：徽标区分「进行中·冻结」「进行中·已暂停 N 次」「已暂停」「已结束」；
  每个暂停流时段按**展出区间**列出区间起止、区间内分段照度与暂停空档（标注“暂停中：空档不曝光，预占已释放”）；
  实际曝光列显示**累计曝光（计入已用）**与**当前预占**（暂停中为 0）。
- 进行中时段点 **⏸ 暂停**：弹窗填写本段开始（首次可改，恢复后锁定为恢复时间）、暂停时间与完整衔接分段，实时显示本段曝光；
  成功后作品已用/预占/余额与后续缺口即时刷新。
- 已暂停时段点 **▶ 恢复**：填写恢复时间（默认上次暂停终点，需晚于该时间）与新预计结束时间，实时预览按计划照度计的重新预占；
  与同作品其他时段重叠会整次拒绝并提示冲突时段。
- 已暂停时段可点 **结束（按已展区间）** 直接收尾；恢复后点 **结束并结算** 提交自恢复时间起的最后区间。允许多次暂停/恢复。
- 含展出区间的时段点 **分段更正**：弹窗顶部下拉选择要更正的区间（区间起止固定），提交后总量、累计曝光与缺口同步重算。

### 多段结算与更正（既有能力）

- **进行中 / 已结束时段**表的“实际起止 / 分段”“分段照度”“实际曝光”三列展示分段明细；旧单一照度结算显示为单段。
- 进行中时段点 **结束补记**：弹窗勾选「按多段实际照度结算」即可增删多段（开始/结束时间、照度），实时显示 Σ 曝光；不勾选则保持原有单一照度补记（对应 `finish`，无需版本）。
- 已结束时段点 **分段更正**：弹窗显示原实际区间（不可改），填写理由并提交完整分段；成功后页面顶部提示更正前后曝光，作品已用量与后续不可启动状态即时刷新。
- 页面新增 **分段更正记录** 卡片：按时间倒序展示每次更正的理由、实际区间、更正前后曝光、变化量与更正后分段（暂停流的区间更正会标注对应区间号）。

## 快速体验超量拦截

初始演示数据以 2026-09-30 为当天，预算均充足。进入页面：

1. 对「一号厅 09:00–13:00（进行中）」点 **结束补记**；
2. 把实际照度改为 `300`（240 分钟 × 300 = 72000 lux·min），保存；
3. 后续二号厅时段会被标记为 **不可启动**，页面列出《山水轴》《星夜手稿》的缺口，启动按钮被禁止；
4. 在未开始排期草稿中缩短时长 / 降低照度 / 改展作品后 **整批校验并保存**，缺口消除即可重新启动。
