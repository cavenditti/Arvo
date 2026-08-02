// OWNER: capture-observe — compatibility stub for old deep links. Creation is now opened from
// the separate primary action beside the tab pill; scouting history lives in the root stack.
import { Redirect } from 'expo-router';

export default function Screen() {
  return <Redirect href="/observation/new" />;
}
