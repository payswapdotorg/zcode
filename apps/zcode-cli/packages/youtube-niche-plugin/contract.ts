/**
 * youtube-niche-plugin 对外契约：插件清单声明什么、构建后保证产出什么。
 * MCP 工具、面板资源与数据库的运行时契约见 src/contract.ts 与 CONTRACT.md。
 */
import type { NicheRecord } from "#niche/contract.ts";

export type { NicheRecord };

/**
 * 构建后在插件根目录下必定存在的产物。插件安装与桌面打包把它们当作必需资产，
 * 缺任一项即视为残缺插件。
 */
export const YOUTUBE_NICHE_PLUGIN_OUTPUTS = [
  "dist/server.mjs",
  "dist/ui/panel.html",
] as const;

export interface YoutubeNichePluginContract {
  /** 插件名取自 .zcode-plugin/plugin.json：同时是 MCP 服务名与 ui:// 资源前缀。 */
  name: "youtube-niche";
  /** 构建保证产出的文件，相对插件根目录。 */
  outputs: typeof YOUTUBE_NICHE_PLUGIN_OUTPUTS;
}
