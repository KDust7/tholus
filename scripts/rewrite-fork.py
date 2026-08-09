import argparse
import pathlib
import re
import sys

FORK = pathlib.Path(__file__).resolve().parent.parent / "vendor" / "uv"
SHIM_CRATES = {"uv-vfs", "uv-wasm-http", "uv-wasm-compat"}
VFS_DEP = 'uv-vfs = { workspace = true }'
WORKSPACE_DEP = 'uv-vfs = { version = "0.0.70", path = "crates/uv-vfs" }'
URL_IMPORT = '#[cfg(target_family = "wasm")]\nuse uv_vfs::UrlFilePathExt as _;'

SOURCE_RULES = [
    ("fs_err-to-vfs", re.compile(r"\bfs_err::tokio\b"), "uv_vfs::fs::tokio"),
    ("fs_err-to-vfs", re.compile(r"\bfs_err\b(?!\s*=)"), "uv_vfs::fs"),
    ("tempfile-to-vfs", re.compile(r"\btempfile::"), "uv_vfs::temp::"),
    ("std-instant-to-web-time", re.compile(r"\bstd::time::Instant\b"), "web_time::Instant"),
    ("std-systemtime-to-web-time", re.compile(r"\bstd::time::SystemTime\b"), "web_time::SystemTime"),
]

URL_METHODS = re.compile(r"\b(from_file_path|to_file_path|from_directory_path)\b")


def crate_dirs():
    crates = FORK / "crates"
    if not crates.is_dir():
        raise SystemExit(f"fork not found at {FORK}; clone it before running this script")
    for crate_dir in sorted(crates.iterdir()):
        if crate_dir.is_dir() and crate_dir.name not in SHIM_CRATES:
            yield crate_dir


def rust_sources(crate_dir):
    for path in sorted(crate_dir.rglob("*.rs")):
        if "target" not in path.parts:
            yield path


def apply_source_rules(text):
    counts = {}
    for name, pattern, replacement in SOURCE_RULES:
        text, hits = pattern.subn(replacement, text)
        if hits:
            counts[name] = counts.get(name, 0) + hits
    return text, counts


def inject_url_import(text):
    if not URL_METHODS.search(text) or "UrlFilePathExt" in text:
        return text, 0

    lines = text.splitlines()
    insert_at = None
    for index, line in enumerate(lines):
        if line.startswith("use "):
            insert_at = index + 1
    if insert_at is None:
        for index, line in enumerate(lines):
            stripped = line.strip()
            if stripped and not stripped.startswith(("//", "#!", "#[")):
                insert_at = index
                break
    if insert_at is None:
        insert_at = len(lines)

    lines[insert_at:insert_at] = URL_IMPORT.splitlines()
    return "\n".join(lines) + ("\n" if text.endswith("\n") else ""), 1


def ensure_crate_dependency(crate_dir, needs_vfs):
    manifest = crate_dir / "Cargo.toml"
    if not manifest.is_file() or not needs_vfs:
        return 0
    text = manifest.read_text(encoding="utf-8")
    if "uv-vfs" in text:
        return 0
    if "[dependencies]" not in text:
        return 0
    updated = text.replace("[dependencies]\n", f"[dependencies]\n{VFS_DEP}\n", 1)
    manifest.write_text(updated, encoding="utf-8")
    return 1


def ensure_workspace_dependency():
    manifest = FORK / "Cargo.toml"
    text = manifest.read_text(encoding="utf-8")
    if "uv-vfs" in text:
        return 0
    anchor = 'uv-types = '
    index = text.find(anchor)
    if index == -1:
        return 0
    updated = f"{text[:index]}{WORKSPACE_DEP}\n{text[index:]}"
    manifest.write_text(updated, encoding="utf-8")
    return 1


def main():
    parser = argparse.ArgumentParser(
        description="Apply the mechanical wasm rewrites to the vendored uv fork."
    )
    parser.add_argument("--check", action="store_true", help="report without writing")
    args = parser.parse_args()

    totals = {}
    touched = set()

    for crate_dir in crate_dirs():
        needs_vfs = False
        for path in rust_sources(crate_dir):
            original = path.read_text(encoding="utf-8")
            updated, counts = apply_source_rules(original)
            updated, injected = inject_url_import(updated)
            if injected:
                counts["url-extension-import"] = injected
            if "uv_vfs" in updated:
                needs_vfs = True
            if updated == original:
                continue
            touched.add(path)
            for name, hits in counts.items():
                totals[name] = totals.get(name, 0) + hits
            if not args.check:
                path.write_text(updated, encoding="utf-8")

        if not args.check:
            added = ensure_crate_dependency(crate_dir, needs_vfs)
            if added:
                totals["crate-dependency"] = totals.get("crate-dependency", 0) + added

    if not args.check:
        added = ensure_workspace_dependency()
        if added:
            totals["workspace-dependency"] = added

    verb = "would rewrite" if args.check else "rewrote"
    print(f"{verb} {len(touched)} file(s) across {FORK}")
    for name in sorted(totals):
        print(f"  {name}: {totals[name]}")

    return 1 if args.check and touched else 0


if __name__ == "__main__":
    sys.exit(main())
