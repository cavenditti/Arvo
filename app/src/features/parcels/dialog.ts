// OWNER: fe-map — cross-platform dialogs. react-native-web's Alert.alert is a no-op, so the web
// portal must fall back to the browser's window.confirm/alert for confirmations and toasts.
import { Alert, Platform } from 'react-native';

export function notify(title: string, message?: string) {
  if (Platform.OS === 'web') {
    window.alert(message ? `${title}\n\n${message}` : title);
  } else {
    Alert.alert(title, message);
  }
}

export function confirmDestructive(opts: {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
}) {
  if (Platform.OS === 'web') {
    if (window.confirm(`${opts.title}\n\n${opts.message}`)) opts.onConfirm();
  } else {
    Alert.alert(opts.title, opts.message, [
      { text: opts.cancelLabel, style: 'cancel' },
      { text: opts.confirmLabel, style: 'destructive', onPress: opts.onConfirm },
    ]);
  }
}
