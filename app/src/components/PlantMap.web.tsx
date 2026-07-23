// OWNER: fe-plant-map — MapLibre GL JS inside an iframe (srcDoc), sharing map/plantMapHtml +
// buildPlantInit with the native variant; bridge is window postMessage both ways, exactly like
// MapView.web.tsx: a `ready` handshake that clears the dedupe, and a JSON payload diff so
// unchanged renders don't reload tiles.
// Props are FROZEN in ./types (PlantMapProps) — do not change them.
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { buildPlantInit, maplibreSelfHosted, plantMapHtml } from './map/plantMapHtml';
import type { PlantMapProps } from './types';

export default function PlantMap(props: PlantMapProps) {
  const { onSelectPlant, height } = props;
  const { t } = useTranslation();
  const ref = useRef<HTMLIFrameElement>(null);
  const readyRef = useRef(false);
  const lastSent = useRef('');

  // The map document is served from a blob: URL minted here, NOT srcDoc. A srcdoc document's
  // location.origin is the string "null" in every browser, which breaks MapLibre in two ways:
  // its worker Actor stamps messages with location.origin and silently drops mismatches (the
  // worker, built from a blob, reports the REAL origin), and WebKit refuses to construct workers
  // in opaque-origin frames at all. A blob: document instead carries the app's real origin, so
  // the frame, its blob workers, and the Actor stamps all agree — in Chromium, WebKit and Gecko
  // alike. Blob URLs are non-hierarchical, so the maplibre tags inside must be absolute
  // (maplibreSelfHosted(origin)). The document string is static per origin — mint once.
  const docUrl = useMemo(
    () =>
      URL.createObjectURL(
        new Blob([plantMapHtml(maplibreSelfHosted(window.location.origin))], {
          type: 'text/html',
        }),
      ),
    [],
  );
  useEffect(() => () => URL.revokeObjectURL(docUrl), [docUrl]);

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
      src={docUrl}
      // `allow-same-origin` is required so the blob document keeps its real origin — sandboxing
      // would otherwise make it opaque, reintroducing both failure modes documented on `docUrl`
      // above (WebKit refusing opaque-origin workers, and the Actor "null"-origin mismatch). The
      // frame therefore shares the app origin; acceptable because its content is entirely
      // first-party — our own document string plus the self-hosted maplibre-gl from /vendor
      // (sha384-verified against the published pins at vendor time). No third-party code runs next
      // to the org-scoped media token in the MVT tile URL, and the map works offline in the field.
      sandbox="allow-scripts allow-same-origin"
      style={{
        border: 'none',
        width: '100%',
        height: height != null ? height : '100%',
        display: 'block',
      }}
    />
  );
}
