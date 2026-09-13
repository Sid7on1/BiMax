# Method — how these numbers were obtained

Written so the findings can be re-run and disputed.

## Capture
- **Stills**: `screencapture -x -o -R<x,y,w,h>` at the window rect. Retina ⇒ **2× native pixels**;
  every value reported in **pt** is native ÷ 2.
- **Motion**: `ffmpeg -f avfoundation -framerate 60 -i "<screen>" -vf crop=<window>` → h264 crf 22–24,
  then per-frame analysis in numpy. **60fps ⇒ 16.7ms resolution.** Durations are ±1 frame.
- **Driving the UI**: computer-use MCP clicks. AppleScript `System Events click at {x,y}` was tried and
  is a **no-op** on this macOS — every click below went through the MCP.
- **Measurement**: PIL + numpy. Colours are sampled pixels. Element bounds come from connected-component
  labelling of the chrome band, not from eyeballing a screenshot.

## Two traps hit, and how they were caught
1. **The MCP screenshot tool returns an empty desktop** even for granted, frontmost apps — a real bug in
   this build. Everything visual here therefore comes from `screencapture`, not from the MCP.
2. **The first recording captured the wrong window.** The terminal had come forward over the Claude
   window, so the crop framed the terminal and the clicks landed in it. Fixed by verifying frame 0 of
   every recording before analysing it. *Any motion number produced without that check is worthless.*

## Controls that make the material findings valid
- **Translucency** is tested by **moving the window** and re-sampling the same window-relative pixels,
  with a **same-position control** to rule out an animated background. Without that control, an
  animated gradient is indistinguishable from vibrancy.
- **Motion** was measured with **Reduce Motion verified OFF** (`reduceMotion=0`, `reduceTransparency`
  unset, `NSAutomaticWindowAnimationsEnabled` unset). Otherwise "this app doesn't animate" would have
  been an accessibility artifact, not a design choice.

## Honest limits
- **60fps** cannot resolve a curve shorter than ~17ms; single-frame transitions are reported as
  "instant", meaning ≤16.7ms, not literally zero.
- **Codex was in native fullscreen**, so its chrome (traffic lights, corner radius) was not comparable;
  it was temporarily un-fullscreened for the material test and **restored exactly as found**.
- **Type ramps, hover/press/focus states and light mode were not captured for any of the three apps.**
- **Reduce Motion / Reduce Transparency live toggle was not run** — `com.apple.universalaccess` is
  SIP-protected and cannot be written from the CLI.
- Apple's own docs could not be fetched (client-side rendered). See `05-apple/SOURCES.md`.

## Privacy
Window-only crops; no full-desktop shots were kept in this folder. Personal content visible inside the
apps was not transcribed into any notes. `*.png` is gitignored — notes commit, screenshots do not.
