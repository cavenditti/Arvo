// OWNER: alert-grouping — grouped alert-event rows (docs/UX-REVAMP.md). Renders AlertEvents
// from features/insights/grouping.ts as one standard content list: plain-language title,
// parcel + relative time, body, and a technical disclosure. Native actions live behind the row:
// swipe right to confirm; swipe left to postpone or dismiss. Web retains visible button fallbacks.
//
// PUBLIC PROPS (new frozen contract, replaces the old per-alert onAction shape):
//   alerts      raw Alert[] — the component groups them into events itself
//   parcelName  optional resolver id → display name ('' when unknown)
//   onConfirm   ack every id of the event (fires haptics.success())
//   onSnooze    snooze ids for 1 | 3 | 7 days (duration is an explicit argument — no side channel)
//   onDismiss   dismiss every id of the event
import Ionicons from '@expo/vector-icons/Ionicons';
import { formatDistanceToNow, isValid, parseISO } from 'date-fns';
import { type ComponentProps, useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, StyleSheet, Text, View } from 'react-native';
import ReanimatedSwipeable, {
  type SwipeableMethods,
} from 'react-native-gesture-handler/ReanimatedSwipeable';

import type { Alert } from '@/api/types';
import { kindGlyph } from '@/components/glyphs';
import { GlyphBadge, InteractivePressable, MonoLabel, Pill } from '@/components/ui';
import { dfLocale } from '@/features/insights/format';
import { groupAlerts, type AlertEvent } from '@/features/insights/grouping';
import * as haptics from '@/lib/haptics';
import {
  alertStateTint,
  colors,
  fonts,
  radius,
  severityTint,
  spacing,
  statusColors,
  touch,
  type as typeScale,
} from '@/theme';

export interface AlertListProps {
  alerts: Alert[];
  parcelName?: (id: string | null) => string;
  onConfirm(ids: string[]): void;
  onSnooze(ids: string[], days: number): void;
  onDismiss(ids: string[]): void;
}

const SNOOZE_CHOICES = [1, 3, 7];

export default function AlertList({
  alerts,
  parcelName,
  onConfirm,
  onSnooze,
  onDismiss,
}: AlertListProps) {
  const events = useMemo(() => groupAlerts(alerts, parcelName), [alerts, parcelName]);
  const openRow = useRef<SwipeableMethods | null>(null);
  const handleWillOpen = useCallback((row: SwipeableMethods) => {
    if (openRow.current !== row) openRow.current?.close();
    openRow.current = row;
  }, []);
  const handleClose = useCallback((row: SwipeableMethods) => {
    if (openRow.current === row) openRow.current = null;
  }, []);

  return (
    <View style={styles.list}>
      {events.map((ev, index) => (
        <EventCard
          key={ev.key}
          event={ev}
          last={index === events.length - 1}
          onConfirm={onConfirm}
          onSnooze={onSnooze}
          onDismiss={onDismiss}
          onWillOpen={handleWillOpen}
          onClose={handleClose}
        />
      ))}
    </View>
  );
}

