import asyncio
import importlib.util
import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

spec = importlib.util.spec_from_file_location(
    "rust_indexing_lsp", Path(__file__).parents[1] / "rust-indexing-lsp.py"
)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class LspTransportTest(unittest.IsolatedAsyncioTestCase):
    async def test_refuses_oversized_advertisement_before_reading_body(self):
        class HeaderOnlyReader(asyncio.StreamReader):
            async def readexactly(self, size):
                self.assert_body_not_requested(size)
                return await super().readexactly(size)

            def assert_body_not_requested(self, size):
                if size > 1:
                    raise AssertionError("oversized body was requested before refusal")

        reader = HeaderOnlyReader()
        reader.feed_data(b"Content-Length: 4194305\r\n\r\n")
        with self.assertRaisesRegex(ValueError, "frame byte limit"):
            await probe.receive(reader)

    async def test_accepts_exact_frame_byte_limit(self):
        reader = asyncio.StreamReader()
        body = b'"' + b"x" * (4 * 1024 * 1024 - 2) + b'"'
        reader.feed_data(f"Content-Length: {len(body)}\r\n\r\n".encode() + body)
        self.assertEqual(await probe.receive(reader), "x" * (len(body) - 2))

    async def test_refuses_invalid_or_duplicate_lengths(self):
        for fields in (b"Content-Length: -1", b"Content-Length: nope",
                       b"Content-Length: 2\r\ncontent-length: 2"):
            with self.subTest(fields=fields):
                reader = asyncio.StreamReader()
                reader.feed_data(fields + b"\r\n\r\n{}")
                reader.feed_eof()
                error = None
                try:
                    await probe.receive(reader)
                except Exception as caught:
                    error = caught
                self.assertIsInstance(error, ValueError, "invalid framing must be refused explicitly")
                self.assertIn("Content-Length", str(error))

    async def test_refuses_header_over_byte_limit(self):
        reader = asyncio.StreamReader()
        reader.feed_data(b"X: " + b"x" * 8192 + b"\r\nContent-Length: 2\r\n\r\n{}")
        with self.assertRaisesRegex(ValueError, "header byte limit"):
            await probe.receive(reader)

    async def assert_probe_refuses_notifications(self, frames, overrides, reason):
        reader = asyncio.StreamReader()
        reader.feed_data(frames)
        reader.feed_eof()
        process = SimpleNamespace(
            stdin=SimpleNamespace(write=Mock(), drain=AsyncMock()),
            stdout=reader, returncode=None, kill=Mock(),
        )

        async def wait():
            process.returncode = -1

        process.wait = AsyncMock(side_effect=wait)
        with tempfile.TemporaryDirectory() as directory:
            args = SimpleNamespace(binary="diagnostic-server", workspace=directory,
                                   target=None, features=[])
            with patch.object(probe.asyncio, "create_subprocess_exec", AsyncMock(return_value=process)), \
                    patch.multiple(probe, create=True, **overrides):
                error = None
                try:
                    await probe.probe(args)
                except Exception as caught:
                    error = caught
        self.assertIsInstance(error, ValueError, "probe must refuse the output budget explicitly")
        self.assertIn(reason, str(error))
        process.kill.assert_called_once_with()
        process.wait.assert_awaited_once_with()

    async def test_probe_bounds_cumulative_wire_bytes_and_cleans_up(self):
        frame = b'Content-Length: 14\r\n\r\n{"method":"n"}'
        await self.assert_probe_refuses_notifications(
            frame * 4, {"MAX_WIRE_BYTES": len(frame) * 2}, "wire byte limit",
        )

    async def test_probe_bounds_message_count_and_cleans_up(self):
        frame = b'Content-Length: 14\r\n\r\n{"method":"n"}'
        await self.assert_probe_refuses_notifications(
            frame * 4, {"MAX_MESSAGES": 2}, "message count limit",
        )

    async def test_probe_sends_negotiated_incremental_edit(self):
        responses = [
            {"id": 1, "result": {"capabilities": {"textDocumentSync": {"change": 2}}}},
            {"method": "experimental/serverStatus", "params": {"quiescent": True}},
            *({"id": identifier, "result": []} for identifier in (2, 3, 4, 6, 8)),
            {"id": 7, "result": None},
        ]
        reader = asyncio.StreamReader()
        for message in responses:
            body = json.dumps(message).encode()
            reader.feed_data(f"Content-Length: {len(body)}\r\n\r\n".encode() + body)
        reader.feed_eof()
        frames = []
        process = SimpleNamespace(
            stdin=SimpleNamespace(write=frames.append, drain=AsyncMock()),
            stdout=reader,
            returncode=None,
            kill=Mock(),
        )

        async def wait():
            process.returncode = 0

        process.wait = wait
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "source.rs").write_text("fn f() {}\n// 🦀", encoding="utf-8")
            args = SimpleNamespace(
                binary="diagnostic-server", workspace=directory, file="source.rs",
                target=None, features=[], line=0, character=0,
                definition_line=0, definition_character=0,
            )
            with patch.object(probe.asyncio, "create_subprocess_exec", AsyncMock(return_value=process)):
                await probe.probe(args)
        messages = [json.loads(frame.split(b"\r\n\r\n", 1)[1]) for frame in frames]
        edit = next(message for message in messages if message.get("method") == "textDocument/didChange")
        self.assertEqual(edit["params"]["contentChanges"], [{
            "range": {"start": {"line": 1, "character": 5}, "end": {"line": 1, "character": 5}},
            "text": "\n",
        }])
        process.kill.assert_not_called()

    async def test_reads_utf8_bytes_and_preserves_next_message(self):
        reader = asyncio.StreamReader()
        body = json.dumps({"result": "é🦀"}, ensure_ascii=False).encode()
        frame = f"Content-Length: {len(body)}\r\n\r\n".encode() + body
        reader.feed_data(frame + b"Content-Length: 2\r\n\r\n{}")
        self.assertEqual(await probe.receive(reader), {"result": "é🦀"})
        self.assertEqual(await probe.receive(reader), {})

    async def test_truncated_body_is_an_error(self):
        reader = asyncio.StreamReader()
        reader.feed_data(b"Content-Length: 12\r\n\r\n{}")
        reader.feed_eof()
        with self.assertRaises(asyncio.IncompleteReadError):
            await probe.receive(reader)

    async def test_corrupt_body_is_an_error(self):
        reader = asyncio.StreamReader()
        reader.feed_data(b"Content-Length: 1\r\n\r\nx")
        with self.assertRaises(json.JSONDecodeError):
            await probe.receive(reader)


