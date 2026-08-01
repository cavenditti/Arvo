// OWNER: fe-shell — Arvo's single, simplified brand mark: the A and sprout only.
// It deliberately excludes the former field detail so the in-app mark matches every
// platform icon and the native splash screen.
import { View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { colors, radius } from '@/theme';

const BRAND = { dark: '#008000', light: '#00AA00' };

function Mark({ size }: { size: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100" accessibilityLabel="Arvo">
      <Path d="M50 5 99 94H79L50 43 21 94H1Z" fill={BRAND.dark} />
      <Path
        d="M50 91C48.9 77.6 39.4 68.4 24.7 69.5c.6 12.3 10.5 21.2 25.3 21.5Z"
        fill={BRAND.light}
      />
      <Path
        d="M50 91c1.1-13.4 10.6-22.6 25.3-21.5C74.7 81.8 64.8 90.7 50 91Z"
        fill={BRAND.light}
      />
    </Svg>
  );
}

export default function Logo({
  size = 40,
  variant = 'tile',
}: {
  size?: number;
  variant?: 'tile' | 'plain';
}) {
  if (variant === 'plain') {
    return <Mark size={size} />;
  }
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: Math.min(radius.md, Math.round(size * 0.28)),
        backgroundColor: '#FFFFFF',
        borderWidth: 1,
        borderColor: colors.borderSoft,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Mark size={Math.round(size * 0.72)} />
    </View>
  );
}
