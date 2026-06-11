#!/usr/bin/env python3
"""
VinciRamp — macOS app entry point (py2app + dev).

Frozen (py2app):
  sys.executable → .../MacOS/VinciRamp
  resources      → .../Resources/   (sys.executable/../Resources)
  ui/            → .../Resources/ui/

Dev:
  python3 Resources/app.py
  resources      → Resources/
  ui/            → Resources/ui/
"""

import os
import sys
import traceback

# ── path setup ──────────────────────────────────────────────────────
if getattr(sys, 'frozen', False):
    RESOURCES = os.path.join(os.path.dirname(sys.executable), '..', 'Resources')
else:
    RESOURCES = os.path.dirname(os.path.abspath(__file__))

sys.path.insert(0, RESOURCES)

# ── crash logging ───────────────────────────────────────────────────
_LOG_DIR = os.path.expanduser('~/Library/Logs/VinciRamp')
_LOG = os.path.join(_LOG_DIR, 'crash.log')

def _log_error(msg):
    try:
        os.makedirs(_LOG_DIR, exist_ok=True)
        with open(_LOG, 'a') as f:
            f.write(msg + '\n')
    except Exception:
        pass

# ── imports (after path is set) ─────────────────────────────────────
try:
    from apply_curve import (
        ApplyError, apply_to_item, get_context, item_uid, list_video_items, read_points,
    )
except Exception as e:
    _log_error('Failed to import apply_curve: %s\n%s' % (e, traceback.format_exc()))
    raise


def _err(e):
    if not isinstance(e, ApplyError):
        traceback.print_exc()
    return {"ok": False, "msg": str(e) if isinstance(e, ApplyError) else "Unexpected error: %s" % e}


class Api:
    def __init__(self):
        self._items = {}

    def list_timeline(self):
        try:
            _, _, timeline = get_context()
            self._items = {}
            by_track = {}
            for ti, item in list_video_items(timeline):
                uid = item_uid(item, ti)
                self._items[uid] = item
                by_track.setdefault(ti, []).append({
                    "id": uid,
                    "name": item.GetName() or "clip",
                    "start": int(item.GetStart() or 0),
                    "end": int(item.GetEnd() or 0),
                })
            tracks = [{"index": ti, "items": by_track[ti]} for ti in sorted(by_track)]
            return {
                "ok": True,
                "name": timeline.GetName() or "Timeline",
                "start": int(timeline.GetStartFrame() or 0),
                "end": int(timeline.GetEndFrame() or 0),
                "tracks": tracks,
            }
        except Exception as e:
            return _err(e)

    def get_curve(self, uid):
        try:
            item = self._items.get(uid)
            if not item:
                raise ApplyError("Clip not found — hit Refresh and reselect.")
            return {"ok": True, "points": read_points(item)}
        except Exception as e:
            return _err(e)

    def apply(self, uid, samples, points_json=None):
        try:
            item = self._items.get(uid)
            if not item:
                raise ApplyError("Clip not found — hit Refresh and reselect.")
            msg = apply_to_item(item, samples, points_json)
            return {"ok": True, "msg": msg}
        except Exception as e:
            return _err(e)


def main():
    try:
        import webview
    except ImportError:
        msg = (
            "VinciRamp needs the 'pywebview' package.\n"
            "Install it with:  pip3 install pywebview\n"
        )
        _log_error(msg)
        sys.stderr.write(msg)
        sys.exit(1)

    html = os.path.join(RESOURCES, 'ui', 'index.html')
    if not os.path.isfile(html):
        _log_error('UI file not found: %s' % html)
        sys.stderr.write('UI not found at %s\n' % html)
        sys.exit(1)

    webview.create_window(
        "VinciRamp",
        html,
        js_api=Api(),
        width=820,
        height=640,
        min_size=(580, 500),
        background_color="#0e0e10",
    )
    webview.start()


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        _log_error('Unhandled exception: %s\n%s' % (e, traceback.format_exc()))
        raise
