// ── web/src/sources/recon/countries.ts ──────────────────────────────────────
// ISO 3166-1 alpha-2 → an approximate centre of the country, [lat, lon].
//
// ── what this is deliberately not ───────────────────────────────────────────
//
// This is NOT geolocation. It exists so a network lookup can be placed on the
// map at the country an autonomous system is REGISTERED in, which is a fact
// about a registry entry rather than a claim about where any machine is.
//
// The alternative was IP geolocation, and it was rejected twice over: every
// keyless HTTPS provider is either inaccurate or metered, `ip-api.com` is
// HTTP-only and would be blocked as mixed content on a site served over HTTPS,
// and — the actual reason — IP geolocation is wrong often enough that plotting
// its output as a position would be the kind of confident overclaim this project
// exists to argue against. A country centroid cannot be mistaken for precision.
//
// Coordinates are visual centres rather than computed centroids: the centroid of
// a country wrapping a bay or spanning an archipelago lands in water, and a
// marker in the sea reads as a bug.
//
// The list is not exhaustive. An unlisted country yields no position, and the
// lookup is reported in the panel without being plotted — which is the honest
// outcome, and better than inventing one.
// ────────────────────────────────────────────────────────────────────────────

export const COUNTRY_CENTROIDS: Readonly<Record<string, readonly [number, number]>> = {
  AE: [24.0, 54.0], AF: [34.0, 66.0], AL: [41.0, 20.0], AM: [40.3, 45.0],
  AO: [-12.5, 18.5], AR: [-35.0, -65.0], AT: [47.6, 14.1], AU: [-25.0, 134.0],
  AZ: [40.3, 47.9], BA: [44.0, 18.0], BD: [24.0, 90.0], BE: [50.6, 4.6],
  BG: [42.8, 25.5], BH: [26.0, 50.5], BJ: [9.5, 2.3], BO: [-17.0, -65.0],
  BR: [-10.0, -52.0], BW: [-22.0, 24.0], BY: [53.7, 28.0], CA: [56.0, -98.0],
  CD: [-3.0, 23.0], CH: [46.8, 8.2], CI: [7.5, -5.5], CL: [-33.0, -71.0],
  CM: [6.0, 12.5], CN: [35.0, 105.0], CO: [4.0, -73.0], CR: [10.0, -84.0],
  CU: [21.5, -79.0], CY: [35.0, 33.0], CZ: [49.8, 15.5], DE: [51.2, 10.4],
  DK: [56.0, 10.0], DO: [19.0, -70.5], DZ: [28.0, 2.6], EC: [-1.5, -78.5],
  EE: [58.7, 25.5], EG: [26.8, 30.0], ES: [40.2, -3.6], ET: [9.0, 39.5],
  FI: [64.0, 26.0], FR: [46.6, 2.4], GA: [-0.8, 11.6], GB: [54.0, -2.4],
  GE: [42.0, 43.5], GH: [7.9, -1.0], GR: [39.0, 22.0], GT: [15.5, -90.3],
  HK: [22.3, 114.2], HN: [14.8, -86.5], HR: [45.1, 15.5], HU: [47.1, 19.5],
  ID: [-2.0, 118.0], IE: [53.2, -8.0], IL: [31.4, 35.0], IN: [22.0, 79.0],
  IQ: [33.0, 43.7], IR: [32.5, 54.0], IS: [64.9, -18.6], IT: [42.8, 12.6],
  JM: [18.1, -77.3], JO: [31.2, 36.5], JP: [36.5, 138.0], KE: [0.5, 37.9],
  KG: [41.5, 74.5], KH: [12.6, 105.0], KR: [36.5, 127.8], KW: [29.3, 47.6],
  KZ: [48.0, 67.0], LA: [18.5, 103.9], LB: [33.9, 35.9], LK: [7.6, 80.7],
  LT: [55.3, 23.9], LU: [49.8, 6.1], LV: [56.9, 24.9], LY: [27.0, 17.5],
  MA: [31.8, -6.5], MD: [47.2, 28.5], ME: [42.8, 19.3], MG: [-19.4, 46.7],
  MK: [41.6, 21.7], MM: [21.0, 96.0], MN: [46.8, 103.8], MT: [35.9, 14.4],
  MU: [-20.3, 57.6], MX: [23.6, -102.5], MY: [4.2, 109.0], MZ: [-18.0, 35.0],
  NA: [-22.0, 17.2], NG: [9.1, 8.7], NI: [12.9, -85.2], NL: [52.2, 5.5],
  NO: [64.0, 12.0], NP: [28.4, 84.1], NZ: [-41.5, 172.8], OM: [21.0, 57.0],
  PA: [8.5, -80.1], PE: [-9.2, -75.0], PH: [12.9, 122.0], PK: [30.0, 69.4],
  PL: [52.0, 19.4], PR: [18.2, -66.4], PS: [31.9, 35.2], PT: [39.6, -8.0],
  PY: [-23.4, -58.4], QA: [25.3, 51.2], RO: [45.9, 25.0], RS: [44.0, 20.9],
  RU: [61.0, 90.0], RW: [-1.9, 29.9], SA: [24.0, 45.0], SD: [15.0, 30.0],
  SE: [62.0, 16.0], SG: [1.35, 103.8], SI: [46.1, 14.8], SK: [48.7, 19.5],
  SN: [14.5, -14.5], SO: [5.2, 46.2], SV: [13.8, -88.9], SY: [35.0, 38.0],
  TH: [15.0, 101.0], TJ: [38.9, 71.3], TM: [39.0, 59.6], TN: [34.0, 9.6],
  TR: [39.0, 35.2], TT: [10.5, -61.3], TW: [23.7, 121.0], TZ: [-6.4, 34.9],
  UA: [49.0, 32.0], UG: [1.4, 32.4], US: [39.5, -98.4], UY: [-32.8, -56.0],
  UZ: [41.4, 64.6], VE: [7.1, -66.0], VN: [16.0, 106.5], YE: [15.6, 47.6],
  ZA: [-29.0, 25.0], ZM: [-13.5, 27.9], ZW: [-19.0, 29.9],
}

/** `[lat, lon]` for a country code, or null when it is not in the table. */
export function centroidFor(code: string | null | undefined): readonly [number, number] | null {
  if (!code) return null
  return COUNTRY_CENTROIDS[code.toUpperCase()] ?? null
}
