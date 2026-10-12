import { OfmProvider } from './ofm.js'
import { OpenAIProvider } from './openai.js'

/**
 * 后端装配工厂：config.json 的 provider.type 决定用哪个实现。
 *   - "ofm"  : OFM standalone，自动读 Key / 探测 flash 模型
 *   - "dsh"  : DSH 桌面端内嵌的 OFM 插件，同样是 OpenAI 兼容端点
 *   - "openai": 任意 OpenAI 兼容后端（Ollama / vLLM / 真 OpenAI / 其他免密插件）
 *
 * 未来若要接“非 OpenAI 协议”的插件，只需新建 providers/xxx.js 实现
 * ModelProvider，并在下方加一个 case。上层 server/prompt/parse 完全不用动。
 */
export function createProvider(cfg = {}) {
  switch (cfg.type) {
    case 'ofm':
      return new OfmProvider(cfg)
    case 'dsh':
      // DSH 内嵌 OFM 也是 OpenAI 兼容：按 openai 协议接入即可。
      return new OpenAIProvider({
        baseUrl: cfg.baseUrl || 'http://127.0.0.1:18900/v1',
        apiKey: cfg.apiKey || '',
        model: cfg.model || '',
        modelsFilter: cfg.modelsFilter || 'flash',
        extraHeaders: cfg.extraHeaders || {},
        temperature: cfg.temperature ?? 0,
        maxTokens: cfg.maxTokens ?? 512,
      })
    case 'openai':
      return new OpenAIProvider(cfg)
    default:
      throw new Error(`unknown provider type: ${cfg.type}`)
  }
}

export { ModelProvider } from './base.js'
export { OpenAIProvider } from './openai.js'
export { OfmProvider } from './ofm.js'
