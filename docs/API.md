# API 与兼容范围

采用 ICPC Contest API 2023-06 的 JSON 资源及 NDJSON 事件表示。以下是已实现的只读子集，不声称完整标准兼容。

本仓库是这些服务端行为的唯一维护入口。1.x 的消费者可依赖现有路径、鉴权、事件格式及 `x_hydro_*` 字段含义；应忽略未知资源类型和新增可选字段。不兼容变更在主版本及迁移说明中明确发布，兼容更新保持日志 scope/token 可续传。

## 鉴权与地址

API 基址为 `/api/ccs`，域内为 `/d/<domain>/api/ccs`。所有资源均为 GET，包括 API 元信息也要求鉴权。

- `Authorization: Basic ...`：直播视图，遵守 Hydro 封榜。
- `x-ccs-api-key: ...`：可选的未封榜只读视图，默认关闭。
- 未封榜读取密钥须为 32–1024 个可见 ASCII 字符且不含空白，推荐随机十六进制字符串；Basic 密码仍可使用 UTF-8 文本。
- 两种方式都只允许 `hydroCcsApi.contests` 中的比赛。
- 若请求携带错误的 `x-ccs-api-key`，即使 Basic 正确也拒绝，避免意外切换视图。
- 不接受 URL 查询参数里的密码/密钥，不使用 Hydro 登录 Cookie 鉴权。

响应设为 `Cache-Control: no-store`，并按鉴权请求头区分缓存。不要通过反向代理向公共访客注入未封榜密钥。

## 资源

下列路径相对 API 基址：

| 路径 | 内容 |
| --- | --- |
| `/` | API 版本与插件名称、版本 |
| `/contests` | 当前域白名单内的固定时间 acm 比赛 |
| `/contests/:id` | 比赛信息、开赛时间、时长、封榜时长 |
| `/contests/:id/state` | 开始、结束、封榜、解封状态 |
| `/contests/:id/access` | 本实现支持的实体字段；写入能力列表为空 |
| `/contests/:id/teams` | 队伍、所属组织、组别及隐藏标记 |
| `/contests/:id/groups` | `participants` 正式队、`observers` 打星队、当前域用户组及可选手动附加分组 |
| `/contests/:id/organizations` | 学校/组织 |
| `/contests/:id/problems` | 题号、顺序、标题、气球 `color`/`rgb`、可确定时的测试点总数 `test_data_count` |
| `/contests/:id/languages` | 语言 |
| `/contests/:id/judgement-types` | 判题类型 |
| `/contests/:id/submissions` | 提交元数据，不含代码 |
| `/contests/:id/judgements` | 判题状态和最终结果，不含编译日志 |
| `/contests/:id/runs` | 逐测试点完成结果；不含输入输出、文件路径、测试点消息 |
| `/contests/:id/<集合>/:objectId` | 上述集合中单个对象 |
| `/contests/:id/scoreboard` | 正式榜单；可用 `group_id=<分组ID>` 筛选，`group_id=observers` 为打星独立榜 |
| `/contests/:id/event-feed` | 持续 NDJSON 事件流 |

仅支持固定起止时间的 Hydro `acm` 比赛。OI/IOI、个人计时比赛返回 400。不存在的比赛/资源返回 404。

## 事件流与恢复

```text
GET /api/ccs/contests/<id>/event-feed
GET /api/ccs/contests/<id>/event-feed?stream=false
GET /api/ccs/contests/<id>/event-feed?since_token=<last-token>
```

每行是 `{ "type": ..., "id": ..., "data": ..., "token": ... }`，空行表示心跳，`data: null` 表示删除。消费者只在完整处理一条事件后保存 token。

`stream=false` 返回截至请求时点的持久事件历史；它不是仅包含当前对象的快照。携带 `since_token` 时跳过已消费事件。token 绑定插件日志版本、域、比赛和鉴权视图；错误、跨范围或超出已提交事件的 token 返回 400。账号密码轮换不改变日志命名空间，但旧凭据失效。

