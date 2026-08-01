// OWNER: foundation-ui — data freshness banner (docs/UX-REVAMP.md frozen contract). Quiet,
// informational tone: tells the farmer what he's looking at ("Aggiornato alle 12:30"), never
// alarms him. Renders nothing while online with fresh data (<10 min).
import Ionicons from '@expo/vector-icons/Ionicons';
import { useNetInfo } from '@react-native-community/netinfo';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, Text, View } from 'react-native';

import { formatTime } from '@/lib/format';
import { colors, fonts, radius, spacing, type as typeScale } from '@/theme';

const FRESH_MS = 10 * 60 * 1000;
const RECHECK_MS = 30 * 1000;

/** True unless NetInfo definitely reports no connection (unknown counts as online). */
export function useOnlineStatus(): boolean {
  const net = useNetInfo();
  return net.isConnected !== false;
}

export function StaleBanner({ updatedAt }: { updatedAt?: number | null }) {
  const { t } = useTranslation();
  const online = useOnlineStatus();

  // Staleness depends on "now" — keep a clock in state and re-evaluate while mounted.
  const [now, setNow] = useState(0);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const id = setInterval(tick, RECHECK_MS);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, []);

  // Until the first effect tick (now=0) treat data as fresh — avoids a stale flash on mount.
  const fresh = updatedAt != null && (now === 0 || now - updatedAt < FRESH_MS);
  if (online && (updatedAt == null || fresh)) return null;

  return (
    <View style={styles.row} accessibilityLiveRegion="polite">
      {!online && (
        <View style={styles.pill}>
          <Ionicons name="cloud-offline-outline" size={14} color={colors.textMuted} />
          <Text style={styles.text} maxFontSizeMultiplier={typeScale.maxMult}>
            {t('common.offline')}
          </Text>
        </View>
      )}
      {updatedAt != null && (
        <View style={styles.pill}>
          <Text style={styles.text} maxFontSizeMultiplier={typeScale.maxMult}>
            {t('common.updated_at', { time: formatTime(updatedAt) })}
          </Text>
        </View>
      )}
    </View>
  );
}

export default StaleBanner;

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: spacing.sm,
    flexWrap: 'wrap',
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 28,
    backgroundColor: colors.cardAlt,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radius.pill,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  text: { fontFamily: fonts.bodyMedium, fontSize: typeScale.caption, color: colors.textMuted },
});
