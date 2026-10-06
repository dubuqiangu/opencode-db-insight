/**
 * 数字与日期格式化小工具（纯函数，无副作用）。
 * 大数一律 K/M/B 缩写 + tabular-nums 由 CSS 保证对齐。
 */

/** token 量级缩写：<1k 原样，之后 K/M/B，B 以上保持 B。 */
export function formatTokens(value) {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs >= 1e9) return trimZero((value / 1e9).toFixed(2)) + "B";
  if (abs >= 1e6) return trimZero((value / 1e6).toFixed(1)) + "M";
  if (abs >= 1e3) return trimZero((value / 1e3).toFixed(1)) + "K";
  return String(Math.round(value));
}

function trimZero(text) {
  return text.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

/** 通用计数缩写（调用次数等），千分位内保留原值。 */
export function formatCount(value) {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs >= 1e6) return trimZero((value / 1e6).toFixed(2)) + "M";
  if (abs >= 1e4) return trimZero((value / 1e3).toFixed(0)) + "K";
  if (abs >= 1e3) return trimZero((value / 1e3).toFixed(1)) + "K";
  return String(value);
}

/** 百分比：0.972 → "97.2%"；null → "—"。 */
export function formatPercent(fraction, digits = 1) {
  if (!Number.isFinite(fraction)) return "—";
  return (fraction * 100).toFixed(digits) + "%";
}

/** 环比百分点差：+2.1pp / -0.8pp。 */
export function formatPointDelta(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
  const deltaPp = (current - previous) * 100;
  return deltaPp.toFixed(1) + "pp";
}

/** 相对变化：previous 为 0 时返回 null（避免 ∞）。 */
export function formatRatioDelta(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;
  return ((current - previous) / previous * 100).toFixed(1) + "%";
}

/** 本地时区 'YYYY-MM-DD' → 当日零点 epoch 毫秒。 */
export function dateKeyToEpoch(dateKey) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(year, month - 1, day).getTime();
}

/** epoch → 本地 'YYYY-MM-DD'。 */
export function epochToDateKey(epochMilliseconds) {
  const date = new Date(epochMilliseconds);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const dayOfMonth = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${dayOfMonth}`;
}

/** epoch → 'MM-dd HH:mm'（本地时间）。 */
export function formatDateTime(epochMilliseconds) {
  if (!Number.isFinite(epochMilliseconds)) return "—";
  const date = new Date(epochMilliseconds);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const dayOfMonth = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${month}-${dayOfMonth} ${hours}:${minutes}`;
}

/** epoch → 'MM-dd'。 */
export function formatDay(epochMilliseconds) {
  if (!Number.isFinite(epochMilliseconds)) return "—";
  const date = new Date(epochMilliseconds);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const dayOfMonth = String(date.getDate()).padStart(2, "0");
  return `${month}-${dayOfMonth}`;
}

/** 两个 epoch → 'MM-dd → MM-dd' 活跃区间。 */
export function formatSeenRange(firstEpoch, lastEpoch) {
  if (!Number.isFinite(firstEpoch) || !Number.isFinite(lastEpoch)) return "—";
  return `${formatDay(firstEpoch)} → ${formatDay(lastEpoch)}`;
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / MM-dd。 */
export function formatRelative(epochMilliseconds, now = Date.now()) {
  if (!Number.isFinite(epochMilliseconds)) return "—";
  const elapsed = now - epochMilliseconds;
  if (elapsed < 60_000) return "刚刚";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`;
  return formatDay(epochMilliseconds);
}

/**
 * 秒数 → 人类可读时长：<60s "N 秒"；<1h "N 分钟"；<1d "X 小时 Y 分"；
 * 更长 "X 天 Y 小时"（余数单位为 0 时只显示主单位）。
 */
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 60) return `${Math.round(seconds)} 秒`;
  const totalMinutes = Math.round(seconds / 60);
  if (totalMinutes < 60) return `${totalMinutes} 分钟`;
  const totalHours = Math.floor(totalMinutes / 60);
  const remainderMinutes = totalMinutes % 60;
  if (totalHours < 24) {
    return remainderMinutes === 0 ? `${totalHours} 小时` : `${totalHours} 小时 ${remainderMinutes} 分`;
  }
  const totalDays = Math.floor(totalHours / 24);
  const remainderHours = totalHours % 24;
  return remainderHours === 0 ? `${totalDays} 天` : `${totalDays} 天 ${remainderHours} 小时`;
}

/**
 * 路径最后一段（目录展示名）：兼容 / 与 \ 分隔、末尾分隔符、
 * 重复分隔符。全部段落皆空时原样返回。后端契约已切好 name 字段，
 * 此函数供 mock 生成 name 与前端 name 缺失时兜底。
 */
export function pathLastSegment(directoryPath) {
  const pathText = String(directoryPath);
  const segments = pathText.split(/[\\/]+/).filter((segment) => segment !== "");
  return segments.length > 0 ? segments[segments.length - 1] : pathText;
}

const HTML_ESCAPE_MAP = {
  "&": "&" + "amp;",
  "<": "&" + "lt;",
  ">": "&" + "gt;",
  '"': "&" + "quot;",
  "'": "&" + "#39;",
};

/** HTML 文本转义（SVG/DOM 模板里插用户可见字符串前必过）。 */
export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) => HTML_ESCAPE_MAP[char]);
}

/** 创建带命名空间与属性的 SVG 元素。 */
export function svgElement(tagName, attributes = {}) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", tagName);
  for (const [name, value] of Object.entries(attributes)) {
    if (value !== undefined && value !== null) element.setAttribute(name, String(value));
  }
  return element;
}
