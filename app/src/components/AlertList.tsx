// OWNER: alert-grouping — grouped alert-event cards (docs/UX-REVAMP.md). Renders AlertEvents
// from features/insights/grouping.ts: plain-language Fraunces title, parcel + relative time
// meta, plain body, count badge, a "Dettagli tecnici" disclosure hiding the mono summary and
// the individual alerts, and bulk actions ≥44pt (Conferma / Posponi 1g·3g·7g / Ignora).
//
// PUBLIC PROPS (new frozen contract, replaces the old per-alert onAction shape):
//   alerts      raw Alert[] — the component groups them into events itself
//   parcelName  optional resolver id → display name ('' when unknown)
//   onConfirm   ack every id of the event (fires haptics.success())
//   onSnooze    snooze ids for 1 | 3 | 7 days (duration is an explicit argument — no side channel)
//   onDismiss   dismiss every id of the event
import Ionicons from '@expo/vector-icons/Ionicons';
import { formatDistanceToNow, isValid, parseISO } from 'date-fns';
import { LinearGradient } from 'expo-linear-gradient';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, Text, View } from 'react-native';

import type { Alert } from '@/api/types';
import { kindGlyph } from '@/components/glyphs';
import { GlyphBadge, InteractivePressable, MonoLabel, Pill, TintCard } from '@/components/ui';
import { dfLocale } from '@/features/insights/format';
import { groupAlerts, type AlertEvent } from '@/features/insights/grouping';
import * as haptics from '@/lib/haptics';
import {
  alertStateTint,
  colors,
  fonts,
  gradients,
  radius,
  severityGradient,
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
  return (
    <View style={styles.list}>
      {events.map((ev) => (
        <EventCard
          key={ev.key}
          event={ev}
          onConfirm={onConfirm}
          onSnooze={onSnooze}
          onDismiss={onDismiss}
        />
      ))}
    </View>
  );
}

function EventCard({
  event,
  onConfirm,
  onSnooze,
  onDismiss,
}: {
  event: AlertEvent;
  onConfirm: (ids: string[]) => void;
  onSnooze: (ids: string[], days: number) => void;
  onDismiss: (ids: string[]) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [snoozing, setSnoozing] = useState(false);

  const sev = severityTint[event.severity] ?? severityTint.info;
  const actionableIds = event.alerts
    .filter((a) => a.state === 'open' || a.state === 'snoozed')
    .map((a) => a.id);
  const many = actionableIds.length > 1;

  const parcel = typeof event.titleParams.parcel === 'string' ? event.titleParams.parcel : '';
  const latest = parseISO(event.latestAt);
  const ago = isValid(latest)
    ? formatDistanceToNow(latest, { addSuffix: true, locale: dfLocale() })
    : '';
  // the raw-signal list matters whenever more than one alert was grouped (count counts plants)
  const manySignals = event.alerts.length > 1;
  const hasDetail = event.techDetail != null || manySignals;
  const allDismissed =
    actionableIds.length === 0 && event.alerts.every((a) => a.state === 'dismissed');

  return (
    <TintCard gradient={severityGradient(event.severity)} style={styles.card}>
      <View style={styles.titleRow}>
        <GlyphBadge glyph={kindGlyph(event.kind)} fg={sev.fg} bg={sev.bg} size={28} />
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
        <Pill label={t(`severity.${event.severity}`)} fg={sev.fg} bg={sev.bg} />
      </View>

      <MonoLabel style={styles.meta}>{[parcel, ago].filter(Boolean).join(' · ')}</MonoLabel>

      <Text style={styles.body} maxFontSizeMultiplier={typeScale.maxMult}>
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

      {actionableIds.length > 0 ? (
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
      ) : (
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
      )}
    </TintCard>
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
        style={styles.actionPrimaryWrap}
        hoverStyle={styles.actionPrimaryHover}
      >
        <LinearGradient
          colors={gradients.forest}
          start={{ x: 0, y: 0 }}
          end={{ x: 0.9, y: 1 }}
          style={styles.actionPrimary}
        >
          <Text style={styles.actionTextPrimary} maxFontSizeMultiplier={typeScale.maxMult}>
            {label}
          </Text>
        </LinearGradient>
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
  list: { gap: spacing.sm },
  card: {
    borderRadius: radius.lg,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  title: {
    flex: 1,
    fontFamily: fonts.display,
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
  meta: { marginTop: 6 },
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
  actionPrimaryWrap: { flexGrow: 1, borderRadius: radius.lg },
  actionPrimaryHover: { opacity: 0.9 },
  actionPrimary: {
    minHeight: touch.min,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.lg,
  },
  actionText: { fontFamily: fonts.bodySemiBold, fontSize: typeScale.body, color: colors.primaryDark },
  actionTextPrimary: { fontFamily: fonts.bodyBold, fontSize: typeScale.body, color: colors.onPrimary },
});
