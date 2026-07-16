// OWNER: fe-map — one self-contained Leaflet document shared by MapView.native (react-native-webview)
// and MapView.web (iframe srcDoc). Bridge is JSON both ways:
//   in  → { type:'init', parcels, markers, focus, mode, labels, overlay }  (native: injected window.__update(...)
//          or a 'message' event; web: a window 'message' event)
//   out → { type:'ready' } once Leaflet is up, { type:'select', id }, { type:'drawn', geometry }
// Draw mode: tap to add vertices with live preview + on-map Fine/Annulla buttons.
import type { ParcelGeometry } from '@/api/types';
import type { MapViewProps } from '../types';

export interface MapLabels {
  finish: string;
  cancel: string;
  hint: string;
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
  };
}

export const mapHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>
  html, body, #map { height: 100%; margin: 0; padding: 0; }
  #map { background: #aadaff; }
  .leaflet-container { font-family: system-ui, -apple-system, sans-serif; }
  .parcel-label { background: rgba(255,255,255,0.85); border: none; box-shadow: none;
    font: 600 12px system-ui, sans-serif; color: #1C2321; padding: 1px 6px; border-radius: 6px; }
  #hint { position: absolute; left: 12px; right: 12px; top: 12px; display: none; z-index: 1000;
    text-align: center; background: rgba(28,35,33,0.88); color: #fff; font: 500 13px system-ui, sans-serif;
    padding: 8px 12px; border-radius: 8px; }
  #drawbar { position: absolute; left: 0; right: 0; bottom: 18px; display: none; justify-content: center;
    gap: 12px; z-index: 1000; pointer-events: none; }
  #drawbar button { pointer-events: auto; border: none; border-radius: 24px; padding: 12px 24px;
    font: 600 15px system-ui, sans-serif; color: #fff; box-shadow: 0 2px 8px rgba(0,0,0,0.3); }
  #btnFinish { background: #2E7D32; }
  #btnFinish:disabled { background: #9bb99d; }
  #btnCancel { background: #8a8f89; }
