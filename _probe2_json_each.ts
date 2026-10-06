// Probe 2: decompose the json_each tool-name query cost, plus JSONB viability.
import { DatabaseSync } from "node:sqlite"
import { homedir } from "node:os"
import { join } from "node:path"

const dbPath = join(homedir(), ".local", "share", "opencode", "opencode.db")
const db = new DatabaseSync(dbPath, { readOnly: true })

function timeQuery(label, sql, params = []) {
  const start = performance.now()
  const rows = db.prepare(sql).all(...params)
  const elapsed = Math.round(performance.now() - start)
  console.log(`${label}: ${elapsed}ms, rows=${rows.length}`)
  return rows
}

console.log("sqlite version:", db.prepare("SELECT sqlite_version() AS v").get().v)

const sizeRow = db
  .prepare(
    `SELECT COUNT(*) AS n, SUM(LENGTH(data)) AS bytes, AVG(LENGTH(data)) AS avg_bytes
     FROM session_message WHERE type='assistant'`,
  )
  .get()
console.log("assistant rows:", JSON.stringify(sizeRow))

const contentRow = db
  .prepare(
    `SELECT COUNT(*) AS n, SUM(LENGTH(json_extract(data,'$.content'))) AS bytes
     FROM session_message
     WHERE type='assistant' AND json_valid(data) AND json_type(data)='object'`,
  )
  .get()
console.log("content arrays:", JSON.stringify(contentRow))

// P1: json_each expansion alone (full parse + element render, no predicates on data validity)
timeQuery(
  "P1 json_each count, assistant only",
  `SELECT COUNT(*) AS n FROM session_message m, json_each(m.data, '$.content') c
   WHERE m.type = 'assistant'`,
)

// P2: + validity predicate (adds 2 full parses)
timeQuery(
  "P2 json_each count + validity",
  `SELECT COUNT(*) AS n FROM session_message m, json_each(m.data, '$.content') c
   WHERE m.type = 'assistant' AND json_valid(m.data) AND json_type(m.data) = 'object'`,
)

// P3: + per-part type filter (1 extra full parse per part)
timeQuery(
  "P3 + c.value->>'$.type' = 'tool'",
  `SELECT COUNT(*) AS n FROM session_message m, json_each(m.data, '$.content') c
   WHERE m.type = 'assistant' AND json_valid(m.data) AND json_type(m.data) = 'object'
     AND c.value ->> '$.type' = 'tool'`,
)

// P4: + name resolution WITHOUT part_value materialization across subquery
timeQuery(
  "P4 direct name resolution",
  `SELECT COALESCE(json_extract(m.data,'$.agent'),'unknown') AS agent_name,
          COALESCE(NULLIF(c.value->>'$.name',''), c.value->>'$.tool') AS resolved_tool_name
   FROM session_message m, json_each(m.data, '$.content') c
   WHERE m.type = 'assistant' AND json_valid(m.data) AND json_type(m.data) = 'object'
     AND c.value ->> '$.type' = 'tool'`,
)

// P5: P4 aggregated in SQL (GROUP BY) — nothing big crosses to JS
timeQuery(
  "P5 P4 + GROUP BY",
  `SELECT agent_name, resolved_tool_name, COUNT(*) AS n FROM (
     SELECT COALESCE(json_extract(m.data,'$.agent'),'unknown') AS agent_name,
            COALESCE(NULLIF(c.value->>'$.name',''), c.value->>'$.tool') AS resolved_tool_name
     FROM session_message m, json_each(m.data, '$.content') c
     WHERE m.type = 'assistant' AND json_valid(m.data) AND json_type(m.data) = 'object'
       AND c.value ->> '$.type' = 'tool'
   ) GROUP BY agent_name, resolved_tool_name`,
)

// P6: single full parse per part via multi-path json_extract + substr type test
timeQuery(
  "P6 one-parse-per-part (multi-path extract)",
  `SELECT agent_raw, part_fields FROM (
     SELECT COALESCE(json_extract(m.data,'$.agent'),'unknown') AS agent_raw,
            json_extract(c.value, '$.type', '$.name', '$.tool') AS part_fields
     FROM session_message m, json_each(m.data, '$.content') c
     WHERE m.type = 'assistant' AND json_valid(m.data) AND json_type(m.data) = 'object'
   ) WHERE substr(part_fields, 1, 7) = '["tool"'`,
)

// P7: JSONB route — convert data once, json_each over JSONB (SQLite >= 3.45)
timeQuery(
  "P7 json_each(jsonb(data))",
  `SELECT COUNT(*) AS n FROM session_message m, json_each(jsonb(m.data), '$.content') c
   WHERE m.type = 'assistant' AND json_valid(m.data) AND json_type(m.data) = 'object'`,
)

// P8: JSONB + type filter via ->> on c.value
timeQuery(
  "P8 jsonb + type filter",
  `SELECT COUNT(*) AS n FROM session_message m, json_each(jsonb(m.data), '$.content') c
   WHERE m.type = 'assistant' AND json_valid(m.data) AND json_type(m.data) = 'object'
     AND c.value ->> '$.type' = 'tool'`,
)

// P9: JSONB full tool-name resolution, aggregated
timeQuery(
  "P9 jsonb + full resolution + GROUP BY",
  `SELECT agent_name, resolved_tool_name, COUNT(*) AS n FROM (
     SELECT COALESCE(json_extract(m.data,'$.agent'),'unknown') AS agent_name,
            COALESCE(NULLIF(c.value->>'$.name',''), c.value->>'$.tool') AS resolved_tool_name
     FROM session_message m, json_each(jsonb(m.data), '$.content') c
     WHERE m.type = 'assistant' AND json_valid(m.data) AND json_type(m.data) = 'object'
       AND c.value ->> '$.type' = 'tool'
   ) GROUP BY agent_name, resolved_tool_name`,
)

// P10: validity via jsonb only (one parse) + json_each on jsonb
timeQuery(
  "P10 jsonb validity + json_each(jsonb) + type + GROUP BY",
  `SELECT agent_name, resolved_tool_name, COUNT(*) AS n FROM (
     SELECT COALESCE(json_extract(m.data,'$.agent'),'unknown') AS agent_name,
            COALESCE(NULLIF(c.value->>'$.name',''), c.value->>'$.tool') AS resolved_tool_name
     FROM session_message m, json_each(jsonb(m.data), '$.content') c
     WHERE m.type = 'assistant' AND jsonb(m.data) IS NOT NULL AND json_type(m.data) = 'object'
       AND c.value ->> '$.type' = 'tool'
   ) GROUP BY agent_name, resolved_tool_name`,
)

db.close()
