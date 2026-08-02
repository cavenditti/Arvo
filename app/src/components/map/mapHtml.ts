// OWNER: map-native — one self-contained Leaflet document shared by MapView.native (react-native-webview)
// and MapView.web (iframe srcDoc). Bridge is JSON both ways:
//   in  → { type:'init', parcels, markers, focus, mode, labels, overlay, cadastre }
//          (native: injected window.__update(...) or a 'message' event; web: a window 'message' event)
//        → { type:'setBasemap', basemap:'map'|'sat' } switches the base tiles (native may call the
//          injected window.__setBasemap(...) directly); default 'map' (OSM), 'sat' = Esri imagery
//   out → { type:'ready' } once Leaflet is up, { type:'select', id }, { type:'drawn', geometry },
//         { type:'cadastre', ref } on candidate tap, { type:'moved', bbox, zoom } after pan/zoom,
//         { type:'tileerror' } (debounced) when base tiles repeatedly fail — host may show an
//         offline notice
// Draw mode: tap to add vertices with live preview + on-map Fine/Annulla ultimo punto/Annulla buttons.
import type { ParcelGeometry } from '@/api/types';
import type { CadastreMapFeature, MapViewProps } from '../types';

export interface MapLabels {
  finish: string;
  cancel: string;
  hint: string;
  /** draw mode "undo last vertex" button — optional, the document falls back to Italian copy */
  undo?: string;
  /** zoom button titles/aria-labels — optional, Leaflet's English defaults otherwise */
  zoomIn?: string;
  zoomOut?: string;
}

export interface MapInitMessage {
  type: 'init';
  parcels: { id: string; name: string; color: string | null; geometry: ParcelGeometry }[];
  markers: { id: string; lon: number; lat: number; label?: string }[];
  focus: [number, number, number?] | null;
  mode: 'view' | 'draw';
  labels: MapLabels;
  /** XYZ index raster tiles rendered above the base map, below parcel polygons; null = none */
  overlay: NonNullable<MapViewProps['overlay']> | null;
  /** cadastral candidates overlay (FR-0-010b onboarding); null = none */
  cadastre: { features: CadastreMapFeature[]; selected: string[] } | null;
}

/** Flatten the frozen MapView props into the wire payload the Leaflet document understands. */
export function buildInit(props: MapViewProps, labels: MapLabels): MapInitMessage {
  return {
    type: 'init',
    parcels: props.parcels.map((f) => ({
      id: f.parcel.id,
      name: f.parcel.name,
      color: f.color ?? null,
      geometry: f.parcel.geometry,
    })),
    markers: props.markers ?? [],
    focus: props.focus ?? null,
    mode: props.mode,
    labels,
    overlay: props.overlay ?? null,
    cadastre: props.cadastre ?? null,
  };
}

export const mapHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
  integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=" crossorigin="anonymous" />
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
  integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=" crossorigin="anonymous"></script>
