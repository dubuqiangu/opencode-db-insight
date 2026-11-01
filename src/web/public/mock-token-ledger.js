/**
 * Wave 1 mock 生产者（v0.29.0）：A1 记账守恒 + A2/A3 会话事件。
 *
 * 单独成文件（不改 mock-data.js / mock-replay-data.js）：形状严格对齐合同
 * §3.1 的冻结响应体，供 data-source.js 的 USE_MOCK 分支消费，离线预览
 * 能看到记账卡的完整性判定、三分、逐会话对照与跨源对照全路径。
 *
 *   getMockTokenLedger()        → GET /api/token-ledger
 *                                 { totals, conservation, reconciliation,
 *                                   sessions[] }
 *   getMockSessionEvents(id)    → GET /api/session/:id/events
 *                                 { events: [{ seq, timeCreated, type, detail }] }
 *
 * 事件从回放 fixtures（mock-replay-data.js 的 getMockSessionMessages）派生，
 * 复用同一份消息序列的 seq/timeCreated，保证事件锚点与回放曲线步点对得上；
 * legacy_ 前缀会话返回 null（镜像真实接口 404）。
 */

import { getMockSessionMessages } from "./mock-replay-data.js";

/**
 * 逐会话记账行（字段名 = 合同 §3.1 的 TokenLedgerSample）：
 * promptInput/CacheRead/CacheWrite 来自 message 侧 data.tokens，
 * v2* 来自 session_v2 对照列。
 *
 * 前四行的 v2 侧刻意只带一点漂移（真实库里两侧并非逐字节一致）；
 * 第五行 ses_8f3a7d91 的 v2CacheRead 明显大于 message 侧——模拟
 * 「session_v2 保留了被 compaction 剪掉的历史」。它让跨源对照整体
 * 超出容差（residualRatio ≈ 7.6% > 2%），但没有任何分量异常，
 * 用来证明**判定仍为「记账完整」**（完整性只看 anomalies）。
 */
const MOCK_LEDGER_SESSIONS = [
  {
    sessionId: "ses_replay_demo",
    messages: 76,
    promptInput: 486_400,
    promptCacheRead: 14_203_800,
    promptCacheWrite: 1_152_600,
    output: 318_500,
    reasoning: 142_300,
    v2Input: 486_400,
    v2CacheRead: 14_210_500,
    v2CacheWrite: 1_150_200,
    v2Output: 318_500,
  },
  {
    sessionId: "ses_8f3a1ee7",
    messages: 54,
    promptInput: 322_100,
    promptCacheRead: 9_684_200,
    promptCacheWrite: 742_900,
    output: 205_700,
    reasoning: 88_400,
    v2Input: 322_100,
    v2CacheRead: 9_689_900,
    v2CacheWrite: 741_300,
    v2Output: 205_700,
  },
  {
    // 大残差样本：message 侧被 compaction 剪短，session_v2 仍记全量历史。
    sessionId: "ses_8f3a7d91",
    messages: 40,
    promptInput: 210_000,
    promptCacheRead: 6_400_000,
    promptCacheWrite: 520_000,
    output: 168_000,
    reasoning: 61_000,
    v2Input: 210_000,
    v2CacheRead: 9_800_000,
    v2CacheWrite: 520_000,
    v2Output: 168_000,
  },
  {
    sessionId: "ses_8f3a3c15",
    messages: 31,
    promptInput: 174_800,
    promptCacheRead: 5_120_600,
    promptCacheWrite: 388_200,
    output: 121_300,
    reasoning: 47_100,
    v2Input: 174_800,
    v2CacheRead: 5_124_000,
    v2CacheWrite: 387_500,
    v2Output: 121_300,
  },
  {
    sessionId: "ses_8f3a5a43",
    messages: 12,
    promptInput: 68_500,
    promptCacheRead: 1_980_400,
    promptCacheWrite: 156_800,
    output: 44_900,
    reasoning: 15_600,
    v2Input: 68_500,
    v2CacheRead: 1_982_100,
    v2CacheWrite: 156_200,
    v2Output: 44_900,
  },
];

/** 逐会话消息侧 prompt 三分之和 / 对照侧三分之和（守恒校验用）。 */
function messageSidePromptTotal(session) {
  return session.promptInput + session.promptCacheRead + session.promptCacheWrite;
}

function sessionTablePromptTotal(session) {
  return session.v2Input + session.v2CacheRead + session.v2CacheWrite;
}

/**
 * 汇总 totals（合同 §3.1）：msg 侧三分与 output/reasoning 直接求和，
 * promptTotal = 三分之和，cacheHitRate = cacheRead / promptTotal
 * （promptTotal 为 0 → null）。
 */
function buildLedgerTotals(sessions) {
  let promptInput = 0;
  let promptCacheRead = 0;
  let promptCacheWrite = 0;
  let output = 0;
  let reasoning = 0;
  for (const session of sessions) {
    promptInput += session.promptInput;
    promptCacheRead += session.promptCacheRead;
    promptCacheWrite += session.promptCacheWrite;
    output += session.output;
    reasoning += session.reasoning;
  }
  const promptTotal = promptInput + promptCacheRead + promptCacheWrite;
  return {
    promptInput,
    promptCacheRead,
    promptCacheWrite,
    promptTotal,
    output,
    reasoning,
    cacheHitRate: promptTotal === 0 ? null : promptCacheRead / promptTotal,
    sessions: sessions.length,
  };
}

