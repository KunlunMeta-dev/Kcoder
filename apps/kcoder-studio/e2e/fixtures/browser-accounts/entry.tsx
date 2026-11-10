import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { createInstance } from 'i18next'
import { initReactI18next, I18nextProvider } from 'react-i18next'
import { BrowserAccountControls, type BrowserAccountChoice } from '../../../renderer/src/components/layout/workspace-panels/BrowserAccountControls'
import workbench from '../../../renderer/src/i18n/locales/zh-CN/common-workbench.json'
import '../../../renderer/src/styles/globals.css'
const i18n=createInstance()
await i18n.use(initReactI18next).init({lng:'zh-CN',resources:{'zh-CN':{common:workbench}}})
function Preview() {
 const [choice,setChoice]=useState<BrowserAccountChoice|null>(null)
 return <main className="min-h-screen bg-background p-6 text-text-primary">
   <header className="flex items-center justify-between gap-3 border-b border-border pb-4"><span className="font-medium">KCoder Studio · 浏览器</span><BrowserAccountControls label="layout-browser" choice={choice} onSelect={async value=>setChoice(value)}/></header>
   <p className="mt-6 text-sm text-text-muted">界面预览 · 合成账户资料，未连接网站、Native 或模型。</p>
   <p className="mt-3 text-sm" data-testid="selected-account">{choice?.profile.draft.label??'临时会话'}</p>
 </main>
}
createRoot(document.getElementById('root')!).render(<I18nextProvider i18n={i18n}><Preview/></I18nextProvider>)
