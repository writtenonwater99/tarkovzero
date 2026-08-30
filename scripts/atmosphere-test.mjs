/**
 * src/atmosphere.js — what the frozen contract turns into, checked at the GLSL boundary.
 *
 * render-style-test.mjs asserts the DATA (palette, fog constants, post block) and render-assets-test
 * asserts the codecs. Neither can see the shaders those numbers are compiled into, and that gap has
 * cost real defects: the fog's height term diverged from the contract it quotes (absolute
 * relief-scaled altitude instead of real metres above ground) and FXAA stayed switched on in a
 * full-screen pass that was chewing every label on the map. Both are one string away from visible
 * here, so they are asserted here.
 *
 *   node --test scripts/atmosphere-test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fogExtensionFor, gradeEffectFor, referenceGroundMeters, backgroundFor, fogParams, postFor,
  groundDetailExtensionFor, waterExtensionFor, surfaceMaterial, materialTint, shadowRings,
  voidMargin, skirtRamp,
} from '../src/atmosphere.js';
import { FOG, POST, PALETTE, WATER, BACKDROP, FOG_DESATURATION, FOG_COOL_AMOUNT, specularFor } from '../src/render-style.js';

const CUSTOMS_DIAGONAL = 1223;
/** The vertex-stage injection the fog extension compiles into every world layer. */
const fogSource = (diagonal = CUSTOMS_DIAGONAL) => {
  const ext = fogExtensionFor('realistic', diagonal, () => ({ groundMeters: 7, relief: 3 }));
  assert.ok(ext, 'realistic fog should produce an extension');
  const shaders = ext.getShaders(ext);
  return { ext, shaders, vs: shaders.inject['vs:DECKGL_FILTER_GL_POSITION'], fs: shaders.inject['fs:#main-end'] };
};

test('the fog height term is metres ABOVE GROUND, not absolute relief-scaled altitude', () => {
  const { vs, shaders } = fogSource();
  // The two halves of the defect, each of which is one edit away from coming back:
  assert.match(vs, /tzWorld\.z\s*-\s*tzFog\.ground/, 'the height term must be measured from the ground reference');
  assert.match(vs, /tzFog\.relief/, 'the height term must divide deck-space Z back to real metres');
  assert.doesNotMatch(vs, /max\(0\.0,\s*tzWorld\.z\)/, 'measuring altitude from world zero inverts aerial perspective');
  // And the falloff is the contract's own constant, in real metres.
  assert.ok(vs.includes(String(FOG.realistic.heightFalloffMeters)), `falloff ${FOG.realistic.heightFalloffMeters} is not in the shader`);
  // The uniforms the two live values arrive on have to be declared, or the shader will not link.
  const decl = shaders.modules[0];
  assert.deepEqual(Object.keys(decl.uniformTypes).sort(), ['ground', 'origin', 'relief']);
  for (const name of ['ground', 'origin', 'relief']) assert.match(decl.vs, new RegExp(`float ${name};`));
});