/**
 * 记账完整性校验（合同 §3.1）：**只看异常计数**。negativeComponents 统计
 * 任一 token 分量为负的会话；cacheReadExceedsPrompt 统计 promptCacheRead
 * 超出该会话 prompt 三分之和（命中率 > 100%）的会话。跨源对照不参与。
 */
function buildLedgerConservation(sessions) {
  let negativeComponents = 0;
  let cacheReadExceedsPrompt = 0;
  for (const session of sessions) {
    if (
      session.promptInput < 0 || session.promptCacheRead < 0 || session.promptCacheWrite < 0
      || session.output < 0 || session.reasoning < 0
      || session.v2Input < 0 || session.v2CacheRead < 0 || session.v2CacheWrite < 0 || session.v2Output < 0
    ) {
      negativeComponents += 1;
    }
    if (session.promptCacheRead > messageSidePromptTotal(session)) cacheReadExceedsPrompt += 1;
  }
  return {
    anomalies: { negativeComponents, cacheReadExceedsPrompt },
    balanced: negativeComponents === 0 && cacheReadExceedsPrompt === 0,
  };
}

/** 跨源对照容差（镜像 stats/token-ledger.ts 的常量）。 */
const MOCK_RECONCILIATION_TOLERANCE = 0.02;

/**
 * 跨源对照（合同 §3.1，**仅信息性**）：residual = 对照侧合计 − 消息侧合计；
 * residualRatio = residual / 对照侧合计（分母 0 → null）；withinTolerance =
 * |residualRatio| ≤ 容差（ratio 为 null → false）。超差是已知差值，不是异常。
 */
function buildLedgerReconciliation(sessions) {
  let messageSideTotal = 0;
  let sessionTableTotal = 0;
  for (const session of sessions) {
    messageSideTotal += messageSidePromptTotal(session);
    sessionTableTotal += sessionTablePromptTotal(session);
  }
  const residualTokens = sessionTableTotal - messageSideTotal;
  const residualRatio = sessionTableTotal === 0 ? null : residualTokens / sessionTableTotal;
  return {
    residualTokens,
    residualRatio,
    withinTolerance: residualRatio !== null && Math.abs(residualRatio) <= MOCK_RECONCILIATION_TOLERANCE,
    tolerance: MOCK_RECONCILIATION_TOLERANCE,
  };
}

/** GET /api/token-ledger 的 mock 响应体（会话按 promptTotal 降序、id 升序）。 */
export function getMockTokenLedger() {
  const sessions = [...MOCK_LEDGER_SESSIONS].sort(
    (left, right) =>
      messageSidePromptTotal(right) - messageSidePromptTotal(left)
      || (left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0),
  );
  return {
    totals: buildLedgerTotals(sessions),
    conservation: buildLedgerConservation(sessions),
    reconciliation: buildLedgerReconciliation(sessions),
    sessions,
  };
}

/** 事件类型白名单：回放曲线只消费这三类（其余回放消息忽略）。 */
const SESSION_EVENT_TYPES = new Set(["compaction", "model-switched", "system"]);

/** system 事件 detail 截断长度（镜像后端安全截断语义）。 */
const SYSTEM_EVENT_DETAIL_LIMIT = 120;

/**
 * 单条消息 → 事件对象；非事件类型返回 null。
 * compaction 取 data.reason（缺失/非串 → "unknown"）；model-switched 拼
 * `from → to`；system 取 data.text 前若干字符。
 */
function messageToSessionEvent(messageRecord) {
  const eventType = String(messageRecord.type ?? "");
  if (!SESSION_EVENT_TYPES.has(eventType)) return null;
  const dataRecord = messageRecord.data !== null && typeof messageRecord.data === "object"
    ? messageRecord.data
    : {};
  let detail = "";
  if (eventType === "compaction") {
    detail = typeof dataRecord.reason === "string" && dataRecord.reason !== "" ? dataRecord.reason : "unknown";
  } else if (eventType === "model-switched") {
    const fromModelId = dataRecord.previous !== null && typeof dataRecord.previous === "object"
      ? String(dataRecord.previous.id ?? "unknown")
      : "unknown";
    const toModelId = dataRecord.model !== null && typeof dataRecord.model === "object"
      ? String(dataRecord.model.id ?? "unknown")
      : "unknown";
    detail = `${fromModelId} → ${toModelId}`;
  } else {
    detail = typeof dataRecord.text === "string"
      ? dataRecord.text.slice(0, SYSTEM_EVENT_DETAIL_LIMIT)
      : "";
  }
  return {
    seq: Number(messageRecord.seq),
    timeCreated: Number(messageRecord.timeCreated),
    type: eventType,
    detail,
  };
}

/**
 * GET /api/session/:id/events 的 mock：从回放 fixtures 抽出事件行（按 seq
 * 升序）。legacy_ 前缀会话 → null（data-source 转成 SessionNotFoundError，
 * 与消息路由同语义）。
 */
export function getMockSessionEvents(sessionId) {
  const messageRecords = getMockSessionMessages(sessionId);
  if (messageRecords === null) return null;
  const events = messageRecords
    .map(messageToSessionEvent)
    .filter((event) => event !== null)
    .sort((left, right) => left.seq - right.seq);
  return { events };
}
