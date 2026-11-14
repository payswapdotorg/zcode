// ============================================================
// AgentRuntime-backed WorkflowDriver：模型侧失败的收容
// ============================================================
// workflow-driver.ts 顶到 oxlint max-lines 上限（400 行），把 turn 被拒时对模型侧错误的
// 收容（策略表判 stop → 整个 run
// stopped(provider)；context_exceeded → 节点 ContextLimit 失败；retry / cancelled → 退避重驱）
// 拆到本文件。自由函数经 {@link ModelFailureHost} 读 driver 的依赖与 sink、回调 runTurn；私有状态
// 不外露。常量与纯辅助（退避曲线、Retry-After 读取、称呼）住在 workflow-driver-helpers.ts。

import {
  debugQuotaProbeDelayMs,
  inspectWorkflowModelFailure,
  type WorkflowModelFailureInspection,
} from "@zcode/adapters/model";
import {
  refToString,
  WorkflowError,
  type InstanceRef,
  type ProviderStopDetails,
  type WorkflowReportSink,
} from "@zcode/dynamic-workflow";
import {
  PROVIDER_STOP_RAW_MESSAGE_MAX_CHARS,
  TRANSIENT_CONTINUE_PROMPT,
  defaultSchedule,
  readRetryAfterMs,
  subagentLabel,
  transientBackoffMs,
} from "./workflow-driver-helpers.js";
import type { AgentRuntimeWorkflowDriverDeps, SessionState } from "./workflow-driver-types.js";

/** driver 交给收容逻辑的宿主面：依赖、sink、是否已 dispose、以及在同一会话上再起一轮 turn。 */
export interface ModelFailureHost {
  readonly deps: Pick<AgentRuntimeWorkflowDriverDeps, "clock" | "logger" | "runId" | "debugMode">;
  readonly sink: WorkflowReportSink;
  isDisposed(): boolean;
  runTurn(state: SessionState, instance: InstanceRef, input: string, epilogueStart: number): void;
}

/**
 * turn 被拒时的模型侧收容：driver 与 runner 读同一张策略表。返回 `false` 表示这不是模型层错误
 * （inspect 返回 undefined），调用方按 driver 侧失败处理；返回 `true` 表示已按策略处置。
 */
export function handleModelTurnFailure(
  host: ModelFailureHost,
  state: SessionState,
  instance: InstanceRef,
  error: unknown,
): boolean {
  const inspected = inspectWorkflowModelFailure(error);
  if (inspected === undefined) return false;
  switch (inspected.policy.decision) {
    case "stop":
      // ZCODE_DEBUG_MODE：配额类停止不再停下 run——改走患者重驱（与 runner 的探测曲线同一条，
      // 60s→10min→1h，预算豁免在 runner 侧已尽过）。覆盖 runner 无法原地重试的路径
      // （如 SSE 可见输出边界后的失败）；flag off 时逐字走 stopRun。
      if (inspected.policy.kind === "quota" && host.deps.debugMode === true) {
        scheduleDebugQuotaRedrive(host, state, instance, inspected);
        return true;
      }
      // 确定性的模型侧错误：整个 run 停下（stopped(provider)，可恢复），不结算节点。
      host.sink.stopRun(providerStopError(state, inspected, error));
      return true;
    case "context_exceeded":
      // core 已压缩失败：ask 本身太大，是脚本之错——节点以 ContextLimit 失败，脚本可 catch。
      host.sink.askFailed(
        instance,
        new WorkflowError(
          "ContextLimit",
          `Subagent ${subagentLabel(state)} exceeded the model's context window even after ` +
            `compaction. Give this ask a smaller input or split the work across subagents.`,
          { cause: error },
        ),
      );
      return true;
    default:
      // retry / cancelled：runner 放过来的瞬态失败（流恢复耗尽等）——
      // 与 runner 的退避同一条曲线，等完再起一轮续跑，只有 cancel 能结束它。
      scheduleTransientRedrive(host, state, instance, inspected, error);
      return true;
  }
}

/**
 * 瞬态失败的 driver 侧重驱：per-ask 计数、2s→60s 抖动退避（Retry-After 优先）、先报一条
 * `askWaiting(backoff)` 再等、等待期间尊重取消、然后在同一持久 runtime 上发一轮续跑 turn
 * （与 nudge 同一机制）。无上限——run 级 stall 时钟负责让人知道它在等。
 */
