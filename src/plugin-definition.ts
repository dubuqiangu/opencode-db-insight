/**
 * Vendored plugin definition helper.
 *
 * The host loads a plugin entry with a plain dynamic import and validates
 * the default export's shape ({ id, setup }) directly — the upstream
 * `Plugin.define()` is an identity function, so we ship our own instead of
 * importing @opencode/plugin at runtime. That keeps @opencode/plugin (whose
 * dependency tree pulls effect/AI-SDK/@aws-sdk and other deep floating
 * ranges) out of the installed dependency surface: the host's npm install
 * of this package then only has to resolve the small, exactly pinned
 * @opentui/* tree. See CHANGELOG 0.16.2 for the incident that forced this.
 *
 * @opencode/plugin remains a devDependency for local type information.
 */

/** Teardown returned by setup(); the host runs it when the plugin unloads. */
export type InsightPluginCleanup = () => Promise<void> | void

/** Host-validated plugin contract (server and TUI flavors share the shape). */
export interface InsightPluginDefinition {
  readonly id: string
  readonly setup: (context: any) => Promise<InsightPluginCleanup | void> | InsightPluginCleanup | void
}

/** Identity helper preserving the Plugin.define({...}) call shape. */
export function defineInsightPlugin(definition: InsightPluginDefinition): InsightPluginDefinition {
  return definition
}
