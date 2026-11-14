/* ZCODE_DEBUG_MODE=1 时配额/限流类停止的患者探测定义（spec：
   apps/zcode-cli/docs/design/v2/debug-mode.md）。

   默认（flag off）一切路径不变；本模块的谓词与曲线只在 flag on 时被 runner /
   bootstrap driver 引用。设计对齐两处既有机制，不引入第三种语义：
   - 预算豁免 + 原地探测：与 off-peak 排队协议同款（offpeak-retry.ts，runner 里
     `attempt -= 1` 让 for 自增后原地重试，无限探测，不消耗 Default 重试预算）；
   - 反热环升梯：与 dynamic-workflow-quota-resume.ts 的 10min→1h 指数间距同族
     （`WORKFLOW_QUOTA_RESUME_MIN_SPACING_MS * 2^(n-1)`，顶 1h）。

   合成出的曲线：首次配额停止等 60s（offpeak 的保守探测间隔），此后 10min→20min→
   40min→1h 封顶——「session 永远活着，但不敲打端点」。Retry-After 故意**不**参与
   探测间隔：配额 429 的 Retry-After 常指向额度窗口结束（可达数小时），照它等待就
   探测不出「窗口内服务端是否放行」（这正是 debug 模式要回答的经验问题）。 */
import { ModelFailureReason } from "@zcode/contracts";
import type { ClassifiedModelFailure } from "./failure-classifier.js";
import { WORKFLOW_QUOTA_PROVIDER_CODES } from "./workflow-model-failure-policy.js";

/** 探测最小间隔：首次配额停止后的等待（与 offpeak 无 Retry-After 的保守探测同值）。 */
export const DEBUG_QUOTA_PROBE_MIN_SPACING_MS = 60_000;
/** 反热环升梯底：连续配额停止从第 2 次起按 10min 起步指数退避（quota-resume 同族）。 */
export const DEBUG_QUOTA_PROBE_BACKOFF_BASE_MS = 10 * 60_000;
/** 升梯顶：1 小时（与 dynamic-workflow-quota-resume 的最大间距同值）。 */
export const DEBUG_QUOTA_PROBE_BACKOFF_MAX_MS = 60 * 60_000;

/** 指数封顶，防 overflow：10min * 2^6 已远超 1h 顶。 */
const DEBUG_QUOTA_PROBE_BACKOFF_MAX_EXPONENT = 6;

/**
 * 第 {@link consecutiveQuotaStops} 次（1 起）连续配额停止后的探测间隔：
 * 1 → 60s；2 → 10min；3 → 20min；4 → 40min；≥5 → 1h。只升不降（成功即离开循环），
 * 幂等、无时钟、无随机——测试与 harness 直接断言数值。
 */
export function debugQuotaProbeDelayMs(consecutiveQuotaStops: number): number {
  if (!Number.isFinite(consecutiveQuotaStops) || consecutiveQuotaStops <= 1) {
    return DEBUG_QUOTA_PROBE_MIN_SPACING_MS;
  }
  const exponent = Math.min(consecutiveQuotaStops - 2, DEBUG_QUOTA_PROBE_BACKOFF_MAX_EXPONENT);
  const escalated = DEBUG_QUOTA_PROBE_BACKOFF_BASE_MS * 2 ** exponent;
  return Math.min(escalated, DEBUG_QUOTA_PROBE_BACKOFF_MAX_MS);
}

/**
 * 这次失败在 debug 模式下是否算「配额/限流类停止」：配额业务码（与 workflow 策略表
 * 同一张 {@link WORKFLOW_QUOTA_PROVIDER_CODES}）**或** reason 为 rate_limited（覆盖
 * 主对话表里的 TERMINAL_RATE_LIMIT_MAPPING 码与预算耗尽的裸 429——它们同样是
 * 窗口/账单信号）。auth / invalid_request / 5xx / 网络错误不受影响，仍走默认路径。
 * 调用方须先排除 off-peak 排队协议（offpeak 有自己的探测语义，见 offpeak-retry.ts）。
 */
export function isDebugQuotaStopFailure(
  failure: Pick<ClassifiedModelFailure, "reason">,
  providerCode: string | undefined,
): boolean {
  if (providerCode !== undefined && WORKFLOW_QUOTA_PROVIDER_CODES.has(providerCode)) {
    return true;
  }
  return failure.reason === ModelFailureReason.RateLimited;
}
