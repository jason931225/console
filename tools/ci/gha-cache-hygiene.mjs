#!/usr/bin/env node
/**
 * GHA cache hygiene for console.
 *
 * 1. Delete every cache whose key starts with DELETE_PREFIXES (default:
 *    buildkit-, index- — Docker BuildKit type=gha leftovers).
 * 2. If total usage still exceeds MAX_TOTAL_BYTES, delete oldest non-KEEP
 *    caches until under budget (or only KEEP remain).
 * 3. Exit 1 if usage still exceeds MAX_TOTAL_BYTES after deletes.
 *
 * Env:
 *   GITHUB_TOKEN, GITHUB_REPOSITORY (owner/repo)
 *   DRY_RUN=true|false
 *   MAX_TOTAL_BYTES (default 8GiB)
 *   DELETE_PREFIXES (comma-separated)
 *   KEEP_PREFIXES (comma-separated)
 */
import { writeFileSync } from "node:fs";

const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
if (!token || !repo) {
  console.error("GITHUB_TOKEN and GITHUB_REPOSITORY are required");
  process.exit(2);
}
const dryRun = String(process.env.DRY_RUN || "false").toLowerCase() === "true";
const maxTotal = Number(process.env.MAX_TOTAL_BYTES || String(8 * 1024 ** 3));
const deletePrefixes = (process.env.DELETE_PREFIXES || "buildkit-,index-")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const keepPrefixes = (process.env.KEEP_PREFIXES || "v0-rust-,node-cache-")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const api = async (path, init = {}) => {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${init.method || "GET"} ${path} -> ${res.status}: ${body.slice(0, 400)}`);
  }
  if (res.status === 204) return null;
  return res.json();
};

const listAllCaches = async () => {
  const out = [];
  let page = 1;
  for (;;) {
    const batch = await api(
      `/repos/${repo}/actions/caches?per_page=100&page=${page}`,
    );
    const actions = batch.actions_caches || [];
    out.push(...actions);
    if (actions.length < 100) break;
    page += 1;
    if (page > 50) break;
  }
  return out;
};

const matchesPrefix = (key, prefixes) =>
  prefixes.some((p) => (key || "").startsWith(p));

const fmt = (n) => `${(n / (1024 ** 3)).toFixed(2)} GiB`;

const main = async () => {
  const usage = await api(`/repos/${repo}/actions/cache/usage`);
  let caches = await listAllCaches();
  const beforeBytes = usage.active_caches_size_in_bytes || 0;
  console.log(
    `usage before: ${fmt(beforeBytes)} across ${usage.active_caches_count} (list ${caches.length})`,
  );
  console.log(`dry_run=${dryRun} max_total=${fmt(maxTotal)}`);
  console.log(`delete_prefixes=${deletePrefixes.join(",")}`);
  console.log(`keep_prefixes=${keepPrefixes.join(",")}`);

  const victims = [];
  const force = caches.filter((c) => matchesPrefix(c.key, deletePrefixes));
  for (const c of force) victims.push({ ...c, reason: "docker-gha-prefix" });

  const forceIds = new Set(force.map((c) => c.id));
  let projected =
    beforeBytes - force.reduce((s, c) => s + (c.size_in_bytes || 0), 0);

  if (projected > maxTotal) {
    const rest = caches
      .filter((c) => !forceIds.has(c.id))
      .filter((c) => !matchesPrefix(c.key, keepPrefixes))
      .sort((a, b) => {
        const ta = Date.parse(a.last_accessed_at || a.created_at || 0);
        const tb = Date.parse(b.last_accessed_at || b.created_at || 0);
        return ta - tb; // oldest first
      });
    for (const c of rest) {
      if (projected <= maxTotal) break;
      victims.push({ ...c, reason: "budget-lru" });
      projected -= c.size_in_bytes || 0;
    }
  }

  // unique by id
  const byId = new Map();
  for (const v of victims) byId.set(v.id, v);
  const unique = [...byId.values()];
  console.log(`victims: ${unique.length}`);
  for (const v of unique.slice(0, 40)) {
    console.log(
      `  - ${v.reason} id=${v.id} ${(v.size_in_bytes / 1e6).toFixed(1)}MB ${String(v.key).slice(0, 70)}`,
    );
  }
  if (unique.length > 40) console.log(`  ... +${unique.length - 40} more`);

  let deleted = 0;
  let failed = 0;
  if (!dryRun) {
    for (const v of unique) {
      try {
        await api(`/repos/${repo}/actions/caches/${v.id}`, { method: "DELETE" });
        deleted += 1;
      } catch (e) {
        failed += 1;
        console.error(`delete failed id=${v.id}: ${e.message}`);
      }
    }
  }

  // re-read usage
  const usageAfter = await api(`/repos/${repo}/actions/cache/usage`);
  const afterBytes = usageAfter.active_caches_size_in_bytes || 0;
  console.log(
    `usage after: ${fmt(afterBytes)} across ${usageAfter.active_caches_count} (deleted=${deleted} failed=${failed} dry_run=${dryRun})`,
  );

  if (typeof process.env.GITHUB_STEP_SUMMARY === "string") {
    writeFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      [
        `## GHA cache hygiene`,
        ``,
        `| | |`,
        `|---|---|`,
        `| before | ${fmt(beforeBytes)} / ${usage.active_caches_count} keys |`,
        `| after | ${fmt(afterBytes)} / ${usageAfter.active_caches_count} keys |`,
        `| victims | ${unique.length} (deleted=${deleted}, failed=${failed}) |`,
        `| dry_run | ${dryRun} |`,
        `| max_total | ${fmt(maxTotal)} |`,
        ``,
      ].join("\n"),
      { flag: "a" },
    );
  }

  if (afterBytes > maxTotal && !dryRun) {
    console.error(
      `cache budget still over max_total (${fmt(afterBytes)} > ${fmt(maxTotal)})`,
    );
    process.exit(1);
  }
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
