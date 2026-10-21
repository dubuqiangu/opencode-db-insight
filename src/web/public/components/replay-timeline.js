/**
 * 回放角色时间线（T4.2）：🧑 用户正文 / 🤖 助手正文 / 💭 reasoning（默认展开，
 * 可折叠）/ 🔧 工具调用（参数+输出代码块；单块超 4000 字符默认折叠）/ 🔔
 * system·model-switched·compaction 斜体分隔行。idle/synthetic 跳过。
 *
 * 消息 `data` 的解释口径与 src/export/message-roles.ts 逐条对齐
 * （工具名 name→tool 回退；输出 state.metadata.output→state.content 回退）。
 * 文本提取函数自 v0.10.0 起共享自 replay-message-text.js（渲染与搜索
 * 共用同一出处）。大会话分页：每块最多 200 条，且整块的正文预算不超过
 * 300,000 字符（见 DEFAULT_PAGE_CHAR_BUDGET），"加载更多"逐块追加。
 */

import { formatDateTime, escapeHtml } from "../format.js";
import { buildTurnCostBarElement } from "./replay-turn-bar.js";
import {
  asRecord,
  partText,
  readMessageText,
  readToolName,
  readToolInput,
  readToolOutputForDisplay,
  TOOL_OUTPUT_DISPLAY_MAX_CHARS,
  REASONING_DISPLAY_MAX_CHARS,
  truncateForDisplay,
  isVisibleReplayMessageType,
} from "./replay-message-text.js";

const DEFAULT_PAGE_SIZE = 200;
/**
 * 单块正文预算（字符，v0.24.x）。条数上限本身不封顶布局成本：实测本机库
 * 1041 个有可见消息的会话里，200 条一块的正文长度中位数 112,823、p95
 * 708,134、p99 1,062,388、最大 1,744,374——也就是说约 11% 的会话一打开就
 * 要布局几十万到一百多万字符。预算取 300,000 的依据：
 * - 落在 p50 与 p95 之间偏保守的位置，中位数会话（112k）的首屏块仍是完整
 *   200 条，普通小会话的分页行为逐字不变；
 * - 最坏单条正文约 2×10⁵ 字符（工具输出上限）+ 1×10⁵（思考过程上限），
 *   一块装不下两条最重的消息——重的会话会自然切成每块 2~数条；
 * - 1,744,374 这样的最大首屏切成约 6 块，首屏布局量降到原来的六分之一
 *   左右，剩下的一次点击一块，不会一次性回流所有内容。
 * 预算按「预估正文长度」判断，不做 DOM 测量：测量要等布局完成，那正是
 * 我们要避免的开销。
 */
const DEFAULT_PAGE_CHAR_BUDGET = 300_000;
/** 单个工具块（参数+输出）超过此字符数默认折叠。 */
const TOOL_BLOCK_COLLAPSE_THRESHOLD = 4000;

const ASSISTANT_MODEL_COLORS = ["var(--m1)", "var(--m2)", "var(--m6)", "var(--m4)"];

/* ---------------- 单条消息节点 ---------------- */

function buildNodeShell(roleClass, iconGlyph, timeCreated, messageId) {
  const nodeElement = document.createElement("article");
  nodeElement.className = `replay-node ${roleClass}`;
  // 深链定位与「复制链接」都靠这个属性：节点必须自带消息 id，否则一旦
  // 时间线重排、分页追加，就没有任何稳定锚点可以把 URL 换算回节点。
  // 与 messageRecords[i].id 同值（构建时直接取，不做二次编码）。
  if (typeof messageId === "string" && messageId !== "") {
    nodeElement.dataset.messageId = messageId;
    nodeElement.id = `msg-${messageId}`;
  }
  const iconElement = document.createElement("span");
  iconElement.className = "replay-icon";
  iconElement.textContent = iconGlyph;
  nodeElement.appendChild(iconElement);
  const bodyElement = document.createElement("div");
  bodyElement.className = "replay-body";
  nodeElement.appendChild(bodyElement);
  if (Number.isFinite(timeCreated) && timeCreated > 0) {
    const timeElement = document.createElement("span");
    timeElement.className = "replay-time num";
    timeElement.textContent = formatDateTime(timeCreated);
    nodeElement.appendChild(timeElement);
  }
  return { nodeElement, bodyElement };
}

