# -*- coding: utf-8 -*-
"""Helper script for dota2-mcp live Workshop Tools & in-game inspection.

Key safety invariants:
1. NEVER call UIA InvokePattern, TogglePattern, or ValuePattern (in Qt 5.15 they call
   QWidget::activateWindow -> SetForegroundWindow and switch Windows 11 virtual desktops).
   UIA is used strictly READ-ONLY to inspect widget trees and bounding rectangles.
2. All mouse clicks and keyboard input use Win32 PostMessageW directly to the target
   child HWND in client-relative coordinates.
3. Newly opened tool windows are moved to Virtual Desktop 2 via pyvda while preserving
   the user's foreground window on Desktop 1.
"""
import base64
import ctypes
import io
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from ctypes import POINTER, Structure, byref, c_int, c_long, c_uint, c_ulong, c_void_p, c_wchar_p, wintypes as W

import comtypes
import comtypes.client
from PIL import Image, ImageChops, ImageDraw, ImageStat

PANEL_URL = os.environ.get("DOTA_PANEL_URL", "http://127.0.0.1:8770")
DOTA_DEV_PY = os.environ.get(
    "DOTA_DEV_PY",
    r"C:\Users\Admin\Documents\project\dota-metamod\launch\dota_dev.py",
)

user32 = ctypes.WinDLL("user32", use_last_error=True)
gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
dwmapi = ctypes.WinDLL("dwmapi", use_last_error=True)

try:
    user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
except Exception:
    pass

WNDENUMPROC = ctypes.WINFUNCTYPE(W.BOOL, W.HWND, W.LPARAM)
user32.EnumWindows.argtypes = [WNDENUMPROC, W.LPARAM]
user32.EnumChildWindows.argtypes = [W.HWND, WNDENUMPROC, W.LPARAM]
user32.GetWindowThreadProcessId.argtypes = [W.HWND, POINTER(W.DWORD)]
user32.GetWindowThreadProcessId.restype = W.DWORD
user32.GetClassNameW.argtypes = [W.HWND, W.LPWSTR, c_int]
user32.GetWindowTextW.argtypes = [W.HWND, W.LPWSTR, c_int]
user32.GetWindowTextLengthW.argtypes = [W.HWND]
user32.GetWindowRect.argtypes = [W.HWND, POINTER(W.RECT)]
user32.IsWindowVisible.argtypes = [W.HWND]
user32.IsWindow.argtypes = [W.HWND]
user32.IsIconic.argtypes = [W.HWND]
user32.GetAncestor.argtypes = [W.HWND, W.UINT]
user32.GetAncestor.restype = W.HWND
user32.GetForegroundWindow.restype = W.HWND
user32.SetForegroundWindow.argtypes = [W.HWND]
user32.AttachThreadInput.argtypes = [W.DWORD, W.DWORD, W.BOOL]
user32.PostMessageW.argtypes = [W.HWND, W.UINT, W.WPARAM, W.LPARAM]
user32.PostMessageW.restype = W.BOOL
user32.SendMessageW.argtypes = [W.HWND, W.UINT, W.WPARAM, W.LPARAM]
user32.SendMessageW.restype = W.LPARAM
user32.PrintWindow.argtypes = [W.HWND, W.HDC, W.UINT]
user32.PrintWindow.restype = W.BOOL
user32.GetWindowDC.argtypes = [W.HWND]
user32.GetWindowDC.restype = W.HDC
user32.ReleaseDC.argtypes = [W.HWND, W.HDC]

gdi32.CreateCompatibleDC.argtypes = [W.HDC]
gdi32.CreateCompatibleDC.restype = W.HDC
gdi32.CreateCompatibleBitmap.argtypes = [W.HDC, c_int, c_int]
gdi32.CreateCompatibleBitmap.restype = W.HBITMAP
gdi32.SelectObject.argtypes = [W.HDC, W.HGDIOBJ]
gdi32.SelectObject.restype = W.HGDIOBJ
gdi32.DeleteObject.argtypes = [W.HGDIOBJ]
gdi32.DeleteDC.argtypes = [W.HDC]
gdi32.GetDIBits.argtypes = [W.HDC, W.HBITMAP, W.UINT, W.UINT, c_void_p, c_void_p, W.UINT]

kernel32.OpenProcess.argtypes = [W.DWORD, W.BOOL, W.DWORD]
kernel32.OpenProcess.restype = W.HANDLE
kernel32.QueryFullProcessImageNameW.argtypes = [W.HANDLE, W.DWORD, W.LPWSTR, POINTER(W.DWORD)]
kernel32.CloseHandle.argtypes = [W.HANDLE]

GA_ROOT = 2
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
DWMWA_CLOAKED = 14
PW_RENDERFULLCONTENT = 2

WM_SETFOCUS = 0x0007
WM_SETTEXT = 0x000C
WM_KEYDOWN = 0x0100
WM_KEYUP = 0x0101
WM_CHAR = 0x0102
WM_MOUSEMOVE = 0x0200
WM_LBUTTONDOWN = 0x0201
WM_LBUTTONUP = 0x0202
WM_LBUTTONDBLCLK = 0x0203
WM_RBUTTONDOWN = 0x0204
WM_RBUTTONUP = 0x0205
WM_MBUTTONDOWN = 0x0207
WM_MBUTTONUP = 0x0208
EM_SETSEL = 0x00B1
WM_CLEAR = 0x0303

MK_LBUTTON = 0x0001
MK_RBUTTON = 0x0002
MK_MBUTTON = 0x0010


class BITMAPINFOHEADER(Structure):
    _fields_ = [
        ("biSize", W.DWORD),
        ("biWidth", W.LONG),
        ("biHeight", W.LONG),
        ("biPlanes", W.WORD),
        ("biBitCount", W.WORD),
        ("biCompression", W.DWORD),
        ("biSizeImage", W.DWORD),
        ("biXPelsPerMeter", W.LONG),
        ("biYPelsPerMeter", W.LONG),
        ("biClrUsed", W.DWORD),
        ("biClrImportant", W.DWORD),
    ]


class BITMAPINFO(Structure):
    _fields_ = [("bmiHeader", BITMAPINFOHEADER), ("bmiColors", W.DWORD * 3)]


