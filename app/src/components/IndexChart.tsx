// OWNER: fe-dashboard — react-native-svg index time series: p10–p90 band, mean polyline,
// per-acquisition dots (hollow when cloudy), tap dot → value label.
import { format, parseISO } from 'date-fns';
import type { Locale } from 'date-fns';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, Text, View } from 'react-native';
import Svg, {
  Circle,
  G,
  Line,
  Path,
  Polyline,
  Rect,
  Text as SvgText,
} from 'react-native-svg';

import type { IndexPoint } from '@/api/types';
import { INDEX_DOMAIN, dfLocale, indexColor } from '@/features/insights/format';
import { colors, spacing } from '@/theme';
import type { IndexChartProps } from './types';

const PAD = { top: 12, right: 12, bottom: 22, left: 30 };
const CLOUD_MAX = 40; // cloud_pct above this → hollow dot (low-confidence acquisition)

export default function IndexChart({ series, index, height = 200 }: IndexChartProps) {
  const { t } = useTranslation();
  const [width, setWidth] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  // read here (component subscribes to language via useTranslation) and thread down so the
  // memoizable children re-render on a live language switch
  const locale = dfLocale();

  if (series.length === 0) {
    return (
      <View style={[styles.empty, { height }]}>
        <Text style={styles.emptyText}>{t('chart.no_data')}</Text>
      </View>
    );
  }

  return (
    <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)} style={{ height }}>
      {width > 0 && (
        <Chart
          series={series}
          index={index}
          width={width}
          height={height}
          selected={selected}
          onSelect={setSelected}
          locale={locale}
        />
      )}
    </View>
  );
}

type Pt = {
  x: number;
  yMean: number;
  yHi: number;
  yLo: number;
  cloudy: boolean;
  p: IndexPoint;
};

function Chart({
  series,
  index,
  width,
  height,
  selected,
  onSelect,
  locale,
}: {
  series: IndexPoint[];
  index: IndexChartProps['index'];
  width: number;
  height: number;
  selected: number | null;
  onSelect: (i: number | null) => void;
  locale: Locale;
}) {
  const [yMin, yMax] = INDEX_DOMAIN[index];
  const innerW = width - PAD.left - PAD.right;
  const innerH = height - PAD.top - PAD.bottom;

  const times = series.map((p) => parseISO(p.observed_at).getTime());
  const tMin = Math.min(...times);
  const tMax = Math.max(...times);
  const tRange = tMax - tMin;

  const xFor = (t: number) => PAD.left + (tRange > 0 ? (t - tMin) / tRange : 0.5) * innerW;
  const yFor = (v: number) => {
    const c = Math.max(yMin, Math.min(yMax, v));
    return PAD.top + (1 - (c - yMin) / (yMax - yMin)) * innerH;
  };

  const pts: Pt[] = series.map((p, i) => ({
    x: xFor(times[i]),
    yMean: yFor(p.mean),
    yHi: yFor(p.p90 ?? p.mean),
    yLo: yFor(p.p10 ?? p.mean),
    cloudy: (p.cloud_pct ?? 0) > CLOUD_MAX,
    p,
  }));

  // p10–p90 band as a closed path (top left→right along p90, back right→left along p10)
  const band =
    pts.map((d, i) => `${i === 0 ? 'M' : 'L'} ${d.x} ${d.yHi}`).join(' ') +
    ' ' +
    pts
      .slice()
      .reverse()
      .map((d) => `L ${d.x} ${d.yLo}`)
      .join(' ') +
    ' Z';

  const meanLine = pts.map((d) => `${d.x},${d.yMean}`).join(' ');

  const yTicks = Array.from({ length: 5 }, (_, i) => yMin + ((yMax - yMin) * i) / 4);
  const xTickIdx = [0, Math.floor((series.length - 1) / 2), series.length - 1].filter(
    (v, i, a) => a.indexOf(v) === i,
  );

  return (
    <Svg width={width} height={height}>
      {yTicks.map((v, i) => {
        const y = yFor(v);
        return (
          <G key={`y${i}`}>
            <Line
              x1={PAD.left}
              y1={y}
              x2={width - PAD.right}
              y2={y}
              stroke={colors.border}
              strokeWidth={1}
            />
            <SvgText
              x={PAD.left - 4}
              y={y + 3}
              fontSize={9}
              fill={colors.textMuted}
              textAnchor="end"
            >
              {v.toFixed(v % 1 === 0 ? 0 : 1)}
            </SvgText>
          </G>
        );
      })}

      <Path d={band} fill={colors.primary} fillOpacity={0.14} />
      <Polyline points={meanLine} fill="none" stroke={colors.primary} strokeWidth={2} />

      {xTickIdx.map((i) => (
        <SvgText
          key={`x${i}`}
          x={Math.max(PAD.left + 12, Math.min(width - PAD.right - 12, pts[i].x))}
          y={height - 6}
          fontSize={9}
          fill={colors.textMuted}
          textAnchor="middle"
        >
          {format(times[i], 'd MMM', { locale })}
        </SvgText>
      ))}

      {pts.map((d, i) => (
        <G key={`d${i}`}>
          <Circle
            cx={d.x}
            cy={d.yMean}
            r={3.5}
            fill={d.cloudy ? colors.card : indexColor(index, d.p.mean)}
            stroke={colors.primary}
            strokeWidth={1.5}
          />
          {/* enlarged transparent hit target for tap */}
          <Circle
            cx={d.x}
            cy={d.yMean}
            r={14}
            fill="transparent"
            onPress={() => onSelect(selected === i ? null : i)}
          />
        </G>
      ))}

      {selected != null && pts[selected] && (
        <Label pt={pts[selected]} width={width} locale={locale} />
      )}
    </Svg>
  );
}

function Label({ pt, width, locale }: { pt: Pt; width: number; locale: Locale }) {
  const text = `${pt.p.mean.toFixed(2)} · ${format(parseISO(pt.p.observed_at), 'd MMM', {
    locale,
  })}`;
  const boxW = 10 + text.length * 6;
  const boxH = 18;
  const x = Math.max(4, Math.min(width - boxW - 4, pt.x - boxW / 2));
  const y = Math.max(2, pt.yMean - boxH - 6);
  return (
    <G>
      <Rect x={x} y={y} width={boxW} height={boxH} rx={4} fill={colors.text} opacity={0.92} />
      <SvgText x={x + boxW / 2} y={y + 12} fontSize={10} fill="#FFFFFF" textAnchor="middle">
        {text}
      </SvgText>
    </G>
  );
}

const styles = StyleSheet.create({
  empty: { alignItems: 'center', justifyContent: 'center', padding: spacing.md },
  emptyText: { color: colors.textMuted },
});
