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

in float v_scalar;
in vec2 v_quad;

out vec4 fragColor;

void main() {
  float d = length(v_quad);
  if (d > 1.0) discard;

  float core = smoothstep(1.0, 0.0, d);
  float halo = pow(core, 4.0);

  float t = clamp((v_scalar - u_rampLow) / max(u_rampHigh - u_rampLow, 1e-6), 0.0, 1.0);
  fragColor = vec4(mix(u_colorLow, u_colorHigh, t), (halo * 0.85 + core * 0.15) * u_opacity);
}