_proc_name_cache = {}


def proc_exe_name(pid):
    if pid in _proc_name_cache:
        return _proc_name_cache[pid]
    h = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not h:
        return ""
    buf = ctypes.create_unicode_buffer(1024)
    sz = W.DWORD(1024)
    ok = kernel32.QueryFullProcessImageNameW(h, 0, buf, byref(sz))
    kernel32.CloseHandle(h)
    name = os.path.basename(buf.value).lower() if ok else ""
    if name:
        _proc_name_cache[pid] = name
    return name


def is_target_proc(pid):
    return proc_exe_name(pid) in ("dota2.exe", "vconsole2.exe")


def hwnd_pid(hwnd):
    pid = W.DWORD()
    user32.GetWindowThreadProcessId(hwnd, byref(pid))
    return pid.value


def hwnd_class(hwnd):
    buf = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(hwnd, buf, 256)
    return buf.value


def hwnd_title(hwnd):
    n = user32.GetWindowTextLengthW(hwnd)
    if n <= 0:
        return ""
    buf = ctypes.create_unicode_buffer(n + 2)
    user32.GetWindowTextW(hwnd, buf, n + 2)
    return buf.value


def hwnd_rect(hwnd):
    rc = W.RECT()
    user32.GetWindowRect(hwnd, byref(rc))
    return {
        "left": rc.left,
        "top": rc.top,
        "right": rc.right,
        "bottom": rc.bottom,
        "width": rc.right - rc.left,
        "height": rc.bottom - rc.top,
    }


def hwnd_cloaked(hwnd):
    cloaked = c_int(0)
    try:
        dwmapi.DwmGetWindowAttribute(W.HWND(hwnd), DWMWA_CLOAKED, byref(cloaked), ctypes.sizeof(cloaked))
    except Exception:
        pass
    return int(cloaked.value)


def hwnd_desktop(hwnd):
    try:
        from pyvda import AppView
        return int(AppView(hwnd).desktop.number)
    except Exception:
        return None


def move_hwnd_to_desktop(hwnd, desktop_num):
    if not desktop_num or desktop_num < 1:
        return False
    try:
        from pyvda import AppView, VirtualDesktop, get_virtual_desktops
        while len(get_virtual_desktops()) < desktop_num:
            VirtualDesktop.create()
        AppView(hwnd).move(VirtualDesktop(desktop_num))
        return True
    except Exception:
        return False


def current_desktop_num():
    try:
        from pyvda import VirtualDesktop
        return int(VirtualDesktop.current().number)
    except Exception:
        return None


def restore_foreground(hwnd):
    if not hwnd or not user32.IsWindow(hwnd):
        return
    if user32.SetForegroundWindow(hwnd):
        return
    cur = user32.GetWindowThreadProcessId(user32.GetForegroundWindow(), None)
    me = kernel32.GetCurrentThreadId()
    user32.AttachThreadInput(me, cur, True)
    try:
        user32.SetForegroundWindow(hwnd)
    finally:
        user32.AttachThreadInput(me, cur, False)


class FocusGuard:
    """Ensures our operations never leave the user on a different virtual desktop or steal focus."""

    def __init__(self, target_desktop=2):
        self.before_fg = user32.GetForegroundWindow()
        self.before_fg_is_dota = bool(self.before_fg and is_target_proc(hwnd_pid(self.before_fg)))
        self.before_desk = current_desktop_num()
        self.target_desktop = target_desktop

    def enforce(self):
        cur_desk = current_desktop_num()
        if self.before_desk and cur_desk and cur_desk != self.before_desk:
            try:
                from pyvda import VirtualDesktop
                VirtualDesktop(self.before_desk).go()
            except Exception:
                pass
        fg = user32.GetForegroundWindow()
        if (
            self.before_fg
            and not self.before_fg_is_dota
            and fg != self.before_fg
            and is_target_proc(hwnd_pid(fg))
        ):
            restore_foreground(self.before_fg)


def enum_children(hwnd):
    children = []
    root_rc = hwnd_rect(hwnd)

    @WNDENUMPROC
    def cb(ch, _):
        rc = hwnd_rect(ch)
        if rc["width"] > 0 and rc["height"] > 0:
            children.append({
                "hwnd": int(ch),
                "className": hwnd_class(ch),
                "title": hwnd_title(ch),
                "visible": bool(user32.IsWindowVisible(ch)),
                "rect": rc,
                "relRect": {
                    "x": rc["left"] - root_rc["left"],
                    "y": rc["top"] - root_rc["top"],
                    "w": rc["width"],
                    "h": rc["height"],
                },
            })
        return True

    user32.EnumChildWindows(hwnd, cb, 0)
    return children


def classify_window(hwnd, cls, title, exe_name):
    t_low = title.lower()
    if cls == "SDL_app":
        return "game"
    if exe_name == "vconsole2.exe":
        return "vconsole"
    if "particle editor" in t_low or ".vpcf" in t_low:
        return "pet"
    if "material editor" in t_low or ".vmat" in t_low:
        return "material_editor"
    if "modeldoc" in t_low or ".vmdl" in t_low:
        return "modeldoc"
    if "hammer" in t_low or ".vmap" in t_low:
        return "hammer"
    if "asset browser" in t_low or "dota2 - " in t_low or "addons/" in t_low:
        return "asset_browser"
    # Check child classes for CQPetMainWnd etc.
    for ch in enum_children(hwnd):
        c_cls = ch["className"]
        if "CQPetMainWnd" in c_cls or "ParticlePreview" in c_cls:
            return "pet"
    if cls.startswith("Qt"):
        return "qt_tool"
    return "other"


