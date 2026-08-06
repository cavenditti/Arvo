// OWNER: fe-plant-map — one self-contained MapLibre GL JS document shared by PlantMap.native
// (react-native-webview) and PlantMap.web (iframe srcDoc), exactly the architecture of
// ./mapHtml.ts. Bridge is JSON both ways:
//   in  → { type:'init', tileUrlTemplate, metric, scale, palette, parcelGeometry, focus,
//           selectedPlantId, labels, overlay? }   (native: injected window.__updatePlants(...)
//                                                  or a 'message' event; web: a 'message' event)
//   out → { type:'ready' } once the map is up, { type:'plant', id } on tap
//
// Why this scales: the plants never travel as JSON. The document points a MapLibre **vector**
// source at the MVT template (docs/API-PLANT.md §Plant vector tiles) and paints it with
// data-driven expressions, so 30k plants are drawn by the GPU from ~1 tile per screen. Below the
// circle layer's zoom the same source feeds a heatmap, so a parcel-wide view stays legible
// instead of collapsing into a solid blob of overlapping dots.
//
// No string in this document ever reaches innerHTML — the note uses textContent and there are no
// symbol/label layers — so mapHtml.ts's esc() helper has no counterpart here. That is also why
// the style declares no `glyphs`/`sprite`: a text layer would need a font endpoint, one more CDN
// dependency inside the WebView.
import type { ParcelGeometry } from '@/api/types';
import { mapPalette, type PlantMapPalette } from '@/features/plants/colors';
import type { PlantMapProps } from '../types';

export interface PlantMapLabels {
  /** shown while the first tiles are in flight */
  loading: string;
  /** parent-owned empty-state copy; tile visibility is deliberately not used as a plant count */
  empty: string;
  /** shown below zoom 10, where the API rejects tile requests */
  zoomIn: string;
  /** shown when MapLibre itself never arrives (offline field device, CDN blocked) */
  error: string;
  /** base-map switch labels (kept inside the map so the frozen PlantMap props stay unchanged) */
  map: string;
  satellite: string;
}

/** XYZ raster tiles drawn above the base map, below the plant layer (ortho/DSM, FR-P-053). */
export interface PlantMapOverlay {
  urlTemplate: string;
  opacity?: number;
  /** [w, s, e, n] — limits tile requests */
  bounds?: [number, number, number, number];
}

export interface PlantMapInitMessage {
  type: 'init';
  /** MVT template with {z}/{x}/{y}, already carrying ?metric=&capture=&token= */
  tileUrlTemplate: string;
  metric: PlantMapProps['metric'];
  /** colour-ramp domain; null = fall back to the 0..1 `norm` property alone */
  scale: { p5: number; p95: number } | null;
  /** Terra colours resolved from the theme — the document itself hardcodes nothing */
  palette: PlantMapPalette;
  parcelGeometry: ParcelGeometry | null;
  focus: [number, number, number?] | null;
  selectedPlantId: string | null;
  labels: PlantMapLabels;
  /** top edge for map-owned controls; native places it below the translucent navigation chrome */
  chromeTop: number;
  /** ortho/DSM raster tiles are out of P-MVP scope, so nothing sets this yet — the document
   *  honours it the day a capture serves them, which keeps that a payload change, not a rewrite */
  overlay?: PlantMapOverlay | null;
}

/** Flatten the frozen PlantMap props into the wire payload the MapLibre document understands. */
export function buildPlantInit(
  props: PlantMapProps,
  labels: PlantMapLabels,
  chromeTop = 12,
): PlantMapInitMessage {
  return {
    type: 'init',
    tileUrlTemplate: props.tileUrlTemplate,
    metric: props.metric,
    scale: props.scale ?? null,
    palette: mapPalette(props.metric),
    parcelGeometry: props.parcelGeometry ?? null,
    focus: props.focus ?? null,
    selectedPlantId: props.selectedPlantId ?? null,
    labels,
    chromeTop,
  };
}

