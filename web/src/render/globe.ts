// ── web/src/render/globe.ts ─────────────────────────────────────────────────
// The globe, rendering directly out of the WASM heap.
//
// ── why custom Three.js and not MapLibre ───────────────────────────────────
//
// The architecture picks the renderer, not aesthetics. The engine hands back a
// packed Float32Array of [lat, lon, scalar, factId] living inside the wasm
// heap. Three.js InstancedInterleavedBuffer can point *at that array* — no
// copy, no per-entity JavaScript object, nothing allocated per frame.
//
// MapLibre's data path wants GeoJSON Feature objects, which is exactly the
// per-entity allocation the entire boundary design in heap.ts exists to avoid.
// Feeding it 100k points means constructing 100k objects every refresh.
//
// The spherical convention is carried over unchanged from ABROAD/src/globe.js
// so the two projects agree on what a lat/lon means — but it is evaluated in
// the vertex shader here, so the CPU never touches a coordinate.
// ────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three'

import { POINT_FLOATS } from '../engine/abi'

const GLOBE_RADIUS = 1

// Frames skipped before frame-time averaging begins — see the tick loop.
const WARMUP_FRAMES = 5

// Matches latLonToVec3 in ABROAD/src/globe.js:31.
const LAT_LON_TO_VEC3 = /* glsl */ `
  vec3 latLonToVec3(float lat, float lon, float r) {
    float phi = radians(90.0 - lat);
    float theta = radians(lon);
    return vec3(
       r * sin(phi) * cos(theta),
       r * cos(phi),
      -r * sin(phi) * sin(theta)
    );
  }
`

export interface GlobeOptions {
  container: HTMLElement
  maxPoints: number
}

/** Visual identity for one data layer. */
export interface LayerSpec {
  colorLow: number
  colorHigh: number
  /** Base radius in world units before the scalar contribution. */
  sizeBase: number
  /** How much the per-point scalar grows the radius. */
  sizeScale: number
  /** Scalar value mapped to colorLow, and to colorHigh. */
  rampLow: number
  rampHigh: number
}

/** A layer's GPU-side state, pointing at engine-owned memory. */
interface PointLayer {
  mesh: THREE.Mesh
  geometry: THREE.InstancedBufferGeometry
  material: THREE.ShaderMaterial
  interleaved: THREE.InstancedInterleavedBuffer
}

export class Globe {
  readonly scene = new THREE.Scene()
  readonly camera: THREE.PerspectiveCamera
  #renderer: THREE.WebGLRenderer
  #container: HTMLElement

  #layers = new Map<string, PointLayer>()
  #maxPoints: number

  #rotation = 0
  #autoRotate = true
  #running = false
  #frameHandle = 0

  // Frame timing, exposed to the benchmark panel. Measured, not asserted.
  #frameMs = 0
  #frameEma = 0
  #frameCount = 0

  constructor(opts: GlobeOptions) {
    this.#container = opts.container

    this.#renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    })
    // Capped at 2: beyond that the fill cost doubles for a difference nobody
    // can see, and phones cook themselves.
    this.#renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.#renderer.setClearColor(0x0b0b0d, 1)
    this.#container.appendChild(this.#renderer.domElement)

    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100)
    this.camera.position.set(0, 0.55, 2.9)
    this.camera.lookAt(0, 0, 0)

