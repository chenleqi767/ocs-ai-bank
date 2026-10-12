// 极简内存缓存：按 题型 + 题目 做键，避免重复烧免费额度。

export class MemoryCache {
  constructor({ enabled = true, ttlMs = 86400000, maxEntries = 2000 } = {}) {
    this.enabled = enabled
    this.ttlMs = ttlMs
    this.maxEntries = maxEntries
    this.map = new Map()
  }

  _key(title, type) {
    return `${type}::${title}`
  }

  get(title, type) {
    if (!this.enabled) return null
    const k = this._key(title, type)
    const e = this.map.get(k)
    if (!e) return null
    if (Date.now() > e.exp) {
      this.map.delete(k)
      return null
    }
    return e.value
  }

  set(title, type, value) {
    if (!this.enabled) return
    const k = this._key(title, type)
    this.map.set(k, { value, exp: Date.now() + this.ttlMs })
    if (this.map.size > this.maxEntries) {
      const first = this.map.keys().next().value
      if (first !== undefined) this.map.delete(first)
    }
  }
}
