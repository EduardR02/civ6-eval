"""Persistent Astra Python runtime. The OS sandbox, not Python restrictions, is the boundary.

Namespace and files in /workspace survive executions; reset loses only the namespace.
Top-level await works. A final expression is displayed, and display(image) emits a compressed JPEG (full=True for lossless PNG).
All live interaction is synchronous, permission-checked host RPC (no sandbox network):

    import pyautogui as pg
    image = pg.screenshot()              # PIL.Image, Civ client area only
    display(image.crop((0, 0, 600, 400)))
    pg.click(300, 250)                    # always client-relative coordinates
    state = civ.snapshot()
    help(civ)                            # discovery: bridge defines argument schemas
    child = agent.spawn("Inspect the shared screenshot", name="observer")
    result = agent.wait(id=child["id"], timeoutMs=60000)
    artifact.write(name="notes.txt", content="observations")
    rpc("history.search", query="previous turn")

civ.snapshot/inspect/rules/action and artifact/history methods accept keyword args.
Use rpc(method, dict) for every host method, including future discovery operations.
RPC can be awaited via asyncio.to_thread(rpc, method, args); calls are serialized.
No code is automatically retried. Python exceptions preserve prior side effects.
"""
import ast
import asyncio
import base64
import builtins
import collections
import inspect
import io
import json
import os
from pathlib import Path
import queue
import resource
import sys
import threading
import time
import traceback
import types
import uuid

from PIL import Image

MAX_WIRE_BYTES = 48 * 1024 * 1024
MAX_CONTENT_BYTES = 24 * 1024 * 1024
MAX_PREVIEW_BYTES = 64 * 1024
MAX_DISPLAYS = 64

# Preserve the protocol at the descriptor level: print(), C extensions, subprocesses,
# os.write(1, ...), and sys.__stdout__ all go into execution logs, never the wire.
_wire_in = os.fdopen(os.dup(0), "r", encoding="utf-8")
_wire_out = os.fdopen(os.dup(1), "w", encoding="utf-8", buffering=1)
_null = os.open(os.devnull, os.O_RDWR)
os.dup2(_null, 0)
os.dup2(_null, 1)
os.dup2(_null, 2)
os.close(_null)
_wire_lock = threading.RLock()
_rpc_lock = threading.Lock()
_rpc_sequence = 0
_requests = queue.Queue()
_rpc_replies = queue.Queue()
_transport_error = None
_loop = asyncio.new_event_loop()
asyncio.set_event_loop(_loop)
_content = []
_artifacts = []
_content_bytes = 0
_execution_dir = None

# These resource ceilings complement namespace isolation and bound accidental floods.
# Full logs are retained up to the file-size limit; exceeding it is an explicit error.
resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
resource.setrlimit(resource.RLIMIT_FSIZE, (256 * 1024 * 1024, 256 * 1024 * 1024))
resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))
resource.setrlimit(resource.RLIMIT_NPROC, (128, 128))


def _send(message):
    encoded = json.dumps(message, ensure_ascii=True, allow_nan=False, separators=(",", ":"))
    if len(encoded) > MAX_WIRE_BYTES:
        raise ValueError("RPC message exceeds the 48 MiB wire limit; share large data as artifacts")
    with _wire_lock:
        _wire_out.write(encoded + "\n")
        _wire_out.flush()


def _read():
    line = _wire_in.readline(MAX_WIRE_BYTES + 1)
    if not line:
        raise EOFError("Host closed the Python worker transport")
    if len(line) > MAX_WIRE_BYTES or not line.endswith("\n"):
        raise ValueError("Host message exceeds the JSONL size limit or is incomplete")
    message = json.loads(line)
    if not isinstance(message, dict):
        raise ValueError("Host message must be a JSON object")
    return message


