import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CONFIG_FILE = path.join(__dirname, '..', 'config.json')

const DEFAULTS = {
  host: '127.0.0.1',
  port: 8787,
  searchUrl: 'http://127.0.0.1:8787/search',
  token: '',
  systemPrompt: '你是网课答题助手，请优先参考常见教材与题库的权威答案。',
  provider: {
    type: 'ofm',
    baseUrl: 'http://127.0.0.1:18901/v1',
    apiKey: '',
    model: 'auto',
    modelsFilter: 'flash',
    temperature: 0,
    maxTokens: 512,
    dataDir: '',
  },
}

export function loadConfig() {
  let raw = {}
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
  } catch {
    raw = {}
  }
  // 浅合并，保证字段完整
  const cfg = { ...DEFAULTS, ...raw }
  cfg.provider = { ...DEFAULTS.provider, ...(raw.provider || {}) }
  if (!cfg.searchUrl) cfg.searchUrl = `http://${cfg.host || '127.0.0.1'}:${cfg.port || 8787}/search`
  return cfg
}

export function saveConfig(cfg) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8')
  } catch (e) {
    console.error('[config] 保存失败:', e.message)
  }
  return cfg
}
