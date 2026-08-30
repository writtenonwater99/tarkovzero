// The Stage 1 ground-detail recipe, as a pure function of four decoded images.
//
// This lives apart from scripts/prepare-render-assets.mjs on purpose: that file
// is a top-level-await script that runs its whole pipeline on import, so nothing
// inside it can be unit-tested. The channel assignment below is exactly the kind
// of thing that is silently wrong forever once a baseline is committed — swap
// the AO and roughness sources and every hash changes, every output still
// decodes, `--check` still passes on the next run, and terrain roughness quietly
// reads the occlusion map. Keeping it here means a test can drive it with
// distinguishable synthetic inputs and assert which channel is which.
import { packChannels, resizeTo, takeChannels } from './imageio.mjs';

/**
 * @param {{color: object, normal: object, ao: object, rough: object}} src decoded source maps
 * @param {number} size target width/height, an integer factor below the source
 * @returns {{albedo: object, normal: object, orm: object}}
 */
export function buildGroundMaps(src, size) {
  for (const [name, img] of Object.entries(src)) {
    if (img.width !== img.height) throw new Error(`${name} map is not square (${img.width}x${img.height})`);
    if (img.width % size) throw new Error(`${name} map ${img.width}px has no integer box ratio to ${size}px`);
  }
  return {
    // Colour averages in linear light; normals average then renormalise; AO and
    // roughness are already linear data and average as-is.
    albedo: takeChannels(resizeTo(src.color, size, 'srgb'), 3),
    normal: takeChannels(resizeTo(src.normal, size, 'normal'), 3),
    orm: packChannels([
      { img: resizeTo(src.ao, size, 'linear'), channel: 0 }, // R = occlusion
      { img: resizeTo(src.rough, size, 'linear'), channel: 0 }, // G = roughness
      { constant: 0 }, // B = metalness; ground is never metallic
    ]),
  };
}
