import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import type { Parcel } from '@/api/types';
import { InteractivePressable, MonoLabel } from '@/components/ui';
import { useOutsideDismiss } from '@/components/useOutsideDismiss';
import FieldViewSwitcher from '@/components/web/FieldViewSwitcher';
import { cropLabel } from '@/features/insights/format';
import { formatArea } from '@/features/parcels/crops';
import { useParcels } from '@/features/parcels/hooks';
import { colors, fonts, radius, spacing } from '@/theme';

type FieldView = 'overview' | 'plants';

/** Stable field-workspace chrome shared by Overview and Plants. */
export default function FieldWorkspaceHeader({
  parcel,
  active,
  actions,
}: {
  parcel: Parcel;
  active: FieldView;
  actions?: ReactNode;
}) {
  const { t } = useTranslation();
  const router = useRouter();
  const parcelsQ = useParcels();
  const parcels = useMemo(
    () => (parcelsQ.data ?? []).filter((item) => !item.archived),
    [parcelsQ.data],
  );
  const [open, setOpen] = useState(false);
  const menuRef = useRef<View | null>(null);
  const close = useCallback(() => setOpen(false), []);
  useOutsideDismiss(menuRef, open, close);

  const meta = [cropLabel(parcel.crop), parcel.variety, formatArea(parcel.area_ha)]
    .filter(Boolean)
    .join(' · ');

  function selectField(parcelId: string) {
    setOpen(false);
    if (parcelId === parcel.id) return;
    if (active === 'plants') {
      router.replace({ pathname: '/plants', params: { parcelId } });
    } else {
      router.replace(`/parcel/${parcelId}`);
    }
  }

  return (
    <View style={styles.root}>
      <View style={styles.topRow}>
        <View style={styles.titleBlock}>
          <MonoLabel size={10}>{t('fields.field_workspace')}</MonoLabel>
          <Text style={styles.title} numberOfLines={1}>{parcel.name}</Text>
          <Text style={styles.meta} numberOfLines={1}>{meta}</Text>
        </View>
      </View>

      <View style={styles.bottomRow}>
        <FieldViewSwitcher parcelId={parcel.id} active={active} />
        <View style={styles.bottomControls}>
          <View ref={menuRef} style={styles.selectWrap}>
            <InteractivePressable
              style={styles.selectTrigger}
              hoverStyle={styles.selectTriggerHover}
              accessibilityLabel={t('fields.select_field')}
              accessibilityState={{ expanded: open }}
              onPress={() => setOpen((value) => !value)}
            >
              <Ionicons name="leaf-outline" size={15} color={colors.primary} />
              <Text style={styles.selectText} numberOfLines={1}>{parcel.name}</Text>
              <Ionicons
                name={open ? 'chevron-up' : 'chevron-down'}
                size={14}
                color={colors.textFaint}
              />
            </InteractivePressable>
            {open ? (
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
          <View style={styles.actions}>{actions}</View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flexShrink: 0,
    gap: spacing.sm,
    paddingBottom: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    zIndex: 50,
  },
  topRow: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  titleBlock: { flex: 1, minWidth: 0 },
  title: {
    marginTop: 2,
    fontFamily: fonts.displayBold,
    fontSize: 28,
    color: colors.text,
    letterSpacing: -0.5,
  },
  meta: { marginTop: 2, fontFamily: fonts.body, fontSize: 12.5, color: colors.textMuted },
  selectWrap: { width: 240, position: 'relative', zIndex: 60 },
  selectTrigger: {
    minHeight: 38,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: 12,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  selectTriggerHover: { backgroundColor: colors.cardAlt, borderColor: colors.primary },
  selectText: { flex: 1, fontFamily: fonts.bodySemiBold, fontSize: 12.5, color: colors.text },
  menu: {
    position: 'absolute',
    top: 42,
    right: 0,
    width: 280,
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
  bottomRow: {
    minHeight: 40,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    zIndex: 60,
  },
  bottomControls: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, zIndex: 60 },
  actions: {
    width: 344,
    minHeight: 38,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: spacing.sm,
    zIndex: 1,
  },
});
