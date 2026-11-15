# Installation identity lifecycle — audit + fresh-install fixture (Task 4)

> 状态：**已审计（2026-11-15）**，配套 fixture：`apps/zcode-cli/tools/reset-install-state/`。
> 目的：测试环境里对「安装身份」做确定性控制——把被测机器恢复到真正的 first-launch 状态，
> 以便稳定测试 onboarding / registration / grant issuance；同时回答「卸载后到底剩什么」。

## 1. 结论速览

一次全新安装涉及三层身份：

| 层 | 身份 | 生成时机 | 存储 |
| --- | --- | --- | --- |
| 安装/设备身份 | `deviceMid`（纯随机 UUID，无机器派生） | 首次模型请求（anthropic metadata）或 OTLP 启用时的 telemetry 准备 | `$ZCODE_DATA_BASE_DIR/.zcode/v2/telemetry-state.json` |
| 账号身份（registration/grant） | OAuth 登录：`user_id`（zai）或 组织+项目摘要（bigmodel） | `zcode login` 浏览器授权完成时 | `~/.zcode/v2/credentials.json`（加密）+ `~/.zcode/v2/provider_config.json` |
| 凭据加密密钥 | 32 字节随机密钥 | 首次写入凭据（或 keyring 首建） | OS keyring 条目或同目录 `credential-secret` 文件 |

**卸载后仍然残留（测试卫生 bug 的根源）**，按「`rm -rf ~/.zcode` 也删不掉」排序：

1. **OS keyring 条目**：service `ZCode Credential Encryption`，account = `sha256(credentials.json 绝对路径).hex()`。
   代码只提供 `get/set`，**没有任何路径删除它**（`logoutZCodeCli` 只清 JSON 内的 key）。
   macOS = Keychain，Linux = Secret Service（D-Bus），Windows = Credential Manager。
2. **legacy `enc:v1:` 派生密钥**：`sha256("zcode-credential-fallback:{platform}:{homedir}:{username}")` ——
   机器属性派生，只要 homedir/username/platform 不变，任何历史 v1 密文永远可解。
3. **重定位出的第二数据根**：`$ZCODE_DATA_BASE_DIR/.zcode`（以及 `~/.zcode/cli/config.json` 的
   `storage.dir` 指向的第三根）——fixture 只清 HOME 会漏。
4. **项目级状态**：cwd 里的 `.zcode/` 项目配置、`.env`（dotenv 注入 provider 配置）——复用脏 cwd 的 fixture 会漏。
5. **`ZCODE_HOME` / `ZCODE_DATA_BASE_DIR` 双轴不一致**（见 §2.3）——两个 env 控制同一个
   telemetry-state.json，fixture 只设其一可能读到/留下另一份旧 deviceMid。

CLI 本身**没有 uninstall 命令**（`rg uninstall apps/zcode-cli` 无命中）；卸载=删二进制，数据根全保留。

## 2. deviceMid（安装/设备身份）

### 2.1 生成与落盘

- 生成函数 `createUuid()`（`packages/shared/src/uuid.ts`）= `crypto.randomUUID()`（或随机字节 v4 回退）。
  **纯随机，不含任何机器指纹**——干净机器必然得到新 ID，这是 fixture 可行的基础。
- 两个创建入口，写同一个状态文件（`{ "deviceMid": "<uuid>" }`）：
  - `apps/zcode-cli/packages/adapters/src/device/cli-device-mid.ts` `ensureCliDeviceMid()` ——
    首次 anthropic-kind 模型请求组装 `metadata.user_id` 时（`anthropic-request-metadata.ts`）。
    文件系统失败不阻断请求（进程内回退一次性 UUID）。
  - `apps/zcode-cli/packages/telemetry/src/bootstrap.ts` `prepareModelTelemetryEnv()` ——
    OTLP endpoint 已配置时准备匿名身份。
- 并发安全：`telemetry-state.lock`（wx 排他 + 5 min 陈旧回收），临时文件 + rename 原子写。