function buildUserNode(messageRecord) {
  const userText = readMessageText(asRecord(messageRecord.data));
  if (userText.trim() === "") return null;
  const { nodeElement, bodyElement } = buildNodeShell("role-user", "🧑", messageRecord.timeCreated, messageRecord.id);
  const textElement = document.createElement("div");
  textElement.className = "replay-text";
  textElement.textContent = userText;
  bodyElement.appendChild(textElement);
  return nodeElement;
}

function buildReasoningPartElement(reasoningText) {
  const detailsElement = document.createElement("details");
  detailsElement.className = "replay-reasoning";
  // v0.24.x：reasoning **默认展开**，所以它的大块正文会立刻进入布局。
  // 实测本机库最大 reasoning part 有 150,908 字符、18 个超 100k，而 text
  // part 与 tool output 都没到 100k——真正需要截断的是这里。折叠不是保护：
  // 用户一进来看到的就是展开态。
  const reasoningDisplay = truncateForDisplay(reasoningText, REASONING_DISPLAY_MAX_CHARS);
  detailsElement.open = true; // 默认展开（spec），点标题可折叠
  const summaryElement = document.createElement("summary");
  summaryElement.textContent = reasoningDisplay.truncated
    ? `💭 思考过程 · ${reasoningDisplay.totalChars.toLocaleString("en-US")} 字符`
    : "💭 思考过程";
  detailsElement.appendChild(summaryElement);
  const textElement = document.createElement("div");
  textElement.className = "replay-text muted";
  textElement.textContent = reasoningDisplay.text;
  detailsElement.appendChild(textElement);
  if (reasoningDisplay.truncated) {
    const truncationNote = document.createElement("div");
    truncationNote.className = "replay-code-truncation";
    truncationNote.textContent =
      `仅显示前 ${REASONING_DISPLAY_MAX_CHARS.toLocaleString("en-US")} 字符，` +
      `完整思考过程共 ${reasoningDisplay.totalChars.toLocaleString("en-US")} 字符`;
    detailsElement.appendChild(truncationNote);
  }
  return detailsElement;
}

