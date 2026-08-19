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
    def test_is_absolute_is_routed_through_the_extension_trait(self):
        text, count, _ = rewrite("fn f(p: &Path) -> bool { p.is_absolute() }\n")
        self.assertEqual(count, 1)
        self.assertIn("p.vfs_is_absolute()", text)

    def test_is_relative_is_routed_through_the_extension_trait(self):
        text, count, _ = rewrite("fn f(p: &Path) -> bool { p.is_relative() }\n")
        self.assertEqual(count, 1)
        self.assertIn("p.vfs_is_relative()", text)

    def test_an_absoluteness_check_in_the_test_tail_is_left_alone(self):
        source = "#[cfg(test)]\nmod tests {\n    fn t(p: &Path) { assert!(p.is_absolute()); }\n}\n"
        text, count, _ = rewrite(source)
        self.assertEqual(count, 0)
        self.assertEqual(text, source)

    def test_the_absoluteness_rewrite_is_idempotent(self):
        once, _, _ = rewrite("fn f(p: &Path) -> bool { p.is_absolute() }\n")
        twice, count, _ = rewrite(once)
        self.assertEqual(count, 0)
        self.assertEqual(twice, once)

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


class SourceRules(unittest.TestCase):
    def rewrite(self, source):
        text, counts = rewrite_fork.apply_source_rules(source)
        return text, counts

    def test_walkdir_paths_route_through_the_shim(self):
        text, counts = self.rewrite("use walkdir::WalkDir;\n\nfn f() -> walkdir::Error { todo!() }\n")
        self.assertEqual(counts.get("walkdir-to-vfs"), 2)
        self.assertIn("use uv_vfs::walk::WalkDir;", text)
        self.assertIn("uv_vfs::walk::Error", text)

    def test_a_bare_walkdir_word_is_left_alone(self):
        source = "// walkdir is fast\nlet walkdir_root = 1;\n"
        self.assertEqual(self.rewrite(source), (source, {}))

    def test_the_walkdir_rule_is_idempotent(self):
        once, _ = self.rewrite("use walkdir::WalkDir;\n")
        twice, counts = self.rewrite(once)
        self.assertEqual(twice, once)
        self.assertNotIn("walkdir-to-vfs", counts)

    def test_glob_paths_route_through_the_shim(self):
        text, counts = self.rewrite(
            "use glob::{GlobError, Pattern, glob};\n\nlet p = glob::Pattern::escape(root);\n"
        )
        self.assertEqual(counts.get("glob-to-vfs"), 2)
        self.assertIn("use uv_vfs::glob::{GlobError, Pattern, glob};", text)
        self.assertIn("uv_vfs::glob::Pattern::escape", text)

    def test_uvs_own_glob_module_is_left_alone(self):
        source = "use crate::glob::cluster_globs;\nmod glob;\nlet globs = 1;\n"
        self.assertEqual(self.rewrite(source), (source, {}))

    def test_the_glob_rule_is_idempotent(self):
        once, _ = self.rewrite("use glob::{Pattern, glob};\n")
        twice, counts = self.rewrite(once)
        self.assertEqual(twice, once)
        self.assertNotIn("glob-to-vfs", counts)

    def test_a_stdin_read_routes_through_the_shim(self):
        text, counts = self.rewrite("std::io::stdin().read_to_end(&mut buf)?;\n")
        self.assertEqual(counts.get("std-stdin-to-compat"), 1)
        self.assertIn("uv_wasm_compat::stdin().read_to_end(&mut buf)?;", text)

    def test_a_terminal_check_keeps_the_host_stdin(self):
        source = "let interactive = std::io::stdin().is_terminal();\n"
        self.assertEqual(self.rewrite(source), (source, {}))

    def test_the_stdin_rule_is_idempotent(self):
        once, _ = self.rewrite("std::io::stdin().read_line(&mut input)?;\n")
        twice, counts = self.rewrite(once)
        self.assertEqual(twice, once)
        self.assertNotIn("std-stdin-to-compat", counts)

    def test_absolute_routes_through_the_vfs(self):
        text, counts = self.rewrite("let root = std::path::absolute(cache.root())?;\n")
        self.assertEqual(counts.get("std-absolute-to-vfs"), 1)
        self.assertIn("uv_vfs::absolute(cache.root())", text)

    def test_a_bare_path_absolute_routes_through_the_vfs(self):
        text, counts = self.rewrite("let install = path::absolute(install_path)?;\n")
        self.assertEqual(counts.get("path-absolute-to-vfs"), 1)
        self.assertIn("uv_vfs::absolute(install_path)", text)

    def test_a_qualified_absolute_is_counted_once(self):
        _, counts = self.rewrite("std::path::absolute(a)?;\n")
        self.assertEqual(counts.get("std-absolute-to-vfs"), 1)
        self.assertNotIn("path-absolute-to-vfs", counts)

    def test_an_unrelated_absolute_is_left_alone(self):
        source = "let my_path = 1;\nself.absolute();\nlet other_path_absolute = 2;\n"
        self.assertEqual(self.rewrite(source), (source, {}))

    def test_the_path_import_goes_when_the_rewrite_leaves_it_unused(self):
        text, counts = self.rewrite("use std::path;\n\nfn f() { path::absolute(a); }\n")
        self.assertEqual(counts.get("unused-path-import"), 1)
        self.assertNotIn("use std::path;", text)
        self.assertIn("uv_vfs::absolute(a)", text)

    def test_a_fully_qualified_path_does_not_keep_the_import_alive(self):
        text, counts = self.rewrite(
            "use std::path;\n\nfn f(p: std::path::PathBuf) { path::absolute(p); }\n"
        )
        self.assertEqual(counts.get("unused-path-import"), 1)
        self.assertNotIn("use std::path;", text)

    def test_the_path_import_stays_when_something_else_needs_it(self):
        text, counts = self.rewrite(
            "use std::path;\n\nfn f() -> path::PathBuf { path::absolute(a) }\n"
        )
        self.assertNotIn("unused-path-import", counts)
        self.assertIn("use std::path;", text)

    def test_the_absolute_rule_is_idempotent(self):
        once, _ = self.rewrite("std::path::absolute(a)?;\npath::absolute(b)?;\n")
        twice, counts = self.rewrite(once)
        self.assertEqual(twice, once)
        self.assertNotIn("std-absolute-to-vfs", counts)
        self.assertNotIn("path-absolute-to-vfs", counts)

    def test_temp_dir_routes_through_the_vfs(self):
        text, counts = self.rewrite('let lock = std::env::temp_dir().join("uv.lock");\n')
        self.assertEqual(counts.get("std-env-paths-to-vfs"), 1)
        self.assertIn('uv_vfs::temp_dir().join("uv.lock")', text)

    def test_a_bare_temp_dir_routes_through_the_vfs(self):
        text, counts = self.rewrite('let lock = env::temp_dir().join("uv.lock");\n')
        self.assertEqual(counts.get("env-paths-to-vfs"), 1)
        self.assertIn('uv_vfs::temp_dir().join("uv.lock")', text)

    def test_split_paths_routes_through_the_vfs(self):
        text, counts = self.rewrite("let dirs = env::split_paths(&search_path).collect();\n")
        self.assertEqual(counts.get("env-paths-to-vfs"), 1)
        self.assertIn("uv_vfs::split_paths(&search_path)", text)

    def test_a_home_dir_import_routes_through_the_vfs(self):
        text, counts = self.rewrite("use std::env::home_dir;\n")
        self.assertEqual(counts.get("std-env-paths-to-vfs"), 1)
        self.assertEqual(text, "use uv_vfs::home_dir;\n")

    def test_a_qualified_env_path_helper_is_counted_once(self):
        _, counts = self.rewrite("std::env::temp_dir();\n")
        self.assertEqual(counts.get("std-env-paths-to-vfs"), 1)
        self.assertNotIn("env-paths-to-vfs", counts)

    def test_join_paths_is_left_on_std(self):
        source = "let path = env::join_paths(dirs)?;\n"
        self.assertEqual(self.rewrite(source), (source, {}))

    def test_env_constants_are_left_alone(self):
        source = "env::consts::EXE_SUFFIX;\nenv::consts::ARCH;\n"
        self.assertEqual(self.rewrite(source), (source, {}))

    def test_a_variable_read_routes_through_the_vfs(self):
        text, counts = self.rewrite("let home = std::env::var(EnvVars::HOME)?;\n")
        self.assertEqual(counts.get("std-env-vars-to-vfs"), 1)
        self.assertIn("uv_vfs::var(EnvVars::HOME)?", text)

    def test_a_bare_variable_read_routes_through_the_vfs(self):
        text, counts = self.rewrite("let home = env::var(EnvVars::HOME)?;\n")
        self.assertEqual(counts.get("env-vars-to-vfs"), 1)
        self.assertIn("uv_vfs::var(EnvVars::HOME)?", text)

    def test_var_os_routes_through_the_vfs(self):
        text, counts = self.rewrite("let path = env::var_os(EnvVars::PATH);\n")
        self.assertEqual(counts.get("env-vars-to-vfs"), 1)
        self.assertIn("uv_vfs::var_os(EnvVars::PATH)", text)

    def test_a_qualified_variable_read_is_counted_once(self):
        _, counts = self.rewrite("std::env::var_os(name);\n")
        self.assertEqual(counts.get("std-env-vars-to-vfs"), 1)
        self.assertNotIn("env-vars-to-vfs", counts)

    def test_vars_is_left_on_std_because_nothing_calls_it(self):
        source = "for (key, value) in env::vars() {}\n"
        self.assertEqual(self.rewrite(source), (source, {}))

    def test_set_var_is_left_on_std(self):
        source = "unsafe { std::env::set_var(EnvVars::UV, current_exe) };\n"
        self.assertEqual(self.rewrite(source), (source, {}))

    def test_a_rewritten_variable_read_is_not_rewritten_again(self):
        once, _ = self.rewrite("env::var(EnvVars::HOME);\n")
        twice, counts = self.rewrite(once)
        self.assertEqual(twice, once)
        self.assertEqual(counts, {})

    def test_current_dir_routes_through_the_vfs(self):
        text, counts = self.rewrite("options.relative_to(&std::env::current_dir()?)\n")
        self.assertEqual(counts.get("std-current-dir-to-vfs"), 1)
        self.assertIn("uv_vfs::current_dir()?", text)

    def test_a_bare_current_dir_routes_through_the_vfs(self):
        text, counts = self.rewrite("options.relative_to(&env::current_dir()?)\n")
        self.assertEqual(counts.get("env-current-dir-to-vfs"), 1)
        self.assertIn("uv_vfs::current_dir()?", text)

    def test_set_current_dir_routes_through_uv_fs(self):
        text, counts = self.rewrite("std::env::set_current_dir(directory)?;\n")
        self.assertEqual(counts.get("std-set-current-dir-to-fs"), 1)
        self.assertIn("uv_fs::set_current_dir(directory)?;", text)

    def test_setting_the_directory_is_not_read_as_reading_it(self):
        _, counts = self.rewrite("env::set_current_dir(directory)?;\n")
        self.assertEqual(counts.get("env-set-current-dir-to-fs"), 1)
        self.assertNotIn("env-current-dir-to-vfs", counts)

    def test_the_working_directory_rules_are_idempotent(self):
        once, _ = self.rewrite("std::env::current_dir()?;\nenv::set_current_dir(d)?;\n")
        twice, counts = self.rewrite(once)
        self.assertEqual(twice, once)
        self.assertNotIn("std-current-dir-to-vfs", counts)
        self.assertNotIn("env-set-current-dir-to-fs", counts)

    def test_the_env_import_goes_when_the_rewrite_leaves_it_unused(self):
        text, counts = self.rewrite("use std::env;\n\nfn f() { env::temp_dir(); }\n")
        self.assertEqual(counts.get("unused-env-import"), 1)
        self.assertNotIn("use std::env;", text)
        self.assertIn("uv_vfs::temp_dir()", text)

    def test_a_grouped_env_import_loses_only_its_own_item(self):
        text, counts = self.rewrite("use std::{env, io};\n\nfn f() { env::temp_dir(); }\n")
        self.assertEqual(counts.get("unused-env-import"), 1)
        self.assertIn("use std::io;\n", text)

    def test_a_multi_line_group_keeps_its_shape(self):
        text, counts = self.rewrite(
            "use std::{\n    env,\n    ffi::OsString,\n};\n\nfn f() { env::temp_dir(); }\n"
        )
        self.assertEqual(counts.get("unused-env-import"), 1)
        self.assertIn("use std::{\n    ffi::OsString,\n};\n", text)

    def test_a_shared_line_in_a_group_loses_only_the_stranded_item(self):
        text, counts = self.rewrite(
            "use std::{\n    env, io,\n    path::{Path, PathBuf},\n};\n\nfn f() { env::var(name); }\n"
        )
        self.assertEqual(counts.get("unused-env-import"), 1)
        self.assertIn("    io,\n", text)
        self.assertIn("    path::{Path, PathBuf},\n", text)
        self.assertNotIn("env,", text)

    def test_an_indented_import_is_dropped_when_it_is_stranded(self):
        text, counts = self.rewrite("fn f() {\n    use std::env;\n    env::var(name);\n}\n")
        self.assertEqual(counts.get("unused-env-import"), 1)
        self.assertNotIn("use std::env;", text)

    def test_the_env_import_stays_when_something_else_needs_it(self):
        text, counts = self.rewrite(
            "use std::{env, io};\n\nfn f() { env::temp_dir(); env::join_paths(dirs); }\n"
        )
        self.assertNotIn("unused-env-import", counts)
        self.assertIn("use std::{env, io};", text)

    def test_a_qualified_env_path_does_not_keep_the_import_alive(self):
        text, counts = self.rewrite(
            "use std::env;\nuse std::env::consts::ARCH;\n\nfn f() { env::temp_dir(); }\n"
        )
        self.assertEqual(counts.get("unused-env-import"), 1)
        self.assertIn("use std::env::consts::ARCH;", text)

    def test_the_env_path_rules_are_idempotent(self):
        once, _ = self.rewrite("std::env::temp_dir();\nenv::split_paths(&p);\n")
        twice, counts = self.rewrite(once)
        self.assertEqual(twice, once)
        self.assertNotIn("std-env-paths-to-vfs", counts)
        self.assertNotIn("env-paths-to-vfs", counts)


