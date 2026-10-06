// Probe 3: JSONB binary-lookup design vs current, plus usage-query variants.
import { DatabaseSync } from "node:sqlite"
import { homedir } from "node:os"
import { join } from "node:path"

const dbPath = join(homedir(), ".local", "share", "opencode", "opencode.db")
const db = new DatabaseSync(dbPath, { readOnly: true })

function timeQuery(label, sql, params = []) {
  const start = performance.now()
  const rows = db.prepare(sql).all(...params)
  const elapsed = Math.round(performance.now() - start)
  const n = Array.isArray(rows) ? rows.length : 1
  console.log(`${label}: ${elapsed}ms, rows=${n}`)
  return rows
}

// sanity: ->> on a JSONB blob
console.log("jsonb ->> literal:", JSON.stringify(db.prepare(`SELECT jsonb('{"name":"x"}') ->> '$.name' AS v`).get()))

// W2: conversion-only cost
timeQuery(
  "W2 jsonb conversion only",
  `SELECT COUNT(*) AS n FROM session_message
   WHERE type='assistant' AND json_valid(data) AND jsonb(data) IS NOT NULL`,
)

// W3: usage via 4 single-path text extracts (early-stop?)
timeQuery(
  "W3 usage single-path extracts",
  `SELECT session_id,
          json_extract(data,'$.agent') AS agent,
          json_extract(data,'$.tokens.input') AS ti,
          json_extract(data,'$.tokens.output') AS to_,
          json_extract(data,'$.tokens.cache.read') AS tcr
   FROM session_message
   WHERE type='assistant' AND json_valid(data) AND json_type(data)='object'`,
)

// W4: usage via JSONB binary lookups (4 conversions per row)
timeQuery(
  "W4 usage jsonb ->> x4",
  `SELECT session_id,
          jsonb(data) ->> '$.agent' AS agent,
          jsonb(data) ->> '$.tokens.input' AS ti,
          jsonb(data) ->> '$.tokens.output' AS to_,
          jsonb(data) ->> '$.tokens.cache.read' AS tcr
   FROM session_message
   WHERE type='assistant' AND json_valid(data) AND json_type(data)='object'`,
)

// W5: tool names via json_each over JSONB doc + binary fullkey lookups
timeQuery(
  "W5 tool names: jsonb doc + fullkey binary lookups",
  `SELECT agent_name, resolved_tool_name FROM (
     SELECT COALESCE(json_extract(m.data,'$.agent'), 'unknown') AS agent_name,
            COALESCE(
              NULLIF(jsonb(m.data) ->> (c.fullkey || '.' || 'name'), ''),
              jsonb(m.data) ->> (c.fullkey || '.' || 'tool')
            ) AS resolved_tool_name
     FROM session_message m, json_each(jsonb(m.data), '$.content') c
     WHERE m.type='assistant' AND json_valid(m.data)
       AND json_type(m.data, '$.content') = 'array'
       AND jsonb(m.data) ->> (c.fullkey || '.' || 'type') = 'tool'
   )`,
)

// W6: same but aggregated in SQL
timeQuery(
  "W6 W5 + GROUP BY",
  `SELECT agent_name, resolved_tool_name, COUNT(*) AS n FROM (
     SELECT COALESCE(json_extract(m.data,'$.agent'), 'unknown') AS agent_name,
            COALESCE(
              NULLIF(jsonb(m.data) ->> (c.fullkey || '.' || 'name'), ''),
              jsonb(m.data) ->> (c.fullkey || '.' || 'tool')
            ) AS resolved_tool_name
     FROM session_message m, json_each(jsonb(m.data), '$.content') c
     WHERE m.type='assistant' AND json_valid(m.data)
       AND json_type(m.data, '$.content') = 'array'
       AND jsonb(m.data) ->> (c.fullkey || '.' || 'type') = 'tool'
   ) GROUP BY agent_name, resolved_tool_name`,
)

// W7: like W5 but the type filter via text ->> on rendered c.value (isolate cost difference)
timeQuery(
  "W7 W5 with c.value ->> type",
  `SELECT agent_name, resolved_tool_name FROM (
     SELECT COALESCE(json_extract(m.data,'$.agent'), 'unknown') AS agent_name,
            COALESCE(
              NULLIF(jsonb(m.data) ->> (c.fullkey || '.' || 'name'), ''),
              jsonb(m.data) ->> (c.fullkey || '.' || 'tool')
            ) AS resolved_tool_name
     FROM session_message m, json_each(jsonb(m.data), '$.content') c
     WHERE m.type='assistant' AND json_valid(m.data)
       AND json_type(m.data, '$.content') = 'array'
       AND c.value ->> '$.type' = 'tool'
   )`,
)

db.close()
