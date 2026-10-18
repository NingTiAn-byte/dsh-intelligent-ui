import type { UiDocument } from './document.ts'
import { chartTemplate } from './chart-templates.ts'
import { TEMPLATE_STYLES } from './theme.ts'
import { DESIGN_GUIDANCE } from './design-system.ts'

export const TEMPLATE_NAMES = ['calculator', 'comparison', 'flowchart', 'chart_line', 'chart_bar', 'chart_pie'] as const
export type TemplateName = typeof TEMPLATE_NAMES[number]

const theme = TEMPLATE_STYLES
const followup = `
let followupBusy = false;
function wireFollowup(makeText) {
  const button = document.getElementById('followup');
  const status = document.getElementById('bridge-status');
  let latestRequest = null;
  const runLabels = {queued:'已接收，等待运行。',running:'模型处理中…',completed:'对应模型轮次已完成，请在对话中查看回复。',failed:'模型运行失败或回复不完整，请查看对话。',cancelled:'排队消息已移除或模型运行已停止。',unknown:'暂无法确认运行结果，请查看对话。'};
  function showRun(value) { if (!latestRequest || value.requestId === latestRequest) status.textContent = runLabels[value.status]; }
  window.dshUI.onRunStatus?.(showRun);
  window.dshUI.onReceipt(receipt => {
    if (receipt.status === 'pending-confirmation') { latestRequest = receipt.requestId; status.textContent = '等待你在界面外确认。'; }
    if (receipt.status === 'sending') status.textContent = '正在提交到当前对话…';
  });
  button.addEventListener('click', async () => {
    if (followupBusy) return;
    followupBusy = true;
    button.disabled = true;
    try {
      const text = makeText();
      const receipt = await window.dshUI.sendPrompt(text);
      status.textContent = receipt.status === 'queued' ? '已入队；请在 DSH 对话中查看模型回复。' : receipt.status;
      const known = window.dshUI.getRunStatuses?.().find(row => row.requestId === receipt.requestId);
      if (known) showRun(known);
    } catch (error) {
      status.textContent = error.code === 'CANCELLED' ? '已取消，没有发送。' : '未能提交：' + error.message;
    } finally { followupBusy = false; button.disabled = false; document.querySelector('input')?.dispatchEvent(new Event('input')); }
  });
}
`
const footer = `<div class="actions"><button id="reset" type="button">恢复默认值</button><button class="iui-primary" id="followup" type="button">解释当前结果</button></div><p id="bridge-status" role="status" aria-live="polite"></p>`
const templates: Record<TemplateName, UiDocument> = {
  chart_line: chartTemplate('line', theme, footer, followup),
  chart_bar: chartTemplate('bar', theme, footer, followup),
  chart_pie: chartTemplate('pie', theme, footer, followup),
  calculator: {
    version: 1, title: '数量与单价计算器', description: '示例数据；数量与单价由用户输入，总价为计算值。单位：件、元/件、元。', height: 400,
    css: theme,
    html: `<h2>数量 × 单价</h2><p class="note">演示初始值，不是实时价格。公式：总价 = 数量 × 单价。</p><div class="fields"><label for="quantity">数量（件，1～100）<input id="quantity" type="number" min="1" max="100" step="1" value="3"></label><label for="price">单价（元/件，0～10000）<input id="price" type="number" min="0" max="10000" step="0.01" value="12"></label></div><p id="validation" role="alert" class="error"></p><p class="result">总价：<output id="total" aria-live="polite">36.00</output> 元</p>${footer}`,
    javascript: `const quantity = document.getElementById('quantity'); const price = document.getElementById('price');
function values() {
  if (!quantity.value.trim() || !price.value.trim()) throw new Error('请填写数量和单价。');
  const count = Number(quantity.value), unitPrice = Number(price.value);
  if (!Number.isFinite(count) || !Number.isInteger(count) || count < 1 || count > 100 || !Number.isFinite(unitPrice) || unitPrice < 0 || unitPrice > 10000) throw new Error('数量须为 1～100 的整数，单价须在 0～10000 之间。');
  return { count, unitPrice, total: count * unitPrice };
}
function update() {
  try { const v = values(); document.getElementById('total').textContent = v.total.toFixed(2); document.getElementById('validation').textContent = ''; document.getElementById('followup').disabled = followupBusy; }
  catch (error) { document.getElementById('total').textContent = '—'; document.getElementById('validation').textContent = error.message; document.getElementById('followup').disabled = true; }
}
quantity.addEventListener('input', update); price.addEventListener('input', update);
document.getElementById('reset').addEventListener('click', () => { quantity.value = '3'; price.value = '12'; update(); });
${followup}
wireFollowup(() => { const v = values(); return '请解释数量 ' + v.count + ' 件 × 单价 ' + v.unitPrice.toFixed(2) + ' 元/件 = ' + v.total.toFixed(2) + ' 元的计算，以及数量增加 1 件的影响。'; });
update();`,
  },
  comparison: {
    version: 1, title: '可排序方案对比表', description: '三种方案均为明确标注的演示数据，不代表真实商品或测评；价格单位为元。', height: 450,
    css: theme,
    html: `<h2>方案对比</h2><p class="note">来源：内置示例，评分为假设。可更改排序并选择一个方案追问。</p><label for="sort">排序方式<select id="sort"><option value="price">价格从低到高</option><option value="score">示例评分从高到低</option></select></label><div class="table-scroll" role="region" aria-label="方案对比表，可横向滚动" tabindex="0"><table><caption>演示方案价格与评分</caption><thead><tr><th scope="col">方案</th><th scope="col">价格（元）</th><th scope="col">假设评分（满分 10）</th><th scope="col">选择</th></tr></thead><tbody id="rows"></tbody></table></div><p id="selected" role="status"></p>${footer}`,
    javascript: `const rows = [{id:'a',name:'方案 A',price:80,score:7},{id:'b',name:'方案 B',price:120,score:9},{id:'c',name:'方案 C',price:100,score:8}];
let selected = 'a'; const sort = document.getElementById('sort');
function renderRows() {
  const ordered = [...rows].sort((a,b) => sort.value === 'score' ? b.score-a.score : a.price-b.price);
  const body = document.getElementById('rows'); body.replaceChildren();
  ordered.forEach(row => { const tr = document.createElement('tr'); [row.name,row.price.toFixed(2),String(row.score)].forEach(value => { const cell = document.createElement('td'); cell.textContent = value; tr.appendChild(cell); });
    const cell = document.createElement('td'), button = document.createElement('button'); button.type = 'button'; button.textContent = '选择 ' + row.name; button.setAttribute('aria-pressed',String(selected === row.id));
    button.addEventListener('click', () => { selected = row.id; renderRows(); }); cell.appendChild(button); tr.appendChild(cell); body.appendChild(tr); });
  document.getElementById('selected').textContent = '当前选择：' + rows.find(row => row.id === selected).name;
}
sort.addEventListener('change',renderRows); document.getElementById('reset').addEventListener('click',()=>{selected='a';sort.value='price';renderRows();});
${followup}
wireFollowup(() => { const row = rows.find(row => row.id === selected); return '请比较当前选择的' + row.name + '（示例价格 ' + row.price + ' 元，假设评分 ' + row.score + '/10），说明与其他演示方案的差异，不要把示例当成真实测评。'; }); renderRows();`,
  },
  flowchart: {
    version: 1, title: '工具调用流程分步解释', description: '通用流程示意，不读取当前会话的实时运行状态；每个步骤均可选择并进一步追问。', height: 420,
    css: theme,
    html: `<h2>从提问到交互界面</h2><p class="note">流程示意，非实时监控。点击步骤或使用前进/后退。</p><svg viewBox="0 0 600 100" role="img" aria-label="提问、工具执行、界面展示三个步骤"><g fill="var(--iui-accent-soft)" stroke="var(--iui-accent)"><rect x="5" y="10" width="175" height="70" rx="8"/><rect x="210" y="10" width="175" height="70" rx="8"/><rect x="415" y="10" width="175" height="70" rx="8"/><path d="M180 45H210M385 45H415"/></g><g text-anchor="middle" fill="var(--iui-text)" font-size="18"><text x="92" y="52">用户提问</text><text x="297" y="52">工具执行</text><text x="502" y="52">界面展示</text></g></svg><div class="actions" aria-label="流程步骤"><button type="button" data-step="0">1 提问</button><button type="button" data-step="1">2 工具</button><button type="button" data-step="2">3 界面</button></div><p id="step-detail" role="status" aria-live="polite"></p><div class="actions"><button id="previous" type="button">上一步</button><button id="next" type="button">下一步</button></div>${footer}`,
    javascript: `const steps = ['用户提出问题，模型判断需要文字还是交互界面。','生成时展示静态预览；工具检查参数并保存界面文档，工具成功不等于浏览器运行已验证。','工具成功后，客户端在同一隔离 iframe 中启用交互；结果独立于过程折叠。']; let step = 0;
function show() { document.getElementById('step-detail').textContent = (step+1) + '/3：' + steps[step]; document.querySelectorAll('[data-step]').forEach(button => button.setAttribute('aria-pressed',String(Number(button.dataset.step)===step))); document.getElementById('previous').disabled=step===0; document.getElementById('next').disabled=step===2; }
document.querySelectorAll('[data-step]').forEach(button=>button.addEventListener('click',()=>{step=Number(button.dataset.step);show();}));
document.getElementById('previous').addEventListener('click',()=>{step=Math.max(0,step-1);show();}); document.getElementById('next').addEventListener('click',()=>{step=Math.min(2,step+1);show();}); document.getElementById('reset').addEventListener('click',()=>{step=0;show();});
${followup}
wireFollowup(()=>'请用通俗语言解释工具调用流程中的第 '+(step+1)+' 步：'+steps[step]); show();`,
  },
}

