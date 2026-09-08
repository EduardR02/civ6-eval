"""Trusted native Windows JSONL desktop service, restricted to the Civ VI client.

Only this worker imports real PyAutoGUI. The analysis worker receives a synchronous
RPC proxy. Screenshots return only the guarded game's composited client rectangle.
Coordinates are client-relative. Focus/visibility/occlusion and bounds are checked
at each input step. The reader thread gives cancellation priority over live input.
"""
import atexit
import base64
import ctypes
from ctypes import wintypes
import io
import json
import math
import os
import queue
import sys
import threading
import time
import traceback

if sys.platform != "win32":
    raise RuntimeError("The native desktop worker must run on Windows")

user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
dwmapi = ctypes.WinDLL("dwmapi", use_last_error=True)
# Do this before importing PyAutoGUI: client/screen pixels must remain physical on
# mixed-DPI monitors. ERROR_ACCESS_DENIED means awareness was already established.
user32.SetProcessDpiAwarenessContext.argtypes = [ctypes.c_void_p]
user32.SetProcessDpiAwarenessContext.restype = wintypes.BOOL
if not user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4)) and ctypes.get_last_error() != 5:
    raise ctypes.WinError(ctypes.get_last_error())

import pyautogui
from PIL import ImageGrab

pyautogui.PAUSE = 0
pyautogui.FAILSAFE = True

WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
user32.EnumWindows.argtypes = [WNDENUMPROC, wintypes.LPARAM]
user32.EnumWindows.restype = wintypes.BOOL
user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
user32.GetWindowThreadProcessId.restype = wintypes.DWORD
user32.GetClientRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
user32.GetClientRect.restype = wintypes.BOOL
user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
user32.GetWindowRect.restype = wintypes.BOOL
user32.ClientToScreen.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.POINT)]
user32.ClientToScreen.restype = wintypes.BOOL
user32.GetForegroundWindow.restype = wintypes.HWND
user32.GetAsyncKeyState.argtypes = [ctypes.c_int]
user32.GetAsyncKeyState.restype = ctypes.c_short
user32.SetForegroundWindow.argtypes = [wintypes.HWND]
user32.SetForegroundWindow.restype = wintypes.BOOL
user32.AttachThreadInput.argtypes = [wintypes.DWORD, wintypes.DWORD, wintypes.BOOL]
user32.AttachThreadInput.restype = wintypes.BOOL
user32.BringWindowToTop.argtypes = [wintypes.HWND]
user32.BringWindowToTop.restype = wintypes.BOOL
kernel32.GetCurrentThreadId.restype = wintypes.DWORD
user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
user32.IsWindowVisible.argtypes = [wintypes.HWND]
user32.IsWindowVisible.restype = wintypes.BOOL
user32.IsIconic.argtypes = [wintypes.HWND]
user32.IsIconic.restype = wintypes.BOOL
user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
user32.GetWindowTextLengthW.restype = ctypes.c_int
user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user32.GetWindowTextW.restype = ctypes.c_int
user32.WindowFromPoint.argtypes = [wintypes.POINT]
user32.WindowFromPoint.restype = wintypes.HWND
kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
kernel32.OpenProcess.restype = wintypes.HANDLE
kernel32.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
kernel32.QueryFullProcessImageNameW.restype = wintypes.BOOL
kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
kernel32.CloseHandle.restype = wintypes.BOOL
dwmapi.DwmGetWindowAttribute.argtypes = [wintypes.HWND, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD]
dwmapi.DwmGetWindowAttribute.restype = ctypes.c_long

class MouseInput(ctypes.Structure):
    _fields_ = [("dx", wintypes.LONG), ("dy", wintypes.LONG), ("mouseData", wintypes.DWORD),
                ("dwFlags", wintypes.DWORD), ("time", wintypes.DWORD), ("dwExtraInfo", ctypes.c_size_t)]

class InputUnion(ctypes.Union):
    _fields_ = [("mi", MouseInput)]

class Input(ctypes.Structure):
    _fields_ = [("type", wintypes.DWORD), ("value", InputUnion)]

user32.SendInput.argtypes = [wintypes.UINT, ctypes.POINTER(Input), ctypes.c_int]
user32.SendInput.restype = wintypes.UINT

def _mouse_event(button, down):
    flags = {"left": (0x0002, 0x0004), "right": (0x0008, 0x0010), "middle": (0x0020, 0x0040)}
    event = Input(type=0, value=InputUnion(mi=MouseInput(dwFlags=flags[button][0 if down else 1])))
    if user32.SendInput(1, ctypes.byref(event), ctypes.sizeof(Input)) != 1:
        raise RuntimeError("Windows rejected mouse input; no successful delivery was confirmed")

