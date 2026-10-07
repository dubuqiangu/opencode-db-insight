/**
 * 回放角色时间线（T4.2）：🧑 用户正文 / 🤖 助手正文 / 💭 reasoning（默认展开，
 * 可折叠）/ 🔧 工具调用（参数+输出代码块；单块超 4000 字符默认折叠）/ 🔔
 * system·model-switched·compaction 斜体分隔行。idle/synthetic 跳过。
 *
 * 消息 `data` 的解释口径与 src/export/message-roles.ts 逐条对齐
 * （工具名 name→tool 回退；输出 state.metadata.output→state.content 回退）。
 * 文本提取函数自 v0.10.0 起共享自 replay-message-text.js（渲染与搜索
 * 共用同一出处）。大会话分页：visible 消息 >200 条时先渲染 200 条，
 * "加载更多"逐块追加。
 */

import { formatDateTime, escapeHtml } from "../format.js";
import { buildTurnCostBarElement } from "./replay-turn-bar.js";
import {
  asRecord,
  partText,
  readMessageText,
  readToolName,
  readToolInput,
  readToolOutput,
  isVisibleReplayMessageType,
} from "./replay-message-text.js";

const DEFAULT_PAGE_SIZE = 200;
/** 单个工具块（参数+输出）超过此字符数默认折叠。 */
const TOOL_BLOCK_COLLAPSE_THRESHOLD = 4000;

const ASSISTANT_MODEL_COLORS = ["var(--m1)", "var(--m2)", "var(--m6)", "var(--m4)"];

/* ---------------- 单条消息节点 ---------------- */

function buildNodeShell(roleClass, iconGlyph, timeCreated) {
  const nodeElement = document.createElement("article");
  nodeElement.className = `replay-node ${roleClass}`;
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
  const { nodeElement, bodyElement } = buildNodeShell("role-user", "🧑", messageRecord.timeCreated);
  const textElement = document.createElement("div");
  textElement.className = "replay-text";
  textElement.textContent = userText;
  bodyElement.appendChild(textElement);
  return nodeElement;
}

function buildReasoningPartElement(reasoningText) {
  const detailsElement = document.createElement("details");
  detailsElement.className = "replay-reasoning";
  detailsElement.open = true; // 默认展开（spec），点标题可折叠
  const summaryElement = document.createElement("summary");
  summaryElement.textContent = "💭 思考过程";
  detailsElement.appendChild(summaryElement);
  const textElement = document.createElement("div");
  textElement.className = "replay-text muted";
  textElement.textContent = reasoningText;
  detailsElement.appendChild(textElement);
  return detailsElement;
}

function buildToolPartElement(toolPartRecord) {
  const toolName = readToolName(toolPartRecord);
  const stateRecord = asRecord(toolPartRecord.state);
  // 参数 pre 的展示文本出自 readToolInput 单点（replay-message-text.js，
  // ora-5 P2 修复）：展示形态只有这一份代码，渲染与搜索文本视图必然
  // 同源——改形态两侧一起变，「看得见搜不到」不再靠注释纪律维持。
  const paramsJson = readToolInput(stateRecord);
  const toolOutput = readToolOutput(stateRecord);
  const blockLength = paramsJson.length + toolOutput.length;

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

  const { nodeElement, bodyElement } = buildNodeShell("role-assistant", "🤖", messageRecord.timeCreated);

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
 * 渲染角色时间线，返回分页控制器：
 *   { appendNextChunk(): boolean, hasMore, visibleCount,
 *     renderedCount, nodeAt(index) }
 * messageRecords 需已按 seq 升序（后端 ORDER BY seq ASC）。
 * v0.10.0 增 renderedCount / nodeAt：会话内搜索（replay-search.js）的
 * 命中定位需要知道「DOM 渲染到第几条」并按可见序号取节点——时间线第 i
 * 个子节点恒等于第 i 条可见消息（buildMessageNode 每条消息恰好产出一个
 * 节点），与 buildReplaySearchIndex 的第 i 项对齐（见
 * replay-message-text.js 头部的对齐不变量）。
 */
export function renderTimeline(container, messageRecords, pageSize = DEFAULT_PAGE_SIZE) {
  const visibleRecords = (Array.isArray(messageRecords) ? messageRecords : [])
    .filter((record) => isVisibleReplayMessageType(String(record.type ?? "")));

  const listElement = document.createElement("div");
  listElement.className = "replay-timeline";
  container.innerHTML = "";
  container.appendChild(listElement);

  const timelineState = { lastAssistantModelId: null, assistantModelCounter: 0 };
  let renderedCount = 0;

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
      const chunkEnd = Math.min(renderedCount + pageSize, visibleRecords.length);
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
  if (messageType === "user") return buildUserNode(messageRecord) ?? buildSkippedNode();
  if (messageType === "assistant") return buildAssistantNode(messageRecord, timelineState);
  return buildNoticeNode(messageRecord); // system / model-switched / compaction / 未知
}

/** 空文本 user 消息占位（保持时间线连贯，不隐藏空洞）。 */
function buildSkippedNode() {
  const nodeElement = document.createElement("div");
  nodeElement.className = "replay-notice";
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
