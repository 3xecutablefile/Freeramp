import os
import sys
import traceback

if getattr(sys, 'frozen', False):
    HERE = os.path.join(os.path.dirname(sys.executable), '..', 'Resources')
else:
    HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from apply_curve import (
    ApplyError, apply_to_item, get_context, item_uid, list_video_items, read_points,
)


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
        sys.stderr.write(
            "Speed Curve needs the 'pywebview' package.\n"
            "Install it with:  pip3 install pywebview\n"
        )
        sys.exit(1)

    webview.create_window(
        "Speed Curve",
        os.path.join(HERE, "ui", "index.html"),
        js_api=Api(),
        width=820,
        height=640,
        min_size=(580, 500),
        background_color="#1c1c20",
    )
    webview.start()


if __name__ == "__main__":
    main()