def list_target_windows(include_children=False):
    out = []

    @WNDENUMPROC
    def cb(hwnd, _):
        if user32.GetAncestor(hwnd, GA_ROOT) != hwnd:
            return True
        pid = hwnd_pid(hwnd)
        if not is_target_proc(pid):
            return True
        cls = hwnd_class(hwnd)
        if cls in ("MSCTFIME UI", "IME", "DummyDWMListenerWindow", "WorkerW"):
            return True
        rc = hwnd_rect(hwnd)
        if rc["width"] < 80 or rc["height"] < 80:
            return True
        vis = bool(user32.IsWindowVisible(hwnd))
        cloaked = hwnd_cloaked(hwnd)
        title = hwnd_title(hwnd)
        if not vis and not cloaked and not title:
            return True
        exe_name = proc_exe_name(pid)
        kind = classify_window(hwnd, cls, title, exe_name)
        item = {
            "hwnd": int(hwnd),
            "pid": int(pid),
            "exe": exe_name,
            "kind": kind,
            "className": cls,
            "title": title,
            "visible": vis,
            "cloaked": cloaked,
            "iconic": bool(user32.IsIconic(hwnd)),
            "desktop": hwnd_desktop(hwnd),
            "rect": rc,
        }
        if include_children:
            item["children"] = enum_children(hwnd)
        out.append(item)
        return True

    user32.EnumWindows(cb, 0)
    # Sort so primary tool windows (pet, material_editor, modeldoc, hammer, asset_browser, game) come first
    priority = {
        "pet": 1,
        "material_editor": 2,
        "modeldoc": 3,
        "hammer": 4,
        "asset_browser": 5,
        "game": 6,
        "qt_tool": 7,
        "vconsole": 8,
        "other": 9,
    }
    out.sort(key=lambda w: (priority.get(w["kind"], 99), -w["rect"]["width"] * w["rect"]["height"]))
    return out


def resolve_window(selector):
    wins = list_target_windows(include_children=False)
    if not wins:
        raise RuntimeError("Не найдено ни одного окна dota2.exe / тулзов. Запущен ли клиент тулзов?")
    if selector is None or str(selector).strip() == "":
        return wins[0]
    s = str(selector).strip()
    # Direct HWND match
    try:
        target_hwnd = int(s, 0)
        for w in wins:
            if w["hwnd"] == target_hwnd:
                return w
    except ValueError:
        pass
    s_low = s.lower()
    # Alias mapping
    aliases = {
        "particle": "pet",
        "pet": "pet",
        "vpcf": "pet",
        "material": "material_editor",
        "met": "material_editor",
        "vmat": "material_editor",
        "model": "modeldoc",
        "modeldoc": "modeldoc",
        "vmdl": "modeldoc",
        "hammer": "hammer",
        "vmap": "hammer",
        "asset": "asset_browser",
        "browser": "asset_browser",
        "game": "game",
        "dota": "game",
        "sdl": "game",
    }
    mapped_kind = aliases.get(s_low)
    if mapped_kind:
        for w in wins:
            if w["kind"] == mapped_kind:
                return w
    # Exact kind match
    for w in wins:
        if w["kind"].lower() == s_low:
            return w
    # Title or className substring match
    for w in wins:
        if s_low in w["title"].lower() or s_low in w["className"].lower():
            return w
    raise RuntimeError(
        f"Окно '{selector}' не найдено. Доступные окна: "
        + ", ".join(f"{w['hwnd']} ({w['kind']}: {w['title']!r})" for w in wins)
    )


def capture_hwnd_pil(hwnd):
    rc = hwnd_rect(hwnd)
    w, h = rc["width"], rc["height"]
    if w <= 0 or h <= 0:
        raise RuntimeError(f"Окно {hwnd} имеет нулевой размер ({w}x{h})")
    hdc_win = user32.GetWindowDC(hwnd)
    if not hdc_win:
        raise RuntimeError(f"GetWindowDC({hwnd}) не удался")
    hdc_mem = gdi32.CreateCompatibleDC(hdc_win)
    hbmp = gdi32.CreateCompatibleBitmap(hdc_win, w, h)
    old = gdi32.SelectObject(hdc_mem, hbmp)
    try:
        ok = user32.PrintWindow(hwnd, hdc_mem, PW_RENDERFULLCONTENT)
        if not ok:
            user32.PrintWindow(hwnd, hdc_mem, 0)
        bmi = BITMAPINFO()
        bmi.bmiHeader.biSize = ctypes.sizeof(BITMAPINFOHEADER)
        bmi.bmiHeader.biWidth = w
        bmi.bmiHeader.biHeight = -h  # top-down DIB
        bmi.bmiHeader.biPlanes = 1
        bmi.bmiHeader.biBitCount = 32
        bmi.bmiHeader.biCompression = 0
        buf = ctypes.create_string_buffer(w * h * 4)
        gdi32.GetDIBits(hdc_mem, hbmp, 0, h, buf, byref(bmi), 0)
        img = Image.frombuffer("RGBA", (w, h), buf, "raw", "BGRA", 0, 1).convert("RGB")
        return img
    finally:
        gdi32.SelectObject(hdc_mem, old)
        gdi32.DeleteObject(hbmp)
        gdi32.DeleteDC(hdc_mem)
        user32.ReleaseDC(hwnd, hdc_win)


def find_viewport_crop(hwnd):
    """Finds the largest 3D viewport child HWND (CQToolSceneWidget) relative to hwnd."""
    children = enum_children(hwnd)
    viewports = [
        c for c in children
        if "CQToolSceneWidget" in c["className"] or "SceneWidget" in c["className"]
    ]
    if not viewports:
        return None
    viewports.sort(key=lambda c: c["relRect"]["w"] * c["relRect"]["h"], reverse=True)
    vp = viewports[0]["relRect"]
    if vp["w"] < 32 or vp["h"] < 32:
        return None
    return (vp["x"], vp["y"], vp["x"] + vp["w"], vp["y"] + vp["h"])


def apply_crop(img, hwnd, crop):
    if not crop:
        return img, None
    if crop == "viewport":
        box = find_viewport_crop(hwnd)
        if box:
            x1, y1, x2, y2 = box
            x1 = max(0, min(img.width, x1))
            y1 = max(0, min(img.height, y1))
            x2 = max(x1 + 1, min(img.width, x2))
            y2 = max(y1 + 1, min(img.height, y2))
            return img.crop((x1, y1, x2, y2)), {"left": x1, "top": y1, "right": x2, "bottom": y2, "mode": "viewport"}
        return img, None
    if isinstance(crop, (list, tuple)) and len(crop) == 4:
        x1, y1, c3, c4 = [int(v) for v in crop]
        # Support [left, top, right, bottom]
        x2 = c3 if c3 > x1 else x1 + c3
        y2 = c4 if c4 > y1 else y1 + c4
        x1 = max(0, min(img.width, x1))
        y1 = max(0, min(img.height, y1))
        x2 = max(x1 + 1, min(img.width, x2))
        y2 = max(y1 + 1, min(img.height, y2))
        return img.crop((x1, y1, x2, y2)), {"left": x1, "top": y1, "right": x2, "bottom": y2, "mode": "custom"}
    return img, None


