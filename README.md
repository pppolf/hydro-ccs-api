# Hydro CCS API

为 Hydro 原生 XCPC 比赛提供独立的只读 [ICPC Contest API 2023-06](https://ccs-specs.icpc.io/2023-06/contest_api)。可作为 ICPC Live、ICPC Tools CDS 等软件的比赛数据源。

本插件只依赖 Hydro 宿主与 Node.js 内置模块，具有独立配置、鉴权和事件日志。无需安装监考平台、桌面客户端、视频服务或其他 CCS 插件。

## 支持范围

- Hydro 原生 `acm`（XCPC）比赛，固定开赛和结束时间。
- 比赛、状态、队伍、分组、学校、题目、语言、提交、判题与榜单资源。
- NDJSON 持续事件流、历史回放、`since_token` 断线续传。
- 直播视图遵守封榜；可选的独立只读密钥读取未封榜视图。
- 主站与域内比赛隔离，全部比赛访问受显式白名单限制。
- Hydro 秒级罚时、团队成员提交归属、打星分组和气球颜色。

当前不支持 OI/IOI 或个人计时的 `duration` 比赛。不提供写操作、选手代码、测试点、编译日志、题目包、`runs`、`clarifications`、`awards` 或视频流。这是 Contest API 的一个只读子集，完整资源与兼容边界见 [API 文档](docs/API.md)。

## 环境

- Hydro **5.1.x**：当前使用 5.1.0 的真实 API 类型和设置注册器验证；其他版本需自行验证。
- Node.js **24 LTS**，或 22.18.0 及以上的 22.x。开发依赖也要求此范围。
- 使用 Hydro 已有 MongoDB；无需单独数据库或副本集事务。

## 安装

将本仓库下载或克隆到 Hydro 服务可以读取的目录。例如仓库发布后，将下面的 `<owner>` 替换为实际 GitHub 用户或组织：

```sh
git clone https://github.com/<owner>/hydro-ccs-api.git /opt/hydro-ccs-api
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
| CCS 未封榜读取密钥 | 空 | 可选 `x-ccs-api-key`；32–1024 字符，只读未封榜结果 |

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

## 开发与验证

```sh
npm ci --ignore-scripts
npm run check
npm pack --dry-run
```

`npm run check` 包含插件类型检查、隔离 Hydro/Mongo 模型回归、本地真实 HTTP/NDJSON 传输，以及 Hydro 5.1 实际设置注册器测试。测试不启动生产 Hydro、不连接真实数据库。

Hydro 分发的是 TypeScript 源码，并使用非严格编译选项。本插件使用自己的严格配置检查自身源码，同时从已安装 Hydro 读取真实 API 类型；类型检查脚本不把宿主源码作为本插件的严格检查对象。

本仓库包含 [GitHub Actions](.github/workflows/ci.yml)，在 Node.js 22/24 上执行安装、类型检查、测试和打包检查。当前验证范围不等同于真实 Hydro/Mongo 部署验收；上线前按 [验收步骤](docs/DEPLOYMENT.md) 检查实际服务器。

## 发布到 GitHub

在 GitHub 创建空仓库后，关联该目录的独立 Git 仓库并推送：

```sh
git remote add origin https://github.com/<owner>/hydro-ccs-api.git
git push -u origin main
```

可用 `npm pack` 生成可安装的源码包；不需要发布到 npm 才能作为 Hydro 本地插件使用。

## License

[MIT](LICENSE)。Hydro 及开发依赖各自的许可证保持不变。
