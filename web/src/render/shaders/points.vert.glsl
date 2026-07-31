// ── points.vert.glsl ────────────────────────────────────────────────────────
// Instanced billboard points, projected by MapLibre.
//
// This file deliberately has NO `#version` line. pointsLayer.ts assembles the
// real source as:
//
//     #version 300 es
//     <shaderData.vertexShaderPrelude>   MapLibre's projectTile() + uniforms
//     <shaderData.define>                globe / mercator switch
//     <this file>
//
// `#version` must be the first token in a GLSL source, so it cannot live here.
// Compile errors therefore report line numbers offset by the prelude's length;
// glutil.ts says so in the thrown message.
//
// Attribute locations are explicit so ONE vertex array object stays valid across
// every projection variant. MapLibre recompiles the prelude when the projection
// changes (globe ↔ mercator, and every frame of the transition between them),
// and without fixed locations each new program could bind attributes elsewhere
// and the VAO would silently feed the wrong floats.
// ────────────────────────────────────────────────────────────────────────────

precision highp float;

// Per-vertex: the corner of a unit quad, [-1,-1] .. [1,1]. Divisor 0.
layout(location = 0) in vec2 a_quad;

// Per-instance, read straight out of the wasm heap at 16-byte stride.
// Matches px::wire::Point — lat, lon at floats 0..1, scalar at float 2. Float 3
// is the fact id and is not bound here; picking reads it on the CPU.
layout(location = 1) in vec2 a_latlon;
layout(location = 2) in float a_scalar;

uniform vec2 u_viewport;
uniform float u_sizeBase;
uniform float u_sizeScale;

// 0 draws the disc, 1 draws the glyph. The CPU computes it from the map zoom
// against the layer's own threshold — see PointsLayer.setZoom for why the
// crossfade exists at all.
uniform float u_iconMix;
// Edge of the glyph mark in pixels. A silhouette needs roughly ten times the
// radius a dot does before it is recognisable rather than a smudge.
uniform float u_iconSize;

out float v_scalar;
out vec2 v_quad;

// MapLibre's projectTile() consumes normalised global mercator, 0..1 on both
// axes. Converting here rather than on the CPU is the whole reason the zero-copy
// path survived the move off three.js: the engine's Float32Array goes to the GPU
// untouched, and no JavaScript ever allocates a coordinate.
vec2 latLonToMercator(vec2 latlon) {
  // Clamped to the web-mercator limit. Beyond it the tangent below diverges and
  // a polar point would land at infinity rather than being dropped.
  float lat = clamp(latlon.x, -85.051129, 85.051129) * 0.01745329252;
  return vec2(
    (latlon.y + 180.0) / 360.0,
    0.5 - log(tan(0.78539816339 + 0.5 * lat)) / 6.28318530718
  );
}

void main() {
  v_scalar = a_scalar;
  v_quad = a_quad;

  gl_Position = projectTile(latLonToMercator(a_latlon));

  // Screen-space billboard. Offsetting only .xy leaves .z untouched, which
  // matters: under globe projection projectTile writes a horizon distance into
  // .z rather than a depth, so far-side points are clipped by the GPU for free.
  // Perturbing .z here would put points on the back of the planet back on screen.
  // The dot keeps its scalar-driven radius; the glyph does not. A plane drawn
  // at a size proportional to its altitude would be encoding the altitude twice
  // — once in colour, once in a shape whose whole job is to say "aircraft" — and
  // the small ones would stop being readable as planes at all.
  float dotPx = u_sizeBase + max(a_scalar, 0.0) * u_sizeScale;
  float px = mix(dotPx, u_iconSize, u_iconMix);
  gl_Position.xy += a_quad * (px * 2.0 / u_viewport) * gl_Position.w;
}