MongoDB 使用 `hydro.ccs.api.commits` 与 `hydro.ccs.api.chunks` 两个独立集合。先写不可变事件块，再提交具有唯一索引的版本；支持独立 Mongo 实例。多进程竞争提交时保留唯一胜出批次。服务重启后从日志恢复，部分失败不会产生成功的空事件历史。

首次访问建立当前比赛快照作为日志基线。对活跃比赛监听 Hydro `record/change` / `record/judge`，收到通知后刷新并在事件提交成功时唤醒流；同时每约 2 秒轮询，以处理通知遗漏、其他进程写入及比赛配置变化。刷新过程中到达的通知会安排后续读取，5 分钟无人读取后停止后台观察。

本插件记录的是**观察到的状态变化**。通知会触发读取当前数据库状态，并不复制一套 Hydro 评测消息队列；并发通知可合并为一次后续读取。首次启用前、停机期间或两次读取之间已被覆盖的过程不能补造；测试点若成批上报，进度也会成批推进。

日志不自动删除。备份时同时保留两个集合；删除日志意味着下游必须丢弃游标并重新建立基线，不应只清理其中一个集合。

## 逐测试点判题进度

1.1.0 新增 `runs`，沿用原日志命名空间和 token；升级后旧游标可继续使用。直播端按所属 `judgement_id` 统计当前 run 对象数量，再除以 `problems.test_data_count`。每次收到相同 run ID 应更新已有对象，`data: null` 应删除对象，不能把事件条数直接当作测试点数量。

`test_data_count` 来自 Hydro 解析后的题目配置，包括引用题目。无法确定有效正整数总数时省略该字段，并不输出该题的 runs。测试点结果仅读取 `id`、`subtaskId`、`status`、`time`；不导出评测消息、文件路径或测试数据。

每个 run 提供 `id`、`judgement_id`、`ordinal`、`judgement_type_id`、`time`、`contest_time`、`run_time`。Hydro 以 `(subtaskId, id)` 标识测试点，插件为这些标识分配并持久保存 `1..test_data_count` 的 ordinal；它是稳定的 CCS 序号，不表示测试点完成先后，也不保证等于 Hydro 页面题号。并行完成、同名子任务测试点和重复通知不会重复累计。观察到重判清空测试点后，会先删除旧 runs，再报告新进度。

`run_time` 将 Hydro 的毫秒耗时转换为秒。Hydro 没有保存每个测试点的墙钟完成时间，因此 `time` / `contest_time` 使用 CCS 首次观察该结果的时间，并以 `x_hydro_time_source: "CCS_OBSERVED"` 标明；重读和重启不会改变未变化结果的时间。这不代表补全了接入前的实际测试点执行历史。

排队、编译、评测中时 `judgement_type_id` 与结束时间保持 null；最终结果等待原生 journal 同步。榜单继续依据 journal 计算，即使重判时实时 record 已经恢复为等待状态。

HydroJudge 的 `performance` 模式会缓存测试点直到结束；部分版本的重判也采用这种批量上报方式。题目 `detail: none`、远端评测机或其他不提供测试点的评测配置可能没有逐点数据。需要实时进度时，应确认评测机逐步上报真实测试点；单独的 `progress` 百分比不能生成可靠的标准 runs。

## 封榜与队伍

直播视图对**提交时间严格晚于** `lockAt` 的结果隐藏 verdict、结束时间和 Hydro 状态。封榜前提交在封榜后判出的结果仍可见，边界与现有 Hydro 规则一致。

历史事件回放同样按当前封榜策略过滤；提前封榜时间或重新封榜不会通过旧事件泄漏隐藏结果。封榜后的提交不输出 runs；历史中的对应 run 事件保留 token，但转为 `data: null`，避免结果或测试点完成数量进入直播进度。解封后消费者会得到可见结果与 runs 更新。

CCS 队伍 ID 使用 Hydro 队伍账号用户名，`team_id` 引用相同值；团队成员的提交根据原生 journal 和成员关系归属。比赛管理员账号标记 `hidden: true` 并排除出榜单。打星队保留展示，默认正式排名排除打星队；指定 `group_id=observers` 可取打星独立榜。

## 域用户组与附加分组

