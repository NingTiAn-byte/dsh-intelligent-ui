# 运行契约 / Runtime contract

## 文档 / Documents

基本字段为 `version`, `title`, `description`, `html`, `css`, `javascript`, `height`。HTML 是 body 片段；脚本放在独立的 `javascript` 字段，不能靠 HTML 中的 script、事件属性或远程资源执行代码。

The document contains separate HTML, CSS and JavaScript fields. HTML is a body fragment. Script execution belongs in the dedicated JavaScript field, not embedded HTML or remote assets.

| 版本 / Version | 保存内容 / Saved content |
| --- | --- |
| v1 | 基本文档 / Basic document |
| v2 | 基本文档与非空库声明 / Basic document and nonempty library declarations |
| v3 | 基本文档与已验证图片，可带库声明 / Saved validated images and optional library declarations |

初始高度为 180～900 px，实际可由 Host 配置收紧；客户端根据内容自动测高至 180～4000 px。源码文字总量上限为 200000 字符。v3 图片数量最多四张，每张默认上限 256000 字节。完整校验以 `src/shared/document.ts` 与 `src/shared/images.ts` 为准。

Initial height is 180–900 px, subject to Host limits. Automatic content measurement spans 180–4000 px. Total source text is capped at 200000 characters. v3 supports up to four images, normally capped at 256000 bytes each. The shared validators are authoritative.

## 桥接 API / Bridge API

脚本可使用 `window.dshUI`（Bridge v3）：

```javascript
const theme = window.dshUI.getTheme();
const stopTheme = window.dshUI.onThemeChange(next => {
  // Update custom visuals without recreating form or game state.
});
const stopRuns = window.dshUI.onRunStatus(event => {
  // Correlate by event.requestId; model completion is a separate event.
});
try {
  const receipt = await window.dshUI.sendPrompt('请解释当前计算结果');
  // The Promise reports confirmation/queue acceptance, not model completion.
} catch (error) {
  // Handle cancellation, unsupported standalone actions or host errors.
}
```

其他方法：`openLink(httpsUrl)`、`onReceipt(listener)`、`getRunStatuses()`、`reportError(error)`。监听返回取消订阅函数。运行状态为 `queued/running/completed/failed/cancelled/unknown`，只有 `completed` 表示对应模型轮次完成；响应正文在 DSH 对话中查看。

Other methods are `openLink`, `onReceipt`, `getRunStatuses` and `reportError`. Subscriptions return an unsubscribe function. Confirmation receipts and model-run statuses are separate. Read the actual model response in the DSH conversation.

宿主验证每次挂载的随机 channel；生成代码不应直接操作父页面。独立文件不提供真实会话桥接。脚本错误、未处理 Promise 拒绝和部分资源/CSP 错误可反馈到宿主；死循环或浏览器进程崩溃不在此错误监听保证范围内。

Host messages are validated against the mount's random channel. Generated code must not manipulate the parent DOM. Standalone files cannot send live chat messages. Error reporting covers browser-reported errors, not recovery from infinite loops or browser-process crashes.

## 主题与库 / Theme and libraries

通用样式使用 `--iui-bg`, `--iui-text`, `--iui-muted`, `--iui-border`, `--iui-accent` 等变量；完整 token 和组件类见 `src/shared/design-system.ts`。自定义皮肤可覆盖低优先级的基础控件样式。

Use shared `--iui-*` variables and the component styles in `src/shared/design-system.ts`. Base controls have low specificity so custom skins can override them.

图表声明 `libraries: ["chartjs-4.5.1"]`，脚本使用全局 `Chart`。图表 canvas 放在有明确内容高度的相对定位容器中。地图库标识为 `leaflet-1.9.4`；优先用 Host 的受控地图工具生成真实保存区域。不要注入 CDN 或任意网络请求。

Declare `chartjs-4.5.1` to use global `Chart`; give the canvas a relatively positioned container with an explicit content height. Leaflet's identifier is `leaflet-1.9.4`; prefer controlled map preparation. Do not inject CDNs or arbitrary fetch calls.

## 数据与可访问性 / Data and accessibility

控件行可使用 `.iui-control-row`，A/B 等一组动作键可使用 `.iui-action-keys`。控件组会按自身容器的宽度换行，适用于宽页面里的窄侧栏；不要仅依赖视口断点。方向键、动作键和间距的总宽度超过面板内容宽度时，应分行，保留可点击尺寸，避免用隐藏溢出或负偏移掩盖问题。这些类需生成文档主动采用，不会自动重排任意历史 HTML。

Use `.iui-control-row` for wrapping control groups and `.iui-action-keys` for grouped action buttons. Wrapping follows the actual container width, including narrow desktop sidebars. Keep usable targets instead of hiding overflow or applying negative offsets. These classes are opt-in; they do not automatically rewrite arbitrary saved HTML.

数值需说明单位、假设与来源；模拟数据应明确标识。图片保留作者、许可与来源，地点介绍用文字超链接，不必把内部定位坐标展示给用户。动画提供暂停和重置，控件保留键盘操作、标签与可见焦点。

Keep units, assumptions, provenance and image attribution visible. Link location descriptions to their sources. Provide pause/reset controls for animation and keyboard-accessible labelled controls with visible focus.
