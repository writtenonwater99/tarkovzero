/**
 * What a THREE.js overlay marker draws — the one rule, and the one place that writes the DOM.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The Three renderer never called the icon system. `makeOverlayItem()` did
 * `element.textContent = safeText(label)` and stopped, so every one of ~200 Customs markers was
 * the same dark text pill: on 2026-09-03 the live Customs view was roughly a hundred chips reading
 * "BURIED BARREL CACHE" stacked on each other, with the extracts lost inside them. Meanwhile
 * `src/icons.js` already held a complete 17-kind badge vocabulary — shape = family, glyph = item,
 * colour = kind — that the 2D Leaflet view and the deck.gl diorama both drew from.
 *
 * So this module carries `src/icons.js` into the Three overlay, and nothing else. It re-draws no
 * glyph, invents no LOD ladder (`src/lod.js` owns that, and deck.gl already drives it), and owns
 * exactly two decisions:
 *
 *   1. WHICH MARK, from the shared tier. `dot` -> the family dot; `icon`/`full` -> the badge.
 *      Extracts and transits are LOD-exempt by the rule already written in `src/lod.js`: they are
 *      what the map is FOR, and a player hunting the way out is usually zoomed out.
 *
 *   2. WHETHER THE NAME IS DRAWN. This is what kills the collision:
 *        loot / spawn / utility  badge only — the name is on the hover `title`, where it always was
 *        extracts                badge AND name — a bare letter code is a riddle, and they are the
 *                                one navigational class on the map
 *      Place labels (`kind: 'place'`) never reach this module; they keep their own
 *      `label-chrome` / `label-tier` leader-line treatment, untouched.
 *
 * SANITISATION
 * ------------
 * `content.html` is the ONLY string that is ever assigned to `innerHTML`, and every byte of it
 * comes from the trusted `icons.js` vocabulary: the kind is looked up in `KINDS` (an unknown kind
 * returns null and the caller keeps its plain-text pill), the letter and the requirement mark come
 * from the hand-written `EXTRACT_LETTER` / `EXTRACT_REQ` tables, and the level is whitelisted here.
 * Any data-derived string — a marker's name — is written with `textContent`, never interpolated.
 */
import { KINDS, dotHtml, extractLetter, extractReq, iconHtml } from './icons.js';
import { TIERS } from './lod.js';

/** Badge pixel sizes, matching the 2D map (`src/main.js` iconFor): extracts read one step larger. */
export const MARKER_BADGE_PX = 22;
export const EXTRACT_BADGE_PX = 26;
/** The dot tier's mark. Same 6 px the Leaflet `dotIcon` uses, so the two views agree. */
export const MARKER_DOT_PX = 6;

/** The four levels a badge has art for. Anything else is a surface marker, never a class name. */
export const OVERLAY_LEVELS = Object.freeze(['surface', 'underground', 'rooftop', 'upper']);
export const safeOverlayLevel = (level) => (OVERLAY_LEVELS.includes(level) ? level : 'surface');

/** Extracts and transits ignore the tier entirely — `src/lod.js`, red-team row 12. */
export const isExtractKind = (kind) => String(kind ?? '').startsWith('extract');

/** The tier a marker of this kind actually draws at, given the shared camera tier. */
export function markerTier(kind, tier) {
  if (isExtractKind(kind)) return 'full';
  return TIERS.includes(tier) ? tier : 'full';
}

const trim = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

/**
 * The mark one marker draws at one tier. Pure: no DOM, no globals, safe to assert in node.
 *
 * @param {{markerKind?:string,label?:string,title?:string,level?:string}} spec
 *        a `markerOverlaySpec()` row from src/three-world.js
 * @param {string} tier  the shared marker tier ('dot' | 'icon' | 'full')
 * @returns {{kind:string,tier:string,mark:'dot'|'badge',html:string,name:string|null,size:number}|null}
 *          null when the kind is not in the icon vocabulary — the caller must fall back to text
 *          rather than draw a badge it cannot name.
 */
export function markerOverlayContent(spec, tier) {
  const kind = String(spec?.markerKind ?? '');
  if (!KINDS[kind]) return null;
  const t = markerTier(kind, tier);
  if (t === 'dot') {
    return { kind, tier: t, mark: 'dot', html: dotHtml(kind, MARKER_DOT_PX), name: null, size: MARKER_DOT_PX };
  }
  const extract = isExtractKind(kind);
  const name = trim(spec?.label ?? spec?.title);
  const size = extract ? EXTRACT_BADGE_PX : MARKER_BADGE_PX;
  const html = iconHtml(
    kind, size,
    extract ? extractLetter(name) : null,
    safeOverlayLevel(spec?.level),
    null,
    extract ? extractReq(name) : null,
  );
  // THE TEXT POLICY, in one expression: only an extract carries its name onto the map face.
  return { kind, tier: t, mark: 'badge', html, name: extract && name ? name : null, size };
}

/**
 * Paint one overlay element for `spec` at `tier`. Idempotent — calling it again with a different
 * tier replaces the mark in place, which is what a camera move does.
 *
 * @returns the content that was drawn, or null if the kind is not in the vocabulary (in which case
 *          the element is left exactly as it was, so the caller's text fallback survives).
 */
export function paintMarkerOverlay(element, spec, tier, doc = globalThis.document) {
  const content = markerOverlayContent(spec, tier);
  if (!content || !element) return null;
  // Clears the previous mark's children AND any text the caller had put there.
  element.textContent = '';
  element.classList.add('has-mark');
  element.classList.toggle('mark-dot', content.mark === 'dot');
  element.classList.toggle('mark-badge', content.mark === 'badge');
  element.dataset.markerKind = content.kind;
  element.dataset.lodTier = content.tier;
  element.dataset.mark = content.mark;
  const mark = doc.createElement('span');
  mark.className = 'tz-three-mark';
  // TRUSTED VOCABULARY ONLY — see the module header. Never assign a data string here.
  mark.innerHTML = content.html;
  element.append(mark);
  if (content.name) {
    const label = doc.createElement('span');
    label.className = 'tz-three-mark-name';
    label.textContent = content.name;   // data-derived: textContent, never innerHTML
    element.append(label);
  }
  return content;
}