def _mouse_move(x, y):
    # SendInput movement updates DirectInput/raw-input consumers as well as the
    # OS cursor. SetCursorPos alone can leave Civ's UI hit-test position stale.
    left, top = user32.GetSystemMetrics(76), user32.GetSystemMetrics(77)
    width, height = user32.GetSystemMetrics(78), user32.GetSystemMetrics(79)
    event = Input(type=0, value=InputUnion(mi=MouseInput(
        dx=round((x - left) * 65535 / (width - 1)),
        dy=round((y - top) * 65535 / (height - 1)), dwFlags=0x8000 | 0x4000 | 0x0001)))
    if user32.SendInput(1, ctypes.byref(event), ctypes.sizeof(Input)) != 1:
        raise RuntimeError("Windows rejected mouse movement")

GAME_EXECUTABLES = {"civilizationvi.exe", "civilizationvi_dx12.exe"}
MAX_LINE = 1024 * 1024
_commands = queue.Queue(maxsize=256)
_cancel = threading.Event()
_closing = threading.Event()
_wire_lock = threading.Lock()
_input_lock = threading.RLock()
_state_lock = threading.Lock()
_generation = 0
_held_keys = set()
_held_buttons = set()
_held_window = None
_wire = sys.stdout
sys.stdout = sys.stderr


def _send(message):
    with _wire_lock:
        _wire.write(json.dumps(message, ensure_ascii=True, allow_nan=False, separators=(",", ":")) + "\n")
        _wire.flush()


def _pid(hwnd):
    result = wintypes.DWORD()
    if not user32.GetWindowThreadProcessId(hwnd, ctypes.byref(result)):
        raise ctypes.WinError(ctypes.get_last_error())
    return result.value


def _executable(pid):
    handle = kernel32.OpenProcess(0x1000, False, pid)
    if not handle:
        return None  # Protected unrelated processes are not candidates.
    try:
        length = wintypes.DWORD(32768)
        buffer = ctypes.create_unicode_buffer(length.value)
        if not kernel32.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(length)):
            return None
        return os.path.basename(buffer.value).lower()
    finally:
        kernel32.CloseHandle(handle)


def _windows():
    result = []
    @WNDENUMPROC
    def collect(hwnd, _):
        result.append(hwnd)
        return True
    if not user32.EnumWindows(collect, 0):
        raise ctypes.WinError(ctypes.get_last_error())
    return result


def _cloaked(hwnd):
    value = wintypes.DWORD()
    return dwmapi.DwmGetWindowAttribute(hwnd, 14, ctypes.byref(value), ctypes.sizeof(value)) == 0 and value.value != 0


def _window():
    candidates = []
    for hwnd in _windows():
        if not user32.IsWindowVisible(hwnd) or _cloaked(hwnd):
            continue
        pid = _pid(hwnd)
        executable = _executable(pid)
        if executable in GAME_EXECUTABLES:
            rect = wintypes.RECT()
            if user32.GetClientRect(hwnd, ctypes.byref(rect)) and rect.right > 0 and rect.bottom > 0:
                candidates.append((hwnd, pid, executable))
    foreground = user32.GetForegroundWindow()
    chosen = next((item for item in candidates if item[0] == foreground), None)
    if chosen is None:
        if not candidates:
            raise RuntimeError("No visible CivilizationVI.exe or CivilizationVI_DX12.exe client window was found")
        if len(candidates) != 1:
            raise RuntimeError("Multiple Civ VI windows found; focus the intended game window before continuing")
        chosen = candidates[0]
    hwnd, pid, executable = chosen
    rect = wintypes.RECT()
    origin = wintypes.POINT(0, 0)
    if not user32.GetClientRect(hwnd, ctypes.byref(rect)) or not user32.ClientToScreen(hwnd, ctypes.byref(origin)):
        raise ctypes.WinError(ctypes.get_last_error())
    title = ctypes.create_unicode_buffer(user32.GetWindowTextLengthW(hwnd) + 1)
    user32.GetWindowTextW(hwnd, title, len(title))
    return {"hwnd": hwnd, "pid": pid, "process": executable, "title": title.value,
            "left": origin.x, "top": origin.y, "width": rect.right, "height": rect.bottom,
            "foreground": foreground == hwnd, "minimized": bool(user32.IsIconic(hwnd)), "coordinateSpace": "client"}