class UrlImport(unittest.TestCase):
    def inject(self, source, host_only=False):
        return rewrite_fork.inject_url_import(source, host_only)

    def test_production_use_gains_the_guarded_import(self):
        text, count = self.inject("fn f(u: &Url) {\n    u.to_file_path();\n}\n")
        self.assertEqual(count, 1)
        self.assertIn(rewrite_fork.URL_IMPORT, text)

    def test_a_use_confined_to_the_test_tail_gains_nothing(self):
        source = "fn f() {}\n\n#[cfg(test)]\nmod tests {\n    fn t(u: &Url) { u.to_file_path(); }\n}\n"
        self.assertEqual(self.inject(source), (source, 0))

    def test_a_use_gated_off_wasm_gains_nothing(self):
        source = '#[cfg(windows)]\nfn f(u: &Url) {\n    u.to_file_path();\n}\n'
        self.assertEqual(self.inject(source), (source, 0))

    def test_a_host_only_target_gains_nothing(self):
        source = "fn f(u: &Url) {\n    u.to_file_path();\n}\n"
        self.assertEqual(self.inject(source, host_only=True), (source, 0))

    def test_an_import_left_over_from_a_host_only_use_is_stripped(self):
        source = (
            rewrite_fork.URL_IMPORT
            + "\n\n#[cfg(test)]\nmod tests {\n    fn t(u: &Url) { u.to_file_path(); }\n}\n"
        )
        text, count = self.inject(source)
        self.assertEqual(count, 0)
        self.assertNotIn("UrlFilePathExt", text)

    def test_a_hand_placed_import_is_left_alone(self):
        source = "mod m {\n    use uv_vfs::UrlFilePathExt as _;\n    fn f(u: &Url) { u.to_file_path(); }\n}\n"
        self.assertEqual(self.inject(source), (source, 0))

    def test_a_type_owning_the_method_does_not_pull_the_trait_in(self):
        source = "fn f(p: &Path) {\n    let _ = DisplaySafeUrl::from_file_path(p);\n}\n"
        self.assertEqual(self.inject(source), (source, 0))

    def test_a_method_that_type_does_not_own_still_pulls_the_trait_in(self):
        text, count = self.inject("fn f(u: &DisplaySafeUrl) {\n    u.to_file_path();\n}\n")
        self.assertEqual(count, 1)
        self.assertIn(rewrite_fork.URL_IMPORT, text)

    def test_the_plain_url_type_still_pulls_the_trait_in(self):
        text, count = self.inject("fn f(p: &Path) {\n    let _ = Url::from_file_path(p);\n}\n")
        self.assertEqual(count, 1)
        self.assertIn(rewrite_fork.URL_IMPORT, text)

    def test_injection_is_idempotent(self):
        once, _ = self.inject("fn f(u: &Url) {\n    u.to_file_path();\n}\n")
        twice, _ = self.inject(once)
        self.assertEqual(twice, once)
        self.assertEqual(twice.count("UrlFilePathExt"), 1)


