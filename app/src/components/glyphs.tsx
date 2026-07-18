// OWNER: fe-shell — Terra glyph library (docs/DESIGN.md §5): simple organic vector marks used
// as oversized card-bleed illustrations (via GlyphCard) and small badges (via GlyphBadge).
// One fill color; compose shapes solid and let the wrapper apply opacity so overlaps stay flat.
import type { ComponentType } from 'react';
import Svg, { Circle, G, Line, Path, Rect } from 'react-native-svg';

import { colors } from '@/theme';

export type GlyphName =
  | 'sun'
  | 'cloud'
  | 'rain'
  | 'frost'
  | 'leaf'
  | 'sprout'
  | 'drop'
  | 'wind'
  | 'thermo';

function Sun({ color }: { color: string }) {
  return (
    <G>
      <Circle cx={50} cy={50} r={20} fill={color} />
      {Array.from({ length: 8 }, (_, i) => (
        <Rect
          key={i}
          x={46.5}
          y={7}
          width={7}
          height={17}
          rx={3.5}
          fill={color}
          transform={`rotate(${i * 45} 50 50)`}
        />
      ))}
    </G>
  );
}

function CloudShape({ color, lift = 0 }: { color: string; lift?: number }) {
  const dy = -lift;
  return (
    <G>
      <Circle cx={34} cy={52 + dy} r={16} fill={color} />
      <Circle cx={56} cy={44 + dy} r={21} fill={color} />
      <Circle cx={74} cy={55 + dy} r={13} fill={color} />
      <Rect x={30} y={52 + dy} width={48} height={16} rx={8} fill={color} />
    </G>
  );
}

function Cloud({ color }: { color: string }) {
  return <CloudShape color={color} />;
}

function Rain({ color }: { color: string }) {
  return (
    <G>
      <CloudShape color={color} lift={18} />
      {[27, 47, 67].map((x, i) => (
        <Rect
          key={i}
          x={x}
          y={i === 1 ? 64 : 56}
          width={7}
          height={27}
          rx={3.5}
          fill={color}
          transform={`rotate(16 ${x} ${i === 1 ? 64 : 56})`}
        />
      ))}
    </G>
  );
}

function Frost({ color }: { color: string }) {
  return (
    <G>
      <Circle cx={50} cy={50} r={7} fill={color} />
      {Array.from({ length: 6 }, (_, i) => (
        <G key={i} transform={`rotate(${i * 60} 50 50)`}>
          <Line x1={50} y1={40} x2={50} y2={12} stroke={color} strokeWidth={6} strokeLinecap="round" />
          <Circle cx={50} cy={10} r={4.5} fill={color} />
        </G>
      ))}
    </G>
  );
}

function Leaf({ color }: { color: string }) {
  return (
    <G>
      <Path d="M50 10 C 78 24 86 56 52 86 C 18 56 26 24 50 10 Z" fill={color} />
      <Path d="M50 86 L 50 96" stroke={color} strokeWidth={6} strokeLinecap="round" />
    </G>
  );
}

function Sprout({ color }: { color: string }) {
  return (
    <G>
      <Path
        d="M50 92 C 50 70 50 56 50 44"
        stroke={color}
        strokeWidth={7}
        strokeLinecap="round"
        fill="none"
      />
      <Path d="M50 56 C 28 56 18 42 18 26 C 38 26 50 38 50 56 Z" fill={color} />
      <Path d="M50 44 C 70 44 80 32 80 16 C 62 16 50 28 50 44 Z" fill={color} />
    </G>
  );
}

function Drop({ color }: { color: string }) {
  return (
    <Path
      d="M50 8 C 60 30 76 44 76 62 A 26 26 0 1 1 24 62 C 24 44 40 30 50 8 Z"
      fill={color}
    />
  );
}

function Wind({ color }: { color: string }) {
  return (
    <G>
      <Path
        d="M12 36 H 56 A 10 10 0 1 0 46 20"
        stroke={color}
        strokeWidth={7}
        strokeLinecap="round"
        fill="none"
      />
      <Path
        d="M8 54 H 74 A 11 11 0 1 1 63 72"
        stroke={color}
        strokeWidth={7}
        strokeLinecap="round"
        fill="none"
      />
      <Path
        d="M16 72 H 44 A 8 8 0 1 1 36 85"
        stroke={color}
        strokeWidth={7}
        strokeLinecap="round"
        fill="none"
      />
    </G>
  );
}

function Thermo({ color }: { color: string }) {
  // contour (tube+bulb outline) + mercury column: reads as a thermometer even tone-on-tone,
  // unlike a solid silhouette (which looks like a pin)
  return (
    <G>
      <Path
        d="M 39 66 L 39 17 A 11 11 0 0 1 61 17 L 61 66 A 15.5 15.5 0 1 1 39 66 Z"
        stroke={color}
        strokeWidth={6}
        fill="none"
      />
      <Rect x={46.5} y={34} width={7} height={36} rx={3.5} fill={color} />
      <Circle cx={50} cy={77} r={8.5} fill={color} />
    </G>
  );
}

const GLYPHS: Record<GlyphName, ComponentType<{ color: string }>> = {
  sun: Sun,
  cloud: Cloud,
  rain: Rain,
  frost: Frost,
  leaf: Leaf,
  sprout: Sprout,
  drop: Drop,
  wind: Wind,
  thermo: Thermo,
};

/** One Terra glyph at `size`, single `color`. Wrap in an opacity View for bleed use. */
export default function Glyph({
  name,
  size = 24,
  color,
}: {
  name: GlyphName;
  size?: number;
  color: string;
}) {
  const Shape = GLYPHS[name];
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      <Shape color={color} />
    </Svg>
  );
}

/** Weather-day glyph choice (mirrors theme.weatherGradient). */
export function weatherGlyph(
  tMin: number | null | undefined,
  tMax: number | null | undefined,
  precipMm: number | null | undefined,
): GlyphName {
  if (tMin != null && tMin <= 0) return 'frost';
  if ((precipMm ?? 0) >= 1) return 'rain';
  if (tMax != null && tMax >= 32) return 'sun';
  if (tMax != null && tMax >= 20) return 'sun';
  return 'cloud';
}

/** Deeper tone matching a weather glyph's backdrop family (docs/DESIGN.md §5). The one
 * canonical mapping — WeatherPanel and the weather tab previously kept near-twin copies. */
export function weatherTone(glyph: GlyphName): string {
  if (glyph === 'sun') return colors.warning; // hot / clear
  if (glyph === 'rain' || glyph === 'frost') return colors.info; // wet / cold
  return colors.textFaint; // cloud / mild
}

/** Alert/advisory kind → glyph (fallback 'sprout'). */
export function kindGlyph(kind: string | null | undefined): GlyphName {
  if (!kind) return 'sprout';
  if (kind.includes('heat')) return 'thermo';
  if (kind.includes('frost')) return 'frost';
  if (kind.includes('spray') || kind.includes('wind')) return 'wind';
  if (kind.includes('moisture') || kind.includes('water') || kind.includes('rain')) return 'drop';
  if (kind.includes('index') || kind.includes('ndvi')) return 'leaf';
  if (kind.includes('cloud') || kind.includes('imagery')) return 'cloud';
  return 'sprout';
}
