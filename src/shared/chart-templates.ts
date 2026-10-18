import type { UiDocument } from './document.ts'
import { CHART_LIBRARY } from './libraries.ts'

export function chartTemplate(type: 'line' | 'bar' | 'pie', theme: string, footer: string, followup: string): UiDocument {
  const names = { line: '折线图', bar: '柱状图', pie: '饼图' }
  const rows = [3200, 3500, 3000, 4000, 3600, 3800].map((amount, index) => `<tr><th scope="row">${index + 1} 月</th><td>6000.00</td><td>${amount.toFixed(2)}</td><td>${(6000 - amount).toFixed(2)}</td></tr>`).join('')
  return {
    version: 2, libraries: [CHART_LIBRARY], title: `月度收支${names[type]}（演示数据）`,
    description: '内置六个月演示数据；收入和支出可编辑，结余为计算值，单位：元。饼图仅表示各月支出在累计支出中的占比。', height: 800,
    css: theme + '.chart-box{position:relative;height:320px;width:100%;margin:var(--iui-space-4) 0}.chart-box canvas{max-width:100%}.summary{font-weight:700;color:var(--iui-accent)}.empty{padding:var(--iui-space-6);border:1px dashed var(--iui-border);border-radius:var(--iui-radius-md);background:var(--iui-surface);text-align:center}',
    html: `<h2>月度收支与支出占比</h2><p class="note" id="chart-caption">来源：内置演示数据，不代表真实账单。折线/柱状图对比月收入与支出；饼图显示各月支出占比。单位：元。</p><div class="fields"><label for="chart-type">图表类型<select id="chart-type">${(['line', 'bar', 'pie'] as const).map(kind => `<option value="${kind}"${kind === type ? ' selected' : ''}>${names[kind]}</option>`).join('')}</select></label><label for="income">每月收入（元，0～1000000）<input id="income" type="number" min="0" max="1000000" step="0.01" value="6000"></label><label for="month">编辑月份<select id="month">${Array.from({ length: 6 }, (_, index) => `<option value="${index}">${index + 1} 月</option>`).join('')}</select></label><label for="amount">当月支出（元，0～1000000）<input id="amount" type="number" min="0" max="1000000" step="0.01" value="3200"></label></div><p id="validation" role="alert" class="error"></p><p id="summary" class="summary" aria-live="polite">累计收入 36000.00 元；累计支出 21100.00 元；结余 14900.00 元。</p><div id="chart-box" class="chart-box"><canvas id="budget-chart" role="img" aria-label="月度收支图，详细数据见下方表格" aria-describedby="chart-caption">请阅读下方收支数据表。</canvas></div><p id="chart-empty" class="empty" role="status" hidden></p><div class="table-scroll" role="region" aria-label="收支数据表，可横向滚动" tabindex="0"><table><caption>图表数据与计算值（元）</caption><thead><tr><th scope="col">月份</th><th scope="col">收入</th><th scope="col">支出</th><th scope="col">结余</th></tr></thead><tbody id="chart-rows">${rows}</tbody></table></div><div class="actions"><button id="clear-data" type="button">清空数据</button></div>${footer}`,
    javascript: `const initialType = ${JSON.stringify(type)};
const initialAmounts = [3200,3500,3000,4000,3600,3800];
const labels = ['1 月','2 月','3 月','4 月','5 月','6 月'];
function chartPalette() { const colors = window.dshUI.getTheme().colors; return [colors.chart1,colors.chart2,colors.chart3,colors.chart4,colors.chart5,colors.chart6]; }
function chartOptions(type) { const t=window.dshUI.getTheme(), c=t.colors, font={family:t.fontFamily,size:t.fontSize}; return {responsive:true,maintainAspectRatio:false,animation:false,locale:'zh-CN',color:c.text,font,plugins:{legend:{position:'bottom',labels:{color:c.text,font}},tooltip:{backgroundColor:c.raised,titleColor:c.text,bodyColor:c.text,borderColor:c.border,borderWidth:1,callbacks:{label:context=>context.dataset.label+': '+Number(context.raw).toFixed(2)+' 元'}}},...(type==='pie'?{}:{scales:{x:{ticks:{color:c.muted,font},grid:{color:c.grid},border:{color:c.border}},y:{beginAtZero:true,title:{display:true,text:'元',color:c.text,font},ticks:{color:c.muted,font},grid:{color:c.grid},border:{color:c.border}}}})}; }
const kind = document.getElementById('chart-type'), income = document.getElementById('income'), month = document.getElementById('month'), amount = document.getElementById('amount');
let amounts = [...initialAmounts], chart = null;
function restyleChart() { if (!chart) return; const c=window.dshUI.getTheme().colors, pie=chart.config.type==='pie'; chart.data.datasets.forEach((dataset,index)=>{dataset.backgroundColor=pie?chartPalette():(index===0?c.chart2:c.chart1);dataset.borderColor=pie?c.bg:(index===0?c.chart2:c.chart1);}); chart.options=chartOptions(chart.config.type);chart.update('none'); }
function destroyChart() { if (chart) { chart.destroy(); chart = null; } }
function setEmpty(message) { destroyChart(); document.getElementById('chart-box').hidden = true; const empty = document.getElementById('chart-empty'); empty.textContent = message; empty.hidden = false; }
function number(input) { if (!input.value.trim()) throw new Error('请填写收入和当月支出。'); const value = Number(input.value); if (!Number.isFinite(value) || value < 0 || value > 1000000) throw new Error('收入和支出须为 0～1000000 的有限数值。'); return Math.round(value * 100) / 100; }
function values() { const monthlyIncome = number(income); if (!amounts.length) throw new Error('暂无数据，请恢复默认值。'); const expense = number(amount); return { monthlyIncome, expense, total: amounts.reduce((a,b)=>a+b,0) }; }
function table(monthlyIncome) { const body = document.getElementById('chart-rows'); body.replaceChildren(); amounts.forEach((expense,index)=>{ const row = document.createElement('tr'); [labels[index],monthlyIncome.toFixed(2),expense.toFixed(2),(monthlyIncome-expense).toFixed(2)].forEach((value,column)=>{const cell = document.createElement(column===0?'th':'td');if(column===0)cell.scope='row';cell.textContent=value;row.appendChild(cell);});body.appendChild(row);}); }
function update() {
  document.getElementById('validation').textContent = '';
  if (!amounts.length) { setEmpty('暂无数据，请恢复默认值。'); document.getElementById('summary').textContent = '暂无数据。'; document.getElementById('chart-rows').replaceChildren(); document.getElementById('followup').disabled = true; return; }
  try {
    const monthlyIncome = number(income), expense = number(amount); amounts[Number(month.value)] = expense;
    const total = amounts.reduce((a,b)=>a+b,0), totalIncome = monthlyIncome * amounts.length;
    document.getElementById('summary').textContent = '累计收入 '+totalIncome.toFixed(2)+' 元；累计支出 '+total.toFixed(2)+' 元；结余 '+(totalIncome-total).toFixed(2)+' 元。'; table(monthlyIncome);
    document.getElementById('followup').disabled = followupBusy;
    if (kind.value === 'pie' && total === 0) { setEmpty('累计支出为 0，无法计算占比。可查看下方数据表。'); return; }
    document.getElementById('chart-empty').hidden = true; document.getElementById('chart-box').hidden = false;
    const c = window.dshUI.getTheme().colors;
    const datasets = kind.value === 'pie' ? [{label:'支出（元）',data:[...amounts],backgroundColor:chartPalette(),borderColor:c.bg}] : [{label:'收入（元）',data:amounts.map(()=>monthlyIncome),borderColor:c.chart2,backgroundColor:c.chart2,tension:.2},{label:'支出（元）',data:[...amounts],borderColor:c.chart1,backgroundColor:c.chart1,tension:.2}];
    if (chart && chart.config.type === kind.value) { chart.data = { labels:[...labels], datasets }; restyleChart(); }
    else { destroyChart(); chart = new window.Chart(document.getElementById('budget-chart'), {type:kind.value,data:{labels:[...labels],datasets},options:chartOptions(kind.value)}); }
  } catch(error) { setEmpty('图表已暂停，可修正输入后重试。'); document.getElementById('validation').textContent = error.message; document.getElementById('summary').textContent = '输入无效，图表已暂停。'; document.getElementById('chart-rows').replaceChildren(); document.getElementById('followup').disabled = true; if (!(error.message.includes('请填写') || error.message.includes('有限数值'))) window.dshUI.reportError(error); }
}
kind.addEventListener('change',update); income.addEventListener('input',update); amount.addEventListener('input',update);
month.addEventListener('change',()=>{amount.value=String(amounts[Number(month.value)]);update();});
document.getElementById('clear-data').addEventListener('click',()=>{amounts=[];amount.value='';amount.disabled=true;month.disabled=true;update();});
document.getElementById('reset').addEventListener('click',()=>{amounts=[...initialAmounts];income.value='6000';month.value='0';amount.value='3200';amount.disabled=false;month.disabled=false;kind.value=initialType;update();});
${followup}
window.dshUI.onThemeChange(restyleChart);
wireFollowup(()=>{const v=values();return '请解释当前'+kind.options[kind.selectedIndex].text+'：每月收入 '+v.monthlyIncome.toFixed(2)+' 元；各月支出 '+amounts.map((value,index)=>labels[index]+' '+value.toFixed(2)+' 元').join('、')+'；累计支出 '+v.total.toFixed(2)+' 元；累计结余 '+(v.monthlyIncome*amounts.length-v.total).toFixed(2)+' 元。以上为演示数据。';});
update();`,
  }
}
