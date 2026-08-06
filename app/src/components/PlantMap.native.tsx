// OWNER: fe-plant-map — MapLibre GL JS inside react-native-webview, sharing map/plantMapHtml +
// buildPlantInit with the web variant; bridge is JSON postMessage (out) + injectJavaScript
// window.__updatePlants (in), exactly like MapView.native.tsx.
// Props are FROZEN in ./types (PlantMapProps) — do not change them.
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Platform, StyleSheet, View } from 'react-native';

import Constants from 'expo-constants';
import * as Device from 'expo-device';
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

interface PlantMapDiagnosticEvent {
  name: string;
  elapsed_ms?: number;
  state?: string;
  zoom?: number;
  source_loaded?: boolean;
  source_features?: number;
  rendered_features?: number;
  heat_features?: number;
  tile_requests?: number;
  tile_events?: number;
  tile?: string;
  source_data_type?: string;
  source_id?: string;
  circle_layer?: boolean;
  heat_layer?: boolean;
  canvas_width?: number;
  canvas_height?: number;
  origin?: string;
  error_name?: string;
  error_message?: string;
  http_status?: number;
}

function createDiagnosticId(_parcelId: string, _metric: string): string {
  return `pm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function safeDiagnosticMessage(value: unknown): string | undefined {
  if (value == null) return undefined;
  return String(value)
    .replace(/([?&]token=)[^&#\s]+/gi, '$1[redacted]')
    .replace(/(authorization=)[^&#\s]+/gi, '$1[redacted]')
    .slice(0, 480);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Copy only the fixed, credential-free diagnostic schema out of the WebView message. */
function bridgeDiagnostic(msg: Record<string, unknown>): PlantMapDiagnosticEvent | null {
  if (typeof msg.name !== 'string') return null;
  return {
    name: msg.name,
    elapsed_ms: finiteNumber(msg.elapsed_ms),
    state: typeof msg.state === 'string' ? msg.state : undefined,
    zoom: finiteNumber(msg.zoom),
    source_loaded: typeof msg.source_loaded === 'boolean' ? msg.source_loaded : undefined,
    source_features: finiteNumber(msg.source_features),
    rendered_features: finiteNumber(msg.rendered_features),
    heat_features: finiteNumber(msg.heat_features),
    tile_requests: finiteNumber(msg.tile_requests),
    tile_events: finiteNumber(msg.tile_events),
    tile: typeof msg.tile === 'string' ? msg.tile : undefined,
    source_data_type:
      typeof msg.source_data_type === 'string' ? msg.source_data_type : undefined,
    source_id: typeof msg.source_id === 'string' ? msg.source_id : undefined,
    circle_layer: typeof msg.circle_layer === 'boolean' ? msg.circle_layer : undefined,
    heat_layer: typeof msg.heat_layer === 'boolean' ? msg.heat_layer : undefined,
    canvas_width: finiteNumber(msg.canvas_width),
    canvas_height: finiteNumber(msg.canvas_height),
    origin: typeof msg.origin === 'string' ? msg.origin : undefined,
    error_name: typeof msg.error_name === 'string' ? msg.error_name : undefined,
    error_message: safeDiagnosticMessage(msg.error_message),
    http_status: finiteNumber(msg.http_status),
  };
}

export default function PlantMap(props: PlantMapProps) {
  const { onSelectPlant, height } = props;
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const ref = useRef<WebView>(null);
  const readyRef = useRef(false);
  const lastSent = useRef('');
  const sentDiagnosticsRef = useRef(new Set<string>());
  const mapDiagnosticId = useMemo(
    () => createDiagnosticId(props.parcelId, props.metric),
    [props.parcelId, props.metric],
  );

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
      mapDiagnosticId,
    ),
  );

  useEffect(() => {
    sentDiagnosticsRef.current.clear();
  }, [mapDiagnosticId]);

  const send = useCallback(() => {
    if (readyRef.current && ref.current && lastSent.current !== payloadStr) {
      lastSent.current = payloadStr;
      ref.current.injectJavaScript(`window.__updatePlants(${payloadStr}); true;`);
    }
  }, [payloadStr]);

  const reportDiagnostic = useCallback(
    (event: PlantMapDiagnosticEvent) => {
      const fingerprint = JSON.stringify(event);
      if (sentDiagnosticsRef.current.has(fingerprint) || sentDiagnosticsRef.current.size >= 40) {
        return;
      }
      sentDiagnosticsRef.current.add(fingerprint);
      const buildNumber =
        Platform.OS === 'ios'
          ? Constants.platform?.ios?.buildNumber
          : Constants.platform?.android?.versionCode?.toString();
      void api
        .post<void>('/diagnostics/plant-map', {
          diagnostic_id: mapDiagnosticId,
          parcel_id: props.parcelId,
          metric: props.metric,
          platform: Platform.OS,
          os_version: Device.osVersion ?? String(Platform.Version),
          device_model: Device.modelName ?? undefined,
          app_version: Constants.expoConfig?.version,
          build_number: buildNumber ?? undefined,
          event,
        })
        .catch(() => {
          // Diagnostics must never interfere with the map or show a second user-facing error.
        });
    },
    [mapDiagnosticId, props.metric, props.parcelId],
  );

  useEffect(() => {
    send();
  }, [send]);

  const onMessage = useCallback(
    (e: WebViewMessageEvent) => {
      try {
        const msg = JSON.parse(e.nativeEvent.data) as Record<string, unknown>;
        if (msg.type === 'ready') {
          readyRef.current = true;
          // A fresh document announcing ready (first boot OR a WebView content-process reload)
          // has no map state — clear the dedupe so the init is always re-sent.
          lastSent.current = '';
          send();
        } else if (
          msg.type === 'plantDiagnostic' &&
          msg.diagnosticId === mapDiagnosticId
        ) {
          const event = bridgeDiagnostic(msg);
          if (event) reportDiagnostic(event);
        } else if ((msg.type === 'plant' || msg.type === 'selectPlant') && msg.id) {
          onSelectPlant?.(String(msg.id));
        }
      } catch {
        // ignore malformed bridge messages
      }
    },
    [mapDiagnosticId, onSelectPlant, reportDiagnostic, send],
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
        onLoadStart={() => reportDiagnostic({ name: 'webview-load-start' })}
        onLoadEnd={() => reportDiagnostic({ name: 'webview-load-end' })}
        onError={(event) =>
          reportDiagnostic({
            name: 'webview-error',
            error_name: String(event.nativeEvent.code),
            error_message: safeDiagnosticMessage(event.nativeEvent.description),
          })
        }
        onHttpError={(event) =>
          reportDiagnostic({
            name: 'webview-http-error',
            http_status: event.nativeEvent.statusCode,
            error_message: safeDiagnosticMessage(event.nativeEvent.description),
          })
        }
        onContentProcessDidTerminate={() =>
          reportDiagnostic({ name: 'webview-process-terminated' })
        }
        style={styles.flex}
        scrollEnabled={false}
        overScrollMode="never"
      />
    </View>
  );
}

const styles = StyleSheet.create({ flex: { flex: 1, backgroundColor: 'transparent' } });
