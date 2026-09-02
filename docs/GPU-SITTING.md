# GPU sitting — one pass, four artifacts

Everything queued behind your eyes since the checkpoint, batched so you look once instead of four times.
Headless captures are diagnostics only; nothing below has had a real-GPU verdict, and `gpuFrameMs` is
`null` under SwiftShader so **no frame-time claim in this repo is currently backed by anything**.

Dev server is running. If you restart it, remember Vite's watcher does not fire on `/mnt/c` — edits need a
restart, not HMR.

Your verdict on each is one of: **ADMIT** · **REVISE** (say what) · **REJECT**.

---

## 1 · Authored vegetation — the big one

```
http://127.0.0.1:5173/?map=customs&view=3d&renderer=three&look=realistic
```

All 31 prototype families, 8,805 placements, every one authored geometry. This replaces the 8 procedural
proxy batches you have been looking at since August.

**Console check (paste it, it answers the honesty question):**

```js
tz.renderStats().vegetation
```

Expect `materialMode: "shared-array-texture"`, `drawCalls: 31`, `liveBuckets: 31`, `bucketCeiling: 93`,
`accountedPlacements: 8805`, and **`warnings: []`**. If `warnings` is non-empty, something fell back and it
will tell you what — do not judge the look until it is empty.

**Load takes 60–85 seconds** (93 GLBs, 15.3 MB, sha256-verified over the loopback route). That is expected.
The forest is procedural until it swaps, and the swap is atomic — you will never see a half-built scene.

**What I need from you, in order:**

1. **Does it read as forest, or as cards?** The 22 leaf/needle cards are alpha-tested cutouts now, not
   blended. If there is a dark fringe on leaf edges the RGB dilation failed and I need to know.
2. **LOD transitions.** Fly in and out. Pine LOD1 is a known silhouette discontinuity from LOD0/LOD2, dry
   shrubs nearly vanish at LOD2, ground plants are 12–16 triangles at LOD2, and Stump04 reads as a pale
   featureless box. Which of those actually bother you at real distances?
3. **Does it hold frame rate?** This is the number nobody has. 31 vegetation draw calls sit inside a
   ~1,461-call frame; whether that costs anything real is unknown until now.
4. **Alpha-test overdraw on dense canopy** — fly low through a pine stand. This is the classic failure of
   cutout foliage and SwiftShader cannot show it.

Toggle back with `?vegetation=procedural` for a direct A/B at an identical camera.

---

## 2 · Fortress — authored building, already promoted

```
http://127.0.0.1:5173/?map=customs&view=3d&renderer=three&look=realistic#4.4/203/-128
```

Also force the fallback backend once, since WebGPU vs WebGL2 is a real difference on your machine:
append `&threeBackend=webgl2`.

**Question:** does it sit, orient, shadow and stream plausibly, with no duplicate procedural geometry
showing through? Its ground and upper playable tops are 2.447 m and 8.183 m world Y — do the floors read
at the right heights?

Not asking whether it matches EFT. Asking whether it is a coherent building.

---

## 3 · Terrain PBR V2.1

Same URL as #1 — it is the ground you are already standing on.

**Question:** does the terrain read as physically coherent material — grass, litter, dirt, gravel, ballast —
rather than tinted noise? Look especially where the rail ballast meets grass, and at the road surfaces,
which are baked into the ground texture rather than being geometry.

Toggle `Look: Real | Vector` in the View panel for the A/B. Vector is the default and the pre-R1 renderer.

---

## 4 · Crackhouse — offline candidate, NOT in the renderer

Contact sheets: `.local-candidates/crackhouse-fixedrig/`

```
crackhouse-lod-oblique.png    all three LODs, identical camera
crackhouse-lod-south.png
crackhouse-lod-east.png
```

These cameras were broken until today — each LOD framed itself, so any earlier verdict was on bad
evidence. They are now frozen constants and all three LODs occupy identical screen position and size.

**Question:** is this an acceptable original-authored building *hypothesis* — not whether it matches EFT's
crackhouse. It has never been staged in the renderer; its canonical footprint centre is ≈ (83.15, −156.18)
if you want it placed next.

**Known and unfixed, needs your call:** LOD1's silhouette is **26.4 mm wider than LOD0's** (roof-tile
overlap on a coarser row grid). An LOD should never grow. The fix changes the authored roof, so it is
yours. Also: exposed-brick damage patches sit 146 mm outboard of the plaster they show through.

---

## What is deliberately NOT in this sitting

- **Stage B vegetation atlases** — deletes the opaque foliage blobs and raises pine LOD1 from 552 to 2,712
  triangles. Correct in principle, but it is a real visual change and its four open questions all need a
  frame you have not seen yet. Deferred until after this pass.
- **Industrial rail stock** — no asset authored yet. Family identity is settled by your 65 photographs;
  count and placement are not, and nothing is being built against an unverified count.
- **Anything on tarkovzero.com** — everything above is judged on the LOCAL frame, which carries the
  exact terrain package and the 8,805 authored vegetation placements. Since 2026-09-01 the same
  renderer also runs in production on `?renderer=three` (Customs only, never the default), but that
  frame draws the PUBLIC heightfield and the public tree positions instead: it is a different
  picture, and a judgement made here does not transfer to it. Local enhancements are still gated to
  dev + loopback. See `docs/LOCAL-THREE-POC.md`.
