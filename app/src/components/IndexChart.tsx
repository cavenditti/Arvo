// OWNER: fe-dashboard — replace with react-native-svg line chart (p10–p90 band, tap for value).
import { Text, View } from 'react-native';

import type { IndexChartProps } from './types';

export default function IndexChart(props: IndexChartProps) {
  return (
    <View style={{ height: props.height ?? 180, alignItems: 'center', justifyContent: 'center' }}>
      <Text>
        {props.index.toUpperCase()} chart placeholder ({props.series.length} points)
      </Text>
    </View>
  );
}
