import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

import { loadConfig, saveConfig } from './config.js'
import { createProvider } from './providers/index.js'
import { buildMessages } from './prompt.js'
import { parseAnswer } from './parse.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = path.join(__dirname, '..', 'public')
const OCS_DIR = path.join(__dirname, '..', 'ocs')
const OCS_CONFIG_FILE = path.join(OCS_DIR, 'answerer-config.json')
const LOG_DIR = path.join(__dirname, '..', 'logs')

// 每次运行生成一个独立的日志文件（JSONL：每行一条完成记录），便于持久保存与下载。
const SESSION_TS = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const LOG_FILE = path.join(LOG_DIR, `run-${SESSION_TS}-pid${process.pid}.jsonl`)
let logStream = null
try {
  fs.mkdirSync(LOG_DIR, { recursive: true })
  logStream = fs.createWriteStream(LOG_FILE, { flags: 'a', encoding: 'utf8' })
  logStream.on('error', (e) => console.error('[log] 写入失败:', e.message))
} catch (e) {
  console.error('[log] 无法创建日志文件:', e.message)
}
function appendLogToFile(entry) {
  if (!logStream) return
  try { logStream.write(JSON.stringify(entry) + '\n') } catch {}
}

const cfg = loadConfig() // 同步加载，含 provider / token / searchUrl / port
const provider = createProvider(cfg.provider || {})
let selectedModel = cfg.provider?.model || 'auto' // 当前全局模型（唯一来源）
const PORT = process.env.PORT || cfg.port || 8787
const HOST = cfg.host || '127.0.0.1'

// ---- 内存态 ----
let modelCache = null // { models, recommended, filter, ts }
let probeRunning = false
let probePromise = null

// 答题响应缓存：相同 (模型, 题型, 题目, 选项) 命中时直接返回，并标记 cached=true 写入日志。
const answerCache = new Map() // key -> { text, model }
function answerCacheKey(title, type, cleanOptions) {
  return JSON.stringify([selectedModel, type, title, cleanOptions])
}

// ---- 服务端答题日志（网页与 OCS 共用同一份，前端轮询即“实时同步”）----
const logStore = { rows: [], seq: 0 }
const LOG_MAX = 200
function addLog(entry) {
  logStore.seq += 1
  logStore.rows.push({ id: logStore.seq, ts: Date.now(), ...entry })
  if (logStore.rows.length > LOG_MAX) logStore.rows.shift()
}

// OCS 传来的 options 可能是：
//   - 字符串 "A. 北京\nB. 上海"  （OCS 默认）
//   - 数组 ["北京","上海"] 或 ["A. 北京",...]
// 归一化为干净文本数组（去掉 "A." 这类前缀），供 prompt 使用；
// 同时返回带字母前缀的展示串，便于日志核对。
function normalizeOptions(options) {
  let arr = []
  if (Array.isArray(options)) {
    arr = options.map((o) => String(o))
  } else if (typeof options === 'string' && options.trim()) {
    arr = options.split('\n').map((s) => s.trim()).filter(Boolean)
  }
  // 去掉行首 "A." / "1." / "①" 等选项前缀，便于模型定位真实内容
  const clean = arr.map((s) => s.replace(/^[A-Za-z0-9]{1,2}[\.、）)]?\s*/, '').trim()).filter(Boolean)
  return clean
}

// ============ 工具 ============
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > 1_000_000) {
        reject(new Error('payload too large'))
        req.destroy()
        return
      }
      data += c
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

async function readJson(req) {
  const raw = await readBody(req)
  if (!raw) return {}
  return JSON.parse(raw)
}

// 干净展示名：去掉上游形如 "· x0.00→免费" / "· x0.05 X" 的倍率噪点
function cleanName(name) {
  if (!name || typeof name !== 'string') return ''
  return name.replace(/\s*[·•・]\s*x\d*\.?\d*\s*(→免费|[Xx]\b|免费)?/g, '').replace(/\s+/g, ' ').trim()
}

