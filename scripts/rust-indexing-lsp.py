import argparse
import asyncio
import json
import time
from pathlib import Path


# Research probes retain responses for inspection; timeouts alone do not bound memory.
MAX_HEADER_BYTES = 8 * 1024
MAX_FRAME_BYTES = 4 * 1024 * 1024
MAX_WIRE_BYTES = 16 * 1024 * 1024
MAX_MESSAGES = 10_000


async def receive(reader, budget=None):
    if budget is None:
        budget = {"wire_bytes": 0, "messages": 0}
    if budget["messages"] >= MAX_MESSAGES:
        raise ValueError("LSP message count limit exceeded")
    header = bytearray()
    while not header.endswith(b"\r\n\r\n"):
        if len(header) >= MAX_HEADER_BYTES:
            raise ValueError("LSP header byte limit exceeded")
        if budget["wire_bytes"] >= MAX_WIRE_BYTES:
            raise ValueError("LSP wire byte limit exceeded")
        header.extend(await reader.readexactly(1))
        budget["wire_bytes"] += 1
    lengths = []
    for line in header.decode("ascii").split("\r\n")[:-2]:
        name, separator, value = line.partition(":")
        if not separator:
            raise ValueError("invalid LSP header")
        if name.lower() == "content-length":
            lengths.append(value.strip())
    if len(lengths) != 1 or not lengths[0] or not all("0" <= char <= "9" for char in lengths[0]):
        raise ValueError("invalid or duplicate LSP Content-Length")
    # Compare decimal text first, so even an enormous integer advertisement is refused.
    length_text = lengths[0].lstrip("0") or "0"
    maximum = str(MAX_FRAME_BYTES)
    if len(length_text) > len(maximum) or (len(length_text) == len(maximum) and length_text > maximum):
        raise ValueError("LSP frame byte limit exceeded")
    length = int(length_text)
    if budget["wire_bytes"] + length > MAX_WIRE_BYTES:
        raise ValueError("LSP wire byte limit exceeded")
    budget["wire_bytes"] += length
    budget["messages"] += 1
    body = await reader.readexactly(length)
    return json.loads(body)


def newline_change(source, sync):
    kind = sync.get("change", 0) if isinstance(sync, dict) else sync
    if kind == 1:
        return {"text": source + "\n"}
    if kind != 2:
        raise ValueError("server does not support document changes")
    lines = source.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    end = {"line": len(lines) - 1, "character": len(lines[-1].encode("utf-16-le")) // 2}
    return {"range": {"start": end, "end": end}, "text": "\n"}


async def probe(args):
    root = Path(args.workspace).resolve()
    process = await asyncio.create_subprocess_exec(
        args.binary,
        cwd=root,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
    )
    messages = []
    budget = {"wire_bytes": 0, "messages": 0}

    async def send(message):
        body = json.dumps(message).encode()
        process.stdin.write(f"Content-Length: {len(body)}\r\n\r\n".encode() + body)
        await process.stdin.drain()

    async def next_message():
        message = await receive(process.stdout, budget)
        messages.append(message)
        if "method" in message and "id" in message:
            if message["method"] in (
                "window/workDoneProgress/create",
                "client/registerCapability",
            ):
                await send({"jsonrpc": "2.0", "id": message["id"], "result": None})
            else:
                await send({
                    "jsonrpc": "2.0", "id": message["id"],
                    "error": {"code": -32601, "message": "unsupported probe request"},
                })
        return message

    timings = {}

    async def request(identifier, method, params):
        started = time.monotonic()
        await send({"jsonrpc": "2.0", "id": identifier, "method": method, "params": params})
        while True:
            message = await next_message()
            if message.get("id") == identifier and "method" not in message:
                timings[method] = (time.monotonic() - started) * 1000
                if "error" in message:
                    raise RuntimeError(message["error"])
                return message["result"]

    try:
        started = time.monotonic()
        cargo_options = {"buildScripts": {"enable": False}, "offline": True}
        if args.target:
            cargo_options["target"] = args.target
        if args.features:
            cargo_options["features"] = args.features
        initialized = await request(1, "initialize", {
            "processId": None,
            "rootUri": root.as_uri(),
            "capabilities": {
                "experimental": {"serverStatusNotification": True},
                "textDocument": {"callHierarchy": {"dynamicRegistration": False}},
                "general": {"positionEncodings": ["utf-16"]},
            },
            "initializationOptions": {
                "cargo": cargo_options,
                "procMacro": {"enable": False},
                "checkOnSave": False,
            },
        })
        await send({"jsonrpc": "2.0", "method": "initialized", "params": {}})
        while True:
            message = await next_message()
            if message.get("method") == "experimental/serverStatus":
                if message["params"]["quiescent"]:
                    break
        timings["ready"] = (time.monotonic() - started) * 1000
        document = {"uri": (root / args.file).as_uri()}
        source = (root / args.file).read_text(encoding="utf-8")
        await send({"jsonrpc": "2.0", "method": "textDocument/didOpen", "params": {
            "textDocument": {**document, "languageId": "rust", "version": 1, "text": source},
        }})
        symbols = await request(2, "textDocument/documentSymbol", {"textDocument": document})
        unknown = await request(3, "workspace/symbol", {"query": "semctx_missing_346"})
        hierarchy = await request(4, "textDocument/prepareCallHierarchy", {
            "textDocument": document,
            "position": {"line": args.line, "character": args.character},
        })
        calls = None
        if hierarchy:
            calls = await request(5, "callHierarchy/outgoingCalls", {"item": hierarchy[0]})
        definition = await request(6, "textDocument/definition", {
            "textDocument": document,
            "position": {"line": args.definition_line, "character": args.definition_character},
        })
        await send({"jsonrpc": "2.0", "method": "textDocument/didChange", "params": {
            "textDocument": {**document, "version": 2},
            "contentChanges": [newline_change(source, initialized["capabilities"].get("textDocumentSync"))],
        }})
        edited_symbols = await request(8, "textDocument/documentSymbol", {"textDocument": document})
        timings["documentSymbolAfterEdit"] = timings.pop("textDocument/documentSymbol")
        await request(7, "shutdown", None)
        await send({"jsonrpc": "2.0", "method": "exit"})
        await process.wait()
        return {
            "initialization": initialized, "symbols": symbols, "unknown": unknown,
            "hierarchy": hierarchy, "calls": calls, "definition": definition,
            "editedSymbols": edited_symbols,
            "timingsMs": timings, "messages": messages, "exitCode": process.returncode,
        }
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("binary")
    parser.add_argument("workspace")
    parser.add_argument("file")
    parser.add_argument("--line", type=int, default=6)
    parser.add_argument("--character", type=int, default=4)
    parser.add_argument("--definition-line", type=int, default=9)
    parser.add_argument("--definition-character", type=int, default=26)
    parser.add_argument("--timeout", type=float, default=90)
    parser.add_argument("--target")
    parser.add_argument("--features", nargs="*", default=[])
    args = parser.parse_args()
    result = asyncio.run(asyncio.wait_for(probe(args), timeout=args.timeout))
    print(json.dumps(result, ensure_ascii=True, indent=2))
    if result["exitCode"] != 0:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
