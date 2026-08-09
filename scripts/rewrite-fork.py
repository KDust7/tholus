import argparse
import pathlib
import re
import sys

FORK = pathlib.Path(__file__).resolve().parent.parent / "vendor" / "uv"
SHIM_CRATES = {"uv-vfs", "uv-wasm-http", "uv-wasm-compat"}

RULES = [
    (
        "fs_err-to-vfs",
        re.compile(r"\bfs_err::tokio\b"),
        "uv_vfs::fs::tokio",
    ),
    (
        "fs_err-to-vfs",
        re.compile(r"\bfs_err\b(?!\s*=)"),
        "uv_vfs::fs",
    ),
    (
        "tempfile-to-vfs",
        re.compile(r"\btempfile::"),
        "uv_vfs::temp::",
    ),
    (
        "std-instant-to-web-time",
        re.compile(r"\bstd::time::Instant\b"),
        "web_time::Instant",
    ),
    (
        "std-systemtime-to-web-time",
        re.compile(r"\bstd::time::SystemTime\b"),
        "web_time::SystemTime",
    ),
]


def rust_sources():
    crates = FORK / "crates"
    if not crates.is_dir():
        raise SystemExit(f"fork not found at {FORK}; clone it before running this script")
    for crate_dir in sorted(crates.iterdir()):
        if not crate_dir.is_dir() or crate_dir.name in SHIM_CRATES:
            continue
        for path in sorted(crate_dir.rglob("*.rs")):
            if "target" in path.parts:
                continue
            yield path


def rewrite(text):
    counts = {}
    for name, pattern, replacement in RULES:
        text, hits = pattern.subn(replacement, text)
        if hits:
            counts[name] = counts.get(name, 0) + hits
    return text, counts


def main():
    parser = argparse.ArgumentParser(
        description="Apply the mechanical wasm rewrites to the vendored uv fork."
    )
    parser.add_argument("--check", action="store_true", help="report without writing")
    args = parser.parse_args()

    totals = {}
    touched = []
    for path in rust_sources():
        original = path.read_text(encoding="utf-8")
        updated, counts = rewrite(original)
        if not counts:
            continue
        touched.append(path)
        for name, hits in counts.items():
            totals[name] = totals.get(name, 0) + hits
        if not args.check:
            path.write_text(updated, encoding="utf-8")

    verb = "would rewrite" if args.check else "rewrote"
    print(f"{verb} {len(touched)} file(s) across {FORK}")
    for name in sorted(totals):
        print(f"  {name}: {totals[name]} occurrence(s)")

    if args.check and touched:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
