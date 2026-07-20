// OWNER: web-shell — web replacement for the native bottom-tabs layout. On web, Metro resolves
// this .web.tsx over _layout.tsx: instead of <Tabs>, the (tabs) group renders inside the Campo
// portal chrome (fixed sidebar + scrollable main). Every (tabs) route mounts through <Slot />.
// Routes are therefore NOT declared here (unlike the native <Tabs> in _layout.tsx): adding a
// screen to (tabs) is enough for it to render — `plants.web.tsx` (the plant map workspace) mounts
// this way, and is entered from the parcel detail screen's "open plant map" action.
import { Slot } from 'expo-router';

import PortalShell from '@/components/web/PortalShell';

export default function TabsWebLayout() {
  return (
    <PortalShell>
      <Slot />
    </PortalShell>
  );
}
