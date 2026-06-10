#!/usr/bin/env python3
"""
SpeedRampFree — .drfx generator
Builds 12 speed-ramp effect templates (Fusion macros wrapping a TimeStretcher)
and packages them into SpeedRampFree.drfx for DaVinci Resolve 19/20.

Architecture:
  Each preset is a MacroOperator containing one TimeStretcher node.
  The TimeStretcher's SourceTime input carries a SimpleExpression that
  analytically remaps output time -> source time based on three published
  Inspector sliders: Strength, Ramp Start, Ramp End.

  Curve families:
    sine  : r(v) = v + (A*S / (2*pi*C)) * (sin(2*pi*C*v + PH) - sin(PH))
            speed = 1 + A*S*cos(...)  -> oscillating slow/fast, monotonic
            as long as A*S <= 1. Guarantees r(0)=0, r(1)=1 (timeline integrity).
    pow_in : r(v) = (1-S)*v + S*v^P          (near-freeze start, launch out)
    pow_out: r(v) = (1-S)*v + S*(1-(1-v)^P)  (fast start, settle into slow)

  Ramp window [a,b]: identity (normal speed) outside, remap rescaled inside.
  Continuous and monotonic everywhere, clip duration unchanged.
"""

import io
import os
import zipfile

OUT_DIR = "/home/claude/speedrampfree/build"
PACK_NAME = "SpeedRampFree"

# ---------------------------------------------------------------------------
# Preset definitions
# name, family, params, defaults for (Strength, RampStart, RampEnd), tooltip
# ---------------------------------------------------------------------------
PRESETS = [
    dict(name="Cinematic Drop",  family="sine",    cyc=1, amp=0.92, ph=0.0,
         strength=1.0, a=0.10, b=0.90,
         tip="Fast in, deep slow-motion dip in the middle, fast out."),
    dict(name="Hit And Launch",  family="pow_in",  p=3.5,
         strength=1.0, a=0.15, b=1.00,
         tip="Hangs slow on the moment of impact, then launches out fast."),
    dict(name="Smooth Slow In",  family="pow_out", p=2.2,
         strength=0.75, a=0.00, b=1.00,
         tip="Plays fast, then eases gently into slow motion."),
    dict(name="Smooth Slow Out", family="pow_in",  p=2.2,
         strength=0.75, a=0.00, b=1.00,
         tip="Starts in slow motion and eases back up to speed."),
    dict(name="Epic Bullet Time", family="sine",   cyc=1, amp=0.99, ph=0.0,
         strength=1.0, a=0.25, b=0.75,
         tip="Near-freeze plateau in the center, whip-fast on both ends."),
    dict(name="Double Pump",     family="sine",    cyc=2, amp=0.90, ph=0.0,
         strength=1.0, a=0.05, b=0.95,
         tip="Two rhythmic slow-motion dips. Great for music cuts."),
    dict(name="Burst Out",       family="pow_in",  p=4.5,
         strength=1.0, a=0.00, b=0.55,
         tip="Brief hold, explosive acceleration, then normal speed."),
    dict(name="Action Ramp",     family="sine",    cyc=1, amp=0.85, ph=1.5707963,
         strength=1.0, a=0.05, b=0.95,
         tip="Slow first half building into a fast, punchy back half."),
    dict(name="Wave Ramp",       family="sine",    cyc=3, amp=0.80, ph=0.0,
         strength=1.0, a=0.00, b=1.00,
         tip="Three flowing speed waves across the clip."),
    dict(name="Snap Ramp",       family="sine",    cyc=4, amp=0.95, ph=0.0,
         strength=1.0, a=0.00, b=1.00,
         tip="Four sharp rhythmic snaps. Align cuts to your beat grid."),
    dict(name="Freeze And Fly",  family="pow_in",  p=7.0,
         strength=1.0, a=0.00, b=0.85,
         tip="Almost frozen, then takes off. Maximum drama."),
    dict(name="Gentle Flow",     family="sine",    cyc=1, amp=0.45, ph=0.0,
         strength=1.0, a=0.00, b=1.00,
         tip="Subtle breathing speed change. Cinematic, not flashy."),
]

# ---------------------------------------------------------------------------
# Expression builder
# ---------------------------------------------------------------------------