def _release_inputs():
    global _held_window
    with _input_lock:
        # Releases must not be blocked by the emergency corner failsafe or loss of
        # foreground; otherwise cancellation can leave an OS modifier held down.
        for button in tuple(_held_buttons):
            _mouse_event(button, False)
            _held_buttons.discard(button)
        for key in tuple(_held_keys):
            pyautogui.platformModule._keyUp(key)
            _held_keys.discard(key)
        _held_window = None


atexit.register(_release_inputs)


def _guard(window, point=None, check_occlusion=False):
    if _cancel.is_set() or _closing.is_set():
        raise InterruptedError("Desktop action cancelled; held inputs are being released")
    if any(user32.GetAsyncKeyState(key) & 0x8000 for key in (0x12, 0x5B, 0x5C)):
        raise RuntimeError("A physical Alt or Windows key is held; release it before Civ input or capture")
    if user32.GetForegroundWindow() != window["hwnd"] or user32.IsIconic(window["hwnd"]):
        _release_inputs()
        raise RuntimeError("Civ VI is not the foreground window; call desktop.focus before input or capture")
    origin = wintypes.POINT(0, 0)
    rect = wintypes.RECT()
    if not user32.ClientToScreen(window["hwnd"], ctypes.byref(origin)) or not user32.GetClientRect(window["hwnd"], ctypes.byref(rect)):
        raise ctypes.WinError(ctypes.get_last_error())
    if (origin.x, origin.y, rect.right, rect.bottom) != (window["left"], window["top"], window["width"], window["height"]):
        raise RuntimeError("Civ VI client moved or resized during action; recapture and use new coordinates")
    if point is not None:
        x, y = point
        if not (0 <= x < window["width"] and 0 <= y < window["height"]):
            raise ValueError("Coordinates are outside the Civ VI client area")
        screen = wintypes.POINT(window["left"] + x, window["top"] + y)
        hit = user32.WindowFromPoint(screen)
        if not hit or _pid(hit) != window["pid"]:
            raise RuntimeError("Target point is obscured by a non-Civ window; no input was sent")
    if check_occlusion:
        for hwnd in _windows():
            if hwnd == window["hwnd"]:
                break
            if not user32.IsWindowVisible(hwnd) or user32.IsIconic(hwnd) or _cloaked(hwnd):
                continue
            other = wintypes.RECT()
            if not user32.GetWindowRect(hwnd, ctypes.byref(other)):
                raise ctypes.WinError(ctypes.get_last_error())
            overlaps = (other.left < window["left"] + window["width"] and other.right > window["left"] and
                        other.top < window["top"] + window["height"] and other.bottom > window["top"])
            if overlaps and _pid(hwnd) != window["pid"]:
                raise RuntimeError("An unrelated window overlaps the Civ client; dismiss it before capturing")


def _number(value, name, minimum, maximum, integer=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not minimum <= value <= maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}")
    if integer and int(value) != value:
        raise ValueError(f"{name} must be an integer")
    return int(value) if integer else float(value)


def _pause(seconds):
    if _cancel.wait(seconds) or _closing.is_set():
        raise InterruptedError("Desktop action cancelled")


def _point(args, window):
    current = pyautogui.position()
    x = args.get("x")
    y = args.get("y")
    x = current.x - window["left"] if x is None else _number(x, "x", 0, window["width"] - 1, True)
    y = current.y - window["top"] if y is None else _number(y, "y", 0, window["height"] - 1, True)
    _guard(window, (x, y))
    return x, y


def _move(window, target, duration):
    start = pyautogui.position()
    start = (start.x - window["left"], start.y - window["top"])
    if duration > 0:
        _guard(window, start)
    steps = max(1, math.ceil(duration * 60))
    started = time.monotonic()
    for step in range(1, steps + 1):
        fraction = step / steps
        x = round(start[0] + (target[0] - start[0]) * fraction)
        y = round(start[1] + (target[1] - start[1]) * fraction)
        _guard(window, (x, y))
        with _input_lock:
            _guard(window, (x, y))
            pyautogui.failSafeCheck()
            _mouse_move(window["left"] + x, window["top"] + y)
        _pause(max(0, started + duration * fraction - time.monotonic()))


