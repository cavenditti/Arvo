// OWNER: fe-map — Leaflet inside react-native-webview. Shares map/mapHtml + buildInit with the web
// variant; bridge is JSON postMessage (out) + injectJavaScript window.__update (in). Props: ./types.
import { useCallback, useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

import { buildInit, mapHtml } from './map/mapHtml';
import type { MapViewProps } from './types';

export default function MapView(props: MapViewProps) {
  const { onSelectParcel, onDrawComplete, height } = props;
  const { t } = useTranslation();
  const ref = useRef<WebView>(null);
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
    if (readyRef.current && ref.current && lastSent.current !== payloadStr) {
      lastSent.current = payloadStr;
      ref.current.injectJavaScript(`window.__update(${payloadStr}); true;`);
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
          send();
        } else if (msg.type === 'select' && msg.id) {
          onSelectParcel?.(msg.id);
        } else if (msg.type === 'drawn' && msg.geometry) {
          onDrawComplete?.(msg.geometry);
        }
      } catch {
        // ignore malformed bridge messages
      }
    },
    [send, onSelectParcel, onDrawComplete],
  );

  return (
    <View style={height != null ? { height } : styles.flex}>
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
