/* OCS 本地 AI 题库 · 控制台前端（Vue 3 + Element Plus，本地 vendor，无需构建） */
function showFatal(msg) {
  const box = document.getElementById('fatal')
  if (!box) { document.body.insertAdjacentHTML('beforeend', `<pre id="fatal" style="position:fixed;inset:0;background:#1d1e1f;color:#ff6b6b;padding:24px;font:13px/1.6 monospace;white-space:pre-wrap;z-index:99999;">${msg}</pre>`); return }
  box.textContent = msg
}
window.addEventListener('error', (e) => showFatal('页面运行错误：\n' + (e.error ? (e.error.stack || e.error.message) : e.message)))
window.addEventListener('unhandledrejection', (e) => showFatal('未处理的 Promise 异常：\n' + ((e.reason && (e.reason.stack || e.reason.message)) || e.reason)))

function need(name, obj) {
  if (!obj) { const m = `缺少全局依赖 ${name}，请检查 /vendor 文件是否加载成功`; showFatal(m); throw new Error(m) }
  return obj
}

const Vue_ = need('Vue', typeof Vue !== 'undefined' ? Vue : null)
const ElementPlus_ = need('ElementPlus', typeof ElementPlus !== 'undefined' ? ElementPlus : null)
const { createApp, ref, reactive, onMounted } = Vue_
const ElMessage = (ElementPlus_ && ElementPlus_.ElMessage) || function () {}
// 中文语言包（本地 vendor，失败则回退英文避免整页崩溃）
const zhCn = (typeof ElementPlusLocaleZhCn !== 'undefined') ? ElementPlusLocaleZhCn : null

const LAST_KEY = 'aibank.lastConfig'

function api(url, opts = {}) {
  opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {})
  if (!opts.headers['Authorization'] && window.__token) opts.headers['Authorization'] = 'Bearer ' + window.__token
  return fetch(url, opts).then(async (res) => {
    if (!res.ok) {
      let msg = res.status + ' ' + res.statusText
      try { const j = await res.json(); if (j && j.error) msg = j.error } catch {}
      throw new Error(msg)
    }
    const ct = res.headers.get('content-type') || ''
    return ct.includes('application/json') ? res.json() : res.text()
  })
}