def remap_lua(preset):
    """Return the Lua snippet computing r from v (normalized window position)."""
    S = "math.min(math.max(Strength,0),1)"
    if preset["family"] == "sine":
        c, amp, ph = preset["cyc"], preset["amp"], preset["ph"]
        return (
            f"local k=({amp}*{S})/(2*math.pi*{c}); "
            f"local r=v + k*(math.sin(2*math.pi*{c}*v + {ph}) - math.sin({ph}));"
        )
    if preset["family"] == "pow_in":
        p = preset["p"]
        return f"local s={S}; local r=(1-s)*v + s*(v^{p});"
    if preset["family"] == "pow_out":
        p = preset["p"]
        return f"local s={S}; local r=(1-s)*v + s*(1-(1-v)^{p});"
    raise ValueError(preset["family"])


def source_time_expression(preset):
    """One-line Lua SimpleExpression for TimeStretcher.SourceTime."""
    remap = remap_lua(preset)
    body = (
        "(function() "
        "local t0=comp.RenderStart; "
        "local D=math.max(comp.RenderEnd-t0,1); "
        "local u=(time-t0)/D; "
        "local a=math.min(math.max(RampStart,0),0.95); "
        "local b=math.min(math.max(RampEnd,a+0.05),1); "
        "local v=math.min(math.max((u-a)/(b-a),0),1); "
        f"{remap} "
        "local g; "
        "if u<a then g=u elseif u>b then g=u else g=a+(b-a)*r end "
        "return t0 + g*D "
        "end)()"
    )
    return body


# ---------------------------------------------------------------------------
# .setting (Fusion macro) builder
# ---------------------------------------------------------------------------

SETTING_TEMPLATE = """{{
	Tools = ordered() {{
		{macro_id} = MacroOperator {{
			CtrlWZoom = false,
			NameSet = true,
			CustomData = {{
				HelpPage = "https://github.com/speedrampfree",
			}},
			Inputs = ordered() {{
				Input1 = InstanceInput {{
					SourceOp = "SRF_Retime",
					Source = "Input",
				}},
				Strength = InstanceInput {{
					SourceOp = "SRF_Retime",
					Source = "Strength",
					Default = {strength},
				}},
				RampStart = InstanceInput {{
					SourceOp = "SRF_Retime",
					Source = "RampStart",
					Default = {a},
				}},
				RampEnd = InstanceInput {{
					SourceOp = "SRF_Retime",
					Source = "RampEnd",
					Default = {b},
				}},
				InterpolateBetweenFrames = InstanceInput {{
					SourceOp = "SRF_Retime",
					Source = "InterpolateBetweenFrames",
					Name = "Motion Blend",
					Default = 1,
				}},
			}},
			Outputs = {{
				MainOutput1 = InstanceOutput {{
					SourceOp = "SRF_Retime",
					Source = "Output",
				}},
			}},
			ViewInfo = GroupInfo {{ Pos = {{ 0, 0 }} }},
			Tools = ordered() {{
				SRF_Retime = TimeStretcher {{
					CtrlWZoom = false,
					NameSet = true,
					Inputs = {{
						SourceTime = Input {{
							Value = 0,
							Expression = "{expr}",
						}},
						InterpolateBetweenFrames = Input {{ Value = 1, }},
						SampleSpread = Input {{ Value = 1, }},
						Depth = Input {{ Value = 0, }},
						Strength = Input {{ Value = {strength}, }},
						RampStart = Input {{ Value = {a}, }},
						RampEnd = Input {{ Value = {b}, }},
					}},
					ViewInfo = OperatorInfo {{ Pos = {{ 0, 16.5 }} }},
					UserControls = ordered() {{
						Strength = {{
							LINKS_Name = "Strength",
							LINKID_DataType = "Number",
							INPID_InputControl = "SliderControl",
							INP_Default = {strength},
							INP_MinScale = 0,
							INP_MaxScale = 1,
							INP_MinAllowed = 0,
							INP_MaxAllowed = 1,
							INP_Integer = false,
							ICS_ControlPage = "Controls",
							INPS_ToolTip = "{tip} 0 = no ramp, 1 = full preset intensity.",
						}},
						RampStart = {{
							LINKS_Name = "Ramp Start",
							LINKID_DataType = "Number",
							INPID_InputControl = "SliderControl",
							INP_Default = {a},
							INP_MinScale = 0,
							INP_MaxScale = 0.95,
							INP_MinAllowed = 0,
							INP_MaxAllowed = 0.95,
							INP_Integer = false,
							ICS_ControlPage = "Controls",
							INPS_ToolTip = "Where in the clip the ramp begins (0 = clip start).",
						}},
						RampEnd = {{
							LINKS_Name = "Ramp End",
							LINKID_DataType = "Number",
							INPID_InputControl = "SliderControl",
							INP_Default = {b},
							INP_MinScale = 0.05,
							INP_MaxScale = 1,
							INP_MinAllowed = 0.05,
							INP_MaxAllowed = 1,
							INP_Integer = false,
							ICS_ControlPage = "Controls",
							INPS_ToolTip = "Where in the clip the ramp ends (1 = clip end).",
						}},
					}},
				}},
			}},
		}}
	}},
	ActiveTool = "{macro_id}"
}}
"""


