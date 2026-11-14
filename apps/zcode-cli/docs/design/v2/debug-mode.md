# ZCODE_DEBUG_MODE（配额/限流韧性开关）

`ZCODE_DEBUG_MODE=1|true|on`（默认关闭）是**本机开发与自动化测试**专用的单变量韧性开关：让 CLI 把限流/配额类失败当作「使用窗口刚重置」——患者探测、永不本地停摆、压下限额警告面。目标场景是自动化测试套件在同一台机器上连续跑多轮迭代，不被窗口/账单状态打断。

- 优先级：env 是**最后手段**（AGENTS.md 规则）。本开关是刻意的一次性例外：它必须对被测进程**全局**生效（runner、治理器、driver、文案四处同读），config 文件 / CLI 参数 / session 配置都只能覆盖一部分装配层。
- 解析：`packages/shared/src/runtimeEnv.ts` 的 `isZCodeDebugModeEnabled`（"1"/"true"/"on"，其余一律 false，含未设置）。各层经 DI 的 env（runner 用 `input.env`、治理器单例默认 `process.env`）读一次。
- 命名：与 `ZCODE_DEBUG`（desktop 主进程 inspect-brk 端口号，`packages/shared/src/env.ts`）不同名、不同义，二者互不影响。

## 目标

1. **配额类停止改走患者探测**（预算豁免，不是激进 10 连试，也不是无节制的无限重驱）：
   - runner（generate/stream 两条路径 + SSE 错误块 + 自然 EOF 的隐藏业务错误）：配额类失败不消耗 `Default`（10 次）重试预算，原地无限重试；间隔走患者升梯。
   - driver（workflow）：策略表判 `stop(kind: quota)` 时不再 `stopRun`，改在同一持久 runtime 上按同一升梯患者重驱（覆盖 runner 无法原地重试的路径，如 SSE 可见输出边界后的失败）。
   - 升梯（两处同一条曲线，`adapters/src/model/debug-quota-retry.ts` 的 `debugQuotaProbeDelayMs`）：第 1 次失败等 60s（与 off-peak 无 Retry-After 的保守探测同值），此后 10min→20min→40min→1h 封顶（与 `dynamic-workflow-quota-resume.ts` 的反热环间距同族）。**Retry-After 不参与间隔**：配额 429 的 Retry-After 常指向额度窗口结束（可达数小时），照它等待就探测不出「窗口内服务端是否放行」。
   - 判定（`isDebugQuotaStopFailure`）：配额业务码（与 workflow 策略表同一张 `WORKFLOW_QUOTA_PROVIDER_CODES`）**或** `reason === rate_limited`（覆盖主对话表的终止映射码与预算耗尽的裸 429）。auth / invalid_request / 5xx / 网络错误不受影响。off-peak 协议在时让位（它有自己的排队探测与过号语义）。
2. **绕过 workflow 并发治理器的 429 冷却冻结**（`workflow-concurrency-governor.ts`）：限流类信号不再携带 Retry-After 进控制器（控制器带 `undefined` 就不设冷却，`concurrency.ts` 的 `throttled`），闸门不再被长达额度窗口的冷却冻住、子代理不再在闸门上饿死。cap 的 AIMD 降半/回退/恢复语义照旧。
3. **压下限额警告面**（只限下列几处，其余 UI 逐字不变）：
   - `core/src/runtime-task/workflow-notification-copy.ts` 的 `quota` 文案（终态通知与 GetWorkflowRun 共用）：不再出现「额度用尽/上限已到」「将于 … 重置」「充值或升级」，换中性两句。
   - `core/src/runtime-task/notification.ts` 的 `autoResumesAfterReset` 指引句。
   - `core/src/runtime/methods/turn.ts`：限流类 TurnError 不再把输入队列切成 error-paused（排队输入继续进下一轮）。
   - TUI（`tui/src/app-events.ts`）：限流类 TurnError 不追加转写错误行、不清空排队输入显示（与 runtime 侧同步，避免显示层先清空仍在跑的队列）；状态行（「turn failed」）保留。
   - 保留项：`model_retry_scheduled` 状态行（患者探测的进行时反馈）与 workflow stall 通知（其文案本就说明「仍在跑、无需动作」，是防误操作的指引，不是限额警告）。

## 非目标

- **不绕过任何服务端配额**：探测的请求仍会撞 429/配额码并被服务端拒绝；本开关只改变客户端对这类失败的**反应**。
- 不修改分类表本身（terminal vs retryable 的映射与 workflow 策略表逐字保留）；`failure-provider-business-codes.ts`、`workflow-model-failure-policy.ts` 一字不动。
- 不改变 off-peak 排队协议（3105 排队探测 / 3102、3106 过号标记）与 Start-Plan busy 的语义。
- 不适用于生产 CLI 的普通使用：患者探测会让被限额的会话「看起来挂着」而不是尽快交还控制权。

## 错误行为

- flag off（未设置 / 0 / false / off / 任意其它值）：以上所有路径逐字走默认行为（停止、冻结、警告、error-paused 队列）。回归由既有测试套件 + 本 spec 的 off 回归用例共同钉住。
- flag on 时取消/中止语义不变：患者探测的等待仍尊重 abort signal（与 off-peak 排队等待同一条取消路径）；run 级 stall 时钟照常播报「仍在跑」。
- driver 患者重驱的退场条件与瞬态重驱完全一致（disposed / cancelled / accepted / abort / 换 instance）。

## 测试覆盖

- `adapters/tests/debug-quota-retry.test.ts`：升梯数值、判定真值表、generate/stream 两路径的预算豁免（失败次数远超 `maxAttempts` 仍探测直至成功）、flag off 时配额终止与预算约束的回归。
- `bootstrap/tests/workflow-concurrency-governor.test.ts`：flag on 时 429+Retry-After 不冻结准入（cap 仍降）、flag off 回归。
- 30 次连续调用 harness（`apps/zcode-cli/tools/debug-mode-harness/`）：验证无限制相关的停摆并逐调用记录结局（success / quota-stop / retry），报告「限额触发后的成功率」。
