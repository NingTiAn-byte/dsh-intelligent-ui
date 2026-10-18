# 开发说明 / Development

## 可重现构建 / Reproducible setup

执行 `npm ci`，设置 `DSH_SOURCE` 指向已构建的 `0.2.1-alpha.4` 源码，再执行 `npm run build` 和 `npm run check`。`package-lock.json` 固定普通依赖；DSH 的版本与源码构建是另一项必要前提。

Run `npm ci`, point `DSH_SOURCE` at a built `0.2.1-alpha.4` checkout, then run `npm run build` and `npm run check`. The lockfile pins regular dependencies; the matching built DSH source is a separate prerequisite.

`scripts/environment.mjs` 为 Host 类型与运行模块建立链接。切换 DSH checkout 后，应先移除旧项目依赖目录并重新 `npm ci`，避免沿用指向原 checkout 的链接；不要修改 DSH 的包目录来迁就本插件。

The environment helper links Host packages. When switching checkouts, recreate this project's dependency directory with `npm ci` to avoid retaining links to the previous checkout.

构建校验 vendor manifest 的 SHA-256 与字节数，生成 `lib/`、`dist/mcp/`、静态预览及本机 overlay/MCP 配置。所有生成文件均被 Git 忽略。升级图库应添加新版本标识及兼容方案，并保留第三方许可。

Builds verify vendored hashes and sizes, then generate bundles, the portable MCP package, previews and local configuration. Generated files are ignored. Library upgrades need a new identifier and compatibility plan, with licenses preserved.

## 测试 / Testing

- `npm run check`：Host、Client、MCP 三套严格 TypeScript 检查。
- `npm test`：文档边界、工具注册、DSH 会话投影、路由、追问状态、原生人工问答、MCP 握手及真实浏览器交互。
- `npm run verify:mcp`：通过真实 SDK stdio 连接读取资源、提示和工具，装配模板。
- `npm run audit:release`：检查 Git 的待发布文件清单，拒绝本地产物、已识别的个人路径与密钥格式；它不能识别所有可能的秘密格式。

Tests cover validation, Host integration, conversation projections, routing, follow-up status, human questions, MCP and browser interactions. The publication audit checks tracked and non-ignored untracked files; it is a supplement to reviewing what you publish.

浏览器测试优先使用 `DSH_TEST_BROWSER`，Windows 可自动发现 Edge，否则使用 Playwright Chromium。后者需先执行 `npx playwright install chromium`。当前自动化实际验证平台是 Windows；macOS/Linux 的浏览器选择逻辑已整理，未据此宣称完成跨平台验收。

Browser selection prefers `DSH_TEST_BROWSER`, then installed Edge on Windows, then Playwright Chromium. Run `npx playwright install chromium` when needed. The current verification platform is Windows; portable browser selection is not a claim of full macOS/Linux validation.

默认回归不依赖个人会话或真实模型，也不会发送模型请求。可选真实图片回放使用外部 `DSH_LIVE_IMAGE_FIXTURE`。图片与地图联网下载、当前模型的一次生成质量以及真实用户操作属于另外的集成验证，不能由确定性回归替代。

Default regressions do not depend on personal sessions or call a live model. Optional real-image replay reads `DSH_LIVE_IMAGE_FIXTURE`. Live downloads and one-shot generation quality require separate checks.

## Git 清单 / Git contents

保留源码、测试与固定测试数据、预览源码、构建脚本、必要说明、锁文件与资源许可。不要强制添加 `.gitignore` 排除的文件。尤其不要提交 DSH_HOME、启动日志中的访问 URL、凭据、模型输出或本机 MCP 配置。

Keep source, tests, fixed fixtures, preview source, scripts, documentation, lockfiles and asset licenses. Do not force-add ignored files, particularly DSH_HOME, token-bearing launch URLs, credentials, model output or local MCP configuration. Acceptance reports and historical project notes belong outside the publication directory.