def rpc(method, args=None, **kwargs):
    """Call a permission-checked host method synchronously; failures raise RuntimeError.

    rpc('civ.inspect', {'kind': 'unit', 'id': 12})
    rpc('artifact.read', name='notes.txt')
    Host schemas are authoritative; use civ.rules()/civ.inspect() for discovery.
    """
    global _rpc_sequence
    if not isinstance(method, str) or not method:
        raise TypeError("RPC method must be a nonempty string")
    if args is not None and not isinstance(args, dict):
        raise TypeError("RPC arguments must be a dict")
    payload = dict(args or {})
    if payload.keys() & kwargs.keys():
        raise TypeError("Duplicate RPC argument")
    payload.update(kwargs)
    with _rpc_lock:
        if _transport_error is not None:
            raise RuntimeError(f"Host transport is unavailable: {_transport_error}")
        _rpc_sequence += 1
        request_id = f"rpc-{_rpc_sequence}"
        _send({"type": "rpc", "id": request_id, "method": method, "args": payload})
        response = _rpc_replies.get()
        if isinstance(response, BaseException):
            raise RuntimeError(f"Host transport closed during RPC: {response}")
        if response.get("type") != "rpc_result" or response.get("id") != request_id:
            raise RuntimeError("Host returned an out-of-order RPC response")
        if "error" in response:
            raise RuntimeError(f"{method}: {response['error']}")
        return response.get("result")


class Service:
    """Named RPC namespace: service.method(**kwargs) passes keyword args unchanged."""
    def __init__(self, namespace, methods):
        self._namespace = namespace
        self._methods = methods

    def __getattr__(self, method):
        if method not in self._methods:
            raise AttributeError(f"{self._namespace} supports: {', '.join(self._methods)}")
        def call(**kwargs):
            return rpc(f"{self._namespace}.{method}", kwargs)
        call.__name__ = method
        call.__doc__ = f"Call {self._namespace}.{method}; all keyword arguments pass to the host."
        return call

    def __dir__(self):
        return list(self._methods)


class Agents:
    """Same-model subagents. Each child has a separate context and Python namespace.

    spawn(task, name=None), send(id, message), wait(id=None, ids=None,
    timeoutMs=None), list(). Share files through artifact RPC, not other workspaces.
    send queues a next-prompt message, or starts an idle agent; it does not
    interrupt or steer the current prompt or tool call.
    """
    def spawn(self, task, name=None):
        args = {"task": task}
        if name is not None:
            args["name"] = name
        return rpc("agent.spawn", args)

    def send(self, id, message):
        return rpc("agent.send", id=id, message=message)

    def wait(self, id=None, ids=None, timeoutMs=None):
        args = {}
        if id is not None:
            args["id"] = id
        if ids is not None:
            args["ids"] = ids
        if timeoutMs is not None:
            args["timeoutMs"] = timeoutMs
        return rpc("agent.wait", args)

    def list(self):
        return rpc("agent.list")


def display(value, full=False):
    """Emit a PIL image to your vision context or another value as text.

    Images are encoded as JPEG quality 85 at their native size by default
    (full=True emits lossless PNG instead). Bytes are frozen at first
    inclusion, so what reaches the model history is deterministic. Output is
    limited to 24 MiB total and 64 displays per execution. Save large
    arrays/images in /workspace instead. Full stdout/stderr logs are saved.
    """
    global _content_bytes
    if len(_content) >= MAX_DISPLAYS:
        raise ValueError("Execution exceeded 64 display outputs; save additional data to a file")
    if isinstance(value, Image.Image):
        lossless = bool(full)
        suffix = "png" if lossless else "jpg"
        image_path = _execution_dir / f"display-{len(_content) + 1}.{suffix}"
        if lossless:
            value.save(image_path, format="PNG")
        else:
            value.convert("RGB").save(image_path, format="JPEG", quality=85)
        _artifacts.append(str(image_path.relative_to('/workspace')))
        size = image_path.stat().st_size
        if _content_bytes + ((size + 2) // 3) * 4 > MAX_CONTENT_BYTES:
            raise ValueError(f"Image exceeds remaining display budget; full image saved as {image_path}")
        data = base64.b64encode(image_path.read_bytes()).decode("ascii")
        _content.append({"type": "image", "data": data, "mimeType": "image/png" if lossless else "image/jpeg"})
        _content_bytes += len(data)
        return
    if isinstance(value, str):
        text = value
    elif isinstance(value, (dict, list, tuple)):
        try:
            text = json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False)
        except (TypeError, ValueError):
            text = repr(value)
    else:
        text = repr(value)
    encoded = text.encode("utf-8", errors="replace")
    if len(encoded) > MAX_PREVIEW_BYTES:
        text_path = _execution_dir / f"display-{len(_content) + 1}.txt"
        text_path.write_bytes(encoded)
        _artifacts.append(str(text_path.relative_to('/workspace')))
        text = encoded[:MAX_PREVIEW_BYTES].decode("utf-8", errors="replace") + f"\n[truncated; full display: {text_path}]"
    if _content_bytes + len(text.encode("utf-8")) > MAX_CONTENT_BYTES:
        raise ValueError("Execution exceeded the 24 MiB display budget")
    _content_bytes += len(text.encode("utf-8"))
    _content.append({"type": "text", "text": text})


