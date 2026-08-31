#!/usr/bin/env node
// Transform-free static server for the built game (adapted from qed64's
// scripts/serve-dist.mjs): bytes served verbatim (no Content-Encoding — the
// worker SHA-verifies runtime chunks), COOP/COEP on everything (Memory64 +
// SharedArrayBuffer), SPA fallback to index.html.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, normalize, extname } from "node:path";

const DIST = new URL("../client/dist", import.meta.url).pathname;
const PORT = Number(process.env.PORT) || 3006;
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm",
  ".ttf": "font/ttf", ".svg": "image/svg+xml", ".png": "image/png", ".snapz": "application/octet-stream",
};

createServer(async (req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const safe = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  let file = join(DIST, safe === "/" ? "index.html" : safe);
  try {
    if (!(await stat(file)).isFile()) throw new Error("dir");
  } catch {
    file = join(DIST, "index.html"); // SPA fallback
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      "Content-Type": MIME[extname(file)] ?? "application/octet-stream",
      "Content-Length": body.byteLength,
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Resource-Policy": "cross-origin",
      "Cache-Control": "no-transform",
    });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(PORT, () => console.log(`game dist on http://localhost:${PORT}`));
