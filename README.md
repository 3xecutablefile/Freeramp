# SpeedRampFree v0.1 — Install & Test

One-click cinematic speed ramps for DaVinci Resolve. Drag from the Effects
Library onto any clip in the Edit page, tune three sliders in the Inspector.
Built and tested against Resolve 20.1 Studio.

## Install (10 seconds)

Double-click `SpeedRampFree.drfx`. Resolve opens and asks to install the
template bundle. Confirm, restart Resolve if prompted.

The presets appear in: **Edit page → Effects Library → Effects (Open FX /
Fusion Effects section) → SpeedRampFree**.

Manual fallback: copy the `settings/` files into
`~/Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Templates/Edit/Effects/SpeedRampFree/`
and restart Resolve.

## Use

1. Drag a preset onto a clip in the timeline (Edit page).
2. Select the clip → Inspector → Effects tab.
3. Adjust:
   - **Strength** — 0 = no ramp, 1 = full preset intensity
   - **Ramp Start / Ramp End** — position the ramp window inside the clip
     (normal 100% speed outside the window)
   - **Motion Blend** — frame interpolation for smoother slow-mo
4. The clip's duration never changes. Nothing downstream moves.

## First test protocol (please run these 5 checks)

1. Effect appears in Effects Library after install — yes/no?
2. Drop "Gentle Flow" on a 5–10s clip. Does playback visibly speed-flow?
   If the image goes black or static, the SourceTime expression failed —
   tell me and I'll switch to the keyframe-baked fallback.
3. Open Inspector — do Strength / Ramp Start / Ramp End sliders show and
   respond live?
4. Try "Epic Bullet Time" on 60fps+ footage. Check the mid-clip near-freeze.
5. Render a short export — confirm output matches the preview.

## Known limitations (honest list)

- **Audio is NOT retimed.** Fusion effects only touch video. For ramped
  clips, detach/mute clip audio and cut music to the ramp instead (this is
  also true of the paid competitor — it's a Resolve platform limit).
- Slow-mo quality depends on source frame rate. 60/120fps footage shines;
  24/30fps relies on Motion Blend frame interpolation.
- Ramps never sample outside the clip's own range (that's what guarantees
  timeline integrity), so a deep slow section is balanced by fast sections
  elsewhere in the clip.
- "Snap Ramp" is rhythmic but not yet audio-beat-synced — that's v2.

## Files

- `SpeedRampFree.drfx` — the installable bundle (this is the product)
- `settings/*.setting` — individual presets for manual install/debugging
- `preset_preview.png` — speed profile of every preset
- `generate_drfx.py` — the generator; edit PRESETS and rerun to rebuild
- `render_preview.py` — rebuilds the preview sheet

## Troubleshooting

- **Effect renders but nothing changes:** check Strength > 0 and that the
  ramp window (Start < position < End) covers part of the clip.
- **Black frames / "expression error" in console:** the Lua expression may
  need adjusting for your build — open the Fusion page on the clip, click
  the TimeStretcher node, and read the error in the console (Workspace →
  Console). Send me the exact message.
- **Choppy slow-mo:** enable Motion Blend, or set the clip's Retime Process
  to Optical Flow in Inspector → Video → Retime and Scaling (Studio).
