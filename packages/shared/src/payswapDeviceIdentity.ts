import { homedir } from "node:os";
import { join } from "node:path";

/**
 * PaySwap ZCode 发行版独立的设备身份命名空间。
 *
 * 历史上设备身份（`deviceMid`）存放在 `~/.zcode/v2/telemetry-state.json`，与同一 OS 账号下的
 * 其他 ZCode 系应用共享一个文件。PaySwap 发行版改用独立命名空间，避免跨产品共享设备身份：
 *
 * ```text
 * <home>/.payswap/zcode/telemetry-state.json   # deviceMid 持久化
 * <home>/.payswap/zcode/telemetry-state.lock   # 同目录同名互斥锁
 * ```
 *
 * 生命周期约定（install-identity isolation）：
 * - 身份只锚定 OS 用户主目录：Desktop main、app services、远端 Server（SSH/WSL/Docker Core、
 *   ZCode Lite、stdio entry）、独立 CLI 在同机同账号下必须解析到同一个文件；身份不跟随
 *   `ZCODE_DATA_BASE_DIR` / `ZCODE_HOME` / Desktop 数据目录重定位等任何数据根配置。
 * - 不读取、不迁移、不回退旧的 `~/.zcode/v2/telemetry-state.json`；新命名空间首次初始化时
 *   生成全新 UUID。旧文件属于其他 ZCode 系应用，本发行版永不改动它。
 * - 远端 Server 自身的 `install.json` `installationId` 是另一套独立的安装配对身份，与本命名空间无关。
 *
 * 本模块是唯一的路径事实源：所有运行环境一律经由这里的导出函数拼路径，禁止在业务包里
 * 自行拼接 `.payswap/zcode` 路径字符串。
 */

/** 身份命名空间相对主目录的目录段：`<home>/.payswap/zcode`。 */
export const PAYSWAP_ZCODE_IDENTITY_DIR_SEGMENTS = [".payswap", "zcode"] as const;

/** 设备身份 state 文件名（沿用 telemetry-state.json 命名，仅位置迁移）。 */
export const PAYSWAP_ZCODE_TELEMETRY_STATE_FILE_NAME = "telemetry-state.json";

/** 与 state 文件同目录的互斥锁文件名。 */
export const PAYSWAP_ZCODE_TELEMETRY_LOCK_FILE_NAME = "telemetry-state.lock";

export interface PayswapDeviceIdentityPathOptions {
  /**
   * 显式主目录（宿主/测试注入）。提供时优先于 env 解析，作为身份命名空间的根。
   */
  homeDir?: string;
  /**
   * 参与主目录解析的环境变量表，缺省 `process.env`。仅读取 `HOME` / `USERPROFILE`，
   * 与 Node `os.homedir()` 的语义一致（Windows 用 USERPROFILE，POSIX 用 HOME）。
   * 注意：身份解析不读取 `ZCODE_DATA_BASE_DIR` / `ZCODE_HOME`——设备身份不跟随数据根。
   */
  env?: Record<string, string | undefined>;
}

function resolvePayswapIdentityHomeDir(
  options: PayswapDeviceIdentityPathOptions = {},
): string {
  const explicit = options.homeDir?.trim();
  if (explicit) {
    return explicit;
  }

  const env = options.env ?? process.env;
  const envHome = env.HOME?.trim() || env.USERPROFILE?.trim();
  return envHome && envHome.length > 0 ? envHome : homedir();
}

/** `<home>/.payswap/zcode` */
export function resolvePayswapIdentityDir(
  options: PayswapDeviceIdentityPathOptions = {},
): string {
  return join(resolvePayswapIdentityHomeDir(options), ...PAYSWAP_ZCODE_IDENTITY_DIR_SEGMENTS);
}

/** `<home>/.payswap/zcode/telemetry-state.json` */
export function resolvePayswapIdentityStateFile(
  options: PayswapDeviceIdentityPathOptions = {},
): string {
  return join(resolvePayswapIdentityDir(options), PAYSWAP_ZCODE_TELEMETRY_STATE_FILE_NAME);
}

/** `<home>/.payswap/zcode/telemetry-state.lock`（与 state 文件同目录）。 */
export function resolvePayswapIdentityLockFile(
  options: PayswapDeviceIdentityPathOptions = {},
): string {
  return join(resolvePayswapIdentityDir(options), PAYSWAP_ZCODE_TELEMETRY_LOCK_FILE_NAME);
}
