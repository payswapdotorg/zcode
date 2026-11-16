import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createUuid } from "@zcode/shared";
import { resolvePayswapIdentityStateFile } from "@zcode/shared/payswap-device-identity";

const LOCK_RETRY_DELAY_MS = 10;
const LOCK_RETRY_COUNT = 200;
const LOCK_STALE_MS = 5 * 60 * 1000;

interface TelemetryState {
  deviceMid?: unknown;
  [key: string]: unknown;
}

interface TelemetryLockOwner {
  createdAt: number;
  pid: number;
}

export interface EnsureCliDeviceMidOptions {
  /** 身份命名空间所在主目录；缺省按 env HOME/USERPROFILE → os.homedir() 解析。仅测试注入。 */
  baseDir?: string;
  createId?: () => string;
  /** 仅用于解析 HOME/USERPROFILE；设备身份不跟随 ZCODE_DATA_BASE_DIR 等数据根配置。 */
  env?: Record<string, string | undefined>;
}

const deviceMidCacheByStateFile = new Map<string, Promise<string>>();

/**
 * 在 CLI 所在主机独立确保 deviceMid 存在；它是反馈与 provider 请求头使用的设备身份，
 * 与 Desktop / 远端 server 共享同一个 state 文件与字段（PaySwap 独立命名空间
 * `<home>/.payswap/zcode/telemetry-state.json`，见 @zcode/shared/payswap-device-identity）。
 * 文件系统异常不阻断模型请求；同一进程会继续使用首次生成的 fallback UUID。
 */
export function ensureCliDeviceMid(options: EnsureCliDeviceMidOptions = {}): Promise<string> {
  const stateFile = resolveCliTelemetryStateFile(options);
  const cached = deviceMidCacheByStateFile.get(stateFile);
  if (cached) {
    return cached;
  }

  const createId = options.createId ?? createUuid;
  let generatedDeviceMid: string | undefined;
  const getGeneratedDeviceMid = () => {
    generatedDeviceMid ??= createId();
    return generatedDeviceMid;
  };
  const pending = ensurePersistedDeviceMid({
    getGeneratedDeviceMid,
    stateFile,
  }).catch(() => getGeneratedDeviceMid());
  deviceMidCacheByStateFile.set(stateFile, pending);
  return pending;
}

function resolveCliTelemetryStateFile(options: EnsureCliDeviceMidOptions): string {
  return resolvePayswapIdentityStateFile({
    homeDir: options.baseDir,
    env: options.env,
  });
}

async function ensurePersistedDeviceMid(input: {
  getGeneratedDeviceMid: () => string;
  stateFile: string;
}): Promise<string> {
  const existingDeviceMid = await readExistingDeviceMid(input.stateFile);
  if (existingDeviceMid) {
    return existingDeviceMid;
  }

  return withTelemetryStateLock(input.stateFile, async (state) => {
    const lockedExistingDeviceMid = readDeviceMid(state);
    if (lockedExistingDeviceMid) {
      return lockedExistingDeviceMid;
    }

    const deviceMid = input.getGeneratedDeviceMid();
    state.deviceMid = deviceMid;
    await writeTelemetryState(input.stateFile, state);
    return deviceMid;
  });
}

async function readExistingDeviceMid(stateFile: string): Promise<string | undefined> {
  return readDeviceMid(await readTelemetryState(stateFile));
}

function readDeviceMid(state: TelemetryState): string | undefined {
  return typeof state.deviceMid === "string" && state.deviceMid.length > 0
    ? state.deviceMid
    : undefined;
}

async function readTelemetryState(stateFile: string): Promise<TelemetryState> {
  try {
    const parsed = JSON.parse(await readFile(stateFile, "utf-8")) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function writeTelemetryState(stateFile: string, state: TelemetryState): Promise<void> {
  const directory = dirname(stateFile);
  await mkdir(directory, { recursive: true });
  const tempFile = join(
    directory,
    `.${basename(stateFile)}.${process.pid}.${Date.now()}.${Math.random()
      .toString(16)
      .slice(2)}.tmp`,
  );

  try {
    await writeFile(tempFile, JSON.stringify(state, null, 2), "utf-8");
    await rename(tempFile, stateFile);
  } catch (error) {
    await unlink(tempFile).catch(() => undefined);
    throw error;
  }
}

async function withTelemetryStateLock<T>(
  stateFile: string,
  run: (state: TelemetryState) => Promise<T>,
): Promise<T> {
  const lockFile = join(dirname(stateFile), "telemetry-state.lock");
  await mkdir(dirname(lockFile), { recursive: true });

  for (let attempt = 0; attempt < LOCK_RETRY_COUNT; attempt += 1) {
    try {
      const handle = await open(lockFile, "wx");
      try {
        await handle.writeFile(
          JSON.stringify({
            createdAt: Date.now(),
            pid: process.pid,
          }),
          "utf-8",
        );
        return await run(await readTelemetryState(stateFile));
      } finally {
        await handle.close();
        await unlink(lockFile).catch(() => undefined);
      }
    } catch (error) {
      if (!isNodeErrorCode(error, "EEXIST")) {
        throw error;
      }
      if (await removeStaleTelemetryLockIfNeeded(lockFile, Date.now())) {
        continue;
      }
      await sleep(LOCK_RETRY_DELAY_MS);
    }
  }

  throw new Error("CLI telemetry state lock timeout");
}

async function removeStaleTelemetryLockIfNeeded(
  lockFile: string,
  timestamp: number,
): Promise<boolean> {
  try {
    const metadata = await stat(lockFile);
    if (timestamp - metadata.mtimeMs < LOCK_STALE_MS) {
      const owner = await readTelemetryLockOwner(lockFile);
      if (!owner || isProcessAlive(owner.pid)) {
        return false;
      }
    }

    await unlink(lockFile).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

async function readTelemetryLockOwner(lockFile: string): Promise<TelemetryLockOwner | null> {
  try {
    const parsed = JSON.parse(await readFile(lockFile, "utf-8")) as unknown;
    if (
      !isRecord(parsed) ||
      typeof parsed.pid !== "number" ||
      typeof parsed.createdAt !== "number"
    ) {
      return null;
    }
    return {
      createdAt: parsed.createdAt,
      pid: parsed.pid,
    };
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeErrorCode(error, "EPERM");
  }
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, delayMs);
  });
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