def resize_max_dim(img, max_dim):
    if not max_dim or max_dim <= 0:
        return img
    w, h = img.size
    if w <= max_dim and h <= max_dim:
        return img
    scale = max_dim / float(max(w, h))
    nw = max(1, int(round(w * scale)))
    nh = max(1, int(round(h * scale)))
    return img.resize((nw, nh), Image.Resampling.LANCZOS)


def encode_png_b64(img):
    bio = io.BytesIO()
    img.save(bio, format="PNG", optimize=True)
    return base64.b64encode(bio.getvalue()).decode("ascii")


def cmd_window_shot(args):
    win = resolve_window(args.get("window"))
    hwnd = win["hwnd"]
    frames = max(1, min(16, int(args.get("frames") or 1)))
    interval_ms = max(30, min(2000, int(args.get("intervalMs") or 160)))
    max_dim = max(128, min(2048, int(args.get("maxDim") or 1024)))
    crop_spec = args.get("crop")

    imgs = []
    crop_used = None
    for i in range(frames):
        raw = capture_hwnd_pil(hwnd)
        cropped, crop_used = apply_crop(raw, hwnd, crop_spec)
        imgs.append(cropped)
        if i + 1 < frames:
            time.sleep(interval_ms / 1000.0)

    diffs = []
    for i in range(len(imgs) - 1):
        d = ImageChops.difference(imgs[i], imgs[i + 1]).convert("L")
        st = ImageStat.Stat(d)
        hist = d.histogram()
        total_px = max(1, d.width * d.height)
        changed_px = sum(hist[8:])
        diffs.append({
            "pair": f"{i}->{i+1}",
            "meanDiff": round(st.mean[0], 2),
            "maxDiff": int(st.extrema[0][1]),
            "changedPct": round(changed_px * 100.0 / total_px, 2),
        })

    if len(imgs) == 1:
        out_img = resize_max_dim(imgs[0], max_dim)
    else:
        # Contact sheet grid (up to 3 columns)
        cols = min(3, len(imgs))
        rows = (len(imgs) + cols - 1) // cols
        fw, fh = imgs[0].size
        sheet = Image.new("RGB", (fw * cols, fh * rows), (18, 20, 24))
        draw = ImageDraw.Draw(sheet)
        for idx, im in enumerate(imgs):
            gx = (idx % cols) * fw
            gy = (idx // cols) * fh
            sheet.paste(im, (gx, gy))
            draw.rectangle([gx + 4, gy + 4, gx + 88, gy + 24], fill=(0, 0, 0))
            draw.text((gx + 8, gy + 7), f"#{idx} ({idx * interval_ms}ms)", fill=(120, 220, 255))
        out_img = resize_max_dim(sheet, max_dim)

    luma = out_img.convert("L")
    l_stat = ImageStat.Stat(luma)
    l_hist = luma.histogram()
    non_black_pct = round(sum(l_hist[10:]) * 100.0 / max(1, luma.width * luma.height), 2)

    return {
        "ok": True,
        "window": win,
        "crop": crop_used,
        "frames": frames,
        "intervalMs": interval_ms if frames > 1 else 0,
        "imageWidth": out_img.width,
        "imageHeight": out_img.height,
        "meanLuma": round(l_stat.mean[0], 2),
        "nonBlackPct": non_black_pct,
        "frameDiffs": diffs,
        "animated": any(d["changedPct"] > 0.15 for d in diffs) if diffs else None,
        "pngBase64": encode_png_b64(out_img),
    }


# ---------- Read-only UIA tree inspection ----------

CONTROL_TYPE_NAMES = {
    50000: "Button",
    50001: "Calendar",
    50002: "CheckBox",
    50003: "ComboBox",
    50004: "Edit",
    50005: "Hyperlink",
    50006: "Image",
    50007: "ListItem",
    50008: "List",
    50009: "Menu",
    50010: "MenuBar",
    50011: "MenuItem",
    50012: "ProgressBar",
    50013: "RadioButton",
    50014: "ScrollBar",
    50015: "Slider",
    50016: "Spinner",
    50017: "StatusBar",
    50018: "Tab",
    50019: "TabItem",
    50020: "Text",
    50021: "ToolBar",
    50022: "ToolTip",
    50023: "Tree",
    50024: "TreeItem",
    50025: "Custom",
    50026: "Group",
    50027: "Thumb",
    50028: "DataGrid",
    50029: "DataItem",
    50030: "Document",
    50031: "SplitButton",
    50032: "Window",
    50033: "Pane",
    50034: "Header",
    50035: "HeaderItem",
    50036: "Table",
    50037: "TitleBar",
    50038: "Separator",
}

INTERACTIVE_TYPES = {
    "Button",
    "CheckBox",
    "ComboBox",
    "Edit",
    "Hyperlink",
    "ListItem",
    "MenuItem",
    "RadioButton",
    "Slider",
    "Spinner",
    "SplitButton",
    "TabItem",
    "TreeItem",
}


def get_uia():
    comtypes.CoInitialize()
    comtypes.client.GetModule("UIAutomationCore.dll")
    from comtypes.gen.UIAutomationClient import (
        CUIAutomation,
        IUIAutomation,
        IUIAutomationTogglePattern,
        IUIAutomationValuePattern,
        UIA_TogglePatternId,
        UIA_ValuePatternId,
    )
    uia = comtypes.client.CreateObject(CUIAutomation, interface=IUIAutomation)
    return uia, IUIAutomationTogglePattern, IUIAutomationValuePattern, UIA_TogglePatternId, UIA_ValuePatternId


def deepest_child_at(root_hwnd, children, sx, sy):
    """Finds the smallest visible native child HWND covering screen point (sx, sy)."""
    candidates = []
    for c in children:
        if not c["visible"]:
            continue
        r = c["rect"]
        if r["left"] <= sx < r["right"] and r["top"] <= sy < r["bottom"]:
            area = r["width"] * r["height"]
            candidates.append((area, c))
    if not candidates:
        rc = hwnd_rect(root_hwnd)
        return int(root_hwnd), int(sx - rc["left"]), int(sy - rc["top"])
    candidates.sort(key=lambda item: item[0])
    chosen = candidates[0][1]
    return int(chosen["hwnd"]), int(sx - chosen["rect"]["left"]), int(sy - chosen["rect"]["top"])


def walk_uia_elements(hwnd, max_depth=7, filter_str=None, interactive_only=False):
    uia, TogglePat, ValuePat, ToggleId, ValueId = get_uia()
    walker = uia.RawViewWalker
    root = uia.ElementFromHandle(W.HWND(hwnd))
    win_rc = hwnd_rect(hwnd)
    children = enum_children(hwnd)
    flt = filter_str.lower().strip() if filter_str else ""

    items = []

    def visit(el, depth, group_classes):
        if not el or depth > max_depth or len(items) >= 600:
            return
        try:
            ct = el.CurrentControlType
            ct_name = CONTROL_TYPE_NAMES.get(ct, str(ct))
            name = (el.CurrentName or "").strip()
            cls = (el.CurrentClassName or "").strip()
            aid = ""
            try:
                aid = (el.CurrentAutomationId or "").strip()
            except Exception:
                pass
            rc = el.CurrentBoundingRectangle
            l, t, r, b = int(rc.left), int(rc.top), int(rc.right), int(rc.bottom)
            w, h = r - l, b - t
        except Exception:
            return

        next_groups = list(group_classes)
        if cls and cls not in next_groups and depth > 0:
            next_groups.append(cls)

        if depth > 0 and w > 2 and h > 2:
            # Read-only toggle state & value
            toggle_state = None
            val_str = None
            try:
                tp = el.GetCurrentPattern(ToggleId)
                if tp:
                    toggle_state = int(tp.QueryInterface(TogglePat).CurrentToggleState)
            except Exception:
                pass
            try:
                vp = el.GetCurrentPattern(ValueId)
                if vp:
                    v = vp.QueryInterface(ValuePat).CurrentValue
                    if v is not None:
                        val_str = str(v)[:120]
            except Exception:
                pass

            keep = True
            if interactive_only and ct_name not in INTERACTIVE_TYPES and not name and not val_str:
                keep = False
            if flt:
                hay = f"{ct_name} {name} {cls} {aid} {val_str or ''} {' '.join(next_groups)}".lower()
                if flt not in hay:
                    keep = False

            if keep:
                cx_screen = l + w // 2
                cy_screen = t + h // 2
                thwnd, clx, cly = deepest_child_at(hwnd, children, cx_screen, cy_screen)
                items.append({
                    "index": len(items),
                    "depth": depth,
                    "controlType": ct_name,
                    "name": name,
                    "className": cls,
                    "automationId": aid,
                    "groupClasses": next_groups[-3:],
                    "toggleState": toggle_state,
                    "value": val_str,
                    "winRect": {
                        "x": l - win_rc["left"],
                        "y": t - win_rc["top"],
                        "w": w,
                        "h": h,
                    },
                    "clickPos": {
                        "x": cx_screen - win_rc["left"],
                        "y": cy_screen - win_rc["top"],
                    },
                    "targetHwnd": thwnd,
                    "clientPos": {"x": clx, "y": cly},
                })

        try:
            ch = walker.GetFirstChildElement(el)
            while ch:
                visit(ch, depth + 1, next_groups)
                ch = walker.GetNextSiblingElement(ch)
        except Exception:
            pass

    visit(root, 0, [])
    return items, children


def cmd_ui_tree(args):
    win = resolve_window(args.get("window"))
    hwnd = win["hwnd"]
    max_depth = max(1, min(14, int(args.get("maxDepth") or 7)))
    flt = args.get("filter")
    interactive_only = bool(args.get("interactiveOnly", False))
    items, children = walk_uia_elements(hwnd, max_depth=max_depth, filter_str=flt, interactive_only=interactive_only)
    return {
        "ok": True,
        "window": win,
        "count": len(items),
        "nativeChildCount": len(children),
        "nativeChildren": children[:40],
        "elements": items,
    }


def make_lparam(x, y):
    return ((int(y) & 0xFFFF) << 16) | (int(x) & 0xFFFF)


def post_mouse_click(target_hwnd, client_x, client_y, button="left", double_click=False):
    lp = make_lparam(client_x, client_y)
    user32.PostMessageW(target_hwnd, WM_MOUSEMOVE, 0, lp)
    time.sleep(0.015)
    btn = (button or "left").lower()
    if btn == "right":
        user32.PostMessageW(target_hwnd, WM_RBUTTONDOWN, MK_RBUTTON, lp)
        time.sleep(0.025)
        user32.PostMessageW(target_hwnd, WM_RBUTTONUP, 0, lp)
    elif btn == "middle":
        user32.PostMessageW(target_hwnd, WM_MBUTTONDOWN, MK_MBUTTON, lp)
        time.sleep(0.025)
        user32.PostMessageW(target_hwnd, WM_MBUTTONUP, 0, lp)
    else:
        user32.PostMessageW(target_hwnd, WM_LBUTTONDOWN, MK_LBUTTON, lp)
        time.sleep(0.025)
        user32.PostMessageW(target_hwnd, WM_LBUTTONUP, 0, lp)
        if double_click:
            time.sleep(0.03)
            user32.PostMessageW(target_hwnd, WM_LBUTTONDBLCLK, MK_LBUTTON, lp)
            time.sleep(0.025)
            user32.PostMessageW(target_hwnd, WM_LBUTTONUP, 0, lp)


def resolve_ui_target(hwnd, args):
    win_rc = hwnd_rect(hwnd)
    children = enum_children(hwnd)
    if args.get("x") is not None and args.get("y") is not None:
        wx = int(args["x"])
        wy = int(args["y"])
        sx = win_rc["left"] + wx
        sy = win_rc["top"] + wy
        thwnd, cx, cy = deepest_child_at(hwnd, children, sx, sy)
        return {
            "matchedBy": "coordinates",
            "winPos": {"x": wx, "y": wy},
            "targetHwnd": thwnd,
            "clientPos": {"x": cx, "y": cy},
            "element": None,
        }

    name_q = (args.get("name") or "").strip()
    ctrl_q = (args.get("controlType") or "").strip().lower()
    group_q = (args.get("groupClass") or "").strip().lower()
    idx = int(args.get("index") or 0)

    items, _ = walk_uia_elements(hwnd, max_depth=10, filter_str=None, interactive_only=False)
    matches = []
    q_low = name_q.lower()
    for el in items:
        if ctrl_q and el["controlType"].lower() != ctrl_q:
            continue
        if group_q and not any(group_q in g.lower() for g in el["groupClasses"]):
            continue
        if q_low:
            # Prefer exact match first, or substring match
            hay_exact = [
                el["name"].lower(),
                el["className"].lower(),
                el["automationId"].lower(),
            ]
            hay_sub = f"{el['name']} {el['className']} {el['automationId']} {el['value'] or ''}".lower()
            if q_low not in hay_exact and q_low not in hay_sub:
                continue
        matches.append(el)

    # If exact name matches exist, prioritize them unless index selects among all
    exact_matches = [m for m in matches if m["name"].lower() == q_low] if q_low else []
    pool = exact_matches if (exact_matches and idx < len(exact_matches)) else matches

    if not pool:
        raise RuntimeError(
            f"Элемент UI не найден (name={name_q!r}, controlType={ctrl_q!r}, groupClass={group_q!r}). "
            "Вызовите ui_tree, чтобы увидеть доступные элементы и координаты."
        )
    if idx < 0 or idx >= len(pool):
        raise RuntimeError(f"Индекс {idx} вне диапазона (найдено совпадений: {len(pool)})")

    chosen = pool[idx]
    return {
        "matchedBy": "uia_readonly",
        "matchCount": len(pool),
        "winPos": chosen["clickPos"],
        "targetHwnd": chosen["targetHwnd"],
        "clientPos": chosen["clientPos"],
        "element": chosen,
    }


def cmd_ui_click(args):
    guard = FocusGuard()
    try:
        win = resolve_window(args.get("window"))
        hwnd = win["hwnd"]
        target = resolve_ui_target(hwnd, args)
        post_mouse_click(
            target["targetHwnd"],
            target["clientPos"]["x"],
            target["clientPos"]["y"],
            button=args.get("button") or "left",
            double_click=bool(args.get("doubleClick", False)),
        )
        wait_ms = max(20, min(5000, int(args.get("waitMs") or 250)))
        time.sleep(wait_ms / 1000.0)
        res = {
            "ok": True,
            "window": win,
            "target": target,
        }
        if args.get("shotAfter"):
            shot = cmd_window_shot({
                "window": hwnd,
                "crop": args.get("crop"),
                "maxDim": args.get("maxDim") or 1024,
            })
            res["shot"] = shot
        return res
    finally:
        guard.enforce()


VK_MAP = {
    "enter": 0x0D,
    "return": 0x0D,
    "esc": 0x1B,
    "escape": 0x1B,
    "tab": 0x09,
    "backspace": 0x08,
    "back": 0x08,
    "delete": 0x2E,
    "del": 0x2E,
    "space": 0x20,
    "up": 0x26,
    "down": 0x28,
    "left": 0x25,
    "right": 0x27,
    "home": 0x24,
    "end": 0x23,
    "pageup": 0x21,
    "pagedown": 0x22,
    "f1": 0x70,
    "f2": 0x71,
    "f3": 0x72,
    "f4": 0x73,
    "f5": 0x74,
    "f6": 0x75,
    "f7": 0x76,
    "f8": 0x77,
    "f9": 0x78,
    "f10": 0x79,
    "f11": 0x7A,
    "f12": 0x7B,
}


def post_key(hwnd, vk):
    scan = 0
    lp_down = 1 | (scan << 16)
    lp_up = 1 | (scan << 16) | (1 << 30) | (1 << 31)
    user32.PostMessageW(hwnd, WM_KEYDOWN, vk, lp_down)
    if vk in (0x0D, 0x08, 0x09, 0x1B, 0x20):
        user32.PostMessageW(hwnd, WM_CHAR, vk, lp_down)
    time.sleep(0.015)
    user32.PostMessageW(hwnd, WM_KEYUP, vk, lp_up)


def cmd_ui_type(args):
    guard = FocusGuard()
    try:
        win = resolve_window(args.get("window"))
        hwnd = win["hwnd"]
        target = None
        target_hwnd = hwnd
        if args.get("name") or (args.get("x") is not None and args.get("y") is not None):
            target = resolve_ui_target(hwnd, args)
            target_hwnd = target["targetHwnd"]
            post_mouse_click(target_hwnd, target["clientPos"]["x"], target["clientPos"]["y"], button="left")
            time.sleep(0.06)

        if args.get("clearFirst"):
            user32.PostMessageW(target_hwnd, EM_SETSEL, 0, -1)
            user32.PostMessageW(target_hwnd, WM_CLEAR, 0, 0)
            for _ in range(40):
                post_key(target_hwnd, 0x08)

        text = args.get("text")
        if text:
            for ch in str(text):
                user32.PostMessageW(target_hwnd, WM_CHAR, ord(ch), 1)
                time.sleep(0.01)

        key = args.get("key")
        if key:
            k_low = str(key).strip().lower()
            vk = VK_MAP.get(k_low)
            if vk is None and len(k_low) == 1:
                vk = ord(k_low.upper())
            if vk is not None:
                post_key(target_hwnd, vk)

        wait_ms = max(20, min(5000, int(args.get("waitMs") or 250)))
        time.sleep(wait_ms / 1000.0)
        res = {
            "ok": True,
            "window": win,
            "target": target,
            "targetHwnd": target_hwnd,
            "typedText": text,
            "pressedKey": key,
        }
        if args.get("shotAfter"):
            res["shot"] = cmd_window_shot({
                "window": hwnd,
                "crop": args.get("crop"),
                "maxDim": args.get("maxDim") or 1024,
            })
        return res
    finally:
        guard.enforce()


# ---------- Console / Panel API ----------

def panel_post(path, payload, timeout=15):
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{PANEL_URL}{path}",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def panel_get(path, timeout=8):
    with urllib.request.urlopen(f"{PANEL_URL}{path}", timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def run_console_cmd(cmd, target="route", wait_sec=1.5):
    kind_map = {
        "route": "route",
        "client": "cl",
        "cl": "cl",
        "rcon": "rcon",
        "server": "rcon",
        "lua": "lua",
        "cl_wait": "cl_wait",
    }
    kind = kind_map.get((target or "route").lower(), "route")
    try:
        res = panel_post("/api/cmd", {"text": cmd, "cmd": cmd, "kind": kind, "wait": float(wait_sec)}, timeout=max(10, int(wait_sec) + 8))
        return res
    except Exception as e:
        # Fallback to dota_dev.py CLI if panel isn't running
        sub_cmd = "console" if kind in ("route", "rcon") else ("cl" if kind in ("cl", "cl_wait") else "lua")
        proc = subprocess.run(
            [sys.executable, DOTA_DEV_PY, sub_cmd, cmd],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=20,
        )
        return {
            "ok": proc.returncode == 0,
            "text": (proc.stdout + ("\n" + proc.stderr if proc.stderr else "")).strip(),
            "fallback": f"dota_dev.py ({e})",
        }


def cmd_console(args):
    cmd = (args.get("cmd") or "").strip()
    if not cmd:
        raise RuntimeError("Параметр cmd пуст")
    target = args.get("target") or "route"
    wait_sec = float(args.get("waitSec") or 1.5)
    return run_console_cmd(cmd, target=target, wait_sec=wait_sec)


# ---------- tools_open (open_asset / show_tool with Desktop 2 guard) ----------

def cmd_tools_open(args):
    path = (args.get("path") or "").strip().replace("\\", "/")
    tool = (args.get("tool") or "").strip()
    target_desktop = int(args.get("desktop") if args.get("desktop") is not None else 2)
    wait_ms = max(300, min(15000, int(args.get("waitMs") or 3000)))

    if not path and not tool:
        raise RuntimeError("Укажите path (путь к ассету, например particles/.../foo.vpcf) или tool (например pet, met, modeldoc_editor)")

    # Strip trailing _c so open_asset opens the source/compiled asset properly in Workshop Tools
    if path.endswith("_c"):
        path = path[:-2]

    guard = FocusGuard(target_desktop=target_desktop)
    before_wins = {w["hwnd"]: w["title"] for w in list_target_windows(include_children=False)}

    cmds_sent = []
    if tool:
        c = f"show_tool {tool}"
        run_console_cmd(c, target="client")
        cmds_sent.append(c)
    if path:
        c = f"open_asset {path}"
        run_console_cmd(c, target="client")
        cmds_sent.append(c)

    base_name = os.path.basename(path).lower() if path else ""
    stem_name = os.path.splitext(base_name)[0].lower() if base_name else ""

    deadline = time.time() + (wait_ms / 1000.0)
    moved_hwnds = []
    matched_win = None

    while time.time() < deadline:
        cur_wins = list_target_windows(include_children=False)
        for w in cur_wins:
            h = w["hwnd"]
            is_new = h not in before_wins
            title_changed = (h in before_wins and w["title"] != before_wins[h])
            if is_new and w["kind"] != "game" and target_desktop >= 2:
                if w.get("desktop") != target_desktop:
                    if move_hwnd_to_desktop(h, target_desktop):
                        moved_hwnds.append(h)
                        w["desktop"] = target_desktop
                guard.enforce()
            if stem_name and (stem_name in w["title"].lower()):
                matched_win = w
            elif is_new and w["kind"] != "game":
                matched_win = w
            elif title_changed and w["kind"] != "game":
                matched_win = w
        guard.enforce()
        if matched_win and time.time() > (deadline - (wait_ms / 1000.0) + 0.8):
            break
        time.sleep(0.08)

    # Final sweep of all tool windows onto target_desktop if SDL_app is on target_desktop
    final_wins = list_target_windows(include_children=False)
    for w in final_wins:
        if w["kind"] != "game" and w["exe"] == "dota2.exe" and target_desktop >= 2:
            if w.get("desktop") not in (None, target_desktop):
                if move_hwnd_to_desktop(w["hwnd"], target_desktop):
                    moved_hwnds.append(w["hwnd"])
                    w["desktop"] = target_desktop
    guard.enforce()

    if not matched_win:
        # Try matching by extension -> kind
        ext_kind = None
        if path.endswith(".vpcf"):
            ext_kind = "pet"
        elif path.endswith(".vmat"):
            ext_kind = "material_editor"
        elif path.endswith(".vmdl"):
            ext_kind = "modeldoc"
        elif path.endswith(".vmap"):
            ext_kind = "hammer"
        for w in final_wins:
            if ext_kind and w["kind"] == ext_kind:
                matched_win = w
                break

    res = {
        "ok": True,
        "commandsSent": cmds_sent,
        "targetDesktop": target_desktop,
        "movedHwnds": moved_hwnds,
        "window": matched_win,
        "allWindows": final_wins,
    }
    if args.get("shotAfter", True) and matched_win:
        time.sleep(0.35)
        try:
            res["shot"] = cmd_window_shot({
                "window": matched_win["hwnd"],
                "crop": args.get("crop"),
                "maxDim": args.get("maxDim") or 1024,
            })
        except Exception as e:
            res["shotError"] = str(e)
    return res


# ---------- particle_shot (PET 3D viewport or In-Game Lua spawn + burst capture) ----------

def cmd_particle_shot(args):
    vpcf = (args.get("vpcf") or "").strip().replace("\\", "/")
    if not vpcf:
        raise RuntimeError("Укажите vpcf (например particles/units/heroes/hero_lina/lina_spell_light_strike_array.vpcf)")
    if vpcf.endswith("_c"):
        vpcf = vpcf[:-2]

    mode = (args.get("mode") or "auto").strip().lower()
    frames = max(1, min(16, int(args.get("frames") or 6)))
    interval_ms = max(40, min(1000, int(args.get("intervalMs") or 150)))
    max_dim = max(256, min(2048, int(args.get("maxDim") or 1280)))
    duration = float(args.get("duration") or 3.0)

    guard = FocusGuard()
    try:
        # Decide between 'pet' and 'ingame' when mode == 'auto'
        chosen_mode = mode
        if chosen_mode == "auto":
            wins = list_target_windows(include_children=False)
            has_pet = any(w["kind"] == "pet" for w in wins)
            if has_pet:
                chosen_mode = "pet"
            else:
                try:
                    st = panel_get("/api/status", timeout=3)
                    gs = ((st.get("server") or {}).get("game_state") or "")
                    has_game = any(w["kind"] == "game" for w in wins)
                    if "GAME_IN_PROGRESS" in gs and has_game:
                        chosen_mode = "ingame"
                    else:
                        chosen_mode = "pet"
                except Exception:
                    chosen_mode = "pet"

        if chosen_mode == "pet":
            open_res = cmd_tools_open({
                "path": vpcf,
                "desktop": 2,
                "waitMs": 3200,
                "shotAfter": False,
            })
            pet_win = open_res.get("window")
            if not pet_win:
                pet_win = resolve_window("pet")
            hwnd = pet_win["hwnd"]
            time.sleep(0.5)
            # Click 'Restart' button inside CQParticlePreview via PostMessageW so burst particles replay from t=0
            restarted = False
            try:
                target = resolve_ui_target(hwnd, {"name": "Restart", "groupClass": "CQParticlePreview"})
                post_mouse_click(target["targetHwnd"], target["clientPos"]["x"], target["clientPos"]["y"])
                restarted = True
                time.sleep(0.06)
            except Exception:
                pass
            shot = cmd_window_shot({
                "window": hwnd,
                "crop": args.get("crop") or "viewport",
                "frames": frames,
                "intervalMs": interval_ms,
                "maxDim": max_dim,
            })
            shot["mode"] = "pet"
            shot["vpcf"] = vpcf
            shot["restartedPreview"] = restarted
            return shot

        # In-game mode: spawn particle via Server Lua at hero/origin, move camera, and burst-capture SDL_app
        game_win = resolve_window("game")
        cp0 = args.get("cp0")
        cp1 = args.get("cp1")
        extra_lua = args.get("extraLua") or ""
        cp0_lua = (
            f"Vector({float(cp0[0])}, {float(cp0[1])}, {float(cp0[2])})"
            if isinstance(cp0, (list, tuple)) and len(cp0) == 3
            else "(hero and hero:GetAbsOrigin() or Vector(0, 0, 128))"
        )
        cp1_lua = (
            f"ParticleManager:SetParticleControl(p, 1, Vector({float(cp1[0])}, {float(cp1[1])}, {float(cp1[2])}))"
            if isinstance(cp1, (list, tuple)) and len(cp1) == 3
            else ""
        )
        # Dota's Lua rejects empty statements (";;" -> "unexpected symbol near ';'"),
        # so optional parts are only joined in when they are non-empty.
        optional_lua = "; ".join(
            s.strip().rstrip(";").strip()
            for s in (cp1_lua, extra_lua)
            if s.strip().rstrip(";").strip()
        )
        lua_parts = [
            "local hero = PlayerResource:GetSelectedHeroEntity(0)",
            f"local pos = {cp0_lua}",
            "SendToConsole(string.format('dota_camera_set_lookatpos %.1f %.1f', pos.x, pos.y))",
            f"local p = ParticleManager:CreateParticle('{vpcf}', PATTACH_WORLDORIGIN, nil)",
            "ParticleManager:SetParticleControl(p, 0, pos)",
        ]
        if optional_lua:
            lua_parts.append(optional_lua)
        lua_parts += [
            "local ent = hero or Entities:First()",
            "if ent then ent:SetContextThink('mcp_pshot_' .. tostring(p), function() "
            "ParticleManager:DestroyParticle(p, false); ParticleManager:ReleaseParticleIndex(p); return nil "
            f"end, {max(0.5, duration):.2f}) end",
            "print('[MCP_PARTICLE_SHOT] spawned id=' .. tostring(p))",
        ]
        lua_code = "; ".join(lua_parts)
        lua_res = run_console_cmd(lua_code, target="lua")
        time.sleep(0.12)
        shot = cmd_window_shot({
            "window": game_win["hwnd"],
            "crop": args.get("crop"),
            "frames": frames,
            "intervalMs": interval_ms,
            "maxDim": max_dim,
        })
        shot["mode"] = "ingame"
        shot["vpcf"] = vpcf
        shot["luaResult"] = lua_res
        return shot
    finally:
        guard.enforce()


def main():
    # The Node caller spawns us with `-I` (isolated), which makes Python ignore
    # PYTHONIOENCODING; stdout then falls back to the console codepage (cp1251
    # on this box) and would crash on non-ASCII results (e.g. Greek bot names in
    # RCON `status`). Force UTF-8 so json.dumps(ensure_ascii=False) can't raise.
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "Usage: live_helper.py <action> [json_args]"}))
        sys.exit(1)
    action = sys.argv[1]
    raw_args = sys.argv[2] if len(sys.argv) > 2 else "{}"
    try:
        args = json.loads(raw_args) if raw_args else {}
        if action == "window_list":
            wins = list_target_windows(include_children=bool(args.get("includeChildren", False)))
            res = {"ok": True, "count": len(wins), "windows": wins}
        elif action == "window_shot":
            res = cmd_window_shot(args)
        elif action == "ui_tree":
            res = cmd_ui_tree(args)
        elif action == "ui_click":
            res = cmd_ui_click(args)
        elif action == "ui_type":
            res = cmd_ui_type(args)
        elif action == "console":
            res = cmd_console(args)
        elif action == "tools_open":
            res = cmd_tools_open(args)
        elif action == "particle_shot":
            res = cmd_particle_shot(args)
        else:
            res = {"ok": False, "error": f"Unknown action: {action}"}
    except Exception as e:
        res = {"ok": False, "error": str(e)}
    try:
        sys.stdout.write(json.dumps(res, ensure_ascii=False))
    except UnicodeEncodeError:
        sys.stdout.write(json.dumps(res, ensure_ascii=True))
    sys.stdout.flush()


if __name__ == "__main__":
    main()
