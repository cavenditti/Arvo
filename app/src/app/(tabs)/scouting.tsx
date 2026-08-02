// OWNER: capture-observe — compatibility stub for old deep links. Creation is opened from
// contextual field/scouting actions; scouting history lives in the root stack.
import { Redirect } from 'expo-router';

export default function Screen() {
  return <Redirect href="/observation/new" />;
}
