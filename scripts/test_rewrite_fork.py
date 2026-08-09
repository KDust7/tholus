import importlib.util
import pathlib
import shutil
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location(
    "rewrite_fork", pathlib.Path(__file__).resolve().parent / "rewrite-fork.py"
)
rewrite_fork = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(rewrite_fork)

TLS = "crates/uv-client/src/tls.rs"


def head_of(source):
    call = source.rindex(".")
    return rewrite_fork.receiver_head(rewrite_fork.receiver_before(source, call))


class ReceiverHead(unittest.TestCase):
    def test_a_bare_binding_is_read_as_a_name(self):
        self.assertEqual(head_of("if executable.exists()"), ("executable", False))

    def test_a_chain_broken_over_lines_finds_its_receiver(self):
        source = "        let metadata = file\n            .metadata()"
        self.assertEqual(head_of(source), ("file", False))

    def test_a_leading_keyword_is_not_absorbed_into_the_receiver(self):
        self.assertEqual(head_of("let metadata = match path.metadata()"), ("path", False))

    def test_a_reference_resolves_to_the_thing_referenced(self):
        self.assertEqual(head_of("Timestamp::from_metadata(&path.metadata()"), ("path", False))

    def test_adapters_are_stripped_to_reach_the_producing_call(self):
        source = "if sibling\n    .file_type()\n    .map_err(Error::CacheRead)?\n    .is_dir()"
        self.assertEqual(head_of(source), ("file_type", True))

    def test_a_try_operator_does_not_hide_the_producing_call(self):
        self.assertEqual(head_of("if entry.file_type()?.is_file()"), ("file_type", True))

    def test_a_constructor_is_read_as_a_call(self):
        self.assertEqual(head_of("if Path::new(&name).is_file()"), ("new", True))

    def test_a_free_function_receiver_is_read_as_a_call(self):
        source = "if !uv_vfs::fs::symlink_metadata(location)?.is_dir()"
        self.assertEqual(head_of(source), ("symlink_metadata", True))

    def test_an_already_rewritten_producer_is_judged_the_same_way(self):
        self.assertEqual(head_of("if path.vfs_metadata()?.is_file()"), ("metadata", True))

    def test_a_join_keeps_the_expression_a_path(self):
        source = 'if site_packages.join(&target_path).exists()'
        self.assertEqual(head_of(source), ("join", True))


def rewrite(source, relative="crates/uv-demo/src/lib.rs"):
    text, count, _, skipped, _ = rewrite_fork.rewrite_presence_checks(source, relative)
    return text, count, skipped


PRODUCTION_AFTER_A_TEST_HELPER = (
    "#[cfg(test)]\n"
    "fn helper() {}\n"
    "\n"
    "pub fn real(p: &Path) -> bool {\n"
    "    p.exists()\n"
    "}\n"
    "\n"
    "#[cfg(test)]\n"
    "mod tests {\n"
    "    fn t(p: &Path) {\n"
    "        assert!(p.exists());\n"
    "    }\n"
    "}\n"
)


class UnitTestTail(unittest.TestCase):
    def test_a_trailing_test_module_is_found(self):
        source = "fn a() {}\n\n#[cfg(test)]\nmod tests {\n    fn b() {}\n}\n"
        self.assertEqual(rewrite_fork.unit_test_tail(source), source.index("#[cfg(test)]"))

    def test_a_file_without_tests_has_no_tail(self):
        source = "fn a() {}\n"
        self.assertEqual(rewrite_fork.unit_test_tail(source), len(source))

    def test_a_gated_test_module_is_found(self):
        source = 'fn a() {}\n\n#[cfg(all(test, not(target_family = "wasm")))]\nmod t {\n}\n'
        self.assertEqual(rewrite_fork.unit_test_tail(source), source.index("#[cfg"))

    def test_consecutive_test_modules_count_as_one_tail(self):
        source = "fn a() {}\n\n#[cfg(test)]\nmod t1 {\n}\n\n#[cfg(test)]\nmod t2 {\n}\n"
        self.assertEqual(rewrite_fork.unit_test_tail(source), source.index("#[cfg"))

    def test_a_test_helper_followed_by_production_code_is_not_the_tail(self):
        tail = rewrite_fork.unit_test_tail(PRODUCTION_AFTER_A_TEST_HELPER)
        self.assertEqual(tail, PRODUCTION_AFTER_A_TEST_HELPER.index("#[cfg(test)]\nmod tests"))

    def test_production_code_after_a_test_helper_is_still_rewritten(self):
        text, count, _ = rewrite(PRODUCTION_AFTER_A_TEST_HELPER)
        self.assertEqual(count, 1)
        self.assertIn("pub fn real(p: &Path) -> bool {\n    p.vfs_exists()", text)
        self.assertIn("assert!(p.exists());", text)

    def test_a_test_only_file_gains_no_import(self):
        source = "fn a() {}\n\n#[cfg(test)]\nmod tests {\n    fn b(p: &Path) { p.exists(); }\n}\n"
        text, count, _ = rewrite(source)
        self.assertEqual((count, text), (0, source))


