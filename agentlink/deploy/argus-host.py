#!/usr/bin/env python3
"""A no-sudo Argus Host for machines that have Codex but no Node/Bun.

The relay only transports encrypted frames.  This process makes an outbound
WSS connection, keeps its identity below ``AGENTLINK_HOME``, and speaks to
``codex app-server`` over stdio.  It intentionally never listens on a public
port and has no dependency outside Python's ``cryptography`` package, which is
available on zjuL40's user environment.

The wire format mirrors packages/wire and the Android client:
X25519 + HKDF-SHA256 for pairing and AES-256-GCM for channel messages.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import os
import queue
import secrets
import select
import shutil
import signal
import socket
import ssl
import struct
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlparse

try:
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF
    from cryptography.hazmat.primitives.serialization import Encoding, NoEncryption, PrivateFormat, PublicFormat
except ImportError as error:  # pragma: no cover - exercised on the target host
    raise SystemExit(
        "Argus Host needs Python package 'cryptography'. It is preinstalled on zjuL40; "
        f"current import failed: {error}"
    )


JSON = dict[str, Any]
ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
REVERSE = {ch: index for index, ch in enumerate(ALPHABET)}
REVERSE.update({"I": 1, "L": 1, "O": 0})
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
APPROVAL_METHODS = {
    "item/commandExecution/requestApproval": "命令执行",
    "execCommandApproval": "命令执行",
    "item/fileChange/requestApproval": "文件修改",
    "applyPatchApproval": "文件修改",
    "item/permissions/requestApproval": "权限申请",
}
STOP = threading.Event()
# A history read is deliberately progressive: the phone can render the newest
# conversation immediately while the older turns travel in bounded frames.
HISTORY_INITIAL_EVENTS = 80
HISTORY_CHUNK_EVENTS = 80
HISTORY_CHUNK_DELAY_SECONDS = 0.18
HISTORY_TURNS_PER_PAGE = 4
# Relay frames are capped at 300 kB before encryption/base64. Keep plaintext
# history slices comfortably below that ceiling rather than assuming every
# event is short.
HISTORY_CHUNK_MAX_PAYLOAD_BYTES = 160_000
HISTORY_EVENT_TEXT_CHARS = 30_000
# Live Codex text arrives in very small deltas.  Keep first paint effectively
# instant, but batch the rest so encryption, relay framing and Compose do not
# repeat work for every token-sized notification.
TEXT_COALESCE_INTERVAL_SECONDS = 0.075
TEXT_COALESCE_MAX_CHARS = 8_192

# History is deliberately the lowest-priority traffic: it is an observational
# read and must never make an input, interrupt, or approval wait behind a long
# thread.  Bounded queues also stop an offline phone from growing the Host's
# memory without limit.
OUTBOUND_CONTROL_MAX = 64
OUTBOUND_REALTIME_MAX = 256
OUTBOUND_HISTORY_MAX = 24
OUTBOUND_PRIORITY_PUT_TIMEOUT_SECONDS = 0.75
OUTBOUND_FLUSH_FRAME_BUDGET = 32
OUTBOUND_REALTIME_PER_HISTORY = 4

# The Android home refresh currently requests both legacy and Codex catalog
# shapes.  They are intentionally kept for compatibility, but share this short
# cache and a single in-flight app-server walk.
CATALOG_CACHE_SECONDS = 1.5
CATALOG_WAIT_SECONDS = 30.0
HISTORY_CANCEL_RETENTION_SECONDS = 5 * 60.0
METRICS_LOG_INTERVAL_SECONDS = 60.0

TURN_LIFECYCLE_METHODS = frozenset({
    "turn/started", "turn/completed", "turn/aborted", "turn/failed",
})
HISTORY_PAYLOAD_KINDS = frozenset({
    "codex-history-start", "codex-history-chunk", "codex-history-complete",
})
CONTROL_PAYLOAD_KINDS = frozenset({
    "echo-ack", "input-ack", "permission-request", "codex-error",
    "session-started", "cloud-session-url",
})


@dataclass
class CatalogFlight:
    """One shared thread/list walk, including its result for waiting callers."""

    ready: threading.Event
    generation: int
    result: list[JSON] | None = None
    error: str | None = None


def now_ms() -> int:
    return int(time.time() * 1000)


def utf8(value: str) -> bytes:
    return value.encode("utf-8")


def b64encode(value: bytes) -> str:
    return base64.b64encode(value).decode("ascii")


def b64decode(value: str) -> bytes:
    return base64.b64decode(value.encode("ascii"), validate=True)


def stable_json(value: Any) -> str:
    """JSON.stringify equivalent used by the pairing transcript."""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def base32_encode(value: bytes) -> str:
    bits = 0
    accumulator = 0
    output: list[str] = []
    for byte in value:
        accumulator = (accumulator << 8) | byte
        bits += 8
        while bits >= 5:
            output.append(ALPHABET[(accumulator >> (bits - 5)) & 31])
            bits -= 5
    if bits:
        output.append(ALPHABET[(accumulator << (5 - bits)) & 31])
    return "".join(output)


def public_bytes(key: X25519PrivateKey | X25519PublicKey) -> bytes:
    if isinstance(key, X25519PrivateKey):
        key = key.public_key()
    return key.public_bytes(Encoding.Raw, PublicFormat.Raw)


def private_bytes(key: X25519PrivateKey) -> bytes:
    return key.private_bytes(Encoding.Raw, PrivateFormat.Raw, NoEncryption())


def fingerprint(public_key: bytes) -> str:
    compact = base32_encode(hashlib.sha256(public_key).digest()[:12])[:20]
    return "-".join(compact[index:index + 4] for index in range(0, 20, 4))


def hkdf(value: bytes, *, salt: bytes | None, info: bytes, length: int = 32) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=length, salt=salt, info=info).derive(value)


def pepper_from_secret(secret: str) -> bytes:
    return hashlib.sha256(utf8(f"agentlink/pepper/v1:{secret}")).digest()


def confirm_tag(key: bytes, direction: str, transcript: bytes) -> bytes:
    return hmac.new(key, transcript + utf8(f":{direction}"), hashlib.sha256).digest()


def pairing_transcript(hello_a: JSON, hello_b: JSON) -> bytes:
    # pairing.ts passes stableStringify(hello) into transcriptHash(), whose
    # implementation stable-stringifies those strings again.  Keep this double
    # serialization or Android's confirm tag will not match.
    left = stable_json(stable_json(hello_a))
    right = stable_json(stable_json(hello_b))
    return hashlib.sha256(utf8(f"{left}|{right}")).digest()


def derive_confirm_key(shared: bytes, pepper: bytes) -> bytes:
    return hkdf(shared, salt=pepper, info=b"agentlink/confirm/v1")


def derive_channel_key(shared: bytes) -> bytes:
    return hkdf(shared, salt=None, info=b"agentlink/channel/v1")


def derive_long_term_key(shared: bytes) -> bytes:
    return hkdf(shared, salt=None, info=b"agentlink/longterm/v1")


def derive_channel_token(long_term_key: bytes) -> str:
    return b64encode(hkdf(long_term_key, salt=None, info=b"agentlink/chan-token/v1", length=24))


class SecureChannel:
    def __init__(self, key: bytes):
        if len(key) != 32:
            raise ValueError("channel key must be 32 bytes")
        self._cipher = AESGCM(key)

    def seal(self, payload: Any) -> str:
        nonce = secrets.token_bytes(12)
        ciphertext = self._cipher.encrypt(nonce, utf8(json.dumps(payload, ensure_ascii=False, separators=(",", ":"))), None)
        return b64encode(b"\x00" + nonce + ciphertext)

    def open(self, blob: str) -> JSON:
        raw = b64decode(blob)
        if len(raw) < 29 or raw[0] != 0:
            raise ValueError("invalid encrypted frame")
        decoded = self._cipher.decrypt(raw[1:13], raw[13:], None)
        value = json.loads(decoded.decode("utf-8"))
        if not isinstance(value, dict):
            raise ValueError("encrypted frame must contain an object")
        return value


def state_dir() -> Path:
    root = Path(os.environ.get("AGENTLINK_HOME", str(Path.home() / ".agentlink"))).expanduser()
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(root, 0o700)
    return root


def private_write(path: Path, content: str) -> None:
    temporary = path.with_name(f".{path.name}.{secrets.token_hex(6)}.tmp")
    try:
        with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w", encoding="utf-8") as handle:
            handle.write(content)
            handle.write("\n")
        os.replace(temporary, path)
        os.chmod(path, 0o600)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def load_or_create_identity() -> X25519PrivateKey:
    path = state_dir() / "identity.json"
    if path.exists():
        raw = json.loads(path.read_text(encoding="utf-8"))
        return X25519PrivateKey.from_private_bytes(b64decode(str(raw["secretKey"])))
    identity = X25519PrivateKey.generate()
    private_write(
        path,
        json.dumps(
            {
                "secretKey": b64encode(private_bytes(identity)),
                "publicKey": b64encode(public_bytes(identity)),
                "createdAt": now_ms(),
            },
            ensure_ascii=False,
            indent=2,
        ),
    )
    return identity


def load_peers() -> dict[str, JSON]:
    path = state_dir() / "peers.json"
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
        return parsed if isinstance(parsed, dict) else {}
    except FileNotFoundError:
        return {}
    except (json.JSONDecodeError, OSError) as error:
        raise RuntimeError(f"cannot read peer store {path}: {error}") from error


def save_peer(peer: JSON) -> None:
    peers = load_peers()
    peers[str(peer["fingerprint"])] = peer
    private_write(state_dir() / "peers.json", json.dumps(peers, ensure_ascii=False, indent=2))


def device_info() -> JSON:
    return {
        "name": os.environ.get("AGENTLINK_DEVICE_NAME", socket.gethostname()).strip() or socket.gethostname(),
        "platform": os.environ.get("AGENTLINK_DEVICE_PLATFORM", "linux").strip() or "linux",
    }


class WebSocket:
    """Small client-only RFC 6455 implementation for the relay's text frames."""

    def __init__(self, connection: socket.socket, initial: bytes = b""):
        self._socket = connection
        self._buffer = bytearray(initial)
        self._send_lock = threading.Lock()
        self._closed = False

    @classmethod
    def connect(cls, url: str, timeout: float = 10.0) -> "WebSocket":
        parsed = urlparse(url)
        if parsed.scheme not in {"ws", "wss"} or not parsed.hostname:
            raise ValueError(f"invalid relay URL: {url}")
        port = parsed.port or (443 if parsed.scheme == "wss" else 80)
        raw = socket.create_connection((parsed.hostname, port), timeout=timeout)
        if parsed.scheme == "wss":
            raw = ssl.create_default_context().wrap_socket(raw, server_hostname=parsed.hostname)
        key = b64encode(secrets.token_bytes(16))
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
        raw.sendall(utf8(request))
        header = bytearray()
        while b"\r\n\r\n" not in header:
            piece = raw.recv(4096)
            if not piece:
                raise ConnectionError("relay closed during WebSocket upgrade")
            header.extend(piece)
            if len(header) > 64_000:
                raise ConnectionError("oversized WebSocket upgrade response")
        raw_header, initial = bytes(header).split(b"\r\n\r\n", 1)
        lines = raw_header.decode("iso-8859-1").split("\r\n")
        if not lines or " 101 " not in f" {lines[0]} ":
            raise ConnectionError(f"relay rejected WebSocket upgrade: {lines[0] if lines else 'empty response'}")
        headers: dict[str, str] = {}
        for line in lines[1:]:
            if ":" in line:
                name, value = line.split(":", 1)
                headers[name.strip().lower()] = value.strip()
        expected = b64encode(hashlib.sha1(utf8(key + WS_GUID)).digest())
        if headers.get("sec-websocket-accept") != expected:
            raise ConnectionError("relay returned an invalid WebSocket accept key")
        raw.settimeout(1.0)
        return cls(raw, initial)

    def _read_exact(self, size: int) -> bytes:
        while len(self._buffer) < size:
            try:
                piece = self._socket.recv(max(4096, size - len(self._buffer)))
            except socket.timeout as error:
                raise TimeoutError from error
            if not piece:
                raise ConnectionError("relay connection closed")
            self._buffer.extend(piece)
        result = bytes(self._buffer[:size])
        del self._buffer[:size]
        return result

    def _read_frame(self) -> tuple[bool, int, bytes]:
        header = self._read_exact(2)
        final = bool(header[0] & 0x80)
        opcode = header[0] & 0x0F
        masked = bool(header[1] & 0x80)
        length = header[1] & 0x7F
        if length == 126:
            length = struct.unpack("!H", self._read_exact(2))[0]
        elif length == 127:
            length = struct.unpack("!Q", self._read_exact(8))[0]
        if length > 1_000_000:
            raise ConnectionError("relay sent an oversized WebSocket frame")
        mask = self._read_exact(4) if masked else b""
        payload = self._read_exact(length)
        if masked:
            payload = bytes(value ^ mask[index % 4] for index, value in enumerate(payload))
        return final, opcode, payload

    def _send_frame(self, opcode: int, payload: bytes) -> None:
        if self._closed:
            raise ConnectionError("relay connection is closed")
        mask = secrets.token_bytes(4)
        length = len(payload)
        header = bytearray([0x80 | opcode])
        if length < 126:
            header.append(0x80 | length)
        elif length <= 0xFFFF:
            header.append(0x80 | 126)
            header.extend(struct.pack("!H", length))
        else:
            header.append(0x80 | 127)
            header.extend(struct.pack("!Q", length))
        encrypted = bytes(value ^ mask[index % 4] for index, value in enumerate(payload))
        with self._send_lock:
            self._socket.sendall(bytes(header) + mask + encrypted)

    def send_json(self, payload: JSON) -> None:
        self._send_frame(0x1, utf8(json.dumps(payload, ensure_ascii=False, separators=(",", ":"))))

    def recv_json(self) -> JSON:
        fragments = bytearray()
        fragment_opcode: int | None = None
        while True:
            final, opcode, payload = self._read_frame()
            if opcode == 0x8:
                # Echo the close frame before marking the local transport dead.
                # This is required by RFC 6455 and lets the relay release the
                # member promptly instead of waiting for a TCP timeout.
                try:
                    self._send_frame(0x8, payload)
                except Exception:
                    pass
                self._closed = True
                if len(payload) >= 2:
                    code = struct.unpack("!H", payload[:2])[0]
                    reason = payload[2:].decode("utf-8", errors="replace").replace("\n", " ")[:120]
                    detail = f" (code {code}{': ' + reason if reason else ''})"
                else:
                    detail = ""
                raise ConnectionError(f"relay closed the WebSocket{detail}")
            if opcode == 0x9:
                self._send_frame(0xA, payload)
                continue
            if opcode == 0xA:
                continue
            if opcode == 0x1:
                if final:
                    raw = payload
                    break
                fragment_opcode = opcode
                fragments.extend(payload)
                continue
            if opcode == 0x0 and fragment_opcode == 0x1:
                fragments.extend(payload)
                if final:
                    raw = bytes(fragments)
                    break
                continue
            raise ConnectionError(f"unsupported relay WebSocket opcode: {opcode}")
        value = json.loads(raw.decode("utf-8"))
        if not isinstance(value, dict):
            raise ConnectionError("relay message was not an object")
        return value

    def close(self) -> None:
        if self._closed:
            return
        try:
            self._send_frame(0x8, b"")
        except Exception:
            pass
        self._closed = True
        try:
            self._socket.close()
        except OSError:
            pass