def _install_pyautogui():
    module = types.ModuleType("pyautogui", "Civ-only host desktop proxy; all coordinates are client-relative.")
    Point = collections.namedtuple("Point", "x y")
    Size = collections.namedtuple("Size", "width height")

    def screenshot(imageFilename=None, region=None):
        """Return a PIL screenshot of the Civ client area, optionally crop (x,y,w,h)."""
        result = rpc("desktop.screenshot")
        if not isinstance(result, dict) or result.get("mimeType") != "image/png":
            raise RuntimeError("Desktop screenshot did not return a PNG")
        image = Image.open(io.BytesIO(base64.b64decode(result["data"], validate=True)))
        image.load()
        image.info["window"] = result.get("window")
        if region is not None:
            if len(region) != 4 or not all(isinstance(n, int) and not isinstance(n, bool) for n in region):
                raise ValueError("region must be (x, y, width, height) in integer client pixels")
            x, y, width, height = region
            if x < 0 or y < 0 or width <= 0 or height <= 0 or x + width > image.width or y + height > image.height:
                raise ValueError("Screenshot region is outside the Civ client area")
            image = image.crop((x, y, x + width, y + height))
        if imageFilename is not None:
            image.save(imageFilename)
        return image

    def coordinates(x, y):
        if isinstance(x, (tuple, list)):
            if y is not None or len(x) != 2:
                raise TypeError("Expected x,y or one (x,y) pair")
            x, y = x
        return {"x": x, "y": y}

    def click(x=None, y=None, clicks=1, interval=0.0, button="left", duration=0.0):
        return rpc("desktop.click", **coordinates(x, y), clicks=clicks, interval=interval, button=button, duration=duration)

    def mouseDown(x=None, y=None, button="left"):
        return rpc("desktop.mouseDown", **coordinates(x, y), button=button)

    def mouseUp(x=None, y=None, button="left"):
        return rpc("desktop.mouseUp", **coordinates(x, y), button=button)

    def moveTo(x=None, y=None, duration=0.0):
        return rpc("desktop.moveTo", **coordinates(x, y), duration=duration)

    def dragTo(x=None, y=None, duration=0.0, button="left"):
        return rpc("desktop.dragTo", **coordinates(x, y), duration=duration, button=button)

    def scroll(clicks, x=None, y=None):
        return rpc("desktop.scroll", clicks=clicks, **coordinates(x, y))

    def press(keys, presses=1, interval=0.0):
        return rpc("desktop.press", keys=keys, presses=presses, interval=interval)

    def hotkey(*keys, interval=0.0):
        return rpc("desktop.hotkey", keys=list(keys), interval=interval)

    def write(message, interval=0.0):
        return rpc("desktop.write", text=message, interval=interval)

    def keyDown(key):
        return rpc("desktop.keyDown", key=key)

    def keyUp(key):
        return rpc("desktop.keyUp", key=key)

    def position(x=None, y=None):
        result = rpc("desktop.position")
        return Point(result["x"] if x is None else x, result["y"] if y is None else y)

    def size():
        result = rpc("desktop.size")
        return Size(result["width"], result["height"])

    def focus():
        return rpc("desktop.focus")

    def window():
        return rpc("desktop.window")

    for name in ("screenshot", "click", "mouseDown", "mouseUp", "moveTo", "dragTo", "scroll", "press", "hotkey", "write", "keyDown", "keyUp", "position", "size", "focus", "window"):
        setattr(module, name, locals()[name])
    module.sleep = time.sleep
    module.Point = Point
    module.Size = Size
    sys.modules["pyautogui"] = module
    return module


_namespace = {
    "__name__": "__astra__", "__builtins__": builtins,
    "rpc": rpc, "display": display,
    "civ": Service("civ", ("snapshot", "inspect", "rules", "action", "keybinds", "dismiss_notifications")),
    "agent": Agents(),
    "artifact": Service("artifact", ("read", "write", "list")),
    "history": Service("history", ("search", "read")),
    "pyautogui": _install_pyautogui(),
}


