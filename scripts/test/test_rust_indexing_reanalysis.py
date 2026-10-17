import copy
import ctypes
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import time
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "reanalysis", Path(__file__).parents[1] / "rust-indexing-reanalysis.py"
)
reanalysis = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(reanalysis)
UNPACK_SPEC = importlib.util.spec_from_file_location(
    "research_unpack", Path(__file__).parents[1] / "rust-indexing-unpack.py"
)
unpack = importlib.util.module_from_spec(UNPACK_SPEC)
UNPACK_SPEC.loader.exec_module(unpack)


def process_alive(pid):
    if os.name == "nt":
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.restype = ctypes.c_void_p
        handle = kernel.OpenProcess(0x1000 | 0x100000, False, pid)
        if not handle:
            return False
        try:
            return kernel.WaitForSingleObject(ctypes.c_void_p(handle), 0) == 258
        finally:
            kernel.CloseHandle(ctypes.c_void_p(handle))
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    status = Path(f"/proc/{pid}/stat")
    return not status.exists() or status.read_text().split(")", 1)[1].split()[0] != "Z"


class RunnerCleanupTest(unittest.TestCase):
    def exercise_timeout(self, real_lsp, minimal_env=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            record = root / "pids.json"
            server = root / "server.py"
            server.write_text(
                "import json, os, subprocess, sys, time\n"
                "from pathlib import Path\n"
                "child = subprocess.Popen([sys.executable, '-c', "
                "'import time; time.sleep(120)'], stdout=subprocess.DEVNULL, "
                "stderr=subprocess.DEVNULL)\n"
                f"Path({str(record)!r}).write_text(json.dumps("
                "{'launcher':os.getppid(), 'parent':os.getpid(), 'child':child.pid, "
                "'parentAliveBefore':True, 'childAliveBefore':child.poll() is None}))\n"
                "time.sleep(120)\n",
                encoding="utf-8",
            )
            if real_lsp:
                executable = root / ("server.cmd" if os.name == "nt" else "server")
                executable.write_text(
                    f'@"{sys.executable}" -B "{server}"\n'
                    if os.name == "nt"
                    else f'#!{sys.executable}\nexec(compile(open({str(server)!r}).read(), {str(server)!r}, "exec"))\n',
                    encoding="utf-8",
                )
                executable.chmod(0o700)
                (root / "source.rs").write_text("fn main() {}\n")
                argv = [
                    sys.executable,
                    str(Path(reanalysis.__file__).with_name("rust-indexing-lsp.py")),
                    str(executable),
                    str(root),
                    "source.rs",
                    "--timeout",
                    "120",
                ]
            else:
                argv = [
                    sys.executable,
                    "-c",
                    "import subprocess,sys,time; "
                    f"subprocess.Popen([sys.executable, {str(server)!r}]); time.sleep(120)",
                ]
            runner = reanalysis.Runner({}, root, time.monotonic() + 3)
            try:
                if minimal_env:
                    reduced = {
                        key.upper(): value
                        for key, value in os.environ.items()
                        if key.upper() in {"PATH", "SYSTEMROOT", "TEMP", "TMP"}
                    }
                    # Restore the host environment before fixture cleanup, even
                    # when the native timeout path refuses or the mutant fails.
                    with patch.dict(os.environ, reduced, clear=True):
                        self.assertNotIn("SYSTEMDRIVE", os.environ)
                        with self.assertRaises(subprocess.TimeoutExpired):
                            runner.command(argv, root)
                else:
                    with self.assertRaises(subprocess.TimeoutExpired):
                        runner.command(argv, root)
                pids = json.loads(record.read_text())
                self.assertTrue(pids["parentAliveBefore"])
                self.assertTrue(pids["childAliveBefore"])
                self.assertFalse(
                    process_alive(pids["parent"]),
                    "owned server survived Runner timeout",
                )
                self.assertFalse(
                    process_alive(pids["child"]),
                    "owned descendant survived Runner timeout",
                )
                timing = json.loads((root / "command-0000.timing.json").read_text())
                self.assertEqual(timing["status"], "TIMEOUT")
            finally:
                if record.exists():
                    pids = json.loads(record.read_text())
                    for pid in (pids["launcher"], pids["parent"], pids["child"]):
                        if process_alive(pid):
                            if os.name == "nt":
                                system = ctypes.create_unicode_buffer(32768)
                                size = ctypes.WinDLL("kernel32").GetSystemDirectoryW(
                                    system, len(system)
                                )
                                self.assertTrue(0 < size < len(system))
                                cleanup_env = {
                                    key.upper(): value
                                    for key, value in os.environ.items()
                                }
                                cleanup_env["SYSTEMDRIVE"] = Path(system.value).drive
                                subprocess.run(
                                    [
                                        str(Path(system.value) / "taskkill.exe"),
                                        "/PID",
                                        str(pid),
                                        "/T",
                                        "/F",
                                    ],
                                    check=True,
                                    stdout=subprocess.PIPE,
                                    stderr=subprocess.PIPE,
                                    env=cleanup_env,
                                    timeout=5,
                                )
                            else:
                                os.kill(pid, 9)
                    deadline = time.monotonic() + 3
                    while any(
                        process_alive(pid) for pid in pids.values() if type(pid) is int
                    ):
                        if time.monotonic() >= deadline:
                            raise AssertionError("owned fixture cleanup failed")
                        time.sleep(0.01)

    def test_outer_timeout_reaps_owned_descendants_before_propagation(self):
        self.exercise_timeout(False)

    def test_outer_timeout_reaps_real_lsp_wrapper_server_and_descendant(self):
        self.exercise_timeout(True)

    @unittest.skipUnless(os.name == "nt", "Windows taskkill environment contract")
    def test_outer_timeout_reaps_descendants_without_inherited_systemdrive(self):
        self.exercise_timeout(False, minimal_env=True)

    def test_cleanup_failure_refuses_tree_guarantee_and_still_reaps_direct_child(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            record = root / "direct.pid"
            runner = reanalysis.Runner({}, root, time.monotonic() + 1)
            failure = (
                patch.object(Path, "is_file", return_value=False)
                if os.name == "nt"
                else patch.object(
                    reanalysis.os, "killpg", side_effect=PermissionError("denied")
                )
            )
            with (
                failure,
                self.assertRaises((RuntimeError, subprocess.TimeoutExpired)) as caught,
            ):
                runner.command(
                    [
                        sys.executable,
                        "-c",
                        "import os,time; from pathlib import Path; "
                        f"Path({str(record)!r}).write_text(str(os.getpid())); time.sleep(120)",
                    ],
                    root,
                )
            self.assertIsInstance(caught.exception, RuntimeError)
            self.assertIn("cleanup could not be established", str(caught.exception))
            timing = json.loads((root / "command-0000.timing.json").read_text())
            self.assertEqual(timing["status"], "CLEANUP_FAILED")
            self.assertIn("cleanup could not be established", timing["cleanupError"])
            self.assertFalse(process_alive(int(record.read_text())))

    def test_success_preserves_native_streams_and_command_provenance(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runner = reanalysis.Runner({}, root, time.monotonic() + 15)
            argv = [
                sys.executable,
                "-c",
                "import os; os.write(1,b'raw\\x00out'); os.write(2,b'raw\\x00err')",
            ]
            stdout, stderr, observation = runner.command(argv, root)
            self.assertEqual(stdout, b"raw\x00out")
            self.assertEqual(stderr, b"raw\x00err")
            self.assertEqual(observation["exitCode"], 0)
            self.assertEqual(observation["stdoutSha256"], reanalysis.sha(stdout))
            self.assertEqual(observation["stderrSha256"], reanalysis.sha(stderr))
            self.assertEqual(
                json.loads((root / "command-0000.argv.json").read_text()),
                {"argv": argv, "cwd": str(root)},
            )


class NativeEvidenceTest(unittest.TestCase):
    def make_input_archive(self, root):
        payload = b"fn example() {}\n"
        name = "Y-pico-1/inputs/src/lib.rs"
        archive = root / "captured-inputs.zip"
        with zipfile.ZipFile(archive, "w") as bundle:
            bundle.writestr(name, payload)
        sha = reanalysis.sha(payload)
        reanalysis.save(
            root / "result.json",
            {
                "pairs": [
                    {
                        "engine": "Y",
                        "workspace": "pico",
                        "sample": 1,
                        "workspaceInputs": [
                            {"capturePath": "src/lib.rs", "sha256": sha}
                        ],
                    }
                ]
            },
        )
        manifest = {
            "archive": {
                "path": archive.name,
                "sha256": reanalysis.sha(archive.read_bytes()),
                "bytes": archive.stat().st_size,
                "uncompressedBytes": len(payload),
            },
            "members": [{"path": name, "sha256": sha, "bytes": len(payload)}],
        }
        reanalysis.save(root / "CAPTURED-INPUTS.json", manifest)
        return manifest, name, payload

    def test_input_archive_extracts_verified_bytes_and_refuses_existing_destination(
        self,
    ):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _, name, payload = self.make_input_archive(root)
            self.assertEqual(
                unpack.unpack_inputs(root), {"members": 1, "bytes": len(payload)}
            )
            self.assertEqual((root / name).read_bytes(), payload)
            with self.assertRaisesRegex(ValueError, "already exists"):
                unpack.unpack_inputs(root)

    def test_input_archive_sha_mismatch_is_refused_before_any_extraction(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest, _, _ = self.make_input_archive(root)
            manifest["archive"]["sha256"] = "0" * 64
            reanalysis.save(root / "CAPTURED-INPUTS.json", manifest)
            with self.assertRaisesRegex(ValueError, "archive SHA-256"):
                unpack.unpack_inputs(root)
            self.assertFalse((root / "Y-pico-1/inputs").exists())

    def test_input_archive_refuses_malformed_or_unknown_members_without_writes(self):
        for kind in ("malformed", "unknown", "symlink", "traversal"):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                manifest, name, payload = self.make_input_archive(root)
                archive = root / "captured-inputs.zip"
                if kind == "malformed":
                    archive.write_bytes(b"not-a-zip")
                else:
                    with zipfile.ZipFile(archive, "w") as bundle:
                        item = zipfile.ZipInfo(name)
                        if kind == "symlink":
                            item.create_system = 3
                            item.external_attr = 0o120777 << 16
                        bundle.writestr(item, payload)
                        if kind in ("unknown", "traversal"):
                            bundle.writestr(
                                "unknown.rs" if kind == "unknown" else "../escape.rs",
                                b"bad",
                            )
                manifest["archive"]["bytes"] = archive.stat().st_size
                manifest["archive"]["sha256"] = reanalysis.sha(archive.read_bytes())
                reanalysis.save(root / "CAPTURED-INPUTS.json", manifest)
                with self.assertRaises(ValueError):
                    unpack.unpack_inputs(root)
                self.assertFalse((root / "Y-pico-1/inputs").exists())

    def test_input_archive_refuses_missing_member_before_creating_inputs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / "captured-inputs.zip"
            with zipfile.ZipFile(archive, "w"):
                pass
            name = "Y-pico-1/inputs/src/lib.rs"
            expected = reanalysis.sha(b"fn example() {}\n")
            reanalysis.save(
                root / "result.json",
                {
                    "pairs": [
                        {
                            "engine": "Y",
                            "workspace": "pico",
                            "sample": 1,
                            "workspaceInputs": [
                                {"capturePath": "src/lib.rs", "sha256": expected}
                            ],
                        }
                    ]
                },
            )
            reanalysis.save(
                root / "CAPTURED-INPUTS.json",
                {
                    "archive": {
                        "path": archive.name,
                        "sha256": reanalysis.sha(archive.read_bytes()),
                        "bytes": archive.stat().st_size,
                        "uncompressedBytes": 16,
                    },
                    "members": [{"path": name, "sha256": expected, "bytes": 16}],
                },
            )
            with self.assertRaisesRegex(ValueError, "inventory"):
                unpack.unpack_inputs(root)
            self.assertFalse((root / "Y-pico-1/inputs").exists())

    def test_public_reanalysis_series_proves_all_native_postimages_and_portable_custody(
        self,
    ):
        public = (
            Path(__file__).parents[2]
            / "docs/research/rust-indexing/results/reanalysis-windows-2026-10-17"
        )
        result = json.loads((public / "result.json").read_bytes())
        config = json.loads((public / "config.json").read_bytes())
        provenance = json.loads((public / "PROVENANCE.json").read_bytes())
        self.assertEqual(
            provenance["measuredHead"], "1f08463191369097fe15dda1721324a4c7ab4215"
        )
        self.assertEqual(
            provenance["resultSha256"],
            reanalysis.sha((public / "result.json").read_bytes()),
        )
        self.assertEqual(
            provenance["configSha256"],
            reanalysis.sha((public / "config.json").read_bytes()),
        )
        self.assertFalse(provenance["publicationTestIsMeasuredRuntimeInput"])
        for path, digest in provenance["measuredHarnessSha256"].items():
            matching = [
                pin["sha256"]
                for pin in config["pins"]
                if pin["path"].replace("\\", "/").endswith("/" + path)
            ]
            self.assertEqual(matching, [digest], "original measured harness identity")
        self.assertEqual(result["engines"], list("TYSL"))
        self.assertEqual(len(result["pairs"]), 24)
        self.assertEqual(
            {
                (pair["sample"], pair["workspace"], pair["engine"])
                for pair in result["pairs"]
            },
            {
                (sample, workspace, engine)
                for sample in (1, 2, 3)
                for workspace in ("fixture", "pico")
                for engine in "TYSL"
            },
        )
        for pair in result["pairs"]:
            world = next(
                item
                for item in config["workspaces"]
                if item["name"] == pair["workspace"]
            )
            commands = pair["commands"]
            for command in commands:
                self.assertRegex(command["prefix"], r"^command-[0-9]{4}$")

            def native(index, commands=commands):
                return (public / (commands[index]["prefix"] + ".stdout")).read_bytes()

            if pair["engine"] == "T":
                document = next(
                    item
                    for item in json.loads(native(0))["files"]
                    if item["file"] == world["target"]
                )
                before = [item["name"] for item in document["before"]["symbols"]]
                after = [item["name"] for item in document["after"]["symbols"]]
            elif pair["engine"] == "Y":
                target_index = world["files"].index(world["target"])
                before = reanalysis.tsv_symbols(native(target_index))
                after = reanalysis.tsv_symbols(
                    native(len(world["files"]) + target_index)
                )
            elif pair["engine"] == "S":
                self.assertEqual(config["S"]["pathMode"], "windows-diagnostic")
                self.assertEqual(
                    pair["scipPathLimitation"], reanalysis.WINDOWS_SCIP_LIMIT
                )
                before = reanalysis.scip_symbols(
                    json.loads(native(1)), world["target"], config["S"]["pathMode"]
                )
                after = reanalysis.scip_symbols(
                    json.loads(native(3)), world["target"], config["S"]["pathMode"]
                )
            else:
                document = json.loads(native(0))
                before = reanalysis.LSP.symbol_names(document["symbols"])
                after = reanalysis.LSP.symbol_names(document["editedSymbols"])
            label = f"{pair['engine']}/{pair['workspace']}/{pair['sample']}"
            self.assertNotIn(
                reanalysis.SYMBOL, before, label + " baseline must lack probe function"
            )
            self.assertIn(
                reanalysis.SYMBOL,
                after,
                label + " native postimage must contain probe function",
            )

        # Keep native symbol assertions ahead of custody validation, so a stale
        # well-formed postimage is an assertion failure, not a digest ERROR.
        catalogue = json.loads((public / "CATALOG.json").read_bytes())
        for entry in catalogue["files"]:
            self.assertEqual(
                reanalysis.sha(
                    reanalysis.retained_path(public, entry["path"]).read_bytes()
                ),
                entry["sha256"],
                entry["path"],
            )
        logical = catalogue["logicalOriginals"]
        self.assertEqual(len(logical), 607)
        self.assertEqual(len({entry["path"] for entry in logical}), 607)
        physical = {entry["path"]: entry for entry in catalogue["files"]}
        archived = {
            entry["path"]: entry
            for entry in json.loads((public / "CAPTURED-INPUTS.json").read_bytes())[
                "members"
            ]
        }
        self.assertEqual(len(archived), 204)
        for entry in logical:
            storage = entry["storage"]
            if "member" in storage:
                self.assertEqual(
                    storage, {"archive": "captured-inputs.zip", "member": entry["path"]}
                )
                stored = archived[entry["path"]]
            else:
                self.assertEqual(storage, {"file": entry["path"]})
                stored = physical[entry["path"]]
            self.assertEqual(
                (entry["bytes"], entry["sha256"]), (stored["bytes"], stored["sha256"])
            )
        with tempfile.TemporaryDirectory() as directory:
            portable = Path(directory) / "copied-records"
            shutil.copytree(public, portable)
            unpacked = unpack.unpack_inputs(portable)
            self.assertEqual(unpacked["members"], 204)
            read_bytes = Path.read_bytes

            def local_read(path):
                self.assertTrue(
                    path.resolve().is_relative_to(portable.resolve()),
                    "validation attempted an original host/tool read",
                )
                return read_bytes(path)

            with (
                patch.object(Path, "read_bytes", local_read),
                patch.object(
                    reanalysis.Runner,
                    "command",
                    side_effect=AssertionError("validation must not execute engines"),
                ),
            ):
                validation = reanalysis.validate_series(portable)
            self.assertEqual(
                validation,
                {"status": "VALID", "pairs": 24, "states": 48, "engines": list("TYSL")},
            )

    def test_five_file_syn_timings_sum_native_integer_nanoseconds_once(self):
        # Actual parse_ns from commands 0001..0010 of the interrupted
        # reindex382-measurements-8f3afa1 series. These are unit-test inputs,
        # not fresh native executions or a replacement campaign receipt.
        values = [
            347700,
            234600,
            206400,
            316400,
            198200,
            225800,
            217200,
            182100,
            290900,
            194600,
        ]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            original = root / "original"
            files = [
                "app/src/main.rs",
                "domain/src/lib.rs",
                "domain/src/model.rs",
                "domain/src/operations.rs",
                "domain/tests/dispatch.rs",
            ]
            for file in files:
                path = original / file
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b"fn existing() {}\n")
            output = root / "captures"
            output.mkdir()
            world = {
                "name": "fixture",
                "path": str(original),
                "files": files,
                "target": files[0],
            }
            runner = reanalysis.Runner(
                {"Y": {"binary": "C:/native-syn.exe"}}, output, time.monotonic() + 10
            )

            def capture(argv, cwd):
                index = runner.sequence
                runner.sequence += 1
                name = (
                    reanalysis.SYMBOL
                    if reanalysis.SYMBOL.encode() in Path(argv[1]).read_bytes()
                    else "existing"
                )
                raw = f"symbol\tfn\t{name}\t0\t16\t\n".encode()
                stderr = f"timing\tparse_ns\t{values[index]}\n".encode()
                stem = output / f"command-{index:04d}"
                stem.with_suffix(".stdout").write_bytes(raw)
                stem.with_suffix(".stderr").write_bytes(stderr)
                reanalysis.save(
                    stem.with_suffix(".argv.json"), {"argv": argv, "cwd": str(cwd)}
                )
                observation = {
                    "prefix": stem.name,
                    "exitCode": 0,
                    "elapsedMs": 1,
                    "stdoutSha256": reanalysis.sha(raw),
                    "stderrSha256": reanalysis.sha(stderr),
                    "argvSha256": reanalysis.sha(
                        stem.with_suffix(".argv.json").read_bytes()
                    ),
                }
                reanalysis.save(stem.with_suffix(".timing.json"), observation)
                return raw, stderr, observation

            with patch.object(runner, "command", side_effect=capture):
                pair = runner.pair("Y", world, 1)
            self.assertEqual(
                pair["nativeTimingsMs"],
                {
                    "coldFullParse": sum(values[:5]) / 1_000_000,
                    "editedFullParse": sum(values[5:]) / 1_000_000,
                },
            )
            pair["nativeTimingsMs"]["editedFullParse"] += 0.0001
            with self.assertRaisesRegex(ValueError, "timing projection mismatch"):
                reanalysis.validate_pair(pair, world, output, runner.config)

    def test_captured_manifests_cannot_be_rediscovered_as_replay_inputs(self):
        names = (
            "Cargo.toml.snapshot",
            "app/Cargo.toml.snapshot",
            "domain/Cargo.toml",
            "Cargo.lock",
            "src/lib.rs",
        )
        captured = [reanalysis.capture_path(name) for name in names]
        self.assertEqual(
            captured[:3],
            [
                "Cargo.toml.snapshot.capture",
                "app/Cargo.toml.snapshot.capture",
                "domain/Cargo.toml.capture",
            ],
        )
        self.assertFalse(
            any(
                Path(name).name in ("Cargo.toml", "Cargo.toml.snapshot")
                for name in captured
            )
        )
        self.assertEqual(captured[3:], list(names[3:]))

    def test_symbol_oracle_refuses_stale_and_raw_substring_matches(self):
        for before, after in (
            ([], []),
            ([reanalysis.SYMBOL], [reanalysis.SYMBOL]),
            ([], [reanalysis.SYMBOL + "_other"]),
        ):
            with (
                self.subTest(before=before, after=after),
                self.assertRaisesRegex(ValueError, "added symbol"),
            ):
                reanalysis.require_added(before, after)
        reanalysis.require_added(["existing"], [reanalysis.SYMBOL])

    def test_scip_uses_target_definition_descriptor_not_raw_text(self):
        index = {
            "documents": [
                {
                    "relativePath": "src/lib.rs",
                    "symbols": [
                        {
                            "symbol": "scip-rust cargo pico-args 0.5.0 semctx_reindex_probe()."
                        },
                        {
                            "symbol": "scip-rust cargo pico-args 0.5.0 semctx_reindex_probe_other()."
                        },
                        {
                            "symbol": "scip-rust cargo pico-args 0.5.0 unrelated().",
                            "displayName": reanalysis.SYMBOL,
                        },
                    ],
                    "occurrences": [{"symbol": reanalysis.SYMBOL}],
                }
            ]
        }
        self.assertEqual(
            reanalysis.scip_symbols(index, "src/lib.rs"),
            [reanalysis.SYMBOL, reanalysis.SYMBOL + "_other", "unrelated"],
        )
        with self.assertRaisesRegex(ValueError, "target document"):
            reanalysis.scip_symbols(index, "missing.rs")

    def test_scip_windows_diagnostic_is_explicit_and_preserves_native_paths(self):
        before = {"documents": [{"relativePath": "app\\src\\main.rs", "symbols": []}]}
        after = copy.deepcopy(before)
        after["documents"][0]["symbols"] = [
            {"symbol": "scip-rust cargo fixture 0.1.0 semctx_reindex_probe()."}
        ]
        with self.assertRaisesRegex(ValueError, "nonconforming"):
            reanalysis.scip_symbols(before, "app/src/main.rs")
        reanalysis.require_added(
            reanalysis.scip_symbols(before, "app/src/main.rs", "windows-diagnostic"),
            reanalysis.scip_symbols(after, "app/src/main.rs", "windows-diagnostic"),
        )
        self.assertEqual(after["documents"][0]["relativePath"], "app\\src\\main.rs")

    def test_scip_diagnostic_refuses_colliding_or_unsafe_document_paths(self):
        index = {
            "documents": [
                {"relativePath": "app/src/main.rs"},
                {"relativePath": "app\\src\\main.rs"},
            ]
        }
        with self.assertRaisesRegex(ValueError, "ambiguous"):
            reanalysis.scip_symbols(index, "app/src/main.rs", "windows-diagnostic")
        for path in (
            "",
            "/src/lib.rs",
            "C:/src/lib.rs",
            "C:src/lib.rs",
            "\\\\server\\src\\lib.rs",
            "./src/lib.rs",
            "src/../lib.rs",
            "src//lib.rs",
            "src/./lib.rs",
            "src/",
            "src\\..\\lib.rs",
        ):
            with (
                self.subTest(path=path),
                self.assertRaisesRegex(ValueError, "relative path"),
            ):
                reanalysis.scip_symbols(
                    {"documents": [{"relativePath": path}]},
                    "src/lib.rs",
                    "windows-diagnostic",
                )

    def test_timings_refuse_nan_infinite_negative_boolean_and_missing(self):
        for value in (float("nan"), float("inf"), -1, True, None, "12"):
            with (
                self.subTest(value=value),
                self.assertRaisesRegex(ValueError, "native timing"),
            ):
                reanalysis.finite_duration(value)

    def make_pair(self, directory):
        root = Path(directory)
        workspace = root / "original"
        (workspace / "src").mkdir(parents=True)
        source = b"fn existing() {}\n"
        (workspace / "src/lib.rs").write_bytes(source)
        inputs = root / "Y-pico-1/inputs/src"
        inputs.mkdir(parents=True)
        (inputs / "lib.rs").write_bytes(source)
        (root / "Y-pico-1/target.before.rs").write_bytes(source)
        (root / "Y-pico-1/target.after.rs").write_bytes(
            source + reanalysis.APPEND.encode()
        )
        world = {
            "name": "pico",
            "path": str(workspace),
            "files": ["src/lib.rs"],
            "target": "src/lib.rs",
        }
        pair = {
            "engine": "Y",
            "workspace": "pico",
            "sample": 1,
            "sources": {
                "src/lib.rs": {
                    "beforeSha256": reanalysis.sha(source),
                    "afterSha256": reanalysis.sha(source + reanalysis.APPEND.encode()),
                }
            },
            "appendSha256": reanalysis.sha(reanalysis.APPEND.encode()),
            "commands": [],
            "nativeTimingsMs": {"coldFullParse": 0.001, "editedFullParse": 0.001},
        }
        for number, name in enumerate(("existing", reanalysis.SYMBOL)):
            raw = (
                f"summary\titems\t1\tmethods\t0\nsymbol\tfn\t{name}\t0\t16\t\n".encode()
            )
            stderr = b"timing\tparse_ns\t1000\n"
            stem = root / f"command-{number:04d}"
            stem.with_suffix(".stdout").write_bytes(raw)
            stem.with_suffix(".stderr").write_bytes(stderr)
            reanalysis.save(
                stem.with_suffix(".argv.json"),
                {
                    "argv": ["C:/native-syn.exe", "C:/scratch/src/lib.rs"],
                    "cwd": "C:/scratch",
                },
            )
            command = {
                "prefix": stem.name,
                "exitCode": 0,
                "elapsedMs": 1,
                "stdoutSha256": reanalysis.sha(raw),
                "stderrSha256": reanalysis.sha(stderr),
                "argvSha256": reanalysis.sha(
                    stem.with_suffix(".argv.json").read_bytes()
                ),
            }
            reanalysis.save(stem.with_suffix(".timing.json"), command)
            pair["commands"].append(command)
        return root, world, pair

    def test_retained_command_argv_mutation_is_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            root, world, pair = self.make_pair(directory)
            reanalysis.validate_pair(pair, world, root)
            reanalysis.save(
                root / "command-0001.argv.json",
                {"argv": ["C:/wrong-tool.exe", "different.rs"], "cwd": "C:/scratch"},
            )
            with self.assertRaisesRegex(ValueError, "argv"):
                reanalysis.validate_pair(pair, world, root)

    def test_retained_command_executable_must_match_configured_engine(self):
        with tempfile.TemporaryDirectory() as directory:
            root, world, pair = self.make_pair(directory)
            with self.assertRaisesRegex(ValueError, "executable"):
                reanalysis.validate_pair(
                    pair, world, root, {"Y": {"binary": "C:/different.exe"}}
                )

    def test_retained_native_output_is_reinspected_and_stale_symbol_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            root, world, pair = self.make_pair(directory)
            reanalysis.validate_pair(pair, world, root)
            stem = root / "command-0001"
            raw = (
                stem.with_suffix(".stdout")
                .read_bytes()
                .replace(reanalysis.SYMBOL.encode(), b"stale")
            )
            stem.with_suffix(".stdout").write_bytes(raw)
            pair["commands"][1]["stdoutSha256"] = reanalysis.sha(raw)
            reanalysis.save(stem.with_suffix(".timing.json"), pair["commands"][1])
            with self.assertRaisesRegex(ValueError, "added symbol"):
                reanalysis.validate_pair(pair, world, root)

    def test_retained_input_hash_and_failed_command_are_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            root, world, pair = self.make_pair(directory)
            wrong = copy.deepcopy(pair)
            wrong["sources"]["src/lib.rs"]["afterSha256"] = "0" * 64
            with self.assertRaisesRegex(ValueError, "source hash"):
                reanalysis.validate_pair(wrong, world, root)
            pair["commands"][1]["exitCode"] = 9
            reanalysis.save(root / "command-0001.timing.json", pair["commands"][1])
            with self.assertRaisesRegex(ValueError, "command observation"):
                reanalysis.validate_pair(pair, world, root)

    def test_series_refuses_missing_or_duplicate_sample_without_engine_execution(self):
        with tempfile.TemporaryDirectory() as directory:
            root, world, pair = self.make_pair(directory)
            fixture = {
                "name": "fixture",
                "target": "app/src/main.rs",
                "files": ["a.rs", "b.rs", "c.rs", "d.rs", "e.rs"],
            }
            config = {"workspaces": [fixture, world]}
            reanalysis.save(root / "config.json", config)
            result = {
                "status": "COMPLETE",
                "engines": ["Y"],
                "pairs": [pair],
                "configSha256": reanalysis.sha((root / "config.json").read_bytes()),
            }
            reanalysis.save(root / "result.json", result)
            with (
                self.assertRaisesRegex(ValueError, "coverage mismatch"),
            ):
                reanalysis.validate_series(root)

    def test_retained_paths_refuse_absolute_traversal_and_symlink_escape(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for path in (str(root / "file"), "../outside"):
                with (
                    self.subTest(path=path),
                    self.assertRaisesRegex(ValueError, "relative"),
                ):
                    reanalysis.retained_path(root, path)
            with (
                patch.object(Path, "is_symlink", return_value=True),
                self.assertRaisesRegex(ValueError, "symlinks"),
            ):
                reanalysis.retained_path(root, "linked/file")

    def test_native_windows_psapi_retains_real_child_peak_after_exit(self):
        if os.name != "nt":
            self.skipTest("PSAPI is Windows-only")
        with subprocess.Popen(
            [sys.executable, "-c", "data=bytearray(32*1024*1024); print(len(data))"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        ) as process:
            stdout, stderr = process.communicate(timeout=15)
            self.assertEqual(process.returncode, 0, stderr)
            self.assertEqual(stdout.strip(), b"33554432")
            measurement = reanalysis.LSP.direct_child_rss(process)
            self.assertIsInstance(measurement["peakRssBytes"], int, measurement)
            self.assertGreater(measurement["peakRssBytes"], 0)


if __name__ == "__main__":
    unittest.main()
