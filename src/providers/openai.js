import os from 'node:os'
import { ModelProvider } from './base.js'

function expandHome(p) {
  if (!p || typeof p !== 'string') return p
  if (p.startsWith('~')) {
    const home = os.homedir()
    return p.replace(/^~($|\/|\\)/, home + '$1')
  }
  return p
}

/**
 * 通用 OpenAI 兼容后端。
 * 覆盖绝大多数实现：OFM standalone、OFM 的 DSH 内嵌端点、Ollama、vLLM、
 * LM Studio、真 OpenAI，以及任何“类 OFM 免密插件”。
 */
export class OpenAIProvider extends ModelProvider {
  constructor(cfg = {}) {
    super()
    this.baseUrl = (cfg.baseUrl || 'http://127.0.0.1:18900/v1').replace(/\/$/, '')
    this.apiKey = cfg.apiKey || ''
    this.model = cfg.model || ''
    this.modelsFilter = cfg.modelsFilter || ''
    this.extraHeaders = cfg.extraHeaders || {}
    this.temperature = cfg.temperature ?? 0
    this.maxTokens = cfg.maxTokens ?? 512
  }

  get name() {
    return 'openai'
  }

  get upstream() {
    return this.baseUrl
  }

  _headers() {
    const h = { 'content-type': 'application/json', ...this.extraHeaders }
    if (this.apiKey) h.authorization = `Bearer ${this.apiKey}`
    return h
  }

  async listModels() {
    const r = await fetch(`${this.baseUrl}/models`, { headers: this._headers() })
    if (!r.ok) throw new Error(`listModels HTTP ${r.status}`)
    const d = await r.json().catch(() => ({}))
    const rows = Array.isArray(d?.data)
      ? d.data
      : Array.isArray(d?.models)
      ? d.models
      : []
    return rows.map((m) => (typeof m === 'string' ? m : m?.id)).filter(Boolean)
  }

  async complete({ model, messages, temperature = this.temperature, stream = false } = {}) {
    // model 可以是单个 id，也可以是候选列表（resolveModel 默认返回列表）。
    // 逐个尝试，直到某个模型成功应答——后端某免费通道抖动时整体仍可用。
    const candidates = Array.isArray(model) ? model : model ? [model] : await this.resolveModel()
    let lastErr = null
    for (const m of candidates) {
      try {
        const r = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: this._headers(),
          body: JSON.stringify({
            model: m,
            messages,
            temperature,
            max_tokens: this.maxTokens,
            stream,
          }),
        })
        if (!r.ok) {
          const body = await r.text().catch(() => '')
          // 4xx 模型不存在等致命错也换下一个候选
          lastErr = new Error(`completion HTTP ${r.status}: ${body.slice(0, 200)}`)
          continue
        }
        const d = await r.json().catch(() => ({}))
        const text = d?.choices?.[0]?.message?.content ?? ''
        if (!text) {
          lastErr = new Error('模型返回空内容')
          continue
        }
        return { text, model: m, usage: d?.usage }
      } catch (e) {
        lastErr = e
      }
    }
    throw lastErr || new Error('所有候选模型均不可用')
  }

  /**
   * 轻量探测单个模型是否可用：发一个极短 prompt，看能否返回非空内容。
   * 用于启动时筛选“真正能用”的模型，避免把会 502 的模型暴露给前端。
   */
  async probe(model, { timeoutMs = 6000 } = {}) {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const r = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this._headers(),
        signal: ctrl.signal,
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: '回复一个字：好' }],
          temperature: 0,
          max_tokens: 4,
        }),
      })
      if (!r.ok) return false
      const d = await r.json().catch(() => ({}))
      const text = d?.choices?.[0]?.message?.content ?? ''
      return text.trim().length > 0
    } catch {
      return false
    } finally {
      clearTimeout(t)
    }
  }

  /**
   * 探测所有模型，返回可用模型数组（并发探测，整体超时约 maxMs）。
   * 优先排 modelsFilter 命中的。探测失败则回退为“不过滤，全部标记为可用”。
   */
  async listAvailable({ maxMs = 15000 } = {}) {
    let all
    try {
      all = await this.listModels()
    } catch {
      return []
    }
    if (!all.length) return []

    // 并发探测，整体带总超时
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), maxMs)
    const results = await Promise.all(
      all.map(async (m) => {
        try {
          const ok = await this.probe(m, { timeoutMs: Math.min(6000, maxMs) })
          return ok ? m : null
        } catch {
          return null
        }
      })
    ).catch(() => all.map(() => null))
    clearTimeout(timer)

    const available = results.filter(Boolean)
    if (available.length) {
      const f = this.modelsFilter ? new RegExp(this.modelsFilter, 'i') : null
      available.sort((a, b) => {
        const ra = f && f.test(a) ? 0 : 1
        const rb = f && f.test(b) ? 0 : 1
        return ra - rb
      })
      return available
    }
    // 探测全失败时，回退：仍返回全部，由上层在运行时再试
    return all
  }
}

export { expandHome }