test('the fog distance term measures from the orbit target and clamps to the contract', () => {
  const p = fogParams('realistic', CUSTOMS_DIAGONAL);
  const { vs, fs } = fogSource();
  assert.match(vs, /tzFog\.origin/, 'depth must be relative to the eye standoff');
  assert.ok(vs.includes(String(p.maxDensity)), 'maxDensity is not the contract value');
  assert.ok(vs.includes(p.startMeters.toFixed(1)) || vs.includes(String(p.startMeters)), 'startMeters is not the contract value');
  // Mixed after the layer's own lighting, or the sun lands on top of the fog.
  assert.match(fs, /fragColor\.rgb = mix\(/);
});

test('vector has no fog extension at all', () => {
  assert.equal(fogExtensionFor('vector', CUSTOMS_DIAGONAL), null);
});

test('the grade pass does not run a spatial filter over the frame', () => {
  // POST.realistic.fxaa is false because deck's PostProcessEffect is one full-screen pass and the
  // label/icon/quest/live layers are in it. If that flag ever flips back, this fails first.
  assert.equal(POST.realistic.fxaa, false);
  assert.equal(postFor('realistic').fxaa, false);
  const effect = gradeEffectFor('realistic', { texture: { id: 'fake-lut' } });
  assert.ok(effect, 'realistic should produce a grade effect once the LUT is there');
  const fs = effect.module.fs;
  // The helper may stay in the source (re-enabling is one flag), but nothing may CALL it.
  assert.doesNotMatch(fs, /=\s*tzGrade_fxaa\(/, 'the grade pass is calling FXAA over the whole framebuffer');
  assert.match(fs, /vec3 c = texture\(src, uv\)\.rgb;/, 'the grade should sample one texel per pixel');
  // The pointwise stages are still all there.
  assert.match(fs, /tzGrade_lut\(c\)/);
  assert.ok(fs.includes(String(POST.realistic.vignette)) && fs.includes(String(POST.realistic.grain)));
});

test('vector never gets a grade pass', () => {
  assert.equal(gradeEffectFor('vector', { texture: {} }), null);
  assert.equal(gradeEffectFor('realistic', null), null); // …nor does realistic before the LUT lands
});

test('the background is the contract colour, opaque', () => {
  const bg = backgroundFor('realistic');
  const hex = PALETTE.fogFar.replace('#', '');
  assert.deepEqual(bg, [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16), 255]);
});

test('referenceGroundMeters is the heightfield median, in real metres', () => {
  assert.equal(referenceGroundMeters({ heights: [0, 1, 2, 3, 100] }), 2);
  assert.equal(referenceGroundMeters({ heights: new Float32Array([4, 0, 2, 6]) }), 3);
  assert.equal(referenceGroundMeters(null), 0);
  assert.equal(referenceGroundMeters({ heights: [] }), 0);
});

// ---------------------------------------------------------------------------
// R1.5 — what the new material state compiles into
// ---------------------------------------------------------------------------
test('the fog is AERIAL PERSPECTIVE: desaturate, cool, then wash', () => {
  const { fs } = fogSource();
  // The defect this replaces was one `mix(colour, fogColour, t)`: every hue marched to the same
  // grey at the same rate, which reads as an alpha fade into a hex code rather than as distance.
  assert.match(fs, /0\.299, 0\.587, 0\.114/, 'the fog must take luma before it can desaturate');
  assert.ok(fs.includes(String(FOG_DESATURATION.toFixed(6))), 'the contract desaturation is not in the shader');
  assert.ok(fs.includes(String(FOG_COOL_AMOUNT.toFixed(6))), 'the contract cool shift is not in the shader');
  // Three mixes, in order, and the LAST one is the wash toward the far-fog colour.
  const mixes = fs.match(/mix\(/g) ?? [];
  assert.ok(mixes.length >= 3, `expected desaturate + cool + wash, found ${mixes.length} mixes`);
  assert.match(fs, /fragColor\.rgb = mix\(tzC, vec3\(/, 'the wash must run last, on the already-graded colour');
});

test('the ground shader adds a wet-road lobe from an albedo mask', () => {
  const ext = groundDetailExtensionFor('realistic', { albedo: 1, normal: 1, orm: 1, macro: 1 });
  assert.ok(ext, 'realistic + textures should produce a ground extension');
  const { inject } = ext.getShaders(ext);
  // The mask is read from the BAKE, in the colour filter, before this extension modulates anything.
  assert.match(inject['fs:DECKGL_FILTER_COLOR'], /tz_roadMask = smoothstep/);
  assert.ok(inject['fs:DECKGL_FILTER_COLOR'].indexOf('tz_roadMask') < inject['fs:DECKGL_FILTER_COLOR'].indexOf('tzDet'),
    'the mask must be taken before the detail maps modulate the albedo, or it drifts with the tuning');
  // It travels to main's tail as a fragment GLOBAL — a hook function cannot see main's locals and
  // main cannot see a hook's, so a varying would be wrong and a local would not compile.
  assert.match(inject['fs:#decl'], /float tz_roadMask = 0\.0;/);
  // …and the lobe itself is added AFTER lighting, or it is a second albedo, not a reflection.
  const end = inject['fs:#main-end'];
  assert.match(end, /fragColor\.rgb \+=/, 'a specular is added to the lit colour, never multiplied into it');
  assert.match(end, /tz_roadMask/);
  assert.match(end, /pow\(max\(dot\(/, 'no Blinn-Phong term in the road lobe');
  const spec = specularFor('realistic', 'road');
  assert.ok(end.includes(spec.shininess.toFixed(6)), `the road exponent ${spec.shininess} is not in the shader`);
  // Vector never gets the extension at all.
  assert.equal(groundDetailExtensionFor('vector', { albedo: 1, normal: 1, orm: 1, macro: 1 }), null);
});

test('water decodes its depth from COLOR_0 in the one hook that can see it', () => {
  const ext = waterExtensionFor('realistic');
  assert.ok(ext, 'realistic should produce a water extension');
  const { inject } = ext.getShaders(ext);
  // `colors` is a vertex ATTRIBUTE. deck emits a hook injection as a standalone function placed
  // ahead of the layer's own declarations, so the attribute is only in scope in `vs:#main-start`,
  // which luma inlines into main(). Reading it from DECKGL_FILTER_GL_POSITION does not compile.
  assert.match(inject['vs:#main-start'], /tz_wDepth = colors\.r/);
  assert.match(inject['vs:#main-start'], /tz_wIn = colors\.g/);
  assert.equal(inject['vs:DECKGL_FILTER_GL_POSITION'], undefined);
  assert.match(inject['vs:#decl'], /out float tz_wDepth/);
  assert.match(inject['fs:#decl'], /in float tz_wDepth/);
  // Depth drives the body colour AND the alpha; the sky term is added after, with a Fresnel lift.
  const filter = inject['fs:DECKGL_FILTER_COLOR'];
  assert.match(filter, /color\.rgb = tzBody;/);
  assert.match(filter, /color\.a = tzIn \* mix\(/, 'the shore fade is alpha, not a stroke');
  assert.ok(filter.includes(WATER.shoreAlpha.toFixed(6)) && filter.includes(WATER.maxAlpha.toFixed(6)));
  assert.match(inject['fs:#main-end'], /pow\(1\.0 - clamp\(dot\(tzN, tzV\)/, 'no Fresnel term on the water');
  // Vector keeps its flat semantic fill.
  assert.equal(waterExtensionFor('vector'), null);
});

test('surfaceMaterial carries the frozen lobe, and vector rock is not a hole', () => {
  for (const kind of ['building', 'roof', 'prop', 'rock', 'boulder', 'foliage', 'trunk', 'slabLike']) {
    const m = surfaceMaterial('realistic', kind);
    assert.deepEqual(
      { shininess: m.shininess, specularColor: m.specularColor },
      specularFor('realistic', kind),
      `${kind} is not taking its lobe from the contract`,
    );
    assert.deepEqual(surfaceMaterial('vector', kind).specularColor, [0, 0, 0], `${kind} reflects in vector mode`);
  }
  // Woods' Mountain Spine read as a HOLE in the vector skin because rock ran ambient 0.36 under a
  // light whose key is 0.12 — 36% of the albedo and nothing else, against a black void. Part C's
  // flip table says vector is "unlit or near-unlit high ambient" for every family.
  for (const kind of ['rock', 'boulder']) {
    assert.ok(surfaceMaterial('vector', kind).ambient >= 0.7, `vector ${kind} ambient is too low to read on a black void`);
  }
  // The player marker is UI, not a world surface, and keeps its own lobe in both looks.
  assert.deepEqual(surfaceMaterial('realistic', 'player'), surfaceMaterial('vector', 'player'));
});

test('materialTint separates a wall from its roof, and only the roof folds in the sky', () => {
  const wall = materialTint('realistic', 'building-concrete-panel');
  const roofPlain = materialTint('realistic', 'roof-tar');
  const roofLit = materialTint('realistic', 'roof-tar', 0, true);
  const luma = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
  assert.ok(luma(roofPlain) < luma(wall) - 20, 'a tar roof must read clearly darker than a concrete wall');
  // Flat caps are drawn by non-extruded SolidPolygonLayers, which deck never lights, so the roof's
  // broad sky lobe has to arrive in the albedo or it never arrives at all.
  assert.ok(luma(roofLit) > luma(roofPlain), 'the unlit roof never picked up its sky lobe');
  // The jitter is deterministic and small.
  assert.deepEqual(materialTint('realistic', 'building-brick', 421), materialTint('realistic', 'building-brick', 421));
  const jittered = materialTint('realistic', 'building-brick', 999);
  const plain = materialTint('realistic', 'building-brick');
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(jittered[i] - plain[i]) <= Math.ceil(plain[i] * 0.07) + 1);
  // Vector answers the contract's flat semantic fill, and takes no sky fold.
  assert.deepEqual(materialTint('vector', 'roof-tar', 0, true), materialTint('vector', 'roof-tar'));
});

test('the grade adds a sky ramp that can only touch atmosphere', () => {
  const fs = gradeEffectFor('realistic', { texture: { id: 'fake' } }).module.fs;
  assert.match(fs, /float skyness = 1\.0 - smoothstep/, 'the sky ramp is missing');
  assert.match(fs, /1\.0 - uv\.y/, "deck's screen pass puts uv.y = 1 at the top; the zenith belongs there");
  assert.ok(fs.includes(BACKDROP.realistic.skyTolerance.toFixed(6)), 'the ramp must be bounded by the contract tolerance');
  // The ramp is applied BEFORE the LUT, so the grade still owns the final colour.
  assert.ok(fs.indexOf('skyness') < fs.indexOf('tzGrade_lut(c)'));
  // …and the label/icon/quest layers in the same framebuffer are far from the fog colour, so the
  // smoothstep gates them out. Assert the gate exists rather than the pixels: this is the same
  // full-screen pass FXAA was removed from for exactly that reason.
  assert.match(fs, /skyness \* /);
});

test('the contact rings widen, and the backdrop margin outruns the fog', () => {
  const rings = shadowRings('realistic');
  assert.equal(rings.length, 3);
  assert.ok(rings[0] < rings[1] && rings[1] < rings[2], 'the penumbra must widen outward');
  assert.deepEqual(shadowRings('nonsense'), rings, 'an unknown look falls back to the default');
  // 60 m of apron could never reach the fog's far end; the haze has to.
  const customsDiagonal = 1223;
  assert.ok(voidMargin('realistic', customsDiagonal) > fogParams('realistic', customsDiagonal).targetMeters);
  assert.equal(voidMargin('realistic', 0), Math.max(60, BACKDROP.realistic.voidMarginFactor * 1000));
  // The skirt ramp darkens downward in realistic and is a no-op in vector.
  const ramp = skirtRamp('realistic');
  assert.ok(ramp.bottom[0] < ramp.top[0] && ramp.feather > 0);
  assert.deepEqual(skirtRamp('vector').top, skirtRamp('vector').bottom);
});