function buildToolPartElement(toolPartRecord) {
  const toolName = readToolName(toolPartRecord);
  const stateRecord = asRecord(toolPartRecord.state);
  // 参数 pre 的展示文本出自 readToolInput 单点（replay-message-text.js，
  // ora-5 P2 修复）：展示形态只有这一份代码，渲染与搜索文本视图必然
  // 同源——改形态两侧一起变，「看得见搜不到」不再靠注释纪律维持。
  const paramsJson = readToolInput(stateRecord);
  const toolOutputDisplay = readToolOutputForDisplay(stateRecord);
  const toolOutput = toolOutputDisplay.text;
  // 折叠阈值按**完整**长度判断：被截断的大输出一定是超长块，仍应默认折叠。
  const blockLength = paramsJson.length + toolOutputDisplay.totalChars;

  const detailsElement = document.createElement("details");
  detailsElement.className = "replay-tool";
  detailsElement.open = blockLength <= TOOL_BLOCK_COLLAPSE_THRESHOLD; // 超长默认折叠
  const summaryElement = document.createElement("summary");
  const statusText = stateRecord === null ? "" : String(stateRecord.status ?? "");
  const statusSuffix = statusText !== "" && statusText !== "completed" ? `（${escapeHtml(statusText)}）` : "";
  summaryElement.innerHTML = `🔧 <code>${escapeHtml(toolName)}</code>${statusSuffix}` +
    ` <span class="replay-tool-size num">${blockLength > TOOL_BLOCK_COLLAPSE_THRESHOLD ? `${blockLength.toLocaleString("en-US")} 字符 · 点击展开` : ""}</span>`;
  detailsElement.appendChild(summaryElement);

  if (paramsJson !== "") {
    const inputBlock = document.createElement("pre");
    inputBlock.className = "replay-code lang-json";
    inputBlock.textContent = paramsJson;
    detailsElement.appendChild(inputBlock);
  }
  if (toolOutput.trim() !== "") {
    const outputHead = document.createElement("div");
    outputHead.className = "replay-code-head";
    outputHead.textContent = "输出";
    detailsElement.appendChild(outputHead);
    const outputBlock = document.createElement("pre");
    outputBlock.className = "replay-code lang-text";
    outputBlock.textContent = toolOutput;
    detailsElement.appendChild(outputBlock);
    // 截断要**说出来**：静默丢内容会让用户以为工具没输出那么多。
    // 注意导出 Markdown 的上限更低（4000 字符），所以提示里不引导用户
    // 去导出看全文——那样只会看到更短的一段。
    if (toolOutputDisplay.truncated) {
      const truncationNote = document.createElement("div");
      truncationNote.className = "replay-code-truncation";
      truncationNote.textContent =
        `仅显示前 ${TOOL_OUTPUT_DISPLAY_MAX_CHARS.toLocaleString("en-US")} 字符，` +
        `完整输出共 ${toolOutputDisplay.totalChars.toLocaleString("en-US")} 字符`;
      detailsElement.appendChild(truncationNote);
    }
  }
  return detailsElement;
}

function buildAssistantNode(messageRecord, timelineState) {
  const dataRecord = asRecord(messageRecord.data);
  const contentParts = dataRecord !== null && Array.isArray(dataRecord.content) ? dataRecord.content : [];

  const modelRecord = dataRecord === null ? null : asRecord(dataRecord.model);
  const modelId = modelRecord === null ? "" : String(modelRecord.id ?? "");
  const modelChanged = modelId !== "" && timelineState.lastAssistantModelId !== null && modelId !== timelineState.lastAssistantModelId;
  if (modelId !== "") timelineState.lastAssistantModelId = modelId;

  const { nodeElement, bodyElement } = buildNodeShell("role-assistant", "🤖", messageRecord.timeCreated, messageRecord.id);

  const metaLine = document.createElement("div");
  metaLine.className = "replay-assistant-meta";
  const modelColorIndex = timelineState.assistantModelCounter % ASSISTANT_MODEL_COLORS.length;
  timelineState.assistantModelCounter += 1;
  metaLine.innerHTML = `${modelId !== "" ? `<span class="replay-model-chip" style="color:${ASSISTANT_MODEL_COLORS[modelColorIndex]}">${escapeHtml(modelId)}</span>` : ""}` +
    `${dataRecord !== null && dataRecord.agent ? ` <span class="badge">${escapeHtml(String(dataRecord.agent))}</span>` : ""}`;
  bodyElement.appendChild(metaLine);

  for (const contentPart of contentParts) {
    const partRecord = asRecord(contentPart);
    if (partRecord === null) continue;
    const partType = String(partRecord.type ?? "");
    if (partType === "text") {
      const textPassage = typeof partRecord.text === "string" ? partRecord.text : "";
      if (textPassage.trim() === "") continue;
      const textElement = document.createElement("div");
      textElement.className = "replay-text";
      textElement.textContent = textPassage;
      bodyElement.appendChild(textElement);
    } else if (partType === "reasoning") {
      const reasoningPassage = typeof partRecord.text === "string" ? partRecord.text : "";
      if (reasoningPassage.trim() === "") continue;
      bodyElement.appendChild(buildReasoningPartElement(reasoningPassage));
    } else if (partType === "tool") {
      bodyElement.appendChild(buildToolPartElement(partRecord));
    }
  }

  // turn 级成本条（T4.4）：挂在助手块底部
  const tokensRecord = dataRecord === null ? null : dataRecord.tokens;
  const turnBarElement = buildTurnCostBarElement(tokensRecord, modelId, modelChanged);
  if (turnBarElement !== null) bodyElement.appendChild(turnBarElement);

  return nodeElement;
}