<style>
  html, body, #map { height: 100%; margin: 0; padding: 0; }
  #map { background: #DFE6DF; }
  .leaflet-container { font-family: system-ui, -apple-system, sans-serif; }
  .parcel-label { background: rgba(255,255,255,0.85); border: none; box-shadow: none;
    font: 600 12px system-ui, sans-serif; color: #1B1E1A; padding: 1px 6px; border-radius: 6px; }
  /* zoom control bottom-right (top-left collided with the floating search): 44px targets for
     gloved thumbs, lifted above the attribution line and the host's bottom overlays */
  .leaflet-control-zoom, .leaflet-touch .leaflet-control-zoom {
    border: 1px solid #E4E1D7; border-radius: 12px; overflow: hidden;
    box-shadow: 0 2px 8px rgba(0,0,0,0.18);
  }
  .leaflet-control-zoom a, .leaflet-touch .leaflet-control-zoom a {
    width: 44px; height: 44px; line-height: 44px; font-size: 20px;
    color: #1B1E1A; background: #FBFAF7; border-bottom-color: #EDECE7;
  }
  .leaflet-control-zoom a.leaflet-disabled { color: #8A8F86; }
  .leaflet-bottom.leaflet-right .leaflet-control-zoom { margin-right: 12px; margin-bottom: 76px; }
  #hint { position: absolute; left: 12px; right: 12px; top: 12px; display: none; z-index: 1000;
    text-align: center; background: rgba(27,30,26,0.88); color: #fff; font: 500 13px system-ui, sans-serif;
    padding: 8px 12px; border-radius: 8px; }
  #drawbar { position: absolute; left: 0; right: 0; bottom: 18px; display: none; justify-content: center;
    align-items: center; flex-wrap: wrap; gap: 8px; padding: 0 8px; z-index: 1000; pointer-events: none; }
  #drawbar button { pointer-events: auto; border: none; border-radius: 24px; min-height: 44px;
    padding: 10px 18px; font: 600 15px system-ui, sans-serif; color: #fff;
    box-shadow: 0 2px 8px rgba(0,0,0,0.3); }
  #btnFinish { background: #234B34; }
  #btnFinish:disabled { background: #9AA69B; }
  #btnCancel { background: #8A8F86; }
  #btnUndo { background: #FBFAF7; color: #1B1E1A; border: 1px solid #E4E1D7; }
  #btnUndo:disabled { color: #8A8F86; opacity: 0.75; }