/** Return a fresh, editable template document; loading a template never renders or sends a prompt. */
export function getTemplate(name: TemplateName): UiDocument {
  if (!Object.prototype.hasOwnProperty.call(templates, name)) throw new Error('Unknown Intelligent UI template')
  const document = templates[name]
  return { ...document, ...(document.libraries ? { libraries: [...document.libraries] } : {}) }
}

export const GENERATION_GUIDANCE = `Intelligent UI generation guide:
${DESIGN_GUIDANCE}
Use render_intelligent_ui only when a visual or interaction helps the actual task. Use get_intelligent_ui_template for calculator, comparison or flowchart starting points; adapt labels, formulas and data, then call render_intelligent_ui with title, description, html, css, javascript and height. Loading a template alone does not display it.
For progressive preview, emit fields in this order: title, description, height, css, html, javascript. Finish CSS before HTML, then send HTML in natural document order. The client shows an inert static preview as HTML arrives; JavaScript runs once, only after a successful tool result. A cancelled or failed call never activates its preview. Completion keeps the same iframe outside process details; do not wait for the entire reply to finish.
The bridge runtime is version 3. sendPrompt(text) still resolves only at queue acceptance with modelCompleted:false. Use optional onRunStatus(listener) and getRunStatuses() for independent version:1 run updates keyed by requestId. States: queued, running, completed, failed, cancelled, unknown; only completed has modelCompleted:true. A completed model turn does not certify answer correctness or tool success. The response itself stays in the conversation. Keep multiple requests separate and do not let an older result replace a newer request status. These subscriptions do not send messages; never auto-resend on unknown or failed.
Use offline DOM, SVG or Canvas. No arbitrary external resources, inline HTML handlers, script tags or form tags. Put behavior in javascript with addEventListener. Inputs need labels, finite/range checks and explicit zero-denominator handling. Distinguish user inputs, sourced values, calculations and illustrative assumptions; show units, formulas and provenance inside the UI. Use textContent for untrusted text, responsive widths, keyboard focus, textual diagram alternatives and reduced-motion rules.
For article photos, add images:[{id,wikipediaTitle,language:'en'|'zh',alt}] to render_intelligent_ui (1–4 unique IDs, title<=160, alt<=300). Emit images before html. Use <figure data-iui-image="ID"></figure> placeholders. The host retrieves the article's reusable Commons illustration and matching creator/license, fully validates bounded raster bytes with DSH, and saves them in a v3 document. It creates visible credits and concise failure states automatically. Keep the card focused on the subject and source credits. Do not add testing or implementation notes, generic real-time disclaimers, cache/offline notices or descriptions of fallback/replacement policy. Discuss capability limits only when relevant to the user's actual question. Requests require network when generating; saved pixels and HTML exports replay offline. There is no arbitrary image URL, image generation or general image search API, and no maps in this feature. Do not use img src, fetch, CSS image URLs, a CDN or base64 supplied by the model. Do not print returned image dataUrl values in PTC logs. Images remain inactive in streaming previews; scripts and image hydration activate after tool success. Saved v1/v2 documents remain compatible; Chart.js and images may coexist in v3.
The host follows DSH's resolved light/dark/system theme and content fonts without recreating the iframe. Use semantic CSS variables: --iui-bg, --iui-surface, --iui-raised, --iui-text, --iui-muted, --iui-border, --iui-accent, --iui-accent-soft, --iui-error, --iui-success, --iui-warning, --iui-focus, --iui-chart1..6, --iui-grid, --iui-font-family, --iui-font-size, --iui-space-1/2/3/4/6 and --iui-radius-sm/md/lg. Shared base styles cover inputs/buttons, .fields, .actions, .card, .badge, .note, .result, .error and tables. Avoid fixed body foreground/background colors. window.dshUI.getTheme() returns a read-only {version:1,scheme,colors,fontFamily,fontSize}; onThemeChange(listener) returns an unsubscribe function. For Canvas/Chart.js update colors/fonts on the existing instance with chart.update('none'), without rebuilding the DOM/chart, clearing form values, changing legend visibility or sending follow-ups. Read the chart templates for this pattern. Export locks the current resolved theme and replays document default inputs; it does not stay connected to DSH or follow a later OS theme change.
Offline Chart.js 4.5.1 is available only when libraries:["chartjs-4.5.1"] is declared in render_intelligent_ui. Emit libraries after height and before css/html/javascript. The host saves a v2 document; omit libraries (or use []) for unchanged v1 documents. Never paste the library, add script tags, import modules, or fetch a CDN. window.Chart is loaded locally before your successful generated script; no Chart or generated code runs during preview. Read chart_line, chart_bar or chart_pie templates for responsive line/bar/pie charts with editable data, legend, source, units, validation and a readable data table. Use a dedicated position:relative canvas container with an explicit content height, responsive:true and maintainAspectRatio:false; avoid iframe-relative vh heights. Update data with chart.update(); call chart.destroy() before reusing a canvas or changing chart type. The runtime also destroys orphaned instances and disposes them when the frame closes. No time/date adapters or external Chart.js plugins are provided. Pass template fields including libraries, excluding version, to render_intelligent_ui.
The host automatically measures content height and reports script/async/policy errors outside the iframe. height is an initial estimate (180..900), not a reason to force fixed body height. Prefer natural content flow; auto-height is bounded at 4000px and larger content scrolls.
window.dshUI.sendPrompt(text) and openLink(httpsUrl) return Promises after host confirmation. sendPrompt resolves with {requestId,status:'queued',modelCompleted:false}: this confirms queue acceptance, not a completed model response. Disable the initiating button while awaiting; catch cancellation/failure and restore it in finally. onReceipt(listener) exposes pending-confirmation/sending and terminal states. Include current selected values in follow-ups; never submit on load, input changes or timers. No cross-call DOM patch API or automatic persistence of form values. Use dshUI.reportError(error) for caught initialization failures. Never collect secrets in generated UI.`
