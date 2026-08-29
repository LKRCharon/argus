#!/usr/bin/env python3
"""Minimal stdio-to-WebSocket bridge for headless Hosts.

stdin/stdout use one compact JSON object per line. The bridge never interprets
relay payloads. A single asyncio loop owns TLS I/O so WSS reads and writes are
never performed concurrently from different threads.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import secrets
import ssl
import struct
import sys
from typing import Any
from urllib.parse import urlparse


WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
MAX_MESSAGE_BYTES = 300_000
OUTBOUND_FRAGMENT_BYTES = 1_024


class RelayWebSocket:
    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        self.reader = reader
        self.writer = writer
        self.closed = False
        self.transport_closed = False
        self.send_lock = asyncio.Lock()

    @classmethod
    async def connect(cls, url: str, timeout: float = 10.0) -> "RelayWebSocket":
        parsed = urlparse(url)
        if parsed.scheme not in {"ws", "wss"} or not parsed.hostname:
            raise ValueError("invalid relay URL")
        if parsed.username or parsed.password or parsed.fragment:
            raise ValueError("relay URL credentials and fragments are forbidden")
        port = parsed.port or (443 if parsed.scheme == "wss" else 80)
        ssl_context = ssl.create_default_context() if parsed.scheme == "wss" else None
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(
                parsed.hostname,
                port,
                ssl=ssl_context,
                server_hostname=parsed.hostname if ssl_context else None,
            ),
            timeout=timeout,
        )

        key = base64.b64encode(secrets.token_bytes(16)).decode("ascii")
        request_path = parsed.path or "/"
        if parsed.query:
            request_path += f"?{parsed.query}"
        host = parsed.hostname if parsed.port is None else f"{parsed.hostname}:{port}"
        request = (
            f"GET {request_path} HTTP/1.1\r\n"
            f"Host: {host}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        )
        writer.write(request.encode("utf-8"))
        await asyncio.wait_for(writer.drain(), timeout=timeout)
        raw_header = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=timeout)
        if len(raw_header) > 64_000:
            raise ConnectionError("oversized upgrade response")
        lines = raw_header[:-4].decode("iso-8859-1").split("\r\n")
        if not lines or " 101 " not in f" {lines[0]} ":
            raise ConnectionError("relay rejected upgrade")
        headers: dict[str, str] = {}
        for line in lines[1:]:
            if ":" in line:
                name, value = line.split(":", 1)
                headers[name.strip().lower()] = value.strip()
        expected = base64.b64encode(
            hashlib.sha1((key + WS_GUID).encode("ascii")).digest()
        ).decode("ascii")
        if headers.get("sec-websocket-accept") != expected:
            raise ConnectionError("invalid WebSocket accept key")
        return cls(reader, writer)

    async def _read_exact(self, size: int) -> bytes:
        try:
            return await self.reader.readexactly(size)
        except asyncio.IncompleteReadError as error:
            raise ConnectionError("relay connection closed") from error

    async def _read_frame(self) -> tuple[bool, int, bytes]:
        header = await self._read_exact(2)
        final = bool(header[0] & 0x80)
        opcode = header[0] & 0x0F
        masked = bool(header[1] & 0x80)
        length = header[1] & 0x7F
        if length == 126:
            length = struct.unpack("!H", await self._read_exact(2))[0]
        elif length == 127:
            length = struct.unpack("!Q", await self._read_exact(8))[0]
        if length > MAX_MESSAGE_BYTES:
            raise ConnectionError("relay frame too large")
        mask = await self._read_exact(4) if masked else b""
        payload = await self._read_exact(length)
        if masked:
            payload = bytes(value ^ mask[index % 4] for index, value in enumerate(payload))
        return final, opcode, payload

    async def _write_frame(self, opcode: int, payload: bytes, *, final: bool = True) -> None:
        if self.transport_closed:
            raise ConnectionError("relay connection is closed")
        mask = secrets.token_bytes(4)
        length = len(payload)
        header = bytearray([(0x80 if final else 0) | opcode])
        if length < 126:
            header.append(0x80 | length)
        elif length <= 0xFFFF:
            header.append(0x80 | 126)
            header.extend(struct.pack("!H", length))
        else:
            header.append(0x80 | 127)
            header.extend(struct.pack("!Q", length))
        masked = bytes(value ^ mask[index % 4] for index, value in enumerate(payload))
        self.writer.write(bytes(header) + mask + masked)
        await self.writer.drain()

    async def _send_frame(self, opcode: int, payload: bytes) -> None:
        async with self.send_lock:
            await self._write_frame(opcode, payload)

    async def send_json(self, value: dict[str, Any]) -> None:
        if self.closed:
            raise ConnectionError("relay connection is closed")
        payload = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(payload) > MAX_MESSAGE_BYTES:
            raise ValueError("outbound relay message too large")
        # Some GPU hosts sit behind a path that silently drops WSS client
        # records near the Ethernet MTU. WebSocket continuation frames preserve
        # one logical JSON message while keeping each encrypted write small.
        async with self.send_lock:
            for offset in range(0, len(payload), OUTBOUND_FRAGMENT_BYTES):
                chunk = payload[offset:offset + OUTBOUND_FRAGMENT_BYTES]
                await self._write_frame(
                    0x1 if offset == 0 else 0x0,
                    chunk,
                    final=offset + len(chunk) >= len(payload),
                )

    async def receive_json(self) -> dict[str, Any]:
        fragments = bytearray()
        fragment_opcode: int | None = None
        while True:
            final, opcode, payload = await self._read_frame()
            if opcode == 0x8:
                try:
                    await self._send_frame(0x8, payload)
                except Exception:
                    pass
                self.closed = True
                raise ConnectionError("relay closed WebSocket")
            if opcode == 0x9:
                await self._send_frame(0xA, payload)
                continue
            if opcode == 0xA:
                continue
            if opcode in {0x1, 0x2}:
                if fragment_opcode is not None:
                    raise ConnectionError("unexpected fragmented frame")
                fragment_opcode = opcode
                fragments.extend(payload)
            elif opcode == 0x0 and fragment_opcode is not None:
                fragments.extend(payload)
            else:
                raise ConnectionError("unsupported WebSocket frame")
            if len(fragments) > MAX_MESSAGE_BYTES:
                raise ConnectionError("relay message too large")
            if not final:
                continue
            if fragment_opcode != 0x1:
                raise ConnectionError("relay sent a non-text message")
            value = json.loads(fragments.decode("utf-8"))
            if not isinstance(value, dict):
                raise ConnectionError("relay message must be an object")
            return value

    async def close(self) -> None:
        if self.transport_closed:
            return
        if not self.closed:
            try:
                await self._send_frame(0x8, struct.pack("!H", 1000))
            except Exception:
                pass
        self.closed = True
        self.transport_closed = True
        self.writer.close()
        try:
            await asyncio.wait_for(self.writer.wait_closed(), timeout=1.0)
        except Exception:
            pass


def output(value: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


async def stdin_reader() -> asyncio.StreamReader:
    reader = asyncio.StreamReader(limit=MAX_MESSAGE_BYTES + 1)
    protocol = asyncio.StreamReaderProtocol(reader)
    await asyncio.get_running_loop().connect_read_pipe(lambda: protocol, sys.stdin.buffer)
    return reader


async def run(url: str) -> None:
    ws = await RelayWebSocket.connect(url)
    source = await stdin_reader()
    output({"bridge": "open"})

    async def pump_stdin() -> None:
        while True:
            line = await source.readline()
            if not line:
                return
            if len(line) > MAX_MESSAGE_BYTES or not line.endswith(b"\n"):
                raise ValueError("bridge input too large")
            value = json.loads(line.decode("utf-8"))
            if not isinstance(value, dict):
                raise ValueError("bridge input must be an object")
            await ws.send_json(value)

    async def pump_socket() -> None:
        while True:
            output(await ws.receive_json())

    tasks = {
        asyncio.create_task(pump_stdin(), name="ws-bridge-stdin"),
        asyncio.create_task(pump_socket(), name="ws-bridge-socket"),
    }
    try:
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
        for task in done:
            task.result()
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await ws.close()


def main() -> int:
    if len(sys.argv) != 2:
        output({"bridge": "error"})
        return 2
    try:
        asyncio.run(run(sys.argv[1]))
        return 0
    except Exception:
        output({"bridge": "error"})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
