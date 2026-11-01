/**
 * Wave 2A mock 生产者（v0.29.0）：A4 会话内容构成。
 *
 * 单独成文件（不改 mock-data.js）：形状严格对齐合同 §5.3 的冻结响应体，
 * 供 data-source.js 的 USE_MOCK 分支消费，离线预览能看到六分类水平堆叠条、
 * 图例表与工具 token 估算行的完整路径。
 *
 *   getMockContentComposition() → GET /api/content-composition[?session=]
 *     { totalChars, categories:[{ key, chars, share }], toolEstimatedTokens,
 *       sessions }
 *
 * 口径（合同 §5.2 点 1）：构成按 `length()` **字符量**归因，**不是** token
 * 量——真实 token 无法归因到内容分类。工具 token 估算单独一条（🟡），由
 * 工具输入/输出字符量按 `tokenWeight` 量级换算，仅作量级参考。
 *
 * 各分类的 chars 刻意取不整除的值，让 share 的四舍五入看得见（图例与堆叠
 * 条仍自洽：前端一律用 chars / 合计重算占比，不信任 wire 上的 share 字段）。
 */

/**
 * 六分类的字符量（合同 §5.3 的 key 白名单）。
 * chars 降序即后端保证的排序；下面按 chars 降序摆放，读起来与真库一致。
 */
const MOCK_CATEGORY_CHARS = [
  { key: "assistantText", chars: 3_120_450 },
  { key: "toolOutput", chars: 2_845_600 },
  { key: "toolInput", chars: 1_204_300 },
  { key: "reasoning", chars: 986_700 },
  { key: "userText", chars: 412_900 },
  { key: "other", chars: 24_500 },
];

/** 被计入工具 token 估算的分类（工具输入 + 工具输出）。 */
const TOOL_CATEGORY_KEYS = new Set(["toolInput", "toolOutput"]);

/**
 * 工具 token 估算（🟡）：由工具分类字符量按经验系数换算，仅示意。
 * 真实后端走 tool-token-queries.ts 的 `tokenWeight(charCount, byteCount)`；
 * 这里没有字节量，用字符量的固定比例给出一个同量级的估算值。
 */
const TOOL_CHARS_PER_TOKEN = 4;

/** 分类字符量合计（share 的分母）。 */
function sumCategoryChars(categoryChars) {
  return categoryChars.reduce((sum, category) => sum + category.chars, 0);
}

/**
 * GET /api/content-composition 的 mock 响应体：categories 按 chars desc、
 * key asc（合同 §5.3 的确定性排序），share = chars / totalChars（分母 0 → 0）。
 */
export function getMockContentComposition() {
  const totalChars = sumCategoryChars(MOCK_CATEGORY_CHARS);
  const categories = [...MOCK_CATEGORY_CHARS]
    .sort(
      (left, right) =>
        right.chars - left.chars || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0),
    )
    .map((category) => ({
      key: category.key,
      chars: category.chars,
      share: totalChars === 0 ? 0 : category.chars / totalChars,
    }));

  const toolChars = MOCK_CATEGORY_CHARS
    .filter((category) => TOOL_CATEGORY_KEYS.has(category.key))
    .reduce((sum, category) => sum + category.chars, 0);

  return {
    totalChars,
    categories,
    toolEstimatedTokens: Math.round(toolChars / TOOL_CHARS_PER_TOKEN),
    sessions: 348,
  };
}
