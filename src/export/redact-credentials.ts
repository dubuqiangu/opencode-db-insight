/**
 * 导出时的凭据脱敏（DESIGN §8 导出面）。
 *
 * 为什么需要：实测本机库 59443 条消息里，**593 条**含凭据形态的字符串，
 * 去重后 **78 个不同值**（48 个 `sk-`、12 个 `xoxb-`、若干 `ghp_`），其中
 * 55 个被复制进多条消息——它们是用户在对话里真实粘贴过、又被反复引用的
 * token，不是构造的测试数据。
 *
 * 导出文件会被转发、提交进仓库、贴进工单，所以它是**外流载体**；回放页
 * 是本地查看，保持原样（用户明确选择）。两者口径不同是有意的：
 *
 * - 导出：脱敏（本模块，只被 `markdown.ts` 引用）。
 * - 回放页：不脱敏（`replay-message-text.js` 不引用本模块）。
 *
 * 保留末 4 位：用户仍能认出是哪把 key（排查时需要），但复制出去已不可用。
 * 太短的串不做替换——宁可漏掉一个形态不明的串，也不要把正常文本打成
 * `sk-…abcd` 这种噪音。
 */

/**
 * 两类模式分开处理，因为「整个匹配就是凭据」和「匹配里只有一段是凭据」
 * 的替换方式不同：前者整体替掉，后者必须留住键名/分隔符/引号，否则
 * `token = "sk-..."` 会退化成一句没有语法的碎片。
 */
interface WholeMatchPattern {
  readonly label: string
  readonly pattern: RegExp
  /** 0 表示不留尾巴（私钥头这类，尾部是密钥主体）。 */
  readonly keepTailChars: number
}

interface GroupedPattern {
  readonly label: string
  /** 三个捕获组：前导、凭据值、尾部（可缺）。 */
  readonly pattern: RegExp
  readonly keepTailChars: number
}

// 左边界不能只用 `\b`：带 ANSI 色码的工具输出里，`\x1b[0m` 结尾的 `m` 是单词
// 字符，`\bsk-` 在那里不成立，整条规则空转——实测真实库里因此漏了 31 处。
// 现在的守卫是「前面不是字母数字下划线」或「前面刚结束一个 ANSI 转义序列」。
const WHOLE_MATCH_PATTERNS: readonly WholeMatchPattern[] = [
  // OpenAI / Anthropic 风格的 sk- key。实测真实值长度为 24 / 35 / 51。
  { label: "sk", pattern: /(?:(?<![A-Za-z0-9_])|(?<=\x1b\[[0-9;]*m)|(?<=\\u001b\[[0-9;]*m))sk-[A-Za-z0-9_-]{16,}/g, keepTailChars: 4 },
  // GitHub：ghp_/gho_/ghu_/ghs_/ghr_。实测真实值 40 位。
  { label: "github", pattern: /(?:(?<![A-Za-z0-9_])|(?<=\x1b\[[0-9;]*m)|(?<=\\u001b\[[0-9;]*m))gh[pousr]_[A-Za-z0-9]{16,}/g, keepTailChars: 4 },
  // Slack：xoxb-/xoxp-/xoxa-/xoxr-。
  { label: "slack", pattern: /(?:(?<![A-Za-z0-9_])|(?<=\x1b\[[0-9;]*m)|(?<=\\u001b\[[0-9;]*m))xox[bpar]-[A-Za-z0-9-]{10,}/g, keepTailChars: 4 },
  // AWS access key id：固定 20 位大写字母+数字，前缀 AKIA/ASIA。
  // 尾部的 `\b` 保留：真实值恰好 20 位，加上它可以避免把更长的标识符切一半。
  // （曾经在这里删掉 `\b` 去"修"测试，其实是测试夹具写成了 24 位——不要再犯。）
  { label: "aws", pattern: /(?:(?<![A-Za-z0-9_])|(?<=\x1b\[[0-9;]*m)|(?<=\\u001b\[[0-9;]*m))(?:AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Z])/g, keepTailChars: 4 },
  // 私钥块的头：整段抹掉类型名以外的部分。
  { label: "pem", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, keepTailChars: 0 },
]

const GROUPED_PATTERNS: readonly GroupedPattern[] = [
  // 显式赋值：token = "…" / api_key: '…' / password = "…"。
  // 只匹配「键名 + 分隔符 + 引号」这种明确意图，不碰自然语言里的同名词。
  {
    label: "凭据",
    pattern:
      /(\b(?:token|secret|password|passwd|api_key|apikey|app_secret|access_key|client_secret)\b\s*[=:]\s*["'])([^"'\s]{16,})(["'])/gi,
    keepTailChars: 4,
  },
  // Authorization / Bearer 头里的裸凭证。
  {
    label: "凭据",
    pattern: /(\bBearer\s+)([A-Za-z0-9._~+/=-]{20,})/g,
    keepTailChars: 4,
  },
]

/** 生成脱敏标记，例如 `sk-…AUNx`；`keepTailChars <= 0` 时整段隐去。 */
function buildRedactedToken(label: string, originalValue: string, keepTailChars: number): string {
  if (keepTailChars <= 0) return `[已隐去 ${label} 私钥]`
  return `${label}-…${originalValue.slice(-keepTailChars)}`
}

/**
 * 把一段文本里所有可识别的凭据替换成「类型-…末4位」。
 *
 * 纯函数、全函数：任何输入都不抛异常，无 IO、无全局状态。
 * 替换标记本身也占字符，所以结果不保证更短——可读性优先于长度。
 */
export function redactCredentials(text: string): string {
  if (typeof text !== "string" || text === "") return typeof text === "string" ? text : ""

  let redactedText = text

  for (const { label, pattern, keepTailChars } of WHOLE_MATCH_PATTERNS) {
    redactedText = redactedText.replace(pattern, (matchedText) =>
      buildRedactedToken(label, matchedText, keepTailChars),
    )
  }

  for (const { label, pattern, keepTailChars } of GROUPED_PATTERNS) {
    redactedText = redactedText.replace(pattern, (matchedText, leadingPart, credentialValue, trailingPart) => {
      // 找不到凭证段就原样返回，绝不让一次匹配把整行吃掉。
      if (typeof credentialValue !== "string" || credentialValue === "") return matchedText
      const keptTrailing = typeof trailingPart === "string" ? trailingPart : ""
      return `${leadingPart}${buildRedactedToken(label, credentialValue, keepTailChars)}${keptTrailing}`
    })
  }

  return redactedText
}