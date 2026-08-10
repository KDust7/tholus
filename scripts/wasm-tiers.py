import argparse
import collections
import json
import pathlib
import subprocess
import sys

FORK = pathlib.Path(__file__).resolve().parent.parent / "vendor" / "uv"
TARGET = "wasm32-unknown-unknown"


def cargo_metadata(manifest):
    result = subprocess.run(
        [
            "cargo",
            "metadata",
            "--format-version",
            "1",
            "--filter-platform",
            TARGET,
            "--manifest-path",
            str(manifest),
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    if result.returncode != 0:
        sys.stderr.write(result.stderr)
        return None
    return json.loads(result.stdout)


def workspace_tiers(meta, root_name):
    members = set(meta["workspace_members"])
    names = {package["id"]: package["name"] for package in meta["packages"]}
    nodes = {node["id"]: node for node in meta["resolve"]["nodes"]}

    def workspace_dependencies(package_id):
        return {dep["pkg"] for dep in nodes[package_id]["deps"] if dep["pkg"] in members}

    roots = [package_id for package_id in members if names[package_id] == root_name]
    if not roots:
        return None

    order = []
    seen = set()
    stack = [(roots[0], False)]
    while stack:
        package_id, expanded = stack.pop()
        if expanded:
            order.append(package_id)
            continue
        if package_id in seen:
            continue
        seen.add(package_id)
        stack.append((package_id, True))
        for dependency in sorted(workspace_dependencies(package_id), key=lambda i: names[i]):
            if dependency not in seen:
                stack.append((dependency, False))

    depth = {}
    for package_id in order:
        dependencies = [d for d in workspace_dependencies(package_id) if d in depth]
        depth[package_id] = 1 + max(depth[d] for d in dependencies) if dependencies else 0

    tiers = collections.defaultdict(list)
    for package_id in order:
        tiers[depth[package_id]].append(names[package_id])
    return tiers


def main():
    parser = argparse.ArgumentParser(
        description=f"Print the fork's workspace crates in {TARGET} dependency order."
    )
    parser.add_argument("--root", default="uv", help="the crate to walk down from")
    args = parser.parse_args()

    manifest = FORK / "Cargo.toml"
    if not manifest.is_file():
        print(f"no fork at {FORK}", file=sys.stderr)
        return 1

    meta = cargo_metadata(manifest)
    if meta is None:
        return 1

    tiers = workspace_tiers(meta, args.root)
    if tiers is None:
        print(f"{args.root} is not a workspace member", file=sys.stderr)
        return 1

    total = sum(len(names) for names in tiers.values())
    print(f"{total} workspace crates reachable from `{args.root}` on {TARGET}")
    for tier in sorted(tiers):
        print(f"  tier {tier:2d}  {' '.join(sorted(tiers[tier]))}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