默认读取比赛所在域的 `UserModel.listGroup(domainId)`，复用 Hydro **域管理 → 用户组** 中的成员关系，无需填写 CCS 分组设置。每次快照直接读取用户组，不依赖缓存的 `User.group`。只有包含本场有效队伍账号 UID 的组才导出；团队成员 UID 不会使其队伍自动归组，也不导出其他域、无关或空用户组。与官方 XCPCIO 一致，满足 `Number.isSafeInteger(+name)` 的组名会被忽略，包括数字账号组。

分组 `name` 保留 Hydro 用户组名称。若组名满足 `[a-zA-Z0-9_.-]{1,36}`、不以 `-` / `.` 开头、不以 `.` 结尾，且不等于 `participants` / `observers`、不以 `hydro-group-` 开头，则直接作为 `id`；否则使用 `hydro-group-<用户组的24位ObjectId>`。这保证中文名称可用且不会覆盖内置分组，生成 ID 依赖该用户组文档的持久 ID。

内置 `participants` / `observers` 的 ID 和含义保持不变。队伍 `group_ids` 第一项仍由 `unrank` 决定为 `participants` / `observers`，之后按 ID 排序追加所属域用户组，最后按配置顺序追加匹配的手动分组。学校分组与 `organization_id` 独立，组织 ID 映射不会改变用户组成员。

用户组增删成员会在下一次请求或轮询时生成队伍更新；最后一支本场队伍移出或组被删除后，输出该组的删除事件。用户组读取失败时返回 503，不提交部分状态或误删已有分组。

### 可选手动分组

`hydroCcsApi.groups` 接受 JSON 文本数组，每项定义一个额外分组，默认空配置。已有域用户组不需要在这里重复定义。配置示例见 [groups.example.json](../examples/groups.example.json)。

| 字段 | 含义 |
| --- | --- |
| `id` | 必填，匹配 `[a-zA-Z0-9_-]{1,64}`，区分大小写，全配置唯一；不能使用 `participants` 或 `observers` |
| `name` | 必填，去除首尾空白后为 1–128 字符的显示名称 |
| `schools` | 可选的学校名称字符串数组，与队伍账号去除首尾空白后的 `school` 精确匹配 |
| `teams` | 可选的队伍账号用户名字符串数组，与 `teams[].id` 精确匹配，区分大小写；不依据团队成员账号归组 |
| `contests` | 可选的非空 `域ID/24位比赛ID` 字符串数组；省略时适用于所有域和比赛 |

每项必须至少填写 `schools` / `teams` 之一；同时填写时按交集匹配。选择条件省略表示不限制，显式 `[]` 表示没有队伍匹配；不同分组可重叠，同一队伍可属于多个组。名单值去除首尾空白并去重。空配置或 `[]` 仅清除手动分组，保留域用户组同步；非法配置保存时拒绝，绕过设置页写入时返回 503，不发布不完整状态。

手动分组 ID 与当前域用户组的导出 ID 冲突时，以域用户组的名称和成员为准，手动规则整项忽略。即使该用户组暂时没有本场队伍，也会占用该 ID，防止旧名单将已移出的队伍重新加入；删除域用户组后，同 ID 的手动规则可重新生效。迁移到纯用户组管理时，可清空手动设置以避免旧规则回退。

除上述冲突外，当前比赛范围内配置的手动分组即使没有队伍也会输出，形如 `{"id":"besti_fresh","name":"北京电子科技学院新生","hidden":false}`；不输出匹配规则或其他比赛的名单。

### 事件与榜单

两种鉴权视图使用同一分组规则，保持各自的封榜策略。`/groups`、单分组对象、`/teams` 和 event-feed 使用相同对象和 ID；先发布新增分组，再发布引用它的队伍。修改名称、名单或清除配置会追加变更/删除事件，历史事件和既有 token 不变。`/scoreboard?group_id=<id>` 返回该分组内的正式排名，继续排除打星及隐藏队伍；只有 `group_id=observers` 单独计算打星榜。未知分组返回 400。

“全部队伍”是展示端取消分组筛选的行为，不额外生成 `all` 组。直播端的 `isHidden` / `isOutOfContest` 是消费端配置，不是本接口分组对象的标准字段；原正式/打星配置保持不变，新增学校/年级组可设为可见且不额外标记为场外。

