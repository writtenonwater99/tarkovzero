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
} from '../src/atmosphere.js';
import { FOG, POST, PALETTE } from '../src/render-style.js';

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
