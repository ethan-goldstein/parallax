# 0005. MapLibre hosts the renderer; the zero-copy path stays

**Status:** accepted, Phase 9. Reverses the rationale recorded in the old `web/src/render/globe.ts`
header.

## Context

The renderer was a hand-built three.js scene: a near-black sphere, a graticule, an additive
rim-light atmosphere, and one `InstancedBufferGeometry` per data layer whose interleaved buffer
pointed directly at the WASM heap.

That file opened with an explicit rejection of MapLibre:

> MapLibre's data path wants GeoJSON Feature objects, which is exactly the per-entity allocation
> the entire boundary design in heap.ts exists to avoid. Feeding it 100k points means constructing
> 100k objects every refresh.

The claim is true. It is also about the wrong API.

What the decision actually bought was a sphere with no coastlines, no imagery, no camera controls,
no zoom and no picking. `globe.ts:127` carried a note that Natural Earth coastlines would "arrive
with the snapshot format in Phase 4". Phase 4 shipped. They never arrived. The result rendered no
map at all — which made the project's central claim, that OSINT dashboards render only the present
tense while this one is bitemporal, impossible to demonstrate against anything.

## Decision

MapLibre GL JS v6 hosts the renderer. Data layers are drawn through `CustomLayerInterface` in raw
WebGL2. `three` is removed from `web/package.json`.

## Why the original objection does not apply

`addSource`/`setData` is one door into MapLibre. `CustomLayerInterface` is a different one: it hands
over the `WebGL2RenderingContext` and asks only that the layer draw inside MapLibre's frame.

The per-instance data path is now:

```
engine → Float32Array view over the WASM heap → gl.bufferSubData
```

No `Feature` objects, no per-entity allocation, no intermediate array — and one abstraction *fewer*
than before, since three.js's `InstancedInterleavedBuffer` is gone. **`web/src/engine/heap.ts` did
not change by a single line.** The invariant it enforces — re-derive the view on every call, never
cache it — is not only preserved but easier to honour, because the bytes are copied to the GPU
before `setData` returns and nothing retains a reference a heap growth could detach.

Projection happens in the vertex shader. MapLibre splices a prelude into the shader source exposing
`projectTile(vec2)`, which consumes normalised mercator; lat/lon → mercator is eight lines of GLSL.
The CPU still never touches a coordinate.

## Consequences

- **Bundle grows.** three.js tree-shaken was ~600 KB; maplibre-gl is ~800 KB gzipped. The built
  bundle is 981 KB raw / 259 KB gzipped. This is a real regression and the honest price of the
  trade.
- **`sizeBase`/`sizeScale` changed units**, from fractions of a unit-radius globe to screen pixels.
  MapLibre owns the camera and its zoom spans enough orders of magnitude that a world-space radius
  would be invisible at z0 and cover a country at z12.
- **The projection prelude is an API this project does not control.** Its shape changed between
  MapLibre v4 and v5. `maplibre-gl` should be pinned to an exact version, because a break would
  appear at runtime as a blank layer and `tsc` cannot see into interpolated GLSL.
- **Drawing anything that is not a point now requires subdivision.** Under globe projection a
  straight segment between two distant points cuts through the planet. Points are single vertices
  and are unaffected, but the graph edge layer in a later phase must tessellate great-circle arcs
  itself.
- **Depth testing is off and stays off.** Under globe projection `projectTile` writes a
  horizon distance into `gl_Position.z` rather than a depth, so the billboard offset touches only
  `.xy` — which is also what gives far-side culling for free, something the three.js sphere never
  had.
- **The style is built once, not mutated.** Projection and the satellite source are spliced into the
  style object before the map is constructed, rather than added from inside the map's own
  `style.load` handler. This is a construction preference — no post-load mutation to race with, and
  `setProjection` in particular reinitialises projection state that sources were already set up
  against. It is worth recording that this change was made while chasing a blank basemap and did
  **not** fix it; the cause there was a headless verification browser running as a hidden tab, where
  `requestAnimationFrame` never fires and MapLibre's render loop, and so its tile loading, is
  stalled. The declarative form is kept on its merits.

## What was rejected

**Keeping three.js and adding tiled imagery.** A quadtree raster loader, LOD, tile caching, label
placement and picking are all things MapLibre already ships, and the result would still have no
vector labels at street level.

**CesiumJS.** A true 3D globe with terrain, but the good imagery and terrain sit behind Cesium ion's
metered tier, which conflicts with the project's keyless-and-free constraint.

**EOX Sentinel-2 cloudless as the DEFAULT basemap.** CC BY-NC-SA for 2018 onward — the same licence
this project refuses TeleGeography submarine cables over, and share-alike on a default basemap would
attach its obligations to every screenshot and every export.

It ships as an opt-in basemap instead. NASA GIBS (public domain, 250 m, today's imagery) and the ODbL
vector style cover the default and the operational cases; Sentinel-2 at 10 m is selected deliberately,
and the obligations panel gains the non-commercial and share-alike terms while it is active. That is
the distinction the `shareAlike` and `nonCommercial` flags in `sources/registry.ts` were added for —
surfacing an obligation at the moment it is incurred, rather than declining the capability to avoid
having to mention it. The TeleGeography refusal is unaffected: it also fails on undocumented internal
endpoints, and nothing there is opt-in.