class LspEditTest(unittest.TestCase):
    def test_incremental_eof_handles_empty_trailing_newline_and_crlf(self):
        for source, line, character in [("", 0, 0), ("x\n", 1, 0), ("x\r\n🦀", 1, 2)]:
            with self.subTest(source=source):
                end = {"line": line, "character": character}
                self.assertEqual(probe.newline_change(source, 2), {
                    "range": {"start": end, "end": end}, "text": "\n",
                })

    def test_full_sync_preserves_the_whole_source(self):
        self.assertEqual(probe.newline_change("🦀\r\n", {"change": 1}), {"text": "🦀\r\n\n"})

    def test_absent_or_disabled_sync_refuses_edit(self):
        for sync in (None, 0, {}, {"change": 0}, 9):
            with self.subTest(sync=sync), self.assertRaisesRegex(ValueError, "document changes"):
                probe.newline_change("fn f() {}", sync)

    def run_main(self, exit_code):
        output = io.StringIO()
        with patch.object(probe, "probe", AsyncMock(return_value={"exitCode": exit_code})), \
                patch("sys.argv", ["rust-indexing-lsp.py", "server", ".", "source.rs"]), \
                redirect_stdout(output):
            if exit_code:
                with self.assertRaises(SystemExit) as error:
                    probe.main()
                self.assertEqual(error.exception.code, 1)
            else:
                self.assertIsNone(probe.main())
        self.assertEqual(json.loads(output.getvalue())["exitCode"], exit_code)

    def test_cli_preserves_diagnostics_and_refuses_server_failure(self):
        self.run_main(23)

    def test_cli_accepts_clean_server_exit(self):
        self.run_main(0)

    def test_cli_serializes_unicode_on_ascii_stdout(self):
        buffer = io.BytesIO()
        output = io.TextIOWrapper(buffer, encoding="ascii", write_through=True)
        result = {"exitCode": 0, "symbol": "é🦀"}
        with patch.object(probe, "probe", AsyncMock(return_value=result)), \
                patch("sys.argv", ["rust-indexing-lsp.py", "server", ".", "source.rs"]), \
                redirect_stdout(output):
            try:
                probe.main()
            except UnicodeEncodeError:
                self.fail("diagnostic JSON must preserve Unicode on a legacy stdout encoding")
        self.assertEqual(json.loads(buffer.getvalue().decode("utf-8")), result)


if __name__ == "__main__":
    unittest.main()
