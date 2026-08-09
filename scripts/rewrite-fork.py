import argparse
import pathlib
import re
import sys

FORK = pathlib.Path(__file__).resolve().parent.parent / "vendor" / "uv"
SHIM_CRATES = {"uv-vfs", "uv-wasm-http", "uv-wasm-compat"}

SHIM_DEPENDENCIES = {
    "uv_vfs": ("uv-vfs", 'uv-vfs = { version = "0.0.70", path = "crates/uv-vfs" }'),
    "uv_wasm_compat": (
        "uv-wasm-compat",
        'uv-wasm-compat = { version = "0.0.70", path = "crates/uv-wasm-compat" }',
    ),
    "uv_wasm_http": (
        "uv-wasm-http",
        'uv-wasm-http = { version = "0.0.70", path = "crates/uv-wasm-http" }',
    ),
}

WASM_SAFE_TOKIO_FEATURES = ["io-util", "macros", "rt", "sync"]

NATIVE_TOKIO_FEATURES = {
    "uv": ["process", "signal"],
    "uv-auth": ["process"],
    "uv-build-frontend": ["process"],
    "uv-installer": ["process"],
}

URL_IMPORT = '#[cfg(target_family = "wasm")]\nuse uv_vfs::UrlFilePathExt as _;'

SOURCE_RULES = [
    ("fs_err-to-vfs", re.compile(r"\bfs_err::tokio\b"), "uv_vfs::fs::tokio"),
    ("fs_err-to-vfs", re.compile(r"\bfs_err\b(?!\s*=)"), "uv_vfs::fs"),
    ("tempfile-to-vfs", re.compile(r"\btempfile::"), "uv_vfs::temp::"),
    ("std-instant-to-web-time", re.compile(r"\bstd::time::Instant\b"), "web_time::Instant"),
    (
        "std-systemtime-to-web-time",
        re.compile(r"\bstd::time::SystemTime\b"),
        "web_time::SystemTime",
    ),
    (
        "tokio-time-to-compat",
        re.compile(r"\btokio::time::(sleep|timeout)\b"),
        r"uv_wasm_compat::time::\1",
    ),
    (
        "tokio-spawn-blocking-to-compat",
        re.compile(r"\btokio::task::spawn_blocking\b"),
        "uv_wasm_compat::spawn_blocking",
    ),
]

URL_METHODS = re.compile(r"\b(from_file_path|to_file_path|from_directory_path)\b")
TOKIO_WORKSPACE = re.compile(r'tokio = \{ version = "[^"]+", features = \[[^\]]*\] \}', re.S)


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


def ensure_crate_dependencies(crate_dir, needed):
    manifest = crate_dir / "Cargo.toml"
    if not manifest.is_file() or not needed:
        return 0
    text = manifest.read_text(encoding="utf-8")
    if "[dependencies]" not in text:
        return 0

    added = 0
    for crate_name in sorted(needed):
        if crate_name in text:
            continue
        text = text.replace(
            "[dependencies]\n", f"[dependencies]\n{crate_name} = {{ workspace = true }}\n", 1
        )
        added += 1
    if added:
        manifest.write_text(text, encoding="utf-8")
    return added


REPLACED_DEPENDENCIES = {
    "fs-err": re.compile(r"\bfs_err\b"),
    "tempfile": re.compile(r"\btempfile\b"),
}

FEATURE_REDIRECTS = {'"fs-err/tokio"': '"uv-vfs/tokio"'}


def prune_replaced_dependencies(crate_dir):
    manifest = crate_dir / "Cargo.toml"
    if not manifest.is_file():
        return 0

    sources = [path.read_text(encoding="utf-8") for path in rust_sources(crate_dir)]
    text = manifest.read_text(encoding="utf-8")
    original = text

    for old, new in FEATURE_REDIRECTS.items():
        text = text.replace(old, new)

    for dependency, pattern in REPLACED_DEPENDENCIES.items():
        if any(pattern.search(source) for source in sources):
            continue
        text = "\n".join(
            line for line in text.splitlines() if not line.startswith(f"{dependency} =")
        ) + ("\n" if text.endswith("\n") else "")

    if text == original:
        return 0
    manifest.write_text(text, encoding="utf-8")
    return 1


def ensure_native_tokio(crate_dir):
    features = NATIVE_TOKIO_FEATURES.get(crate_dir.name)
    manifest = crate_dir / "Cargo.toml"
    if not features or not manifest.is_file():
        return 0
    text = manifest.read_text(encoding="utf-8")
    marker = 'cfg(not(target_family = "wasm"))'
    if marker in text and "tokio" in text.split(marker, 1)[1][:400]:
        return 0
    rendered = ", ".join(f'"{feature}"' for feature in features)
    block = (
        f'\n[target.\'{marker}\'.dependencies]\n'
        f"tokio = {{ workspace = true, features = [{rendered}] }}\n"
    )
    manifest.write_text(text.rstrip() + "\n" + block, encoding="utf-8")
    return 1


def ensure_workspace_dependencies():
    manifest = FORK / "Cargo.toml"
    text = manifest.read_text(encoding="utf-8")
    anchor = "uv-types = "
    index = text.find(anchor)
    if index == -1:
        return 0

    added = 0
    for _, (crate_name, entry) in sorted(SHIM_DEPENDENCIES.items()):
        if f"\n{crate_name} = " in text:
            continue
        text = f"{text[:index]}{entry}\n{text[index:]}"
        index = text.find(anchor)
        added += 1
    if added:
        manifest.write_text(text, encoding="utf-8")
    return added


def strip_workspace_tokio():
    manifest = FORK / "Cargo.toml"
    text = manifest.read_text(encoding="utf-8")
    match = TOKIO_WORKSPACE.search(text)
    if not match:
        return 0
    rendered = ",\n  ".join(f'"{feature}"' for feature in WASM_SAFE_TOKIO_FEATURES)
    replacement = f'tokio = {{ version = "1.45.1", features = [\n  {rendered},\n] }}'
    if match.group(0) == replacement:
        return 0
    manifest.write_text(text[: match.start()] + replacement + text[match.end() :], encoding="utf-8")
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
        needed = set()
        for path in rust_sources(crate_dir):
            original = path.read_text(encoding="utf-8")
            updated, counts = apply_source_rules(original)
            updated, injected = inject_url_import(updated)
            if injected:
                counts["url-extension-import"] = injected
            for marker, (crate_name, _) in SHIM_DEPENDENCIES.items():
                if marker in updated:
                    needed.add(crate_name)
            if updated == original:
                continue
            touched.add(path)
            for name, hits in counts.items():
                totals[name] = totals.get(name, 0) + hits
            if not args.check:
                path.write_text(updated, encoding="utf-8")

        if not args.check:
            added = ensure_crate_dependencies(crate_dir, needed)
            if added:
                totals["crate-dependency"] = totals.get("crate-dependency", 0) + added
            if ensure_native_tokio(crate_dir):
                totals["native-tokio-block"] = totals.get("native-tokio-block", 0) + 1
            if prune_replaced_dependencies(crate_dir):
                totals["pruned-manifest"] = totals.get("pruned-manifest", 0) + 1

    if not args.check:
        added = ensure_workspace_dependencies()
        if added:
            totals["workspace-dependency"] = added
        if strip_workspace_tokio():
            totals["workspace-tokio-strip"] = 1

    verb = "would rewrite" if args.check else "rewrote"
    print(f"{verb} {len(touched)} file(s) across {FORK}")
    for name in sorted(totals):
        print(f"  {name}: {totals[name]}")

    return 1 if args.check and touched else 0


if __name__ == "__main__":
    sys.exit(main())
