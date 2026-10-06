/**
 * 单会话回放的 mock fixtures（离线演示与测试；真实 API 见 data-source.js）。
 *
 * 形状严格对齐 src/db/queries.ts querySessionMessages 的返回与
 * src/export/message-roles.ts 探明的线上形状（2026-10-06）：
 *   SessionMessageRecord = { id, sessionId, type, seq, timeCreated, timeUpdated, data }
 *   - user:            data = { text }
 *   - assistant:       data = { model:{id,providerID}, agent,
 *                              tokens:{input,output,reasoning,cache:{read,write}},
 *                              content:[ {type:"text",text}
 *                                      | {type:"reasoning",text}
 *                                      | {type:"tool",name,state:{status,input,
 *                                          metadata:{output,exit}}} ] }
 *   - system:          data = { text }
 *   - model-switched:   data = { model:{id}, previous:{id} }
 *   - compaction:       data = { status, reason, summary }
 *   - idle/synthetic:   回放视图忽略
 *
 * id 以 "legacy_" 开头的会话模拟 2026-09-23 前旧表会话：返回 null，
 * data-source 会转成 SessionNotFound → 界面走 404 分支。
 */

const REPLAY_SESSION_ID = "ses_replay_demo";
const REPLAY_MESSAGE_COUNT = 228; // > 200，验证分页加载
const MESSAGE_GAP_MS = 90_000;

function createSeededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

const USER_PROMPTS = [
  "帮我排查 heatmap 时区偏移一天的问题",
  "把日历对齐到周一，前面的空白天数补零",
  "趋势图右轴命中率刻度改成 0-100 固定",
  "这个会话的 tool 输出太长了，默认折叠吧",
  "再看一眼 compaction 事件的时间点",
];

const ASSISTANT_TEXTS = [
  "找到原因了：日期 key 用 UTC 解析，本地时区会偏一天。改用本地构造 Date 就行。",
  "这层楼的改动不大，我先动了 calendar-heatmap.js，按周一对齐后首列补白。",
  "右轴已固定 0-100，grid 不画，避免和左轴刻度打架。",
  "长输出块超过 4000 字符默认收起，展开按钮放在块标题上。",
  "压缩事件在时间线上是斜体分隔行，和导出的口径保持一致。",
];

const REASONING_TEXTS = [
  "用户说「偏移一天」，最可能是 dateKey 解析用了 Date.parse(date-only)，ECMAScript 规定按 UTC 解析——本地时区为东八区时会快 8 小时，跨零点就落在下一天。",
  "周起始日：目标用户是中文开发者，用周一为每周第一列；首列之前的空白格子直接跳过不渲染。",
  "三段配色沿用 KPI 卡语义：缓存读=绿（免费）、实付=琥珀（花钱）、输出=紫。",
];

/** 一个超长 tool 输出（>4000 字符），验证长块默认折叠。 */
function buildLongToolOutput() {
  const segment = "  at computeLevelThresholds (calendar-heatmap.js:42:19)\n" +
    "  at renderCalendarHeatmap (calendar-heatmap.js:88:5)\n" +
    "  at loadCalendarSection (app.js:141:3)\n";
  return "RangeError: Invalid time value\n" + segment.repeat(120);
}

function buildToolPart(toolName, random, isLongOutput) {
  const toolInputs = {
    read: { path: "src/web/public/components/calendar-heatmap.js" },
    bash: { command: "node m3-frontend-smoke.mjs" },
    edit: { path: "app.js", oldText: "371", newText: "366" },
  };
  const outputText = isLongOutput
    ? buildLongToolOutput()
    : `ok · ${toolName} 执行完成，无异常（${Math.round(random() * 900 + 100)}ms）`;
  return {
    type: "tool",
    name: toolName,
    state: {
      status: "completed",
      input: toolInputs[toolName] ?? {},
      metadata: { output: outputText, exit: 0 },
    },
  };
}

