// 从模型回复里抽取规范化的答案，并按 OCS 约定格式化。
// 重要：OCS 的多选题答案必须用分隔符连成字符串（文档示例用 “#”），不能返回数组。

const LETTERS = 'ABCDEFGHIJ'

function normalizeJudgement(text) {
  const t = text.trim()
  if (/^(正确|对|√|true|yes|是|1)$/i.test(t)) return '正确'
  if (/^(错误|错|×|false|no|否|0)$/i.test(t)) return '错误'
  if (t.includes('正确') && !t.includes('错误')) return '正确'
  if (t.includes('错误')) return '错误'
  return text.trim()
}

function collectLetters(text) {
  const out = []
  const all = text.match(/[A-Ja-j]/g) || []
  for (const c of all) {
    const u = c.toUpperCase()
    if (!out.includes(u)) out.push(u)
  }
  return out.sort((a, b) => LETTERS.indexOf(a) - LETTERS.indexOf(b))
}

export function parseAnswer(raw, type) {
  const text = (raw || '').toString().replace(/\s+/g, ' ').trim()
  if (!text) return ''

  if (type === 'multiple') {
    // 优先按 # / 、/ ，/ 空格 切分后逐段取字母，避免把说明文字里的字母误收。
    const parts = text.split(/[#＃\s,，、]+/).filter(Boolean)
    const found = []
    for (const part of parts) {
      const m = part.match(/[A-Ja-j]/g)
      if (m) for (const c of m) if (!found.includes(c.toUpperCase())) found.push(c.toUpperCase())
    }
    if (found.length)
      return found.sort((a, b) => LETTERS.indexOf(a) - LETTERS.indexOf(b)).join('#')
    // 退化：直接散落的字母
    const letters = collectLetters(text)
    return letters.length ? letters.join('#') : text
  }

  if (type === 'single') {
    const m = text.match(/[A-Ja-j]/)
    return m ? m[0].toUpperCase() : text
  }

  if (type === 'judgement') {
    return normalizeJudgement(text)
  }

  // completion 或未知类型：尽力截取“答案：”之后的内容
  const m = text.match(/(?:答案|答)\s*[:：]\s*(.+)$/)
  return (m ? m[1] : text).trim()
}