### 2.2 消费方（为什么它影响测试）

- Anthropic 请求 `metadata.user_id = {"device_id": deviceMid, "account_uuid": "", "session_id": ...}`
  （`adapters/src/model/anthropic-request-metadata.ts`；脱敏入口 `redactAnthropicRequestMetadata`）。
- OTLP telemetry resource `installationId`（`telemetry/src/bootstrap.ts`，env 名 `ZCODE_TELEMETRY_DEVICE_MID`）。
- feedback / provider 请求头（`cli-device-mid.ts` 文件头注释）。
- `X-Device-Mid` 请求头（ZCode endpoint 的已认证请求，「有值才带」）：provider-endpoint-routing 配置
  GET（`packages/shared/src/zcode-source-headers.ts:57` `buildZCodeSourceHeadersFromContext`；CLI 装配在
  `bootstrap/src/provider-endpoint-routing-source-headers.ts:28-35`）；billing/balance——该端点服务端把它当
  **必填**，缺失返回 `400 {"code":3001,"msg":"parameter error"}`（`packages/server/src/stdioDeviceMid.ts:14`、
  `docs/zai-start-plan-provider.md:65`），因此远端 server / services 会在启动时确保 deviceMid 已落盘。
- **勘误（2026-11-15 审计补充）**：deviceMid 并非只到 Anthropic/OTLP。coding-plan 模型流量本身就是
  anthropic-messages 协议，`metadata.user_id.device_id` 原样随请求发出；其中 Start Plan 的 baseUrl 就是
  `https://zcode.z.ai/api/v1/zcode-plan/anthropic`（`packages/shared/src/zcodeEndpoint.ts:382`，catalog
  `account:zai-start-plan`）——即 deviceMid 经模型请求直达 ZCode 生产后端（Individual Plan 走
  `api.z.ai/api/anthropic`，同样携带）。叠加上述 `X-Device-Mid` 信道：grant 签发后，服务端可把设备身份
  **事后归因**到账号（见 §3.1 定论）。

### 2.3 双轴不一致（审计发现，fixture 必须双设）

| 入口 | env | 路径拼法 |
| --- | --- | --- |
| `cli-device-mid.ts` | `ZCODE_DATA_BASE_DIR`（缺省 homedir） | `join(base, ".zcode", "v2", "telemetry-state.json")` |
| `telemetry/src/bootstrap.ts` | `ZCODE_HOME`（缺省 homedir） | `join(home, "v2", "telemetry-state.json")` |

即 `ZCODE_HOME` 指 `.zcode` 目录本身、`ZCODE_DATA_BASE_DIR` 指其父目录。只设其一的进程可能
在另一处留下/读到旧 deviceMid。**fixture 规则：`ZCODE_DATA_BASE_DIR=$base` 且 `ZCODE_HOME=$base/.zcode` 成对设置。**

## 3. Registration / grant issuance（账号身份）

实况（`bootstrap/src/auth-login.ts` + `adapters/src/auth/cli-oauth.ts`）：

```text
POST {apiBase}/oauth/cli/init     Body {"provider":"zai"}   Authorization: Bearer <pollToken:32B随机>
  → {"authorize_url","flow_id","expires_at","poll_interval_sec"}     ← 服务端登记登录流（grant 发起）
浏览器打开 authorize_url，用户登录/授权
GET  {apiBase}/oauth/cli/poll/{flow_id}   同一 Bearer pollToken
  → {"status":"pending"} … {"status":"ready","token","user","accessToken","refreshToken"}   ← grant 签发
```

- 生产端点 `https://zcode.z.ai`（`apiBaseUrl = origin + /api/v1`），覆盖项：
  `ZCODE_BASE_URL` / `ZCODE_ENDPOINT_ORIGIN` / `ZCODE_PRODUCTION_BASE_URL` / `ZCODE_TEST_BASE_URL`，
  `ZCODE_ENV=test` 切 test 域（`packages/shared/src/zcodeEndpoint.ts`）。
