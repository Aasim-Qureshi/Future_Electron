"""
Helpers for certificate PDF save from Chrome's built-in viewer.

- JSON payloads from page.evaluate: nodriver often returns RemoteObject instead of
  a plain dict when await_promise=True; returning JSON.stringify(...) fixes that.
- Windows OS-level Ctrl+S: CDP key events sometimes never reach the PDF plugin;
  SendInput/keybd_event targets the real foreground window after bring_to_front.
"""

from __future__ import annotations

import asyncio
import json
import sys


def normalize_evaluate_json_result(result) -> dict | None:
    """Turn nodriver evaluate return value into a dict when JS used JSON.stringify."""
    if isinstance(result, dict):
        return result
    if isinstance(result, str):
        try:
            out = json.loads(result)
            return out if isinstance(out, dict) else None
        except json.JSONDecodeError:
            return None
    if result is not None and hasattr(result, "value"):
        v = getattr(result, "value", None)
        if isinstance(v, dict):
            return v
        if isinstance(v, str):
            try:
                out = json.loads(v)
                return out if isinstance(out, dict) else None
            except json.JSONDecodeError:
                return None
    if result is not None and hasattr(result, "deep_serialized_value"):
        dsv = result.deep_serialized_value
        if dsv is not None and hasattr(dsv, "value"):
            v = dsv.value
            if isinstance(v, dict):
                return v
            if isinstance(v, str):
                try:
                    out = json.loads(v)
                    return out if isinstance(out, dict) else None
                except json.JSONDecodeError:
                    return None
    return None


def os_hotkey_ctrl_s() -> bool:
    """Send Ctrl+S to the foreground window (Windows only)."""
    if not sys.platform.startswith("win"):
        return False
    try:
        import ctypes

        user32 = ctypes.windll.user32
        VK_CONTROL = 0x11
        VK_S = 0x53
        KEYEVENTF_KEYUP = 0x0002

        user32.keybd_event(VK_CONTROL, 0, 0, 0)
        user32.keybd_event(VK_S, 0, 0, 0)
        user32.keybd_event(VK_S, 0, KEYEVENTF_KEYUP, 0)
        user32.keybd_event(VK_CONTROL, 0, KEYEVENTF_KEYUP, 0)
        return True
    except Exception:
        return False


async def async_os_hotkey_ctrl_s() -> bool:
    return await asyncio.to_thread(os_hotkey_ctrl_s)