function buildNoticeLine(messageType, dataRecord) {
  if (messageType === "system") {
    const systemText = dataRecord === null ? "" : readMessageText(dataRecord).replace(/\s+/g, " ").trim();
    return systemText === "" ? "系统指令更新（内容缺失）" : `系统指令更新: ${truncateNotice(systemText)}`;
  }
  if (messageType === "model-switched") {
    const currentModelId = readModelIdField(dataRecord, "model");
    const previousModelId = readModelIdField(dataRecord, "previous");
    return `模型切换: ${previousModelId} → ${currentModelId}`;
  }
  if (messageType === "compaction") {
    const compactionReason = dataRecord === null ? "" : String(dataRecord.reason ?? "").replace(/\s+/g, " ").trim();
    const compactionSummary = dataRecord === null ? "" : String(dataRecord.summary ?? "").replace(/\s+/g, " ").trim();
    return `上下文压缩（${compactionReason === "" ? "未知原因" : compactionReason}）: ${truncateNotice(compactionSummary)}`;
  }
  return `未知消息类型（${messageType}）`;
}

function readModelIdField(dataRecord, modelKey) {
  const modelRecord = dataRecord === null ? null : asRecord(dataRecord[modelKey]);
  const modelId = modelRecord === null ? "" : String(modelRecord.id ?? "");
  return modelId === "" ? "未知" : modelId;
}

function truncateNotice(text, maxLength = 80) {
  const singleLineText = text.replace(/\s+/g, " ").trim();
  return singleLineText.length > maxLength ? singleLineText.slice(0, maxLength - 1) + "…" : singleLineText;
}

function buildNoticeNode(messageRecord) {
  const dataRecord = asRecord(messageRecord.data);
  const noticeText = buildNoticeLine(String(messageRecord.type ?? ""), dataRecord);
  const nodeElement = document.createElement("div");
  nodeElement.className = "replay-notice";
  // 通知行也带 id：深链可能指向 system / model-switched / compaction，
  // 它们同样是可定位的消息节点。
  if (typeof messageRecord.id === "string" && messageRecord.id !== "") {
    nodeElement.dataset.messageId = messageRecord.id;
    nodeElement.id = `msg-${messageRecord.id}`;
  }
  nodeElement.innerHTML = `🔔 <em>${escapeHtml(noticeText)}</em>`;
  if (Number.isFinite(messageRecord.timeCreated) && messageRecord.timeCreated > 0) {
    const timeElement = document.createElement("span");
    timeElement.className = "replay-time num";
    timeElement.textContent = formatDateTime(messageRecord.timeCreated);
    nodeElement.appendChild(timeElement);
  }
  return nodeElement;
}

/* ---------------- 时间线容器 + 分页 ---------------- */

/**
 * 估算单条消息渲染后铺在页面上的正文长度（字符）。
 *
 * 只算「会进入布局的可见正文」，与各 build*Node 实际写入 DOM 的规则一致：
 * - user：readMessageText 全文（空文本走占位节点，长度接近 0）；
 * - assistant：text part 全文 + reasoning 的展示截断长度（折叠与否都算，
 *   因为 reasoning 默认展开）+ 工具块的参数与输出展示长度；
 * - 通知行：正文是 ≤80 字符的拼装串，按小常量计。
 * 估算值略偏大（含截断说明与元信息行的开销）是有意的：宁可提前切块，
 * 也不要让某个超重消息因为低估而挤进上一块。
 */
