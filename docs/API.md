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
| `/contests/:id/groups` | `participants` 正式队、`observers` 打星队 |
| `/contests/:id/organizations` | 学校/组织 |
| `/contests/:id/problems` | 题号、顺序、标题、气球 `color`/`rgb` |
| `/contests/:id/languages` | 语言 |
| `/contests/:id/judgement-types` | 判题类型 |
| `/contests/:id/submissions` | 提交元数据，不含代码 |
| `/contests/:id/judgements` | 判题元数据，不含编译日志或测试点 |
| `/contests/:id/<集合>/:objectId` | 上述集合中单个对象 |
| `/contests/:id/scoreboard` | 正式榜单；可用 `group_id=participants` 或 `group_id=observers` |
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

首次访问建立当前比赛快照作为日志基线；每约 2 秒轮询活跃比赛，5 分钟无人读取后停止后台轮询。本插件记录的是**观察到的状态变化**，无法补造首次启用前、停机期间或两个轮询间被覆盖的全部中间判题过程。

日志不自动删除。备份时同时保留两个集合；删除日志意味着下游必须丢弃游标并重新建立基线，不应只清理其中一个集合。

## 封榜与队伍

直播视图对**提交时间严格晚于** `lockAt` 的结果隐藏 verdict、结束时间和 Hydro 状态。封榜前提交在封榜后判出的结果仍可见，边界与现有 Hydro 规则一致。

历史事件回放同样按当前封榜策略过滤；提前封榜时间或重新封榜不会通过旧事件泄漏隐藏结果。解封后消费者会得到可见结果更新。

CCS 队伍 ID 使用 Hydro 队伍账号用户名，`team_id` 引用相同值；团队成员的提交根据原生 journal 和成员关系归属。比赛管理员账号标记 `hidden: true` 并排除出榜单。打星队保留展示，默认正式排名排除打星队；指定 `group_id=observers` 可取打星独立榜。

## 扩展字段与罚时

| 字段 | 说明 |
| --- | --- |
| `contest.x_hydro_rules` | `HYDRO_ACM_V1` 规则标识 |
| `contest.x_hydro_time_unit` | `seconds` |
| `scoreboard.rows[].x_hydro_total_seconds` | Hydro 秒级总罚时 |
| `problems[].x_hydro_time_seconds`（榜单内） | 首次 AC 的秒数 |
| `submissions[].x_hydro_order` | 原生 journal 内顺序，无法确认时为 null |
| `teams[].x_hydro_username(s)` | 队伍账号及可读成员账号名 |
| `submissions[].x_hydro_username` | 实际提交者用户名 |
| `judgements[].x_hydro_status` | 当前可见的 Hydro 判题状态 |
| `judgements[].x_hydro_rank` | 仅未封榜视图：该次 CCS 观察前后的名次及来源信息 |

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
