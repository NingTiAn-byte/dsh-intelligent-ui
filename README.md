# DSH Intelligent UI

[English](README.en.md) · 中文

将 DeepSeek Harness 的聊天结果变成可交互的计算器、图表、地图、流程图和小型应用。界面保存在会话中，支持历史重放与单文件 HTML 导出。

当前版本 **1.2.1**，面向 **DeepSeek Harness 源码版 `0.2.1-alpha.4` 的 Web 客户端**。本项目是独立插件，并非 DeepSeek 或 OpenAI 的官方产品。其他版本，包括 rc.2，需要适配验证，不能直接视为兼容。

## 功能

- **交互界面**：HTML/CSS/JavaScript 分离生成；流式阶段提供静态预览，成功后启用一次交互。支持 DOM、SVG、Canvas 动画和小游戏。
- **持久显示**：自有聊天节点保留结果，支持历史会话恢复、重置、自动高度和运行错误反馈。
- **统一视觉**：跟随 DSH 浅色/深色、字号和字体，提供计算器、方案比较、流程图、折线图、柱状图、饼图六种模板。
- **图表与表格**：内置 Chart.js 4.5.1；受控结构化表格、柱图和饼图；图表可离线重放。
- **地点与图片**：DSH Host 可按地名解析坐标、查询百科/Commons 配图并保存署名；每份文档最多四张图片。Leaflet 1.9.4 与保存的街道区域支持离线展示、标记和行程播放。
- **宿主协作**：当前模型选择文字/表格/UI/混合展示；追问经用户确认后发送，独立显示排队与模型运行状态；会议时间复用 DSH 人工问答，工作流展示只读任务快照。
- **独立 MCP**：stdio 服务提供 13 个资源、3 个提示和 7 个工具，可返回组装后的 HTML。MCP 客户端负责是否以及如何显示它。

## 环境与安装

- Node.js **22.19 或更高版本**，本轮使用 Node 24 验证。
- 已安装依赖并完成构建的 [DeepSeek Harness 源码](https://github.com/deepseek-ai/deepseek-harness)，其 `package.json` 版本必须为 `0.2.1-alpha.4`。按该版本仓库说明执行 `pnpm install` 和 `pnpm run build`；不要假设最新默认分支仍兼容。
- 启动 DSH 的辅助脚本需要 PowerShell 7。插件构建和静态预览本身使用 Node.js。

在本项目根目录执行：

```powershell
# 换成你实际的、已经构建的 DSH 源码路径。
$env:DSH_SOURCE = 'D:\code\deepseek-harness'
npm ci
npm run build
npm run check
```

macOS/Linux 将环境变量写法替换为 `export DSH_SOURCE=/path/to/deepseek-harness`。未设置时，构建脚本会寻找同级或上一级目录下的 `deepseek-harness`。

普通依赖由本项目锁文件安装；构建脚本仅将 DSH 自有包链接到指定源码目录，不复制 DSH、不安装全局包。Windows 使用目录 junction，其他平台使用符号链接。`.npmrc` 中的 `legacy-peer-deps=true` 用于避免 npm 从注册表补装宿主专用 peer 包。

### 静态预览

```sh
npm run preview
# 只生成预览并打印位置，不自动打开浏览器：
npm run preview -- --no-open
```

预览不调用模型。追问演示只记录请求，不会连接真实聊天。

### 在 DSH 中使用

```powershell
pwsh -NoProfile -File scripts/run-dsh.ps1 -Harness $env:DSH_SOURCE
```

默认端口 `3098`。若端口已被其他服务占用，可加 `-Port 3099`。`-Check` 只检查配置，`-NoOpen` 不打开浏览器。脚本生成 `preview/local.patch.yml`，创建独立的 `intelligent-ui` profile；未设置 `DSH_HOME` 时使用被 Git 忽略的 `artifacts/dsh-home`。

在 DSH 设置中配置你自己的模型服务。访问令牌、模型密钥、会话和本机代理均不属于项目源码。若图片/地图网络需要代理，可复制 `preview/images-network.example.yml` 为 `preview/images-network.patch.yml`，填写本机配置，再通过 `-ImageNetworkPatch` 指定；此文件不会进入 Git。

试用提示词：

```text
生成一个交互式单摆演示，可调摆长与重力加速度，支持开始、暂停、重置，显示周期公式、单位和理想模型的假设。
```

```text
用交互地图介绍北京故宫、天坛、颐和园，按地点名称自动定位，各配一张相关图片，提供行程播放；介绍文字附来源超链接。
```

```text
Create a retro interactive gaming console that I can play.
```

复杂游戏或物理模拟的正确性仍取决于模型生成代码，需要实际操作检查；运行容器具备交互能力，不代表任意一次生成都正确。

## 独立 MCP

```sh
npm run build
npm run verify:mcp
npm run mcp
```

构建会生成本机可用的 `preview/mcp.config.json`，请将其中配置填到支持 stdio 的 MCP 客户端。它包含本机绝对路径，已被 Git 忽略，不应作为公共配置提交。

`dist/mcp` 是独立运行包：将整个目录复制到目标机器，在该目录执行 `npm install --ignore-scripts`、`node mcp-stdio.js` 即可；运行此包无需 DSH、React 或浏览器服务。构建该包仍需要上述开发环境。网络地图准备可能访问固定上游来源；MCP 不具备 DSH 的地名解析、图片下载及聊天确认桥接。

## 开发与测试

```sh
npm run build
npm run check
# Windows 有 Edge 时会自动使用；其他情况安装 Chromium：
npx playwright install chromium
npm test
npm run verify:mcp
npm run audit:release
```

也可通过 `DSH_TEST_BROWSER` 指定已安装 Chromium 系浏览器的可执行文件。测试不发送真实模型消息；会使用已构建 DSH 的模块验证集成，并产生被忽略的 `artifacts/`。真实百科照片回放检查为可选项：用 `DSH_LIVE_IMAGE_FIXTURE` 指向已准备的 v3 文档 JSON；没有时只跳过该项，其他图片测试仍执行。

目录说明、运行契约和开发注意事项见 [架构](docs/architecture.md)、[运行 API](docs/runtime.md) 和 [开发说明](docs/development.md)。

## 数据、网络与边界

生成代码运行在独立来源 iframe，使用 CSP 与消息桥接；外链、追问需要宿主确认。HTML 片段不能直接装载远程脚本、任意 iframe 或使用任意网络请求。图片和默认街道数据由 Host 受控获取，成功保存的文档可以离线重放；首次获取仍需联网，地图保存范围以外不承诺完整路网。旧版 NASA/USGS 地图模式可能使用固定来源的远程图块。

会议时间选择不等于预订会议；工作流快照不推进原生任务；独立 HTML 导出不提供真实聊天服务。更多实现边界见运行文档。

## 发布与许可

Git 仅管理源码、自动化测试、必要说明、依赖锁文件与第三方资源许可。验收报告、历史比较、个人 TODO、截图、模型输出、会话、日志和本机配置不纳入仓库。构建和测试产物由 `.gitignore` 排除。

本项目采用 [MIT 许可证](LICENSE)。第三方资源沿用各自许可，详见 [第三方说明](THIRD_PARTY_NOTICES.md)、`vendor/` 和地图测试数据的 [署名](tests/fixtures/MAP-DATA-NOTICE.md)。