// MapLibre GL JS loads two ways, chosen by the caller (the rest of the document is identical):
//  • MAPLIBRE_CDN — native (react-native-webview). Pinned to an exact version AND an SRI digest,
//    exactly like the leaflet tags in ./mapHtml.ts. `crossorigin="anonymous"` makes the browser
//    enforce the pin (unpkg answers `access-control-allow-origin: *`, so it also holds when the
//    native document uses the API as its explicit base URL). The sha384 digests were computed from
//    the dist/ files in the
//    maplibre-gl@4.7.1 npm tarball and confirmed byte-identical to what unpkg serves. The pin is
//    defence in depth: this document renders third-party code next to an org-scoped media token (it
//    rides in the MVT tile URL). Never bump the version without recomputing BOTH digests, and never
//    guess one — a wrong digest silently blocks the load and leaves a dead map.
//  • maplibreSelfHosted(origin) — web portal. Served from app/public/vendor (identical bytes,
//    sha384-verified against the CDN pins at vendor time). The document is loaded from a blob: URL
//    minted by PlantMap.web.tsx — NOT srcDoc — so it carries a real origin in every browser (a
//    srcdoc document's location.origin is "null", which MapLibre's worker Actor rejects, and WebKit
//    additionally refuses workers from opaque origins). Blob URLs are non-hierarchical, so relative
//    paths cannot resolve against them: the vendor tags REQUIRE absolute URLs, hence the origin
//    parameter. Self-hosting removes the third-party CDN from the serving path (no SRI needed) and
//    keeps the map working offline in the field.
export const MAPLIBRE_CDN = {
  css: `<link rel="stylesheet" href="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css" integrity="sha384-MinO0mNliZ3vwppuPOUnGa+iq619pfMhLVUXfC4LHwSCvF9H+6P/KO4Q7qBOYV5V" crossorigin="anonymous" />`,
  js: `<script src="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js" integrity="sha384-SYKAG6cglRMN0RVvhNeBY0r3FYKNOJtznwA0v7B5Vp9tr31xAHsZC0DqkQ/pZDmj" crossorigin="anonymous"></script>`,
};
export function maplibreSelfHosted(origin: string) {
  return {
    css: `<link rel="stylesheet" href="${origin}/vendor/maplibre-gl.css" />`,
    js: `<script src="${origin}/vendor/maplibre-gl.js"></script>`,
  };
}

// `lib` selects where maplibre-gl comes from; the returned document string is otherwise identical
// on both platforms. Native calls plantMapHtml() (CDN); web calls
// plantMapHtml(maplibreSelfHosted(window.location.origin)).
export function plantMapHtml(lib = MAPLIBRE_CDN) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
${lib.css}
${lib.js}
<style>
  html, body, #map { height: 100%; margin: 0; padding: 0; }
  #map { background: #DFE6DF; }
  #note { position: absolute; left: 12px; right: 12px; top: 12px; display: none; z-index: 2;
    text-align: center; background: rgba(27,30,26,0.88); color: #fff; font: 500 13px system-ui, sans-serif;
    padding: 8px 12px; border-radius: 8px; pointer-events: none; }
  #basemap-toggle { position: absolute; right: 12px; top: 12px; z-index: 3; min-height: 38px;
    border: 1px solid rgba(255,255,255,0.12); border-radius: 12px; padding: 0 13px;
    background: rgba(27,30,26,0.92); color: #fff; font: 600 12px system-ui, sans-serif;
    box-shadow: 0 2px 8px rgba(0,0,0,0.2); }
  .maplibregl-ctrl-attrib { font: 400 10px system-ui, sans-serif; }