- **ready 才落盘**：`credentials.json`（整组替换写入，见 §4 加密）+ `provider_config.json`
  （personal providers + 默认模型，`persistStandaloneCodingPlanConnection`）+ 连接身份
  （zai: `user.user_id`；bigmodel: org/project 摘要）。**init 后放弃（timeout/abort）不写任何文件。**
- 登录态判定：`hasConfiguredStandaloneCodingPlan()`（bootstrap 导出）——fresh 机器 = false，
  可作为 fixture 的「未注册」断言。
- 退出：`logoutZCodeCli()` 只删 credentials.json 里的 key（**不动 keyring、不动 provider_config.json、
  不动 telemetry-state.json**）。

### 3.1 grant issuance 的身份锚点（定论，2026-11-15 补全）

服务器以 **OAuth 账号 `user_id`** 作为 grant 归属；deviceMid 不参与 grant 签发：

- init 只发送 `{"provider":"zai"}` + 随机 32B pollToken（`cli-oauth.ts:84-98,123-125`），无任何设备身份；
- 授权回调 `/api/v1/oauth/cli/callback/<provider>` 来自授权页背后的**已登录浏览器会话**——grant 的主体
  就是该账号；poll ready 返回 `user.user_id`，登录尾将其存为连接身份（`auth-login.ts:136-141`）；
  `docs/zcode-login-rework.md:162` 亦把 `user.user_id` 定为「会话、设备、权限和资产归属」的 canonical subject。
- deviceMid 只在**后续**已认证请求上作事后归因（`X-Device-Mid` 头与 `metadata.user_id.device_id`，§2.2）；
  keyring 凭据加密密钥纯本地（§4），从不出机。

Fixture 含义：**同账号重装（deviceMid、cipher key 全换）= 同一 grant 身份**；要验证「新主体首次
grant 签发」的 fresh-install 测试必须**换新账号**，仅 reset 本机状态不够。本定论依据上列线上协议
证据；`src/verify-live-cycle.ts`（双 fixture 同账号交叉验证）是为它设计的实证实验，截至
2026-11-15 尚未执行。

## 4. 凭据加密密钥（`packages/shared/src/credential-security/systemCredentialCipher.ts`）

- 密文格式：`enc:v2:{os|env}:{24hex密钥指纹}:{iv.tag.payload(base64url)}`，AES-256-GCM。
- **os 来源**：`@napi-rs/keyring` `AsyncEntry("ZCode Credential Encryption", sha256(credentials.json 绝对路径).hex())`。
  密钥按**凭据文件路径**区分；`credential-source` 标记文件（内容 `os\n`）把目录钉死在 os 来源。
- **env 来源**（headless/无 keyring）：`ZCODE_CREDENTIAL_SECRET` 或同目录 `credential-secret`
  文件（0600、32–4096 字节）。两者配了会拒绝（`unavailable()`）。
- **headless Linux 陷阱**：无 Secret Service 时，CLI 首次登录在 `assertWritable()` 即失败
  （`CREDENTIAL_SECURE_STORAGE_UNAVAILABLE`；Linux 桌面的 private-file 回退不适用独立 CLI）。
  fixture 的干净机器等价做法：**每次注入全新随机的 `ZCODE_CREDENTIAL_SECRET`**（相当于干净 keychain）。
- legacy `enc:v1:`：密钥 = 机器属性派生（§1.2），仅作历史兼容读取。

## 5. 完整持久化地图（`.zcode` 数据根内）

依据 `docs/settings-storage-management.md`（2026-09-10 普查）+ 本审计：