function estimateNodeCharCost(messageRecord) {
  const messageType = String(messageRecord.type ?? "");
  const dataRecord = asRecord(messageRecord.data);
  if (dataRecord === null) return 0;
  if (messageType === "user") return readMessageText(dataRecord).length;
  if (messageType !== "assistant") return 200; // 通知行：拼装串 + 图标时间

  let totalCost = 0;
  const contentParts = Array.isArray(dataRecord.content) ? dataRecord.content : [];
  for (const contentPart of contentParts) {
    const partRecord = asRecord(contentPart);
    if (partRecord === null) continue;
    const partType = String(partRecord.type ?? "");
    if (partType === "text") {
      totalCost += typeof partRecord.text === "string" ? partRecord.text.length : 0;
    } else if (partType === "reasoning") {
      const reasoningPassage = typeof partRecord.text === "string" ? partRecord.text : "";
      totalCost += Math.min(reasoningPassage.length, REASONING_DISPLAY_MAX_CHARS) + 200;
    } else if (partType === "tool") {
      const stateRecord = asRecord(partRecord.state);
      totalCost += readToolInput(stateRecord).length + readToolOutputForDisplay(stateRecord).text.length + 200;
    }
  }
  return totalCost;
}

/**
 * 渲染角色时间线，返回分页控制器：
 *   { appendNextChunk(): boolean, hasMore, visibleCount,
 *     renderedCount, nodeAt(index) }
 * messageRecords 需已按 seq 升序（后端 ORDER BY seq ASC）。
 * v0.10.0 增 renderedCount / nodeAt：会话内搜索（replay-search.js）的
 * 命中定位需要知道「DOM 渲染到第几条」并按可见序号取节点——时间线第 i
 * 个子节点恒等于第 i 条可见消息（buildMessageNode 每条消息恰好产出一个
 * 节点），与 buildReplaySearchIndex 的第 i 项对齐（见
 * replay-message-text.js 头部的对齐不变量）。
 *
 * v0.24.x 起每块受**双重封顶**：条数不超过 pageSize，正文估算不超过
 * charBudget。预算只影响「一批装多少条」，不影响分页语义——无论哪一侧
 * 先到上限，appendNextChunk 都从 renderedCount 连续渲染到块尾，所以调用
 * 若干次之后前 N 条必然齐全，nodeAt(i) 仍是第 i 条。这一点是搜索导航与
 * 深链定位的正确性基础，不要在追加时跳过任何一条。
 *
 * 每块至少 1 条：单条就超预算时也照样渲染它，否则 renderedCount 不再前进，
 * 搜索导航与深链的 while 循环会永远转下去。
 */
export function renderTimeline(
  container,
  messageRecords,
  pageSize = DEFAULT_PAGE_SIZE,
  charBudget = DEFAULT_PAGE_CHAR_BUDGET,
) {
  const visibleRecords = (Array.isArray(messageRecords) ? messageRecords : [])
    .filter((record) => isVisibleReplayMessageType(String(record.type ?? "")));

  const listElement = document.createElement("div");
  listElement.className = "replay-timeline";
  container.innerHTML = "";
  container.appendChild(listElement);

  const timelineState = { lastAssistantModelId: null, assistantModelCounter: 0 };
  let renderedCount = 0;

  /** 自 chunkStart 起按「条数 + 字符预算」算出本块结束下标（至少 1 条）。 */
  function resolveChunkEnd(chunkStart) {
    const countLimit = Math.min(chunkStart + pageSize, visibleRecords.length);
    let chunkChars = 0;
    let chunkEnd = chunkStart;
    while (chunkEnd < countLimit) {
      const nodeCharCost = estimateNodeCharCost(visibleRecords[chunkEnd]);
      // 先判「加上这条会不会超」，再决定是否停下：第一条无条件收下。
      if (chunkEnd > chunkStart && chunkChars + nodeCharCost > charBudget) break;
      chunkChars += nodeCharCost;
      chunkEnd += 1;
    }
    return chunkEnd;
  }

  const controller = {
    hasMore: false,
    visibleCount: visibleRecords.length,
    get renderedCount() {
      return renderedCount;
    },
    /** 时间线第 index 个子节点（未渲染区间返回 null）。 */
    nodeAt(index) {
      return index >= 0 && index < renderedCount ? listElement.children[index] : null;
    },
    appendNextChunk() {
      const chunkEnd = resolveChunkEnd(renderedCount);
      const fragment = document.createDocumentFragment();
      for (let index = renderedCount; index < chunkEnd; index += 1) {
        fragment.appendChild(buildMessageNode(visibleRecords[index], timelineState));
      }
      listElement.appendChild(fragment);
      renderedCount = chunkEnd;
      controller.hasMore = renderedCount < visibleRecords.length;
      return controller.hasMore;
    },
  };
  controller.appendNextChunk();
  return controller;
}

