// OWNER: fe-map — replace with the Leaflet-in-iframe (srcDoc) implementation sharing
// src/components/map/mapHtml.ts with the native WebView version. Props: ./types.ts.
import { Text, View } from 'react-native';

import type { MapViewProps } from './types';

export default function MapView(props: MapViewProps) {
  return (
    <View style={{ height: props.height ?? 300, alignItems: 'center', justifyContent: 'center' }}>
      <Text>Map placeholder ({props.parcels.length} parcels)</Text>
    </View>
  );
}
