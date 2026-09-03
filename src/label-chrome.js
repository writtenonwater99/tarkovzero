/**
 * The place-label LEADER, as markup — one definition, two renderers, one test.
 *
 *     anchor ring at the real position -> hairline stem rising -> cap tick -> the name above it
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Two of the three label passes draw the leader out of DOM: the 2D Leaflet layer
 * (`src/placeLabels.js`, a divIcon) and the Three renderer (`src/map3d-three.js`, an HTML overlay).
 * Written twice, they would drift — and the drift would be silent, because both would still render
 * *something*. So the class names, the leader's pieces and the custom properties `src/style.css`
 * reads are defined here, once, and both passes call these functions. The deck.gl pass is the
 * exception by necessity: it has no DOM at all and rebuilds the same leader out of deck layers.
 *
 * EVERY VALUE COMES FROM `src/label-tier.js`. Nothing here authors a size, a weight, a colour or a
 * stem length; this module only decides how a tier's style is *spelled* for CSS. `styleFor()`
 * throws on an unknown tier and nothing here catches it — a label that lost its tier must fail
 * where the bad value is (handoff §6).
 *
 * PURE AND DEPENDENCY-FREE, deliberately: it is imported by a Leaflet module, a Three module and a
 * Node test, and none of those may pull a renderer in behind it.
 */
import { TIERS, TIER_RANK, styleFor } from './label-tier.js';

/** The leader's three pieces, in paint order — the ring is last so no stem ever crosses it. */
export const LEADER_PIECES = Object.freeze(['pl-cap', 'pl-stem', 'pl-ring']);

/** Does this tier draw a leader at all? `zone` has `stemPx: 0` by definition and does not. */
export const hasLeader = (tier) => styleFor(tier).stemPx > 0;

/**
 * The tier's whole style, spelled as the custom properties `src/style.css` reads.
 *
 * `--stem` is the value ON SCREEN RIGHT NOW and is rewritten by the collision pass when a name has
 * to grow its leader past a neighbour; `--stem0` is the tier's own length and never changes, so
 * "how far has this label been pushed" stays answerable from the element.
 */
export function labelCssProps(tier) {
  const s = styleFor(tier);
  return {
    '--fs': `${s.fontSizePx}px`,
    // The legibility floor, per tier: 12.5 px for the two big tiers and 11 px for the two small
    // ones — the exact floors QA D13 and QA M10 settled, restated as a function of the contract
    // rather than as two more magic numbers.
    '--fs-min': `${Math.max(11, s.fontSizePx - 2.5)}px`,
    '--fw': String(s.fontWeight),
    '--ls': `${s.letterSpacingEm}em`,
    '--tt': s.textTransform,
    '--ink-dark': s.color.ink,
    '--halo-dark': s.color.halo,
    '--ink-light': s.color.inkOnLight,
    '--halo-light': s.color.haloOnLight,
    '--halo-px': `${s.color.haloPx}px`,
    '--stem0': `${s.stemPx}px`,
    '--stem': `${s.stemPx}px`,
    // landmark paints over zone, never the other way round
    '--z-tier': String(TIERS.length - TIER_RANK[tier]),
  };
}

/** The same properties as one inline `style` string. */
export const labelStyleAttr = (tier, extra = {}) =>
  Object.entries({ ...labelCssProps(tier), ...extra }).map(([k, v]) => `${k}:${v}`).join(';');

/** The class list for a label root. The tier class is what style.css hangs the zone rules off. */
export const labelClassName = (tier) => `place-label tier-${tier}`;

/**
 * The 2D divIcon's inner HTML: the name, then the leader when the tier has one.
 *
 * `text` is interpolated verbatim, as it always has been — every place name in this app comes from
 * `src/labels.js`, a repo file, never from a user or a fetch.
 */
export function labelMarkup(tier, text, extraProps = {}) {
  const leader = hasLeader(tier) ? LEADER_PIECES.map((c) => `<i class="${c}"></i>`).join('') : '';
  return `<div class="${labelClassName(tier)}" style="${labelStyleAttr(tier, extraProps)}">`
    + `<span class="pl-name">${text}</span>${leader}</div>`;
}
