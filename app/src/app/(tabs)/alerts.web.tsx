// OWNER: web-insights — Campo web "Insights" inbox (portal screen 03). Renders inside the web
// (tabs)/_layout.web.tsx PortalShell (sidebar + scrollable, padded, max-width-1280 main), so this
// file is content only: header (counts/search/avatar), severity + state + parcel filters, a
// decision-support banner, and richer alert cards with optimistic ack/snooze/dismiss.
// Native alerts.tsx / AlertList are frozen to this agent; the tint maps and mutation shape are
// replicated here because the web cards are laid out differently.
import Ionicons from '@expo/vector-icons/Ionicons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow, parseISO } from 'date-fns';
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { TextStyle } from 'react-native';

import { api } from '@/api/client';
import type { Alert, AlertState, Parcel, Severity, User } from '@/api/types';
import type { AlertAction } from '@/components/types';
import { Dot, MonoValue, Pill, TintCard } from '@/components/ui';
import { dfLocale } from '@/features/insights/format';
import { readSnoozeDays, setSnoozeDays } from '@/features/insights/snooze';
import { colors, fonts, radius, severityColor, severityTint, spacing } from '@/theme';

type Me = { user: User };
type Segment = 'open' | 'snoozed' | 'resolved';
type SevFilter = 'all' | Severity;

const DAY_MS = 86_400_000;
const SNOOZE_CHOICES = [1, 3, 7] as const;
const ALERTS_ALL_KEY = ['alerts', 'all'] as const;

// Web-only reset: drop the default browser focus ring on the search input (the bordered
// container is the focus affordance). Not part of RN's TextStyle, so cast like the repo idiom.
const WEB_INPUT_RESET = { outlineStyle: 'none' } as unknown as TextStyle;

// State tints are web-card-local; severity tag/gradient tints come from the shared
// severityTint map in '@/theme' (dots use severityColor).
const STATE_TINT: Record<AlertState, { fg: string; bg: string }> = {
  open: { fg: colors.primary, bg: colors.primarySoft },
  acked: { fg: colors.textMuted, bg: colors.borderSoft },
  snoozed: { fg: '#5B8F8A', bg: '#E5EEED' },
  dismissed: { fg: colors.textFaint, bg: colors.borderSoft },
};

// Short filter-chip labels (the card severity tag reuses the longer severity.* keys instead).
const SEV_FILTERS: { key: Severity; labelKey: string; fallback: string }[] = [
  { key: 'critical', labelKey: 'alerts.sev_critical', fallback: 'High' },
  { key: 'warning', labelKey: 'alerts.sev_warning', fallback: 'Medium' },
  { key: 'info', labelKey: 'alerts.sev_info', fallback: 'Info' },
];

const SEGMENTS: { key: Segment; labelKey: string; fallback: string }[] = [
  { key: 'open', labelKey: 'alerts.filter_open', fallback: 'Open' },
  { key: 'snoozed', labelKey: 'alerts.state.snoozed', fallback: 'Snoozed' },
  { key: 'resolved', labelKey: 'alerts.seg_resolved', fallback: 'Resolved' },
];

function matchesSegment(state: AlertState, segment: Segment): boolean {
  if (segment === 'open') return state === 'open';
  if (segment === 'snoozed') return state === 'snoozed';
  return state === 'acked' || state === 'dismissed'; // resolved
}

