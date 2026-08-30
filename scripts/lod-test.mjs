#!/usr/bin/env node
/**
 * Marker LOD test (step 4).
 *
 * `src/lod.js` is the one place 2D and 3D agree on what a marker looks like, so the three things
 * that must not drift are pinned here: where the tier boundaries sit in metres per pixel, that the
 * hysteresis really is a dead band (a value inside it keeps whatever is on screen), and that the
 * spawn clustering is a pure function of the coordinates and the cell size — same viewport, same
 * clusters, in the same order, whatever order the points arrive in.
 *
 * Plain node, no deps: lod.js imports nothing and touches no DOM.
 */
import { tier, tierOf, TIERS, BOUNDS, HYSTERESIS, cellFor, CLUSTER_PX, clusterPoints, updateTier, setTier, currentTier } from '../src/lod.js';

/* ---------------------------------------------------------------- harness */
let pass = 0;
const fails = [];
function check(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (name, got, want) => check(name, Object.is(got, want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const near = (name, got, want, tol = 1e-9) => check(name, Math.abs(got - want) <= tol, `got ${got}, want ${want}`);

/* ------------------------------------------------------------ thresholds */
console.log('tier thresholds (metres per pixel)');
{
  eq('boundaries are dot|icon then icon|full', BOUNDS.join(','), '0.33,0.165');
  eq('tiers run coarse to fine', TIERS.join(','), 'dot,icon,full');

  // The zoom stops a 1400x985 window actually lands on for Customs (sx = 0.239).
  const mpp = (zoom) => 1 / (0.239 * Math.pow(2, zoom));
  eq('Customs at cover-fit (2.92) is dot', tierOf(mpp(2.92)), 'dot');
  eq('half a zoom in (3.42) is still dot', tierOf(mpp(3.42)), 'dot');
  eq('one zoom in (3.92) is icon', tierOf(mpp(3.92)), 'icon');
  eq('one and a half (4.42) is still icon', tierOf(mpp(4.42)), 'icon');
  eq('two zooms in (4.92) is full', tierOf(mpp(4.92)), 'full');
  eq('max zoom (7) is full', tierOf(mpp(7)), 'full');

  // Other maps get the same treatment for the same physical scale — that is the whole point of
  // cutting on m/px instead of on a zoom number.
  eq('Woods at cover-fit (1.005 m/px) is dot', tierOf(1.005), 'dot');
  eq('Reserve at cover-fit (0.423 m/px) is dot', tierOf(0.423), 'dot');

  eq('just above the dot boundary', tierOf(0.3301), 'dot');
  eq('on the dot boundary is icon', tierOf(0.33), 'icon');
  eq('just above the full boundary', tierOf(0.1651), 'icon');
  eq('on the full boundary is full', tierOf(0.165), 'full');
  eq('a 3D zoom of 3 (0.125 m/px) is full', tierOf(1 / Math.pow(2, 3)), 'full');

  eq('garbage falls back to full', tierOf(NaN), 'full');
  eq('zero falls back to full', tierOf(0), 'full');
}

/* ------------------------------------------------------------ hysteresis */
console.log('');
console.log('hysteresis (±10% dead band around each boundary)');
{
  eq('the margin is 10%', HYSTERESIS, 0.1);
  const hi = 0.33 * 1.1, lo = 0.33 * 0.9;           // 0.363 / 0.297
  const hi2 = 0.165 * 1.1, lo2 = 0.165 * 0.9;       // 0.1815 / 0.1485

  eq('inside the band, coming from dot, stays dot', tier(0.32, 'dot'), 'dot');
  eq('inside the band, coming from icon, stays icon', tier(0.34, 'icon'), 'icon');
  eq('same value, two different answers — that IS the hysteresis',
    `${tier(0.32, 'dot')}/${tier(0.32, 'icon')}`, 'dot/icon');

  check('zooming in only becomes icon 10% past the boundary', tier(lo + 1e-9, 'dot') === 'dot' && tier(lo - 1e-9, 'dot') === 'icon');
  check('zooming out only becomes dot 10% past the boundary', tier(hi - 1e-9, 'icon') === 'icon' && tier(hi + 1e-9, 'icon') === 'dot');
  check('the same holds at the icon|full boundary', tier(lo2 + 1e-9, 'icon') === 'icon' && tier(lo2 - 1e-9, 'icon') === 'full');
  check('and coming back out of full', tier(hi2 - 1e-9, 'full') === 'full' && tier(hi2 + 1e-9, 'full') === 'icon');

  eq('a big jump skips a tier in one call', tier(0.05, 'dot'), 'full');
  eq('and back', tier(2, 'full'), 'dot');
  eq('an unknown previous tier behaves like a fresh read', tier(0.2, 'nonsense'), 'icon');

  // Idempotence matters: main.js and map3d.js both fold the same m/px in on one camera change.
  for (const m of [0.55, 0.391, 0.33, 0.32, 0.276, 0.18, 0.165, 0.138, 0.05]) {
    const once = tier(m, 'dot'), twice = tier(m, once);
    check(`idempotent at ${m}`, once === twice, `${once} then ${twice}`);
  }

  // No ordinary zoom stop may sit inside a dead band, or a screenshot would depend on the
  // direction the camera arrived from. This is why the boundaries are geometric midpoints.
  for (const z of [2.92, 3.42, 3.92, 4.42, 4.92, 5.42]) {
    const m = 1 / (0.239 * Math.pow(2, z));
    check(`zoom stop ${z} is unambiguous`, tier(m, 'dot') === tier(m, 'full'), `${tier(m, 'dot')} vs ${tier(m, 'full')}`);
  }

  // The shared tier used by both views.
  setTier('dot');
  eq('updateTier folds through the shared state', updateTier(0.32), 'dot');
  eq('and holds it', currentTier(), 'dot');
  eq('until the value clears the band', updateTier(0.2), 'icon');
  setTier('dot');
}

/* ------------------------------------------------------------ clustering */
console.log('');
console.log('cluster determinism');
{
  eq('a cell is 24 px', CLUSTER_PX, 24);
  near('at 0.55 m/px a cell is 13.2 m', cellFor(0.55), 13.2, 1e-9);
  near('at 0.138 m/px a cell is 3.312 m', cellFor(0.138), 3.312, 1e-9);

  const P = (x, z, id) => ({ id, position: { x, z } });
  // Three points inside one 10 m cell, one just over the edge into the next.
  const pts = [P(1, 1, 'a'), P(4, 2, 'b'), P(9.5, 9.5, 'c'), P(11, 1, 'd'), P(-3, -3, 'e')];
  const cs = clusterPoints(pts, 10);
  eq('four points collapse to three cells', cs.length, 3);
  const byKey = Object.fromEntries(cs.map((c) => [c.key, c]));
  eq('the 0|0 cell holds three', byKey['0|0'].count, 3);
  eq('the 1|0 cell holds one', byKey['1|0'].count, 1);
  eq('negatives floor down, not toward zero', byKey['-1|-1'].count, 1);
  near('the centroid is the mean x', byKey['0|0'].x, (1 + 4 + 9.5) / 3, 1e-12);
  near('the centroid is the mean z', byKey['0|0'].z, (1 + 2 + 9.5) / 3, 1e-12);

  const sig = (list) => JSON.stringify(list.map((c) => [c.key, c.count, c.x, c.z, c.points.map((p) => p.id)]));
  const shuffled = [pts[3], pts[0], pts[4], pts[2], pts[1]];
  const reversed = [...pts].reverse();
  eq('input order cannot change the result', sig(clusterPoints(shuffled, 10)), sig(cs));
  eq('nor can reversing it', sig(clusterPoints(reversed, 10)), sig(cs));
  eq('the same call twice is byte-identical', sig(clusterPoints(pts, 10)), sig(cs));
  check('clusters come back in sorted key order', cs.map((c) => c.key).join(',') === [...cs.map((c) => c.key)].sort().join(','));

  // Zooming in must split clusters, never merge them.
  const coarse = clusterPoints(pts, 40), fine = clusterPoints(pts, 2);
  check('a bigger cell means fewer clusters', coarse.length <= cs.length);
  eq('a 2 m cell separates every point', fine.length, pts.length);
  const total = (list) => list.reduce((n, c) => n + c.count, 0);
  check('no point is lost at any cell size', total(coarse) === pts.length && total(cs) === pts.length && total(fine) === pts.length);

  eq('an empty input is an empty result', clusterPoints([], 10).length, 0);
  eq('a bad cell size degrades to one cluster per position', clusterPoints(pts, 0).length, pts.length);
  eq('points without coordinates are dropped', clusterPoints([P(1, 1, 'a'), { position: { x: NaN, z: 0 } }], 10)[0].count, 1);

  // The real shape: Customs' 120 spawns are not spread evenly, they sit in a dozen spawn zones a
  // few metres apart. At fit zoom that should thin right down; at full-tier zoom it should be
  // close to one pin per point again.
  const spawns = Array.from({ length: 120 }, (_, i) => {
    const zone = i % 12;                                   // 12 zones, 10 points each
    const ax = -300 + zone * 80, az = -250 + ((zone * 37) % 400);
    const k = Math.floor(i / 12);
    return P(ax + (k % 4) * 2.5, az + Math.floor(k / 4) * 2.5, `s${i}`);
  });
  const atFit = clusterPoints(spawns, cellFor(0.552));
  const atFull = clusterPoints(spawns, cellFor(0.138));
  check(`fit zoom thins 120 spawns to ${atFit.length}`, atFit.length < spawns.length);
  check(`full zoom keeps ${atFull.length} of 120 apart`, atFull.length >= atFit.length);
  eq('every spawn is still accounted for', total(atFit), 120);
}

/* -------------------------------------------------------------- summary */
console.log('');
if (fails.length) {
  console.error(`✗ marker LOD: ${fails.length} failed, ${pass} passed`);
  for (const f of fails) console.error(`   ${f}`);
  process.exit(1);
}
console.log(`✓ marker LOD: ${pass} checks passed`);
