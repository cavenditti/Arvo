// OWNER: fe-map — Leaflet inside an iframe (srcDoc). Shares map/mapHtml + buildInit with the native
// variant; bridge is window postMessage both ways. sandbox="allow-scripts" (scripts + tiles, no
// same-origin). Props: ./types.
import { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { buildInit, mapHtml } from './map/mapHtml';
import type { MapViewProps } from './types';

export default function MapView(props: MapViewProps) {
  const { onSelectParcel, onDrawComplete, height } = props;
  const { t } = useTranslation();
  const ref = useRef<HTMLIFrameElement>(null);
  const readyRef = useRef(false);
  const lastSent = useRef('');

  const payloadStr = JSON.stringify(
    buildInit(props, {
      finish: t('map.draw_finish'),
      cancel: t('map.draw_cancel'),
      hint: t('map.draw_hint'),
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
          send();
        } else if (msg.type === 'select' && msg.id) {
          onSelectParcel?.(msg.id);
        } else if (msg.type === 'drawn' && msg.geometry) {
          onDrawComplete?.(msg.geometry);
        }
      } catch {
        // ignore malformed bridge messages
      }
    }
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [send, onSelectParcel, onDrawComplete]);

  return (
    <iframe
      ref={ref}
      title="map"
      srcDoc={mapHtml}
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