class PresenceRewrite(unittest.TestCase):
    def test_a_path_predicate_is_routed_through_the_extension_trait(self):
        text, count, _ = rewrite("use std::path::Path;\n\nfn f(p: &Path) -> bool { p.exists() }\n")
        self.assertEqual(count, 1)
        self.assertIn("p.vfs_exists()", text)

    def test_the_import_lands_after_the_last_use_statement(self):
        text, _, _ = rewrite("use std::path::Path;\n\nfn f(p: &Path) -> bool { p.exists() }\n")
        lines = text.splitlines()
        self.assertEqual(lines[0], "use std::path::Path;")
        self.assertEqual(lines[1], rewrite_fork.PATH_EXT_IMPORT)

    def test_the_import_clears_a_use_statement_spread_over_lines(self):
        source = (
            "use crate::{\n"
            "    Alpha,\n"
            "    Beta,\n"
            "};\n"
            "\n"
            "fn f(p: &Path) -> bool { p.exists() }\n"
        )
        text, _, _ = rewrite(source)
        lines = text.splitlines()
        self.assertEqual(lines[3], "};")
        self.assertEqual(lines[4], rewrite_fork.PATH_EXT_IMPORT)

    def test_a_metadata_receiver_keeps_its_inherent_predicates(self):
        text, count, skipped = rewrite("if metadata.is_dir() { }\n")
        self.assertEqual(count, 0)
        self.assertEqual(skipped, [("is_dir", "metadata")])
        self.assertNotIn("vfs_", text)

    def test_a_binding_named_metadata_is_still_a_path_for_presence(self):
        text, count, _ = rewrite("assert!(!metadata.exists());\n")
        self.assertEqual(count, 1)
        self.assertIn("metadata.vfs_exists()", text)

    def test_a_file_type_receiver_is_left_alone(self):
        _, count, skipped = rewrite("if entry.file_type()?.is_dir() { }\n")
        self.assertEqual(count, 0)
        self.assertEqual(skipped, [("is_dir", "file_type")])

    def test_metadata_is_rewritten_only_where_the_table_names_the_receiver(self):
        source = "let m = file.metadata()?;\n"
        _, listed, _ = rewrite(source, TLS)
        _, unlisted, _ = rewrite(source)
        self.assertEqual((listed, unlisted), (1, 0))

    def test_an_unlisted_receiver_in_a_listed_file_is_left_alone(self):
        _, count, skipped = rewrite("let m = entry.metadata()?;\n", TLS)
        self.assertEqual(count, 0)
        self.assertEqual(skipped, [("metadata", "entry")])

    def test_rewriting_twice_changes_nothing_the_second_time(self):
        once, _, _ = rewrite("use std::path::Path;\n\nfn f(p: &Path) -> bool { p.exists() }\n")
        twice, count, _ = rewrite(once)
        self.assertEqual(count, 0)
        self.assertEqual(twice, once)

    def test_a_chained_metadata_predicate_survives_a_second_run(self):
        cache_info = "crates/uv-cache-info/src/cache_info.rs"
        once, first, _ = rewrite("let ok = path.metadata()?.is_file();\n", cache_info)
        twice, second, _ = rewrite(once, cache_info)
        self.assertEqual((first, second), (1, 0))
        self.assertIn("path.vfs_metadata()?.is_file()", twice)

    def test_a_uv_type_that_shadows_the_predicate_keeps_its_own_method(self):
        source = "if minor_version_link.exists() { }\n"
        _, listed, skipped = rewrite(source, "crates/uv-virtualenv/src/virtualenv.rs")
        _, elsewhere, _ = rewrite(source)
        self.assertEqual((listed, elsewhere), (0, 1))
        self.assertEqual(skipped, [("exists", "minor_version_link")])

    def test_a_shadowed_receiver_vouches_for_its_table_entry(self):
        relative = "crates/uv-pep508/src/verbatim_url.rs"
        _, _, accepted, *_ = rewrite_fork.rewrite_presence_checks(
            "return parsed_scheme.is_file();\n", relative
        )
        self.assertIn((relative, "parsed_scheme"), accepted)

    def test_an_already_rewritten_site_still_vouches_for_its_table_entry(self):
        _, _, accepted, *_ = rewrite_fork.rewrite_presence_checks("file.vfs_metadata()?;\n", TLS)
        self.assertIn((TLS, "file"), accepted)


