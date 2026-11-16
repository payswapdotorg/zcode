import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { createUuid } from "@zcode/shared";
import { resolvePayswapIdentityDir } from "@zcode/shared/payswap-device-identity";

export interface EnsureDesktopDeviceMidSyncOptions {
  /**
   * telemetry-state.json 所在目录，默认 `~/.payswap/zcode`（PaySwap ZCode 独立设备身份命名空间，
   * 见 @zcode/shared/payswap-device-identity）。仅测试注入。
   */
  stateDir?: string;
  /** UUID 生成器，默认 createUuid。仅测试注入 */
  createId?: () => string;
}

/**
 * 同步确保设备身份文件（`~/.payswap/zcode/telemetry-state.json`，PaySwap 独立命名空间）里有
 * deviceMid，并返回该值。
 *
 * 与数仓上报（telemetryCore）共用同一个文件的 `deviceMid` 字段，使 ARMS 与数仓两套
 * device_mid 统一为同一个持久化 UUID。ARMS 侧需要在窗口创建前同步取值（经 preload
 * `--device-id=` 注入），故此处用 node:fs 同步读写。
 *
 * 命名空间隔离：只读写 PaySwap 自己的 `~/.payswap/zcode/`，不读取、不迁移、不回退旧的
 * `~/.zcode/v2/telemetry-state.json`（该文件属于同机其他 ZCode 系应用）；首次启动在新命名
 * 空间生成全新 UUID，普通重启/升级/保留用户数据的重装都复用同一身份。身份锚定 OS 用户主
 * 目录，不跟随 Desktop 数据目录重定位。
 *
 * 竞态规避：
 * - 已存在合法 deviceMid 时直接返回、绝不写盘（老用户/二次启动零写入）。
 * - 缺失才写，且读出「完整 state」只补 deviceMid 再写回，避免冲掉 telemetryCore 写的
 *   lastDailyActiveDate / dailyActiveInFlight 等字段。
 * - 原子写（临时文件 + renameSync），避免被并发读方读到半截 JSON。
 *
 * 任何 fs / JSON 异常都不抛：写盘失败仍返回内存中生成的 UUID，下次启动再尝试落盘，
 * 保证窗口创建那一刻 deviceMid 一定有值。
 */
export function ensureDesktopDeviceMidSync(
  options?: EnsureDesktopDeviceMidSyncOptions,
): string {
  const createId = options?.createId ?? createUuid;
  try {
    const stateDir = options?.stateDir ?? resolvePayswapIdentityDir();
    const stateFile = join(stateDir, "telemetry-state.json");

    const state = readTelemetryStateSync(stateFile);
    if (typeof state.deviceMid === "string" && state.deviceMid) {
      return state.deviceMid;
    }

    const deviceMid = createId();
    state.deviceMid = deviceMid;
    writeTelemetryStateSync(stateFile, state);
    return deviceMid;
  } catch {
    // fs / JSON 异常兜底：保证一定有返回值，窗口创建不阻塞
    return createId();
  }
}

function readTelemetryStateSync(stateFile: string): Record<string, unknown> {
  try {
    const raw = readFileSync(stateFile, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function writeTelemetryStateSync(
  stateFile: string,
  state: Record<string, unknown>,
): void {
  const dir = dirname(stateFile);
  mkdirSync(dir, { recursive: true });
  const tempFile = `${stateFile}.${process.pid}.tmp`;
  writeFileSync(tempFile, JSON.stringify(state, null, 2), "utf-8");
  renameSync(tempFile, stateFile);
}