ALLOWED_KEYS = set("abcdefghijklmnopqrstuvwxyz0123456789 `~!@#$%^&*()-_=+[]{}\\|;:'\",.<>/?")
ALLOWED_KEYS.update({"backspace", "delete", "down", "end", "enter", "esc", "escape", "home", "insert",
                     "left", "pagedown", "pageup", "pgdn", "pgup", "return", "right", "space", "tab", "up",
                     "ctrl", "ctrlleft", "ctrlright", "shift", "shiftleft", "shiftright"})
ALLOWED_KEYS.update(f"f{number}" for number in range(1, 13))


def _key(value):
    if not isinstance(value, str):
        raise TypeError("Keyboard keys must be strings")
    key = value.lower()
    if key not in ALLOWED_KEYS or key not in pyautogui.KEYBOARD_KEYS:
        raise ValueError(f"Key {value!r} is unsupported or reserved for the operating system")
    return key


def _key_effects(key):
    mapping = pyautogui.platformModule.keyboardMapping.get(key)
    if mapping is None or mapping < 0:
        raise ValueError(f"Key {key!r} is unavailable in the active keyboard layout")
    modifiers, virtual_key = divmod(mapping, 256)
    if modifiers & 6:
        raise ValueError("Characters requiring implicit Alt or Ctrl are forbidden")
    return virtual_key, bool(modifiers & 1 or pyautogui.isShiftCharacter(key))


def _validate_chord(keys):
    all_keys = set(keys) | _held_keys
    effects = [_key_effects(key) for key in all_keys]
    virtual_keys = {key for key, _ in effects}
    ctrl = bool(virtual_keys & {0x11, 0xA2, 0xA3}) or bool(user32.GetAsyncKeyState(0x11) & 0x8000)
    shift = any(implicit for _, implicit in effects) or bool(virtual_keys & {0x10, 0xA0, 0xA1}) or bool(user32.GetAsyncKeyState(0x10) & 0x8000)
    if ctrl and (shift or virtual_keys & {0x1B, 0x73, 0x43, 0x58, 0x56, 0x2D, 0x20}):
        raise ValueError("OS/window-closing and host clipboard keyboard shortcuts are forbidden")
    if shift and virtual_keys & {0x2D, 0x09}:
        raise ValueError("Host clipboard and Steam overlay keyboard shortcuts are forbidden")


def _validate_key_ownership(key):
    virtual_key, implicit_shift = _key_effects(key)
    if any(_key_effects(held)[0] == virtual_key for held in _held_keys):
        raise ValueError(f"Cannot emit already-held physical key {key!r}; keyUp first")
    if implicit_shift and user32.GetAsyncKeyState(0x10) & 0x8000:
        raise ValueError("Character would release an already-held Shift key; release Shift first")


def _key_down(window, key):
    global _held_window
    with _input_lock:
        _guard(window)
        _validate_chord([key])
        if key not in _held_keys:
            _validate_key_ownership(key)
            pyautogui.keyDown(key)
            _held_keys.add(key)
            _held_window = window["hwnd"]


def _key_up(key):
    with _input_lock:
        if key in _held_keys:
            pyautogui.platformModule._keyUp(key)
            _held_keys.discard(key)


def _mouse_down(window, button):
    global _held_window
    with _input_lock:
        point = pyautogui.position()
        _guard(window, (point.x - window["left"], point.y - window["top"]))
        _mouse_event(button, True)
        _held_buttons.add(button)
        _held_window = window["hwnd"]


def _mouse_up(button):
    with _input_lock:
        if button in _held_buttons:
            _mouse_event(button, False)
            _held_buttons.discard(button)


def _screenshot(window):
    _guard(window, check_occlusion=True)
    width, height = window["width"], window["height"]
    if width * height > 40_000_000:
        raise ValueError("Civ client screenshot exceeds 40 million pixels")
    # DirectX swap chains can return black from a window DC. Capture the composed
    # client rectangle instead, rejecting focus, geometry, or occlusion changes.
    bounds = (window["left"], window["top"], window["left"] + width, window["top"] + height)
    image = ImageGrab.grab(bbox=bounds, all_screens=True)
    try:
        _guard(window, check_occlusion=True)
        if image.size != (width, height):
            raise RuntimeError("Civ client capture dimensions changed; recapture before input")
        stream = io.BytesIO()
        image.save(stream, format="PNG")
        if stream.tell() > 24 * 1024 * 1024:
            raise ValueError("Civ screenshot PNG exceeds the 24 MiB image limit")
        return {"data": base64.b64encode(stream.getbuffer()).decode("ascii"), "mimeType": "image/png",
                "width": width, "height": height, "window": window}
    finally:
        image.close()


