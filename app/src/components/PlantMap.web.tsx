// OWNER: fe-plant-map — MapLibre GL JS inside an iframe (srcDoc), sharing map/plantMapHtml +
// buildPlantInit with the native variant; bridge is window postMessage both ways, exactly like
// MapView.web.tsx: a `ready` handshake that clears the dedupe, and a JSON payload diff so
// unchanged renders don't reload tiles.
// Props are FROZEN in ./types (PlantMapProps) — do not change them.
import { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { buildPlantInit, plantMapHtml } from './map/plantMapHtml';
import type { PlantMapProps } from './types';

export default function PlantMap(props: PlantMapProps) {
  const { onSelectPlant, height } = props;
  const { t } = useTranslation();
  const ref = useRef<HTMLIFrameElement>(null);
  const readyRef = useRef(false);
  const lastSent = useRef('');

  const payloadStr = JSON.stringify(
    buildPlantInit(props, {
      loading: t('plantmap.loading'),
      empty: t('plantmap.empty'),
      zoomIn: t('plantmap.zoom_in'),
      error: t('plantmap.load_error'),
    }),
  );

  const send = useCallback(() => {
    const win = ref.current?.contentWindow;
    if (readyRef.current && win && lastSent.current !== payloadStr) {
      lastSent.current = payloadStr;
      win.postMessage(payloadStr, '*');
    }
  }, [payloadStr]);

  useEffect(() => {
    send();
  }, [send]);

  useEffect(() => {
    function onMsg(e: MessageEvent) {
      if (!ref.current || e.source !== ref.current.contentWindow) return;
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'ready') {
          readyRef.current = true;
          // A fresh document announcing ready has no map state — clear the dedupe so the init
          // is re-sent even if the payload string hasn't changed.
          lastSent.current = '';
          send();
        } else if ((msg.type === 'plant' || msg.type === 'selectPlant') && msg.id) {
          onSelectPlant?.(msg.id);
        }
      } catch {
        // ignore malformed bridge messages
      }
    }
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [send, onSelectPlant]);

  return (
    <iframe
      ref={ref}
      title="plant-map"
      srcDoc={plantMapHtml}
      // Opaque origin — `allow-scripts` with NO `allow-same-origin`, same as MapView.web. This is
      // the boundary that keeps a tampered CDN response out of the app's own origin, where the
      // 7-day session JWT lives (AsyncStorage === localStorage on web) and where the org-scoped
      // media token in the MVT tile URL would be readable.
      // An earlier comment here claimed MapLibre's WebGL worker cannot start in an opaque origin;
      // that is not true and was measured: the worker is built from a blob: URL, which constructs
      // and round-trips messages fine with origin `null`, WebGL 1/2 are available, and the library
      // touches no localStorage/IndexedDB/Cache API that would throw. Side-by-side, the frame
      // without allow-same-origin reached `load`/`idle` with styleLoaded and painted the parcel
      // (a GeoJSON source, i.e. parsed *in the worker*) with zero map errors.
      sandbox="allow-scripts"
      style={{
        border: 'none',
        width: '100%',
        height: height != null ? height : '100%',
        display: 'block',
      }}
    />
  );
}
