// ============================================================
// ZCODE_DEBUG_MODE · driver 侧配额患者重驱（spec：apps/zcode-cli/docs/design/v2/debug-mode.md）
// ============================================================
// handleModelTurnFailure 的策略表 Stop 集配额行在 debug 模式下不再 stopRun，
// 改走与 runner 同源的 60s→10min→…→1h 患者升梯重驱；flag off 逐字 stopRun。
// 端到端的 Stop 行为由 workflow-fault-matrix.stop.test.ts 钉住（flag off）。

import { describe, expect, it, vi } from "vitest";
import { AiSdkModelAdapterError } from "@zcode/adapters/model";
import { ModelErrorCode, ModelFailureReason } from "@zcode/contracts";
import { handleModelTurnFailure, type ModelFailureHost } from "../src/app/workflow-driver-model-failure.js";
import type { AgentRuntimeWorkflowDriverDeps, SessionState } from "../src/app/workflow-driver-types.js";
import type { InstanceRef, WorkflowReportSink } from "@zcode/dynamic-workflow";

const INSTANCE: InstanceRef = { sessionId: "session-1", siteId: "s1", ordinal: 1 } as never;
const TRANSIENT_CONTINUE_PROMPT = expect.any(String);

function makeHost(debugMode: boolean) {
  const scheduled: Array<{ delayMs: number; fire: () => void }> = [];
  const sink = {
    askFailed: vi.fn(),
    askWaiting: vi.fn(),
    stopRun: vi.fn(),
  };
  const host: ModelFailureHost = {
    deps: {
      runId: "run-debug",
      ...(debugMode ? { debugMode: true } : {}),
      clock: {
        schedule: (callback: () => void, delayMs: number) => {
          const entry = { delayMs, fire: callback };
          scheduled.push(entry);
          return () => {
            entry.fire = () => undefined;
          };
        },
      },
    } as AgentRuntimeWorkflowDriverDeps as ModelFailureHost["deps"],
    sink: sink as unknown as WorkflowReportSink,
    isDisposed: () => false,
    runTurn: vi.fn(),
  };
  return { host, scheduled, sink };
}

function makeState(): SessionState {
  return {
    actor: { sessionId: "session-1", siteId: "s1", ordinal: 1 },
    actorName: "worker",
    accepted: false,
    cancelled: false,
    currentInstance: INSTANCE,
    debugQuotaRedrives: 0,
    transientAttempts: 0,
    abortController: new AbortController(),
  } as unknown as SessionState;
}

function quotaAdapterError(): AiSdkModelAdapterError {
  return new AiSdkModelAdapterError(ModelErrorCode.ModelRateLimited, "[1308] 已达到 5 小时的使用上限", {
    context: { reason: ModelFailureReason.RateLimited, providerCode: "1308", retryable: false },
  });
}

function authAdapterError(): AiSdkModelAdapterError {
  return new AiSdkModelAdapterError(ModelErrorCode.ModelAuthFailed, "[1006] token expired", {
    context: { reason: ModelFailureReason.AuthFailed, providerCode: "1006", retryable: false },
  });
}

describe("handleModelTurnFailure — ZCODE_DEBUG_MODE 配额患者重驱", () => {
  it("debug on + 配额停止：不 stopRun，按 60s→10min→20min 升梯重驱，续跑走同一机制", () => {
    const { host, scheduled, sink } = makeHost(true);
    const state = makeState();

    expect(handleModelTurnFailure(host, state, INSTANCE, quotaAdapterError())).toBe(true);
    expect(sink.stopRun).not.toHaveBeenCalled();
    expect(sink.askWaiting).toHaveBeenCalledWith(INSTANCE, {
      attempt: 1,
      cause: "backoff",
      delayMs: 60_000,
      reason: "rate_limited",
    });
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.delayMs).toBe(60_000);

    // 第一次重驱到期 → 续跑 turn；等待期间未被取消。
    scheduled[0]!.fire();
    expect(host.runTurn).toHaveBeenCalledWith(state, INSTANCE, TRANSIENT_CONTINUE_PROMPT, 0);

    // 同一 ask 内再次配额停止：升梯到 10min。
    handleModelTurnFailure(host, state, INSTANCE, quotaAdapterError());
    expect(scheduled[1]?.delayMs).toBe(10 * 60_000);
    scheduled[1]!.fire();
    // 第三次：20min。
    handleModelTurnFailure(host, state, INSTANCE, quotaAdapterError());
    expect(scheduled[2]?.delayMs).toBe(20 * 60_000);
    // 第四次：40min；第五次起封顶 1h。
    handleModelTurnFailure(host, state, INSTANCE, quotaAdapterError());
    expect(scheduled[3]?.delayMs).toBe(40 * 60_000);
    handleModelTurnFailure(host, state, INSTANCE, quotaAdapterError());
    expect(scheduled[4]?.delayMs).toBe(60 * 60_000);
    expect(sink.stopRun).not.toHaveBeenCalled();
  });

  it("debug on + 等待期间 ask 被取消：重驱不再续跑（与瞬态重驱同一批退场条件）", () => {
    const { host, scheduled } = makeHost(true);
    const state = makeState();
    handleModelTurnFailure(host, state, INSTANCE, quotaAdapterError());
    state.cancelled = true;
    scheduled[0]!.fire();
    expect(host.runTurn).not.toHaveBeenCalled();
  });

  it("debug on 但非配额类 stop（auth）：照旧 stopRun——只有配额行走患者重驱", () => {
    const { host, sink } = makeHost(true);
    expect(handleModelTurnFailure(host, makeState(), INSTANCE, authAdapterError())).toBe(true);
    expect(sink.stopRun).toHaveBeenCalledTimes(1);
    expect(sink.askWaiting).not.toHaveBeenCalled();
    const error = sink.stopRun.mock.calls[0]?.[0] as { providerStop?: { kind?: string } };
    expect(error.providerStop?.kind).toBe("auth");
  });

  it("回归：flag off + 配额停止照旧 stopRun（providerStop.kind = quota）", () => {
    const { host, sink } = makeHost(false);
    expect(handleModelTurnFailure(host, makeState(), INSTANCE, quotaAdapterError())).toBe(true);
    expect(sink.stopRun).toHaveBeenCalledTimes(1);
    expect(sink.askWaiting).not.toHaveBeenCalled();
    const error = sink.stopRun.mock.calls[0]?.[0] as { providerStop?: { kind?: string } };
    expect(error.providerStop?.kind).toBe("quota");
  });
});