    this.scene.add(this.#buildSphere())
    this.scene.add(this.#buildGraticule())
    this.scene.add(this.#buildAtmosphere())

    this.#maxPoints = opts.maxPoints

    this.#resize()
    window.addEventListener('resize', this.#resize)
  }

  // ── the globe body ───────────────────────────────────────────────────────
  // Near-black sphere with near-white line work. The deliberate inversion of
  // every blue-marble OSINT dashboard: the globe is a paper chart, and only
  // DATA carries colour.

  #buildSphere(): THREE.Mesh {
    return new THREE.Mesh(
      new THREE.SphereGeometry(GLOBE_RADIUS * 0.995, 64, 48),
      new THREE.MeshBasicMaterial({ color: 0x0e0e11 }),
    )
  }

  #buildGraticule(): THREE.LineSegments {
    // Placeholder for Natural Earth coastlines, which arrive with the snapshot
    // format in Phase 4. A graticule is honest about being a grid; a
    // low-detail coastline would look like bad data.
    const positions: number[] = []
    const push = (lat: number, lon: number) => {
      const phi = THREE.MathUtils.degToRad(90 - lat)
      const theta = THREE.MathUtils.degToRad(lon)
      positions.push(
        Math.sin(phi) * Math.cos(theta),
        Math.cos(phi),
        -Math.sin(phi) * Math.sin(theta),
      )
    }

    for (let lat = -60; lat <= 60; lat += 30) {
      for (let lon = -180; lon < 180; lon += 3) {
        push(lat, lon)
        push(lat, lon + 3)
      }
    }
    for (let lon = -180; lon < 180; lon += 30) {
      for (let lat = -90; lat < 90; lat += 3) {
        push(lat, lon)
        push(lat + 3, lon)
      }
    }

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    return new THREE.LineSegments(
      geo,
      new THREE.LineBasicMaterial({ color: 0xe8e6e1, transparent: true, opacity: 0.09 }),
    )
  }

  #buildAtmosphere(): THREE.Mesh {
    // Backside-rendered rim light. Additive blending on the far hemisphere
    // reads as a limb glow without any post-processing pass.
    return new THREE.Mesh(
      new THREE.SphereGeometry(GLOBE_RADIUS * 1.14, 48, 32),
      new THREE.ShaderMaterial({
        transparent: true,
        blending: THREE.AdditiveBlending,
        side: THREE.BackSide,
        depthWrite: false,
        uniforms: { uColor: { value: new THREE.Color(0x3fd0c9) } },
        vertexShader: /* glsl */ `
          varying vec3 vNormal;
          void main() {
            vNormal = normalize(normalMatrix * normal);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          uniform vec3 uColor;
          varying vec3 vNormal;
          void main() {
            float rim = pow(0.62 - dot(vNormal, vec3(0.0, 0.0, 1.0)), 3.0);
            gl_FragColor = vec4(uColor, 1.0) * clamp(rim, 0.0, 1.0) * 0.55;
          }
        `,
      }),
    )
  }

  // ── the data layer ───────────────────────────────────────────────────────

