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
        passages.push(typeof partRecord.text === "string" ? partRecord.text : "");
      } else if (partType === "tool") {
        passages.push(readToolName(partRecord));
        passages.push(readToolInput(asRecord(partRecord.state)));
        passages.push(readToolOutput(asRecord(partRecord.state)));
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
