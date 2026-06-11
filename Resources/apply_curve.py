import base64
import json
import os
import subprocess
import sys
import tempfile

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


def get_source_path(item):
    try:
        props = item.GetClipProperty() or {}
        for key in ("File Path", "File path", "file path"):
            if key in props and props[key]:
                return props[key]
        if "File Name" in props:
            return props["File Name"]
    except Exception:
        pass
    return None


def render_preview(item, samples, uid):
    tmp = tempfile.NamedTemporaryFile(suffix=".mp4", delete=False)
    output = tmp.name
    tmp.close()

    if not samples or len(samples) < 2:
        raise ApplyError("No curve to preview.")

    source = get_source_path(item)
    if not source or not os.path.isfile(source):
        raise ApplyError("Source file not found: %s" % (source or "unknown"))

    try:
        subprocess.run(["ffmpeg", "-version"], capture_output=True, check=True)
    except (FileNotFoundError, subprocess.CalledProcessError):
        raise ApplyError("FFmpeg not found. Install it: brew install ffmpeg")

    duration = int(item.GetDuration() or 0)
    preview_frames = min(90, max(15, duration // 4))

    n = len(samples)
    seg_frames = preview_frames / (n - 1)

    parts = []
    for i in range(n - 1):
        avg_speed = (samples[i] + samples[i + 1]) / 2.0 / 100.0
        avg_speed = max(0.01, avg_speed)
        s = int(i * seg_frames)
        e = int((i + 1) * seg_frames) if i < n - 2 else preview_frames
        parts.append(
            "[0:v]trim=start_frame=%d:end_frame=%d,setpts=PTS/%.2f[v%d]"
            % (s, e, avg_speed, i)
        )

    concat_in = "".join("[v%d]" % i for i in range(n - 1))
    parts.append("%sconcat=n=%d:v=1:a=0[v]" % (concat_in, n - 1))
    filter_complex = ";".join(parts)

    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height,r_frame_rate",
         "-of", "csv=p=0", source],
        capture_output=True, text=True
    )
    dims = probe.stdout.strip().split(",") if probe.returncode == 0 else []
    if len(dims) >= 2:
        w, h = int(dims[0]), int(dims[1])
        max_w = 320
        if w > max_w:
            h = int(h * max_w / w)
            w = max_w
        scale = "scale=%d:%d:flags=bicubic," % (w, h if h % 2 == 0 else h + 1)
    else:
        scale = ""

    cmd = [
        "ffmpeg", "-y",
        "-i", source,
        "-filter_complex", scale + filter_complex,
        "-map", "[v]",
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-crf", "30",
        "-pix_fmt", "yuv420p",
        "-an",
        output
    ]

    result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    if result.returncode != 0:
        os.unlink(output)
        raise ApplyError("FFmpeg preview failed: %s" % result.stderr[-200:])

    with open(output, "rb") as f:
        b64 = base64.b64encode(f.read()).decode("ascii")
    os.unlink(output)
    return "data:video/mp4;base64," + b64


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
