import argparse
import pathlib
import re
import shutil
import subprocess
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
    (
        "reqwest-reexports-to-http",
        re.compile(r"\breqwest::(header|StatusCode|Method|Version)\b"),
        r"http::\1",
    ),
    ("reqwest-reexport-to-url", re.compile(r"\breqwest::Url\b"), "url::Url"),
    (
        "std-fs-types-to-vfs",
        re.compile(r"\bstd::fs::(Metadata|Permissions|FileType)\b"),
        r"uv_vfs::fs::\1",
    ),
    ("walkdir-to-vfs", re.compile(r"\bwalkdir::"), "uv_vfs::walk::"),
]

REWRITTEN_DEPENDENCIES = {"http::": "http", "web_time::": "web-time"}

EXTRA_WORKSPACE_DEPENDENCIES = [
    ("web-time", 'web-time = { version = "1.1.0", features = ["serde"] }', "which = "),
]

URL_METHODS = re.compile(
    r"\b(?:(?P<owner>[A-Za-z_][A-Za-z0-9_]*)::)?"
    r"(?P<method>from_file_path|to_file_path|from_directory_path)\b"
)

URL_METHOD_OWNERS = {"DisplaySafeUrl": frozenset({"from_file_path"})}
TOKIO_WORKSPACE = re.compile(r'tokio = \{ version = "[^"]+", features = \[[^\]]*\] \}', re.S)

PATH_EXT_IMPORT = "use uv_vfs::VfsPathExt as _;"

PRESENCE_METHODS = (
    "try_exists",
    "exists",
    "is_file",
    "is_dir",
    "symlink_metadata",
    "canonicalize",
    "read_link",
)

PRESENCE_CALL = re.compile(r"\.(vfs_)?(" + "|".join((*PRESENCE_METHODS, "metadata")) + r")\(\)")

NON_PATH_PRODUCERS = frozenset({"file_type", "metadata", "symlink_metadata"})

NON_PATH_RECEIVERS = {
    "is_file": frozenset({"metadata", "file_type", "entry_type", "ty"}),
    "is_dir": frozenset({"metadata", "file_type", "entry_type", "ty"}),
}

CHAIN_ADAPTERS = frozenset({"map_err", "unwrap", "expect", "ok", "unwrap_or_default"})

NON_PATH_BINDINGS = {
    "crates/uv/src/commands/project/mod.rs": frozenset({"link"}),
    "crates/uv/src/commands/python/uninstall.rs": frozenset({"minor_version_link"}),
    "crates/uv-pep508/src/verbatim_url.rs": frozenset({"parsed_scheme"}),
    "crates/uv-virtualenv/src/virtualenv.rs": frozenset({"minor_version_link"}),
}

PATH_METADATA_RECEIVERS = {
    "crates/uv/src/commands/project/run.rs": frozenset({"target_path"}),
    "crates/uv-build-backend/src/wheel.rs": frozenset({"file"}),
    "crates/uv-cache-info/src/cache_info.rs": frozenset({"path"}),
    "crates/uv-client/src/tls.rs": frozenset({"file"}),
    "crates/uv-distribution/src/metadata/lowering.rs": frozenset({"install_path"}),
    "crates/uv-fs/src/lib.rs": frozenset({"path"}),
    "crates/uv-install-wheel/src/linker.rs": frozenset({"absolute"}),
    "crates/uv-pypi-types/src/parsed_url.rs": frozenset({"verbatim_path", "path"}),
    "crates/uv-virtualenv/src/virtualenv.rs": frozenset({"location"}),
}

CFG_TEST_ATTRIBUTE = re.compile(r"#\[cfg\((?:all\()?\s*test\b")

ITEM_ATTRIBUTE = re.compile(r"^#\[cfg\((.*)\)\]$", re.M)
HOST_ONLY_PREDICATES = re.compile(r"\b(unix|windows|target_os|target_env|target_vendor)\b")

CLOSERS = {")": "(", "]": "[", "}": "{"}
RECEIVER_CHARS = frozenset("_.?:")
IDENTIFIER_TAIL = re.compile(r"([A-Za-z_][A-Za-z0-9_]*)\s*$")


