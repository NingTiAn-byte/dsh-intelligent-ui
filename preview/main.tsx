import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import { Widget } from '../src/client/widget.tsx'
import { zh } from '../src/client/copy.ts'
import { fixture } from './fixture.ts'
import { getTemplate, type TemplateName } from '../src/shared/templates.ts'
import { makeTheme, themeVariables, type UiScheme } from '../src/shared/theme.ts'
import { TableCard } from '../src/client/table.tsx'
const table = { version: 1 as const, title: '季度收入（演示数据）', columns: ['季度', '收入（元）', '备注'], rows: [['Q1', '100', '用户提供的示例'], ['Q2', '200', '<script>这里只是文字</script>']], source: '本地预览的合成数据，不代表真实业务' }
function Preview() {
  const [template, setTemplate] = useState<TemplateName | 'original' | 'table'>('original')
  const [doc, setDoc] = useState(fixture)
  const [preference, setPreference] = useState<UiScheme | 'system'>('system')
  const [systemScheme, setSystemScheme] = useState<UiScheme>(() => matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  const theme = makeTheme(preference === 'system' ? systemScheme : preference)
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)')
    const change = () => setSystemScheme(media.matches ? 'dark' : 'light')
    media.addEventListener('change', change); return () => media.removeEventListener('change', change)
  }, [])
  useEffect(() => {
    document.documentElement.style.colorScheme = theme.scheme
    document.body.style.background = theme.colors.surface; document.body.style.color = theme.colors.text
  }, [theme.scheme])
  return <main style={{ ...themeVariables(theme), maxWidth: 900, margin: '40px auto', padding: 16, fontFamily: theme.fontFamily }}>
  <h1>DSH Intelligent UI · 本地预览</h1>
  <p>这里使用与 DSH 插件相同的界面和沙箱组件。发送按钮仅把提问显示在页面下方；安装到 DSH 后会进入当前会话。</p>
  <label>预览主题 <select aria-label="预览主题" value={preference} onChange={event => setPreference(event.target.value as UiScheme | 'system')}><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label>{' '}
  <label>选择示例 <select value={template} onChange={event => {
    const next = event.target.value as typeof template
    setTemplate(next); if (next !== 'table') setDoc(next === 'original' ? fixture : getTemplate(next)); document.getElementById('sent')!.textContent = ''
  }}><option value="original">原有演示</option><option value="calculator">计算器模板</option><option value="comparison">方案对比模板</option><option value="flowchart">分步流程模板</option><option value="chart_line">离线折线图</option><option value="chart_bar">离线柱状图</option><option value="chart_pie">离线饼图</option><option value="table">受控结构化表格</option></select></label>
  {template === 'table' ? <TableCard table={table} title={table.title} phase="ready" callId="preview-table" theme={theme} t={key => zh[key]} /> : <Widget key={template} document={doc} theme={theme} t={(key, params) => zh[key].replace('{message}', params?.message ?? '')}
    sendPrompt={async text => { document.getElementById('sent')!.textContent = text }} />}
  <p id="sent" role="status" />
</main>
}
createRoot(document.getElementById('root')!).render(<Preview />)
