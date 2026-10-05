/**
 * 主题工具：跟随系统 prefers-color-scheme，为图表提供运行时配色。
 * 图表库（uPlot）与手写 SVG 在渲染时通过 cssVar() 读当前主题色，
 * 主题切换时由 app.js 统一触发重渲染。
 */

const DARK_QUERY = "(prefers-color-scheme: dark)";

/** 当前是否深色主题。 */
export function prefersDark() {
  return window.matchMedia(DARK_QUERY).matches;
}

/** 读取 CSS 变量的当前值（带 # 的十六进制或 rgba）。 */
export function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** 读取模型调色板：返回 ["var(--m1) 解析后的颜色", ...] 的数组。 */
export function modelPalette() {
  const palette = [];
  for (let index = 1; index <= 12; index += 1) {
    palette.push(cssVar("--m" + index));
  }
  return palette;
}

/** 系统主题变化回调，返回取消函数。 */
export function onSchemeChange(callback) {
  const mediaQuery = window.matchMedia(DARK_QUERY);
  const listener = (event) => callback(event.matches);
  mediaQuery.addEventListener("change", listener);
  return () => mediaQuery.removeEventListener("change", listener);
}

/** 图表通用色板（按当前主题取）。 */
export function chartTheme() {
  return {
    stroke: cssVar("--text-dim"),
    grid: cssVar("--grid-line"),
    tick: cssVar("--text-faint"),
    accent: cssVar("--accent"),
    blue: cssVar("--blue"),
    amber: cssVar("--amber"),
    red: cssVar("--red"),
  };
}
