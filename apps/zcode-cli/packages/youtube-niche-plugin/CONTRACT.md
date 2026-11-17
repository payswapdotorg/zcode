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
- 阶段一工具集：`niche_add` / `niche_list` / `niche_remove`；频道关注、视频采集与排名在后续
  阶段加入，数据库表已预留（channels、videos，随细分删除级联）。
- 敏感凭据（未来的 Google OAuth 令牌）不得进入 `userConfig` 明文存储；令牌加密方案落地时更新
  本契约（依据：环境就绪度报告 §3「插件侧 secret 存储」一节）。
