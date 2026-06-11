import json
import os
import sys

NODE_NAME = "SpeedCurveRetime"
POINTS_KEY = "SpeedCurvePoints"


class ApplyError(RuntimeError):
    pass


def get_resolve():
    candidates = [
        "/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting/Modules",
        os.path.expandvars(r"%PROGRAMDATA%\Blackmagic Design\DaVinci Resolve\Support\Developer\Scripting\Modules"),
        "/opt/resolve/Developer/Scripting/Modules",
    ]
    for p in candidates:
        if p and os.path.isdir(p) and p not in sys.path:
            sys.path.append(p)
    try:
        import DaVinciResolveScript as dvr
    except ImportError:
        raise ApplyError("Could not import DaVinciResolveScript. Is DaVinci Resolve Studio installed?")
    resolve = dvr.scriptapp("Resolve")
    if not resolve:
        raise ApplyError("Could not connect to Resolve. Make sure Resolve is running and "
                         "Preferences > System > General > 'External scripting using' is set to Local.")
    return resolve


def get_context():
    resolve = get_resolve()
    project = resolve.GetProjectManager().GetCurrentProject()
    if not project:
        raise ApplyError("No project open.")
    timeline = project.GetCurrentTimeline()
    if not timeline:
        raise ApplyError("No timeline open.")
    return resolve, project, timeline


def item_uid(item, track_index):
    try:
        uid = item.GetUniqueId()
        if uid:
            return str(uid)
    except Exception:
        pass
    return "v%d:%s:%s" % (track_index, item.GetStart(), item.GetName() or "")


def list_video_items(timeline):
    count = int(timeline.GetTrackCount("video") or 0)
    for ti in range(1, count + 1):
        for item in (timeline.GetItemListInTrack("video", ti) or []):
            if item:
                yield ti, item


def sample_speed(samples, u):
    n = len(samples)
    if n == 1:
        return samples[0]
    u = min(max(u, 0.0), 1.0)
    f = u * (n - 1)
    i = int(f)
    if i >= n - 1:
        return samples[-1]
    t = f - i
    return samples[i] * (1.0 - t) + samples[i + 1] * t


def find_tool(comp, reg_ids):
    tools = comp.GetToolList(False) or {}
    for _, tool in tools.items():
        attrs = tool.GetAttrs() or {}
        if attrs.get("TOOLS_RegID") in reg_ids:
            return tool
    return None


def remove_existing(comp):
    tools = comp.GetToolList(False) or {}
    for _, tool in tools.items():
        attrs = tool.GetAttrs() or {}
        if attrs.get("TOOLS_Name") == NODE_NAME:
            tool.Delete()


def read_points(item):
    try:
        if (item.GetFusionCompCount() or 0) < 1:
            return None
        comp = item.GetFusionCompByIndex(1)
        data = comp.GetData(POINTS_KEY) if comp else None
        return data if data else None
    except Exception:
        return None


def apply_to_item(item, samples, points_json=None):
    if not samples or len(samples) < 2:
        raise ApplyError("Curve has no samples.")
    samples = [min(max(float(s), 0.0), 600.0) for s in samples]

    name = item.GetName() or "clip"

    comp_count = item.GetFusionCompCount() or 0
    comp = item.GetFusionCompByIndex(1) if comp_count >= 1 else item.AddFusionComp()
    if not comp:
        raise ApplyError("Could not open a Fusion comp on '%s'." % name)

    comp_attrs = comp.GetAttrs() or {}
    rs = comp_attrs.get("COMPN_RenderStart")
    re_ = comp_attrs.get("COMPN_RenderEnd")
    if rs is None or re_ is None:
        rs, re_ = 0, int(item.GetDuration() or 0) - 1
    rs, re_ = int(rs), int(re_)
    duration = re_ - rs + 1
    if duration < 2:
        raise ApplyError("Clip is too short to ramp (%d frame)." % duration)

    media_out = find_tool(comp, ("MediaOut", "Saver"))
    media_in = find_tool(comp, ("MediaIn", "Loader"))
    if not media_out:
        raise ApplyError("No MediaOut node found in the clip's Fusion comp.")

    comp.Lock()
    try:
        comp.StartUndo("Speed Curve")
        remove_existing(comp)

        out_in = media_out.FindMainInput(1)
        upstream = out_in.GetConnectedOutput() if out_in else None

        ts = comp.AddTool("TimeStretcher", -32768, -32768)
        if not ts:
            raise ApplyError("Could not create TimeStretcher node.")
        ts.SetAttrs({"TOOLS_Name": NODE_NAME})

        ts_in = ts.FindMainInput(1)
        src_out = upstream if upstream else (media_in.FindMainOutput(1) if media_in else None)
        if ts_in and src_out:
            ts_in.ConnectTo(src_out)
        if out_in:
            out_in.ConnectTo(ts.FindMainOutput(1))

        try:
            ts.InterpolateBetweenFrames = 1
        except Exception:
            pass

        spline = None
        for args in ((), ({},)):
            try:
                spline = comp.BezierSpline(*args)
                if spline:
                    break
            except Exception:
                continue
        if not spline:
            raise ApplyError("Could not create an animation spline (comp.BezierSpline).")
        try:
            ts.SourceTime = spline
        except Exception:
            raise ApplyError("Could not attach the animation spline to SourceTime.")

        src = 0.0
        for f in range(duration):
            u = f / (duration - 1.0)
            ts.SourceTime[rs + f] = rs + src
            src += sample_speed(samples, u) / 100.0

        if points_json:
            try:
                comp.SetData(POINTS_KEY, points_json)
            except Exception:
                pass

        comp.EndUndo(True)
    finally:
        comp.Unlock()

    try:
        if (item.GetProperty("RetimeProcess") or 0) == 0:
            item.SetProperty("RetimeProcess", 3)
    except Exception:
        pass

    avg = sum(samples) / len(samples)
    consumed = src
    msg = "Applied to '%s' — %d frames keyframed, avg speed %.0f%%." % (name, duration, avg)
    if consumed > duration + 0.5:
        msg += (" Note: curve consumes ~%.0f source frames in a %d-frame slot; "
                "the clip will hold its last frame once source runs out (unless handles exist)."
                % (consumed, duration))
    return msg


def apply_samples(samples):
    _, _, timeline = get_context()
    item = timeline.GetCurrentVideoItem()
    if not item:
        raise ApplyError("No clip under the playhead.")
    return apply_to_item(item, samples)


def main():
    if len(sys.argv) < 2:
        print("usage: apply_curve.py curve.json")
        sys.exit(1)
    with open(sys.argv[1]) as f:
        payload = json.load(f)
    try:
        print(apply_samples(payload.get("samples") or []))
    except ApplyError as e:
        print("ERROR: %s" % e)
        sys.exit(1)


if __name__ == "__main__":
    main()