def excluded_crates(manifest):
    header = manifest.find("[workspace]")
    if header == -1:
        return frozenset()
    match = re.search(r"exclude\s*=\s*\[(.*?)\]", manifest[header:], re.S)
    return frozenset(re.findall(r'"([^"]+)"', match.group(1))) if match else frozenset()


def crate_dirs():
    crates = FORK / "crates"
    if not crates.is_dir():
        raise SystemExit(f"fork not found at {FORK}; clone it before running this script")
    excluded = excluded_crates((FORK / "Cargo.toml").read_text(encoding="utf-8"))
    for crate_dir in sorted(crates.iterdir()):
        if not crate_dir.is_dir() or crate_dir.name in SHIM_CRATES:
            continue
        if crate_dir.relative_to(FORK).as_posix() in excluded:
            continue
        yield crate_dir


def rust_sources(crate_dir):
    for path in sorted(crate_dir.rglob("*.rs")):
        if "target" not in path.parts:
            yield path


def runs_on_the_build_host(path, crate_dir):
    return path.parent == crate_dir and path.name == "build.rs"


def runs_only_on_the_host(path):
    return not {"tests", "benches", "examples"}.isdisjoint(path.parts)


def apply_source_rules(text):
    counts = {}
    for name, pattern, replacement in SOURCE_RULES:
        text, hits = pattern.subn(replacement, text)
        if hits:
            counts[name] = counts.get(name, 0) + hits
    return text, counts


def end_of_last_use_statement(lines):
    insert_at = None
    inside = False
    depth = 0
    for index, line in enumerate(lines):
        if not inside:
            if not line.startswith("use "):
                continue
            inside = True
            depth = 0
        depth += line.count("{") - line.count("}")
        if depth <= 0 and line.rstrip().endswith(";"):
            inside = False
            insert_at = index + 1
    return insert_at


def insert_import(text, statement):
    lines = text.splitlines()
    insert_at = end_of_last_use_statement(lines)
    if insert_at is None:
        for index, line in enumerate(lines):
            stripped = line.strip()
            if stripped and not stripped.startswith(("//", "#!", "#[")):
                insert_at = index
                break
    if insert_at is None:
        insert_at = len(lines)

    lines[insert_at:insert_at] = statement.splitlines()
    return "\n".join(lines) + ("\n" if text.endswith("\n") else "")


def needs_the_url_trait(match):
    owned = URL_METHOD_OWNERS.get(match.group("owner"), frozenset())
    return match.group("method") not in owned


def url_methods_reach_wasm(text):
    unit_tests_at = unit_test_tail(text)
    return any(
        match.start() < unit_tests_at
        and not gated_off_wasm(text, match.start())
        and needs_the_url_trait(match)
        for match in URL_METHODS.finditer(text)
    )


def inject_url_import(text, host_only):
    stripped = text.replace(URL_IMPORT + "\n", "")
    if "UrlFilePathExt" in stripped:
        return text, 0
    if host_only or not url_methods_reach_wasm(stripped):
        return stripped, 0
    return insert_import(stripped, URL_IMPORT), 1


def receiver_before(text, end):
    index = end
    stack = []
    consumed = False
    while index > 0:
        char = text[index - 1]
        if char in CLOSERS:
            stack.append(CLOSERS[char])
            index -= 1
            consumed = True
            continue
        if char in "([{":
            if not stack or stack[-1] != char:
                break
            stack.pop()
            index -= 1
            continue
        if stack:
            index -= 1
            continue
        if char.isalnum() or char in RECEIVER_CHARS:
            index -= 1
            consumed = True
            continue
        if char.isspace():
            run = index
            while run > 0 and text[run - 1].isspace():
                run -= 1
            before = text[run - 1] if run else ""
            if consumed and (before.isalnum() or before == "_"):
                break
            index = run
            continue
        break
    return text[index:end].strip()


def matching_close(text, opened_at):
    depth = 0
    for index in range(opened_at, len(text)):
        char = text[index]
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return index
    return None


def unit_test_tail(text):
    for match in CFG_TEST_ATTRIBUTE.finditer(text):
        index = match.start()
        while True:
            if not CFG_TEST_ATTRIBUTE.match(text, index):
                break
            opened_at = text.find("{", index)
            if opened_at == -1:
                break
            closed_at = matching_close(text, opened_at)
            if closed_at is None:
                break
            index = closed_at + 1
            while index < len(text) and text[index].isspace():
                index += 1
            if index >= len(text):
                return match.start()
    return len(text)


