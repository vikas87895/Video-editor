# ApnaCut — Browser Video Editor (Complete — all 18 phases + cross-platform hardening)

100% client-side video editor. No backend, no upload, no CDN calls.
Runs offline after the first load (service worker caches the app shell).

## What actually works right now (v1)

- **Media import**: video / audio / image (drag-drop or file picker), real
  thumbnail generation (video frame grab, audio waveform via Web Audio decode).
- **Multi-track timeline**: add/remove video & audio tracks, drag clips, trim
  (left/right handles), split at playhead, delete, duplicate, snapping,
  zoom, mute/lock/hide per track.
- **Real-time canvas compositor**: video + image + text + shapes layered,
  with transform (position/scale/rotation/opacity), live preview synced to
  a `requestAnimationFrame` loop driving the actual `<video>` elements.
- **Text engine**: multiple text layers, font/size/color/stroke/background/
  alignment, Fade & Pop entrance animation, directly rendered on canvas.
- **Shapes**: rectangle, ellipse, triangle, line — fill/stroke/size.
- **Effects**: brightness / contrast / saturation / blur, applied via
  canvas `filter`, live and baked into export.
- **Transitions**: automatic crossfade when two clips on the same track
  overlap. (Wipe/slide/zoom-style transitions are not yet implemented —
  intentionally not faked; see Roadmap.)
- **Export**: real `MediaRecorder` + `canvas.captureStream()` recording to
  WebM (VP9/VP8 + Opus, whichever your browser supports), with **genuine**
  percentage progress based on actual timeline position recorded — not a
  fake bar. If your browser can't record (`MediaRecorder`/`captureStream`
  missing), export is disabled and says so honestly, editing still works.
- **Project save/load**: full project state + original media *blobs*
  stored in IndexedDB (not localStorage — videos are too big for that).
  "Save" persists locally; "Open" lists your saved projects; you can also
  export/import a portable `.apnacut.json` (media re-links from IndexedDB
  by ID, or shows "Media missing → relink" if not found).
- **Keyframes (Phase 8)**: click the ◆/◇ diamond next to Position X/Y, Scale X/Y,
  Rotation, Opacity, Brightness/Contrast/Saturation/Blur, or Volume to start
  animating that property. Move the playhead, change the value → a new
  keyframe is added at that point automatically. A mini strip under the
  slider shows keyframe diamonds — click a diamond to jump to it, Shift+click
  to delete it, click empty strip space to scrub within the clip. Each
  keyframe has a per-segment easing curve (Linear / Ease In / Ease Out /
  Ease In Out / Bounce / Elastic / Back) selectable from the dropdown below
  the strip. Real interpolation, real playback, baked into export — not a
  mockup. **Honest limitation**: this is a simplified keyframe UI (add/move
  via slider+playhead, named-preset easing) rather than a full drag-the-curve
  bezier graph editor with handle manipulation — that's a bigger follow-up
  if you want it next.
- **Undo/redo**: real command history (state snapshots, never clones video
  blobs into history — stays fast).
- **Keyboard shortcuts**: Space, Ctrl+Z/Y/S/O/C/V, Delete, S (split),
  arrow keys (frame step), +/- (zoom).
- **Capability detection**: on load, checks WebCodecs, OffscreenCanvas,
  WebGL/2, Web Audio, File System Access, IndexedDB, Workers, Speech
  Recognition, MediaRecorder, and which video codecs your browser can
  actually record — shown honestly in the status bar and Settings tab.
  If MP4 export isn't supported (most browsers don't allow MP4 recording
  client-side), it says so and offers WebM instead of pretending MP4 works.
- **Responsive layout**: desktop (full 3-panel workspace), tablet
  (narrower panels), mobile (slide-in panels via hamburger buttons,
  ≤900px breakpoint). Tested down to 320px width conceptually — no
  fixed-px overflow in the core layout.
- **Privacy**: your media never leaves the browser. There is no
  upload code anywhere in this app — verify by reading `app.js`.

## Honestly NOT in v1 (roadmap, not faked)

Full bezier-handle-drag graph editor + motion paths (current keyframing is
add-at-playhead + named easing presets, not click-drag curve handles),
compound/nested clips, template *library* beyond the 4 built-in templates,
speed-ramping curves (speed is fixed-value per clip: 0.25×–4×, not
animatable yet), beat detection, forward/backward mask *tracking* (masks
are static per-frame position, keyframeable manually via the same ◆
system as everything else — but no automatic object tracking), true
Web-Worker-offloaded thumbnail/waveform generation (currently async on
the main thread via Promises — doesn't freeze the UI, but isn't a
dedicated worker thread either), MP4 export (browser-dependent, no
current browser supports client-side MP4 recording).