</style>
</head>
<body>
<div id="map"></div>
<div id="hint"></div>
<div id="drawbar"><button id="btnCancel"></button><button id="btnFinish"></button></div>
<script>
(function(){
  var DEFAULT_FILL = '#2E7D32';
  var map, parcelLayer, markerLayer, mode = 'view';
  var drawPts = [], drawLine = null, drawPoly = null, drawDots = [];
  var overlayLayer = null, overlayKey = null;

  function post(msg){
    var s = JSON.stringify(msg);
    if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
      window.ReactNativeWebView.postMessage(s);
    } else if (window.parent && window.parent !== window) {
      window.parent.postMessage(s, '*');
    }
  }

  function ready(){
    if (typeof L === 'undefined') { setTimeout(ready, 60); return; }
    map = L.map('map', { zoomControl: true, attributionControl: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; OpenStreetMap'
    }).addTo(map);
    parcelLayer = L.layerGroup().addTo(map);
    markerLayer = L.layerGroup().addTo(map);
    map.setView([41.9, 12.5], 5);
    map.on('click', onMapClick);
    document.getElementById('btnFinish').addEventListener('click', finishDraw);
    document.getElementById('btnCancel').addEventListener('click', cancelDraw);
    post({ type: 'ready' });
  }

  window.__update = function(p){
    if (!map) { setTimeout(function(){ window.__update(p); }, 60); return; }
    mode = p.mode || 'view';
    if (p.labels) {
      document.getElementById('btnFinish').textContent = p.labels.finish || 'Fine';
      document.getElementById('btnCancel').textContent = p.labels.cancel || 'Annulla';
      document.getElementById('hint').textContent = p.labels.hint || '';
    }
    parcelLayer.clearLayers();
    markerLayer.clearLayers();
    var bounds = null;
    (p.parcels || []).forEach(function(pc){
      try {
        var gj = L.geoJSON(pc.geometry, { style: {
          color: '#1B5E20', weight: 2, opacity: 0.9,
          fillColor: pc.color || DEFAULT_FILL, fillOpacity: 0.5
        } });
        gj.eachLayer(function(layer){
          layer.on('click', function(){ if (mode !== 'draw') post({ type: 'select', id: pc.id }); });
          if (pc.name) layer.bindTooltip(pc.name, { permanent: true, direction: 'center', className: 'parcel-label' });
        });
        gj.addTo(parcelLayer);
        var b = gj.getBounds();
        if (b && b.isValid()) bounds = bounds ? bounds.extend(b) : b;
      } catch (err) {}
    });
    (p.markers || []).forEach(function(m){
      var cm = L.circleMarker([m.lat, m.lon], {
        radius: 6, color: '#fff', weight: 2, fillColor: '#8D6E63', fillOpacity: 1
      });
      if (m.label) cm.bindTooltip(m.label);
      cm.addTo(markerLayer);
      var ll = L.latLng(m.lat, m.lon);
      bounds = bounds ? bounds.extend(ll) : L.latLngBounds(ll, ll);
    });
    updateOverlay(p.overlay);
    if (p.focus && p.focus.length >= 2) {
      map.setView([p.focus[1], p.focus[0]], p.focus.length > 2 && p.focus[2] ? p.focus[2] : 15);
    } else if (bounds && bounds.isValid()) {
      map.fitBounds(bounds, { padding: [28, 28], maxZoom: 16 });
    }
    setDraw(mode === 'draw');
  };

  // Single XYZ index raster overlay. Diffed by JSON so unchanged updates don't reload tiles.
  // Lives in the default tilePane (z-index 200): above the OSM base (added first in ready()),
  // below parcel polygons which Leaflet renders in overlayPane (z-index 400). Verified — no custom pane needed.
  function updateOverlay(ov){
    var key = ov && ov.urlTemplate ? JSON.stringify(ov) : null;
    if (key === overlayKey) return;
    overlayKey = key;
    if (overlayLayer) { map.removeLayer(overlayLayer); overlayLayer = null; }
    if (!key) return;
    var opts = {
      opacity: typeof ov.opacity === 'number' ? ov.opacity : 0.85,
      maxZoom: 17,
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
        color: '#2E7D32', weight: 2, fillColor: '#2E7D32', fillOpacity: 0.25, dashArray: '5,5'
      }).addTo(map);
    } else if (drawPts.length >= 2) {
      drawLine = L.polyline(drawPts, { color: '#2E7D32', weight: 2, dashArray: '5,5' }).addTo(map);
    }
    drawPts.forEach(function(ll){
      drawDots.push(L.circleMarker(ll, {
        radius: 5, color: '#fff', weight: 2, fillColor: '#2E7D32', fillOpacity: 1
      }).addTo(map));
    });
    document.getElementById('btnFinish').disabled = drawPts.length < 3;
  }

  function finishDraw(){
    if (drawPts.length < 3) return;
    var ring = drawPts.map(function(ll){ return [ll.lng, ll.lat]; });
    ring.push([drawPts[0].lng, drawPts[0].lat]);
    post({ type: 'drawn', geometry: { type: 'Polygon', coordinates: [ring] } });
    resetDraw();
  }

  function cancelDraw(){ resetDraw(); }

  function resetDraw(){
    drawPts = [];
    if (drawLine) { map.removeLayer(drawLine); drawLine = null; }
    if (drawPoly) { map.removeLayer(drawPoly); drawPoly = null; }
    drawDots.forEach(function(d){ if (map) map.removeLayer(d); });
    drawDots = [];
    var fin = document.getElementById('btnFinish');
    if (fin) fin.disabled = true;
  }

  function onMessage(data){
    try {
      var msg = typeof data === 'string' ? JSON.parse(data) : data;
      if (msg && msg.type === 'init') window.__update(msg);
    } catch (e) {}
  }
  window.addEventListener('message', function(e){ onMessage(e.data); });
  document.addEventListener('message', function(e){ onMessage(e.data); });

  ready();
})();
</script>
</body>
</html>`;