class CrateDependencies(unittest.TestCase):
    def manifest(self, body):
        directory = pathlib.Path(tempfile.mkdtemp())
        (directory / "Cargo.toml").write_text(body, encoding="utf-8")
        self.addCleanup(shutil.rmtree, directory, True)
        return directory

    def test_a_bench_only_marker_lands_in_dev_dependencies(self):
        crate = self.manifest("[package]\nname = \"uv-bench\"\n\n[dev-dependencies]\nanyhow = { workspace = true }\n")
        added = rewrite_fork.ensure_crate_dependencies(crate, {"uv-vfs"}, "dev-dependencies")
        text = (crate / "Cargo.toml").read_text(encoding="utf-8")
        self.assertEqual(added, 1)
        self.assertIn("[dev-dependencies]\nuv-vfs = { workspace = true }\n", text)

    def test_dev_dependencies_are_not_confused_with_dependencies(self):
        crate = self.manifest("[package]\nname = \"uv-bench\"\n\n[dev-dependencies]\n")
        self.assertEqual(rewrite_fork.ensure_crate_dependencies(crate, {"uv-vfs"}), 0)

    def test_a_marker_already_declared_is_not_added_twice(self):
        crate = self.manifest("[dependencies]\nuv-vfs = { workspace = true }\n")
        self.assertEqual(rewrite_fork.ensure_crate_dependencies(crate, {"uv-vfs"}), 0)


class ExcludedCrates(unittest.TestCase):
    def test_the_workspace_exclude_list_is_read(self):
        manifest = (
            "[workspace]\n"
            'members = ["crates/*"]\n'
            "exclude = [\n"
            '  "scripts",\n'
            "  # Needs nightly\n"
            '  "crates/uv-trampoline",\n'
            "]\n"
        )
        self.assertEqual(
            rewrite_fork.excluded_crates(manifest), {"scripts", "crates/uv-trampoline"}
        )

    def test_a_workspace_without_an_exclude_list_excludes_nothing(self):
        self.assertEqual(rewrite_fork.excluded_crates('[workspace]\nmembers = ["a"]\n'), frozenset())


@unittest.skipUnless((rewrite_fork.FORK / "crates").is_dir(), "the fork is not checked out")
class ForkLayout(unittest.TestCase):
    def test_the_excluded_crates_are_never_rewritten(self):
        excluded = rewrite_fork.excluded_crates(
            (rewrite_fork.FORK / "Cargo.toml").read_text(encoding="utf-8")
        )
        self.assertIn("crates/uv-trampoline", excluded)
        visited = {crate.relative_to(rewrite_fork.FORK).as_posix() for crate in rewrite_fork.crate_dirs()}
        self.assertEqual(visited & excluded, set())


@unittest.skipUnless((rewrite_fork.FORK / "crates").is_dir(), "the fork is not checked out")
class MetadataTable(unittest.TestCase):
    def test_every_listed_file_is_in_the_fork(self):
        missing = [
            relative
            for table in (rewrite_fork.PATH_METADATA_RECEIVERS, rewrite_fork.NON_PATH_BINDINGS)
            for relative in table
            if not (rewrite_fork.FORK / relative).is_file()
        ]
        self.assertEqual(missing, [])


if __name__ == "__main__":
    unittest.main()