// ============ 模型探测 ============
async function ensureAvailable() {
  if (modelCache && Date.now() - modelCache.ts < 5 * 60_000) return modelCache
  return refreshAvailable()
}

async function refreshAvailable() {
  if (probeRunning) return probePromise
  probeRunning = true
  probePromise = (async () => {
    let ids = []
    try {
      ids = await provider.listModels()
    } catch (e) {
      ids = []
    }
    if (!Array.isArray(ids)) ids = []
    const recommended = (cfg.provider?.modelsFilter
      ? ids.filter((m) => new RegExp(cfg.provider.modelsFilter, 'i').test(m))
      : []).slice(0, 5)
    modelCache = { models: ids, recommended, filter: cfg.provider?.modelsFilter || null, ts: Date.now() }
    return modelCache
  })()
  try {
    return await probePromise
  } finally {
    probeRunning = false
  }
}

// ============ Token ============
function ensureToken() {
  if (!cfg.token) {
    cfg.token = crypto.randomBytes(16).toString('hex')
    saveConfig(cfg)
  }
  return cfg.token
}

function rebuildOcsConfig() {
  const url = cfg.searchUrl || `http://${HOST}:${PORT}/search`
  const token = cfg.token || ensureToken()
  const config = [
    {
      name: '本地AI题库(OFM/OpenAI兼容)',
      homepage: `http://${HOST}:${PORT}/`,
      url,
      method: 'post',
      type: 'GM_xmlhttpRequest',
      contentType: 'json',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      data: {
        token,
        title: '${title}',
        type: '${type}',
        options: '${options}',
      },
      handler:
        'return (res)=> res && res.answer ? [res.question ?? undefined, res.answer] : [res.msg ?? "AI未返回", undefined]',
    },
  ]
  try {
    fs.mkdirSync(OCS_DIR, { recursive: true })
    fs.writeFileSync(OCS_CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8')
  } catch (e) {
    // 写入失败不影响服务；接口仍可动态返回
  }
  return config
}

function resetToken() {
  cfg.token = crypto.randomBytes(16).toString('hex')
  saveConfig(cfg)
  rebuildOcsConfig()
  return cfg.token
}

// 解析 OFM 数据目录（与 providers/ofm.js 同一套逻辑：config.dataDir -> OFM_HOME -> ~/.our-free-model）
function resolveOfmDataDir() {
  let dir = cfg.provider?.dataDir ? String(cfg.provider.dataDir) : ''
  if (dir.startsWith('~')) dir = path.join(os.homedir(), dir.slice(1))
  if (!dir || !fs.existsSync(path.join(dir, 'settings.json'))) {
    const envHome = String(process.env.OFM_HOME ?? '').trim()
    if (envHome) dir = envHome
  }
  if (!dir || !fs.existsSync(path.join(dir, 'settings.json'))) {
    dir = path.join(os.homedir(), '.our-free-model')
  }
  return dir
}

// 一键清除缓存：① 内存中的模型探测缓存（强制下次重新探测）；
// ② OFM 数据目录下的可重建缓存文件（catalog/availability/stats）；
// ③ （若存在）ai-bank 自身的响应缓存目录。不删除 token/配置等持久文件。
async function clearCache() {
  modelCache = null // ① 内存探测缓存立即失效
  answerCache.clear() // ④ 答题响应缓存（命中过的题目）
  let removed = 0
  const dir = resolveOfmDataDir()
  const ofmCacheNames = ['catalog.json', 'availability.json', 'stats.json']
  for (const name of ofmCacheNames) {
    const fp = path.join(dir, name)
    if (fs.existsSync(fp)) {
      try { await fsp.unlink(fp); removed++ } catch {}
    }
  }
  // ③ 本项目内的响应/缓存目录（如有）
  for (const d of ['cache', 'tmp']) {
    const cp = path.join(__dirname, '..', d)
    if (fs.existsSync(cp)) {
      try { await fsp.rm(cp, { recursive: true, force: true }); removed++ } catch {}
    }
  }
  return { ok: true, ofmDir: dir, removed }
}

// ============ 答题核心 ============
async function handleSearch(req, res) {
  let body
  try {
    body = await readJson(req)
  } catch (e) {
    return sendJson(res, 400, { msg: '请求体需为 JSON: ' + e.message })
  }

  // token 校验（手动设置的 token，仅用于鉴权，不覆盖自动探测的模型）
  const token = body.token || req.headers['authorization']?.replace(/^Bearer\s+/i, '') || ''
  if (!cfg.token) ensureToken()
  if (cfg.token && token !== cfg.token) {
    return sendJson(res, 401, { msg: 'token 无效，请在 OCS 配置中填入正确的 token' })
  }

  const { title, type = 'single', options } = body
  if (!title || typeof title !== 'string' || !title.trim()) {
    return sendJson(res, 400, { msg: '缺少 title' })
  }

  // 归一化选项：兼容 OCS 默认的 "A. 北京\nB. 上海" 字符串与数组两种格式
  const cleanOptions = normalizeOptions(options)
  const messages = buildMessages({ title: title.trim(), type, options: cleanOptions, systemPrompt: cfg.systemPrompt })

  // 全局模型单一来源：selectedModel 决定走哪条通道
  const target =
    selectedModel && selectedModel !== 'auto'
      ? [selectedModel, ...(modelCache?.models || []).filter((m) => m !== selectedModel)]
      : selectedModel === 'auto'
        ? (modelCache?.recommended?.length
            ? modelCache.recommended
            : (modelCache?.models || []))
        : modelCache?.models || []

  const logId = logStore.seq + 1
  addLog({
    title: title.trim(),
    type,
    options: cleanOptions,
    rawOptions: typeof options === 'string' ? options : Array.isArray(options) ? options.join(' / ') : '—',
    status: 'pending',
    model: selectedModel,
    raw: '',
    answer: '',
  })

  const cacheKey = answerCacheKey(title.trim(), type, cleanOptions)
  let raw = ''
  let usedModel = selectedModel
  let cached = false
  let fallback = false

  // 先查缓存：命中则直接复用上一次回答（同样写入日志，并标记 cached=true）
  const hit = answerCache.get(cacheKey)
  if (hit) {
    cached = true
    raw = hit.text
    usedModel = hit.model || usedModel
  } else {
    try {
      const r = await provider.complete({
        model: target,
        messages,
        temperature: cfg.provider?.temperature ?? 0,
      })
      raw = r?.text ?? ''
      usedModel = r?.model || usedModel
    } catch (e) {
      // 全部通道失败 -> 兜底
      fallback = true
      raw = '未知'
    }

    if (!raw || !raw.trim()) {
      fallback = true
      raw = '未知'
    }
    // 仅在成功拿到真实回答时写入缓存（兜底/未知不缓存）
    if (!fallback && raw) {
      answerCache.set(cacheKey, { text: raw, model: usedModel })
    }
  }

  const answer = parseAnswer(raw, type)
  // 更新该条日志为完成态
  const row = logStore.rows.find((x) => x.id === logId)
  if (row) {
    row.status = fallback ? 'fallback' : 'ok'
    row.model = usedModel
    row.raw = raw
    row.answer = answer
    row.fallback = fallback
    row.cached = cached
    // 持久化到本次运行的日志文件（JSONL），仅记录已完成条目
    appendLogToFile({
      ts: new Date(row.ts).toISOString(),
      type: row.type,
      title: row.title,
      options: row.options,
      rawOptions: row.rawOptions,
      model: usedModel,
      raw,
      answer,
      fallback,
      cached,
    })
  }
  return sendJson(res, 200, {
    question: title,
    answer,
    model: usedModel,
    cached,
    fallback,
  })
}

// ============ 路由 ============
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  const p = url.pathname
  const method = req.method || 'GET'

  try {
    // ---- API ----
    if (p === '/api/config' && method === 'GET') {
      await ensureAvailable()
      return sendJson(res, 200, {
        upstream: provider.upstream || 'unknown',
        provider: cfg.provider?.type || 'unknown',
        selected: selectedModel,
        token: cfg.token,
        searchUrl: cfg.searchUrl || `http://${HOST}:${PORT}/search`,
        systemPrompt: cfg.systemPrompt || '',
      })
    }

    if (p === '/api/config' && method === 'POST') {
      const body = await readJson(req)
      let changed = false
      if (body.model !== undefined) {
        const m = body.model === 'auto' ? 'auto' : String(body.model)
        selectedModel = m
        cfg.provider = cfg.provider || {}
        cfg.provider.model = m
        changed = true
      }
      // 修改上游 API 地址 / Key：需要重建 provider 并重新探测
      if (body.baseUrl !== undefined && String(body.baseUrl).trim()) {
        cfg.provider = cfg.provider || {}
        cfg.provider.baseUrl = String(body.baseUrl).trim().replace(/\/$/, '')
        changed = true
      }
      if (body.apiKey !== undefined) {
        cfg.provider = cfg.provider || {}
        cfg.provider.apiKey = String(body.apiKey)
        changed = true
      }
      if (body.systemPrompt !== undefined) {
        cfg.systemPrompt = String(body.systemPrompt).slice(0, 4000)
        changed = true
      }
      if (changed) {
        saveConfig(cfg)
        try {
          provider = createProvider(cfg.provider)
          await ensureAvailable()
          rebuildOcsConfig()
        } catch (e) {
          // 探测失败不阻断保存，下一次请求会重试
        }
      }
      return sendJson(res, 200, {
        selected: selectedModel,
        provider: { type: cfg.provider?.type, baseUrl: cfg.provider?.baseUrl },
        upstream: provider.upstream || 'unknown',
        ok: true,
      })
    }

    if (p === '/api/models' && method === 'GET') {
      const info = await ensureAvailable()
      return sendJson(res, 200, {
        models: info.models, // 全部模型
        recommended: info.recommended,
        filter: info.filter,
        selected: selectedModel,
        ocsConnectTip:
          'OCS 脚本需在元信息加 @connect 127.0.0.1（或在选择器启用"全域名通用版本"）才能直连本服务。',
      })
    }

    if (p === '/api/models/refresh' && method === 'POST') {
      const info = await refreshAvailable()
      return sendJson(res, 200, { models: info.models, recommended: info.recommended, selected: selectedModel })
    }

    // OCS 配置（含动态 token）
    if (p === '/api/ocs-config' && method === 'GET') {
      const config = rebuildOcsConfig()
      return sendJson(res, 200, {
        config,
        raw: JSON.stringify(config, null, 2),
        searchUrl: cfg.searchUrl || `http://${HOST}:${PORT}/search`,
      })
    }

    // 重置 token（手动触发，不自动覆盖）
    if (p === '/api/token/reset' && method === 'POST') {
      const token = resetToken()
      return sendJson(res, 200, { token, ok: true })
    }

    // 服务端答题日志（网页轮询此接口即可“实时同步”，OCS 与网页共用同一份）
    // 全量返回，前端按 id 增量 upsert（正确处理 pending -> ok 状态变更）。
    if (p === '/api/logs' && method === 'GET') {
      const rows = [...logStore.rows].reverse() // 时间倒序：最新在上
      return sendJson(res, 200, { rows, seq: logStore.seq })
    }
    if (p === '/api/logs' && method === 'DELETE') {
      logStore.rows = []
      logStore.seq = 0
      return sendJson(res, 200, { ok: true })
    }
    // 本次运行的日志文件路径与可下载 URL
    if (p === '/api/logs/file' && method === 'GET') {
      return sendJson(res, 200, {
        file: path.basename(LOG_FILE),
        url: '/logs/' + path.basename(LOG_FILE),
        lines: logStore.seq,
      })
    }

    // 一键清除缓存（内存探测缓存 + OFM 本地缓存文件）
    if (p === '/api/cache/clear' && method === 'POST') {
      const r = await clearCache()
      return sendJson(res, 200, r)
    }

    // ---- 答题 ----
    if (p === '/search' && method === 'POST') {
      return await handleSearch(req, res)
    }

    // OCS 连接测试（AnswererWrapper 的“连接”按钮通常发 GET 探测连通性）
    if (p === '/search' && method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        service: 'ai-bank',
        selected: selectedModel,
        msg: 'ai-bank 在线，请用 POST 提交题目',
      })
    }

    if (p === '/health' && method === 'GET') {
      await ensureAvailable()
      return sendJson(res, 200, {
        ok: true,
        upstream: provider.upstream,
        provider: cfg.provider?.type,
        models: modelCache?.models?.length || 0,
        selected: selectedModel,
      })
    }

    // ---- 静态资源 ----
    if (p === '/' || p === '/app') {
      return serveFile(res, path.join(PUBLIC_DIR, 'index.html'), 'text/html; charset=utf-8')
    }
    if (p === '/app.js') {
      return serveFile(res, path.join(PUBLIC_DIR, 'app.js'), 'text/javascript; charset=utf-8')
    }
    if (p === '/ocs-config.json') {
      const config = rebuildOcsConfig()
      return sendJson(res, 200, config)
    }
    // 本地 vendor 静态资源（Vue / Element Plus / locale）
    if (p.startsWith('/vendor/') && method === 'GET') {
      const fname = path.basename(p.slice('/vendor/'.length))
      const full = path.join(PUBLIC_DIR, 'vendor', fname)
      if (!full.startsWith(path.join(PUBLIC_DIR, 'vendor'))) return sendJson(res, 403, { msg: 'forbidden' })
      const ext = path.extname(fname)
      const ct = ext === '.css' ? 'text/css; charset=utf-8'
        : ext === '.js' ? 'text/javascript; charset=utf-8'
        : 'application/octet-stream'
      return serveFile(res, full, ct)
    }
    // 暗色主题变量（Element Plus 2.x dark）
    if (p === '/vendor/element-plus.dark.css' && method === 'GET') {
      return serveFile(res, path.join(PUBLIC_DIR, 'vendor', 'element-plus.dark.css'), 'text/css; charset=utf-8')
    }
    // 日志文件下载（仅允许 logs 目录下、本次会话产生的 .jsonl）
    if (p.startsWith('/logs/') && method === 'GET') {
      const fname = path.basename(p.slice('/logs/'.length))
      const full = path.join(LOG_DIR, fname)
      if (full === LOG_FILE && fs.existsSync(full)) {
        return serveFile(res, full, 'application/json; charset=utf-8')
      }
      return sendJson(res, 404, { msg: 'log file not found' })
    }

    return sendJson(res, 404, { msg: 'not found' })
  } catch (e) {
    console.error('[err]', e)
    return sendJson(res, 500, { msg: 'server error: ' + (e.message || e) })
  }
})

function serveFile(res, file, contentType) {
  fsp.readFile(file).then((buf) => {
    res.writeHead(200, {
      'content-type': contentType,
      'access-control-allow-origin': '*',
      'cache-control': 'no-cache',
    })
    res.end(buf)
  }).catch(() => {
    sendJson(res, 404, { msg: 'not found' })
  })
}

// 启动
ensureToken()
rebuildOcsConfig()
refreshAvailable().catch(() => {})

server.listen(PORT, HOST, () => {
  console.log(`ai-bank 已启动: http://${HOST}:${PORT}`)
  console.log(`  上游: ${provider.upstream} | provider: ${cfg.provider?.type}`)
  console.log(`  全局模型: ${selectedModel}`)
  console.log(`  token: ${cfg.token}`)
})