</style>
</head>
<body>
<div id="map"></div>
<button id="basemap-toggle" type="button" aria-pressed="false"></button>
<div id="note"></div>
<script>
(function(){
  var CDN_TIMEOUT_MS = 15000;
  var MIN_TILE_Z = 10;      // the API rejects z < 10 (docs/API-PLANT.md §Plant vector tiles)
  var SRC = 'plants';       // source id AND source-layer: the MVT carries one layer, 'plants'
  var HEAT = 'plants-heat', ALERT = 'plants-alert', CIRCLES = 'plants-circles', SEL = 'plants-selected';
  var FALLBACK_SRC = 'plants-fallback', FALLBACK_CIRCLES = 'plants-fallback-circles';
  var FALLBACK_SEL = 'plants-fallback-selected';
  var RAMP = ['#A5432B', '#B26A3F', '#C7A34E', '#B8BF5C', '#7BA653', '#3F7D45'];
  var t0 = Date.now();

  var map = null, styleReady = false, init = null, gotInit = false, cursorBound = false;
  var basemap = 'map';
  var tileKey = null, paintKey = null, overlayKey = null, camKey = null, selectedId = null;
  var sourceReportKey = null, fallbackActive = false;

  function post(msg){
    var s = JSON.stringify(msg);
    if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
      window.ReactNativeWebView.postMessage(s);
    } else if (window.parent && window.parent !== window) {
      window.parent.postMessage(s, '*');
    }
  }

  function labels(){ return (init && init.labels) || {}; }

  try {
    var storedBasemap = window.localStorage.getItem('arvo.plantmap.basemap');
    if (storedBasemap === 'sat') basemap = 'sat';
  } catch (e) {}

  function updateChrome(){
    var l = labels();
    var top = init && typeof init.chromeTop === 'number' ? Math.max(0, init.chromeTop) : 12;
    var button = document.getElementById('basemap-toggle');
    button.style.top = top + 'px';
    document.getElementById('note').style.top = (top + 46) + 'px';
    // The compact button names the destination, not the current layer: "Satellite" switches
    // imagery on; once active, "Map" switches back. One control recovers almost half a row.
    button.textContent = basemap === 'map' ? (l.satellite || 'Satellite') : (l.map || 'Map');
    button.setAttribute('aria-pressed', basemap === 'sat' ? 'true' : 'false');
  }

  function note(text){
    var n = document.getElementById('note');
    n.textContent = text || '';
    n.style.display = text ? 'block' : 'none';
  }

  function rgba(hex, a){
    if (!/^#[0-9a-fA-F]{6}$/.test(String(hex))) return 'rgba(63,125,69,' + a + ')';
    var n = parseInt(String(hex).slice(1), 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  function baseStyle(){
    return {
      version: 8,
      sources: {
        osm: { type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
          tileSize: 256, maxzoom: 19, attribution: '&copy; OpenStreetMap' },
        satellite: { type: 'raster',
          tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
          tileSize: 256, maxzoom: 19, attribution: '&copy; Esri' }
      },
      layers: [
        { id: 'base-map', type: 'raster', source: 'osm',
          layout: { visibility: basemap === 'map' ? 'visible' : 'none' } },
        { id: 'base-satellite', type: 'raster', source: 'satellite',
          layout: { visibility: basemap === 'sat' ? 'visible' : 'none' } }
      ]
    };
  }

  function setBasemap(next){
    if (next !== 'map' && next !== 'sat') return;
    basemap = next;
    if (map && map.getLayer('base-map')) {
      map.setLayoutProperty('base-map', 'visibility', basemap === 'map' ? 'visible' : 'none');
      map.setLayoutProperty('base-satellite', 'visibility', basemap === 'sat' ? 'visible' : 'none');
    }
    try { window.localStorage.setItem('arvo.plantmap.basemap', basemap); } catch (e) {}
    updateChrome();
  }

  document.getElementById('basemap-toggle').addEventListener('click', function(){
    setBasemap(basemap === 'map' ? 'sat' : 'map');
  });
  updateChrome();

  function boot(){
    if (typeof maplibregl === 'undefined') {
      if (Date.now() - t0 > CDN_TIMEOUT_MS) { note(labels().error || ''); return; }
      setTimeout(boot, 60);
      return;
    }
    map = new maplibregl.Map({
      container: 'map', style: baseStyle(), center: [12.5, 41.9], zoom: 5, maxZoom: 22,
      attributionControl: { compact: true }, dragRotate: false, pitchWithRotate: false,
      fadeDuration: 0   // field devices: tile budget over crossfade
    });
    map.touchZoomRotate.disableRotation();
    map.on('load', function(){
      styleReady = true;
      map.resize();           // the container is often laid out after the WebView boots
      if (init) apply(init);
    });
    map.on('idle', function(){ refreshNote(); inspectPlantSource(); });
    map.on('moveend', refreshNote);
    // Non-404 vector-tile failures bubble to the map with sourceId. Never send the error itself:
    // it may contain the query-token URL. Native only needs a signal to activate its authenticated
    // GeoJSON fallback.
    map.on('error', function(e){
      if (e && e.sourceId === SRC) reportPlantSource('error');
    });
    map.on('click', onClick);
    window.addEventListener('resize', function(){ map.resize(); });
  }

  // ── paint expressions ──────────────────────────────────────────────────────

  // Colour comes from the raw \`value\` on the parent's p5/p95 scale when one is supplied, so the
  // map, the legend and the ranking list normalize identically (and a tile cached under an older
  // scale cannot drift); the tile's own \`norm\` is the fallback. −1 means "no observation".
  function normExpr(p){
    var s = p.scale;
    if (s && typeof s.p5 === 'number' && typeof s.p95 === 'number' && s.p95 > s.p5) {
      return ['case', ['has', 'value'],
        ['max', 0, ['min', 1, ['/', ['-', ['get', 'value'], s.p5], s.p95 - s.p5]]],
        ['coalesce', ['get', 'norm'], -1]];
    }
    return ['coalesce', ['get', 'norm'], -1];
  }

  function ramp(pal){ return (pal && pal.ramp && pal.ramp.length > 1) ? pal.ramp : RAMP; }

  // Keep individual crowns legible at the parcel-fit zoom. The old 1.6–2.8 px dots disappeared
  // into OSM orchard symbols and pale canopy colours even though the vector tile was populated.
  function fade(){ return ['interpolate', ['linear'], ['zoom'], 13.5, 0.45, 14.8, 1]; }

  function circlePaint(p, pal){
    var stops = ['interpolate', ['linear'], normExpr(p)], r = ramp(pal);
    for (var i = 0; i < r.length; i++) stops.push(i / (r.length - 1), r[i]);
    return {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, 2.6, 16, 4.2, 18, 7, 20, 12, 22, 20],
      'circle-color': ['case',
        ['!=', ['get', 'status'], 'alive'], pal.muted || '#D5D3CA',
        ['<', normExpr(p), 0], pal.noData || '#8A8F86',
        stops],
      'circle-opacity': fade(),
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 14, 0.8, 18, 1.2, 20, 1.8],
      'circle-stroke-color': ['case',
        ['!=', ['get', 'status'], 'alive'], pal.mutedStroke || '#A5432B',
        pal.halo || '#FBFAF7'],
      'circle-stroke-opacity': fade()
    };
  }

  // Weight is *weakness*, so at parcel zoom the hot spots are the patches worth walking to.
  function heatPaint(p, pal){
    var r = ramp(pal), weak = r[0], mid = r[Math.floor((r.length - 1) / 2)], strong = r[r.length - 1];
    return {
      'heatmap-weight': ['case', ['<', normExpr(p), 0], 0.15, ['-', 1, normExpr(p)]],
      'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 10, 0.7, 15, 1.4],
      'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 10, 6, 13, 12, 16, 24],
      'heatmap-opacity': ['interpolate', ['linear'], ['zoom'], 14.5, 0.85, 16, 0],
      'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'],
        0, rgba(strong, 0), 0.15, rgba(strong, 0.45), 0.45, rgba(mid, 0.6),
        0.75, rgba(weak, 0.7), 1, rgba(weak, 0.85)]
    };
  }

  function selFilter(){ return ['==', ['get', 'id'], selectedId || '']; }

  // ── layers ─────────────────────────────────────────────────────────────────

  function firstPlantLayer(){
    var ids = [HEAT, ALERT, CIRCLES, SEL, FALLBACK_CIRCLES, FALLBACK_SEL];
    for (var i = 0; i < ids.length; i++) if (map.getLayer(ids[i])) return ids[i];
    return undefined;
  }

  function removePlantLayers(){
    [SEL, CIRCLES, ALERT, HEAT].forEach(function(id){ if (map.getLayer(id)) map.removeLayer(id); });
    if (map.getSource(SRC)) map.removeSource(SRC);
  }

  function removeFallbackLayers(){
    [FALLBACK_SEL, FALLBACK_CIRCLES].forEach(function(id){
      if (map.getLayer(id)) map.removeLayer(id);
    });
    if (map.getSource(FALLBACK_SRC)) map.removeSource(FALLBACK_SRC);
    fallbackActive = false;
  }

  function addPlantLayers(p, pal){
    map.addLayer({ id: HEAT, type: 'heatmap', source: SRC, 'source-layer': SRC, maxzoom: 16,
      filter: ['==', ['get', 'status'], 'alive'], paint: heatPaint(p, pal) });
    // ring under the marker for plants carrying an open alert (no dot chrome — the ring is the datum)
    map.addLayer({ id: ALERT, type: 'circle', source: SRC, 'source-layer': SRC, minzoom: 14,
      filter: ['==', ['get', 'alert'], true],
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, 4, 17, 8, 19, 14, 22, 26],
        'circle-color': 'rgba(0,0,0,0)',
        'circle-stroke-color': pal.alert || '#A5432B',
        'circle-stroke-width': 1.4,
        'circle-stroke-opacity': fade()
      } });
    map.addLayer({ id: CIRCLES, type: 'circle', source: SRC, 'source-layer': SRC, minzoom: 14,
      paint: circlePaint(p, pal) });
    map.addLayer({ id: SEL, type: 'circle', source: SRC, 'source-layer': SRC, minzoom: 14,
      filter: selFilter(),
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, 5, 17, 10, 19, 17, 22, 30],
        'circle-color': 'rgba(0,0,0,0)',
        'circle-stroke-color': pal.selected || '#1F4430',
        'circle-stroke-width': 2.2
      } });
    if (!cursorBound) {
      cursorBound = true;
      map.on('mouseenter', CIRCLES, function(){ map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', CIRCLES, function(){ map.getCanvas().style.cursor = ''; });
    }
  }

  function repaint(p, pal){
    if (map.getLayer(CIRCLES)) {
      var cp = circlePaint(p, pal);
      map.setPaintProperty(CIRCLES, 'circle-color', cp['circle-color']);
      map.setPaintProperty(CIRCLES, 'circle-stroke-color', cp['circle-stroke-color']);
    }
    if (map.getLayer(HEAT)) {
      var hp = heatPaint(p, pal);
      map.setPaintProperty(HEAT, 'heatmap-weight', hp['heatmap-weight']);
      map.setPaintProperty(HEAT, 'heatmap-color', hp['heatmap-color']);
    }
    if (map.getLayer(ALERT)) map.setPaintProperty(ALERT, 'circle-stroke-color', pal.alert || '#A5432B');
    if (map.getLayer(SEL)) map.setPaintProperty(SEL, 'circle-stroke-color', pal.selected || '#1F4430');
    if (map.getLayer(FALLBACK_CIRCLES)) {
      var fp = circlePaint(p, pal);
      map.setPaintProperty(FALLBACK_CIRCLES, 'circle-color', fp['circle-color']);
      map.setPaintProperty(FALLBACK_CIRCLES, 'circle-stroke-color', fp['circle-stroke-color']);
    }
    if (map.getLayer(FALLBACK_SEL)) {
      map.setPaintProperty(FALLBACK_SEL, 'circle-stroke-color', pal.selected || '#1F4430');
    }
  }

  function setPlants(p, pal){
    var url = p.tileUrlTemplate || '';
    if (!url) return;
    var pk = JSON.stringify([p.metric, p.scale || null, pal]);
    if (url !== tileKey) {
      // the metric/capture/token live in the template, so a new URL means new data: rebuild.
      // maxzoom 18 lets MapLibre overzoom the deepest tile instead of re-requesting past it.
      removePlantLayers();
      removeFallbackLayers();
      sourceReportKey = null;
      map.addSource(SRC, { type: 'vector', tiles: [url], minzoom: MIN_TILE_Z, maxzoom: 18 });
      addPlantLayers(p, pal);
      tileKey = url;
      paintKey = pk;
      return;
    }
    if (pk !== paintKey) { repaint(p, pal); paintKey = pk; }
  }

  function setParcel(geom, pal){
    var data = geom
      ? { type: 'Feature', geometry: geom, properties: {} }
      : { type: 'FeatureCollection', features: [] };
    var src = map.getSource('parcel');
    if (src) { src.setData(data); return; }
    map.addSource('parcel', { type: 'geojson', data: data });
    var before = firstPlantLayer();
    map.addLayer({ id: 'parcel-fill', type: 'fill', source: 'parcel',
      paint: { 'fill-color': pal.parcelFill || 'rgba(35,75,52,0.06)' } }, before);
    map.addLayer({ id: 'parcel-line', type: 'line', source: 'parcel',
      paint: { 'line-color': pal.parcelLine || '#1F4430', 'line-width': 1.5, 'line-opacity': 0.9 } }, before);
  }

  function setOverlay(ov){
    var key = ov && ov.urlTemplate ? JSON.stringify(ov) : null;
    if (key === overlayKey) return;
    overlayKey = key;
    if (map.getLayer('overlay')) map.removeLayer('overlay');
    if (map.getSource('overlay')) map.removeSource('overlay');
    if (!key) return;
    var src = { type: 'raster', tiles: [ov.urlTemplate], tileSize: 256, maxzoom: 22 };
    if (ov.bounds && ov.bounds.length === 4) src.bounds = ov.bounds;
    map.addSource('overlay', src);
    map.addLayer({ id: 'overlay', type: 'raster', source: 'overlay',
      paint: { 'raster-opacity': typeof ov.opacity === 'number' ? ov.opacity : 0.85 } },
      map.getLayer('parcel-fill') ? 'parcel-fill' : firstPlantLayer());
  }

  function setSelected(id){
    selectedId = id || null;
    if (map.getLayer(SEL)) map.setFilter(SEL, selFilter());
    if (map.getLayer(FALLBACK_SEL)) map.setFilter(FALLBACK_SEL, selFilter());
  }

  // ── camera ─────────────────────────────────────────────────────────────────

  function geomBounds(g){
    if (!g || !g.coordinates) return null;
    var w = 180, s = 90, e = -180, n = -90, seen = false;
    (function walk(c){
      if (typeof c[0] === 'number') {
        seen = true;
        if (c[0] < w) w = c[0];
        if (c[0] > e) e = c[0];
        if (c[1] < s) s = c[1];
        if (c[1] > n) n = c[1];
      } else {
        for (var i = 0; i < c.length; i++) walk(c[i]);
      }
    })(g.coordinates);
    return seen ? [[w, s], [e, n]] : null;
  }

  // Only move when the requested view actually changed — a re-render must never yank the camera
  // out from under someone panning a 30k-plant parcel.
  function camera(p){
    var b = p.parcelGeometry ? geomBounds(p.parcelGeometry) : null;
    var key = p.focus && p.focus.length >= 2
      ? 'f:' + p.focus.join(',')
      : (b ? 'b:' + b[0].join(',') + ',' + b[1].join(',') : 'none');
    if (key === camKey) return;
    camKey = key;
    if (p.focus && p.focus.length >= 2) {
      map.jumpTo({ center: [p.focus[0], p.focus[1]], zoom: p.focus.length > 2 && p.focus[2] ? p.focus[2] : 17 });
    } else if (b) {
      map.fitBounds(b, { padding: 28, maxZoom: 18, duration: 0 });
    }
  }

  // ── notes + interaction ────────────────────────────────────────────────────

  function reportPlantSource(state){
    var key = String(tileKey || '') + ':' + state;
    if (key === sourceReportKey) return;
    sourceReportKey = key;
    post({ type: 'plantSource', state: state });
  }

  function inspectPlantSource(){
    if (!map || !init || fallbackActive || map.getZoom() < MIN_TILE_Z) return;
    if (!map.getSource(SRC) || !map.isSourceLoaded(SRC)) return;
    var sourceFeatures = [];
    try { sourceFeatures = map.querySourceFeatures(SRC, { sourceLayer: SRC }); } catch (e) {}
    if (!sourceFeatures.length) { reportPlantSource('empty'); return; }
    // At the parcel-fit zoom the circle layer must produce something visible. A populated source
    // with no rendered circles is still a broken map from the grower's perspective, so use the
    // same fallback as a failed tile request.
    if (map.getZoom() >= 14) {
      var rendered = [];
      try { rendered = map.queryRenderedFeatures({ layers: [CIRCLES] }); } catch (e) {}
      if (!rendered.length) { reportPlantSource('hidden'); return; }
    }
    reportPlantSource('ready');
  }

  window.__setPlantFallback = function(data){
    if (!map || !styleReady || !init || !data || !Array.isArray(data.features)) return;
    removeFallbackLayers();
    if (!data.features.length) { note(labels().error || ''); return; }
    var pal = init.palette || {};
    map.addSource(FALLBACK_SRC, { type: 'geojson', data: data });
    var cp = circlePaint(init, pal);
    // The fallback is deliberately unmistakable: it activates only when the vector layer is not
    // visible, and uses a larger radius/halo while preserving the chosen metric's colour scale.
    cp['circle-radius'] = ['interpolate', ['linear'], ['zoom'], 10, 3.5, 14, 5, 16, 7, 18, 10, 20, 15];
    cp['circle-opacity'] = 1;
    cp['circle-stroke-width'] = ['interpolate', ['linear'], ['zoom'], 10, 1.2, 16, 1.8, 20, 2.5];
    cp['circle-stroke-opacity'] = 1;
    map.addLayer({ id: FALLBACK_CIRCLES, type: 'circle', source: FALLBACK_SRC,
      minzoom: MIN_TILE_Z, paint: cp });
    map.addLayer({ id: FALLBACK_SEL, type: 'circle', source: FALLBACK_SRC,
      minzoom: MIN_TILE_Z, filter: selFilter(), paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 5, 16, 10, 18, 14, 20, 22],
        'circle-color': 'rgba(0,0,0,0)',
        'circle-stroke-color': pal.selected || '#1F4430',
        'circle-stroke-width': 2.5
      } });
    fallbackActive = true;
    note('');
  };

  window.__plantFallbackError = function(){ note(labels().error || ''); };

  function refreshNote(){
    if (!map || !init) return;
    var l = labels();
    if (map.getZoom() < MIN_TILE_Z) { note(l.zoomIn || ''); return; }
    if (!map.getSource(SRC) || !map.isSourceLoaded(SRC)) { note(l.loading || ''); return; }
    // A vector source only exposes features from tiles currently retained by the renderer.
    // During a metric/source swap it can therefore report zero even though the authoritative
    // parcel summary and ranking contain plants (and the next tile already contains them). The
    // React parent owns the true database-backed empty state; once tiles finish, map chrome must
    // not invent a contradictory count from this transient viewport cache.
    note('');
  }

  function onClick(e){
    var layers = [];
    if (map.getLayer(CIRCLES)) layers.push(CIRCLES);
    if (map.getLayer(FALLBACK_CIRCLES)) layers.push(FALLBACK_CIRCLES);
    if (!layers.length) return;
    var pad = 10;   // field-sized hit box: a plant is ~4 px across at parcel zoom
    var box = [[e.point.x - pad, e.point.y - pad], [e.point.x + pad, e.point.y + pad]];
    var fs = map.queryRenderedFeatures(box, { layers: layers });
    if (!fs.length) return;
    var best = null, bestD = Infinity;
    for (var i = 0; i < fs.length; i++) {
      var pt = map.project(fs[i].geometry.coordinates);
      var d = (pt.x - e.point.x) * (pt.x - e.point.x) + (pt.y - e.point.y) * (pt.y - e.point.y);
      if (d < bestD) { bestD = d; best = fs[i]; }
    }
    if (best && best.properties && best.properties.id) {
      post({ type: 'plant', id: String(best.properties.id) });
    }
  }

  function apply(p){
    updateChrome();
    var pal = p.palette || {};
    setParcel(p.parcelGeometry, pal);
    setOverlay(p.overlay);
    setPlants(p, pal);
    setSelected(p.selectedPlantId);
    camera(p);
    refreshNote();
  }

  window.__updatePlants = function(p){
    gotInit = true;   // both bridges (postMessage and injected JS) land here — stop re-announcing
    init = p;
    if (styleReady) apply(p);
    else note(labels().loading || '');
  };

  function onMessage(data){
    try {
      var msg = typeof data === 'string' ? JSON.parse(data) : data;
      if (msg && msg.type === 'init') window.__updatePlants(msg);
    } catch (e) {}
  }
  window.addEventListener('message', function(e){ onMessage(e.data); });
  document.addEventListener('message', function(e){ onMessage(e.data); });

  // The host may attach its message listener after our first 'ready' (srcDoc iframes can boot
  // before parent effects flush) — keep announcing until an init actually lands.
  function announce(){
    post({ type: 'ready' });
    if (!gotInit) setTimeout(announce, 250);
  }

  announce();
  boot();
})();
</script>
</body>
</html>`;
}