function EventCard({
  event,
  last,
  onConfirm,
  onSnooze,
  onDismiss,
  onWillOpen,
  onClose,
}: {
  event: AlertEvent;
  last: boolean;
  onConfirm: (ids: string[]) => void;
  onSnooze: (ids: string[], days: number) => void;
  onDismiss: (ids: string[]) => void;
  onWillOpen: (row: SwipeableMethods) => void;
  onClose: (row: SwipeableMethods) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [snoozing, setSnoozing] = useState(false);
  const swipeable = useRef<SwipeableMethods | null>(null);

  const sev = severityTint[event.severity] ?? severityTint.info;
  const actionableIds = event.alerts
    .filter((a) => a.state === 'open' || a.state === 'snoozed')
    .map((a) => a.id);
  const many = actionableIds.length > 1;

  const latest = parseISO(event.latestAt);
  const ago = isValid(latest)
    ? formatDistanceToNow(latest, { addSuffix: true, locale: dfLocale() })
    : '';
  // the raw-signal list matters whenever more than one alert was grouped (count counts plants)
  const manySignals = event.alerts.length > 1;
  const hasDetail = event.techDetail != null || manySignals;
  const allDismissed =
    actionableIds.length === 0 && event.alerts.every((a) => a.state === 'dismissed');

  const row = (
    <View style={[styles.row, !last && styles.rowDivider]}>
      <View style={styles.titleRow}>
        <GlyphBadge glyph={kindGlyph(event.kind)} fg={sev.fg} bg={sev.bg} size={36} />
        <View style={styles.titleContent}>
          <View style={styles.titleLine}>
            <Text style={styles.title} maxFontSizeMultiplier={typeScale.maxMult}>
              {t(event.titleKey, event.titleParams)}
            </Text>
            {event.count > 1 ? (
              <View style={[styles.countBadge, { backgroundColor: sev.bg }]}>
                <Text
                  style={[styles.countText, { color: sev.fg }]}
                  maxFontSizeMultiplier={typeScale.maxMult}
                >
                  {event.count}
                </Text>
              </View>
            ) : null}
          </View>
          {ago ? <MonoLabel style={styles.meta}>{ago}</MonoLabel> : null}
        </View>
        <Pill label={t(`severity.${event.severity}`)} fg={sev.fg} bg={sev.bg} />
      </View>

      <Text style={styles.body} numberOfLines={2} maxFontSizeMultiplier={typeScale.maxMult}>
        {t(event.bodyKey, event.bodyParams)}
      </Text>

      {/* jargon lives here: mono summary + the individual signals (docs/UX-REVAMP.md rule 7) */}
      {hasDetail ? (
        <>
          <InteractivePressable
            onPress={() => setExpanded((v) => !v)}
            style={styles.disclosure}
            hoverStyle={styles.disclosureHover}
            accessibilityState={{ expanded }}
            accessibilityLabel={
              expanded
                ? t('alerts_group.hide_detail', { defaultValue: 'Nascondi dettagli' })
                : t('alerts_group.show_detail')
            }
          >
            <Ionicons
              name={expanded ? 'chevron-up' : 'chevron-down'}
              size={16}
              color={colors.textMuted}
            />
            <Text style={styles.disclosureLabel} maxFontSizeMultiplier={typeScale.maxMult}>
              {expanded
                ? t('alerts_group.hide_detail', { defaultValue: 'Nascondi dettagli' })
                : t('alerts_group.show_detail')}
            </Text>
          </InteractivePressable>
          {expanded ? (
            <View style={styles.detail}>
              {event.techDetail ? (
                // mono data voice; wraps (MonoLabel is single-line by design)
                <Text style={styles.techDetail} maxFontSizeMultiplier={typeScale.maxMult}>
                  {event.techDetail}
                </Text>
              ) : null}
              {manySignals ? event.alerts.map((a) => <AlertRow key={a.id} alert={a} />) : null}
            </View>
          ) : null}
        </>
      ) : null}

      {Platform.OS === 'web' && actionableIds.length > 0 ? (
        <View style={styles.actions}>
          {snoozing ? (
            // "Altro" expanded: postpone choices + dismiss + back. Two taps for the
            // destructive-ish paths keeps the collapsed row down to TWO buttons.
            <>
              {SNOOZE_CHOICES.map((d) => (
                <ActionButton
                  key={d}
                  label={t(`alerts.snooze_${d}d`)}
                  onPress={() => {
                    setSnoozing(false);
                    onSnooze(actionableIds, d);
                  }}
                />
              ))}
              <ActionButton
                label={many ? t('alerts_group.dismiss_all') : t('alerts.dismiss')}
                onPress={() => {
                  setSnoozing(false);
                  onDismiss(actionableIds);
                }}
              />
              <ActionButton label={t('common.cancel')} onPress={() => setSnoozing(false)} />
            </>
          ) : (
            <>
              <ActionButton
                primary
                label={many ? t('alerts_group.confirm_all') : t('alerts.ack')}
                onPress={() => {
                  haptics.success();
                  onConfirm(actionableIds);
                }}
              />
              <ActionButton label={t('alerts_group.more')} onPress={() => setSnoozing(true)} />
            </>
          )}
        </View>
      ) : actionableIds.length === 0 ? (
        <View style={styles.footer}>
          {allDismissed ? (
            <Pill
              label={t('alerts.state.dismissed')}
              fg={alertStateTint.dismissed.fg}
              bg={alertStateTint.dismissed.bg}
            />
          ) : (
            <Pill
              label={t('alerts_group.checked')}
              fg={statusColors.healthy.fg}
              bg={statusColors.healthy.bg}
            />
          )}
        </View>
      ) : null}
    </View>
  );

  if (Platform.OS === 'web' || actionableIds.length === 0) return row;

  return (
    <ReanimatedSwipeable
      ref={swipeable}
      friction={1.35}
      leftThreshold={44}
      rightThreshold={58}
      dragOffsetFromLeftEdge={12}
      dragOffsetFromRightEdge={12}
      overshootLeft={false}
      overshootRight={false}
      overshootFriction={8}
      enableTrackpadTwoFingerGesture
      containerStyle={styles.swipeContainer}
      childrenContainerStyle={styles.swipeChildren}
      onSwipeableWillOpen={() => {
        if (swipeable.current) onWillOpen(swipeable.current);
      }}
      onSwipeableClose={() => {
        if (swipeable.current) onClose(swipeable.current);
      }}
      renderLeftActions={(_progress, _translation, methods) => (
        <SwipeAction
          icon="checkmark-circle-outline"
          label={many ? t('alerts_group.confirm_all') : t('alerts.ack')}
          backgroundColor={colors.primary}
          onPress={() => {
            methods.close();
            haptics.success();
            onConfirm(actionableIds);
          }}
        />
      )}
      renderRightActions={(_progress, _translation, methods) => (
        <View style={styles.swipeActions}>
          <SwipeAction
            icon="time-outline"
            label={`${t('alerts.snooze')}\n${t('alerts.snooze_3d')}`}
            backgroundColor={colors.warning}
            onPress={() => {
              methods.close();
              haptics.selection();
              onSnooze(actionableIds, 3);
            }}
          />
          <SwipeAction
            icon="eye-off-outline"
            label={many ? t('alerts_group.dismiss_all') : t('alerts.dismiss')}
            backgroundColor={colors.danger}
            onPress={() => {
              methods.close();
              haptics.warning();
              onDismiss(actionableIds);
            }}
          />
        </View>
      )}
    >
      {row}
    </ReanimatedSwipeable>
  );
}

function SwipeAction({
  icon,
  label,
  backgroundColor,
  onPress,
}: {
  icon: ComponentProps<typeof Ionicons>['name'];
  label: string;
  backgroundColor: string;
  onPress: () => void;
}) {
  return (
    <InteractivePressable
      onPress={onPress}
      accessibilityLabel={label}
      style={[styles.swipeAction, { backgroundColor }]}
      pressedStyle={styles.swipeActionPressed}
    >
      <Ionicons name={icon} size={22} color={colors.onPrimary} />
      <Text style={styles.swipeActionLabel} maxFontSizeMultiplier={typeScale.maxMult}>
        {label}
      </Text>
    </InteractivePressable>
  );
}

/** One raw signal inside the disclosure — technical audience, compact. */
function AlertRow({ alert }: { alert: Alert }) {
  const { t } = useTranslation();
  const state = alertStateTint[alert.state];
  return (
    <View style={styles.alertRow}>
      <View style={styles.alertRowHead}>
        <Text style={styles.alertRowTitle} maxFontSizeMultiplier={typeScale.maxMult}>
          {alert.title}
        </Text>
        {alert.state !== 'open' ? (
          <Pill label={t(`alerts.state.${alert.state}`)} fg={state.fg} bg={state.bg} />
        ) : null}
      </View>
      <Text style={styles.alertRowMessage} maxFontSizeMultiplier={typeScale.maxMult}>
        {alert.message}
      </Text>
    </View>
  );
}

function ActionButton({
  label,
  onPress,
  primary,
}: {
  label: string;
  onPress: () => void;
  primary?: boolean;
}) {
  if (primary) {
    return (
      <InteractivePressable
        onPress={onPress}
        style={[styles.action, styles.actionPrimary]}
        hoverStyle={styles.actionPrimaryHover}
      >
        <Text style={styles.actionTextPrimary} maxFontSizeMultiplier={typeScale.maxMult}>
          {label}
        </Text>
      </InteractivePressable>
    );
  }
  return (
    <InteractivePressable onPress={onPress} style={styles.action} hoverStyle={styles.actionHover}>
      <Text style={styles.actionText} maxFontSizeMultiplier={typeScale.maxMult}>
        {label}
      </Text>
    </InteractivePressable>
  );
}

const styles = StyleSheet.create({
  list: {
    borderRadius: radius.lg,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  swipeContainer: { backgroundColor: colors.card },
  swipeChildren: { backgroundColor: colors.card },
  swipeActions: { flexDirection: 'row' },
  swipeAction: {
    width: 92,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.xs,
  },
  swipeActionPressed: { transform: [{ scale: 0.96 }] },
  swipeActionLabel: {
    color: colors.onPrimary,
    fontFamily: fonts.bodyBold,
    fontSize: typeScale.caption,
    textAlign: 'center',
  },
  row: {
    backgroundColor: colors.card,
    padding: spacing.md,
  },
  rowDivider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  titleContent: { flex: 1, gap: 3 },
  titleLine: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  title: {
    flex: 1,
    fontFamily: fonts.bodySemiBold,
    fontSize: typeScale.bodyLg,
    lineHeight: 22,
    color: colors.text,
  },
  countBadge: {
    minWidth: 26,
    height: 26,
    borderRadius: 8,
    paddingHorizontal: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  countText: { fontFamily: fonts.monoSemiBold, fontSize: 13 },
  meta: {},
  body: {
    fontFamily: fonts.body,
    fontSize: typeScale.body,
    color: colors.textMuted,
    marginTop: 6,
    lineHeight: 20,
  },
  disclosure: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: spacing.sm,
    minHeight: touch.chip,
    paddingVertical: spacing.xs,
    alignSelf: 'flex-start',
    paddingRight: spacing.sm,
    borderRadius: radius.sm,
  },
  disclosureHover: { backgroundColor: colors.cardAlt },
  disclosureLabel: {
    fontFamily: fonts.bodySemiBold,
    fontSize: typeScale.caption,
    color: colors.textMuted,
  },
  detail: {
    marginTop: spacing.xs,
    borderRadius: radius.md,
    backgroundColor: colors.cardAlt,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    padding: spacing.sm,
    gap: spacing.xs,
  },
  techDetail: {
    fontFamily: fonts.mono,
    fontSize: typeScale.caption,
    letterSpacing: 0.4,
    color: colors.textMuted,
  },
  alertRow: {
    borderTopWidth: 1,
    borderTopColor: colors.borderSoft,
    paddingTop: spacing.xs,
    marginTop: spacing.xs,
    gap: 2,
  },
  alertRowHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  alertRowTitle: {
    flex: 1,
    fontFamily: fonts.bodySemiBold,
    fontSize: typeScale.caption,
    color: colors.text,
  },
  alertRowMessage: {
    fontFamily: fonts.body,
    fontSize: typeScale.caption,
    lineHeight: 17,
    color: colors.textMuted,
  },
  footer: { flexDirection: 'row', marginTop: spacing.sm },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.borderSoft,
    paddingTop: spacing.sm,
  },
  action: {
    flexGrow: 1,
    minHeight: touch.min,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  actionHover: { backgroundColor: colors.primarySoft, borderColor: colors.primary },
  actionPrimaryHover: { opacity: 0.9 },
  actionPrimary: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  actionText: { fontFamily: fonts.bodySemiBold, fontSize: typeScale.body, color: colors.primaryDark },
  actionTextPrimary: { fontFamily: fonts.bodyBold, fontSize: typeScale.body, color: colors.onPrimary },
});
