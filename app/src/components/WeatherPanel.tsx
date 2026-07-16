// OWNER: fe-dashboard — replace with 7-day forecast strip + GDD/ET0/water-balance chips +
// advisory badges (decision-support tone; see docs/API.md §Weather).
import { Text, View } from 'react-native';

import type { WeatherPanelProps } from './types';

export default function WeatherPanel(props: WeatherPanelProps) {
  return (
    <View style={{ padding: 8 }}>
      <Text>Weather placeholder ({props.daily.length} days)</Text>
    </View>
  );
}
