// OWNER: fe-map — replace with the Leaflet-in-WebView implementation (shared HTML in
// src/components/map/mapHtml.ts, JSON postMessage bridge). Props contract: ../components/types.ts.
import { Text, View } from 'react-native';

import type { MapViewProps } from './types';

export default function MapView(props: MapViewProps) {
  return (
    <View style={{ height: props.height ?? 300, alignItems: 'center', justifyContent: 'center' }}>
      <Text>Map placeholder ({props.parcels.length} parcels)</Text>
    </View>
  );
}
