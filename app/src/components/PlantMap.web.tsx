// OWNER: fe-plant-map — MapLibre GL JS inside an iframe (srcDoc), sharing map/plantMapHtml +
// buildPlantInit with the native variant; bridge is window postMessage both ways, exactly like
// MapView.web.tsx: a `ready` handshake that clears the dedupe, and a JSON payload diff so
// unchanged renders don't reload tiles.
// Props are FROZEN in ./types (PlantMapProps) — do not change them.
import { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { buildPlantInit, MAPLIBRE_SELF_HOSTED, plantMapHtml } from './map/plantMapHtml';
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
      srcDoc={plantMapHtml(MAPLIBRE_SELF_HOSTED)}
      // Opaque origin (`allow-scripts`, NO `allow-same-origin`) is REQUIRED, not just preferred.
      // MapLibre's worker bridge (Actor) stamps every message with the sender's `location.origin`
      // and silently DROPS messages whose stamp differs from the receiver's own `location.origin`
      // (an anti-injection check in actor.ts; `file://` is special-cased for WebViews). A srcDoc
      // document's location.origin is the string "null" regardless of sandbox flags. With the frame
      // opaque, URL.createObjectURL mints `blob:null/...`, so the worker's location.origin is also
      // "null" — stamps match, tiles flow. With `allow-same-origin`, the blob inherits the REAL app
      // origin while the document's location.origin stays "null" — every worker message is silently
      // dropped and the map wedges at "loading" with zero errors (measured; do not "fix" this again).
      // Opaque is also the security posture we want: the frame cannot touch the app origin, where
      // the session JWT lives. maplibre-gl itself is self-hosted (/vendor), so no third-party code
      // runs next to the org-scoped media token in the MVT tile URL, and the map works offline.
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