</style>
</head>
<body>
<div id="map"></div>
<div id="hint"></div>
<div id="drawbar"><button id="btnCancel"></button><button id="btnUndo"></button><button id="btnFinish"></button></div>
<script>
(function(){
  var DEFAULT_FILL = '#4F8F4A';
  // Invisible fat stroke laid over each tappable polygon: thin fields and cadastral slivers
  // stay tappable with a farmer's thumb even when their painted stroke is 2px.
  var HIT_STYLE = { color: '#000', opacity: 0, weight: 12, fillOpacity: 0 };
  // Permanent parcel name labels only from this zoom in — below it they are unreadable clutter.
  var LABEL_MIN_ZOOM = 14;
  // Leaflet tooltips render string content via innerHTML; names/labels are user input and
  // must never execute inside this document (the native WebView also sees tile URLs).
  function esc(s){
    return String(s).replace(/[&<>"']/g, function(c){
      return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c];
    });
  }
  var map, parcelLayer, markerLayer, cadastreLayer, mode = 'view';
  var drawPts = [], drawLine = null, drawPoly = null, drawDots = [];
  var overlayLayer = null, overlayKey = null, viewKey = null;
  var baseLayers = null, basemap = 'map';
  var tileErrs = 0, lastTileErrPost = 0;

  function post(msg){
    var s = JSON.stringify(msg);
    if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
      window.ReactNativeWebView.postMessage(s);
    } else if (window.parent && window.parent !== window) {
      window.parent.postMessage(s, '*');
    }
  }

  // Repeated base-tile failures (offline, captive portal) → ONE debounced signal to the host;
  // any successful tile load resets the counter so a few missing tiles never fire it.
  function onTileError(){
    tileErrs += 1;
    var now = Date.now();
    if (tileErrs >= 3 && now - lastTileErrPost > 10000) {
      lastTileErrPost = now;
      tileErrs = 0;
      post({ type: 'tileerror' });
    }
  }

  function makeBase(url, attribution){
    // zIndex 1 keeps a re-added base under the index overlay (zIndex 2) after basemap swaps
    var l = L.tileLayer(url, { maxZoom: 19, zIndex: 1, attribution: attribution });
    l.on('tileerror', onTileError);
    l.on('tileload', function(){ tileErrs = 0; });
    return l;
  }

  // Basemap swap, callable before ready (the choice is applied when the map boots).
  window.__setBasemap = function(b){
    b = b === 'sat' ? 'sat' : 'map';
    if (b === basemap) return;
    var prev = basemap;
    basemap = b;
    if (!map || !baseLayers) return;
    map.removeLayer(baseLayers[prev]);
    baseLayers[b].addTo(map);
  };

  function ready(){
    if (typeof L === 'undefined') { setTimeout(ready, 60); return; }
    map = L.map('map', { zoomControl: false, attributionControl: true });
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    baseLayers = {
      map: makeBase('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', '&copy; OpenStreetMap'),
      sat: makeBase('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics')
    };
    baseLayers[basemap].addTo(map);
    parcelLayer = L.layerGroup().addTo(map);
    cadastreLayer = L.layerGroup().addTo(map);
    markerLayer = L.layerGroup().addTo(map);
    map.setView([41.9, 12.5], 5);
    // container can be sized late (flex layout, portal shell) — keep Leaflet's size current
    window.addEventListener('resize', function(){ map.invalidateSize(); });
    map.on('click', onMapClick);
    map.on('zoomend', updateParcelLabels);
    // Viewport reports feed cadastre detection; moveend fires once per settled gesture.
    map.on('moveend', function(){
      var b = map.getBounds();
      post({ type: 'moved',
        bbox: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()],
        zoom: map.getZoom() });
    });
    document.getElementById('btnFinish').addEventListener('click', finishDraw);
    document.getElementById('btnCancel').addEventListener('click', cancelDraw);
    document.getElementById('btnUndo').addEventListener('click', undoDraw);
    announce();
  }

  function setZoomTitles(labels){
    var zi = document.querySelector('.leaflet-control-zoom-in');
    var zo = document.querySelector('.leaflet-control-zoom-out');
    if (zi && labels.zoomIn) { zi.title = labels.zoomIn; zi.setAttribute('aria-label', labels.zoomIn); }
    if (zo && labels.zoomOut) { zo.title = labels.zoomOut; zo.setAttribute('aria-label', labels.zoomOut); }
  }

  // Permanent name labels only when zoomed close enough to read them (>= LABEL_MIN_ZOOM).
  function updateParcelLabels(){
    if (!map || !parcelLayer) return;
    var show = map.getZoom() >= LABEL_MIN_ZOOM;
    parcelLayer.eachLayer(function(group){
      if (!group.eachLayer) return;
      group.eachLayer(function(layer){
        if (!layer.getTooltip || !layer.getTooltip()) return;
        if (show) layer.openTooltip(); else layer.closeTooltip();
      });
    });
  }

  window.__update = function(p){
    gotInit = true; // both bridges (postMessage and injected JS) land here — stop re-announcing
    if (!map) { setTimeout(function(){ window.__update(p); }, 60); return; }
    mode = p.mode || 'view';
    if (p.labels) {
      document.getElementById('btnFinish').textContent = p.labels.finish || 'Fine';
      document.getElementById('btnCancel').textContent = p.labels.cancel || 'Annulla';
      document.getElementById('btnUndo').textContent = p.labels.undo || 'Annulla ultimo punto';
      document.getElementById('hint').textContent = p.labels.hint || '';
      setZoomTitles(p.labels);
    }
    parcelLayer.clearLayers();
    markerLayer.clearLayers();
    var bounds = null;
    (p.parcels || []).forEach(function(pc){
      try {
        var gj = L.geoJSON(pc.geometry, { style: {
          color: '#1F4430', weight: 2, opacity: 0.9,
          fillColor: pc.color || DEFAULT_FILL, fillOpacity: 0.5
        } });
        gj.eachLayer(function(layer){
          layer.on('click', function(){ if (mode !== 'draw') post({ type: 'select', id: pc.id }); });
          if (pc.name) layer.bindTooltip(esc(pc.name), { permanent: true, direction: 'center', className: 'parcel-label' });
        });
        gj.addTo(parcelLayer);
        // transparent wide-stroke twin on top: taps land even on thin polygons
        var hit = L.geoJSON(pc.geometry, { style: HIT_STYLE });
        hit.eachLayer(function(layer){
          layer.on('click', function(){ if (mode !== 'draw') post({ type: 'select', id: pc.id }); });
        });
        hit.addTo(parcelLayer);
        var b = gj.getBounds();
        if (b && b.isValid()) bounds = bounds ? bounds.extend(b) : b;
      } catch (err) {}
    });
    (p.markers || []).forEach(function(m){
      var isUserLocation = m.id === '__user_location__';
      var cm = L.circleMarker([m.lat, m.lon], {
        radius: isUserLocation ? 7 : 6,
        color: '#FBFAF7',
        weight: isUserLocation ? 3 : 2,
        fillColor: isUserLocation ? '#0A84FF' : '#A5432B',
        fillOpacity: 1
      });
      if (m.label) cm.bindTooltip(esc(m.label));
      cm.addTo(markerLayer);
      var ll = L.latLng(m.lat, m.lon);
      bounds = bounds ? bounds.extend(ll) : L.latLngBounds(ll, ll);
    });
    updateCadastre(p.cadastre);
    updateOverlay(p.overlay);
    // Re-fit only when what the view is ABOUT changed (focus target / parcel set / markers).
    // Cadastre refreshes and overlay toggles re-send init while the user is panning — snapping
    // the camera back on those would fight the pan that triggered them.
    var vk = JSON.stringify([
      p.focus || null,
      (p.parcels || []).map(function(x){ return x.id; }),
      (p.markers || []).map(function(m){ return m.id; })
    ]);
    if (vk !== viewKey) {
      viewKey = vk;
      if (p.focus && p.focus.length >= 2) {
        map.setView([p.focus[1], p.focus[0]], p.focus.length > 2 && p.focus[2] ? p.focus[2] : 15);
      } else if (bounds && bounds.isValid()) {
        map.fitBounds(bounds, { padding: [28, 28], maxZoom: 16 });
      }
    }
    updateParcelLabels();
    setDraw(mode === 'draw');
  };

  // Cadastral candidates (FR-0-010b): amber dashed = selectable, filled = selected,
  // grey = already a field. Redrawn on every init; tap posts the ref, host owns selection.
  function updateCadastre(c){
    cadastreLayer.clearLayers();
    if (!c || !c.features || !c.features.length) return;
    var sel = {};
    (c.selected || []).forEach(function(r){ sel[r] = true; });
    c.features.forEach(function(f){
      if (!f || !f.ref || !f.geometry) return;
      var isSel = !!sel[f.ref];
      var style = f.existing
        ? { color: '#8A8F86', weight: 1.5, dashArray: '4,4', opacity: 0.8,
            fillColor: '#8A8F86', fillOpacity: 0.12 }
        : isSel
          ? { color: '#8A5A16', weight: 3, opacity: 1, fillColor: '#D9A441', fillOpacity: 0.45 }
          : { color: '#A26B1F', weight: 2, dashArray: '6,4', opacity: 0.95,
              fillColor: '#D9A441', fillOpacity: 0.15 };
      function onTap(ev){
        if (ev.originalEvent && ev.originalEvent.stopPropagation) ev.originalEvent.stopPropagation();
        post({ type: 'cadastre', ref: f.ref });
      }
      try {
        var gj = L.geoJSON(f.geometry, { style: style });
        gj.eachLayer(function(layer){
          if (f.tooltip) layer.bindTooltip(esc(f.tooltip), { sticky: true });
          if (!f.existing) layer.on('click', onTap);
        });
        gj.addTo(cadastreLayer);
        if (!f.existing) {
          // wide invisible stroke: cadastral slivers stay tappable
          var hit = L.geoJSON(f.geometry, { style: HIT_STYLE });
          hit.eachLayer(function(layer){
            if (f.tooltip) layer.bindTooltip(esc(f.tooltip), { sticky: true });
            layer.on('click', onTap);
          });
          hit.addTo(cadastreLayer);
        }
      } catch (err) {}
    });
  }

  // Single XYZ index raster overlay. Diffed by JSON so unchanged updates don't reload tiles.
  // zIndex 2 keeps it above whichever base layer (zIndex 1) is active — basemap swaps re-add
  // the base later in the tilePane, so insertion order alone is no longer enough — and below
  // parcel polygons, which Leaflet renders in overlayPane (z-index 400).
  function updateOverlay(ov){
    var key = ov && ov.urlTemplate ? JSON.stringify(ov) : null;
    if (key === overlayKey) return;
    overlayKey = key;
    if (overlayLayer) { map.removeLayer(overlayLayer); overlayLayer = null; }
    if (!key) return;
    var opts = {
      opacity: typeof ov.opacity === 'number' ? ov.opacity : 0.85,
      maxZoom: 17,
      zIndex: 2,
      crossOrigin: true
    };
    if (ov.bounds && ov.bounds.length === 4) {
      // ov.bounds = [w, s, e, n] → L.latLngBounds(SW=[s,w], NE=[n,e])
      opts.bounds = L.latLngBounds([ov.bounds[1], ov.bounds[0]], [ov.bounds[3], ov.bounds[2]]);
    }
    overlayLayer = L.tileLayer(ov.urlTemplate, opts).addTo(map);
  }

  function setDraw(on){
    resetDraw();
    document.getElementById('drawbar').style.display = on ? 'flex' : 'none';
    document.getElementById('hint').style.display = on ? 'block' : 'none';
  }

  function onMapClick(e){
    if (mode !== 'draw') return;
    drawPts.push(e.latlng);
    renderDraw();
  }

  function renderDraw(){
    if (drawLine) { map.removeLayer(drawLine); drawLine = null; }
    if (drawPoly) { map.removeLayer(drawPoly); drawPoly = null; }
    drawDots.forEach(function(d){ map.removeLayer(d); });
    drawDots = [];
    if (drawPts.length >= 3) {
      drawPoly = L.polygon(drawPts, {
        color: '#234B34', weight: 2, fillColor: '#234B34', fillOpacity: 0.25, dashArray: '5,5'
      }).addTo(map);
    } else if (drawPts.length >= 2) {
      drawLine = L.polyline(drawPts, { color: '#234B34', weight: 2, dashArray: '5,5' }).addTo(map);
    }
    drawPts.forEach(function(ll){
      drawDots.push(L.circleMarker(ll, {
        radius: 8, color: '#FBFAF7', weight: 2, fillColor: '#234B34', fillOpacity: 1
      }).addTo(map));
    });
    document.getElementById('btnFinish').disabled = drawPts.length < 3;
    document.getElementById('btnUndo').disabled = drawPts.length === 0;
  }

  function finishDraw(){
    if (drawPts.length < 3) return;
    var ring = drawPts.map(function(ll){ return [ll.lng, ll.lat]; });
    ring.push([drawPts[0].lng, drawPts[0].lat]);
    post({ type: 'drawn', geometry: { type: 'Polygon', coordinates: [ring] } });
    resetDraw();
  }

  function cancelDraw(){ resetDraw(); }

  function undoDraw(){
    if (!drawPts.length) return;
    drawPts.pop();
    renderDraw();
  }

  function resetDraw(){
    drawPts = [];
    if (drawLine) { map.removeLayer(drawLine); drawLine = null; }
    if (drawPoly) { map.removeLayer(drawPoly); drawPoly = null; }
    drawDots.forEach(function(d){ if (map) map.removeLayer(d); });
    drawDots = [];
    var fin = document.getElementById('btnFinish');
    if (fin) fin.disabled = true;
    var und = document.getElementById('btnUndo');
    if (und) und.disabled = true;
  }

  function onMessage(data){
    try {
      var msg = typeof data === 'string' ? JSON.parse(data) : data;
      if (!msg) return;
      if (msg.type === 'init') window.__update(msg);
      else if (msg.type === 'setBasemap') window.__setBasemap(msg.basemap);
    } catch (e) {}
  }
  window.addEventListener('message', function(e){ onMessage(e.data); });
  document.addEventListener('message', function(e){ onMessage(e.data); });

  // The host may attach its message listener after our first 'ready' (srcDoc iframes can boot
  // before parent effects flush) — keep announcing until an init actually lands.
  var gotInit = false;
  function announce(){
    post({ type: 'ready' });
    if (!gotInit) setTimeout(announce, 250);
  }

  ready();
})();
</script>
</body>
</html>`;
