# Survey raids — results, 2026-09-01

Two practice raids (`TRAINING | PvP S`), **48 photographs**, in-game clocks 16.39 → 17.59 and
6.59 → 7.23. Photos preserved at `.local-candidates/survey-2026-09-01/` (208 MB, git-ignored).

**Coverage: 20 of 26 candidates photographed. Every family in the roster is now confirmed by sight.**
The six unphotographed candidates are additional instances of families already confirmed, so no family
question remains open.

## Every family confirmed

| family | confirmed by | evidence |
| --- | --- | --- |
| closed-freight-wagon | #18, #12 | green box wagon, corrugated sides, 11.6 m at 2.0° |
| tank-wagon | #16, #17, #1–3, #5, #6, #26 | cylindrical tank bodies, west line and upper deck |
| hopper-wagon | #22, #20, #23 | sloped funnel bodies with under-chutes — unmistakable |
| locomotive | #21 | diesel loco on the raised embankment |
| **gondola-wagon** | **#8, #9** | **low-sided open wagon on bogies, 12.4 m at 1.8°** |
| sliding-door-boxcar | #10 | 23.2 m at 9.0° |

**Gondolas are real** — the family the handoff's "truthful first set" never listed. That set is wrong on
composition, not just on counts.

## New finding: gondolas carry the containers

Photo `6.66` shows a rust-red 20-ft shipping container sitting **on top of** a gondola wagon, on rails,
bogies visible beneath. Some of the roster's container candidates are cargo riding on rail stock rather
than ground-placed containers.

That matters for authoring: a container asset and a gondola asset are not independent placements here, and
anything that counts them separately will double-count the visual object. It is also more evidence for the
nested-placement failure mode both instruments were shown to have — this is exactly that shape, in the
real scene.

## Final coverage — 24 of 26, survey closed

A third pass covered #11, #13, #14 and #15. Only #4 and #7 remain, both west-line tank wagons and both
redundant instances of a family confirmed five times over. **65 photographs total.** The survey is closed.

## What the last pass added

**Gondolas are a coupled consist carrying containers.** `8.35` shows a line of low-sided open wagons
running back with two rust-red containers sitting on their decks, bogies and couplers visible throughout.
Not isolated props.

**The upper-deck consist is a train**, not a row of separate placements: multiple closed freight wagons
coupled in line with a tank car at the end (`8.48`).

**Colour variants are distinct authored assets.** #18 is a green box wagon; #15 is cream/tan. Same family,
different variant — which is exactly why the extractor's prefix folding kept fragmenting `Vagon_tank_green`
away from `Vagon_tank` and why that fold rule mattered so much.

## Consequences for authoring

The handoff's build order — closed wagon, hopper wagon, 6 m container — does not survive the photographs.

1. **Six rail families exist**, not three: closed-freight, tank, hopper, gondola, locomotive,
   sliding-door boxcar — plus colour variants within them.
2. **Containers are not independent placements.** Some ride on gondolas. Authoring a container asset and a
   gondola asset as separate objects will double-count the visible thing. This is the nested-placement
   shape both instruments were proven to miscount, now observed in the real scene.
3. **Family identity is settled. Count and placement are not.** Photographs confirm what exists; they do
   not confirm that 26 is right, and the consists are precisely the structure the roster handles worst.
   No further extractor work closes that gap — the bounds spike already concluded it buys precision, not
   truth.

Codex's split therefore stands: *which prototype should exist* is now answered from outside the repository,
and is a reversible library investment. *How many and where* remains blocked and must not drive a
replacement mapping. Neither landmark mapping literal may be rewritten from this evidence.

**This is the first evidence in the whole industrial lane that did not come from the serialized scene.**
Everything before it — the extractor, the second source, the handoff's claim — traces back to one
acquisition path. These are photons.

## The headline: the elevated cluster is real

Nine of the 26 candidates sit at y ≈ 6.9–7.4 while the rest are at 1–4, and the open question was whether
they were reachable raid geometry or unreachable backdrop scenery. **They are real.**

The player walked at y ≈ 5.6–5.7 directly alongside them, standing on ballast between live rails. Customs
has a **two-level rail yard**: an upper deck carrying a consist, and a lower yard below it. Both are
walkable. Photo `17.57` shows the boundary explicitly — a locomotive and wagon on a raised
concrete-and-brick embankment, with hopper wagons standing in the yard below it.

Nothing leaves the roster on the "backdrop" hypothesis. That hypothesis is dead.

## Confirmed by photograph

| # | family | x, z | evidence |
| --- | --- | --- | --- |
| 18 | closed-freight-wagon | 283.2, −147.7 | **Direct.** Green box wagon, corrugated sides, at ~12 m. Photo `17.37` |
| 16, 17 | tank-wagon | 262.8/272.5, −172.8/−160.8 | Cylindrical tank body visible along the same consist in `17.37`; two shots at 0.7° and 34.9° off-axis |
| 21 | locomotive | 340.7, −121.2 | **Direct.** Diesel locomotive on the upper deck, `17.57` and `17.54` |
| 22 | hopper-wagon | 351.8, −112.7 | **Direct.** Three-plus sloped hopper bodies with discharge chutes, `17.57` |
| 20, 23 | hopper-wagon | 310.9/364.0, −49.6/−123.9 | Framed at 2.5° and 4.0° off-axis, 20.4 m and 14.5 m |
| 19 | tank-wagon | 313.3, −163.4 | 4.9° off-axis at 15.0 m |
| 24, 25 | closed-freight-wagon | 211.1/222.8, −228.0/−213.6 | 2.2° and 15.6° off-axis, 21.1 m and 16.2 m |

**Hopper wagons exist and are visually unmistakable** — sloped funnel bodies with under-chutes, nothing
like a box wagon. That is the exact split the extractor could never make from names, settled by looking.

`17.37` also shows a **continuous consist**: a line of box wagons running back to a tank wagon, not
isolated props. Several roster rows are one train.

## Not visited — 16 of 26

| # | stop | families | why it matters |
| --- | --- | --- | --- |
| 1–7 | West tank line | 7 × tank-wagon | count confirmation only; same asset repeated |
| **8–14** | **Factory Shacks** | **4 × gondola, locomotive, sliding-door boxcar, closed-freight** | **the highest-value gap — see below** |
| 15 | Old Gas Station | closed-freight | one more on the confirmed consist |
| 26 | outlying | tank-wagon | low value |

**Stop 2 is the one that still matters.** Gondola wagons are a family the handoff's "truthful first set"
never listed, and all four candidates are there, unphotographed. So is the sliding-door boxcar, which the
second source deliberately refused to merge into closed-freight. Confirming or refuting those four gondolas
changes which asset families get authored.

## What this does and does not settle

Settled: the elevated candidates are real geometry; hopper, closed-freight, tank and locomotive families
all physically exist in the yard; the yard is two-level.

Not settled: **the count.** A photograph confirms a family exists at a location; it does not prove the
roster's 26 is the right number, and the consist in `17.37` is exactly the shape that both instruments were
shown to miscount (nested and repeated placements). The handoff's "3 closed / 2 tank / 1 hopper" remains
contradicted, but by roster evidence, not yet by a counted photograph.

## Next

One more short raid covering stop 2 (targets 8–14) closes the family question. Everything else can wait.
