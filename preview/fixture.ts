import type { UiDocument } from '../src/shared/document.ts'
export const fixture: UiDocument = {
  version: 1, title: 'DSH 工具调用：动手看看数据怎么流转',
  description: '本地演示，不调用模型、不连接业务数据库。调整数量，查看普通 JavaScript 如何计算结果；按钮可以向宿主提议追问。',
  height: 430,
  html: `<h2>提问 → 工具 → 数据 → 界面</h2><p>交互计算器只是其中一种界面，不需要销售或订单系统。</p><label>数量 <input id="count" type="range" min="1" max="10" value="3"></label><p>数量：<strong id="quantity">3</strong> × 单价 12 = <strong id="total">36</strong></p><svg viewBox="0 0 600 90" role="img" aria-label="工具处理流程"><g fill="var(--iui-accent-soft)" stroke="var(--iui-accent)"><rect x="0" y="10" width="130" height="60" rx="10"/><rect x="155" y="10" width="130" height="60" rx="10"/><rect x="310" y="10" width="130" height="60" rx="10"/><rect x="465" y="10" width="130" height="60" rx="10"/></g><g fill="var(--iui-text)" text-anchor="middle" font-size="17"><text x="65" y="46">用户提问</text><text x="220" y="46">工具执行</text><text x="375" y="46">结果留存</text><text x="530" y="46">界面展示</text></g></svg><button id="follow">追问这个过程</button>`,
  css: 'h2{font-size:1.3em}input{accent-color:var(--iui-accent)}svg{display:block;margin:var(--iui-space-6) 0}strong{color:var(--iui-accent)}',
  javascript: `document.getElementById('count').addEventListener('input',event=>{const n=Number(event.target.value);document.getElementById('quantity').textContent=String(n);document.getElementById('total').textContent=String(n*12)});document.getElementById('follow').addEventListener('click',()=>window.dshUI.sendPrompt('请用大白话解释工具结果为什么需要持久化，并举一个界面重放的例子。'));`,
}
