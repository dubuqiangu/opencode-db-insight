/**
 * 回放消息文本提取单点（v0.10.0）。
 *
 * 这六个纯函数（asRecord / partText / readMessageText / readToolName /
 * readToolInput / readToolOutput）——渲染（replay-timeline 的时间线正文）
 * 与搜索（replay-search 的文本视图）共用同一出处，杜绝两处各写一份
 * 提取逻辑——口径若漂移，搜索就会出现「搜得到却渲染不出来」或反向
 * （v0.10.0 收敛探针实证的第二种：工具入参渲染得出来却搜不到，
 * readToolInput 即为补齐）的错位。
 * `data` 的解释口径与 src/export/message-roles.ts 逐条对齐（工具名
 * name→tool 回退；输出 state.metadata.output→state.content 回退）。
 *
 * 对齐不变量（关键，改任一侧前先读）：buildReplaySearchIndex 的第 i 项
 * 与 renderTimeline 第 i 个可见消息节点一一对应——两侧用同一个
 * isVisibleReplayMessageType 过滤、同一 record 顺序（seq 升序）。
 * 搜索命中按该对齐直接换算成「时间线第 i 个子节点」，节点级高亮
 * （replay-node.replay-hit）据此定位。
 */

/** 回放视图忽略的消息类型（idle/synthetic 不渲染，也就不可搜索）。 */
export function isVisibleReplayMessageType(messageType) {
  return messageType !== "idle" && messageType !== "synthetic";
}

export function asRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}

export function partText(contentPart) {
  if (contentPart === null || typeof contentPart !== "object") return "";
  if (String(contentPart.type) !== "text") return "";
  return typeof contentPart.text === "string" ? contentPart.text : "";
}

export function readMessageText(dataRecord) {
  if (dataRecord === null || typeof dataRecord !== "object") return "";
  const textField = dataRecord.text;
  if (typeof textField === "string") return textField;
  if (Array.isArray(dataRecord.content)) {
    return dataRecord.content
      .map((part) => partText(part))
      .filter((text) => text !== "")
      .join("\n\n");
  }
  return "";
}

export function readToolName(toolPartRecord) {
  let toolName = typeof toolPartRecord.name === "string" ? toolPartRecord.name : "";
  if (toolName === "") toolName = typeof toolPartRecord.tool === "string" ? toolPartRecord.tool : "";
  return toolName === "" ? "unknown" : toolName;
}

/**
 * 工具入参的展示串（第六类可搜索文本，v0.10.0 收敛探针补齐）：
 * state.input 非 null/undefined 时 `JSON.stringify(input, null, 2)`
 * （字符串入参为带引号的 JSON 字面量），否则 ""。
 * **结构单点**（ora-5 P2 修复）：渲染侧（replay-timeline 工具块的参数
 * pre）消费本函数作为唯一出处——展示形态只有这一份代码，搜索 haystack
 * 的入参段自动同源；改形态只改这里，渲染与搜索必然一起变。「看得见
 * 搜不到」的错位不再靠注释纪律维持，而由结构消灭、由渲染→搜索的
 * 包含性集成测试锁死。
 */
export function readToolInput(stateRecord) {
  if (stateRecord === null || typeof stateRecord !== "object") return "";
  if (stateRecord.input === undefined || stateRecord.input === null) return "";
  return JSON.stringify(stateRecord.input, null, 2);
}

export function readToolOutput(stateRecord) {
  if (stateRecord === null || typeof stateRecord !== "object") return "";
  const metadata = stateRecord.metadata;
  if (metadata !== null && typeof metadata === "object" && typeof metadata.output === "string" && metadata.output !== "") {
    return metadata.output;
  }
  if (Array.isArray(stateRecord.content)) {
    return stateRecord.content.map((part) => partText(part)).filter((text) => text !== "").join("\n\n");
  }
  return "";
}

/**
 * 回放页工具输出的**渲染/搜索共用上限**（v0.24.0）。
 *
 * 实测本机库 59093 条消息，单条 data 最大 4.28 MB，354 条超 100 KB。回放页
 * 原来把 toolOutput 全量塞进 <pre> 的 textContent：4 MB 的单个文本节点会让
 * 布局与滚动明显卡顿，而这段内容在折叠状态下根本看不见。
 *
 * 上限放在本模块而不是 replay-timeline.js 的理由与其它提取函数一致：
 * 渲染与搜索必须**同源**。若只截渲染、搜索仍扫全文，就会出现「搜得到却
 * 看不见」（点进去命中，展开却找不到词）；反过来只截搜索则相反。所以
 * 两侧都调用 readToolOutputForDisplay —— 至少看到的那段必然搜得到。
 *
 * 导出 Markdown 不走这里（format-helpers.ts 的 truncateToolOutput 有自己的
 * 4000 字符预算，且导出要的是「有标注的截断」而不是静默丢弃）。两处预算
 * 不同是有意的：回放页是交互浏览，宽一些；导出是文档，窄一些。因此回放页
 * 的提示**不能**让用户「导出看全文」——导出只会更短。
 */
export const TOOL_OUTPUT_DISPLAY_MAX_CHARS = 200_000;