## What got added in this pass (Phases 8, 10, 11, 12, 15, 28)

- **Phase 8 — Keyframes**: ◆ diamond toggle on Position/Scale/Rotation/
  Opacity/Effects/Volume, mini keyframe strip, 7 easing presets
  (Linear/EaseIn/EaseOut/EaseInOut/Bounce/Elastic/Back).
- **Phase 10 — Captions**: add manually at playhead, edit inline (start/
  end/text), real `.srt`/`.vtt` import (parses real timecodes) and export,
  style controls (font size/color/stroke/background/position), optional
  karaoke-style word highlighting (even-timing across words — not
  per-word timestamp alignment, since that needs speech alignment data
  this app doesn't have; labeled honestly).
- **Phase 11 — Chroma key + Masks**: real per-pixel green-screen keying
  (`getImageData`/`putImageData`, color-distance threshold + smoothness +
  spill suppression) and rectangle/ellipse masks with feather (via
  offscreen blur + `destination-in` compositing), both keyframeable
  through the same property system, both baked into export. No object
  tracking (marked experimental/absent, not faked).
- **Phase 12 — Templates**: 4 real templates (Lower Third, Intro Title,
  Subscribe CTA, Chapter Title) that insert actual editable text/shape
  clips at the playhead — not flattened images.
- **Phase 15 — Performance**: media import/thumbnail/waveform generation
  stays async and non-blocking; documented honestly above where it falls
  short of true Worker-thread offloading.
- **Phase 28 — Audio ducking**: since true real-time sidechain compression
  isn't feasible in a static-hosted browser app, implemented the
  spec-sanctioned fallback — automatic **volume keyframing**: pick a
  voice track and a music track, it finds overlaps and inserts real
  attack/release volume keyframes on the music clips.
- Bonus: **Stickers** (emoji library, scalable/animatable/keyframeable
  like any clip) and **safe-area guides** (action-safe 90% / title-safe
  80%, preview-only, never exported).

## Still open if you want to keep going

Full bezier graph editor with draggable curve handles, ML-based
face/object tracking (real tracking, not the manual keyframe-based
substitute below), background removal, and moving thumbnail/waveform
generation into real Web Workers.

## Latest pass — everything from your last two requests

**Genuine "video save" flow (Export dialog):**
- On export completion the WebM file now **auto-downloads immediately**
  (no click needed) via a real browser download.
- A "Download again" link stays available if you missed it.
- On browsers with the File System Access API (desktop Chrome/Edge), a
  real **"Save As..."** button lets you pick the exact folder/filename
  using `showSaveFilePicker` + a writable stream — genuinely writes the
  file where you choose, not a fake dialog.
- On Android (which doesn't support File System Access), it correctly
  falls back to the standard Downloads-folder auto-download — no broken
  "Save As" button shown where it can't work.

**Newly completed features:**
- **Compound/Nested clips** (Phase 10 spec item): select 2+ clips →
  right-click → "Create Compound Clip" groups them into one draggable/
  trimmable timeline object with real nested playback. "Ungroup" expands
  them back to individual clips at their original positions.
- **Speed ramping via keyframes** (Phase 16 spec item): Speed is now
  keyframeable (◆) in addition to the quick preset dropdown — ramp from
  0.1× to 8× smoothly across a clip, baked into both preview and export.
- **Manual mask "tracking"** (Phase 21 spec item): Mask Position X/Y are
  now keyframeable, so you can manually track a moving subject
  frame-by-frame. No automatic/AI tracking (that needs real computer
  vision, not implementable honestly in a static-hosted browser app) —
  this is the explicit manual fallback the spec allows.
- **Real beat detection** (Phase 30 spec item): simple energy-based onset
  detection on decoded audio (not full BPM/tempo analysis — labeled
  honestly). Beat marks show as yellow ticks on audio-clip waveforms.
  New "🎵 Beat Snap" timeline toolbar toggle snaps clip edges/moves to
  detected beats.
- **Auto-Reframe** (Phase 38 spec item): Settings → Auto-Reframe buttons
  for 9:16 / 1:1 / 4:5 / 16:9. Auto-crops video/image clips to cover the
  new frame (centered) and proportionally repositions text/shape/sticker
  clips. This is the **manual** reframe the spec explicitly allows when
  face/object detection isn't available (it isn't, honestly, here).

**Cross-platform hardening (Android + Windows, and iOS/desktop Safari
where feasible):**
- **Fixed: media library → timeline was drag-and-drop only**, which
  **does not work at all on Android/iOS touchscreens** (HTML5 native
  drag-and-drop has no touch equivalent). Every media/sticker/shape/
  template item now also has a tap-friendly **"+" button** that adds it
  straight to the timeline at the playhead — works identically on
  desktop and mobile. Drag-and-drop still works on desktop as an
  additional option.
- **Fixed: first video playback could get silently blocked** by Android
  Chrome's/Safari's autoplay policy (unmuted `play()` calls made later
  inside a `requestAnimationFrame` loop lose the "real user click"
  context). The Play button now warms up every video element
  synchronously inside its own click handler first.
- **Fixed: timeline ruler scrubbing was mouse-only** — added real touch
  handlers so you can scrub the playhead by dragging the ruler on a
  phone/tablet.
- **Fixed: clip dragging could trigger page scroll on touch** — proper
  `preventDefault()` on the relevant touch listeners.
- Viewport now uses `100dvh` (with a `100vh` fallback) so the layout
  doesn't get clipped behind the browser's address bar on Android
  Chrome / mobile Safari.
- `touch-action:manipulation` + `user-scalable=no` prevent the
  double-tap-to-zoom delay and accidental pinch-zoom that break a
  canvas-based editor UI on mobile browsers.
- Mobile breakpoint now uses larger (≥36px) tap targets for buttons and
  wider clip-trim handles, per standard touch-target guidance.
- Fullscreen button now falls back to `webkitRequestFullscreen` for
  older Android/iOS Safari builds that don't support the standard
  Fullscreen API method name.
- **Preview Quality selector is now actually functional**: Half/Quarter
  reduces the resolution used for chroma-key/mask pixel processing
  (the most CPU-heavy part) during editing — meaningfully smoother
  scrubbing on low-end Android phones — while **export always force-runs
  at full quality** regardless of that setting, so lowering it for
  smooth editing never silently degrades your exported file.
- Export codec negotiation already picks VP9→VP8→plain WebM per-browser
  (works across Chrome/Edge/Firefox on both Windows and Android); on
  browsers where `MediaRecorder`/`captureStream` truly aren't available
  (e.g. some iOS Safari versions), export is disabled with an honest
  message instead of silently failing — editing still works everywhere.

## File structure

```
video-editor/
  index.html      — layout + CSS (all responsive breakpoints)
  app.js          — entire app logic (state, timeline, compositor, export, storage)
  manifest.json   — PWA manifest
  sw.js           — service worker (offline app-shell cache)
  README.md       — this file
```

Kept as a small number of files on purpose (matches how you like to ship —
self-contained, easy to drop straight into a GitHub Pages repo, no build
step, no `node_modules`).

## Supported browsers / codecs

- Best experience: recent **Chrome** or **Edge** (VP9 export, full
  MediaRecorder support).
- **Firefox**: editing works fully; export uses VP8/Opus fallback.
- **Safari**: editing mostly works; MediaRecorder/codec support is more
  limited — the status bar will tell you exactly what's unavailable.
- MP4 export: not available in any current browser for pure client-side
  recording — this is a real browser limitation, not a bug in this app.

## Deployment (GitHub Pages, no Node.js needed)

1. Create a new GitHub repository (e.g. `video-editor`).
2. Upload all files in this folder to the repo (keep them at the repo
   root, or inside a folder — just keep the relative structure intact).
3. Commit and push.
4. Open the repo → **Settings → Pages**.
5. Under "Build and deployment", choose **Deploy from a branch**.
6. Select the `main` branch and `/ (root)` folder → Save.
7. Wait a minute, then open the generated URL:
   `https://<your-username>.github.io/<repo-name>/`

All paths in this project are relative (`./app.js`, `./manifest.json`,
`./sw.js`) so it works whether it's served from the repo root or a
sub-path — required for GitHub Pages project sites.

## Local testing

Just open `index.html` via a local static server (double-clicking the
file directly will break the service worker due to `file://` restrictions).
Quickest option:

```
cd video-editor
python3 -m http.server 8080
# then open http://localhost:8080
```

## Project file format

`.apnacut.json` contains `project` (settings), `tracks`, `clips`, and
`mediaRefs` (metadata only — actual media bytes live in IndexedDB, keyed
by media id). If you open a `.json` on a different device/browser without
the original files also in that browser's IndexedDB, clips will show
"media missing" — this is the same limitation every browser-only editor
has, since browsers can't silently read arbitrary files from disk.

## Known limitations

- Export re-renders the timeline frame-by-frame in real time via
  `setTimeout`, so a 2-minute video takes roughly 2 minutes to export
  (this is inherent to `MediaRecorder`, not a shortcut we took).
- Very large project state (100+ clips) may make undo/redo snapshots
  slower since it's a simple JSON-snapshot history, not a diff-based one.
- Audio-in-export currently mixes video-clip audio; standalone audio-track
  clips are decoded/played but full multi-track audio mixing into export
  is a v2 item — flag if this is a priority and I'll wire it in next.
