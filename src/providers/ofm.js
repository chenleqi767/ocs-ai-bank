import fs from 'node:fs'
import path from 'node:path'
import { OpenAIProvider, expandHome } from './openai.js'

/**
 * OFM standalone 后端。
 * 它本身就是 OpenAI 兼容端点（forward.js 已实现 /v1/chat/completions），
 * 这里只是“顺手”做了两件 OFM 特有便利：
 *   1. 没配 apiKey 时，自动从 OFM 数据目录的 settings.json 读取 forwardKey；
 *   2. 默认 modelsFilter 偏向轻量/低速率的 flash 模型。
 * 因此 OFM 挂掉时，把 provider.type 改成 "openai" 并填另一个端点即可，代码零改动。
 */
export class OfmProvider extends OpenAIProvider {
  constructor(cfg = {}) {
    // dataDir 解析顺序：config.dataDir -> 环境变量 OFM_HOME -> 默认 ~/.our-free-model
    // 与 OFM standalone 启动时的数据目录保持一致，才能自动读到 forwardKey。
    let dataDir = cfg.dataDir ? expandHome(cfg.dataDir) : ''
    if (!dataDir || !fs.existsSync(path.join(dataDir, 'settings.json'))) {
      const envHome = String(process.env.OFM_HOME ?? '').trim()
      if (envHome) dataDir = envHome
    }

    let apiKey = cfg.apiKey || ''
    if (!apiKey && dataDir) {
      try {
        const settings = JSON.parse(
          fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8')
        )
        apiKey = settings.forwardKey || ''
      } catch {
        // 允许手动在 config 里填 apiKey，或改用 openai provider
      }
    }

    super({
      baseUrl: cfg.baseUrl || 'http://127.0.0.1:18900/v1',
      apiKey,
      model: cfg.model || '',
      modelsFilter: cfg.modelsFilter || 'flash',
      extraHeaders: cfg.extraHeaders || {},
      temperature: cfg.temperature ?? 0,
      maxTokens: cfg.maxTokens ?? 512,
    })
    this.dataDir = dataDir
  }

  get name() {
    return 'ofm'
  }
}
