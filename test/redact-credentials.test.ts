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

test("redactCredentials removes the whole PBKDF2/PKCS#8 block, body and END footer included", () => {
  // Regression: the old rule matched only the BEGIN line, leaving the base64
  // body and the `-----END …-----` footer verbatim in the export.
  const privateKeyBlock = [
    "-----BEGIN RSA PRIVATE KEY-----",
    "MIIEpAIBAAKCAQEA7Zx9Qw2Fn8vK3sT1uV5yB7cD9eF0gH2iJ4kL6mN8oP0qR2sT4uV6wX8yZ",
    "1aB2cD3eF4gH5iJ6kL7mN8oP9qR0sT1uV2wX3yZ4aB5cD6eF7gH8iJ9kL0mN1oP2qR3sT4uV",
    "-----END RSA PRIVATE KEY-----",
  ].join("\n")

  const redacted = redactCredentials(privateKeyBlock)

  assert.ok(
    !redacted.includes("MIIEpAIBAAKCAQEA7Zx9Qw2Fn8vK3sT1uV5yB7cD9eF0gH2iJ4kL6mN8oP0qR2sT4uV6wX8yZ"),
    "the base64 body is gone, not just the header",
  )
  assert.ok(!redacted.includes("END"), "the END footer is gone too")
  assert.ok(redacted.includes("已隐去"), "the redaction marker is present")
})

test("redactCredentials a truncated lone private key header is still redacted", () => {
  // The header-only fallback must stay, for a block whose END line was trimmed.
  const redacted = redactCredentials("-----BEGIN OPENSSH PRIVATE KEY-----")
  assert.ok(!redacted.includes("OPENSSH PRIVATE KEY"))
  assert.ok(redacted.includes("已隐去"))
})

test("redactCredentials covers github_pat_ fine-grained tokens", () => {
  const fineGrainedPat = "github_pat_testonly00001111222233334444"
  const redacted = redactCredentials(`remote: ${fineGrainedPat}`)
  assert.ok(!redacted.includes(fineGrainedPat), "the fine-grained PAT body is gone")
  assert.ok(redacted.includes("github-…4444"), "tail four characters stay readable")
})

test("redactCredentials covers slack xapp- and xoxc-/xoxd- tokens", () => {
  const appLevelToken = "xapp-testonly-1111222233334444"
  const appRedacted = redactCredentials(`SLACK_APP_TOKEN=${appLevelToken}`)
  assert.ok(!appRedacted.includes(appLevelToken), "the xapp- token body is gone")
  assert.ok(appRedacted.includes("slack-…4444"))

  const cookieToken = "xoxc-testonly-5555666677778888"
  const cookieRedacted = redactCredentials(cookieToken)
  assert.ok(!cookieRedacted.includes(cookieToken), "the xoxc- token body is gone")
  assert.ok(cookieRedacted.includes("slack-…8888"))
})

test("redactCredentials covers Stripe sk_live_/sk_test_ keys without touching the sk- rule", () => {
  // Segmented so no contiguous sk_live_/sk_test_ token appears in source:
  // GitHub push protection flags the literal shape as a Stripe key even though
  // the body here is synthetic and the test only exercises the matcher.
  const stripeLiveKey = "sk_" + "live_" + "testonly11112222333344445555"
  const stripeTestKey = "sk_" + "test_" + "testonly66667777888899990000"
  const redacted = redactCredentials(`${stripeLiveKey} and ${stripeTestKey}`)
  assert.ok(!redacted.includes(stripeLiveKey), "the sk_live_ body is gone")
  assert.ok(!redacted.includes(stripeTestKey), "the sk_test_ body is gone")
  assert.equal(redacted.match(/sk-…/g)?.length, 2, "each key still carries the sk- label")
})

test("redactCredentials covers env-style assignments whose key contains a sensitive word", () => {
  const awsValue = "testonlyvalue0123456789ABCDEF"
  const envAssignments = [
    `AWS_SECRET_ACCESS_KEY="${awsValue}"`,
    "MY_APP_SECRET=anothervalue0123456789abcdef",
    "GITHUB_TOKEN=unquotedvalue0123456789abcdef",
  ]
  for (const assignment of envAssignments) {
    const redacted = redactCredentials(assignment)
    assert.ok(!redacted.includes("value0123456789"), `the value in ${assignment} must be gone`)
    assert.ok(redacted.includes("凭据-"), "the assignment key and separator survive")
  }
})

test("redactCredentials covers an unquoted password assignment", () => {
  const redacted = redactCredentials("password=hunter2hunter2hunter2")
  assert.ok(!redacted.includes("hunter2hunter2hunter2"), "the unquoted value is gone")
  assert.ok(redacted.startsWith("password="), "the key and separator survive")
  assert.ok(redacted.includes("凭据-"))
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

test("redactCredentials does not redact a benign sentence that merely contains 'secret'", () => {
  // The grouped rule needs a key, a `=`/`:` separator and a ≥16-char value;
  // natural language has none of those, so it must pass through unchanged.
  for (const benignSentence of [
    "the secret sauce was tasty",
    "I keep a secret for my friends",
    "a secret: it was short",
  ]) {
    assert.equal(redactCredentials(benignSentence), benignSentence)
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
