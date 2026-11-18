# youtube-niche-plugin

YouTube 细分领域情报插件（MVP 第一阶段骨架）：`.zcode-plugin/plugin.json` 声明一个 stdio MCP
服务与一个侧栏面板（Niche Explorer / 细分领域探索）；`pnpm --filter
@zcode/youtube-niche-plugin build` 产出 `dist/server.mjs` 与 `dist/ui/panel.html`。

不变量：

- 插件名取自插件的 `.zcode-plugin/plugin.json`，它同时是 MCP 服务名和 `ui://youtube-niche/`
  资源前缀；不能从目录名推导（目录名带 `-plugin` 后缀）。
- 构建必定产出 `contract.ts` 的 `YOUTUBE_NICHE_PLUGIN_OUTPUTS`，产物自包含：esbuild 打包全部
  依赖，运行时不读取 `node_modules`。
- 数据落在插件私有数据目录（宿主经 manifest env 映射注入 `ZCODE_PLUGIN_DATA`；独立运行回退到
  `<cwd>/.youtube-niche`），不写工作区其他位置。
- 工具集：`niche_add` / `niche_list` / `niche_remove` / `niche_rank` / `niche_collect` /
  `niche_videos` / `niche_export`（CSV/Markdown，落 `exports/` 子目录，文件名带 niche slug 与
  分钟时间戳，重导出幂等）与 OAuth 对 `youtube_connect` / `youtube_connect_finish`。
- 敏感凭据（Google OAuth 令牌）不进 `userConfig` 明文：AES-256-GCM 加密落盘于插件私有数据目录
  （`tokens.json.enc`，密钥经 `YOUTUBE_NICHE_TOKEN_KEY` 注入，生产侧由宿主从 OS keychain 派生）。
  访问令牌到期前 60s 窗口内或 API 返回 401 时自动经 refresh grant 轮换并回写加密存储；无
  client id / refresh token 时降级为持有现令牌并让 401 如实上抛，绝不静默重连。
