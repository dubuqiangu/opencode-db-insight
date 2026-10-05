/**
 * Turn 级成本条（T4.4）：每条 assistant 消息下方一条细横条，
 * cache.read（绿）/ 实付 input（琥珀）/ output（紫）三段按 token 比例分宽，
 * hover 显示各段 token 与占比；该步发生模型切换时左侧竖标 ⚑。
 *
 * 注意 wire 形状：tokens = { input, output, reasoning, cache: { read, write } }
 * （导出层 parseAssistantStepRow 才把它拍平成 cacheRead，这里吃原始 JSON）。
 */

import { formatTokens } from "../format.js";
import { bindHoverTooltip } from "../tooltip.js";

/** tokens 全零时返回 null（该步不渲染成本条）。 */
export function buildTurnCostBarElement(tokens, currentModelId, modelChanged) {
  const cacheRead = readTokenField(tokens, ["cache", "read"]);
  const paidInput = readTokenField(tokens, ["input"]);
  const outputTokens = readTokenField(tokens, ["output"]);
  const barTotal = cacheRead + paidInput + outputTokens;
  if (barTotal <= 0) return null;

  const rowElement = document.createElement("div");
  rowElement.className = "turn-bar-row";

  if (modelChanged && currentModelId !== "") {
    const modelMarker = document.createElement("span");
    modelMarker.className = "turn-model-marker";
    modelMarker.textContent = "⚑ " + currentModelId;
    modelMarker.title = "此步骤发生了模型切换";
    rowElement.appendChild(modelMarker);
  }

  const barElement = document.createElement("div");
  barElement.className = "turn-bar";
  const segments = [
    { segmentClass: "seg-read", label: "缓存读", value: cacheRead, swatch: "var(--accent)" },
    { segmentClass: "seg-input", label: "实付输入", value: paidInput, swatch: "var(--amber)" },
    { segmentClass: "seg-output", label: "输出", value: outputTokens, swatch: "var(--purple)" },
  ];
  for (const segment of segments) {
    if (segment.value <= 0) continue;
    const widthPercent = (segment.value / barTotal) * 100;
    const segmentElement = document.createElement("span");
    segmentElement.className = `turn-seg ${segment.segmentClass}`;
    segmentElement.style.width = `max(2px, ${widthPercent.toFixed(2)}%)`;
    bindHoverTooltip(segmentElement, () => ({
      title: segment.label,
      rows: [
        { label: "token", value: formatTokens(segment.value) },
        { label: "占该步", value: widthPercent.toFixed(1) + "%" },
      ],
    }));
    barElement.appendChild(segmentElement);
  }
  rowElement.appendChild(barElement);

  const totalLabel = document.createElement("span");
  totalLabel.className = "turn-bar-total num";
  totalLabel.textContent = formatTokens(barTotal);
  totalLabel.title = "该步总量 = input + output + cache.read";
  rowElement.appendChild(totalLabel);

  return rowElement;
}

/** 从 wire tokens JSON 里安全读一个数（路径如 ["cache","read"]）。 */
function readTokenField(tokens, fieldPath) {
  if (tokens === null || typeof tokens !== "object") return 0;
  let current = tokens;
  for (const fieldName of fieldPath) {
    if (typeof current !== "object" || current === null) return 0;
    current = current[fieldName];
  }
  const numericValue = Number(current);
  return Number.isFinite(numericValue) && numericValue > 0 ? numericValue : 0;
}