function buildReplayMessageRecords(sessionId) {
  const random = createSeededRandom(0x5eed1701);
  const records = [];
  const startTime = Date.now() - REPLAY_MESSAGE_COUNT * MESSAGE_GAP_MS;
  const toolNames = ["read", "bash", "edit"];
  let modelId = "glm-5.3";

  const pushRecord = (type, data, timeCreated) => {
    records.push({
      id: `msg_${records.length.toString().padStart(4, "0")}`,
      sessionId,
      type,
      seq: records.length,
      timeCreated,
      timeUpdated: timeCreated + 4_000,
      data,
    });
  };

  pushRecord("system", { text: "系统提示词已更新（环境块 · 工具目录 · 日期）", time: startTime }, startTime);

  for (let messageIndex = 0; messageIndex < REPLAY_MESSAGE_COUNT; messageIndex += 1) {
    const timeCreated = startTime + messageIndex * MESSAGE_GAP_MS;
    const conversationStep = Math.floor(messageIndex / 3);

    // 模型切换：第 60 条消息后切到 claude-sonnet-4.6
    if (messageIndex === 60) {
      pushRecord("model-switched",
        { model: { id: "claude-sonnet-4.6", providerID: "anthropic" }, previous: { id: modelId, providerID: "z-ai" } },
        timeCreated - 30_000);
      modelId = "claude-sonnet-4.6";
    }
    // 每 45 条消息插一次压缩事件 + 少量 idle 噪声
    if (messageIndex > 0 && messageIndex % 45 === 0) {
      pushRecord("compaction",
        { status: "completed", reason: "auto", summary: "上下文压缩：保留了最近 12 轮对话与结论清单。" },
        timeCreated - 20_000);
    }
    if (messageIndex > 0 && messageIndex % 17 === 0) {
      pushRecord("idle", { duration: 300_000 }, timeCreated - 10_000);
    }

    const conversationSlot = messageIndex % 3;
    if (conversationSlot === 0) {
      pushRecord("user", { text: USER_PROMPTS[conversationStep % USER_PROMPTS.length], time: timeCreated }, timeCreated);
    } else {
      const content = [];
      content.push({ type: "reasoning", text: REASONING_TEXTS[conversationStep % REASONING_TEXTS.length] });
      content.push(buildToolPart(
        toolNames[messageIndex % toolNames.length],
        random,
        messageIndex === 34, // 第 34 条消息的助手步骤带 >4000 字符超长输出（验证默认折叠）
      ));
      content.push({ type: "text", text: ASSISTANT_TEXTS[conversationStep % ASSISTANT_TEXTS.length] });

      pushRecord("assistant", {
        model: { id: modelId, providerID: modelId.startsWith("glm") ? "z-ai" : "anthropic" },
        agent: "build",
        tokens: {
          input: 4_000 + Math.round(random() * 8_000),
          output: 2_000 + Math.round(random() * 5_000),
          reasoning: Math.round(random() * 3_000),
          cache: {
            read: 420_000 + Math.round(random() * 180_000),
            write: 20_000 + Math.round(random() * 40_000),
          },
        },
        content,
      }, timeCreated);
    }
  }

  records.sort((left, right) => left.seq - right.seq);
  // seq 按插入顺序重排（上面 pushRecord 顺序即 seq 顺序）
  return records.map((record, index) => ({ ...record, seq: index }));
}

/**
 * GET /api/session/:id/messages 的 mock。legacy_ 前缀 → null（旧表会话，
 * 对应真实 API 的 404 {error: SESSION_NOT_FOUND_MESSAGE}）。
 */
export function getMockSessionMessages(sessionId) {
  if (sessionId.startsWith("legacy_")) return null;
  return buildReplayMessageRecords(sessionId === "" ? REPLAY_SESSION_ID : sessionId);
}

/**
 * GET /api/session/:id/system-prompt 的 mock：instruction key → 提示词文本。
 * legacy_ 前缀 → null。
 */
export function getMockSessionSystemPrompt(sessionId) {
  if (sessionId.startsWith("legacy_")) return null;
  return {
    environment: "You are a coding agent running inside OpenCode.\n操作系统信息与环境变量块。工作目录：~/projects/aicode。今天是 2026-10-06。\n" + "支持读写工作区文件、执行 shell 命令、检索代码。".repeat(6),
    tools: "可用工具目录（节选）：read / edit / bash / grep / glob / task / webfetch。每个工具的入参与限制以注册表为准。调用前确认路径在沙箱内。",
  };
}

/** mock 会话列表里可点击进入回放的那条会话 id。 */
export const REPLAY_DEMO_SESSION_ID = REPLAY_SESSION_ID;