function scheduleTransientRedrive(
  host: ModelFailureHost,
  state: SessionState,
  instance: InstanceRef,
  inspected: WorkflowModelFailureInspection,
  error: unknown,
): void {
  state.transientAttempts += 1;
  const attempt = state.transientAttempts;
  const retryAfterMs = readRetryAfterMs(error);
  const delayMs = retryAfterMs ?? transientBackoffMs(attempt, host.deps.clock?.random);
  host.sink.askWaiting(instance, {
    cause: "backoff",
    reason: inspected.reason,
    attempt,
    delayMs,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
  host.deps.logger?.warn?.("Dynamic workflow subagent turn failed transiently; redriving", {
    attempt,
    delayMs,
    event: "dynamic_workflow.ask.transient_redrive",
    instance: refToString(instance),
    module: "bootstrap.app",
    reason: inspected.reason,
    runId: host.deps.runId ?? "run",
  });
  const schedule = host.deps.clock?.schedule ?? defaultSchedule;
  state.cancelRedrive?.();
  state.cancelRedrive = schedule(() => {
    state.cancelRedrive = undefined;
    // 等待期间 ask 被取消 / 结算 / 换人：这轮续跑没有听众了。
    if (
      host.isDisposed() ||
      state.cancelled ||
      state.accepted ||
      state.abortController?.signal.aborted === true ||
      state.currentInstance === undefined ||
      refToString(state.currentInstance) !== refToString(instance)
    ) {
      return;
    }
    host.runTurn(state, instance, TRANSIENT_CONTINUE_PROMPT, 0);
  }, delayMs);
}

/**
 * ZCODE_DEBUG_MODE 的配额患者重驱：与瞬态重驱同机制（askWaiting → 等待 → 尊重取消 →
 * 同一 runtime 续跑），但间隔用与 runner 同源的 60s→10min→…→1h 升梯
 * （{@link debugQuotaProbeDelayMs}，见 adapters 的 debug-quota-retry.ts），且**不读
 * Retry-After**（配额 429 的 Retry-After 常指向额度窗口结束，照它等待就探测不出窗口内
 * 是否放行）。per-ask 计数（`debugQuotaRedrives`，startAsk 归零）。反热环：连续配额停止
 * 越多间隔越长，上限 1h——run 永远活着，但不敲打端点。
 */
function scheduleDebugQuotaRedrive(
  host: ModelFailureHost,
  state: SessionState,
  instance: InstanceRef,
  inspected: WorkflowModelFailureInspection,
): void {
  state.debugQuotaRedrives += 1;
  const attempt = state.debugQuotaRedrives;
  const delayMs = debugQuotaProbeDelayMs(attempt);
  host.sink.askWaiting(instance, {
    cause: "backoff",
    reason: inspected.reason,
    attempt,
    delayMs,
  });
  host.deps.logger?.warn?.(
    "Dynamic workflow subagent hit a quota stop in debug mode; patient redrive",
    {
      attempt,
      delayMs,
      event: "dynamic_workflow.ask.debug_quota_redrive",
      instance: refToString(instance),
      module: "bootstrap.app",
      reason: inspected.reason,
      runId: host.deps.runId ?? "run",
    },
  );
  const schedule = host.deps.clock?.schedule ?? defaultSchedule;
  state.cancelRedrive?.();
  state.cancelRedrive = schedule(() => {
    state.cancelRedrive = undefined;
    // 与瞬态重驱同一批退场条件：等待期间 ask 被取消 / 结算 / 换人。
    if (
      host.isDisposed() ||
      state.cancelled ||
      state.accepted ||
      state.abortController?.signal.aborted === true ||
      state.currentInstance === undefined ||
      refToString(state.currentInstance) !== refToString(instance)
    ) {
      return;
    }
    host.runTurn(state, instance, TRANSIENT_CONTINUE_PROMPT, 0);
  }, delayMs);
}

/** `ProviderStop` 错误：策略表判 stop 的模型侧错误 + 通知文案要的结构化明细。 */
function providerStopError(
  state: SessionState,
  inspected: WorkflowModelFailureInspection,
  cause: unknown,
): WorkflowError {
  const kind = inspected.policy.decision === "stop" ? inspected.policy.kind : "other";
  const rawMessage = (
    inspected.rawMessage ?? (cause instanceof Error ? cause.message : String(cause))
  ).slice(0, PROVIDER_STOP_RAW_MESSAGE_MAX_CHARS);
  const details: ProviderStopDetails = {
    kind,
    reason: inspected.reason,
    subagent: refToString(state.actor),
    ...(state.actorName === undefined ? {} : { subagentName: state.actorName }),
    ...(inspected.providerId === undefined ? {} : { providerId: inspected.providerId }),
    ...(inspected.modelId === undefined ? {} : { modelId: inspected.modelId }),
    ...(inspected.providerCode === undefined ? {} : { providerCode: inspected.providerCode }),
    ...(rawMessage.length === 0 ? {} : { rawMessage }),
    ...(inspected.resetAt === undefined ? {} : { resetAt: inspected.resetAt }),
  };
  const code = inspected.providerCode === undefined ? "" : ` [${inspected.providerCode}]`;
  return new WorkflowError(
    "ProviderStop",
    `Subagent ${subagentLabel(state)} hit a permanent model-side error ` +
      `(${inspected.reason}${code}): ${rawMessage}`,
    { cause, providerStop: details },
  );
}