METHOD_ARGUMENTS = {
    "window": set(), "focus": set(), "screenshot": set(), "size": set(), "position": set(),
    "click": {"x", "y", "clicks", "interval", "button", "duration"},
    "mouseDown": {"x", "y", "button"}, "mouseUp": {"x", "y", "button"},
    "moveTo": {"x", "y", "duration"}, "dragTo": {"x", "y", "duration", "button"},
    "scroll": {"clicks", "x", "y"}, "press": {"keys", "presses", "interval"},
    "hotkey": {"keys", "interval"}, "write": {"text", "interval"}, "keyDown": {"key"}, "keyUp": {"key"},
}


def _dispatch(method, args):
    if not isinstance(method, str) or not method.startswith("desktop."):
        raise ValueError("Expected a desktop.* method")
    operation = method.removeprefix("desktop.")
    if operation not in METHOD_ARGUMENTS:
        raise ValueError(f"Unsupported desktop method: {method}")
    if not isinstance(args, dict) or args.keys() - METHOD_ARGUMENTS[operation]:
        raise ValueError(f"Unexpected arguments for {method}; allowed: {sorted(METHOD_ARGUMENTS[operation])}")
    window = _window()
    if operation == "window":
        return window
    if operation == "focus":
        if window["minimized"]:
            user32.ShowWindow(window["hwnd"], 9)
        if user32.GetForegroundWindow() != window["hwnd"]:
            current_thread = kernel32.GetCurrentThreadId()
            foreground_thread = user32.GetWindowThreadProcessId(user32.GetForegroundWindow(), None)
            attached = foreground_thread != current_thread and user32.AttachThreadInput(current_thread, foreground_thread, True)
            try:
                user32.BringWindowToTop(window["hwnd"])
                user32.SetForegroundWindow(window["hwnd"])
            finally:
                if attached:
                    user32.AttachThreadInput(current_thread, foreground_thread, False)
        for _ in range(20):
            if user32.GetForegroundWindow() == window["hwnd"]:
                return _window()
            _pause(0.025)
        raise RuntimeError("Civ VI did not become the foreground window")
    if operation == "size":
        return {"width": window["width"], "height": window["height"], "window": window}
    _guard(window)
    if operation == "screenshot":
        return _screenshot(window)
    if operation == "position":
        point = pyautogui.position()
        return {"x": point.x - window["left"], "y": point.y - window["top"], "inside": 0 <= point.x - window["left"] < window["width"] and 0 <= point.y - window["top"] < window["height"], "window": window}
    interval = _number(args.get("interval", 0), "interval", 0, 5)
    duration = _number(args.get("duration", 0), "duration", 0, 30)
    if operation in ("click", "moveTo", "dragTo", "scroll", "mouseDown", "mouseUp"):
        target = _point(args, window)
        button = args.get("button", "left")
        if button not in ("left", "middle", "right"):
            raise ValueError("button must be left, middle, or right")
        count = _number(args.get("clicks", 1), "clicks", -100 if operation == "scroll" else 1, 100, True)
        if operation == "dragTo":
            _mouse_down(window, button)
            try:
                _move(window, target, duration)
            finally:
                _mouse_up(button)
        else:
            _move(window, target, duration)
            _pause(0.5 if operation == "click" else 0.05)
            if operation == "click":
                for index in range(count):
                    _mouse_down(window, button)
                    try:
                        # A 50 ms pulse is missed by Civ's frame-polled dropdowns
                        # on the live DX12 client; preserve a visible held state.
                        _pause(0.5)
                    finally:
                        _mouse_up(button)
                    _pause(0.1)
                    if index + 1 < count:
                        _pause(interval)
            elif operation == "mouseDown":
                _mouse_down(window, button)
            elif operation == "mouseUp":
                _mouse_up(button)
            elif operation == "scroll":
                with _input_lock:
                    _guard(window, target)
                    pyautogui.scroll(count)
        return {"ok": True, "method": method, "position": {"x": target[0], "y": target[1]}, "window": window}
    if operation == "write":
        text = args.get("text")
        if not isinstance(text, str) or len(text) > 10_000 or any(ord(char) < 32 or ord(char) > 126 for char in text):
            raise ValueError("write accepts at most 10000 printable ASCII characters; use press('enter')/press('tab') explicitly")
        with _input_lock:
            for char in text:
                _validate_chord([char])
                _validate_key_ownership(char)
        for char in text:
            with _input_lock:
                _guard(window)
                _validate_chord([char])
                _validate_key_ownership(char)
                pyautogui.write(char)
            _pause(interval)
    elif operation in ("keyDown", "keyUp"):
        key = _key(args.get("key"))
        if operation == "keyDown":
            _key_down(window, key)
        else:
            _key_up(key)
    elif operation in ("press", "hotkey"):
        values = args.get("keys")
        if isinstance(values, str):
            values = [values]
        if not isinstance(values, list) or not 1 <= len(values) <= 128:
            raise ValueError("keys must be a string or a list of 1..128 keys")
        keys = [_key(value) for value in values]
        if operation == "hotkey":
            _validate_chord(keys)
            if len(keys) != len(set(keys)):
                raise ValueError("hotkey keys must be unique")
            owned = []
            try:
                for key in keys:
                    if key not in _held_keys:
                        _key_down(window, key)
                        owned.append(key)
                    _pause(interval)
                _pause(0.05)
            finally:
                for key in reversed(owned):
                    _key_up(key)
        else:
            for key in keys:
                _validate_chord([key])
            presses = _number(args.get("presses", 1), "presses", 1, 100, True)
            for index in range(presses):
                for key in keys:
                    if key in _held_keys:
                        raise ValueError(f"Cannot press already-held key {key!r}; keyUp first")
                    _key_down(window, key)
                    try:
                        _pause(0.05)
                    finally:
                        _key_up(key)
                if index + 1 < presses:
                    _pause(interval)
    return {"ok": True, "method": method, "heldKeys": sorted(_held_keys), "window": window}


