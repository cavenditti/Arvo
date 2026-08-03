// OWNER: map-native — Leaflet inside react-native-webview. Shares map/mapHtml + buildInit with the
// web variant; bridge is JSON postMessage (out) + injectJavaScript window.__update /
// window.__setBasemap (in). Props: ./types.
import { useCallback, useEffect, useRef } from 'react';
import { StyleSheet, View, type GestureResponderEvent } from 'react-native';
import { useTranslation } from 'react-i18next';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

import { buildInit, mapHtml } from './map/mapHtml';
import type { MapViewProps } from './types';

export default function MapView(props: MapViewProps) {
  const {
    onSelectParcel,
    onDrawComplete,
    onCadastreTap,
    onViewportChange,
    onTileError,
    onInteractionChange,
    basemap = 'map',
    height,
  } = props;
  const { t } = useTranslation();
  const ref = useRef<WebView>(null);
  const readyRef = useRef(false);
  const lastSent = useRef('');

  const payloadStr = JSON.stringify(
    buildInit(
      props,
      {
        finish: t('map.draw_finish'),
        cancel: t('map.draw_cancel'),
        hint: t('map.draw_hint'),
        undo: t('map.draw_undo', { defaultValue: 'Annulla ultimo punto' }),
        zoomIn: t('map.zoom_in'),
        zoomOut: t('map.zoom_out'),
      },
      {
        // Read-only maps support pinch zoom and host their own floating controls. Leaflet's
        // bottom-right +/- stack otherwise sits behind NativeTabs' bottom accessory.
        showZoomControl: props.mode === 'draw',
      },
    ),
  );

  const send = useCallback(() => {
    if (readyRef.current && ref.current && lastSent.current !== payloadStr) {
      lastSent.current = payloadStr;
      ref.current.injectJavaScript(`window.__update(${payloadStr}); true;`);
    }
  }, [payloadStr]);

  // Basemap travels outside the init payload (it is view chrome, not content): re-sending init
  // for a tile swap would rebuild every layer. Safe to call before ready — the doc remembers.
  const sendBasemap = useCallback(() => {
    if (readyRef.current && ref.current) {
      ref.current.injectJavaScript(
        `window.__setBasemap && window.__setBasemap(${JSON.stringify(basemap)}); true;`,
      );
    }
  }, [basemap]);

  useEffect(() => {
    send();
  }, [send]);

  useEffect(() => {
    sendBasemap();
  }, [sendBasemap]);

  const onMessage = useCallback(
    (e: WebViewMessageEvent) => {
      try {
        const msg = JSON.parse(e.nativeEvent.data);
        if (msg.type === 'ready') {
          readyRef.current = true;
          // A fresh document announcing ready (first boot OR a WebView content-process
          // reload) has no map state — clear the dedupe so the init is always re-sent.
          lastSent.current = '';
          send();
          sendBasemap();
        } else if (msg.type === 'select' && msg.id) {
          onSelectParcel?.(msg.id);
        } else if (msg.type === 'drawn' && msg.geometry) {
          onDrawComplete?.(msg.geometry);
        } else if (msg.type === 'cadastre' && msg.ref) {
          onCadastreTap?.(msg.ref);
        } else if (msg.type === 'moved' && Array.isArray(msg.bbox)) {
          onViewportChange?.({ bbox: msg.bbox, zoom: msg.zoom });
        } else if (msg.type === 'tileerror') {
          onTileError?.();
        }
      } catch {
        // ignore malformed bridge messages
      }
    },
    [send, sendBasemap, onSelectParcel, onDrawComplete, onCadastreTap, onViewportChange, onTileError],
  );

  // Touch bookkeeping for onInteractionChange: parents (parcel/new) pause their outer
  // ScrollView while a gesture is on the map, so panning never fights page scrolling.
  const touchActive = useRef(false);
  const setTouch = useCallback(
    (active: boolean) => {
      if (touchActive.current === active) return;
      touchActive.current = active;
      onInteractionChange?.(active);
    },
    [onInteractionChange],
  );

  return (
    <View
      style={height != null ? { height } : styles.flex}
      onTouchStart={() => setTouch(true)}
      onTouchEnd={(e: GestureResponderEvent) => {
        if (e.nativeEvent.touches.length === 0) setTouch(false);
      }}
      onTouchCancel={(e: GestureResponderEvent) => {
        if (e.nativeEvent.touches.length === 0) setTouch(false);
      }}
    >
      <WebView
        ref={ref}
        originWhitelist={['*']}
        javaScriptEnabled
        source={{ html: mapHtml }}
        onMessage={onMessage}
        style={styles.flex}
        scrollEnabled={false}
        overScrollMode="never"
      />
    </View>
  );
}

const styles = StyleSheet.create({ flex: { flex: 1, backgroundColor: 'transparent' } });
