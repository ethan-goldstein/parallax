// ── points.frag.glsl ────────────────────────────────────────────────────────
// Disc with a halo, coloured by where the scalar sits on the layer's ramp.
//
// Carried over unchanged in behaviour from the three.js material this replaced,
// so seismic and maritime keep the exact look they had before the renderer swap.
// The only edits are GLSL ES 3.00 spelling: `varying` became `in`, and
// `gl_FragColor` became a declared output.
//
// pointsLayer.ts prepends `#version 300 es` — see the note in points.vert.glsl.
// ────────────────────────────────────────────────────────────────────────────

precision highp float;

uniform vec3 u_colorLow;
uniform vec3 u_colorHigh;
uniform float u_rampLow;
uniform float u_rampHigh;
uniform float u_opacity;

// The glyph sheet. RED is a wide stroke of the outline, GREEN the filled body —
// see icons.ts for why one texture carries both.
uniform sampler2D u_atlas;
// Where this layer's glyph sits in the sheet: origin.xy, size.zw.
uniform vec4 u_glyphUV;
uniform float u_iconMix;

in float v_scalar;
in vec2 v_quad;

out vec4 fragColor;

void main() {
  float t = clamp((v_scalar - u_rampLow) / max(u_rampHigh - u_rampLow, 1e-6), 0.0, 1.0);
  vec3 ramp = mix(u_colorLow, u_colorHigh, t);

  // ── the disc ─────────────────────────────────────────────────────────────
  float d = length(v_quad);
  float core = smoothstep(1.0, 0.0, d);
  float halo = pow(core, 4.0);
  vec4 dot = vec4(ramp, (halo * 0.85 + core * 0.15) * u_opacity);

  // Nothing to sample when the layer declared no glyph; u_glyphUV.z is zero and
  // the whole branch collapses to the disc.
  if (u_iconMix <= 0.001 || u_glyphUV.z <= 0.0) {
    if (d > 1.0) discard;
    fragColor = dot;
    return;
  }

  // ── the glyph ────────────────────────────────────────────────────────────
  vec2 cell = v_quad * 0.5 + 0.5;
  vec4 tx = texture(u_atlas, u_glyphUV.xy + clamp(cell, 0.0, 1.0) * u_glyphUV.zw);

  float body = tx.g;
  // The rim is the part of the wide stroke the body does not already cover.
  float rim = max(tx.r - tx.g, 0.0);

  // Body in the ramp colour over a near-black rim, so the mark holds its shape
  // against the satellite basemap as well as the dark one.
  vec3 iconRgb = mix(vec3(0.02, 0.02, 0.03), ramp, body);
  float iconA = clamp(max(body, rim * 0.9), 0.0, 1.0) * u_opacity;
  vec4 icon = vec4(iconRgb, iconA);

  vec4 outCol = mix(dot, icon, u_iconMix);
  if (outCol.a < 0.004) discard;
  fragColor = outCol;
}