  /**
   * Creates a named data layer. Each layer owns one instanced draw call and
   * one colour ramp, so seismic and maritime data stay visually distinct
   * without either of them needing a per-point source field in the wire
   * format — which would break the 16-byte vec4 stride.
   */
  addLayer(name: string, spec: LayerSpec): void {
    // A single quad per instance, oriented to face the camera in the shader.
    // Cheaper than a sphere per point by two orders of magnitude, and at these
    // sizes a screen-facing disc is visually identical.
    const geometry = new THREE.InstancedBufferGeometry()
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3),
    )
    geometry.setIndex([0, 1, 2, 0, 2, 3])
    geometry.instanceCount = 0

    // Placeholder, replaced on the first updateLayer() by a view over wasm
    // memory. Allocated at full size so the GPU buffer is sized once.
    const buffer = this.#attachInterleaved(geometry, new Float32Array(this.#maxPoints * POINT_FLOATS))

    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uColorLow: { value: new THREE.Color(spec.colorLow) },
        uColorHigh: { value: new THREE.Color(spec.colorHigh) },
        uSizeBase: { value: spec.sizeBase },
        uSizeScale: { value: spec.sizeScale },
        uRampLow: { value: spec.rampLow },
        uRampHigh: { value: spec.rampHigh },
      },
      vertexShader: /* glsl */ `
        attribute vec2 aLatLon;
        attribute float aScalar;

        uniform float uSizeBase;
        uniform float uSizeScale;

        varying float vScalar;
        varying vec2 vQuad;

        ${LAT_LON_TO_VEC3}

        void main() {
          vScalar = aScalar;
          vQuad = position.xy;

          // Lift slightly off the surface so points do not z-fight the sphere
          // at grazing angles.
          vec3 world = latLonToVec3(aLatLon.x, aLatLon.y, 1.008);
          vec4 mv = modelViewMatrix * vec4(world, 1.0);

          mv.xy += position.xy * (uSizeBase + max(aScalar, 0.0) * uSizeScale);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColorLow;
        uniform vec3 uColorHigh;
        uniform float uRampLow;
        uniform float uRampHigh;

        varying float vScalar;
        varying vec2 vQuad;

        void main() {
          float d = length(vQuad);
          if (d > 1.0) discard;

          float core = smoothstep(1.0, 0.0, d);
          float halo = pow(core, 4.0);

          float t = clamp((vScalar - uRampLow) / max(uRampHigh - uRampLow, 1e-6), 0.0, 1.0);
          gl_FragColor = vec4(mix(uColorLow, uColorHigh, t), halo * 0.85 + core * 0.15);
        }
      `,
    })

    const mesh = new THREE.Mesh(geometry, material)
    // Instanced positions are computed in the shader, so the CPU-side bounding
    // sphere is meaningless; without this Three.js culls the whole layer the
    // moment the origin quad leaves view.
    mesh.frustumCulled = false

    this.scene.add(mesh)
    this.#layers.set(name, { mesh, geometry, material, interleaved: buffer })
  }

  #attachInterleaved(
    geometry: THREE.InstancedBufferGeometry,
    array: Float32Array,
  ): THREE.InstancedInterleavedBuffer {
    const buffer = new THREE.InstancedInterleavedBuffer(array, POINT_FLOATS, 1)
    buffer.setUsage(THREE.DynamicDrawUsage)

    // lat, lon at floats 0..1; scalar at float 2. Float 3 is the fact id,
    // reinterpreted — read back on the CPU for picking rather than in a shader.
    geometry.setAttribute('aLatLon', new THREE.InterleavedBufferAttribute(buffer, 2, 0))
    geometry.setAttribute('aScalar', new THREE.InterleavedBufferAttribute(buffer, 1, 2))

    return buffer
  }

  /**
   * Points a layer at a fresh view over the wasm heap.
   *
   * `view` must be re-derived from Heap on every call and never cached by the
   * caller. If the underlying ArrayBuffer identity changed — heap growth, or
   * an engine-side reallocation — the interleaved buffer is rebuilt; otherwise
   * only the dirty flag is set and the same GPU buffer is re-uploaded.
   */
  updateLayer(name: string, view: Float32Array, count: number): void {
    const layer = this.#layers.get(name)
    if (!layer) return

    if (layer.interleaved.array !== view) {
      // Identity changed, so the old buffer may refer to memory that is no
      // longer ours. Rebuilding is correct and rare; doing it every frame
      // would discard the GPU-side buffer each time.
      layer.geometry.deleteAttribute('aLatLon')
      layer.geometry.deleteAttribute('aScalar')
      layer.interleaved = this.#attachInterleaved(layer.geometry, view)
    }

    layer.interleaved.needsUpdate = true
    layer.geometry.instanceCount = count
  }

  setLayerVisible(name: string, visible: boolean): void {
    const layer = this.#layers.get(name)
    if (layer) layer.mesh.visible = visible
  }

  // ── loop ─────────────────────────────────────────────────────────────────

  get frameMs(): number {
    return this.#frameEma
  }

  set autoRotate(v: boolean) {
    this.#autoRotate = v
  }

  start(): void {
    if (this.#running) return
    this.#running = true

    let last = performance.now()
    const tick = () => {
      if (!this.#running) return
      this.#frameHandle = requestAnimationFrame(tick)

      const now = performance.now()
      const dt = now - last
      last = now

      if (this.#autoRotate) {
        this.#rotation += dt * 0.00004
        this.scene.rotation.y = this.#rotation
      }

      this.#renderer.render(this.scene, this.camera)

      this.#frameMs = performance.now() - now
      this.#frameCount++

      // Discard the first few frames before averaging. Frame 1 includes shader
      // compilation and buffer upload and runs hundreds of times longer than
      // steady state; seeding an EMA with it produces a reported frame time
      // that is wrong by two orders of magnitude and decays too slowly to
      // correct itself on a throttled tab.
      if (this.#frameCount > WARMUP_FRAMES) {
        this.#frameEma =
          this.#frameEma === 0 ? this.#frameMs : this.#frameEma * 0.9 + this.#frameMs * 0.1
      }
    }
    this.#frameHandle = requestAnimationFrame(tick)
  }

  stop(): void {
    this.#running = false
    cancelAnimationFrame(this.#frameHandle)
  }

  #resize = (): void => {
    const w = this.#container.clientWidth || window.innerWidth
    const h = this.#container.clientHeight || window.innerHeight
    this.#renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  /** Releases GPU resources. Playbook §2: no leaks on teardown. */
  dispose(): void {
    this.stop()
    window.removeEventListener('resize', this.#resize)

    this.scene.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (mesh.geometry) mesh.geometry.dispose()
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose())
      else if (mat) mat.dispose()
    })

    for (const layer of this.#layers.values()) {
      layer.material.dispose()
      layer.geometry.dispose()
    }
    this.#layers.clear()
    this.#renderer.dispose()
    this.#renderer.domElement.remove()
  }
}
