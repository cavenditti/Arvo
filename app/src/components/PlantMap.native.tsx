// OWNER: fe-plant-map — MapLibre GL JS inside react-native-webview, sharing map/plantMapHtml +
// buildPlantInit with the web variant; bridge is JSON postMessage (out) + injectJavaScript
// window.__updatePlants (in), exactly like MapView.native.tsx.
// Props are FROZEN in ./types (PlantMapProps) — do not change them.
import { useCallback, useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

import { API_URL, api } from '@/api/client';

import { buildPlantInit, plantMapHtml } from './map/plantMapHtml';
import type { PlantMapProps } from './types';

// Static HTML otherwise loads at about:blank, so MapLibre's fetch-based vector tile requests carry
// `Origin: null`. Production deliberately rejects that opaque origin. react-native-webview uses
// baseUrl as the CORS origin for an HTML source, making the protected tiles same-origin with the
// API on iOS and Android. Keeping the object stable also avoids reloading the WebView on renders.
const PLANT_MAP_SOURCE = { html: plantMapHtml(), baseUrl: API_URL };

export default function PlantMap(props: PlantMapProps) {
  const { onSelectPlant, height } = props;
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const ref = useRef<WebView>(null);
  const readyRef = useRef(false);
  const lastSent = useRef('');
  const fallbackRequestRef = useRef('');

  // This route uses a translucent iOS header and draws the WebView underneath it. Keep map-owned
  // chrome below the navigation bar and aligned with the React metric selector.
  const selectorTop = insets.top + 56;
  // Field selection moved into the navigation title; metric and basemap now share one row.
  const mapChromeTop = selectorTop;
  const payloadStr = JSON.stringify(
    buildPlantInit(
      props,
      {
        loading: t('plantmap.loading'),
        empty: t('plantmap.empty'),
        zoomIn: t('plantmap.zoom_in'),
        error: t('plantmap.load_error'),
        map: t('map.basemap_map'),
        satellite: t('map.basemap_sat'),
      },
      mapChromeTop,
    ),
  );
  const payloadKey = `${props.parcelId}:${props.metric}:${props.tileUrlTemplate}`;
  const activePayloadKeyRef = useRef(payloadKey);

  useEffect(() => {
    activePayloadKeyRef.current = payloadKey;
  }, [payloadKey]);

  const send = useCallback(() => {
    if (readyRef.current && ref.current && lastSent.current !== payloadStr) {
      lastSent.current = payloadStr;
      fallbackRequestRef.current = '';
      ref.current.injectJavaScript(`window.__updatePlants(${payloadStr}); true;`);
    }
  }, [payloadStr]);

  // MVT remains the primary path for large orchards. If MapLibre cannot load or render its
  // current vector source, use the existing authenticated GeoJSON export as a native-fetched
  // fallback. This request goes through the ordinary Bearer client (including its token refresh),
  // so it does not depend on WebView CORS or query-token handling.
  const loadFallback = useCallback(async () => {
    const key = payloadKey;
    if (fallbackRequestRef.current === key) return;
    fallbackRequestRef.current = key;
    try {
      const encodedParcel = encodeURIComponent(props.parcelId);
      const encodedMetric = encodeURIComponent(props.metric);
      const raw = await api.get<string | { type: string; features: unknown[] }>(
        `/plants/export.geojson?parcel_id=${encodedParcel}&metric=${encodedMetric}&capture=latest`,
      );
      const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (activePayloadKeyRef.current !== key || !ref.current) return;
      ref.current.injectJavaScript(`window.__setPlantFallback(${JSON.stringify(data)}); true;`);
    } catch {
      if (activePayloadKeyRef.current !== key) return;
      fallbackRequestRef.current = '';
      ref.current?.injectJavaScript('window.__plantFallbackError(); true;');
    }
  }, [payloadKey, props.metric, props.parcelId]);

  useEffect(() => {
    send();
  }, [send]);

  const onMessage = useCallback(
    (e: WebViewMessageEvent) => {
      try {
        const msg = JSON.parse(e.nativeEvent.data);
        if (msg.type === 'ready') {
          readyRef.current = true;
          // A fresh document announcing ready (first boot OR a WebView content-process reload)
          // has no map state — clear the dedupe so the init is always re-sent.
          lastSent.current = '';
          fallbackRequestRef.current = '';
          send();
        } else if (msg.type === 'plantSource' && msg.state !== 'ready') {
          void loadFallback();
        } else if ((msg.type === 'plant' || msg.type === 'selectPlant') && msg.id) {
          onSelectPlant?.(msg.id);
        }
      } catch {
        // ignore malformed bridge messages
      }
    },
    [send, loadFallback, onSelectPlant],
  );

  return (
    <View style={height != null ? { height } : styles.flex}>
      <WebView
        ref={ref}
        originWhitelist={['*']}
        javaScriptEnabled
        // MapLibre keeps its tile/glyph state in a worker-backed cache; without DOM storage the
        // WebGL context still runs, but Android throws on the first IndexedDB touch.
        domStorageEnabled
        source={PLANT_MAP_SOURCE}
        onMessage={onMessage}
        style={styles.flex}
        scrollEnabled={false}
        overScrollMode="never"
      />
    </View>
  );
}

const styles = StyleSheet.create({ flex: { flex: 1, backgroundColor: 'transparent' } });
