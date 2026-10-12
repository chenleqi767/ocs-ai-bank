// 所有模型后端的抽象基类。
// 新增任意后端只需继承此类并实现 listModels / complete（见 openai.js / ofm.js）。

export class ModelProvider {
  get name() {
    return 'base'
  }

  /** 暴露上游地址，供 /health 展示。 */
  get upstream() {
    return ''
  }

  /** 返回可用模型 id 列表（用于自动探测）。 */
  async listModels() {
    throw new Error('not implemented: listModels')
  }

  /**
   * 在没有显式指定 model 时，返回候选模型列表（按优先级排序）。
   * 上层 complete 会逐个尝试，直到成功。
   */
  async resolveModel() {
    if (this.model) return [this.model]
    const ids = await this.listModels()
    if (!Array.isArray(ids) || ids.length === 0) throw new Error('后端未返回任何模型')
    return ids
  }

  /** 单次补全。子类必须实现。 */
  async complete() {
    throw new Error('not implemented: complete')
  }
}