def gated_off_wasm(text, offset):
    previous_item = text.rfind("\n}", 0, offset)
    start = 0 if previous_item == -1 else previous_item + 1
    for match in ITEM_ATTRIBUTE.finditer(text, start, offset):
        predicate = match.group(1)
        if "wasm" in predicate:
            return False
        if HOST_ONLY_PREDICATES.search(predicate):
            return True
    return False


def matching_open(text):
    depth = 0
    for index in range(len(text) - 1, -1, -1):
        char = text[index]
        if char in CLOSERS:
            depth += 1
        elif char in "([{":
            depth -= 1
            if depth == 0:
                return index
    return None


def receiver_head(receiver):
    text = receiver
    while True:
        text = text.rstrip()
        if text.endswith("?"):
            text = text[:-1]
            continue
        if not text.endswith(")"):
            break
        open_at = matching_open(text)
        if open_at is None:
            return None, False
        name = IDENTIFIER_TAIL.search(text[:open_at])
        if name is None:
            return None, False
        if name.group(1) not in CHAIN_ADAPTERS:
            return name.group(1).removeprefix("vfs_"), True
        text = text[: name.start(1)].rstrip().rstrip(".")
    found = IDENTIFIER_TAIL.search(text)
    return (found.group(1), False) if found else (None, False)


def rewrite_presence_checks(text, relative):
    allowed_metadata = PATH_METADATA_RECEIVERS.get(relative, frozenset())
    denied = NON_PATH_BINDINGS.get(relative, frozenset())
    unit_tests_at = unit_test_tail(text)
    pieces = []
    cursor = 0
    rewritten = 0
    host_only = 0
    accepted = set()
    skipped = []

    for match in PRESENCE_CALL.finditer(text):
        if match.start() >= unit_tests_at or gated_off_wasm(text, match.start()):
            host_only += 1
            continue
        method = match.group(2)
        head, from_call = receiver_head(receiver_before(text, match.start()))
        if match.group(1):
            accepted.add((relative, head))
            continue
        if head in denied:
            accepted.add((relative, head))
            wanted = False
        elif method == "metadata":
            wanted = head in allowed_metadata
        elif from_call:
            wanted = head not in NON_PATH_PRODUCERS
        else:
            wanted = head not in NON_PATH_RECEIVERS.get(method, frozenset())
        if not wanted:
            skipped.append((method, head))
            continue
        accepted.add((relative, head))
        pieces.append(text[cursor : match.start()])
        pieces.append(f".vfs_{method}()")
        cursor = match.end()
        rewritten += 1

    if not rewritten:
        return text, 0, accepted, skipped, host_only

    pieces.append(text[cursor:])
    text = "".join(pieces)
    if "VfsPathExt" not in text:
        text = insert_import(text, PATH_EXT_IMPORT)
    return text, rewritten, accepted, skipped, host_only


def ensure_crate_dependencies(crate_dir, needed, section="dependencies"):
    manifest = crate_dir / "Cargo.toml"
    if not manifest.is_file() or not needed:
        return 0
    text = manifest.read_text(encoding="utf-8")
    header = f"[{section}]\n"
    if header not in text:
        return 0

    added = 0
    for crate_name in sorted(needed):
        if re.search(rf"^{re.escape(crate_name)} = ", text, re.M):
            continue
        text = text.replace(header, f"{header}{crate_name} = {{ workspace = true }}\n", 1)
        added += 1
    if added:
        manifest.write_text(text, encoding="utf-8")
    return added


