#!/usr/bin/env bash
# reset-install-state.sh — 把 zcode 安装状态恢复到真正的 first-launch（干净机器）条件。
#
# 审计依据：apps/zcode-cli/docs/design/v2/install-identity-lifecycle.md
# 删除 <base-dir>/.zcode 整棵数据根（credentials / provider_config / telemetry-state(deviceMid) /
# cli/config.json / 会话库 / 轨迹 / 日志 / 备份……）。
# 可选：--purge-keyring 尽力删除 OS keyring 里的凭据加密密钥条目（卸载后唯一删不掉的残留，
#       无人清理即测试卫生 bug 的根源）；--project-dir 清理项目级（cwd 作用域）状态。
#
# 用法：
#   reset-install-state.sh [--base-dir DIR] [--project-dir DIR] [--purge-keyring] [--apply]
#
#   --base-dir DIR    含 .zcode 的目录。默认 $ZCODE_DATA_BASE_DIR，未设则 $HOME。
#   --project-dir DIR 另外清理该项目目录下的 .zcode（项目配置）。.env 只报告不删（可能含真实密钥）。
#   --purge-keyring   尽力删除已知凭据路径（$HOME 根与 --base-dir 根）对应的 keyring 条目：
#                     service "ZCode Credential Encryption"，account = sha256(credentials.json 绝对路径) hex。
#                     无 Secret Service/Keychain/Credential Manager 时报告 skipped（不算失败）。
#   --apply           真正执行。缺省 dry-run：只列出将发生什么。
#
# 退出码：0 正常（含 already-pristine / keyring skipped）；1 用法错误或危险目标；2 文件系统错误。
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
MODE="dry-run"
BASE_DIR="${ZCODE_DATA_BASE_DIR:-$HOME}"
PROJECT_DIR=""
PURGE_KEYRING="no"

usage() { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 1; }
die_usage() { echo "reset-install-state: $*" >&2; usage; }
die_fs() { echo "reset-install-state: $*" >&2; exit 2; }

expand_path() {
  local value="$1"
  if [ "$value" = "~" ]; then printf '%s' "$HOME";
  elif [ "${value#\~/}" != "$value" ]; then printf '%s/%s' "$HOME" "${value#\~/}";
  else printf '%s' "$value"; fi
}

while [ $# -gt 0 ]; do
  case "$1" in
    --base-dir|--project-dir)
      [ $# -ge 2 ] || die_usage "$1 needs a value"
      if [ "$1" = "--base-dir" ]; then BASE_DIR="$2"; else PROJECT_DIR="$2"; fi
      shift 2 ;;
    --base-dir=*|--project-dir=*)
      case "$1" in
        --base-dir=*) BASE_DIR="${1#*=}" ;;
        *) PROJECT_DIR="${1#*=}" ;;
      esac
      shift ;;
    --purge-keyring) PURGE_KEYRING="yes"; shift ;;
    --apply) MODE="apply"; shift ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die_usage "unknown argument: $1" ;;
  esac
done

# ---- 解析并护栏 -------------------------------------------------------------
BASE_DIR="$(cd -- "$(expand_path "$BASE_DIR")" 2>/dev/null && pwd)" \
  || die_fs "base dir does not exist: $BASE_DIR"
ZCODE_DIR="$BASE_DIR/.zcode"

[ -n "$ZCODE_DIR" ] && [ "$ZCODE_DIR" != "/" ] && [ "$ZCODE_DIR" != "$BASE_DIR" ] \
  || die_usage "refusing unsafe .zcode path: '$ZCODE_DIR'"

log() { printf '%s %s\n' "$1" "$2"; }
act() { # act <label> <path>
  if [ ! -e "$2" ]; then log "[$MODE][missing]" "$2"; return 0; fi
  if [ "$MODE" = "apply" ]; then
    rm -rf -- "$2" || die_fs "failed to remove: $2"
    log "[$MODE][reset]" "$2 ($1)"
  else
    log "[$MODE][would-reset]" "$2 ($1)"
  fi
}

echo "reset-install-state: mode=$MODE base=$BASE_DIR"

# 第二数据根告警：ZCODE_DATA_BASE_DIR 指向别处时，只清 --base-dir 会漏掉它。
if [ -n "${ZCODE_DATA_BASE_DIR:-}" ]; then
  OTHER="$(cd -- "$(expand_path "$ZCODE_DATA_BASE_DIR")" 2>/dev/null && pwd)" || OTHER=""
  if [ -n "$OTHER" ] && [ "$OTHER" != "$BASE_DIR" ] && [ -e "$OTHER/.zcode" ]; then
    echo "reset-install-state: WARN second data root exists at $OTHER/.zcode (ZCODE_DATA_BASE_DIR) — pass --base-dir '$OTHER' to reset it too"
  fi
fi

# ---- 主数据根 ---------------------------------------------------------------
if [ -e "$ZCODE_DIR" ]; then
  act ".zcode data root (credentials/deviceMid/config/sessions/logs/backups)" "$ZCODE_DIR"
