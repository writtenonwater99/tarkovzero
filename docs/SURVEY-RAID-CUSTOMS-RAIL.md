# Customs rail-yard survey raid — shot list

Purpose: confirm or refute a **candidate roster**, not collect pretty pictures. The roster says 26 rail
bodies stand in the yard; the handoff claimed 3 closed / 2 tank / 1 hopper / 2 red 6 m containers. Both
readings come from one serialized-scene acquisition and neither is evidence of what is actually there.
Your photographs are the only independent source in this whole chain.

## Setup (5 min, once)

1. Screenshot key is already **F11** (Windows 11 eats PrintScreen).
2. Start the companion **with `--keep`** — this is the one that matters:

   ```
   cd /mnt/c/Users/zeque/tarkovzero/companion
   node.exe companion.mjs --keep
   ```

   Without `--keep`, `deleteScreenshots` defaults to true and every photo is deleted 3 seconds after it
   uploads. The coordinates would survive; the pictures — the actual evidence — would not.
3. Open the site with the pairing code and leave it on 2D. Your live marker is how you navigate to
   coordinates, since EFT shows you none.
4. **Practice / offline raid.** No timer pressure, no PMCs, and the log still records everything.

## How to shoot

For each target: stand **5–10 m away**, object roughly centred, and take **two** — one wide enough to show
what it is standing on (rails? ground? embankment?), one closer on the body. The filename carries your
position, your facing and the in-game clock, so nothing needs writing down.

The question each photo answers is only: **what body type is this, and is it really there?**

## Route — west to east

### Stop 1 · West tank line (near Boiler Room Basement extract)
Seven tank wagons in a row, ground level (y ≈ 3.1).

| target | x | z |
|---|---:|---:|
| tank | 84.7 | 15.8 |
| tank | 120.4 | 1.4 |
| tank | 121.8 | 22.4 |
| tank | 135.1 | −11.1 |
| tank | 136.0 | −1.3 |
| tank | 136.7 | 6.9 |
| tank | 138.0 | 14.9 |

Two or three photos is enough here — they are the same asset repeated. What matters is confirming the
**count** and that they are ground-level rolling stock rather than static scenery.

### Stop 2 · Main yard, Factory Shacks (HIGHEST PRIORITY)
This is the decision cluster. Ground level, y 1.4–4.3.

| target | x | z | why it matters |
|---|---:|---:|---|
| **Locomotive** | 229.7 | −37.4 | the claim never listed a locomotive |
| **gondola** | 221.5 | −40.4 | **gondola is a family the handoff never listed at all** |
| **gondola green** | 224.5 | −54.4 | |
| **gondola** | 232.7 | −52.7 | |
| **gondola green** | 235.5 | −66.6 | |
| **sliding-door boxcar** | 227.8 | −70.4 | distinct asset — is it a closed wagon or its own thing? |
| closed freight | 231.6 | −88.6 | the only ground-level closed wagon |

Photograph **all seven**. If the four gondolas are real, the handoff's family list is simply wrong, and
that changes which asset families get authored.

### Stop 3 · Old Gas Station line — ARE THESE EVEN REAL? (HIGH VALUE)
Six bodies at **y ≈ 6.9–7.4**, well above everything else. Either they sit on a raised embankment, or
they are distant backdrop scenery that no player ever stands next to.

| target | x | z | y |
|---|---:|---:|---:|
| closed freight | 252.2 | −185.9 | 6.91 |
| tank | 262.8 | −172.8 | 7.37 |
| tank | 272.5 | −160.8 | 7.36 |
| closed freight | 283.2 | −147.7 | 6.91 |
| tank green | 313.2 | −163.4 | 2.80 |

**Just answering "can I walk up to these, or are they backdrop?" is worth more than any other photo on
this list.** Nine of the 26 candidates sit at this elevation. If they are scenery, the real count drops
hard and a whole cluster leaves the roster.

### Stop 4 · East — the hoppers (near Warehouse 4 / Transit to Factory)
| target | x | z | y |
|---|---:|---:|---:|
| hopper black | 310.9 | −49.6 | 7.20 |
| Locomotive | 340.7 | −121.2 | 4.29 |
| hopper | 351.8 | −112.7 | 2.25 |
| hopper black | 364.0 | −123.9 | 6.97 |

Hoppers are one of the two families the extractor could never separate from closed wagons on names alone.
Photograph all three.

### Stop 5 · Far south, if you still have time (near ZB-013 / Sniper)
| target | x | z | y |
|---|---:|---:|---:|
| closed freight | 211.1 | −228.0 | 6.91 |
| closed freight | 222.8 | −213.6 | 6.91 |

Same elevated question as Stop 3. Skip if the raid is running long — Stops 2 and 3 carry the decision.

## What I do with them

Join each photo's coordinates to the nearest candidate, then mark every row confirmed, refuted, or
not-visited. A refuted row is as valuable as a confirmed one: it tells us the serialized scene contains
objects the player never meets, which is exactly the failure mode the whole roster is suspected of.

Containers are deliberately not on this list. There are 74 candidates in the box — too many to walk, and
the claim about them (2 red 6 m) is already contradicted at 14 by name evidence alone.
