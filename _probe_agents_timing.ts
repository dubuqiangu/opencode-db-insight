// Probe script: time each sub-query of queryAgentStats against the real db.
import { DatabaseSync } from "node:sqlite"
import { homedir } from "node:os"
import { join } from "node:path"

const dbPath = join(homedir(), ".local", "share", "opencode", "opencode.db")
const db = new DatabaseSync(dbPath, { readOnly: true })

const PREDICATE = "type = 'assistant' AND json_valid(data) AND json_type(data) = 'object'"

function timeQuery(label, sql, params = []) {
  const start = performance.now()
  const stmt = db.prepare(sql)
  const rows = stmt.all(...params)
  const elapsed = Math.round(performance.now() - start)
  console.log(`${label}: ${elapsed}ms, rows=${rows.length}`)
  return { elapsed, rows }
}

const rowCount = db.prepare("SELECT COUNT(*) AS n FROM session_message").get()
console.log("total session_message rows:", rowCount.n)

// 1. memberships
timeQuery("memberships (session_v2)", "SELECT id, agent FROM session_v2")

// 2. usage samples (json_extract multi-path)
timeQuery(
  "usage samples (json_extract)",
  `SELECT session_id,
          json_extract(data, '$.agent', '$.tokens.input', '$.tokens.output', '$.tokens.cache.read') AS usage_fields
   FROM session_message
   WHERE ${PREDICATE}`,
)

// 3. tool name samples (json_each full join)
const toolProbe = timeQuery(
  "tool names (json_each, current)",
  `SELECT agent_name,
          COALESCE(NULLIF(raw_name, ''), part_value ->> '$.tool') AS resolved_tool_name
   FROM (
     SELECT COALESCE(json_extract(m.data, '$.agent'), 'unknown') AS agent_name,
            c.value ->> '$.name' AS raw_name,
            c.value AS part_value
     FROM session_message m, json_each(m.data, '$.content') c
     WHERE m.type = 'assistant' AND json_valid(m.data) AND json_type(m.data) = 'object'
       AND c.value ->> '$.type' = 'tool'
   )`,
)

// 3b. LIKE pre-filter variant
timeQuery(
  "tool names (json_each + LIKE prefilter)",
  `SELECT agent_name,
          COALESCE(NULLIF(raw_name, ''), part_value ->> '$.tool') AS resolved_tool_name
   FROM (
     SELECT COALESCE(json_extract(m.data, '$.agent'), 'unknown') AS agent_name,
            c.value ->> '$.name' AS raw_name,
            c.value AS part_value
     FROM session_message m, json_each(m.data, '$.content') c
     WHERE m.type = 'assistant' AND json_valid(m.data) AND json_type(m.data) = 'object'
       AND m.data LIKE '%"tool"%'
       AND c.value ->> '$.type' = 'tool'
   )`,
)

// 3c. json_extract-only probe: how expensive is the predicate scan itself?
timeQuery(
  "predicate-only scan (json_extract agent only)",
  `SELECT COALESCE(json_extract(m.data, '$.agent'), 'unknown') AS agent_name
   FROM session_message m
   WHERE m.type = 'assistant' AND json_valid(m.data) AND json_type(m.data) = 'object'`,
)

// 3d. row-length stats: what does an assistant data JSON weigh?
timeQuery(
  "row length stats",
  `SELECT COUNT(*) AS n, SUM(LENGTH(data)) AS total_bytes FROM session_message WHERE ${PREDICATE}`,
)

// 3e. LIKE-only count
timeQuery(
  "LIKE prefilter count",
  `SELECT COUNT(*) AS n FROM session_message WHERE ${PREDICATE} AND data LIKE '%"tool"%'`,
)

db.close()