def _execute(request):
    global _content, _artifacts, _content_bytes, _execution_dir
    _content, _artifacts, _content_bytes = [], [], 0
    _execution_dir = Path("/workspace/.executions") / f"{time.time_ns()}-{uuid.uuid4().hex[:8]}"
    _execution_dir.mkdir(parents=True)
    stdout_path, stderr_path = _execution_dir / "stdout.txt", _execution_dir / "stderr.txt"
    original_stdout, original_stderr = sys.stdout, sys.stderr
    output_files = [open(stdout_path, "wb", buffering=0), open(stderr_path, "wb", buffering=0)]
    os.dup2(output_files[0].fileno(), 1)
    os.dup2(output_files[1].fileno(), 2)
    sys.stdout = io.TextIOWrapper(os.fdopen(os.dup(1), "wb", buffering=0), encoding="utf-8", errors="replace", write_through=True)
    sys.stderr = io.TextIOWrapper(os.fdopen(os.dup(2), "wb", buffering=0), encoding="utf-8", errors="replace", write_through=True)
    failed = False
    failure = None
    try:
        code = request.get("code")
        if not isinstance(code, str):
            raise TypeError("execute.code must be a string")
        tree = ast.parse(code, filename="<astra>", mode="exec")
        final_expression = bool(tree.body and isinstance(tree.body[-1], ast.Expr))
        if final_expression:
            last = tree.body[-1]
            tree.body[-1] = ast.copy_location(ast.Assign(targets=[ast.Name(id="_", ctx=ast.Store())], value=last.value), last)
            ast.fix_missing_locations(tree)
        compiled = compile(tree, "<astra>", "exec", flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)
        pending = eval(compiled, _namespace, _namespace)
        if inspect.isawaitable(pending):
            _loop.run_until_complete(pending)
        if final_expression and _namespace.get("_") is not None:
            display(_namespace["_"])
    except BaseException:
        failed = True
        failure = traceback.format_exc()
        try:
            sys.stderr.write(failure)
        except (OSError, ValueError):
            # A user may have closed stderr, or exhausted the full-log file limit.
            pass
    finally:
        for stream in (sys.stdout, sys.stderr):
            try:
                stream.flush()
            except (OSError, ValueError):
                pass
        sys.stdout, sys.stderr = original_stdout, original_stderr
        for stream in output_files:
            stream.close()
    for label, file in (("stdout", stdout_path), ("stderr", stderr_path)):
        relative = str(file.relative_to('/workspace'))
        _artifacts.append(relative)
        size = file.stat().st_size
        if size:
            with open(file, "rb") as stream:
                preview = stream.read(MAX_PREVIEW_BYTES).decode("utf-8", errors="replace")
            suffix = f"\n[truncated {size} bytes; full {label}: /workspace/{relative}]" if size > MAX_PREVIEW_BYTES else ""
            _content.append({"type": "text", "text": f"{label}:\n{preview}{suffix}"})
    if failure:
        _content.append({"type": "text", "text": f"Execution raised an exception. Namespace and earlier effects are preserved.\n{failure[-MAX_PREVIEW_BYTES:]}"})
    if not _content:
        _content.append({"type": "text", "text": "Execution completed without display output."})
    return {"content": _content, "isError": failed, "artifacts": _artifacts}


def _reader():
    global _transport_error
    try:
        while True:
            message = _read()
            if message.get("type") == "rpc_result":
                _rpc_replies.put(message)
            elif message.get("type") == "execute" and isinstance(message.get("id"), str):
                _requests.put(message)
            else:
                raise ValueError("Expected execute request or RPC response")
    except BaseException as error:
        _transport_error = error
        _rpc_replies.put(error)
        _requests.put(None)


threading.Thread(target=_reader, daemon=True, name="astra-protocol-reader").start()
_send({"type": "ready"})
while True:
    _request = _requests.get()
    if _request is None or _transport_error is not None:
        break
    try:
        _result = _execute(_request)
        _send({"type": "result", "id": _request["id"], "result": _result})
    except BaseException:
        _send({"type": "result", "id": _request["id"], "error": traceback.format_exc()[-MAX_PREVIEW_BYTES:]})
