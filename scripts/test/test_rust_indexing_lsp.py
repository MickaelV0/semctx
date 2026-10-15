import asyncio
import importlib.util
import json
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "rust_indexing_lsp", Path(__file__).parents[1] / "rust-indexing-lsp.py"
)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class LspTransportTest(unittest.IsolatedAsyncioTestCase):
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


if __name__ == "__main__":
    unittest.main()
