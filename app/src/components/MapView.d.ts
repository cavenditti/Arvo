// SPINE — type-only resolution shim. tsc resolves `@/components/MapView` here; Metro ignores
// .d.ts and picks MapView.web.tsx / MapView.native.tsx per platform. Keep props identical in both.
import type { ComponentType } from 'react';

import type { MapViewProps } from './types';

declare const MapView: ComponentType<MapViewProps>;
export default MapView;
