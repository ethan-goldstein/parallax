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

export class Globe {
  readonly scene = new THREE.Scene()
  readonly camera: THREE.PerspectiveCamera
  #renderer: THREE.WebGLRenderer
  #container: HTMLElement

  #points: THREE.Mesh
  #interleaved: THREE.InstancedInterleavedBuffer | null = null
  #geometry: THREE.InstancedBufferGeometry
  #material: THREE.ShaderMaterial

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

    const built = this.#buildPoints(opts.maxPoints)
    this.#geometry = built.geometry
    this.#material = built.material
    this.#points = built.mesh
    this.scene.add(this.#points)

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

  #buildPoints(maxPoints: number): {
    geometry: THREE.InstancedBufferGeometry
    material: THREE.ShaderMaterial
    mesh: THREE.Mesh
  } {
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

    // Placeholder buffer, replaced on the first updateFromHeap() by a view over
    // wasm memory. Allocated at full size so the GPU-side buffer is sized once.
    const placeholder = new Float32Array(maxPoints * POINT_FLOATS)
    this.#attachInterleaved(geometry, placeholder)

    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
        uColorLow: { value: new THREE.Color(0xffb000) },
        uColorHigh: { value: new THREE.Color(0xe5484d) },
      },
      vertexShader: /* glsl */ `
        attribute vec2 aLatLon;
        attribute float aScalar;

        varying float vScalar;
        varying vec2 vQuad;

        ${LAT_LON_TO_VEC3}

        void main() {
          vScalar = aScalar;
          vQuad = position.xy;

          // Lift slightly off the surface so points are not z-fighting the
          // sphere at grazing angles.
          vec3 world = latLonToVec3(aLatLon.x, aLatLon.y, 1.008);
          vec4 mv = modelViewMatrix * vec4(world, 1.0);

          // Magnitude drives radius. Earthquake magnitude is logarithmic, so a
          // linear size ramp already encodes an exponential energy difference —
          // no extra scaling curve needed.
          float size = 0.006 + max(aScalar, 0.0) * 0.0045;
          mv.xy += position.xy * size;

          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColorLow;
        uniform vec3 uColorHigh;
        varying float vScalar;
        varying vec2 vQuad;

        void main() {
          float d = length(vQuad);
          if (d > 1.0) discard;

          float core = smoothstep(1.0, 0.0, d);
          float halo = pow(core, 4.0);

          vec3 c = mix(uColorLow, uColorHigh, clamp((vScalar - 2.5) / 4.0, 0.0, 1.0));
          gl_FragColor = vec4(c, halo * 0.85 + core * 0.15);
        }
      `,
    })

    const mesh = new THREE.Mesh(geometry, material)
    // The bounding sphere is meaningless for instanced geometry whose real
    // positions are computed in the shader; without this Three.js frustum-culls
    // the whole layer the moment the origin quad leaves view.
    mesh.frustumCulled = false

    return { geometry, material, mesh }
  }

  #attachInterleaved(geometry: THREE.InstancedBufferGeometry, array: Float32Array): void {
    const buffer = new THREE.InstancedInterleavedBuffer(array, POINT_FLOATS, 1)
    buffer.setUsage(THREE.DynamicDrawUsage)

    // lat, lon at floats 0..1; scalar at float 2. Float 3 is the fact id,
    // reinterpreted — read back on the CPU for picking rather than in a shader.
    geometry.setAttribute('aLatLon', new THREE.InterleavedBufferAttribute(buffer, 2, 0))
    geometry.setAttribute('aScalar', new THREE.InterleavedBufferAttribute(buffer, 1, 2))

    this.#interleaved = buffer
  }

  /**
   * Points at a fresh view over the wasm heap.
   *
   * `view` must be re-derived from Heap on every call — never cached by the
   * caller. If the underlying ArrayBuffer identity changed (heap growth, or an
   * engine-side reallocation) the interleaved buffer is rebuilt; otherwise only
   * the dirty flag is set and the same GPU buffer is re-uploaded.
   */
  updateFromHeap(view: Float32Array, count: number): void {
    const buffer = this.#interleaved
    if (buffer === null) return

    if (buffer.array !== view) {
      // Identity changed, so the old buffer refers to memory that may no longer
      // be ours. Rebuilding is correct and rare; doing it every frame would
      // throw away the GPU-side buffer each time.
      this.#geometry.deleteAttribute('aLatLon')
      this.#geometry.deleteAttribute('aScalar')
      buffer.array = view
      this.#attachInterleaved(this.#geometry, view)
    }

    this.#interleaved!.needsUpdate = true
    this.#geometry.instanceCount = count
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

    this.#material.dispose()
    this.#geometry.dispose()
    this.#renderer.dispose()
    this.#renderer.domElement.remove()
  }
}
