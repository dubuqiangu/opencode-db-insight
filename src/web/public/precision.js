/**
 * 数值可信度的单一来源（v0.23.0）。
 *
 * 页面上的读数只分四类，界限必须一眼可辨：
 *   实值   —— 直接取自数据库的列，除单位换算外没有算术；
 *   估算   —— 由 token 量按公开单价换算，或由多个原始列算术派生；
 *   推断   —— 库中没有对应列，由消息字段反推而来；
 *   不可得 —— 字段未记录或分母为 0，一律显示 "—"，绝不折算成 0。
 *
 * 前三类用徽标表达（绿点 = 实值，琥珀点 = 非实值）；第四类只给 "—" 加
 * 原因悬浮。原因必须取自 `MISSING_REASON`，同一原因在会话列表、模型表、
 * 卡片里必须是同一句话——这是本文件存在的理由，调用点不要另写文案。
 *
 * 文案与 index.html 页脚图例是同一套语义，改动需两边同步。
 */

const PRECISION_LABEL = Object.freeze({
  exact: "实值",
  estimate: "估算",
  inferred: "推断",
});

const PRECISION_TITLE = Object.freeze({
  exact: "实值：直接取自数据库的原始计数，未做任何换算。",
  estimate: "估算：由 token 量按公开单价换算，或由多个原始列算术派生，仅作量级参考。",
  inferred: "推断：数据库没有对应列，由消息字段反推而来，仅作参考。",
});

/**
 * 精度徽标。kind 只接受 exact / estimate / inferred，
 * 未知取值按 estimate 处理——宁可少承诺，不可冒充实值。
 */
export function renderPrecisionBadge(kind) {
  const resolvedKind = Object.hasOwn(PRECISION_LABEL, kind) ? kind : "estimate";
  const toneClass = resolvedKind === "exact" ? "exact" : "estimate";
  return `<span class="precision ${toneClass}" title="${PRECISION_TITLE[resolvedKind]}">${PRECISION_LABEL[resolvedKind]}</span>`;
}

/**
 * 不可得原因的完整目录。键是原因，值是给用户看的那一句话。
 * 新增调用点先在这里找原因；找不到就先补目录，不要在调用点拼文案。
 */
export const MISSING_REASON = Object.freeze({
  legacyField: "旧数据没有该字段的记录（本库自 v0.20.0 起才写入）",
  notRecorded: "本库没有该字段的记录",
  costNotRecorded: "没有成本记录：本库 cost 字段常为 0，0 与未记录同义",
  zeroDenominator: "分母为 0 或未记录，比率无法计算",
  noSamples: "没有可用样本，无法计算统计量",
  channelNoCache: "该通道不缓存，缓存命中率不可得",
  nonPositiveDuration: "没有正的墙钟时长（更新时间不晚于创建时间）",
  noToolCalls: "没有工具调用记录",
  inconsistentCount: "前后端口径不一致，该计数不可得",
});

/**
 * 不可得占位：短横线 + 原因悬浮。
 *
 * 入参是**原因文案**，不是键名——调用点一律传 `MISSING_REASON` 里的常量，
 * 同一原因在会话列表、模型表、卡片里必然是同一句话。
 * 传空值（键名拼错取到 `undefined`）时回落到 notRecorded，
 * 保证任何调用点都不会渲染出空悬浮。
 *
 * 不折算成 0——0 是真实读数，"—" 才是没有读数，两者不能混。
 */
export function renderMissingValue(reasonText) {
  const resolvedText = typeof reasonText === "string" && reasonText !== ""
    ? reasonText
    : MISSING_REASON.notRecorded;
  return `<span class="missing-value" title="${resolvedText}">—</span>`;
}
