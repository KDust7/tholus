import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const crates = join(root, "vendor/uv/crates");

const SHIMS = [
  {
    what: "etcetera",
    pattern: /\betcetera::/,
    ownedBy: "uv-dirs",
    instead: "uv_dirs::user_cache_dir/user_state_dir/user_data_dir/user_config_dir",
  },
  {
    what: "fs_err",
    pattern: /\bfs_err::/,
    ownedBy: "uv-vfs",
    instead: "uv_vfs::fs",
  },
  {
    what: "tempfile",
    pattern: /\btempfile::/,
    ownedBy: "uv-vfs",
    instead: "uv_vfs::temp",
  },
  {
    what: "walkdir",
    pattern: /\bwalkdir::/,
    ownedBy: "uv-vfs",
    instead: "uv_vfs::walk",
  },
  {
    what: "std::env",
    pattern: /\bstd::env::(var|var_os|set_var|remove_var|vars)\b/,
    ownedBy: "uv-vfs",
    instead: "uv_vfs::var/var_os/set_var",
  },
];

const EXEMPT = new Map([
  [
    "vendor/uv/crates/uv/src/commands/self_update.rs",
    [
      {
        line: "if let Ok(path) = etcetera::home_dir() {",
        why: 'the whole module is behind #[cfg(feature = "self-update")], which --no-default-features never compiles',
      },
    ],
  ],
  [
    "vendor/uv/crates/uv/src/lib.rs",
    [
      {
        line: "std::env::set_var(EnvVars::UV, current_exe);",
        why: 'gated by #[cfg(not(target_family = "wasm"))]: it propagates uv to child processes, and a browser has none',
      },
    ],
  ],
]);

function workspaceExcludes() {
  const manifest = readFileSync(join(root, "vendor/uv/Cargo.toml"), "utf8");
  const section = manifest.slice(manifest.indexOf("exclude"));
  const list = /exclude\s*=\s*\[(.*?)\]/s.exec(section)?.[1] ?? "";
  return new Set(
    [...list.matchAll(/"([^"]+)"/g)]
      .map((match) => match[1])
      .filter((entry) => entry.startsWith("crates/"))
      .map((entry) => entry.slice("crates/".length)),
  );
}

const excluded = workspaceExcludes();

function sources(directory) {
  if (!existsSync(directory)) {
    return [];
  }
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "target" ? [] : sources(path);
    }
    return path.endsWith(".rs") ? [path] : [];
  });
}

const relativeTo = (file) => file.slice(root.length + 1).split("\\").join("/");

function matchingLines(text, pattern) {
  return text
    .split(String.fromCharCode(10))
    .map((line, index) => ({ number: index + 1, text: line.trim() }))
    .filter((line) => pattern.test(line.text));
}

const escapes = [];

for (const crate of readdirSync(crates, { withFileTypes: true })) {
  if (!crate.isDirectory() || excluded.has(crate.name)) {
    continue;
  }
  for (const shim of SHIMS) {
    if (crate.name === shim.ownedBy) {
      continue;
    }
    for (const file of sources(join(crates, crate.name, "src"))) {
      const where = relativeTo(file);
      const allowed = new Set((EXEMPT.get(where) ?? []).map((entry) => entry.line));
      const lines = matchingLines(readFileSync(file, "utf8"), shim.pattern).filter(
        (line) => !allowed.has(line.text),
      );
      if (lines.length === 0) {
        continue;
      }
      escapes.push({ crate: crate.name, file: where, shim, lines });
    }
  }
}

if (escapes.length > 0) {
  console.error(
    `\n${escapes.length} place${escapes.length === 1 ? " reaches" : "s reach"} past a shim the port depends on:\n`,
  );
  for (const escape of escapes) {
    console.error(`  ${escape.file}`);
    console.error(
      `    uses ${escape.shim.what} directly; ${escape.shim.ownedBy} owns the browser-aware version, use ${escape.shim.instead}`,
    );
    for (const line of escape.lines) {
      console.error(`      ${line.number}: ${line.text}`);
    }
  }
  console.error(
    "\nA shim is only as good as the call sites rewritten to use it. If a use here is genuinely\n" +
      "native-only, gate it off wasm and say so at the call site.\n",
  );
  process.exit(1);
}

for (const [where, entries] of EXEMPT) {
  const path = join(root, where);
  if (!existsSync(path)) {
    console.error(`${where} is exempted but does not exist; the exemption is stale`);
    process.exit(1);
  }
  const text = readFileSync(path, "utf8");
  for (const entry of entries) {
    if (!text.includes(entry.line)) {
      console.error(
        `${where} no longer contains the exempted line \`${entry.line}\`; drop the exemption`,
      );
      process.exit(1);
    }
    console.log(`exempt: ${where}, ${entry.why}`);
  }
}

console.log(
  `no crate reaches past any of the ${SHIMS.length} shims the port depends on ` +
    `(${excluded.size} workspace-excluded crates were not read)`,
);