def wait_for(ws: WebSocket, predicate: Callable[[JSON], bool], timeout_seconds: float) -> JSON:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        try:
            message = ws.recv_json()
        except TimeoutError:
            continue
        if predicate(message):
            return message
    raise TimeoutError("timed out waiting for relay")


def generate_pair_code() -> tuple[str, str, str]:
    nameplate = f"{secrets.randbelow(10_000):04d}"
    secret = base32_encode(secrets.token_bytes(4))[:6]
    return nameplate, secret, f"{nameplate}-{secret}"


def pair(json_output: bool) -> JSON:
    identity = load_or_create_identity()
    device = device_info()
    nameplate, secret, display = generate_pair_code()
    ws = WebSocket.connect(relay_url())
    try:
        ws.send_json({"op": "join-pair", "nameplate": nameplate})
        joined = wait_for(ws, lambda message: message.get("op") in {"pair-joined", "error"}, 15)
        if joined.get("op") == "error":
            raise RuntimeError(f"relay rejected pairing: {joined.get('message') or joined.get('code')}")
        if joined.get("role") != "A":
            raise RuntimeError("pairing room was unexpectedly occupied; retry")
        if json_output:
            print(json.dumps({"type": "pair_code", "code": display, "ttlSeconds": 300}, ensure_ascii=False), flush=True)
        print(f"配对码: {display}（5 分钟内有效，等待 Android 加入…）", flush=True)

        ready = wait_for(ws, lambda message: message.get("op") in {"pair-ready", "pair-peer-left", "error"}, 300)
        if ready.get("op") != "pair-ready":
            raise RuntimeError("Android 未在配对码有效期内加入")

        ephemeral = X25519PrivateKey.generate()
        hello_a: JSON = {
            "v": 1,
            "kind": "hello",
            "role": "A",
            "ephPub": b64encode(public_bytes(ephemeral)),
            "device": device,
        }
        ws.send_json({"op": "pair-data", "data": hello_a})

        hello_b: JSON | None = None
        channel: SecureChannel | None = None
        peer_identity: JSON | None = None
        confirm_key: bytes | None = None
        transcript: bytes | None = None
        received_confirm = False
        sent_identity = False

        while peer_identity is None:
            message = wait_for(ws, lambda item: item.get("op") in {"pair-data", "pair-peer-left", "error"}, 60)
            if message.get("op") != "pair-data":
                raise RuntimeError("Android left the pairing room")
            data = message.get("data")
            if not isinstance(data, dict):
                raise RuntimeError("invalid pairing payload")
            kind = data.get("kind")
            if kind == "abort":
                raise RuntimeError("Android rejected pairing")
            if kind == "hello":
                if data.get("role") != "B" or hello_b is not None:
                    raise RuntimeError("invalid Android hello")
                hello_b = data
                peer_ephemeral = X25519PublicKey.from_public_bytes(b64decode(str(data["ephPub"])))
                shared = ephemeral.exchange(peer_ephemeral)
                transcript = pairing_transcript(hello_a, hello_b)
                confirm_key = derive_confirm_key(shared, pepper_from_secret(secret))
                channel = SecureChannel(derive_channel_key(shared))
                ws.send_json({
                    "op": "pair-data",
                    "data": {"v": 1, "kind": "confirm", "tag": b64encode(confirm_tag(confirm_key, "A2B", transcript))},
                })
            elif kind == "confirm":
                if confirm_key is None or transcript is None:
                    raise RuntimeError("Android confirm arrived before hello")
                expected = confirm_tag(confirm_key, "B2A", transcript)
                if not hmac.compare_digest(expected, b64decode(str(data.get("tag", "")))):
                    ws.send_json({"op": "pair-data", "data": {"v": 1, "kind": "abort"}})
                    raise RuntimeError("pairing confirmation failed")
                received_confirm = True
                if not sent_identity:
                    assert channel is not None
                    identity_payload = {
                        "v": 1,
                        "kind": "identity",
                        "identityPub": b64encode(public_bytes(identity)),
                        "device": device,
                    }
                    ws.send_json({"op": "pair-data", "data": {"v": 1, "kind": "identity", "blob": channel.seal(identity_payload)}})
                    sent_identity = True
            elif kind == "identity":
                if channel is None or not received_confirm:
                    raise RuntimeError("Android identity arrived before confirmation")
                peer_identity = channel.open(str(data["blob"]))
            else:
                raise RuntimeError("unknown pairing payload")

        peer_public = b64decode(str(peer_identity["identityPub"]))
        peer_key = X25519PublicKey.from_public_bytes(peer_public)
        long_term_key = derive_long_term_key(identity.exchange(peer_key))
        peer_device = peer_identity.get("device") if isinstance(peer_identity.get("device"), dict) else {}
        peer = {
            "identityPub": b64encode(peer_public),
            "fingerprint": fingerprint(peer_public),
            "deviceName": str(peer_device.get("name") or "Android"),
            "platform": str(peer_device.get("platform") or "android"),
            "longTermKey": b64encode(long_term_key),
            "pairedAt": now_ms(),
        }
        save_peer(peer)
        ws.send_json({"op": "leave-pair"})
        print(f"配对成功: {peer['deviceName']} [{peer['fingerprint']}]", flush=True)
        if json_output:
            print(json.dumps({"type": "pair_done", **{key: peer[key] for key in ("deviceName", "platform", "fingerprint")}}, ensure_ascii=False), flush=True)
        return peer
    except Exception:
        try:
            ws.send_json({"op": "pair-data", "data": {"v": 1, "kind": "abort"}})
        except Exception:
            pass
        raise
    finally:
        ws.close()


