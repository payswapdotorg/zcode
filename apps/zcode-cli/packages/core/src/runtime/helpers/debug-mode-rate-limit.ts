/* ZCODE_DEBUG_MODE 的 core 侧谓词（spec：apps/zcode-cli/docs/design/v2/debug-mode.md）。

   只回答一个问题：这次 turn 级错误在 debug 模式下是否算「限流类」——即 adapter 错误链上
   带有 rate_limited 语义（reason 或 ModelErrorCode.ModelRateLimited）。用途只有一个：
   turn.ts 的队列 error-pause 在 debug 模式下对限流类错误放行（排队输入继续进下一轮，
   下一轮在 runner 里患者探测），自动化迭代不被「窗口/账单」状态打断。

   形状读取与 streaming-recovery.ts 的 walkErrorRecords 同款（core 不 import adapters，
   分类表住在 adapters；这里只认 contracts 的 reason/code 字符串）。 */

import { isZCodeDebugModeEnabled } from "@zcode/shared";

/** contracts `ModelFailureReason.RateLimited` / `ModelErrorCode.ModelRateLimited` 的值。 */
const RATE_LIMIT_SIGNALS: ReadonlySet<string> = new Set([
  "rate_limited",
  "model_rate_limited",
  "MODEL_RATE_LIMITED",
]);

/** 错误链的最大深度（与 turn-errors.ts / streaming-recovery.ts 的遍历上限同族）。 */
const MAX_ERROR_CHAIN_DEPTH = 6;

/**
 * debug 模式下这次 turn 级错误是否为限流类（可安全地不停队列：下一轮请求会患者探测）。
 * flag off 时恒为 false（调用方行为逐字不变）。
 */
export function isDebugModeRateLimitTurnError(error: unknown): boolean {
  if (!isZCodeDebugModeEnabled()) return false;
  return hasRateLimitSignal(error);
}

function hasRateLimitSignal(error: unknown): boolean {
  let current = error;
  const seen = new WeakSet<object>();
  for (let depth = 0; depth <= MAX_ERROR_CHAIN_DEPTH; depth += 1) {
    if (current === undefined || current === null || typeof current !== "object") return false;
    const record = current as Record<string, unknown>;
    if (seen.has(record)) return false;
    seen.add(record);
    if (
      isRateLimitSignal(record.reason) ||
      isRateLimitSignal(record.code) ||
      isRateLimitSignal(record.errorCode) ||
      isRateLimitSignalInContext(record.context)
    ) {
      return true;
    }
    current = record.cause;
  }
  return false;
}

function isRateLimitSignalInContext(context: unknown): boolean {
  if (context === null || typeof context !== "object") return false;
  const record = context as Record<string, unknown>;
  return isRateLimitSignal(record.reason) || isRateLimitSignal(record.code);
}

function isRateLimitSignal(value: unknown): boolean {
  return typeof value === "string" && RATE_LIMIT_SIGNALS.has(value);
}
