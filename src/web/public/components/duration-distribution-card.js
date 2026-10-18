/**
 * 会话时长分布卡（v0.21.0）：复用共享分布直方图渲染器
 * （distribution-card.js 的 renderSharedDistributionCard），只是轴刻度
 * 按毫秒 → 紧凑时长（formatDurationMs）格式化、卡头小字报「均值时长」。
 *
 * 数据 = 与 token 分布同形的统一分布载荷：
 *   { totalSessions, buckets:[{start,end,count}], percentiles:{p50,p90,p99},
 *     mean, max }   // start/end/mean/max 单位 = 毫秒
 * 纯渲染：不 fetch、不碰全局 state；数据由接线 lane 传入。
 * distribution === null → 共享渲染器的「数据不可达」降级块。
 */

import { formatDurationMs } from "../format.js";
import { renderSharedDistributionCard } from "./distribution-card.js";

/** 时长分布卡的展示选项：轴刻度走毫秒 → "Xh Ym" 紧凑时长，单位「时长」。 */
const DURATION_CARD_OPTIONS = {
  formatAxis: (value) => formatDurationMs(value),
  sampleUnit: "时长",
  rawUnit: "ms",
  exclusionLabel: "已排除非正墙钟时长会话",
  emptyHint: "全部会话中没有正值的 time_updated - time_created 墙钟时长可统计",
  ariaLabel: "会话时长分布直方图，含 p50/p90/p99 分位标线",
};

/**
 * 渲染会话时长分布卡。
 * @param {HTMLElement} container 挂载点
 * @param {object|null} distribution 统一分布载荷或 null（mean/max/buckets 单位毫秒）
 * @returns {() => void} cleanup
 */
export function renderDurationDistributionCard(container, distribution) {
  return renderSharedDistributionCard(container, distribution, DURATION_CARD_OPTIONS);
}
