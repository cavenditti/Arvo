// OWNER: capture-observe — stub. The center tab FAB routes straight to /observation/new and the
// list moved to the /scouting stack route; this redirect only covers programmatic tab focus.
import { Redirect } from 'expo-router';

export default function Screen() {
  return <Redirect href="/observation/new" />;
}
