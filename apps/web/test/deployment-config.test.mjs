import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = rel => fs.readFileSync(path.join(root, rel), "utf8");

test("vite base path is /geotabassetbooking/ for GitHub Pages project site", () => {
  const viteConfig = read("vite.config.ts");
  const baseMatch = viteConfig.match(/base:\s*["']([^"']+)["']/);
  assert.ok(baseMatch, "vite.config.ts should have a base property");
  assert.equal(baseMatch[1], "/geotabassetbooking/", "base path should be /geotabassetbooking/");
});

test("vite base path has no duplicate repository path segments", () => {
  const viteConfig = read("vite.config.ts");
  const baseMatch = viteConfig.match(/base:\s*["']([^"']+)["']/);
  assert.ok(baseMatch, "vite.config.ts should have a base property");
  const base = baseMatch[1];
  const segments = base.split("/").filter(Boolean);
  const uniqueSegments = [...new Set(segments)];
  assert.equal(segments.length, uniqueSegments.length, `base path has duplicate segments: ${base}`);
});

test("ActivityLink URL points to correct GitHub Pages site", () => {
  const config = JSON.parse(read("../../geotab/opex-vbm-config.json"));
  const item = config.items.find(i => i.path === "ActivityLink");
  assert.ok(item, "ActivityLink item should exist");
  const url = new URL(item.url);
  assert.equal(url.host, "heppyht.github.io", "ActivityLink host should be heppyht.github.io");
  assert.equal(url.pathname, "/geotabassetbooking/", "ActivityLink path should be /geotabassetbooking/");
});

test("Service Add-In serviceSrc points to correct deployed file", () => {
  const config = JSON.parse(read("../../geotab/opex-vbm-service-config.json"));
  const item = config.items.find(i => i.serviceSrc);
  assert.ok(item, "Service Add-In item with serviceSrc should exist");
  const url = new URL(item.serviceSrc);
  assert.equal(url.host, "heppyht.github.io", "serviceSrc host should be heppyht.github.io");
  assert.equal(url.pathname, "/geotabassetbooking/serviceAddin.js", "serviceSrc path should be /geotabassetbooking/serviceAddin.js");
});

test("no duplicate repository path segments in configuration URLs", () => {
  const viteConfig = read("vite.config.ts");
  const config = JSON.parse(read("../../geotab/opex-vbm-config.json"));
  const serviceConfig = JSON.parse(read("../../geotab/opex-vbm-service-config.json"));

  const urls = [];
  const baseMatch = viteConfig.match(/base:\s*["']([^"']+)["']/);
  if (baseMatch) urls.push(baseMatch[1]);
  config.items.forEach(item => { if (item.url) urls.push(item.url); });
  config.items.forEach(item => { if (item.serviceSrc) urls.push(item.serviceSrc); });

  urls.forEach(url => {
    const segments = url.split("/").filter(Boolean);
    const uniqueSegments = [...new Set(segments)];
    assert.equal(segments.length, uniqueSegments.length, `URL has duplicate path segments: ${url}`);
  });
});