def _reader():
    global _generation
    try:
        while True:
            line = sys.stdin.buffer.readline(MAX_LINE + 1)
            if not line:
                _closing.set()
                _cancel.set()
                _commands.put(None)
                return
            if len(line) > MAX_LINE or not line.endswith(b"\n"):
                while line and not line.endswith(b"\n"):
                    line = sys.stdin.buffer.readline(MAX_LINE + 1)
                print("Rejected native desktop request exceeding the 1 MiB JSONL limit", file=sys.stderr)
                continue
            request = None
            try:
                request = json.loads(line)
                if not isinstance(request, dict) or not isinstance(request.get("id"), str):
                    raise ValueError("Desktop request requires a string id")
                with _state_lock:
                    if request.get("type") in ("cancel", "close"):
                        _generation += 1
                        _cancel.set()
                        if request["type"] == "close":
                            _closing.set()
                    request["_generation"] = _generation
                if request.get("type") in ("cancel", "close"):
                    _release_inputs()
                _commands.put(request, timeout=1)
            except (ValueError, UnicodeError, queue.Full) as error:
                if isinstance(request, dict) and isinstance(request.get("id"), str):
                    _send({"type": "result", "id": request["id"], "error": f"{type(error).__name__}: {error}"})
                else:
                    print(f"Rejected malformed native desktop request: {error}", file=sys.stderr)
    except BaseException:
        _closing.set()
        _cancel.set()
        _release_inputs()
        traceback.print_exc(file=sys.stderr)
        try:
            _commands.put_nowait(None)
        except queue.Full:
            pass


def _watch_focus():
    while not _closing.wait(0.05):
        if _held_window is not None and user32.GetForegroundWindow() != _held_window:
            _release_inputs()


threading.Thread(target=_reader, daemon=True, name="desktop-reader").start()
threading.Thread(target=_watch_focus, daemon=True, name="desktop-focus-watch").start()
_send({"type": "ready"})
try:
    while True:
        request = _commands.get()
        if request is None:
            break
        try:
            kind = request.get("type")
            if kind in ("cancel", "close"):
                _release_inputs()
                with _state_lock:
                    if kind == "cancel" and not _closing.is_set() and request["_generation"] == _generation:
                        _cancel.clear()
                result = {"ok": True, "cancelled": True, "heldKeys": [], "heldButtons": []}
            elif kind == "request":
                if request["_generation"] != _generation or _cancel.is_set() or _closing.is_set():
                    raise InterruptedError("Desktop request cancelled before dispatch")
                result = _dispatch(request.get("method"), request.get("args", {}))
            else:
                raise ValueError("Expected request, cancel, or close message")
            _send({"type": "result", "id": request["id"], "result": result})
        except BaseException as error:
            _release_inputs()
            _send({"type": "result", "id": request["id"], "error": f"{type(error).__name__}: {error}"})
        if request.get("type") == "close":
            break
finally:
    _closing.set()
    _release_inputs()
