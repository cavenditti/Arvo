// OWNER: fe-plant-map — MapLibre GL JS inside react-native-webview, sharing map/plantMapHtml +
// buildPlantInit with the web variant; bridge is JSON postMessage (out) + injectJavaScript
// window.__updatePlants (in), exactly like MapView.native.tsx.
// Props are FROZEN in ./types (PlantMapProps) — do not change them.
import { useCallback, useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

import { buildPlantInit, plantMapHtml } from './map/plantMapHtml';
import type { PlantMapProps } from './types';

export default function PlantMap(props: PlantMapProps) {
  const { onSelectPlant, height } = props;
  const { t } = useTranslation();
  const ref = useRef<WebView>(null);
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
    if (readyRef.current && ref.current && lastSent.current !== payloadStr) {
      lastSent.current = payloadStr;
      ref.current.injectJavaScript(`window.__updatePlants(${payloadStr}); true;`);
    }
  }, [payloadStr]);

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
          send();
        } else if ((msg.type === 'plant' || msg.type === 'selectPlant') && msg.id) {
          onSelectPlant?.(msg.id);
        }
      } catch {
        // ignore malformed bridge messages
      }
    },
    [send, onSelectPlant],
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
        source={{ html: plantMapHtml() }}
        onMessage={onMessage}
        style={styles.flex}
        scrollEnabled={false}
        overScrollMode="never"
      />
    </View>
  );
}

const styles = StyleSheet.create({ flex: { flex: 1, backgroundColor: 'transparent' } });
