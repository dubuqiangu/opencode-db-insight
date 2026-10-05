/**
 * Tests for static path resolution and content types (src/web/static-files.ts).
 * The public directory is the real src/web/public (may or may not exist yet —
 * M3 lands there; these tests only exercise path logic, never file reads).
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

import {
  contentTypeForFilePath,
  resolveStaticFilePath,
} from "../src/web/static-files.ts"

const publicDirectory = fileURLToPath(new URL("../src/web/public", import.meta.url))
const publicRoot = resolve(publicDirectory)

test("resolveStaticFilePath maps the dashboard root to index.html", () => {
  assert.equal(resolveStaticFilePath(publicDirectory, "/"), resolve(publicRoot, "index.html"))
  assert.equal(resolveStaticFilePath(publicDirectory, ""), resolve(publicRoot, "index.html"))
})

test("resolveStaticFilePath maps nested asset paths inside the public directory", () => {
  assert.equal(
    resolveStaticFilePath(publicDirectory, "/assets/app.js"),
    resolve(publicRoot, "assets/app.js"),
  )
  assert.equal(
    resolveStaticFilePath(publicDirectory, "/vendor/uplot.min.js"),
    resolve(publicRoot, "vendor/uplot.min.js"),
  )
  assert.equal(
    resolveStaticFilePath(publicDirectory, "/assets/app%20v2.js"),
    resolve(publicRoot, "assets/app v2.js"),
  )
})

test("resolveStaticFilePath rejects traversal attempts with null", () => {
  assert.equal(resolveStaticFilePath(publicDirectory, "/../package.json"), null)
  assert.equal(resolveStaticFilePath(publicDirectory, "/%2e%2e/package.json"), null)
  assert.equal(resolveStaticFilePath(publicDirectory, "/..%2fpackage.json"), null)
  assert.equal(resolveStaticFilePath(publicDirectory, "/a/../../secret.txt"), null)
  assert.equal(resolveStaticFilePath(publicDirectory, "/..\\..\\secret.txt"), null)
  assert.equal(resolveStaticFilePath(publicDirectory, "/%2e%2e%5c%2e%2e%5csecret.txt"), null)
  assert.equal(resolveStaticFilePath(publicDirectory, "/%ff-bad-encoding"), null)
})

test("resolveStaticFilePath keeps device-shaped paths inside the public root", () => {
  // A drive-letter-shaped request must not jump to an absolute device path;
  // it resolves to a (nonexistent) file inside public/ — safe 404 territory.
  const deviceShapedPath = resolveStaticFilePath(publicDirectory, "/C:/Windows/system32")
  assert.notEqual(deviceShapedPath, null)
  assert.ok(deviceShapedPath!.startsWith(publicRoot))
})

test("contentTypeForFilePath maps the front-end extensions and defaults to octet-stream", () => {
  assert.equal(contentTypeForFilePath("index.html"), "text/html; charset=utf-8")
  assert.equal(contentTypeForFilePath("assets/app.JS"), "text/javascript; charset=utf-8")
  assert.equal(contentTypeForFilePath("styles/main.css"), "text/css; charset=utf-8")
  assert.equal(contentTypeForFilePath("img/logo.svg"), "image/svg+xml")
  assert.equal(contentTypeForFilePath("data/table.json"), "application/json; charset=utf-8")
  assert.equal(contentTypeForFilePath("binary.blob"), "application/octet-stream")
  assert.equal(contentTypeForFilePath("no-extension"), "application/octet-stream")
})
