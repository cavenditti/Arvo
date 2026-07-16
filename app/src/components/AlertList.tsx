// OWNER: fe-dashboard — replace with severity-colored list + ack/snooze/dismiss actions.
import { Text, View } from 'react-native';

import type { AlertListProps } from './types';

export default function AlertList(props: AlertListProps) {
  return (
    <View style={{ padding: 8 }}>
      <Text>Alerts placeholder ({props.alerts.length})</Text>
    </View>
  );
}