def macro_id_for(name):
    return "SRF_" + "".join(ch for ch in name.title() if ch.isalnum())


def build_setting(preset):
    expr = source_time_expression(preset).replace('"', '\\"')
    return SETTING_TEMPLATE.format(
        macro_id=macro_id_for(preset["name"]),
        expr=expr,
        strength=preset["strength"],
        a=preset["a"],
        b=preset["b"],
        tip=preset["tip"],
    )


# ---------------------------------------------------------------------------
# Sanity-check the math (monotonicity + endpoint integrity) in pure Python
# ---------------------------------------------------------------------------

def verify_curves():
    import math
    problems = []
    for p in PRESETS:
        S = p["strength"]
        a, b = p["a"], p["b"]

        def r(v):
            if p["family"] == "sine":
                k = (p["amp"] * S) / (2 * math.pi * p["cyc"])
                return v + k * (math.sin(2 * math.pi * p["cyc"] * v + p["ph"]) - math.sin(p["ph"]))
            if p["family"] == "pow_in":
                return (1 - S) * v + S * (v ** p["p"])
            return (1 - S) * v + S * (1 - (1 - v) ** p["p"])

        def g(u):
            if u < a or u > b:
                return u
            v = (u - a) / (b - a)
            return a + (b - a) * r(v)

        prev = -1e-9
        n = 2000
        for i in range(n + 1):
            u = i / n
            val = g(u)
            if val < prev - 1e-9:
                problems.append(f"{p['name']}: non-monotonic at u={u:.4f}")
                break
            prev = val
        if abs(g(0.0)) > 1e-9 or abs(g(1.0) - 1.0) > 1e-9:
            problems.append(f"{p['name']}: endpoints broken g(0)={g(0)} g(1)={g(1)}")
    return problems


# ---------------------------------------------------------------------------
# Package
# ---------------------------------------------------------------------------

def main():
    problems = verify_curves()
    if problems:
        for pr in problems:
            print("CURVE PROBLEM:", pr)
        raise SystemExit(1)
    print("All 12 curves verified: monotonic, g(0)=0, g(1)=1 (timeline integrity OK)")

    os.makedirs(OUT_DIR, exist_ok=True)
    settings_dir = os.path.join(OUT_DIR, "settings")
    os.makedirs(settings_dir, exist_ok=True)

    drfx_path = os.path.join(OUT_DIR, f"{PACK_NAME}.drfx")
    with zipfile.ZipFile(drfx_path, "w", zipfile.ZIP_DEFLATED) as z:
        for preset in PRESETS:
            content = build_setting(preset)
            fname = f"{preset['name']}.setting"
            # individual settings for manual install / debugging
            with open(os.path.join(settings_dir, fname), "w") as f:
                f.write(content)
            # drfx layout: Edit/Effects/<Pack>/<Preset>.setting
            z.writestr(f"Edit/Effects/{PACK_NAME}/{fname}", content)

    print(f"Wrote {drfx_path}")
    print(f"Wrote individual .setting files to {settings_dir}")


if __name__ == "__main__":
    main()