class ClockImports(unittest.TestCase):
    def rewrite(self, source):
        return rewrite_fork.apply_source_rules(source)[0]

    def test_a_clock_type_moves_out_of_a_group_and_the_rest_stays(self):
        self.assertEqual(
            self.rewrite("use std::time::{Duration, Instant};"),
            "use std::time::Duration;\nuse web_time::Instant;",
        )

    def test_an_error_type_moves_with_the_clock_it_belongs_to(self):
        self.assertEqual(
            self.rewrite("use std::time::{Duration, SystemTime, SystemTimeError};"),
            "use std::time::Duration;\nuse web_time::{SystemTime, SystemTimeError};",
        )

    def test_a_group_of_only_clock_types_leaves_no_std_import_behind(self):
        self.assertEqual(
            self.rewrite("use std::time::{Instant, SystemTime};"),
            "use web_time::{Instant, SystemTime};",
        )

    def test_a_group_without_a_clock_type_is_untouched(self):
        self.assertEqual(
            self.rewrite("use std::time::{Duration, TryFromFloatSecsError};"),
            "use std::time::{Duration, TryFromFloatSecsError};",
        )

    def test_the_single_import_form_is_covered_by_the_path_rule(self):
        self.assertEqual(
            self.rewrite("use std::time::Instant;"),
            "use web_time::Instant;",
        )

    def test_the_indentation_of_a_nested_import_is_kept(self):
        self.assertEqual(
            self.rewrite("    use std::time::{Duration, Instant};"),
            "    use std::time::Duration;\n    use web_time::Instant;",
        )

    def test_moving_the_import_is_idempotent(self):
        once = self.rewrite("use std::time::{Duration, Instant};")
        self.assertEqual(self.rewrite(once), once)


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

    def test_a_replaced_dependency_is_dropped_once_no_source_names_it(self):
        crate = self.manifest("[dependencies]\nwalkdir = { workspace = true }\nserde = { workspace = true }\n")
        (crate / "src").mkdir()
        (crate / "src" / "lib.rs").write_text("use uv_vfs::walk::WalkDir;\n", encoding="utf-8")
        self.assertEqual(rewrite_fork.prune_replaced_dependencies(crate), 1)
        text = (crate / "Cargo.toml").read_text(encoding="utf-8")
        self.assertNotIn("walkdir", text)
        self.assertIn("serde", text)

    def test_a_replaced_dependency_a_source_still_names_is_kept(self):
        crate = self.manifest("[dependencies]\nwalkdir = { workspace = true }\n")
        (crate / "src").mkdir()
        (crate / "src" / "lib.rs").write_text("pub use walkdir::WalkDir;\n", encoding="utf-8")
        self.assertEqual(rewrite_fork.prune_replaced_dependencies(crate), 0)

    def test_a_crate_named_only_in_prose_does_not_keep_its_dependency(self):
        crate = self.manifest("[dependencies]\nwalkdir = { workspace = true }\n")
        (crate / "src").mkdir()
        (crate / "src" / "lib.rs").write_text(
            '// walkdir is cheap\nlet _ = x.expect("walkdir starts with root");\n', encoding="utf-8"
        )
        self.assertEqual(rewrite_fork.prune_replaced_dependencies(crate), 1)

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
    def test_every_owner_still_defines_the_methods_claimed_for_it(self):
        sources = [
            path.read_text(encoding="utf-8")
            for crate in rewrite_fork.crate_dirs()
            for path in rewrite_fork.rust_sources(crate)
        ]
        for owner, methods in rewrite_fork.URL_METHOD_OWNERS.items():
            for method in methods:
                defined = any(
                    f"impl {owner}" in source and f"fn {method}" in source for source in sources
                )
                self.assertTrue(defined, f"{owner} no longer defines {method}")

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