@dataclass
class PendingCall:
    event: threading.Event
    result: Any = None
    error: str | None = None


class CodexRpc:
    """JSON-RPC client for `codex app-server` over its stdio transport."""

    def __init__(
        self,
        on_notification: Callable[[str, Any], None],
        on_server_request: Callable[[int | str, str, Any], None],
    ):
        self._on_notification = on_notification
        self._on_server_request = on_server_request
        self._process: subprocess.Popen[str] | None = None
        self._next_id = 1
        self._pending: dict[int, PendingCall] = {}
        self._lock = threading.Lock()
        self._write_lock = threading.Lock()

    def start(self) -> None:
        if self._process is not None and self._process.poll() is None:
            return
        binary = os.environ.get("CODEX_BIN") or shutil.which("codex")
        if not binary:
            raise RuntimeError("未找到 codex；请设置 CODEX_BIN 或把 codex 放进 PATH")
        self._process = subprocess.Popen(
            [binary, "app-server"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            bufsize=1,
            cwd=str(Path.home()),
        )
        threading.Thread(target=self._read_loop, name="argus-codex-rpc", daemon=True).start()
        self.call("initialize", {
            "clientInfo": {"name": "argus", "title": "Argus", "version": "0.1.0"},
            # `thread/turns/list` is the read-only paginated API. Opting in is
            # local to this bridge and never resumes or modifies a thread.
            "capabilities": {"experimentalApi": True},
        })
        self.notify("initialized")

    def _read_loop(self) -> None:
        process = self._process
        if process is None or process.stdout is None:
            return
        for line in process.stdout:
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(message, dict):
                continue
            method = message.get("method")
            identifier = message.get("id")
            if identifier is not None and method is None:
                try:
                    numeric_id = int(identifier)
                except (TypeError, ValueError):
                    continue
                with self._lock:
                    pending = self._pending.pop(numeric_id, None)
                if pending is None:
                    continue
                if message.get("error") is not None:
                    detail = message["error"]
                    pending.error = str(detail.get("message") if isinstance(detail, dict) else detail)
                else:
                    pending.result = message.get("result")
                pending.event.set()
            elif method and identifier is not None:
                self._on_server_request(identifier, str(method), message.get("params"))
            elif method:
                self._on_notification(str(method), message.get("params"))
        with self._lock:
            pending_calls = list(self._pending.values())
            self._pending.clear()
        for pending in pending_calls:
            pending.error = "codex app-server 已断开"
            pending.event.set()

    def _send_raw(self, value: JSON) -> None:
        process = self._process
        if process is None or process.poll() is not None or process.stdin is None:
            raise RuntimeError("codex app-server 未连接")
        with self._write_lock:
            process.stdin.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
            process.stdin.flush()

    def call(self, method: str, params: Any = None, timeout: float = 30.0) -> Any:
        with self._lock:
            identifier = self._next_id
            self._next_id += 1
            pending = PendingCall(threading.Event())
            self._pending[identifier] = pending
        try:
            request: JSON = {"id": identifier, "method": method}
            if params is not None:
                request["params"] = params
            self._send_raw(request)
        except Exception:
            with self._lock:
                self._pending.pop(identifier, None)
            raise
        if not pending.event.wait(timeout):
            with self._lock:
                self._pending.pop(identifier, None)
            raise TimeoutError(f"{method} 超时")
        if pending.error:
            raise RuntimeError(pending.error)
        return pending.result

    def notify(self, method: str, params: Any = None) -> None:
        request: JSON = {"method": method}
        if params is not None:
            request["params"] = params
        self._send_raw(request)

    def respond(self, identifier: int | str, result: Any) -> None:
        self._send_raw({"id": identifier, "result": result})

    def stop(self) -> None:
        process, self._process = self._process, None
        if process is None or process.poll() is not None:
            return
        try:
            process.terminate()
            process.wait(timeout=3)
        except Exception:
            try:
                process.kill()
            except Exception:
                pass


def summarize(value: Any, limit: int = 300) -> str:
    if isinstance(value, str):
        text = value
    else:
        try:
            text = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
        except (TypeError, ValueError):
            text = str(value)
    return text if len(text) <= limit else f"{text[:limit]}…"


def flatten_turns(turns: Any) -> list[JSON]:
    if not isinstance(turns, list):
        return []
    output: list[JSON] = []
    for turn in turns:
        if not isinstance(turn, dict):
            continue
        for item in turn.get("items", []):
            if not isinstance(item, dict):
                continue
            kind = item.get("type")
            if kind == "userMessage":
                text = "".join(
                    str(part.get("text", ""))
                    for part in item.get("content", [])
                    if isinstance(part, dict) and part.get("type") == "text"
                ).strip()
                if text:
                    output.append({"type": "user-text", "text": text})
            elif kind == "agentMessage" and str(item.get("text", "")).strip():
                output.append({"type": "text", "text": str(item["text"])})
            elif kind == "reasoning":
                summary = item.get("summary", [])
                text = "\n".join(map(str, summary)) if isinstance(summary, list) else ""
                if text.strip():
                    output.append({"type": "thinking", "text": text})
            elif kind == "commandExecution":
                output.append({"type": "tool-call", "name": "shell", "summary": summarize(item.get("command") or item.get("parsedCmd") or "")})
            elif kind == "fileChange":
                changes = item.get("changes", [])
                paths = ", ".join(str(change.get("path")) for change in changes if isinstance(change, dict) and change.get("path"))
                output.append({"type": "tool-call", "name": "edit", "summary": summarize(paths)})
            elif kind == "mcpToolCall":
                output.append({"type": "tool-call", "name": str(item.get("server", "mcp")), "summary": summarize(item.get("tool", ""), 200)})
        status = turn.get("status")
        if isinstance(status, dict):
            status = status.get("type")
        if isinstance(status, str) and status not in {"inProgress", "running"}:
            output.append({"type": "turn-done", "reason": status})
    return output


def describe_source(source: Any) -> tuple[str | None, int | None, str | None]:
    if not isinstance(source, dict):
        return None, None, None
    sub = source.get("subAgent") or source.get("subagent")
    if not isinstance(sub, dict):
        return None, None, None
    spawn = sub.get("thread_spawn") or sub.get("threadSpawn")
    if not isinstance(spawn, dict):
        return None, None, None
    parent = spawn.get("parent_thread_id") or spawn.get("parentThreadId")
    if parent is None:
        return None, None, None
    try:
        depth = int(spawn.get("depth", 1))
    except (TypeError, ValueError):
        depth = 1
    return str(parent), depth, str(spawn.get("agent_nickname") or spawn.get("agentNickname") or "") or None


class ArgusHost:
    def __init__(self, peer: JSON):
        self.peer = peer
        self.ws: WebSocket | None = None
        self.channel = SecureChannel(b64decode(str(peer["longTermKey"])))
        self.rpc: CodexRpc | None = None
        self._rpc_lock = threading.Lock()
        self._active_turns: dict[str, str] = {}
        self._turn_lock = threading.Lock()
        # A second catalog tap supersedes an older stream for the same thread.
        # The request id also lets the phone discard any frame already queued.
        self._history_streams: dict[str, str] = {}
        self._history_cancelled: dict[tuple[str, str], float] = {}
        self._history_stream_lock = threading.Lock()
        # One observation read at a time keeps paged history from competing
        # with an explicit phone input for app-server work.  Control commands
        # themselves do not take this slot.
        self._history_read_slot = threading.Semaphore(1)
        self._approvals: dict[str, int | str] = {}
        self._approval_lock = threading.Lock()
        self._catalog_lock = threading.Lock()
        self._catalog_cache: tuple[float, list[JSON]] | None = None
        self._catalog_flight: CatalogFlight | None = None
        self._catalog_generation = 0
        self._text_lock = threading.Lock()
        self._text_buffers: dict[str, tuple[str, float]] = {}
        self._metrics_lock = threading.Lock()
        self._metrics: dict[str, int] = {}
        self._queue_high_water = {"control": 0, "realtime": 0, "history": 0}
        self._last_metrics_log = time.monotonic()
        # An SSLSocket has one transport owner: reads and writes from separate
        # threads intermittently dropped otherwise healthy WebSockets on L40.
        # Worker threads enqueue plaintext objects; `run()` seals and writes
        # them on the same thread that receives frames.  A history download is
        # low priority, so it gets its own small queue instead of blocking a
        # permission answer or accumulating indefinitely behind a slow phone.
        self._outbound_control: queue.Queue[JSON] = queue.Queue(maxsize=OUTBOUND_CONTROL_MAX)
        self._outbound_realtime: queue.Queue[JSON] = queue.Queue(maxsize=OUTBOUND_REALTIME_MAX)
        self._outbound_history: queue.Queue[JSON] = queue.Queue(maxsize=OUTBOUND_HISTORY_MAX)
        self._realtime_since_history = 0

    def _metric_inc(self, name: str, amount: int = 1) -> None:
        with self._metrics_lock:
            self._metrics[name] = self._metrics.get(name, 0) + amount

    def _metric_duration_ms(self, name: str, started_at: float) -> None:
        elapsed_ms = max(0, int((time.monotonic() - started_at) * 1000))
        with self._metrics_lock:
            self._metrics[f"{name}_count"] = self._metrics.get(f"{name}_count", 0) + 1
            self._metrics[f"{name}_total_ms"] = self._metrics.get(f"{name}_total_ms", 0) + elapsed_ms
            self._metrics[f"{name}_max_ms"] = max(self._metrics.get(f"{name}_max_ms", 0), elapsed_ms)

    def _observe_queue_depth(self, lane: str, target: queue.Queue[JSON]) -> None:
        # qsize() is approximate across threads, which is enough for an
        # operational high-water signal and does not expose payload content.
        depth = target.qsize()
        with self._metrics_lock:
            self._queue_high_water[lane] = max(self._queue_high_water[lane], depth)

    @staticmethod
    def _payload_lane(payload: JSON) -> str:
        kind = str(payload.get("kind") or "")
        if kind in HISTORY_PAYLOAD_KINDS:
            return "history"
        if kind in CONTROL_PAYLOAD_KINDS:
            return "control"
        return "realtime"

    def send_payload(self, payload: JSON, lane: str | None = None) -> bool:
        if self.ws is None:
            raise ConnectionError("relay is not connected")
        resolved_lane = lane or self._payload_lane(payload)
        targets: dict[str, queue.Queue[JSON]] = {
            "control": self._outbound_control,
            "realtime": self._outbound_realtime,
            "history": self._outbound_history,
        }
        target = targets.get(resolved_lane)
        if target is None:
            raise ValueError(f"unknown outbound lane: {resolved_lane}")
        if resolved_lane == "history":
            try:
                target.put_nowait(payload)
            except queue.Full:
                # Do not discard a random earlier slice and pretend the history
                # is complete.  The producer cancels the whole read and reports
                # a retryable error instead.
                self._metric_inc("history_queue_rejected")
                return False
        else:
            try:
                target.put(payload, timeout=OUTBOUND_PRIORITY_PUT_TIMEOUT_SECONDS)
            except queue.Full as error:
                self._metric_inc(f"{resolved_lane}_queue_saturated")
                raise ConnectionError(f"{resolved_lane} outbound queue is saturated") from error
        self._observe_queue_depth(resolved_lane, target)
        self._metric_inc(f"outbound_{resolved_lane}_enqueued")
        return True

    def _next_outbound_payload(self) -> JSON | None:
        try:
            return self._outbound_control.get_nowait()
        except queue.Empty:
            pass
        if self._realtime_since_history >= OUTBOUND_REALTIME_PER_HISTORY:
            try:
                self._realtime_since_history = 0
                return self._outbound_history.get_nowait()
            except queue.Empty:
                pass
        try:
            self._realtime_since_history += 1
            return self._outbound_realtime.get_nowait()
        except queue.Empty:
            self._realtime_since_history = 0
        try:
            return self._outbound_history.get_nowait()
        except queue.Empty:
            return None

    def _is_cancelled_history_payload(self, payload: JSON) -> bool:
        if payload.get("kind") not in HISTORY_PAYLOAD_KINDS:
            return False
        thread_id = payload.get("sessionId")
        request_id = payload.get("requestId")
        if not isinstance(thread_id, str) or not isinstance(request_id, str):
            return False
        with self._history_stream_lock:
            return (thread_id, request_id) in self._history_cancelled

    def _flush_outbound(self, ws: WebSocket) -> None:
        sent = 0
        scanned = 0
        # Bound a single pass: receive/heartbeat work stays responsive even if
        # an absent phone left a batch of now-cancelled history frames behind.
        while sent < OUTBOUND_FLUSH_FRAME_BUDGET and scanned < OUTBOUND_FLUSH_FRAME_BUDGET * 2:
            payload = self._next_outbound_payload()
            if payload is None:
                return
            scanned += 1
            if self._is_cancelled_history_payload(payload):
                self._metric_inc("history_frames_discarded_after_cancel")
                continue
            ws.send_json({"op": "chan-data", "data": {"enc": self.channel.seal(payload)}})
            sent += 1
            self._metric_inc("outbound_frames_sent")

    def _append_text_delta(self, thread_id: str, text: str) -> None:
        flush_now: str | None = None
        now = time.monotonic()
        with self._text_lock:
            prior, created_at = self._text_buffers.get(thread_id, ("", now))
            combined = prior + text
            if len(combined) >= TEXT_COALESCE_MAX_CHARS:
                flush_now = combined
                self._text_buffers.pop(thread_id, None)
            else:
                self._text_buffers[thread_id] = (combined, created_at)
        self._metric_inc("text_deltas_in")
        self._metric_inc("text_chars_in", len(text))
        if flush_now:
            self._send_text_event(thread_id, flush_now)

    def _send_text_event(self, thread_id: str, text: str) -> None:
        try:
            self.send_payload({
                "kind": "agent-event",
                "sessionId": thread_id,
                "agent": "codex",
                "event": {"type": "text", "text": text},
            }, lane="realtime")
        except ConnectionError as error:
            # A saturated phone link must not make the Host tear down its local
            # app-server (and thereby disturb the desktop's active turn). Text
            # can recover on the next history read; control traffic remains in
            # its separate priority queue.
            self._metric_inc("text_frames_dropped_backpressure")
            print(f"[host] live text frame skipped: {error}", file=sys.stderr, flush=True)
            return
        self._metric_inc("text_frames_out")
        self._metric_inc("text_chars_out", len(text))

    def _flush_text_buffers(self, thread_id: str | None = None, force: bool = False) -> None:
        now = time.monotonic()
        ready: list[tuple[str, str]] = []
        with self._text_lock:
            for candidate, (text, created_at) in list(self._text_buffers.items()):
                if thread_id is not None and candidate != thread_id:
                    continue
                if force or now - created_at >= TEXT_COALESCE_INTERVAL_SECONDS:
                    self._text_buffers.pop(candidate, None)
                    if text:
                        ready.append((candidate, text))
        for candidate, text in ready:
            self._send_text_event(candidate, text)

    def _log_metrics_if_due(self) -> None:
        now = time.monotonic()
        if now - self._last_metrics_log < METRICS_LOG_INTERVAL_SECONDS:
            return
        self._last_metrics_log = now
        with self._metrics_lock:
            counters = dict(self._metrics)
            high_water = dict(self._queue_high_water)
        with self._history_stream_lock:
            active_history = len(self._history_streams)
        snapshot = {
            "outboundDepth": {
                "control": self._outbound_control.qsize(),
                "realtime": self._outbound_realtime.qsize(),
                "history": self._outbound_history.qsize(),
            },
            "outboundHighWater": high_water,
            "activeHistoryReads": active_history,
            "counters": counters,
        }
        # Metrics intentionally contain no peer ids, thread ids, paths or text.
        print(f"[host] metrics {json.dumps(snapshot, ensure_ascii=False, separators=(',', ':'))}", flush=True)

    def _codex(self) -> CodexRpc:
        with self._rpc_lock:
            if self.rpc is None:
                self.rpc = CodexRpc(self._on_notification, self._on_server_request)
            self.rpc.start()
            return self.rpc

    def _on_notification(self, method: str, params: Any) -> None:
        data = params if isinstance(params, dict) else {}
        thread_id = data.get("threadId")
        turn = data.get("turn") if isinstance(data.get("turn"), dict) else {}
        turn_id = data.get("turnId") or turn.get("id")
        self._metric_inc("codex_notifications")
        if method == "turn/started" and thread_id and turn_id:
            with self._turn_lock:
                self._active_turns[str(thread_id)] = str(turn_id)
        elif thread_id and method in {"turn/completed", "turn/aborted", "turn/failed"}:
            with self._turn_lock:
                self._active_turns.pop(str(thread_id), None)
        if method in TURN_LIFECYCLE_METHODS or method.startswith("thread/"):
            self._invalidate_catalog()
        try:
            if method == "item/agentMessage/delta":
                delta = data.get("delta") or data.get("text") or ""
                if delta and thread_id:
                    self._append_text_delta(str(thread_id), str(delta))
                # The raw notification used to duplicate this exact text next
                # to agent-event.  The normalized stream is the sole carrier.
                self._metric_inc("codex_raw_notifications_suppressed")
                return
            if thread_id:
                # Keep text before tool/turn state in observable order.  This
                # avoids a completed card appearing above its final text chunk.
                self._flush_text_buffers(str(thread_id), force=True)
            if method in TURN_LIFECYCLE_METHODS and thread_id:
                minimal: JSON = {"threadId": str(thread_id)}
                if turn_id:
                    minimal["turnId"] = str(turn_id)
                self.send_payload({"kind": "codex-event", "method": method, "params": minimal}, lane="realtime")
                self._metric_inc("codex_lifecycle_events_forwarded")
            else:
                # Android only consumes codex-event for turn lifecycle state;
                # forwarding full raw app-server objects duplicated text and can
                # make an individual encrypted frame unexpectedly large.
                self._metric_inc("codex_raw_notifications_suppressed")
            event: JSON | None = None
            if method == "item/started":
                item = data.get("item") if isinstance(data.get("item"), dict) else {}
                if item and item.get("type") != "agentMessage":
                    event = {"type": "tool-call", "name": str(item.get("type", "item")), "summary": summarize(item.get("command") or item.get("name") or item, 200)}
            elif method == "item/completed":
                item = data.get("item") if isinstance(data.get("item"), dict) else {}
                if item and item.get("type") != "agentMessage":
                    event = {"type": "tool-result", "name": str(item.get("type", "item")), "summary": "completed"}
            elif method == "turn/completed":
                event = {"type": "turn-done", "reason": str(turn.get("status") or "completed")}
            if event is not None and thread_id:
                self.send_payload({"kind": "agent-event", "sessionId": str(thread_id), "agent": "codex", "event": event}, lane="realtime")
        except Exception as error:
            print(f"[host] Codex event forwarding failed: {error}", file=sys.stderr, flush=True)

    def _on_server_request(self, identifier: int | str, method: str, params: Any) -> None:
        rpc = self.rpc
        if rpc is None:
            return
        tool_name = APPROVAL_METHODS.get(method)
        if tool_name is None:
            # Avoid wedging an app-server request the mobile protocol cannot
            # represent. Approval methods are always explicitly routed below.
            rpc.respond(identifier, {})
            return
        request_id = f"codex-{now_ms()}-{secrets.token_hex(3)}"
        with self._approval_lock:
            self._approvals[request_id] = identifier
        details = params if isinstance(params, dict) else {}
        try:
            self.send_payload({
                "kind": "permission-request",
                "sessionId": str(details.get("threadId") or ""),
                "agent": "codex",
                "requestId": request_id,
                "toolName": tool_name,
                "summary": summarize(details.get("command") or details.get("reason") or details, 400),
                "options": [{"id": "allow", "label": "允许"}, {"id": "deny", "label": "拒绝"}],
            })
        except Exception as error:
            with self._approval_lock:
                self._approvals.pop(request_id, None)
            rpc.respond(identifier, {"decision": "denied"})
            print(f"[host] could not forward approval: {error}", file=sys.stderr, flush=True)

    def _invalidate_catalog(self) -> None:
        with self._catalog_lock:
            self._catalog_cache = None
            self._catalog_generation += 1
        self._metric_inc("catalog_invalidations")

    def _fetch_thread_list(self) -> list[JSON]:
        params: JSON = {
            "sourceKinds": [
                "cli", "vscode", "exec", "appServer",
                "subAgent", "subAgentReview", "subAgentCompact",
                "subAgentThreadSpawn", "subAgentOther",
            ],
            # The phone needs the whole local catalog, not merely app-server's
            # first page. Conversation bodies remain on demand via thread/read,
            # so paging the summaries here stays inexpensive.
            "limit": 100,
            "sortKey": "updated_at",
        }
        answer: list[JSON] = []
        seen_cursors: set[str] = set()
        while True:
            result = self._codex().call("thread/list", params)
            rows = result.get("data", []) if isinstance(result, dict) else []
            for row in rows if isinstance(rows, list) else []:
                if not isinstance(row, dict):
                    continue
                parent, depth, nickname = describe_source(row.get("source"))
                status = row.get("status")
                if isinstance(status, dict):
                    status = status.get("type", "unknown")
                answer.append({
                    "id": str(row.get("id", "")),
                    "preview": str(row.get("preview", "")),
                    "name": row.get("name"),
                    "cwd": row.get("cwd"),
                    "status": str(status or "unknown"),
                    "source": "subAgent" if parent else (row.get("source") if isinstance(row.get("source"), str) else None),
                    "parentThreadId": parent or row.get("parentThreadId"),
                    "agentNickname": nickname or row.get("agentNickname"),
                    "depth": depth,
                    "updatedAt": int(row.get("updatedAt") or 0) * 1000,
                    "canAcceptDirectInput": row.get("canAcceptDirectInput") is True,
                })
            next_cursor = result.get("nextCursor") if isinstance(result, dict) else None
            if not isinstance(next_cursor, str) or not next_cursor or next_cursor in seen_cursors:
                return answer
            seen_cursors.add(next_cursor)
            params["cursor"] = next_cursor

    def _thread_list(self) -> list[JSON]:
        """Return the catalog once for concurrent legacy + Codex UI requests."""
        now = time.monotonic()
        with self._catalog_lock:
            cached = self._catalog_cache
            if cached is not None and now - cached[0] < CATALOG_CACHE_SECONDS:
                self._metric_inc("catalog_cache_hits")
                return list(cached[1])
            flight = self._catalog_flight
            if flight is None:
                flight = CatalogFlight(ready=threading.Event(), generation=self._catalog_generation)
                self._catalog_flight = flight
                leader = True
            else:
                leader = False
        if not leader:
            self._metric_inc("catalog_singleflight_waiters")
            if not flight.ready.wait(CATALOG_WAIT_SECONDS):
                raise RuntimeError("Codex thread/list 等待超时")
            if flight.error:
                raise RuntimeError(flight.error)
            if flight.result is None:
                raise RuntimeError("Codex thread/list 未返回目录")
            return list(flight.result)

        started_at = time.monotonic()
        try:
            threads = self._fetch_thread_list()
        except Exception as error:
            with self._catalog_lock:
                flight.error = str(error)
            self._metric_inc("catalog_fetch_errors")
            raise
        else:
            with self._catalog_lock:
                flight.result = threads
                # Do not reintroduce a stale catalog if a live lifecycle event
                # landed while this app-server request was in flight.
                if flight.generation == self._catalog_generation:
                    self._catalog_cache = (time.monotonic(), threads)
            self._metric_inc("catalog_fetches")
            self._metric_duration_ms("catalog_fetch", started_at)
            return list(threads)
        finally:
            with self._catalog_lock:
                if self._catalog_flight is flight:
                    self._catalog_flight = None
            flight.ready.set()

    def _read_history_metadata(self, thread_id: str) -> JSON:
        """Read thread metadata without loading, resuming, or fetching turns.

        A catalog tap is observational: ``thread/resume`` subscribes this Host
        to the thread and can emit a burst of live notifications, which is the
        wrong operation for a phone simply inspecting past work. ``thread/read``
        without ``includeTurns`` is a small metadata lookup; paged body reads
        happen below through ``thread/turns/list``.
        """
        result = self._codex().call("thread/read", {"threadId": thread_id})
        if not isinstance(result, dict):
            result = {}
        thread = result.get("thread") if isinstance(result.get("thread"), dict) else {}
        return {
            "canAcceptDirectInput": thread.get("canAcceptDirectInput") is True,
            "cwd": str(thread.get("cwd") or ""),
        }

    @staticmethod
    def _history_events_for_page(thread_id: str, page_index: int, turns: list[JSON]) -> list[JSON]:
        """Normalise a descending app-server page into chronological UI events."""
        flattened = flatten_turns(list(reversed(turns)))
        events: list[JSON] = []
        # Stable ids allow a Compose LazyColumn to prepend old chunks without
        # reusing an expanded tool card for a different history item.
        for index, event in enumerate(flattened):
            text = event.get("text")
            # A very long app-server delta still needs to fit into one relay
            # frame. Text fragments merge back into one markdown block on the
            # phone, so this preserves the actual content rather than dropping
            # a history item or making the connection fail.
            if isinstance(text, str) and len(text) > HISTORY_EVENT_TEXT_CHARS:
                for part, start in enumerate(range(0, len(text), HISTORY_EVENT_TEXT_CHARS)):
                    item = dict(event)
                    item["text"] = text[start:start + HISTORY_EVENT_TEXT_CHARS]
                    item["eventId"] = f"{thread_id}:p{page_index}:{index}:{part}"
                    events.append(item)
            else:
                event["eventId"] = f"{thread_id}:p{page_index}:{index}"
                events.append(event)
        return events

    def _read_history_page(self, thread_id: str, cursor: str | None) -> tuple[list[JSON], str | None]:
        params: JSON = {
            "threadId": thread_id,
            "limit": HISTORY_TURNS_PER_PAGE,
            "sortDirection": "desc",
            "itemsView": "full",
        }
        if cursor is not None:
            params["cursor"] = cursor
        result = self._codex().call("thread/turns/list", params)
        if not isinstance(result, dict):
            raise RuntimeError("thread/turns/list returned no result")
        raw_turns = result.get("data", [])
        turns = [turn for turn in raw_turns if isinstance(turn, dict)] if isinstance(raw_turns, list) else []
        next_cursor = result.get("nextCursor")
        return turns, str(next_cursor) if isinstance(next_cursor, str) and next_cursor else None

    def _history_stream_is_current(self, thread_id: str, request_id: str) -> bool:
        with self._history_stream_lock:
            return self._history_streams.get(thread_id) == request_id

    def _begin_history_stream(self, thread_id: str, request_id: str) -> None:
        with self._history_stream_lock:
            previous = self._history_streams.get(thread_id)
            if previous and previous != request_id:
                self._history_cancelled[(thread_id, previous)] = time.monotonic()
            self._history_streams[thread_id] = request_id
        if previous and previous != request_id:
            self._metric_inc("history_reads_replaced")

    def _cancel_history(self, thread_id: str, request_id: str | None = None) -> bool:
        """Cancel only the matching read; never touch the Codex thread itself."""
        with self._history_stream_lock:
            current = self._history_streams.get(thread_id)
            if current is None or (request_id is not None and current != request_id):
                return False
            self._history_streams.pop(thread_id, None)
            self._history_cancelled[(thread_id, current)] = time.monotonic()
        self._metric_inc("history_reads_cancelled")
        return True

    def _cancel_all_history(self) -> int:
        with self._history_stream_lock:
            active = list(self._history_streams.items())
            self._history_streams.clear()
            cancelled_at = time.monotonic()
            for thread_id, request_id in active:
                self._history_cancelled[(thread_id, request_id)] = cancelled_at
        if active:
            self._metric_inc("history_reads_cancelled", len(active))
        return len(active)

    def _prune_cancelled_history(self) -> None:
        before = time.monotonic() - HISTORY_CANCEL_RETENTION_SECONDS
        with self._history_stream_lock:
            for key, cancelled_at in list(self._history_cancelled.items()):
                if cancelled_at < before:
                    self._history_cancelled.pop(key, None)

    def _queue_history_payload(self, thread_id: str, request_id: str, payload: JSON) -> bool:
        if not self._history_stream_is_current(thread_id, request_id):
            return False
        if self.send_payload(payload, lane="history"):
            return True
        # A full low-priority queue means keeping the read would only make the
        # user wait longer.  Cancel it as a unit and make retry explicit.
        self._cancel_history(thread_id, request_id)
        self.send_payload({
            "kind": "codex-error",
            "sessionId": thread_id,
            "requestId": request_id,
            "note": "历史记录传输繁忙，已暂停读取；请重新打开会话继续",
        }, lane="control")
        return False

    @staticmethod
    def _take_history_tail(events: list[JSON], max_events: int) -> list[JSON]:
        """Return a chronological tail that is safe for relay's frame limit."""
        chosen: list[JSON] = []
        encoded_size = 2  # JSON list's []
        for event in reversed(events):
            item_size = len(json.dumps(event, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
            separator = 1 if chosen else 0
            if chosen and (len(chosen) >= max_events or
                           encoded_size + separator + item_size > HISTORY_CHUNK_MAX_PAYLOAD_BYTES):
                break
            chosen.append(event)
            encoded_size += separator + item_size
        chosen.reverse()
        return chosen

    def _stream_history(self, thread_id: str, request_id: str) -> None:
        """Page persisted turns newest-first without ever resuming the thread."""
        self._begin_history_stream(thread_id, request_id)
        started_at = time.monotonic()
        acquired = False
        try:
            # A rapid tap across cards replaces the prior read.  Waiting work
            # notices that replacement before it ever sends an app-server call.
            while self._history_stream_is_current(thread_id, request_id):
                if self._history_read_slot.acquire(timeout=0.1):
                    acquired = True
                    break
                self._metric_inc("history_read_slot_waits")
            if not acquired:
                return
            metadata = self._read_history_metadata(thread_id)
            if not self._history_stream_is_current(thread_id, request_id):
                return
            turns, cursor = self._read_history_page(thread_id, None)
            page_index = 0
            events = self._history_events_for_page(thread_id, page_index, turns)
            initial = self._take_history_tail(events, HISTORY_INITIAL_EVENTS)
            earlier = events[:len(events) - len(initial)]
            loaded = len(initial)
            if not self._queue_history_payload(thread_id, request_id, {
                "kind": "codex-history-start",
                "sessionId": thread_id,
                "requestId": request_id,
                "events": initial,
                "loadedEvents": loaded,
                # Total is intentionally unknown until the cursor is exhausted.
                # `hasMore` lets the phone keep its progress animation visible.
                "totalEvents": 0,
                "hasMore": bool(earlier) or cursor is not None,
                "canAcceptDirectInput": metadata.get("canAcceptDirectInput") is True,
            }):
                return
            seen_cursors: set[str] = set()
            # The remainder of the first page, then each earlier page, is sent
            # tail-first because Android prepends every chunk.
            while self._history_stream_is_current(thread_id, request_id):
                while earlier and self._history_stream_is_current(thread_id, request_id):
                    time.sleep(HISTORY_CHUNK_DELAY_SECONDS)
                    chunk = self._take_history_tail(earlier, HISTORY_CHUNK_EVENTS)
                    earlier = earlier[:len(earlier) - len(chunk)]
                    loaded += len(chunk)
                    if not self._queue_history_payload(thread_id, request_id, {
                        "kind": "codex-history-chunk",
                        "sessionId": thread_id,
                        "requestId": request_id,
                        "events": chunk,
                        "loadedEvents": loaded,
                    }):
                        return
                if cursor is None:
                    break
                if cursor in seen_cursors:
                    raise RuntimeError("Codex history pagination cursor repeated")
                seen_cursors.add(cursor)
                page_index += 1
                turns, cursor = self._read_history_page(thread_id, cursor)
                earlier = self._history_events_for_page(thread_id, page_index, turns)
            if self._history_stream_is_current(thread_id, request_id):
                self._queue_history_payload(thread_id, request_id, {
                    "kind": "codex-history-complete",
                    "sessionId": thread_id,
                    "requestId": request_id,
                    "totalEvents": loaded,
                })
        finally:
            if acquired:
                self._history_read_slot.release()
            self._metric_duration_ms("history_read", started_at)
            with self._history_stream_lock:
                if self._history_streams.get(thread_id) == request_id:
                    self._history_streams.pop(thread_id, None)

    def _resume_for_input(self, thread_id: str) -> None:
        """Load a thread only immediately before an explicit phone message."""
        self._codex().call("thread/resume", {"threadId": thread_id})

    def _start_thread(self, cwd: str) -> str:
        result = self._codex().call("thread/start", {"cwd": cwd})
        if not isinstance(result, dict):
            raise RuntimeError("thread/start returned no result")
        thread = result.get("thread") if isinstance(result.get("thread"), dict) else {}
        identifier = thread.get("id") or result.get("threadId")
        if not identifier:
            raise RuntimeError("thread/start 未返回 threadId")
        return str(identifier)

    def _start_turn(self, thread_id: str, text: str) -> str | None:
        result = self._codex().call("turn/start", {"threadId": thread_id, "input": [{"type": "text", "text": text}]})
        if not isinstance(result, dict):
            return None
        turn = result.get("turn") if isinstance(result.get("turn"), dict) else {}
        identifier = result.get("turnId") or turn.get("id")
        return str(identifier) if identifier else None

    @staticmethod
    def _legacy_sessions(threads: list[JSON]) -> list[JSON]:
        """Project Codex threads onto the older generic session-list shape."""
        return [
            {
                "id": thread["id"],
                "title": thread.get("name") or thread.get("preview") or "Codex",
                "agent": "codex",
                "cwd": thread.get("cwd"),
                "updatedAt": thread.get("updatedAt", 0),
                "kind": "chat",
            }
            for thread in threads
        ]

    def _push_catalog(self) -> None:
        """Send the current provider's catalog without waiting for phone UI.

        The relay retains frames for the absent peer, so a phone that connects
        after the Host still receives its historical Codex directory.
        """
        try:
            threads = self._thread_list()
            self.send_payload({"kind": "session-list", "sessions": self._legacy_sessions(threads)})
            self.send_payload({"kind": "codex-thread-list", "threads": threads})
            print(f"[host] pushed initial Codex directory ({len(threads)} threads)", flush=True)
        except Exception as error:
            print(f"[host] initial directory push failed: {error}", file=sys.stderr, flush=True)

    def _handle_payload(self, payload: JSON) -> None:
        kind = payload.get("kind")
        try:
            if kind:
                print(f"[host] phone command: {kind}", flush=True)
            if kind == "echo":
                # Keep the original M1.1 link health check working. It is also
                # a compact end-to-end regression probe for a fresh pairing.
                self.send_payload({
                    "kind": "echo-ack",
                    "text": str(payload.get("text") or ""),
                    "sentAt": payload.get("sentAt"),
                    "from": device_info(),
                })
            elif kind == "codex-threads":
                threads = self._thread_list()
                self.send_payload({"kind": "codex-thread-list", "threads": threads})
                print(f"[host] sent Codex thread directory ({len(threads)} threads)", flush=True)
            elif kind == "codex-resume" and payload.get("sessionId"):
                thread_id = str(payload["sessionId"])
                request_id = str(payload.get("requestId") or secrets.token_hex(8))
                self._stream_history(thread_id, request_id)
            elif kind == "codex-history-cancel" and payload.get("sessionId"):
                # Observation-only cancellation: it never resumes, interrupts,
                # or otherwise changes the desktop Codex thread.
                self._cancel_history(
                    str(payload["sessionId"]),
                    str(payload["requestId"]) if payload.get("requestId") else None,
                )
            elif kind == "codex-input" and payload.get("sessionId") and payload.get("text"):
                thread_id = str(payload["sessionId"])
                text = str(payload["text"])
                self._cancel_history(thread_id)
                self._resume_for_input(thread_id)
                with self._turn_lock:
                    active = self._active_turns.get(thread_id)
                steered = False
                if active:
                    try:
                        self._codex().call("turn/steer", {"threadId": thread_id, "expectedTurnId": active, "input": [{"type": "text", "text": text}]})
                        steered = True
                    except Exception:
                        with self._turn_lock:
                            self._active_turns.pop(thread_id, None)
                if not steered:
                    turn_id = self._start_turn(thread_id, text)
                    if turn_id:
                        with self._turn_lock:
                            self._active_turns[thread_id] = turn_id
                self.send_payload({"kind": "input-ack", "sessionId": thread_id, "status": "running", "note": "已插话到进行中的回合" if steered else "已发送到 Codex 会话"})
            elif kind == "codex-interrupt" and payload.get("sessionId"):
                thread_id = str(payload["sessionId"])
                self._cancel_history(thread_id)
                with self._turn_lock:
                    active = self._active_turns.pop(thread_id, None)
                if not active:
                    raise RuntimeError("该会话当前没有进行中的回合")
                self._codex().call("turn/interrupt", {"threadId": thread_id, "turnId": active})
                self.send_payload({"kind": "input-ack", "sessionId": thread_id, "status": "done", "note": "已打断"})
            elif kind == "new-session" and payload.get("text"):
                if payload.get("agent") != "codex":
                    raise RuntimeError("此 Linux Host 当前只提供 Codex；请在手机端选择 Codex")
                cwd = str(payload.get("cwd") or os.environ.get("ARGUS_HOST_DEFAULT_CWD") or Path.home())
                thread_id = self._start_thread(cwd)
                self._invalidate_catalog()
                self.send_payload({"kind": "session-started", "sessionId": thread_id, "agent": "codex", "cwd": cwd, "prompt": str(payload["text"])})
                turn_id = self._start_turn(thread_id, str(payload["text"]))
                if turn_id:
                    with self._turn_lock:
                        self._active_turns[thread_id] = turn_id
                self.send_payload({"kind": "input-ack", "sessionId": thread_id, "status": "running", "note": f"已在 {cwd} 新建 Codex 会话"})
            elif kind == "permission-response" and payload.get("requestId"):
                request_id = str(payload["requestId"])
                with self._approval_lock:
                    identifier = self._approvals.pop(request_id, None)
                if identifier is not None:
                    self._codex().respond(identifier, {"decision": "approved" if payload.get("optionId") == "allow" else "denied"})
            elif kind == "list-sessions":
                # The authoritative catalog for this Host is Codex's thread
                # list.  Return it through the legacy session-list response as
                # well, so a phone always gets its first catalog even when a
                # following codex-threads request is delayed or lost.
                threads = self._thread_list()
                self.send_payload({
                    "kind": "session-list",
                    "sessions": self._legacy_sessions(threads),
                })
                print(f"[host] sent Codex directory through session-list ({len(threads)} threads)", flush=True)
            elif kind in {"user-input", "remote-control", "cloud-session"}:
                session = str(payload.get("sessionId") or "")
                self.send_payload({"kind": "input-ack", "sessionId": session, "status": "queued", "note": "该 Linux Host 请使用 Codex 会话控制"})
        except Exception as error:
            note = str(error)
            print(f"[host] command {kind or 'unknown'} failed: {note}", file=sys.stderr, flush=True)
            try:
                if kind and str(kind).startswith("codex"):
                    self.send_payload({
                        "kind": "codex-error",
                        "sessionId": str(payload.get("sessionId") or ""),
                        "requestId": str(payload.get("requestId") or ""),
                        "note": note,
                    })
                else:
                    self.send_payload({"kind": "input-ack", "sessionId": str(payload.get("sessionId") or ""), "status": "queued", "note": note})
            except Exception as response_error:
                print(f"[host] could not report command failure: {response_error}", file=sys.stderr, flush=True)

    def run(self) -> None:
        token = derive_channel_token(b64decode(str(self.peer["longTermKey"])))
        self.ws = WebSocket.connect(relay_url())
        ws = self.ws
        try:
            ws.send_json({"op": "join-chan", "token": token, "endpoint": "host"})
            joined = wait_for(ws, lambda message: message.get("op") in {"chan-joined", "error"}, 15)
            if joined.get("op") == "error":
                raise RuntimeError(f"进入设备通道失败: {joined.get('message') or joined.get('code')}")
            print(f"[host] 已连接 Android {self.peer.get('deviceName', '')}，等待 Codex 指令", flush=True)
            threading.Thread(target=self._push_catalog, name="argus-initial-catalog", daemon=True).start()
            while not STOP.is_set():
                self._flush_text_buffers()
                self._flush_outbound(ws)
                self._prune_cancelled_history()
                self._log_metrics_if_due()
                # `recv_json()` has a one-second socket timeout. Waiting on it
                # directly made several progressive history chunks pile up in
                # the outbound queue and arrive as a burst. Poll readability
                # first so worker-enqueued slices flush within ~100 ms, while
                # retaining the existing longer timeout for an actual frame.
                if not ws._buffer:
                    try:
                        readable, _, _ = select.select([ws._socket], [], [], 0.1)
                    except (OSError, ValueError) as error:
                        raise ConnectionError(f"relay socket became unavailable: {error}") from error
                    if not readable:
                        continue
                try:
                    message = ws.recv_json()
                except TimeoutError:
                    continue
                if message.get("op") == "chan-peer-left":
                    # A phone that left the detail view, disconnected, or was
                    # replaced by a reconnect no longer needs bulk history.
                    # Keep Codex itself untouched and await its next command.
                    cancelled = self._cancel_all_history()
                    if cancelled:
                        print(f"[host] cancelled {cancelled} abandoned history read(s)", flush=True)
                    continue
                if message.get("op") != "chan-data":
                    continue
                data = message.get("data")
                encrypted = data.get("enc") if isinstance(data, dict) else None
                if not isinstance(encrypted, str):
                    continue
                try:
                    payload = self.channel.open(encrypted)
                except Exception:
                    continue
                threading.Thread(target=self._handle_payload, args=(payload,), daemon=True).start()
        finally:
            if self.ws:
                self.ws.close()
            self.ws = None
            # A relay blip is transport-only.  Keep the local app-server alive
            # across the next `watch_forever()` reconnect so it cannot cancel a
            # desktop turn merely because Seoul restarted or the route flapped.


def relay_url() -> str:
    return os.environ.get("AGENTLINK_RELAY", "wss://relay.limen.codes/ws")


def newest_peer() -> JSON:
    peers = list(load_peers().values())
    if not peers:
        raise RuntimeError("尚未配对任何 Android 设备，请先运行 pair --watch")
    return max(peers, key=lambda peer: int(peer.get("pairedAt", 0)))


def watch_forever() -> None:
    host: ArgusHost | None = None
    try:
        while not STOP.is_set():
            try:
                peer = newest_peer()
                # The current one-Host policy still follows the newest pairing,
                # but a normal relay reconnect reuses its live app-server.
                if host is None or host.peer.get("fingerprint") != peer.get("fingerprint"):
                    if host and host.rpc:
                        host.rpc.stop()
                    host = ArgusHost(peer)
                host.run()
            except KeyboardInterrupt:
                break
            except Exception as error:
                if not STOP.is_set():
                    print(f"[host] relay/session ended: {error}; retrying in 5s", file=sys.stderr, flush=True)
                    STOP.wait(5)
    finally:
        if host and host.rpc:
            host.rpc.stop()


def main() -> int:
    parser = argparse.ArgumentParser(prog="argus-host", description="No-sudo encrypted Argus Host")
    parser.add_argument("command", choices=("init", "peers", "pair", "watch"))
    parser.add_argument("--watch", action="store_true", dest="watch_after_pair", help="watch after a successful pair")
    parser.add_argument("--json", action="store_true", help="print machine-readable pairing events")
    args = parser.parse_args()

    if args.command == "init":
        identity = load_or_create_identity()
        print(f"设备身份已就绪，指纹: {fingerprint(public_bytes(identity))}")
    elif args.command == "peers":
        peers = list(load_peers().values())
        if args.json:
            print(json.dumps({"type": "peers", "peers": peers}, ensure_ascii=False))
        elif not peers:
            print("尚未配对任何设备")
        else:
            for peer in peers:
                timestamp = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(int(peer.get("pairedAt", 0)) / 1000))
                print(f"{peer.get('deviceName', 'Android')} ({peer.get('platform', 'android')})  [{peer.get('fingerprint', '')}]  配对于 {timestamp}")
    elif args.command == "pair":
        pair(args.json)
        if args.watch_after_pair:
            watch_forever()
    elif args.command == "watch":
        watch_forever()
    return 0


if __name__ == "__main__":
    signal.signal(signal.SIGINT, lambda *_: STOP.set())
    signal.signal(signal.SIGTERM, lambda *_: STOP.set())
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(0)