function fmtTime(ts) {
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function typeLabel(t) {
  return { single: '单选', multiple: '多选', judgement: '判断', completion: '填空' }[t] || t || '—'
}

// 去掉上游模型名里形如 "· x0.00→免费" / "· x0.05 X" 的倍率噪点
function cleanModelName(name) {
  if (!name || typeof name !== 'string') return ''
  return name.replace(/\s*[·•・]\s*x\d*\.?\d*\s*(→免费|[Xx]\b|免费)?/g, '').replace(/\s+/g, ' ').trim() || String(name)
}

// 把后端返回的原始模型（可能是 字符串数组 或 对象数组）规整为 {id,name} 数组，
// 保证 el-option 的 value/label 永远有值——否则会触发
// “Invalid prop value: Expected ... got Undefined at <ElOption>”。
function normModels(list) {
  if (!Array.isArray(list)) return []
  return list.map((m) => {
    const id = typeof m === 'string' ? m : (m && (m.id ?? m.name ?? m.model)) || String(m)
    const name = typeof m === 'string' ? cleanModelName(m) : (m && (m.name ?? m.label ?? m.id)) || String(m)
    return { id: String(id), name: String(name || id) }
  })
}

createApp({
  setup() {
    // 状态
    const provBadge = ref('—')
    const upBadge = ref('—')
    const apiBadge = ref('API: —')
    const selectedModel = ref('auto')
    const models = ref([])
    const recommended = ref([])
    const selStatus = ref('')
    const tokenVal = ref('—')
    const searchUrl = ref('http://127.0.0.1:8787/search')
    const ocsConfigText = ref('加载中…')
    const qType = ref('single')
    const qTitle = ref('')
    const qOptions = ref('')
    const showOptions = ref(true)
    const resText = ref('—')
    const systemPrompt = ref('')
    const promptStatus = ref('')
    const apiUrl = ref('')
    const apiKey = ref('')
    const apiStatus = ref('')
    const cacheStatus = ref('')
    const logs = ref([])
    const logSync = ref('已同步')
    const logOk = ref(true)
    const logFileUrl = ref('#')
    const events = reactive([])

    let logIndex = new Map() // id -> row，按 id 局部更新，避免 pending 状态卡住
    let logTimer = null

    // 主题：默认跟随系统，用户可手动切换
    const dark = ref(false)
    function applyTheme(val) {
      if (val) document.documentElement.classList.add('dark')
      else document.documentElement.classList.remove('dark')
    }

    function sysLog(kind, text) {
      events.unshift({ t: kind, text })
      if (events.length > 200) events.splice(200)
    }

    async function loadConfig() {
      const c = await api('/api/config')
      window.__token = c.token
      tokenVal.value = c.token
      searchUrl.value = c.searchUrl
      selectedModel.value = c.selected || 'auto'
      apiUrl.value = c.provider?.baseUrl || ''
      systemPrompt.value = c.systemPrompt || ''
      provBadge.value = c.provider?.type ? 'provider: ' + c.provider.type : '—'
      upBadge.value = c.upstream || '—'
      apiBadge.value = 'API: ' + (c.provider?.baseUrl || '—')
      // 回填上次填写
      try {
        const last = JSON.parse(localStorage.getItem(LAST_KEY) || '{}')
        if (last.qType) qType.value = last.qType
        if (last.qTitle) qTitle.value = last.qTitle
        if (last.qOptions) qOptions.value = last.qOptions
        if (last.apiUrl) apiUrl.value = last.apiUrl
        if (last.systemPrompt) systemPrompt.value = last.systemPrompt
      } catch {}
      onTypeChange()
    }

    async function loadModels() {
      try {
        const d = await api('/api/models')
        // 后端 models/recommended 可能是字符串数组，统一规整为 {id,name} 供 el-option 使用
        models.value = normModels(d.models)
        recommended.value = normModels(d.recommended)
        selStatus.value = ''
      } catch (e) {
        selStatus.value = '模型列表加载失败：' + e.message
      }
    }

    async function refreshModels() {
      selStatus.value = '重新探测中…'
      try {
        await api('/api/models/refresh', { method: 'POST' })
        await new Promise((r) => setTimeout(r, 4000))
        await loadModels()
        selStatus.value = '已刷新模型列表'
      } catch (e) {
        selStatus.value = e.message
      }
    }

    async function setModel(v) {
      try {
        await api('/api/config', { method: 'POST', body: JSON.stringify({ model: v }) })
        ElMessage.success('全局模型已切换：' + v)
        saveLast()
      } catch (e) {
        ElMessage.error(e.message)
      }
    }

    function onTypeChange() {
      showOptions.value = qType.value === 'single' || qType.value === 'multiple'
      saveLast()
    }

    function saveLast() {
      localStorage.setItem(LAST_KEY, JSON.stringify({
        qType: qType.value, qTitle: qTitle.value, qOptions: qOptions.value,
        apiUrl: apiUrl.value, systemPrompt: systemPrompt.value,
      }))
    }

    async function ask() {
      const title = qTitle.value.trim()
      if (!title) { ElMessage.warning('请先输入题目'); return }
      resText.value = '请求中…'
      try {
        const d = await api('/search', {
          method: 'POST',
          body: JSON.stringify({ title, type: qType.value, options: qOptions.value }),
        })
        resText.value = '答案：' + (d.answer || '—') + (d.fallback ? '（兜底）' : (d.cached ? '（缓存）' : '')) + '\n模型：' + (d.model || '—')
        sysLog('req', `提问 [${typeLabel(qType.value)}] ${title} → ${d.answer || '—'}`)
        pollLogs(true)
      } catch (e) {
        resText.value = '错误：' + e.message
        sysLog('err', '提问失败：' + e.message)
      }
    }

    function clearAsk() {
      resText.value = '—'; qTitle.value = ''; qOptions.value = ''; saveLast()
    }

    async function savePrompt() {
      promptStatus.value = '保存中…'
      try {
        await api('/api/config', { method: 'POST', body: JSON.stringify({ systemPrompt: systemPrompt.value }) })
        promptStatus.value = '已保存'
        ElMessage.success('提示词已保存')
      } catch (e) { promptStatus.value = '失败：' + e.message }
    }

    async function resetPrompt() {
      systemPrompt.value = ''
      await savePrompt()
    }

    async function copyToken() {
      try { await navigator.clipboard.writeText(tokenVal.value); ElMessage.success('token 已复制') }
      catch { ElMessage.error('复制失败，请手动选择') }
    }

    async function resetToken() {
      try {
        const d = await api('/api/token/reset', { method: 'POST' })
        window.__token = d.token; tokenVal.value = d.token
        await reloadCfg()
        ElMessage.success('token 已重置')
      } catch (e) { ElMessage.error(e.message) }
    }

    async function reloadCfg() {
      const cfg = await api('/api/ocs-config')
      ocsConfigText.value = JSON.stringify(cfg, null, 2)
    }

    async function copyCfg() {
      try { await navigator.clipboard.writeText(ocsConfigText.value); ElMessage.success('OCS 配置已复制') }
      catch { ElMessage.error('复制失败，请手动选择') }
    }

    async function saveApiUrl() {
      apiStatus.value = '保存中…'
      try {
        await api('/api/config', { method: 'POST', body: JSON.stringify({ baseUrl: apiUrl.value }) })
        apiStatus.value = '已保存并重连'; apiBadge.value = 'API: ' + apiUrl.value
        await loadModels()
        ElMessage.success('上游地址已保存')
        saveLast()
      } catch (e) { apiStatus.value = '失败：' + e.message }
    }

    async function saveApiKey() {
      apiStatus.value = '保存中…'
      try {
        await api('/api/config', { method: 'POST', body: JSON.stringify({ apiKey: apiKey.value }) })
        apiStatus.value = 'Key 已保存'
        ElMessage.success('API Key 已保存')
      } catch (e) { apiStatus.value = '失败：' + e.message }
    }

    async function clearCache() {
      cacheStatus.value = '清除中…'
      try {
        const d = await api('/api/cache/clear', { method: 'POST' })
        cacheStatus.value = `已清除 ${d.removed} 项缓存`
        sysLog('sys', `已清除缓存：${d.removed} 项（OFM 目录 ${d.ofmDir}）`)
        await loadModels()
      } catch (e) { cacheStatus.value = '失败：' + e.message }
    }

    async function clearLog() {
      await api('/api/logs', { method: 'DELETE' })
      logs.value = []; logIndex = new Map(); logSync.value = '已清空'
    }

    async function pollLogs(immediate) {
      try {
        const d = await api('/api/logs')
        const rows = d.rows || []
        logIndex = new Map()
        for (const r of rows) logIndex.set(r.id, r)
        logs.value = rows
        logSync.value = '已同步 · ' + d.seq
        logOk.value = true
      } catch (e) {
        logOk.value = false
        logSync.value = '同步失败'
      }
      // 更新下载链接
      try {
        const f = await api('/api/logs/file')
        logFileUrl.value = f.url
      } catch {}
    }

    onMounted(async () => {
      // 主题：默认跟随系统偏好
      const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
      dark.value = !!prefersDark
      applyTheme(dark.value)
      try {
        await loadConfig()
        await reloadCfg()
        await loadModels()
        sysLog('sys', '控制台已加载' + (dark.value ? '（暗色）' : '（亮色）'))
        pollLogs(true)
        logTimer = setInterval(() => pollLogs(false), 1500)
      } catch (e) {
        sysLog('err', '初始化失败：' + e.message)
      }
    })

    return {
      provBadge, upBadge, apiBadge, selectedModel, models, recommended, selStatus,
      tokenVal, searchUrl, ocsConfigText, qType, qTitle, qOptions, showOptions, resText,
      systemPrompt, promptStatus, apiUrl, apiKey, apiStatus, cacheStatus,
      logs, logSync, logOk, logFileUrl, events, dark, applyTheme,
      refreshModels, setModel, onTypeChange, ask, clearAsk,
      savePrompt, resetPrompt, copyToken, resetToken, copyCfg, reloadCfg,
      saveApiUrl, saveApiKey, clearCache, clearLog,
      fmtTime, typeLabel,
    }
  },
}).use(ElementPlus_, zhCn ? { locale: zhCn } : {}).mount('#app')

// 挂载成功后清除致命错误占位（若有）
const fb = document.getElementById('fatal')
if (fb) fb.remove()
