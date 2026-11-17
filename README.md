# Hydro CCS API

为 Hydro 原生 XCPC 比赛提供独立的只读 [ICPC Contest API 2023-06](https://ccs-specs.icpc.io/2023-06/contest_api)。可作为 ICPC Live、ICPC Tools CDS 等软件的比赛数据源。

本插件只依赖 Hydro 宿主与 Node.js 内置模块，具有独立配置、鉴权和事件日志。无需安装监考平台、桌面客户端、视频服务或其他 CCS 插件。

## 支持范围

- Hydro 原生 `acm`（XCPC）比赛，固定开赛和结束时间。
- 比赛、状态、队伍、分组、学校、题目、语言、提交、判题、逐测试点 `runs` 与榜单资源。
- 通过测试点总数与完成事件提供直播判题进度；监听 Hydro 评测变化，并保留轮询兜底。
- NDJSON 持续事件流、历史回放、`since_token` 断线续传。
- 直播视图遵守封榜；可选的独立只读密钥读取未封榜视图。
- 主站与域内比赛隔离，全部比赛访问受显式白名单限制。
- Hydro 秒级罚时、团队成员提交归属、打星分组和气球颜色。
- 自动复用比赛所在域的用户组，学校与年级分组无需重复维护账号名单。

当前不支持 OI/IOI 或个人计时的 `duration` 比赛。不提供写操作、选手代码、测试点输入输出、测试点消息、编译日志、题目包、`clarifications`、`awards` 或视频流。`runs` 仅包含测试点标识、判题结果、运行耗时等元数据。这是 Contest API 的一个只读子集，完整资源与兼容边界见 [API 文档](docs/API.md)。

## 环境

- Hydro **5.1.x**：当前使用 5.1.0 的真实 API 类型和设置注册器验证；其他版本需自行验证。
- Node.js **24 LTS**，或 22.18.0 及以上的 22.x。开发依赖也要求此范围。
- 使用 Hydro 已有 MongoDB；无需单独数据库或副本集事务。

## 安装

将本仓库下载或克隆到 Hydro 服务可以读取的目录：

```sh
git clone https://github.com/pppolf/hydro-ccs-api.git /opt/hydro-ccs-api
hydrooj addon add /opt/hydro-ccs-api
```

**用实际运行 Hydro 的同一用户执行 `hydrooj addon add`**，随后重启实际 Hydro 服务。容器部署需要将目录挂载进容器，并在容器内使用该路径注册。

插件入口是根目录的 `index.ts`，由 Hydro 的 TypeScript 加载器加载，运行时从宿主解析 `hydrooj`。仅部署源文件不需要编译，也不需要额外安装一份 Hydro。仓库的 `npm ci` 用于本地开发与测试，见下文。

## 配置

以 Hydro 系统管理员进入 **系统设置 → CCS 比赛数据接口**：

| 设置 | 默认值 | 用途 |
| --- | --- | --- |
| CCS 直播用户名 | `ccs` | HTTP Basic 用户名，无需创建同名 Hydro 用户 |
| CCS 直播密码 | 空 | 直播独立密码；首次未设置时拒绝 Basic 访问 |
| CCS 允许读取的比赛 | 空 | `域ID/24位比赛ID`，逗号或空白分隔，最多 100 项 |
| CCS 组织 ID 映射 | 空 | 学校名称到固定组织 ID 的 JSON 对象，便于提前准备直播 package |
| CCS 自定义分组（可选） | 空 | 默认自动复用域用户组；仅需额外按学校或队伍账号分组时填写 JSON 数组，可限定比赛 |
| CCS 未封榜读取密钥 | 空 | 可选 `x-ccs-api-key`；32–1024 个可见 ASCII 字符，不含空白，只读未封榜结果 |

例如：

```text
system/691000000000000000000001, acm/691000000000000000000002
```

两种鉴权都受这份比赛清单限制。清空清单会禁止全部比赛访问，比赛列表变为空；已经认证的调用仍能读取 API 元信息。修改密码或清单即时影响新请求，并在下一次事件流检查时生效（轮询间隔约 2 秒）。

Hydro 的密码输入框留空表示**保留原值**。停用比赛读取请清空清单；撤销某个密钥可替换为新随机值。未封榜读取密钥不会取得评测、提交或用户管理权限，但会看到封榜期间的判题结果，不应提供给公开直播软件。

可在本机生成独立密钥：

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

### 组织 ID 与直播素材

默认组织 ID 是学校名称生成的固定哈希，并非乱码。需要提前按学校简称准备 package、校徽等素材时，在 **CCS 组织 ID 映射**（`hydroCcsApi.organizationIds`）中填写：

```json
{
  "西华师范大学": "cwnu"
}
```

配置后，`organizations` 接口及 event-feed 的组织 ID 都是 `cwnu`，所属队伍的 `organization_id` 也同步为 `cwnu`；组织的 `name` / `formal_name` 仍为“西华师范大学”。可以据此提前准备使用 `cwnu` 的素材。

映射适用于所有域和比赛，按 Hydro 队伍账号的学校名称匹配；配置名称与学校名称均去除首尾空白，其余字符须一致。ID 区分大小写，须为 1–64 个英文字母、数字、下划线或连字符，不同学校不能配置相同 ID。未映射学校继续使用原哈希 ID；没有学校的队伍保持 `organization_id: null`。留空或填写 `{}` 可清除映射。

建议在准备 package、首次连接直播前完成配置。保存后在下一次数据刷新时生效；若已有事件历史，会追加旧组织删除、新组织及队伍更新事件，原 token 仍可续传。**历史事件不会改写**，因此从头读取 event-feed 仍可能先看到旧哈希 ID，再收到映射后的变更；查看当前 ID 可使用 `/organizations` 和 `/teams`。

### 学校与年级分组

默认自动复用 Hydro **比赛所在域 → 域管理 → 用户组** 中的分组，不需要在 CCS 中再配置一次名单，也无需安装 `@hydrooj/scoreboard-xcpcio`。主站管理地址为 `/domain/group`，其他域为 `/d/<域ID>/domain/group`。

在用户组中选择实际的 **Hydro 队伍账号** 即可，例如把老生队伍加入 `besti_senior`，新生队伍加入 `besti_fresh`。已有用户组可直接使用。归组按队伍账号 UID 判断，不根据团队成员账号推断；一支队伍可以属于多个组。只导出包含本场有效队伍账号的当前域用户组，不导出无关组、空组或其他域的组；与官方 XCPCIO 一致，数字类组名会被忽略，具体规则见 [API 文档](docs/API.md#域用户组与附加分组)。

用户组名称如 `besti_fresh`、`cwnu` 可直接作为 CCS 分组 ID。中文或不符合 CCS ID 格式的名称保留原显示名，ID 自动使用 `hydro-group-<用户组ObjectId>`；`participants`、`observers` 以及以 `hydro-group-` 开头的组名也使用生成 ID，避免冲突。直播端需要填写 ID 时，以 `/groups` 返回值为准。

定制榜单中显示的分组也可能由学校、入学年份等字段计算，并未存入 Hydro 用户组。这类插件可通过 [`hydro-ccs-api/groups` 扩展事件](docs/API.md#榜单插件提供分组)向 CCS 提供分组，与原榜单调用同一段规则；接入后无需另外维护用户组或填写 CCS 账号名单。正式/打星身份仍由 Hydro 比赛决定。

`participants`（正式队伍）与 `observers`（打星队伍）自动保留，学校与年级作为附加分组。例如正式新生队的 `group_ids` 为 `["participants", "besti_fresh"]`，西华师大的打星队为 `["observers", "cwnu"]`。组织 ID `CWNU` 和分组 ID `cwnu` 各自独立，不必相同。“全部队伍”由展示端不限制分组实现，无需添加一个 `all` 组。

直播端若另有 `isHidden` / `isOutOfContest` 配置，原 `participants` 保持 `false/false`，`observers` 保持 `false/true`；新增学校、年级分组使用相同 ID，设为 `false/false`。event-feed 的标准分组对象输出 `id`、`name`、`hidden`，所属关系在队伍的 `group_ids` 中。

保存用户组成员变更后，下一次请求或活动事件流轮询（约 2 秒）会同步更新 `/groups`、`/teams` 和 event-feed；最后一支本场队伍移出用户组后，该组也从当前资源中移除。可用 `/scoreboard?group_id=cwnu` 读取该组的正式榜单。默认榜和学校/年级分组榜继续排除打星队及隐藏队伍，`group_id=observers` 保留打星独立榜。历史事件及 token 保留，增删成员或分组会追加变更事件。展示端是否显示分组按钮取决于其对 `groups` 的支持及本身配置。

#### 可选的额外分组

**CCS 自定义分组（可选）**（`hydroCcsApi.groups`）可以留空；原来填写过的名单也可清空，完全改用域用户组。仅需额外按学校名称、账号或比赛范围定义分组时，填写 JSON 数组，例如 [五个分组的配置示例](examples/groups.example.json)。其中北电老生/新生的 `teams` 数组需要填入各自的队伍账号；空数组表示暂不归入任何队伍。

```json
[
  { "id": "besti_senior", "name": "北京电子科技学院老生", "teams": ["besti_old_01", "besti_old_02"] },
  { "id": "besti_fresh", "name": "北京电子科技学院新生", "teams": ["besti_new_01"] },
  { "id": "cwnu", "name": "西华师范大学", "schools": ["西华师范大学"] },
  { "id": "xju", "name": "新疆大学", "schools": ["新疆大学"] },
  { "id": "scmu", "name": "中南民族大学", "schools": ["中南民族大学"] }
]
```

示例中的 `besti_old_01` 等账号是占位示例，须换成实际 **Hydro 队伍账号用户名**（也就是 `/teams` 中的 `id`），不填队伍显示名、成员账号或组织 ID。`schools` 按队伍账号的学校名称自动匹配。若同一项同时填写 `schools` 和 `teams`，须同时满足两个条件；一支队伍可匹配多个自定义分组。名单不应将同一账号同时放入老生和新生组。

可为某个分组添加 `"contests": ["system/691000000000000000000001"]`，限定生效的域和比赛；省略则适用于所有比赛。多场比赛复用账号时，建议为年级名单限定比赛，避免旧名单影响后续比赛。

同 ID 时，依次优先使用域用户组、榜单插件提供的分组、此处手动配置。域用户组即使暂时没有本场队伍，也不会回退到旧名单。不同 ID 的手动分组继续作为补充。不能覆盖 `participants` / `observers`；留空或 `[]` 只清除手动附加分组，不关闭域用户组或榜单插件分组。

## 接口地址

| 用途 | 地址示例 |
| --- | --- |
| 主站 API 基址 | `https://hydro.example/api/ccs` |
| 域内 API 基址 | `https://hydro.example/d/acm/api/ccs` |
| 单场比赛 | `https://hydro.example/api/ccs/contests/691000000000000000000001` |
| 榜单 | 单场比赛地址加 `/scoreboard` |
| 持续事件流 | 单场比赛地址加 `/event-feed` |

比赛 ID 是 Hydro 比赛页面 URL 中的 24 位 ObjectId。域内比赛必须同时在 URL 保留 `/d/域ID`，并在白名单使用相同域 ID。

以下命令会提示输入密码，不会把密码放入 URL。Windows PowerShell 使用 `curl.exe`：

```sh
curl --fail --user ccs "https://hydro.example/api/ccs/contests"
curl --fail --user ccs "https://hydro.example/api/ccs/contests/691000000000000000000001/scoreboard"
curl --fail --no-buffer --user ccs "https://hydro.example/api/ccs/contests/691000000000000000000001/event-feed"
```

公网通过 HTTPS 访问。反向代理需要保留 `Authorization` / `x-ccs-api-key`，并关闭事件流缓冲，示例见 [Nginx 配置](examples/nginx.conf)。

## 连接直播软件

- **ICPC Live 直连**：使用 [settings.direct.example.json](examples/settings.direct.example.json)。`source.url` 填 API **基址**，`contestId` 单独填写。
- **ICPC Tools CDS**：使用 [cdsConfig.example.xml](examples/cdsConfig.example.xml)。`ccs.url` 填到 `/contests/比赛ID` 的**完整比赛资源地址**。

配置中的域名、比赛 ID、密码均为占位示例。实际部署修改私有副本，勿将真实凭据提交到仓库。经 CDS 再连接 Live 时，Live 使用 CDS 的账号和 API；CDS 使用本插件的 Basic 账号。

此接口只传比赛数据，直播画面需另行接入。直播软件可能按分钟重算罚时；精确保留 Hydro 名次时应读取 `/scoreboard` 的 `rank` 和 `x_hydro_total_seconds`，并在赛前验证同罚时、打星和重判场景。

ICPC Live 的逐测试点进度由 `runs` 数量与 `problems.test_data_count` 计算。需要 HydroJudge 在评测过程中上报测试点：`performance` 模式、重判批量上报或题目 `detail: none` 可能使测试点集中到最后才出现，或完全不提供。排查时先确认 Hydro 的评测记录中 `testCases` 会逐步增加；本插件不会根据百分比伪造测试点。很快完成的评测仍可能直接显示最终结果，详见 [部署验收](docs/DEPLOYMENT.md)。

## 从原监考插件迁移

独立版不会替换或修改已安装的 `cwnupaa-proctor-auth`，也不会自动继承它的密码、比赛清单或事件 token。

| 项目 | 原内置接口 | 本独立插件 |
| --- | --- | --- |
| API 前缀 | `/api/proctor/ccs` | `/api/ccs` |
| 设置前缀 | `cwnupaaProctor.` | `hydroCcsApi.` |
| 未封榜鉴权 | 监考评测用 API-Key | 独立 `x-ccs-api-key` |
| 日志集合 | `cwnupaa.proctor.ccs.*` | `hydro.ccs.api.*` |
| 扩展字段 | `x_proctor_*` | `x_hydro_*` |

独立部署后重新配置账号和允许清单，修改 Live/CDS 地址并清除其旧事件游标，从新事件流建立基线。若原监考平台仍使用内置接口，保留其原配置；独立插件不提供旧监考专用协议适配。

监考插件 `cwnupaa-proctor-auth 0.4.0` 已移除内置 CCS。配套新版监考 Web/Recorder 通过 HTTP 消费本插件：在 Hydro 设置比赛允许清单与 `hydroCcsApi.adminApiKey`，在 Web 和 Recorder 的服务端环境设置 `REACTION_HYDRO_CCS_ORIGIN`（仅协议、主机、端口）和 `REACTION_HYDRO_CCS_API_KEY`（同一独立读取密钥）。考试地址保留 `/d/域ID`；Recorder 使用 `x_hydro_username(s)` / `x_hydro_rank` 并单独保存新游标，不复用评测密钥。

监考侧代码、部署流程和消费测试由监考仓库维护；本插件不依赖它，也不负责录像采集或生成。旧日志不会自动导入，新日志的初始基线不能补造旧历史名次。

## 独立更新与兼容性

以后 CCS 的 API、计分、封榜、字段映射与事件日志只在本仓库修改和测试。将兼容版本部署到 Hydro **实际加载的本插件目录**并重启 Hydro，消费者通过 HTTP 重连即可，不需要把源码复制回监考仓库，也不需要重新构建监考客户端。

1.x 保持现有路径、鉴权、事件与扩展字段含义兼容；新增可选字段/资源不要求消费者同步升级。删除或重命名必需字段、改变鉴权/事件含义等不兼容变更应发布主版本，并给出消费端迁移说明。兼容升级保留日志 scope 和现有 token，除非明确发布日志迁移步骤。

更新前备份配置和两套日志集合，先在测试比赛验证；部署后确认 API 元信息版本、续传、Basic 封榜和未封榜读取正常。数据库日志不随源码包覆盖，详见 [部署验收](docs/DEPLOYMENT.md)。

## 开发与验证

```sh
npm ci --ignore-scripts
npm run check
npm pack --dry-run
```

`npm run check` 包含插件类型检查、隔离 Hydro/Mongo 模型回归、本地真实 HTTP/NDJSON 传输，以及 Hydro 5.1 实际设置注册器测试。测试不启动生产 Hydro、不连接真实数据库。

Hydro 分发的是 TypeScript 源码，并使用非严格编译选项。本插件使用自己的严格配置检查自身源码，同时从已安装 Hydro 读取真实 API 类型；类型检查脚本不把宿主源码作为本插件的严格检查对象。

本仓库包含 [GitHub Actions](.github/workflows/ci.yml)，在 Node.js 22/24 上执行安装、类型检查、测试和打包检查。当前验证范围不等同于真实 Hydro/Mongo 部署验收；上线前按 [验收步骤](docs/DEPLOYMENT.md) 检查实际服务器。

## 仓库与分发

源码与问题反馈：[pppolf/hydro-ccs-api](https://github.com/pppolf/hydro-ccs-api)。可用 `npm pack` 生成可安装的源码包；不需要发布到 npm 才能作为 Hydro 本地插件使用。

## License

[MIT](LICENSE)。Hydro 及开发依赖各自的许可证保持不变。
