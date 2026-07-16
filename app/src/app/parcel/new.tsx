// OWNER: fe-map — Create a parcel by drawing on the map or importing GeoJSON, then fill crop/season
// metadata. A FeatureCollection is bulk-imported via POST /parcels/import; a single geometry feeds
// the one-parcel form (POST /parcels).
import { type ReactNode, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import Ionicons from '@expo/vector-icons/Ionicons';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { Stack, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';

import type { ParcelGeometry } from '@/api/types';
import MapView from '@/components/MapView';
import { TintCard } from '@/components/ui';
import { CROP_OPTIONS, type CropKey, draftParcel, isValidDate } from '@/features/parcels/crops';
import { notify } from '@/features/parcels/dialog';
import {
  useCreateFarm,
  useCreateParcel,
  useFarms,
  useImportParcels,
} from '@/features/parcels/hooks';
import { colors, fonts, gradients, radius, spacing } from '@/theme';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function readAssetText(uri: string): Promise<string> {
  if (Platform.OS === 'web') {
    const res = await fetch(uri);
    return res.text();
  }
  return new File(uri).text();
}

export default function NewParcelScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const farmsQ = useFarms();
  const createParcel = useCreateParcel();
  const importParcels = useImportParcels();
  const createFarm = useCreateFarm();

  const [geometry, setGeometry] = useState<ParcelGeometry | null>(null);
  const [pendingFc, setPendingFc] = useState<unknown>(null);
  const [pendingFcCount, setPendingFcCount] = useState(0);

  const [name, setName] = useState('');
  const [selectedFarm, setSelectedFarm] = useState<string | null>(null);
  const [crop, setCrop] = useState<CropKey | null>(null);
  const [variety, setVariety] = useState('');
  const [plantingDate, setPlantingDate] = useState('');
  const [seasonYear, setSeasonYear] = useState('2026');

  const [creatingFarm, setCreatingFarm] = useState(false);
  const [newFarmName, setNewFarmName] = useState('');
  const [error, setError] = useState<string | null>(null);

  function applyGeometry(geom: unknown, nm?: unknown) {
    const g = geom as { type?: string };
    if (g?.type !== 'Polygon' && g?.type !== 'MultiPolygon') {
      setError(t('parcel.import_invalid'));
      return;
    }
    setPendingFc(null);
    setGeometry(geom as ParcelGeometry);
    if (typeof nm === 'string' && nm && !name) setName(nm);
    setError(null);
  }

  async function onImport() {
    setError(null);
    try {
      const res = await DocumentPicker.getDocumentAsync({
        type: ['application/geo+json', 'application/json', '*/*'],
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (res.canceled) return;
      const asset = res.assets[0];
      if (!asset) return;
      const json = JSON.parse(await readAssetText(asset.uri)) as {
        type?: string;
        features?: unknown[];
        geometry?: unknown;
        properties?: { name?: unknown };
      };
      if (json?.type === 'FeatureCollection' && Array.isArray(json.features)) {
        setGeometry(null);
        setPendingFc(json);
        setPendingFcCount(json.features.length);
      } else if (json?.type === 'Feature') {
        applyGeometry(json.geometry, json.properties?.name);
      } else if (json?.type === 'Polygon' || json?.type === 'MultiPolygon') {
        applyGeometry(json);
      } else {
        setError(t('parcel.import_invalid'));
      }
    } catch {
      setError(t('parcel.import_invalid'));
    }
  }

  function onCreateFarm() {
    const nm = newFarmName.trim();
    if (!nm) return;
    createFarm.mutate(nm, {
      onSuccess: (farm) => {
        setSelectedFarm(farm.id);
        setCreatingFarm(false);
        setNewFarmName('');
      },
      onError: (e) => setError(errMsg(e)),
    });
  }

  function onSubmit() {
    setError(null);
    if (!geometry) return setError(t('parcel.err_geometry'));
    if (!name.trim()) return setError(t('parcel.err_name'));
    if (!selectedFarm) return setError(t('parcel.err_farm'));
    if (plantingDate.trim() && !isValidDate(plantingDate.trim())) {
      return setError(t('parcel.err_date'));
    }
    const yr = parseInt(seasonYear, 10);
    createParcel.mutate(
      {
        farm_id: selectedFarm,
        name: name.trim(),
        geometry,
        crop: crop ?? undefined,
        variety: variety.trim() || undefined,
        planting_date: plantingDate.trim() || undefined,
        season_year: Number.isFinite(yr) ? yr : undefined,
      },
      { onSuccess: () => router.back(), onError: (e) => setError(errMsg(e)) },
    );
  }

  function onBulkImport() {
    setError(null);
    if (!selectedFarm) return setError(t('parcel.err_farm'));
    if (!pendingFc) return;
    importParcels.mutate(
      { farm_id: selectedFarm, feature_collection: pendingFc },
      {
        onSuccess: (r) => {
          notify(
            t('parcel.import_done_title'),
            t('parcel.import_done_msg', { created: r.created.length, skipped: r.skipped ?? 0 }),
          );
          router.back();
        },
        onError: (e) => setError(errMsg(e)),
      },
    );
  }

  const farms = farmsQ.data ?? [];
  const busy = createParcel.isPending || importParcels.isPending;

  return (
    <>
      <Stack.Screen options={{ title: t('parcel.new_title') }} />
      <ScrollView
        style={styles.root}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        {/* geometry: draw or preview */}
        {!pendingFc ? (
          <View style={styles.mapBox}>
            {geometry ? (
              <MapView parcels={[{ parcel: draftParcel(geometry, name) }]} mode="view" height={260} />
            ) : (
              <MapView parcels={[]} mode="draw" height={260} onDrawComplete={(g) => applyGeometry(g)} />
            )}
          </View>
        ) : null}

        {!pendingFc ? (
          <View style={styles.geometryActions}>
            {geometry ? (
              <Pressable style={styles.secondaryBtn} onPress={() => setGeometry(null)}>
                <Ionicons name="pencil" size={16} color={colors.primary} />
                <Text style={styles.secondaryTxt}>{t('parcel.redraw')}</Text>
              </Pressable>
            ) : (
              <Text style={styles.hint}>{t('parcel.draw_hint')}</Text>
            )}
            <Pressable style={styles.secondaryBtn} onPress={onImport}>
              <Ionicons name="document-text" size={16} color={colors.primary} />
              <Text style={styles.secondaryTxt}>{t('parcel.import_geojson')}</Text>
            </Pressable>
          </View>
        ) : null}

        {/* bulk import summary */}
        {pendingFc ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>
              {t('parcel.import_ready', { count: pendingFcCount })}
            </Text>
            <FarmPicker
              farms={farms}
              loading={farmsQ.isLoading}
              selected={selectedFarm}
              onSelect={setSelectedFarm}
              creating={creatingFarm}
              newFarmName={newFarmName}
              onNewFarmName={setNewFarmName}
              onToggleCreate={() => setCreatingFarm((v) => !v)}
              onCreate={onCreateFarm}
              creatingBusy={createFarm.isPending}
              t={t}
            />
            <Pressable
              style={[styles.primaryBtn, (!selectedFarm || busy) && styles.disabled]}
              onPress={onBulkImport}
              disabled={!selectedFarm || busy}
            >
              <TintCard gradient={gradients.forest} style={styles.primaryInner}>
                {importParcels.isPending ? (
                  <ActivityIndicator color={colors.onPrimary} />
                ) : (
                  <Text style={styles.primaryTxt}>
                    {t('parcel.import_action', { count: pendingFcCount })}
                  </Text>
                )}
              </TintCard>
            </Pressable>
            <Pressable style={styles.linkBtn} onPress={() => setPendingFc(null)}>
              <Text style={styles.linkTxt}>{t('common.cancel')}</Text>
            </Pressable>
          </View>
        ) : (
          /* single-parcel form */
          <View style={styles.form}>
            <Field label={t('parcel.name')}>
              <TextInput
                style={styles.input}
                value={name}
                onChangeText={setName}
                placeholder={t('parcel.name_ph')}
                placeholderTextColor={colors.textMuted}
              />
            </Field>

            <Field label={t('parcel.farm')}>
              <FarmPicker
                farms={farms}
                loading={farmsQ.isLoading}
                selected={selectedFarm}
                onSelect={setSelectedFarm}
                creating={creatingFarm}
                newFarmName={newFarmName}
                onNewFarmName={setNewFarmName}
                onToggleCreate={() => setCreatingFarm((v) => !v)}
                onCreate={onCreateFarm}
                creatingBusy={createFarm.isPending}
                t={t}
              />
            </Field>

            <Field label={t('parcel.crop')}>
              <View style={styles.chips}>
                {CROP_OPTIONS.map((c) => {
                  const active = crop === c.value;
                  return (
                    <Pressable
                      key={c.value}
                      style={[styles.chip, active && styles.chipActive]}
                      onPress={() => setCrop(active ? null : c.value)}
                    >
                      <Ionicons
                        name={c.icon}
                        size={15}
                        color={active ? '#fff' : colors.textMuted}
                      />
                      <Text style={[styles.chipTxt, active && styles.chipTxtActive]}>
                        {t(c.labelKey)}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </Field>

            <Field label={t('parcel.variety')}>
              <TextInput
                style={styles.input}
                value={variety}
                onChangeText={setVariety}
                placeholder={t('parcel.variety_ph')}
                placeholderTextColor={colors.textMuted}
              />
            </Field>

            <Field label={t('parcel.planting_date')}>
              <TextInput
                style={styles.input}
                value={plantingDate}
                onChangeText={setPlantingDate}
                placeholder="AAAA-MM-GG"
                placeholderTextColor={colors.textMuted}
                autoCapitalize="none"
                keyboardType="numbers-and-punctuation"
              />
            </Field>

            <Field label={t('parcel.season_year')}>
              <TextInput
                style={styles.input}
                value={seasonYear}
                onChangeText={setSeasonYear}
                keyboardType="number-pad"
                maxLength={4}
              />
            </Field>

            <Pressable
              style={[styles.primaryBtn, busy && styles.disabled]}
              onPress={onSubmit}
              disabled={busy}
            >
              <TintCard gradient={gradients.forest} style={styles.primaryInner}>
                {createParcel.isPending ? (
                  <ActivityIndicator color={colors.onPrimary} />
                ) : (
                  <Text style={styles.primaryTxt}>{t('common.save')}</Text>
                )}
              </TintCard>
            </Pressable>
          </View>
        )}

        {error ? <Text style={styles.error}>{error}</Text> : null}
      </ScrollView>
    </>
  );
}

type TFn = (key: string, opts?: Record<string, unknown>) => string;

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
    </View>
  );
}

function FarmPicker(props: {
  farms: { id: string; name: string }[];
  loading: boolean;
  selected: string | null;
  onSelect: (id: string) => void;
  creating: boolean;
  newFarmName: string;
  onNewFarmName: (v: string) => void;
  onToggleCreate: () => void;
  onCreate: () => void;
  creatingBusy: boolean;
  t: TFn;
}) {
  const { farms, loading, selected, onSelect, creating, newFarmName, t } = props;
  return (
    <View>
      <View style={styles.chips}>
        {loading ? <ActivityIndicator color={colors.primary} /> : null}
        {farms.map((f) => {
          const active = selected === f.id;
          return (
            <Pressable
              key={f.id}
              style={[styles.chip, active && styles.chipActive]}
              onPress={() => onSelect(f.id)}
            >
              <Text style={[styles.chipTxt, active && styles.chipTxtActive]}>{f.name}</Text>
            </Pressable>
          );
        })}
        <Pressable style={[styles.chip, styles.chipAdd]} onPress={props.onToggleCreate}>
          <Ionicons name="add" size={15} color={colors.primary} />
          <Text style={[styles.chipTxt, { color: colors.primary }]}>{t('parcel.new_farm')}</Text>
        </Pressable>
      </View>
      {creating ? (
        <View style={styles.newFarmRow}>
          <TextInput
            style={[styles.input, styles.flex1]}
            value={newFarmName}
            onChangeText={props.onNewFarmName}
            placeholder={t('parcel.farm_name_ph')}
            placeholderTextColor={colors.textMuted}
          />
          <Pressable
            style={[styles.smallBtn, props.creatingBusy && styles.disabled]}
            onPress={props.onCreate}
            disabled={props.creatingBusy}
          >
            {props.creatingBusy ? (
              <ActivityIndicator color={colors.onPrimary} />
            ) : (
              <Text style={styles.primaryTxt}>{t('common.save')}</Text>
            )}
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.md, gap: spacing.md, paddingBottom: spacing.xl },
  mapBox: { borderRadius: radius.md, overflow: 'hidden', borderWidth: 1, borderColor: colors.border },
  geometryActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  hint: { color: colors.textMuted, fontSize: 13, fontFamily: fonts.body, flex: 1 },
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardTitle: { fontSize: 16, fontFamily: fonts.display, color: colors.text },
  form: { gap: spacing.md },
  field: { gap: spacing.xs },
  fieldLabel: { fontSize: 13, fontFamily: fonts.bodySemiBold, color: colors.textMuted },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: 16,
    fontFamily: fonts.body,
    color: colors.text,
    backgroundColor: colors.card,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipAdd: { borderStyle: 'dashed', borderColor: colors.primary },
  chipTxt: { fontSize: 14, fontFamily: fonts.body, color: colors.text },
  chipTxtActive: { color: colors.onPrimary, fontFamily: fonts.bodySemiBold },
  newFarmRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm, alignItems: 'center' },
  flex1: { flex: 1 },
  primaryBtn: {},
  primaryInner: {
    paddingVertical: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
    borderColor: 'transparent',
  },
  primaryTxt: { color: colors.onPrimary, fontFamily: fonts.bodyBold, fontSize: 16 },
  smallBtn: {
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    justifyContent: 'center',
    alignItems: 'center',
    minHeight: 44,
  },
  secondaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.primary,
  },
  secondaryTxt: { color: colors.primary, fontFamily: fonts.bodySemiBold, fontSize: 14 },
  linkBtn: { alignItems: 'center', paddingVertical: spacing.xs },
  linkTxt: { color: colors.textMuted, fontSize: 14, fontFamily: fonts.body },
  disabled: { opacity: 0.5 },
  error: { color: colors.danger, fontSize: 14, fontFamily: fonts.body, textAlign: 'center' },
});