```text
$ZCODE_DATA_BASE_DIR(默认 ~)/.zcode/
├── cli/config.json            用户配置（theme/locale/hooks/MCP/插件/storage.dir 重定位）
├── cli/db/db.sqlite           CLI 会话/任务库
├── cli/{debug,rollout}/       模型调用轨迹 model-io（硬编码 homedir）
├── cli/{agents,exec,plugins,artifacts,image-cache,models,memories,workflows,commands,skills,sessions,log}/
├── v2/credentials.json        加密凭据（registration 产物）
├── v2/credential-secret       env 来源密钥文件（headless）
├── v2/credential-source       os 来源钉死标记
├── v2/provider_config.json    personal providers + 默认模型（registration 产物）
├── v2/telemetry-state.json    deviceMid（+ telemetry-state.lock）
├── v2/setting.json            app 设置（刻意永远真实 HOME）
├── v2/{sessions,session-bindings,checkpoints,logs,crash,migrations,backup,*.sqlite*}
├── backup/ lite/ bundled-agents/ agents/ computer-use/ export-log*/ feedback/ logs/ security/ workspace/
└── （首启动态产物：上述 v2/ 与 cli/ 大部分在首次使用时才创建）
```

`.zcode` 之外、且随「卸载」存活的状态：§1 列表（keyring 条目、v1 派生密钥、重定位根、项目级状态）。

## 6. Fixture：`tools/reset-install-state/reset-install-state.sh`

```bash
# 干跑（默认）——只列出会发生什么
reset-install-state.sh [--base-dir DIR] [--project-dir DIR] [--purge-keyring]
# 真正执行
reset-install-state.sh --apply [同上]
```

- `--base-dir DIR`：含 `.zcode` 的目录（默认 `$ZCODE_DATA_BASE_DIR` 或 `$HOME`）。删除整棵 `<DIR>/.zcode`。
- `--purge-keyring`：尽力删除已知凭据路径（HOME 根与目标根）的 keyring 条目（经 `@napi-rs/keyring`，
  无 Secret Service/Keychain 时报告 skipped，不算失败）。默认**不**动 keyring（跨测试机共享的 keychain 不该被脚本顺手清掉）。
- `--project-dir DIR`：清理 cwd 级状态（`$DIR/.zcode`；`.env` 只报告不删——可能含真实密钥）。
- 安全护栏：拒绝解析到 `/` 的目标；dry-run 默认；`ZCODE_DATA_BASE_DIR` 指向别处时显式告警第二数据根。

## 7. 验证：`tools/reset-install-state/src/verify-fresh-registration.ts`

1. **reset 证明**：seed 一个「用过」的状态（stale deviceMid、伪 credentials.json、provider_config.json、
   cli/config.json、credential-source/secret）→ 跑 reset 脚本 `--apply` → 断言全灭 + 幂等重跑安全。
2. **干净机器身份证明**：reset 后经产品路径（`prepareModelTelemetryEnv`，双 env 轴成对注入 +
   本地 OTLP sink）生成 deviceMid A；再 reset 再生成 → deviceMid B ≠ A（全新安装=全新随机身份）。
3. **fresh 门控证明**：`hasConfiguredStandaloneCodingPlan() === false`（未注册态）。
4. **live registration**（对生产 `https://zcode.z.ai`）：注入全新 `ZCODE_CREDENTIAL_SECRET`（headless
   干净 keychain 等价）后调 `loginZCodeCli({noBrowser:true})`：
   - `onAuthorizeUrl` 拿到真实 `authorize_url` + `flow_id`（服务端已登记登录流=grant 发起）；
   - `onPollStatus` 观察到 live `pending`（无人在浏览器授权，符合预期）；
   - 窗口到期抛 `auth_timeout`；**无任何凭据落盘**（init-放弃不留痕，§3）。
   - authorize_url 打印出来：真人浏览器完成授权即可验证 grant 签发最后一公里。
5. 全部断言通过输出 `verdict: pass` 并退出码 0。

阶段 4 保持原样：它是**无真人**的 in-loop smoke（init + live pending + `auth_timeout` 预期、零落盘）。
要验证 grant 真正签发的最后一公里，用 §7.1 的两阶段驱动。

### 7.1 两阶段 live registration：`src/register-live.ts`（2026-11-15 新增）

