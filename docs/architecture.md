# 架构 / Architecture

## 目录 / Layout

| 路径 / Path | 职责 / Responsibility |
| --- | --- |
| `src/index.ts` | Cordis Host 插件入口、工具与配置 / Host entry, tools and configuration |
| `src/host/` | 地点、图片、地图、展示路由、追问运行关联 / Places, images, maps, routing, follow-up correlation |
| `src/client/` | DSH 聊天节点、iframe、桥接、主题、流式状态 / Conversation nodes, iframe, bridge, theme and streaming |
| `src/shared/` | 文档校验、模板、样式、结构化组件 / Validation, templates, styles and controlled documents |
| `src/mcp/` | 独立 stdio MCP 服务 / Standalone stdio MCP server |
| `preview/` | 离线演示与浏览器测试页面的源码 / Offline preview and browser test entry points |
| `tests/` | 自动化单元、Host 集成和真实浏览器测试 / Unit, Host integration and real-browser tests |
| `vendor/` | 固定版本的图库、地图库和许可 / Pinned chart/map assets and licenses |
| `scripts/` | 构建、类型检查、启动、MCP 验证与发布检查 / Build, typecheck, launch, MCP and publication checks |

## 文档生命周期 / Document lifecycle

1. DSH 模型通过工具提供 HTML、CSS、JavaScript 或结构化参数。共享代码验证版本、大小与字段。
2. Host 获取必要的受控图片、街道区域与来源，将结果存入工具 metadata。客户端使用持久聊天节点展示结果。
3. 流式阶段只显示静态预览；工具成功后在同一 iframe 中启用脚本一次。失败或取消不激活脚本。
4. iframe 与父页面通过随机 channel、来源验证和受限消息类型通信。追问及外链在父页面确认后才执行。
5. 已保存的文档可从历史会话恢复；导出装配同一运行时、当前主题和保存资源，生成单文件 HTML。

The model supplies source or structured tool parameters. The Host validates and persists metadata, including controlled assets when needed. Persistent client nodes render a static stream preview, then activate scripts once after success. A validated bridge handles confirmed host actions. Replay and export reuse the saved document and runtime.

## 集成边界 / Integration boundaries

- DSH 自有模块由源码 checkout 提供；普通运行依赖和开发工具由本项目锁文件管理。
- React 通过 DSH 的客户端模块工厂协议共享，不向宿主注入另一份 React 身份。
- 独立 MCP 复用文档校验与装配代码，返回 HTML 文本与结构化结果。MCP 本身不创建聊天卡片，也不拥有 DSH 的会话权限。
- 只读工作流是展示快照，原生 todo/plan 才是任务状态来源。会议选择通过原生人工问答，不创建日历事件。

DSH owns its runtime modules, model configuration, sessions, task state and human questions. The client shares the host React identity. Standalone MCP reuses validation and assembly but cannot assume a rendering surface or a live DSH conversation.