function buildMessageNode(messageRecord, timelineState) {
  const messageType = String(messageRecord.type ?? "");
  if (messageType === "user") return buildUserNode(messageRecord) ?? buildSkippedNode(messageRecord.id);
  if (messageType === "assistant") return buildAssistantNode(messageRecord, timelineState);
  return buildNoticeNode(messageRecord); // system / model-switched / compaction / 未知
}

/** 空文本 user 消息占位（保持时间线连贯，不隐藏空洞）。 */
function buildSkippedNode(messageId) {
  const nodeElement = document.createElement("div");
  nodeElement.className = "replay-notice";
  // 占位节点在可见序列里占一格：id 必须跟着走，否则深链会错位到隔壁。
  if (typeof messageId === "string" && messageId !== "") {
    nodeElement.dataset.messageId = messageId;
    nodeElement.id = `msg-${messageId}`;
  }
  nodeElement.innerHTML = `🧑 <em>（用户消息无文本内容）</em>`;
  return nodeElement;
}

/** 汇总：Σ(input+output+cache.read) 与 assistant 步数（头部用）。 */
export function summarizeReplayTokens(messageRecords) {
  let totalTokens = 0;
  let assistantStepCount = 0;
  for (const messageRecord of Array.isArray(messageRecords) ? messageRecords : []) {
    if (String(messageRecord.type ?? "") !== "assistant") continue;
    assistantStepCount += 1;
    const dataRecord = asRecord(messageRecord.data);
    const tokensRecord = dataRecord === null ? null : asRecord(dataRecord.tokens);
    if (tokensRecord === null) continue;
    totalTokens += numberOrZero(tokensRecord.input) + numberOrZero(tokensRecord.output) +
      numberOrZero(asRecord(tokensRecord.cache)?.read);
  }
  return { totalTokens, assistantStepCount };
}

/**
 * 会话级严格命中率：src/stats/hit-rate.ts strictHitRate 的前端复刻。
 * Σcache.read / Σ(cache.read + input + cache.write) —— cache.write 计入
 * 分母（与看板顶部命中率口径的区别就在这一项）。
 * 分母为 0（会话没有任何 token 流水）时返回 null，由调用方省略指标。
 */
export function summarizeStrictHitRate(messageRecords) {
  let cacheReadTotal = 0;
  let paidInputTotal = 0;
  let cacheWriteTotal = 0;
  for (const messageRecord of Array.isArray(messageRecords) ? messageRecords : []) {
    if (String(messageRecord.type ?? "") !== "assistant") continue;
    const dataRecord = asRecord(messageRecord.data);
    const tokensRecord = dataRecord === null ? null : asRecord(dataRecord.tokens);
    if (tokensRecord === null) continue;
    cacheReadTotal += numberOrZero(asRecord(tokensRecord.cache)?.read);
    paidInputTotal += numberOrZero(tokensRecord.input);
    cacheWriteTotal += numberOrZero(asRecord(tokensRecord.cache)?.write);
  }
  const denominator = cacheReadTotal + paidInputTotal + cacheWriteTotal;
  if (denominator <= 0) return null;
  return cacheReadTotal / denominator;
}

function numberOrZero(value) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue > 0 ? numericValue : 0;
}
