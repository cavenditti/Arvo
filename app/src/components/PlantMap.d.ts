// SPINE — type-only resolution shim. tsc resolves `@/components/PlantMap` here; Metro ignores
// .d.ts and picks PlantMap.web.tsx / PlantMap.native.tsx per platform. Keep props identical in
// both. Do NOT add a plain PlantMap.ts/.tsx — it would win over both platform files.
import type { ComponentType } from 'react';

import type { PlantMapProps } from './types';

declare const PlantMap: ComponentType<PlantMapProps>;
export default PlantMap;