/** 按上限于码元边界截断，不留孤立高位代理（emoji 被切半会让 DOM 报错）。 */
export function truncateForDisplay(text, characterLimit = TOOL_OUTPUT_DISPLAY_MAX_CHARS) {
  const rawText = typeof text === "string" ? text : "";
  if (rawText.length <= characterLimit) return { text: rawText, truncated: false, totalChars: rawText.length };
  let cutText = rawText.slice(0, characterLimit);
  if (/[\ud800-\udbff]$/.test(cutText)) cutText = cutText.slice(0, -1);
  return { text: cutText, truncated: true, totalChars: rawText.length };
}

/** 渲染与搜索共用：工具输出的展示文本（超上限即截断）。 */
export function readToolOutputForDisplay(stateRecord) {
  return truncateForDisplay(readToolOutput(stateRecord));
}

/**
 * 回放页 thinking（reasoning）正文的展示上限（v0.24.x）。
 *
 * 比工具输出更紧，理由是实测：reasoning 是唯一真正超 100k 的渲染面
 * （最大 150,908，18 个超 100k），而 text part 与 tool output 都远低于 200k；
 * 且它默认**展开**，一进页面就吃这份布局成本。
 *
 * **搜索侧必须用同一上限**（教训，别再改回去）：初版让搜索扫全文，理由写的
 * 是「reasoning 默认展开，命中第一眼就能看到所在段落」——这对超过 100k 的
 * 那 18 个 part 是假的。用户搜第 120k 字符处的短语，计数说「1 处命中」，
 * 跳到节点，**那段文字在 DOM 里根本不存在**，而展开态也无可再展开。这正是
 * 本模块存在的意义所要消灭的「搜得到却看不见」。标注了总长度并不能让一个
 * 不存在的命中变得可见。故 render 与 search 同源（见 buildSearchableMessageText
 * 的 reasoning 分支），本模块的对齐不变量重新处处成立。
 */
export const REASONING_DISPLAY_MAX_CHARS = 100_000;

/**
 * 单条消息的**可搜索文本**（六类）：user 正文、assistant text part、
 * reasoning part、tool name、**tool input（入参，v0.10.0 收敛探针补齐）**、
 * tool output。收敛探针实证：工具入参在 UI 上渲染为参数 pre（与 tool
 * output 同一折叠块）却不在搜索面里，「看得见却搜不到」违反对齐原则；
 * 入参常含完整命令/文件路径/上下文，是回放搜索的高价值面。
 * 通知行（system / model-switched / compaction）刻意排除：契约搜索范围
 * 不含它们，且其渲染文本是截断（≤80 字符）拼装，搜全文会命中
 * 「渲染不出来的文本」。
 * 多段落以 "\n\n" 拼接——搜索按整条消息的合并视图匹配，命中单位是
 * 消息节点（节点级高亮下一节点一处）。tool 分支的段落顺序
 * name → input → output 与工具块 UI 阅读顺序一致（summary 工具名 →
 * 参数 pre → 输出块）。
 */
function buildSearchableMessageText(messageRecord) {
  const dataRecord = asRecord(messageRecord.data);
  if (dataRecord === null) return "";
  const messageType = String(messageRecord.type ?? "");
  if (messageType !== "user" && messageType !== "assistant") return "";
  const passages = [readMessageText(dataRecord)];
  if (messageType === "assistant" && Array.isArray(dataRecord.content)) {
    for (const contentPart of dataRecord.content) {
      const partRecord = asRecord(contentPart);
      if (partRecord === null) continue;
      const partType = String(partRecord.type ?? "");
      if (partType === "reasoning") {
        // 与渲染同源（v0.24.x 修正）：渲染侧把 reasoning 截到
        // REASONING_DISPLAY_MAX_CHARS，搜索面必须同样截断。初版这里推全文，
        // 导致「计数说命中、跳过去却看不见那段文字」——正是本模块要消灭的
        // 错位。truncateForDisplay 是纯函数，不依赖 state，可直接在此调用。
        passages.push(truncateForDisplay(typeof partRecord.text === "string" ? partRecord.text : "", REASONING_DISPLAY_MAX_CHARS).text);
      } else if (partType === "tool") {
        passages.push(readToolName(partRecord));
        passages.push(readToolInput(asRecord(partRecord.state)));
        // 与渲染同源：搜索面只覆盖**看得见的那段**（超上限部分被截掉），
        // 否则会搜到「渲染不出来的文本」，点进去展开也找不到。
        passages.push(readToolOutputForDisplay(asRecord(partRecord.state)).text);
      }
    }
  }
  return passages.filter((passage) => passage !== "").join("\n\n");
}

/**
 * 搜索文本视图：按时间线可见顺序（过滤 idle/synthetic，同 renderTimeline）
 * 为每条消息预计算一份小写合并 haystack。大小写不敏感由「两侧同 lower」
 * 达成——查询词调用方自行 toLowerCase 后 includes。
 * 一次性预计算（消息全量在内存），逐键搜索只做 includes，长会话不卡。
 */
export function buildReplaySearchIndex(messageRecords) {
  const visibleRecords = (Array.isArray(messageRecords) ? messageRecords : [])
    .filter((record) => isVisibleReplayMessageType(String(record.type ?? "")));
  return visibleRecords.map((record) => ({
    haystack: buildSearchableMessageText(record).toLowerCase(),
  }));
}