## 组织 ID 映射

`hydroCcsApi.organizationIds` 是可选的 JSON 文本配置，例如 `{"西华师范大学":"cwnu"}`。它在所有域、比赛及两种鉴权视图中生效；学校名称来自队伍账号的 `school`，与配置键去除首尾空白后精确匹配。匹配时，`organizations[].id`、组织事件外层 `id` / `data.id` 以及 `teams[].organization_id` 均使用指定 ID；组织显示名称仍使用学校名称。单对象地址也使用该 ID，例如 `/contests/:id/organizations/cwnu`。

ID 须匹配 `[a-zA-Z0-9_-]{1,64}`，区分大小写；配置中的学校名称和目标 ID 均不能重复。未配置学校沿用 `SHA256(JSON.stringify(去除首尾空白后的学校名称))` 的前 32 个十六进制字符，没有学校则不生成组织且队伍 `organization_id` 为 null。只有实际参赛队伍使用到的学校才生成组织。留空或 `{}` 表示不覆盖原 ID。

系统设置保存时校验映射；若绕过设置页写入无效配置，或配置 ID 与另一所学校的默认哈希 ID 冲突，读取比赛数据返回 503，不发布不完整状态。

修改或清除映射在下一次刷新时生成正常的组织删除/新增及队伍更新事件，不改变日志范围、既有事件或 token。`stream=false` 的完整历史仍包含旧 ID，消费者须按顺序应用更新及 `data: null` 删除事件；当前 ID 以 `/organizations`、`/teams` 为准。建议在首次接入直播前配置好映射，按固定 ID 准备 package。

## 扩展字段与罚时

| 字段 | 说明 |
| --- | --- |
| `contest.x_hydro_rules` | `HYDRO_ACM_V1` 规则标识 |
| `contest.x_hydro_time_unit` | `seconds` |
| `scoreboard.rows[].x_hydro_total_seconds` | Hydro 秒级总罚时 |
| `problems[].x_hydro_time_seconds`（榜单内） | 首次 AC 的秒数 |
| `problems[].x_hydro_testcase_order` | 测试点 `subtaskId/id` 的稳定 ordinal 映射；数组下标加 1 为 ordinal，客户端无需解析 |
| `submissions[].x_hydro_order` | 原生 journal 内顺序，无法确认时为 null |
| `teams[].x_hydro_username(s)` | 队伍账号及可读成员账号名 |
| `submissions[].x_hydro_username` | 实际提交者用户名 |
| `judgements[].x_hydro_status` | 当前可见的 Hydro 判题状态 |
| `judgements[].x_hydro_journal_status` | 原生榜单使用的可见 journal 状态；重判过程中可能与实时 record 不同 |
| `judgements[].x_hydro_rank` | 仅未封榜视图：该次 CCS 观察前后的名次及来源信息 |
| `runs[].x_hydro_time_source` | `CCS_OBSERVED`，测试点事件时间来自 CCS 观察 |

标准 `score.total_time` 与单题 `time` 仍使用整数分钟。按分钟自行重算的客户端可能与 Hydro 秒级名次不同。

`x_hydro_rank` 是观察顺序的证据，不是 Hydro 数据库事务顺序。首次接入已有结果、journal 顺序不明确或打星等无法可靠比较的情况返回 `UNAVAILABLE`，不会补造名次。重判产生新事件，不改写历史事件。

Hydro 没有对应的最终确认动作，`finalized` / `end_of_updates` 保持 null；结束后仍可能接收重判。

## 错误

错误为 JSON `{ "code": <HTTP状态码>, "message": "..." }`：

- 400：参数、token 或赛制不支持。
- 401：鉴权失败，响应带 Basic challenge。
- 403：比赛不在允许清单。
- 404：比赛、资源或对象不存在。
- 503：配置异常、数据不可用或插件正在停止。不会返回底层数据库私有错误信息。

已经开始发送的事件流发生故障时连接结束；使用最后一条完整事件的 token 重连。插件卸载时主动取消活动流。