phase1 / phase2 是两个独立进程，人在中间完成浏览器授权；phase1 结束后立即退出（不轮询），
phase2 仅凭 state.json 复跑同一 flow：

```bash
# phase 1：reset --apply + 生产 init（https://zcode.z.ai，无 endpoint 覆盖）。
#   打印 authorize_url / flow_id / expires_at 后退出；state（0600）保存 poll_token / flow_id /
#   credential_secret / base_dir——credential_secret 必须跨阶段一致，否则 phase2 解密失败（§4）。
tsx src/register-live.ts phase1                        # state 缺省 tools/reset-install-state/runs/live-flow/state.json
tsx src/register-live.ts phase1 --state-file=PATH [--base-dir=DIR]
# 人：用已登录 z.ai 账号的浏览器打开 authorize_url 完成授权
# phase 2：同一 flow 复轮询（pending → ready；3004/超窗 = 过期）→ 复刻 loginZCodeCli 落盘尾
#          （saveZaiLoginCredentials + account-provider:*:identity/auth-source + 默认模型 provider_config.json）
#          → 断言（credentials.json 落盘、hasConfiguredStandaloneCodingPlan === true、identity 读回一致）
#          → grant 探针（resolveMaterial，信息性、永不致命，只打印指纹不打印 key）→ 输出 {verdict,...} JSON
tsx src/register-live.ts phase2 --state-file=PATH [--poll-deadline-ms=N]
```

- 退出码：0 成功 / `already-registered`（credentials 已存在且 plan 门控为真，幂等重跑）；2 用法或 state
  校验失败；3 poll `failed`；4 flow 过期（信封 3004/等价）——重跑 phase1 拿新 URL；1 其余失败。
- 依赖 state.json 而非内存：sandbox 回收后重跑 phase2 仍可续（同一 base_dir 重物化 provider runtime env）。

另有 `src/verify-live-cycle.ts`：单进程全周期 certifier（两个独立 fixture × 同一账号交叉验证 +
localhost 授权控制台），适用于真人在场、可打开控制台页面的场景；截至 2026-11-15 未执行，
作为 §7.1 两阶段路径的备选，不作为定论依据。

### 7.2 生产运行记录（2026-11-15）

两轮完整 phase1→phase2 周期对生产 `https://zcode.z.ai` 执行（每轮独立 5 min 授权窗口，窗口内无人
完成浏览器授权）：

- phase1：pristine fixture base 上 `reset --apply` → live init 成功——服务端签发真实
  `authorize_url` + `flow_id` + `expires_at`（约 5 min 有效），live `pending` 轮询观测正常；
- phase2：`pre-registration gating PASS`（`hasConfiguredStandaloneCodingPlan === false` 贯穿全程）→
  纯 `pending` 直到流过期，退出码 4（符合设计）；
- **残留审计**（两轮过期后）：`base/.zcode` 内**仅有**
  `v2/runtime/provider/linux-x86_64/0.0.0-dev/endpoint-<hash>/zcode-builtin.json`——builtin provider
  catalog 缓存（endpoint 拉取、非身份产物）；`credentials.json` / `provider_config.json` /
  `telemetry-state.json`（deviceMid）全部不存在。§3 的「init 放弃不写任何**凭据/身份**文件」实证成立；
  catalog cache 是唯一残留，且会被 reset 一并清除（删整棵 `.zcode`），不影响 fresh-install 语义；
- 全周期绿灯路径唯一缺失输入 = 真人在 5 min 窗口内完成 `authorize_url` 授权（两轮窗口无人值守
  过期，非 fixture 缺陷）。

## 8. 建议的后续（非本任务范围）

- `zcode logout --purge` 或卸载脚本补 keyring 条目删除（`CredentialKeyStore` 增加 `delete`）。
- 统一 `ZCODE_HOME` / `ZCODE_DATA_BASE_DIR` 双轴为单一解析器。
- CI fixture 约定：`reset-install-state.sh --apply` + 成对 env + 全新 `ZCODE_CREDENTIAL_SECRET`。
