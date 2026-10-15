import argparse
import asyncio
import json
import time
from pathlib import Path


async def receive(reader):
    headers = (await reader.readuntil(b"\r\n\r\n")).decode("ascii")
    fields = dict(line.split(":", 1) for line in headers.strip().split("\r\n"))
    body = await reader.readexactly(int(fields["Content-Length"]))
    return json.loads(body)


async def probe(args):
    root = Path(args.workspace).resolve()
    process = await asyncio.create_subprocess_exec(
        args.binary,
        cwd=root,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
    )
    messages = []

    async def send(message):
        body = json.dumps(message).encode()
        process.stdin.write(f"Content-Length: {len(body)}\r\n\r\n".encode() + body)
        await process.stdin.drain()

    async def next_message():
        message = await receive(process.stdout)
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
        source = (root / args.file).read_text()
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
            "contentChanges": [{"text": source + "\n"}],
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
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
