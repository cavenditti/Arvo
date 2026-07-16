// OWNER: web-shell — web replacement for the native bottom-tabs layout. On web, Metro resolves
// this .web.tsx over _layout.tsx: instead of <Tabs>, the (tabs) group renders inside the Campo
// portal chrome (fixed sidebar + scrollable main). Every (tabs) route mounts through <Slot />.
import { Slot } from 'expo-router';

import PortalShell from '@/components/web/PortalShell';

export default function TabsWebLayout() {
  return (
    <PortalShell>
      <Slot />
    </PortalShell>
  );
}