else
  log "[$MODE][already-pristine]" "$ZCODE_DIR"
fi

# ---- 项目级（cwd 作用域）状态 ------------------------------------------------
if [ -n "$PROJECT_DIR" ]; then
  PROJECT_DIR="$(cd -- "$(expand_path "$PROJECT_DIR")" 2>/dev/null && pwd)" \
    || die_fs "project dir does not exist: $PROJECT_DIR"
  act "project config" "$PROJECT_DIR/.zcode"
  if [ -f "$PROJECT_DIR/.env" ]; then
    echo "reset-install-state: NOTE $PROJECT_DIR/.env exists (dotenv can inject provider config into CLI runs) — not removed; review manually"
  fi
fi

# ---- keyring 条目（卸载后唯一残留）-------------------------------------------
if [ "$PURGE_KEYRING" = "yes" ]; then
  NODE_HELPER="$(mktemp /tmp/reset-install-state-keyring.XXXXXX.mjs)"
  trap 'rm -f -- "$NODE_HELPER"' EXIT
  cat >"$NODE_HELPER" <<'NODE'
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// 与 systemCredentialCipher.ts 完全同构：service 常量 + account = sha256(credentials.json 绝对路径) hex。
// argv[2] = 搜索起点（脚本自身所在目录）；pnpm 严格布局下先逐级找目录，再用 Node 解析器兜底。
const SERVICE = "ZCode Credential Encryption";

function findKeyringModule(searchRoot) {
  let dir = resolve(searchRoot);
  while (true) {
    const candidate = resolve(dir, "node_modules", "@napi-rs", "keyring");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  try {
    const require = createRequire(resolve(searchRoot, "package.json"));
    let entryDir = dirname(require.resolve("@napi-rs/keyring"));
    while (true) {
      const manifest = resolve(entryDir, "package.json");
      if (existsSync(manifest)) {
        try {
          if (JSON.parse(readFileSync(manifest, "utf8")).name === "@napi-rs/keyring") {
            return entryDir;
          }
        } catch {
          /* 继续向上。 */
        }
      }
      const parent = dirname(entryDir);
      if (parent === entryDir) return undefined;
      entryDir = parent;
    }
  } catch {
    return undefined;
  }
}

async function importKeyring(moduleDir) {
  for (const entry of ["mod.js", "index.js"]) {
    try {
      return await import(pathToFileURL(resolve(moduleDir, entry)).href);
    } catch {
      /* 尝试下一个入口。 */
    }
  }
  return await import(pathToFileURL(moduleDir).href);
}

async function main(argv) {
  const [searchRoot, ...targets] = argv;
  if (!searchRoot || targets.length === 0) return;
  const moduleDir = findKeyringModule(searchRoot);
  if (!moduleDir) {
    console.log("[keyring][skipped] @napi-rs/keyring not found (run from inside the zcode repo)");
    return;
  }
  let keyring;
  try {
    keyring = await importKeyring(moduleDir);
  } catch {
    console.log("[keyring][skipped] @napi-rs/keyring failed to load (prebuilt binary missing?)");
    return;
  }
  for (const baseDir of targets) {
    const credentialsPath = resolve(baseDir, ".zcode/v2/credentials.json");
    const accountHex = createHash("sha256").update(credentialsPath).digest("hex");
    const label = `${SERVICE} / ${accountHex.slice(0, 12)}… (${credentialsPath})`;
    try {
      const entry = new keyring.AsyncEntry(SERVICE, accountHex, {
        linux: { store: "secret-service" },
      });
      const existing = await entry.getPassword();
      if (existing === null || existing === undefined) {
        console.log(`[keyring][absent] ${label}`);
        continue;
      }
      await entry.delete();
      console.log(`[keyring][purged] ${label}`);
    } catch (error) {
      // keyring 不可用（无 Secret Service / D-Bus / Keychain）不算失败：报告即可。
      console.log(
        `[keyring][skipped] ${label} — ${error instanceof Error ? error.message.split("\n")[0] : "unavailable"}`,
      );
    }
  }
}

main(process.argv.slice(2)).catch(() => {
  /* 尽力而为：任何失败都不阻断 reset。 */
});
NODE
  echo "reset-install-state: purging keyring entries (best-effort)…"
  HOME_TARGET="$(expand_path "$HOME")"
  if [ "$HOME_TARGET" != "$BASE_DIR" ]; then
    /usr/bin/env node "$NODE_HELPER" "$SCRIPT_DIR" "$BASE_DIR" "$HOME_TARGET" || true
  else
    /usr/bin/env node "$NODE_HELPER" "$SCRIPT_DIR" "$BASE_DIR" || true
  fi
else
  echo "reset-install-state: keyring entries NOT purged (pass --purge-keyring to also delete 'ZCode Credential Encryption' entries; nothing else ever deletes them — see audit doc)"
fi

echo "reset-install-state: done (mode=$MODE)"
