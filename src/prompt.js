// 按 OCS 题型构造发送给模型的 messages。
// 目标：让模型只吐“答案本身”，便于后续 parse 提取。

const TYPE_HINT = {
  single: '这是一道单选题，只有一个正确选项。',
  multiple: '这是一道多选题，可能有一个或多个正确选项。',
  judgement: '这是一道判断题。',
  completion: '这是一道填空题。',
}

function renderOptions(options) {
  return options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`).join('\n')
}

export function buildMessages({ title, type, options, systemPrompt }) {
  const sys = [
    '你是一个严谨的答题助手。',
    '请只输出最终答案本身，不要解释、不要前缀、不要多余标点。',
    '若题目信息不足或无法判断，仅输出“未知”。',
  ].join('\n')

  const hint = TYPE_HINT[type] || '这是一道题目。'
  let user

  if (type === 'multiple' && Array.isArray(options) && options.length) {
    user =
      `${hint}\n选项：\n${renderOptions(options)}\n\n题目：${title}\n\n` +
      '请输出所有正确选项的字母，多个用“#”连接，例如：A#C'
  } else if (type === 'single' && Array.isArray(options) && options.length) {
    user =
      `${hint}\n选项：\n${renderOptions(options)}\n\n题目：${title}\n\n` +
      '请只输出正确选项的字母，例如：A'
  } else if (type === 'judgement') {
    user = `${hint}\n题目：${title}\n\n请只输出“正确”或“错误”`
  } else if (type === 'completion') {
    user = `${hint}\n题目：${title}\n\n请只输出填空内容`
  } else {
    user = `题目：${title}`
  }

  // 用户自定义提示词作为“附加要求”追加在末尾（最高优先级），让用户配置真正生效；
  // 默认中性提示词不影响格式约束。
  const sp = (systemPrompt && String(systemPrompt).trim()) ? String(systemPrompt).trim() : ''
  if (sp) user += `\n\n—— 附加要求 ——\n${sp}`

  return [
    { role: 'system', content: sys },
    { role: 'user', content: user },
  ]
}