export default function AlertsWebScreen() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const router = useRouter();

  const [sevFilter, setSevFilter] = useState<SevFilter>('all');
  const [segment, setSegment] = useState<Segment>('open');
  const [parcelFilter, setParcelFilter] = useState<string>('all');
  const [parcelMenu, setParcelMenu] = useState(false);
  const [query, setQuery] = useState('');

  const me = useQuery({ queryKey: ['auth', 'me'], queryFn: () => api.get<Me>('/auth/me') });
  const parcels = useQuery({ queryKey: ['parcels'], queryFn: () => api.get<Parcel[]>('/parcels') });
  const alertsQ = useQuery({ queryKey: ALERTS_ALL_KEY, queryFn: () => api.get<Alert[]>('/alerts') });

  const parcelList = parcels.data ?? [];
  const parcelNames = useMemo(() => {
    const m: Record<string, string> = {};
    for (const p of parcelList) m[p.id] = p.name;
    return m;
  }, [parcelList]);

  const allAlerts = useMemo(() => alertsQ.data ?? [], [alertsQ.data]);

  // Header metrics: open count, "new" = open created <24h, most-recent update for "updated … ago".
  const openCount = allAlerts.filter((a) => a.state === 'open').length;
  const newCount = allAlerts.filter(
    (a) => a.state === 'open' && Date.now() - new Date(a.created_at).getTime() < DAY_MS,
  ).length;
  const lastUpdated = allAlerts.reduce<string | null>(
    (acc, a) => (acc == null || a.updated_at > acc ? a.updated_at : acc),
    null,
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return allAlerts.filter((a) => {
      if (!matchesSegment(a.state, segment)) return false;
      if (sevFilter !== 'all' && a.severity !== sevFilter) return false;
      if (parcelFilter !== 'all' && a.parcel_id !== parcelFilter) return false;
      if (q) {
        const pName = a.parcel_id ? parcelNames[a.parcel_id] ?? '' : '';
        const hay = `${a.title} ${a.message} ${pName}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [allAlerts, segment, sevFilter, parcelFilter, query, parcelNames]);

  const mutation = useMutation({
    mutationFn: ({ id, action }: { id: string; action: AlertAction }) => {
      if (action === 'ack') return api.post<Alert>(`/alerts/${id}/ack`);
      if (action === 'dismiss') return api.post<Alert>(`/alerts/${id}/dismiss`);
      const until = new Date(Date.now() + readSnoozeDays() * DAY_MS).toISOString();
      return api.post<Alert>(`/alerts/${id}/snooze`, { until });
    },
    // Optimistic on the shared ['alerts','all'] cache: flip state in place (the client-side
    // segment filter then relocates the card). Invalidate the whole ['alerts'] family on settle.
    onMutate: async ({ id, action }) => {
      await qc.cancelQueries({ queryKey: ['alerts'] });
      const prev = qc.getQueryData<Alert[]>(ALERTS_ALL_KEY);
      if (prev) {
        const nextState: AlertState =
          action === 'ack' ? 'acked' : action === 'dismiss' ? 'dismissed' : 'snoozed';
        qc.setQueryData<Alert[]>(
          ALERTS_ALL_KEY,
          prev.map((a) => (a.id === id ? { ...a, state: nextState } : a)),
        );
      }
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(ALERTS_ALL_KEY, ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['alerts'] }),
  });

  const initials = (me.data?.user.full_name ?? '—')
    .split(' ')
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();

  const subtitle =
    t('alerts.header_meta', { open: openCount, fresh: newCount }) +
    (lastUpdated
      ? ` · ${t('alerts.updated', {
          defaultValue: 'updated {{ago}}',
          ago: formatDistanceToNow(parseISO(lastUpdated), { addSuffix: true, locale: dfLocale() }),
        })}`
      : '');

  const parcelLabel =
    parcelFilter === 'all'
      ? t('alerts.all_parcels', { defaultValue: 'All parcels' })
      : parcelNames[parcelFilter] ?? t('alerts.all_parcels', { defaultValue: 'All parcels' });

  return (
    <View style={styles.root}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.flex1}>
          <Text style={styles.h1}>{t('alerts.title')}</Text>
          <Text style={styles.subtitle}>{subtitle}</Text>
        </View>
        <View style={styles.headerRight}>
          <View style={styles.search}>
            <Ionicons name="search-outline" size={15} color={colors.textFaint} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder={t('alerts.search_placeholder', { defaultValue: 'Search insights' })}
              placeholderTextColor={colors.textFaint}
              style={[styles.searchInput, WEB_INPUT_RESET]}
            />
          </View>
          {/* Non-functional placeholder (alert rules are a later feature) */}
          <View style={styles.rulesBtn}>
            <Text style={styles.rulesBtnText}>
              {t('alerts.alert_rules', { defaultValue: 'Alert rules' })}
            </Text>
          </View>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{initials}</Text>
          </View>
        </View>
      </View>

      {/* Filters */}
      <View style={styles.filterRow}>
        <View style={styles.chips}>
          <SeverityChip
            label={t('alerts.filter_all')}
            active={sevFilter === 'all'}
            onPress={() => setSevFilter('all')}
          />
          {SEV_FILTERS.map((s) => (
            <SeverityChip
              key={s.key}
              label={t(s.labelKey, { defaultValue: s.fallback })}
              dotColor={severityColor[s.key]}
              active={sevFilter === s.key}
              onPress={() => setSevFilter(s.key)}
            />
          ))}
        </View>

        <View style={styles.filterRight}>
          <View style={styles.segment}>
            {SEGMENTS.map((s) => {
              const active = segment === s.key;
              return (
                <Pressable
                  key={s.key}
                  onPress={() => setSegment(s.key)}
                  style={[styles.segBtn, active && styles.segBtnActive]}
                >
                  <Text style={[styles.segText, active && styles.segTextActive]}>
                    {t(s.labelKey, { defaultValue: s.fallback })}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <View style={styles.parcelWrap}>
            <Pressable style={styles.parcelTrigger} onPress={() => setParcelMenu((o) => !o)}>
              <Text style={styles.parcelTriggerText} numberOfLines={1}>
                {parcelLabel}
              </Text>
              <Text style={styles.caret}>▾</Text>
            </Pressable>
            {parcelMenu ? (
              <View style={styles.parcelMenu}>
                <Pressable
                  style={styles.parcelItem}
                  onPress={() => {
                    setParcelFilter('all');
                    setParcelMenu(false);
                  }}
                >
                  <Text style={styles.parcelItemText}>
                    {t('alerts.all_parcels', { defaultValue: 'All parcels' })}
                  </Text>
                </Pressable>
                {parcelList.map((p) => (
                  <Pressable
                    key={p.id}
                    style={styles.parcelItem}
                    onPress={() => {
                      setParcelFilter(p.id);
                      setParcelMenu(false);
                    }}
                  >
                    <Text style={styles.parcelItemText} numberOfLines={1}>
                      {p.name}
                    </Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
          </View>
        </View>
      </View>

      {/* Decision-support banner */}
      <View style={styles.banner}>
        <Ionicons name="information-circle-outline" size={17} color={colors.primary} />
        <Text style={styles.bannerText}>{t('common.decision_support')}</Text>
      </View>

      {/* List */}
      {alertsQ.isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : filtered.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.emptyText}>
            {allAlerts.length === 0
              ? t('alerts.empty')
              : t('alerts.empty_filtered', { defaultValue: 'No insights match your filters.' })}
          </Text>
        </View>
      ) : (
        <View style={styles.list}>
          {filtered.map((a) => (
            <AlertCard
              key={a.id}
              alert={a}
              parcelName={a.parcel_id ? parcelNames[a.parcel_id] : undefined}
              onAction={(action) => mutation.mutate({ id: a.id, action })}
              onOpenParcel={() => a.parcel_id && router.push(`/parcel/${a.parcel_id}`)}
            />
          ))}
        </View>
      )}
    </View>
  );
}

function SeverityChip({
  label,
  active,
  onPress,
  dotColor,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  dotColor?: string;
}) {
  return (
    <Pressable onPress={onPress} style={[styles.chip, active && styles.chipActive]}>
      {dotColor ? <Dot color={dotColor} size={7} /> : null}
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </Pressable>
  );
}

function AlertCard({
  alert,
  parcelName,
  onAction,
  onOpenParcel,
}: {
  alert: Alert;
  parcelName?: string;
  onAction: (action: AlertAction) => void;
  onOpenParcel: () => void;
}) {
  const { t } = useTranslation();
  const [snoozeOpen, setSnoozeOpen] = useState(false);

  const sev = severityTint[alert.severity] ?? severityTint.info;
  const state = STATE_TINT[alert.state];
  const actionable = alert.state === 'open' || alert.state === 'snoozed';
  const dimmed = alert.state === 'acked' || alert.state === 'dismissed';
  const ago = formatDistanceToNow(parseISO(alert.created_at), {
    addSuffix: true,
    locale: dfLocale(),
  });
  const stateLabel =
    alert.state === 'open' ? t('alerts.new', { defaultValue: 'New' }) : t(`alerts.state.${alert.state}`);

  return (
    <TintCard tint={sev.bg} style={[styles.card, dimmed && styles.cardDim]}>
      <View style={styles.cardTop}>
        <View style={styles.flex1}>
          <View style={styles.titleRow}>
            <Dot color={severityColor[alert.severity] ?? colors.info} size={9} />
            <Text style={styles.title} numberOfLines={2}>
              {alert.title}
            </Text>
            <View style={[styles.sevTag, { backgroundColor: sev.bg }]}>
              <Text style={[styles.sevTagText, { color: sev.fg }]}>{t(`severity.${alert.severity}`)}</Text>
            </View>
          </View>
          <MonoValue size={11} weight="500" color={colors.textFaint} style={styles.meta}>
            {[parcelName, ago].filter(Boolean).join(' · ')}
          </MonoValue>
          <Text style={styles.message}>{alert.message}</Text>
        </View>
        <Pill label={stateLabel} fg={state.fg} bg={state.bg} />
      </View>

      {actionable ? (
        <View style={styles.actions}>
          {snoozeOpen ? (
            <>
              {SNOOZE_CHOICES.map((d) => (
                <ActionButton
                  key={d}
                  label={t(`alerts.snooze_${d}d`)}
                  onPress={() => {
                    setSnoozeDays(d);
                    onAction('snooze');
                    setSnoozeOpen(false);
                  }}
                />
              ))}
              <ActionButton label={t('common.cancel')} onPress={() => setSnoozeOpen(false)} />
            </>
          ) : (
            <>
              <ActionButton label={t('alerts.ack')} variant="primary" onPress={() => onAction('ack')} />
              <ActionButton label={t('alerts.snooze')} onPress={() => setSnoozeOpen(true)} />
              <ActionButton label={t('alerts.dismiss')} onPress={() => onAction('dismiss')} />
            </>
          )}
          {alert.parcel_id ? (
            <Pressable onPress={onOpenParcel} hitSlop={6} style={styles.openLinkWrap}>
              <Text style={styles.openLink}>{t('alerts.open_parcel')} →</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </TintCard>
  );
}

function ActionButton({
  label,
  onPress,
  variant = 'default',
}: {
  label: string;
  onPress: () => void;
  variant?: 'default' | 'primary';
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.actionBtn,
        variant === 'primary' ? styles.actionBtnPrimary : styles.actionBtnDefault,
        pressed && styles.pressed,
      ]}
    >
      <Text
        style={[
          styles.actionText,
          variant === 'primary' ? styles.actionTextPrimary : styles.actionTextDefault,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { gap: spacing.md },
  flex1: { flex: 1, minWidth: 0 },

  // Header
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  h1: { fontSize: 22, fontWeight: '700', color: colors.text, letterSpacing: -0.3 },
  subtitle: { fontSize: 12.5, color: colors.textFaint, marginTop: 2 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    height: 34,
    minWidth: 190,
    paddingHorizontal: spacing.sm + 2,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
  },
  searchInput: { flex: 1, fontSize: 13, color: colors.text },
  rulesBtn: {
    height: 34,
    justifyContent: 'center',
    paddingHorizontal: spacing.sm + 4,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
  },
  rulesBtnText: { fontSize: 12.5, fontWeight: '600', color: colors.textMuted },
  avatar: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { fontSize: 12.5, fontWeight: '700', color: colors.primary },

  // Filters
  filterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: spacing.sm,
    zIndex: 10, // keep the parcel dropdown above the cards
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, alignItems: 'center' },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 13,
    paddingVertical: 6,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 12, fontWeight: '600', color: colors.textMuted },
  chipTextActive: { color: colors.onPrimary },

  filterRight: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  segment: {
    flexDirection: 'row',
    gap: 2,
    backgroundColor: colors.borderSoft,
    borderRadius: radius.md,
    padding: 3,
  },
  segBtn: { paddingHorizontal: spacing.md - 4, paddingVertical: 5, borderRadius: radius.sm },
  segBtnActive: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  segText: { fontSize: 12, fontWeight: '600', color: colors.textMuted },
  segTextActive: { color: colors.text },

  parcelWrap: { position: 'relative', zIndex: 20 },
  parcelTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    maxWidth: 200,
    paddingHorizontal: spacing.sm + 4,
    paddingVertical: 7,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
  },
  parcelTriggerText: { flexShrink: 1, fontSize: 12.5, color: colors.textMuted },
  caret: { fontSize: 12, color: colors.textFaint },
  parcelMenu: {
    position: 'absolute',
    top: 40,
    right: 0,
    minWidth: 190,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingVertical: spacing.xs,
    gap: 1,
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
  parcelItem: { paddingHorizontal: spacing.sm + 4, paddingVertical: 7, borderRadius: radius.sm },
  parcelItemText: { fontSize: 12.5, color: colors.text },

  // Banner
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm + 2,
    backgroundColor: colors.primarySoft,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
  },
  bannerText: { flex: 1, fontSize: 12.5, color: colors.primaryDark, lineHeight: 18 },

  // List
  list: { gap: spacing.sm },
  center: { alignItems: 'center', justifyContent: 'center', paddingVertical: spacing.xl * 2 },
  emptyText: { fontSize: 14, color: colors.textMuted },

  card: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: spacing.md,
  },
  cardDim: { opacity: 0.65 },
  cardTop: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  title: { flexShrink: 1, fontSize: 15, fontWeight: '700', color: colors.text },
  sevTag: { borderRadius: radius.sm - 2, paddingHorizontal: 7, paddingVertical: 2 },
  sevTagText: {
    fontFamily: fonts.mono,
    fontSize: 9.5,
    fontWeight: '700',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  meta: { marginTop: 6 },
  message: { fontSize: 13, color: colors.textMuted, lineHeight: 19, marginTop: 8, maxWidth: 640 },

  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.md - 2,
  },
  actionBtn: {
    height: 30,
    justifyContent: 'center',
    paddingHorizontal: spacing.sm + 4,
    borderRadius: radius.sm,
    borderWidth: 1,
  },
  actionBtnPrimary: { backgroundColor: colors.primarySoft, borderColor: colors.primarySoft },
  actionBtnDefault: { backgroundColor: colors.card, borderColor: colors.border },
  pressed: { opacity: 0.6 },
  actionText: { fontSize: 12, fontWeight: '600' },
  actionTextPrimary: { color: colors.primaryDark },
  actionTextDefault: { color: colors.textMuted },
  openLinkWrap: { marginLeft: 'auto' },
  openLink: { fontSize: 12.5, fontWeight: '600', color: colors.primary },
});
