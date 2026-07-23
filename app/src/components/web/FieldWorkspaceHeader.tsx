import Ionicons from '@expo/vector-icons/Ionicons';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { format, parseISO } from 'date-fns';
import { useRouter } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Linking, ScrollView, StyleSheet, Text, View } from 'react-native';

import { API_URL } from '@/api/client';
import type { Parcel } from '@/api/types';
import { InteractivePressable, MonoLabel } from '@/components/ui';
import { useOutsideDismiss } from '@/components/useOutsideDismiss';
import FieldViewSwitcher from '@/components/web/FieldViewSwitcher';
import { cropLabel, dfLocale } from '@/features/insights/format';
import { useMediaToken } from '@/features/media';
import { formatArea } from '@/features/parcels/crops';
import { notify } from '@/features/parcels/dialog';
import { useIndexSeries, useParcels } from '@/features/parcels/hooks';
import { useCaptures } from '@/features/plants/hooks';
import { colors, fonts, radius, spacing } from '@/theme';

type FieldView = 'overview' | 'plants';

/** Stable field-workspace chrome shared by Overview and Plants. */
export default function FieldWorkspaceHeader({
  parcel,
  active,
}: {
  parcel: Parcel;
  active: FieldView;
}) {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const mediaToken = useMediaToken();
  const locale = dfLocale();
  const parcelsQ = useParcels();
  const satelliteSeriesQ = useIndexSeries(parcel.id, 'ndvi');
  const capturesQ = useCaptures(parcel.id, { status: 'extracted', limit: 1 });
  const parcels = useMemo(
    () => (parcelsQ.data ?? []).filter((item) => !item.archived),
    [parcelsQ.data],
  );
  const [fieldOpen, setFieldOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const fieldMenuRef = useRef<View | null>(null);
  const newMenuRef = useRef<View | null>(null);
  const closeFieldMenu = useCallback(() => setFieldOpen(false), [setFieldOpen]);
  const closeNewMenu = useCallback(() => setNewOpen(false), [setNewOpen]);
  useOutsideDismiss(fieldMenuRef, fieldOpen, closeFieldMenu);
  useOutsideDismiss(newMenuRef, newOpen, closeNewMenu);

  const meta = [cropLabel(parcel.crop), parcel.variety, formatArea(parcel.area_ha)]
    .filter(Boolean)
    .join(' · ');
  const satelliteObservedAt = [...(satelliteSeriesQ.data?.series ?? [])]
    .reverse()
    .find((point) => point.source !== 'drone')?.observed_at;
  const droneObservedAt = capturesQ.data?.[0]?.captured_at;
  const satelliteDate = satelliteObservedAt
    ? format(parseISO(satelliteObservedAt), 'd MMM', { locale })
    : '—';
  const droneDate = droneObservedAt
    ? format(parseISO(droneObservedAt), 'd MMM', { locale })
    : '—';

  function selectField(parcelId: string) {
    setFieldOpen(false);
    if (parcelId === parcel.id) return;
    if (active === 'plants') {
      router.replace({ pathname: '/plants', params: { parcelId } });
    } else {
      router.replace(`/parcel/${parcelId}`);
    }
  }

  function runAction(action: 'note' | 'flight' | 'report') {
    setNewOpen(false);
    if (action === 'note') {
      router.push({ pathname: '/observation/new', params: { parcelId: parcel.id } });
      return;
    }
    if (action === 'flight') {
      router.push({ pathname: '/capture/new', params: { parcelId: parcel.id } });
      return;
    }
    if (!mediaToken) {
      notify(t('parcel.report'), t('parcel.report_error'));
      return;
    }
    const url = `${API_URL}/api/v1/reports/parcels/${parcel.id}/season?lang=${i18n.language}&token=${mediaToken}`;
    Linking.openURL(url).catch(() => notify(t('parcel.report'), t('parcel.report_error')));
  }

  return (
    <View style={styles.root}>
      <View style={styles.mainRow}>
        <View ref={fieldMenuRef} style={styles.fieldPickerWrap}>
          <InteractivePressable
            style={styles.fieldPickerTrigger}
            hoverStyle={styles.fieldPickerHover}
            accessibilityLabel={t('fields.select_field')}
            accessibilityState={{ expanded: fieldOpen }}
            onPress={() => {
              setNewOpen(false);
              setFieldOpen((value) => !value);
            }}
          >
            <View style={styles.fieldPickerText}>
              <Text style={styles.title} numberOfLines={1}>{parcel.name}</Text>
              <Text style={styles.meta} numberOfLines={1}>{meta}</Text>
              <View style={styles.latestDataRow}>
                <Text style={styles.latestDataLabel}>{t('fields.latest_data')}:</Text>
                <View
                  style={styles.latestDataSource}
                  accessibilityLabel={`${t('fields.satellite_data')}: ${satelliteDate}`}
                >
                  <MaterialCommunityIcons
                    name="satellite-variant"
                    size={12}
                    color={colors.textMuted}
                  />
                  <Text style={styles.latestDataValue}>{satelliteDate}</Text>
                </View>
                <View style={styles.latestDataDivider} />
                <View
                  style={styles.latestDataSource}
                  accessibilityLabel={`${t('fields.drone_data')}: ${droneDate}`}
                >
                  <MaterialCommunityIcons name="drone" size={13} color={colors.textMuted} />
                  <Text style={styles.latestDataValue}>{droneDate}</Text>
                </View>
              </View>
            </View>
            <Ionicons
              name={fieldOpen ? 'chevron-up' : 'chevron-down'}
              size={17}
              color={colors.primary}
            />
          </InteractivePressable>
          {fieldOpen ? (
            <ScrollView style={styles.menu} contentContainerStyle={styles.menuContent}>
              {parcels.map((item) => {
                const selected = item.id === parcel.id;
                return (
                  <InteractivePressable
                    key={item.id}
                    style={[styles.menuItem, selected && styles.menuItemActive]}
                    hoverStyle={!selected ? styles.menuItemHover : undefined}
                    onPress={() => selectField(item.id)}
                  >
                    <View style={styles.menuItemText}>
                      <Text
                        style={[styles.menuItemName, selected && styles.menuItemNameActive]}
                        numberOfLines={1}
                      >
                        {item.name}
                      </Text>
                      <MonoLabel size={9}>
                        {[cropLabel(item.crop), formatArea(item.area_ha)]
                          .filter(Boolean)
                          .join(' · ')}
                      </MonoLabel>
                    </View>
                    {selected ? (
                      <Ionicons name="checkmark" size={16} color={colors.primary} />
                    ) : null}
                  </InteractivePressable>
                );
              })}
            </ScrollView>
          ) : null}
        </View>

        <View style={styles.headerTools}>
          <View style={styles.headerActionRow}>
            <View ref={newMenuRef} style={styles.newMenuWrap}>
              <InteractivePressable
                style={styles.newTrigger}
                hoverStyle={styles.newTriggerHover}
                accessibilityState={{ expanded: newOpen }}
                onPress={() => {
                  setFieldOpen(false);
                  setNewOpen((value) => !value);
                }}
              >
                <Ionicons name="add" size={16} color={colors.onPrimary} />
                <Text style={styles.newTriggerText}>{t('fields.new_action')}</Text>
                <Ionicons
                  name={newOpen ? 'chevron-up' : 'chevron-down'}
                  size={14}
                  color={colors.onPrimary}
                />
              </InteractivePressable>
              {newOpen ? (
                <View style={styles.actionMenu}>
                  <ActionMenuItem
                    icon="create-outline"
                    label={t('parcel.record_note')}
                    onPress={() => runAction('note')}
                  />
                  <ActionMenuItem
                    icon="drone"
                    label={t('plants.empty_cta')}
                    onPress={() => runAction('flight')}
                  />
                  <ActionMenuItem
                    icon="document-text-outline"
                    label={t('parcel.export_report')}
                    onPress={() => runAction('report')}
                  />
                </View>
              ) : null}
            </View>

            <FieldViewSwitcher parcelId={parcel.id} active={active} />
          </View>
        </View>
      </View>
    </View>
  );
}

function ActionMenuItem({
  icon,
  label,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap | 'drone';
  label: string;
  onPress: () => void;
}) {
  return (
    <InteractivePressable style={styles.actionMenuItem} hoverStyle={styles.menuItemHover} onPress={onPress}>
      <View style={styles.actionMenuIcon}>
        {icon === 'drone' ? (
          <MaterialCommunityIcons name="drone" size={17} color={colors.primary} />
        ) : (
          <Ionicons name={icon} size={15} color={colors.primary} />
        )}
      </View>
      <Text style={styles.actionMenuText}>{label}</Text>
      <Ionicons name="chevron-forward" size={14} color={colors.textFaint} />
    </InteractivePressable>
  );
}

const styles = StyleSheet.create({
  root: {
    flexShrink: 0,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    zIndex: 50,
  },
  mainRow: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-start',
    gap: spacing.md,
    zIndex: 60,
  },
  fieldPickerWrap: {
    width: 280,
    position: 'relative',
    zIndex: 60,
  },
  fieldPickerTrigger: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.md,
  },
  fieldPickerHover: { backgroundColor: colors.cardAlt },
  fieldPickerText: { flex: 1, minWidth: 0 },
  title: {
    fontFamily: fonts.displayBold,
    fontSize: 28,
    color: colors.text,
    letterSpacing: -0.5,
  },
  meta: { marginTop: 2, fontFamily: fonts.body, fontSize: 12.5, color: colors.textMuted },
  menu: {
    position: 'absolute',
    top: 68,
    left: 0,
    width: 300,
    maxHeight: 340,
    marginTop: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    shadowColor: '#000',
    shadowOpacity: 0.14,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  menuContent: { padding: spacing.xs, gap: 2 },
  menuItem: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    borderRadius: radius.sm,
  },
  menuItemActive: { backgroundColor: colors.primarySoft },
  menuItemHover: { backgroundColor: colors.cardAlt },
  menuItemText: { flex: 1, minWidth: 0 },
  menuItemName: { fontFamily: fonts.bodyMedium, fontSize: 12.5, color: colors.text },
  menuItemNameActive: { fontFamily: fonts.bodySemiBold, color: colors.primary },
  headerTools: {
    marginLeft: 'auto',
    alignItems: 'center',
    zIndex: 1,
  },
  headerActionRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  latestDataRow: { minHeight: 15, marginTop: 2, flexDirection: 'row', alignItems: 'center', gap: 5 },
  latestDataLabel: { fontFamily: fonts.bodyMedium, fontSize: 10.5, color: colors.textFaint },
  latestDataSource: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  latestDataValue: { fontFamily: fonts.monoSemiBold, fontSize: 10, color: colors.textMuted },
  latestDataDivider: { width: 1, height: 10, backgroundColor: colors.border },
  newMenuWrap: { position: 'relative', zIndex: 70 },
  newTrigger: {
    minHeight: 38,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.primary,
  },
  newTriggerHover: { backgroundColor: colors.primaryDark },
  newTriggerText: { fontSize: 13, fontFamily: fonts.bodyBold, color: colors.onPrimary },
  actionMenu: {
    position: 'absolute',
    top: 46,
    right: 0,
    width: 238,
    padding: spacing.xs,
    gap: 2,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    shadowColor: '#000',
    shadowOpacity: 0.14,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  actionMenuItem: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    borderRadius: radius.sm,
  },
  actionMenuIcon: {
    width: 28,
    height: 28,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primarySoft,
  },
  actionMenuText: { flex: 1, fontSize: 12.5, fontFamily: fonts.bodySemiBold, color: colors.text },
});
