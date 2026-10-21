import { test } from "node:test"
import assert from "node:assert/strict"

import { redactCredentials } from "../src/export/redact-credentials.ts"

// Fixture values are synthetic: the same shape as the real ones measured in the
// local database (sk- 24/35/51 chars, ghp_ 40, xoxb-), but with made-up bodies.

test("redactCredentials masks an sk- key but keeps its last four characters", () => {
  const redacted = redactCredentials("Authorization: Bearer sk-examplebody0123456789abcdefZ9xQ")
  assert.ok(!redacted.includes("sk-examplebody0123456789abcdefZ9xQ"), "the secret value is gone")
  assert.ok(redacted.includes("Z9xQ"), "the tail stays so the user can tell which key it was")
  assert.ok(redacted.includes("Authorization: Bearer"), "the surrounding syntax is preserved")
})

test("redactCredentials keeps the assignment syntax and only replaces the value", () => {
  const redacted = redactCredentials(`token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"`)
  assert.ok(!redacted.includes("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"))
  assert.ok(redacted.startsWith('token = "'), "the key name and quote survive")
  assert.ok(redacted.endsWith('"'), "the closing quote survives")
  assert.ok(redacted.includes("6789"), "the tail four characters survive")
})

test("redactCredentials masks slack and aws tokens", () => {
  const slackRedacted = redactCredentials(`xoxb-testonly-not-a-real-segment-abcdefghijklmnop`)
  assert.ok(!slackRedacted.includes("abcdefghijklmnop"))

  const awsRedacted = redactCredentials(`AKIAIOSFODNN7EXAMPL9`)
  assert.ok(!awsRedacted.includes("IOSFODNN7EXAMPL9"), "the aws key body is masked")
})

test("redactCredentials removes a private key header entirely", () => {
  const redacted = redactCredentials("-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA")
  assert.ok(!redacted.includes("RSA PRIVATE KEY"), "no key material type leaks")
  assert.ok(redacted.includes("已隐去"), "the redaction is visible, not silent")
})

test("redactCredentials leaves ordinary prose and short prefixes untouched", () => {
  // Guards against over-reach: a sentence mentioning the prefix must not be
  // rewritten into nonsense, and short runs are below the length threshold.
  for (const harmlessText of [
    "nothing secret here",
    "本会话讨论 sk- 前缀的含义",
    "use the token = field to authenticate",
    "",
  ]) {
    assert.equal(redactCredentials(harmlessText), harmlessText)
  }
})

test("redactCredentials is total: non-string input degrades instead of throwing", () => {
  // @ts-expect-error -- deliberately feeding the wrong type
  assert.equal(redactCredentials(undefined), "")
  // @ts-expect-error -- deliberately feeding the wrong type
  assert.equal(redactCredentials(null), "")
})

test("redactCredentials masks every occurrence, not just the first", () => {
  const text = "a sk-exampleAAAA1111bbbb first, then sk-exampleBBBB2222cccc second"
  const redacted = redactCredentials(text)
  assert.ok(!redacted.includes("exampleAAAA1111bbbb"))
  assert.ok(!redacted.includes("exampleBBBB2222cccc"))
  assert.equal(redacted.match(/sk-…/g)?.length, 2, "both occurrences are replaced")
})

test("redactCredentials sees a token glued to an ANSI colour reset (real ESC byte)", () => {
  // The real export path carries terminal-coloured tool output. `\x1b[0m` ends in
  // `m`, a word character, so a `\b` guard before the token silently never fired
  // and 31 keys survived the export. This pins the fix.
  const coloured = "\x1b[32;1mKSCSNKLI_API_KEY  : \x1b[0msk-testonly0123456789abcdefghijABCD"
  const redacted = redactCredentials(coloured)
  assert.ok(!redacted.includes("sk-testonly0123456789abcdefghijABCD"), "the key body is gone")
  assert.ok(redacted.includes("ABCD"), "the tail four characters stay readable")
})

test("redactCredentials sees a token after an escaped ANSI reset (literal backslash-u form)", () => {
  // Same gap in its serialized form: a message may contain the four characters
  // `\u001b` instead of a real ESC byte. The preceding character is still `m`.
  const escaped = "KSCSNKLI_API_KEY  : \\u001b[0msk-testonly0123456789abcdefghijWXYZ"
  const redacted = redactCredentials(escaped)
  assert.ok(!redacted.includes("sk-testonly0123456789abcdefghijWXYZ"), "the key body is gone")
  assert.ok(redacted.includes("WXYZ"), "the tail four characters stay readable")
})