REPLACED_DEPENDENCIES = {
    "fs-err": re.compile(r"\bfs_err\b"),
    "tempfile": re.compile(r"\btempfile\b"),
    "walkdir": re.compile(r"\bwalkdir::"),
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
        kept = []
        for line in text.splitlines():
            if line.startswith(f"{dependency} =") and line.rstrip().endswith("}"):
                continue
            kept.append(line)
        text = "\n".join(kept) + ("\n" if text.endswith("\n") else "")

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

    for crate_name, entry, extra_anchor in EXTRA_WORKSPACE_DEPENDENCIES:
        if f"\n{crate_name} = " in text:
            continue
        position = text.find(extra_anchor)
        if position == -1:
            continue
        text = f"{text[:position]}{entry}\n{text[position:]}"
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


def find_rustfmt():
    found = shutil.which("rustfmt")
    if found:
        return found
    for candidate in (
        pathlib.Path.home() / ".cargo" / "bin" / "rustfmt.exe",
        pathlib.Path.home() / ".cargo" / "bin" / "rustfmt",
    ):
        if candidate.is_file():
            return str(candidate)
    return None


def parse_failures(paths):
    rustfmt = find_rustfmt()
    if rustfmt is None:
        return None

    failures = []
    for path in sorted(paths):
        result = subprocess.run(
            [rustfmt, "--edition", "2024", "--emit", "stdout", str(path)],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        for line in result.stderr.splitlines():
            if line.startswith("error"):
                failures.append((path, line))
                break
    return failures


def report_presence_residue(residue, hits):
    if residue:
        print(f"  presence checks left on non-path receivers: {sum(residue.values())}")
        for (method, head), count in sorted(residue.items(), key=lambda item: (-item[1], item[0])):
            print(f"    {count:4d}  {head}.{method}()")

    declared = {
        (relative, token)
        for table in (PATH_METADATA_RECEIVERS, NON_PATH_BINDINGS)
        for relative, tokens in table.items()
        for token in tokens
    }
    for relative, token in sorted(declared - hits):
        print(f"  no `{token}` receiver left in {relative}; drop it from the table")


def main():
    parser = argparse.ArgumentParser(
        description="Apply the mechanical wasm rewrites to the vendored uv fork."
    )
    parser.add_argument("--check", action="store_true", help="report without writing")
    args = parser.parse_args()

    totals = {}
    touched = set()
    metadata_hits = set()
    residue = {}

    for crate_dir in crate_dirs():
        needed = set()
        needed_by_host_only_targets = set()
        for path in rust_sources(crate_dir):
            if runs_on_the_build_host(path, crate_dir):
                continue
            original = path.read_text(encoding="utf-8")
            updated, counts = apply_source_rules(original)
            updated, injected = inject_url_import(updated, runs_only_on_the_host(path))
            if injected:
                counts["url-extension-import"] = injected
            if not runs_only_on_the_host(path):
                updated, rewritten, accepted, skipped, host_only = rewrite_presence_checks(
                    updated, path.relative_to(FORK).as_posix()
                )
                if rewritten:
                    counts["path-extension-call"] = rewritten
                if host_only:
                    totals["left-in-host-only-code"] = (
                        totals.get("left-in-host-only-code", 0) + host_only
                    )
                metadata_hits |= accepted
                for entry in skipped:
                    residue[entry] = residue.get(entry, 0) + 1
            wanted = needed_by_host_only_targets if runs_only_on_the_host(path) else needed
            for marker, (crate_name, _) in SHIM_DEPENDENCIES.items():
                if marker in updated:
                    wanted.add(crate_name)
            for marker, crate_name in REWRITTEN_DEPENDENCIES.items():
                if marker in updated:
                    wanted.add(crate_name)
            if updated == original:
                continue
            touched.add(path)
            for name, hits in counts.items():
                totals[name] = totals.get(name, 0) + hits
            if not args.check:
                path.write_text(updated, encoding="utf-8")

        if not args.check:
            added = ensure_crate_dependencies(crate_dir, needed)
            added += ensure_crate_dependencies(
                crate_dir, needed_by_host_only_targets - needed, "dev-dependencies"
            )
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

    report_presence_residue(residue, metadata_hits)

    if not args.check and touched:
        failures = parse_failures(touched)
        if failures is None:
            print("  rustfmt not found; skipped the parse check")
        elif failures:
            print(f"  {len(failures)} rewritten file(s) no longer parse:")
            for path, message in failures:
                print(f"    {path.relative_to(FORK)}: {message}")
            return 1
        else:
            print(f"  parse check: {len(touched)} file(s) still parse")

    return 1 if args.check and touched else 0


if __name__ == "__main__":
    sys.exit(main())
