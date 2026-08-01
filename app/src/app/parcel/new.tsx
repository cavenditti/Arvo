// OWNER: fe-map — Create a parcel: detect boundaries from the cadastre (FR-0-010b, default),
// draw on the map, or import GeoJSON, then fill crop/season metadata and an optional cover
// photo. Cadastre multi-select and FeatureCollections bulk-import via POST /parcels/import;
// a single geometry feeds the one-parcel form (POST /parcels + POST /parcels/{id}/photo).
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
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
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import * as Location from 'expo-location';
import { Stack, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';

import type { CadastralParcel, ParcelGeometry } from '@/api/types';
import MapView from '@/components/MapView';
import type { CadastreMapFeature } from '@/components/types';
import { TintCard } from '@/components/ui';
import { CROP_OPTIONS, type CropKey, draftParcel, isValidDate } from '@/features/parcels/crops';
import { notify } from '@/features/parcels/dialog';
import {
  useCadastralParcels,
  useCreateFarm,
  useCreateParcel,
  useFarms,
  useImportParcels,
  useParcels,
  useSetParcelPhoto,
} from '@/features/parcels/hooks';
import { colors, fonts, gradients, radius, spacing } from '@/theme';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Below this zoom a viewport is too wide to fetch (and to tap) cadastral parcels. */
const CADASTRE_MIN_ZOOM = 15;

type SourceMode = 'cadastre' | 'draw';

interface LocalPhoto {
  uri: string;
  name: string;
  mime: string;
}

async function readAssetText(uri: string): Promise<string> {
  if (Platform.OS === 'web') {
    const res = await fetch(uri);
    return res.text();
  }
  return new File(uri).text();
}

/** Human name for a detected cadastral parcel ("Particella 42"). */
function cadastreName(f: CadastralParcel, t: TFn): string {
  const label = f.properties.label ?? f.properties.cadastral_ref ?? '';
  return t('parcel.cadastre_name', { label });
}

export default function NewParcelScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const farmsQ = useFarms();
  const parcelsQ = useParcels();
  const createParcel = useCreateParcel();
  const importParcels = useImportParcels();
  const createFarm = useCreateFarm();
  const setParcelPhoto = useSetParcelPhoto();

  const [source, setSource] = useState<SourceMode>('cadastre');
  const [geometry, setGeometry] = useState<ParcelGeometry | null>(null);
  const [cadastralRef, setCadastralRef] = useState<string | null>(null);
  const [pendingFc, setPendingFc] = useState<unknown>(null);
  const [pendingFcCount, setPendingFcCount] = useState(0);

  const [viewport, setViewport] = useState<{
    bbox: [number, number, number, number];
    zoom: number;
  } | null>(null);
  const [selectedCad, setSelectedCad] = useState<Record<string, CadastralParcel>>({});
  const [gps, setGps] = useState<[number, number] | null>(null);

  const [name, setName] = useState('');
  const [selectedFarm, setSelectedFarm] = useState<string | null>(null);
  const [crop, setCrop] = useState<CropKey | null>(null);
  const [variety, setVariety] = useState('');
  const [plantingDate, setPlantingDate] = useState('');
  const [seasonYear, setSeasonYear] = useState('2026');
  const [photo, setPhoto] = useState<LocalPhoto | null>(null);

  const [creatingFarm, setCreatingFarm] = useState(false);
  const [newFarmName, setNewFarmName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const orgParcels = useMemo(() => parcelsQ.data ?? [], [parcelsQ.data]);

  // Cadastre detection is live while picking boundaries in cadastre mode.
  const cadastreActive = source === 'cadastre' && !geometry && !pendingFc;
  const zoomedEnough = (viewport?.zoom ?? 0) >= CADASTRE_MIN_ZOOM;
  const cadQ = useCadastralParcels(
    cadastreActive && zoomedEnough && viewport ? viewport.bbox : null,
  );

  // A brand-new org has no parcels to frame the map — fall back to the device position once.
  useEffect(() => {
    if (!cadastreActive || gps || !parcelsQ.isSuccess || orgParcels.length > 0) return;
    let cancelled = false;
    (async () => {
      try {
        const perm = await Location.requestForegroundPermissionsAsync();
        if (!perm.granted) return;
        const pos = await Location.getCurrentPositionAsync({});
        if (!cancelled) setGps([pos.coords.longitude, pos.coords.latitude]);
      } catch {
        // no position — the user pans by hand
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cadastreActive, gps, parcelsQ.isSuccess, orgParcels.length]);

  // Overlay = current detection + everything already selected (selection must survive
  // panning away from the viewport that produced it).
  const cadFeatures: CadastreMapFeature[] = useMemo(() => {
    const byRef = new Map<string, CadastreMapFeature>();
    for (const f of cadQ.data?.features ?? []) {
      const ref = f.properties.cadastral_ref;
      if (!ref) continue; // unusable as identity — cannot select or dedupe
      const existing = !!f.properties.existing_parcel_id;
      const label = cadastreName(f, t);
      byRef.set(ref, {
        ref,
        geometry: f.geometry,
        existing,
        tooltip: existing ? `${label} · ${t('parcel.cadastre_existing')}` : label,
      });
    }
    for (const [ref, f] of Object.entries(selectedCad)) {
      if (!byRef.has(ref)) {
        byRef.set(ref, {
          ref,
          geometry: f.geometry,
          existing: false,
          tooltip: cadastreName(f, t),
        });
      }
    }
    return [...byRef.values()];
  }, [cadQ.data, selectedCad, t]);

  const toggleCadastre = useCallback(
    (ref: string) => {
      setSelectedCad((prev) => {
        if (prev[ref]) {
          const next = { ...prev };
          delete next[ref];
          return next;
        }
        const hit = (cadQ.data?.features ?? []).find((f) => f.properties.cadastral_ref === ref);
        if (!hit || hit.properties.existing_parcel_id) return prev;
        return { ...prev, [ref]: hit };
      });
    },
    [cadQ.data],
  );

  const selectedList = Object.values(selectedCad);

  /** Turn the current cadastre selection into the form (1) or a bulk import (n). */
  function confirmCadastre() {
    if (selectedList.length === 0) return;
    if (selectedList.length === 1) {
      const f = selectedList[0];
      setGeometry(f.geometry);
      setCadastralRef(f.properties.cadastral_ref);
      if (!name) setName(cadastreName(f, t));
      setSelectedCad({});
      setError(null);
      return;
    }
    const fc = {
      type: 'FeatureCollection',
      features: selectedList.map((f) => ({
        type: 'Feature',
        geometry: f.geometry,
        properties: {
          name: cadastreName(f, t),
          cadastral_ref: f.properties.cadastral_ref,
        },
      })),
    };
    setPendingFc(fc);
    setPendingFcCount(selectedList.length);
    setSelectedCad({});
    setError(null);
  }

  function applyGeometry(geom: unknown, nm?: unknown) {
    const g = geom as { type?: string };
    if (g?.type !== 'Polygon' && g?.type !== 'MultiPolygon') {
      setError(t('parcel.import_invalid'));
      return;
    }
    setPendingFc(null);
    setCadastralRef(null);
    setGeometry(geom as ParcelGeometry);
    if (typeof nm === 'string' && nm && !name) setName(nm);
    setError(null);
  }

  function clearGeometry() {
    setGeometry(null);
    setCadastralRef(null);
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
        setCadastralRef(null);
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

  // --- cover photo (single, optional) ---

  const addPhotoAsset = (a: ImagePicker.ImagePickerAsset) =>
    setPhoto({
      uri: a.uri,
      name: a.fileName ?? `field_${Date.now()}.jpg`,
      mime: a.mimeType ?? 'image/jpeg',
    });

  const pickPhotoFromCamera = async () => {
    try {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) return;
      const res = await ImagePicker.launchCameraAsync({ quality: 0.6 });
      if (!res.canceled && res.assets[0]) addPhotoAsset(res.assets[0]);
    } catch {
      // camera unavailable (e.g. web) — silently ignore
    }
  };

  const pickPhotoFromLibrary = async () => {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) return;
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsMultipleSelection: false,
        quality: 0.6,
      });
      if (!res.canceled && res.assets[0]) addPhotoAsset(res.assets[0]);
    } catch {
      // ignore
    }
  };

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

  async function onSubmit() {
    setError(null);
    if (!geometry) return setError(t('parcel.err_geometry'));
    if (!name.trim()) return setError(t('parcel.err_name'));
    if (!selectedFarm) return setError(t('parcel.err_farm'));
    if (plantingDate.trim() && !isValidDate(plantingDate.trim())) {
      return setError(t('parcel.err_date'));
    }
    const yr = parseInt(seasonYear, 10);
    try {
      const created = await createParcel.mutateAsync({
        farm_id: selectedFarm,
        name: name.trim(),
        geometry,
        crop: crop ?? undefined,
        variety: variety.trim() || undefined,
        planting_date: plantingDate.trim() || undefined,
        season_year: Number.isFinite(yr) ? yr : undefined,
        cadastral_ref: cadastralRef ?? undefined,
      });
      // The field exists either way — a failed photo upload must not strand the flow.
      if (photo) {
        try {
          await setParcelPhoto.mutateAsync({ parcelId: created.id, ...photo });
        } catch {
          notify(t('parcel.photo_error_title'), t('parcel.photo_error_msg'));
        }
      }
      router.back();
    } catch (e) {
      setError(errMsg(e));
    }
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
  const busy = createParcel.isPending || importParcels.isPending || setParcelPhoto.isPending;

  // One status line drives the whole cadastre panel.
  const cadStatus: { key: string; tone: 'hint' | 'error' } | null = !cadastreActive
    ? null
    : !zoomedEnough
      ? { key: 'parcel.cadastre_zoom', tone: 'hint' }
      : cadQ.isError
        ? { key: 'parcel.cadastre_error', tone: 'error' }
        : cadQ.isLoading
          ? { key: 'parcel.cadastre_loading', tone: 'hint' }
          : cadQ.data && cadQ.data.features.length === 0
            ? { key: 'parcel.cadastre_empty', tone: 'hint' }
            : cadQ.data?.truncated
              ? { key: 'parcel.cadastre_truncated', tone: 'hint' }
              : { key: 'parcel.cadastre_hint', tone: 'hint' };

  return (
    <>
      <Stack.Screen options={{ title: t('parcel.new_title') }} />
      <ScrollView
        style={styles.root}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        {/* geometry source: cadastre detection / hand drawing */}
        {!pendingFc && !geometry ? (
          <View style={styles.chips}>
            {(['cadastre', 'draw'] as const).map((m) => {
              const active = source === m;
              return (
                <Pressable
                  key={m}
                  style={[styles.chip, active && styles.chipActive]}
                  onPress={() => setSource(m)}
                >
                  <Ionicons
                    name={m === 'cadastre' ? 'scan' : 'pencil'}
                    size={15}
                    color={active ? '#fff' : colors.textMuted}
                  />
                  <Text style={[styles.chipTxt, active && styles.chipTxtActive]}>
                    {t(m === 'cadastre' ? 'parcel.mode_cadastre' : 'parcel.mode_draw')}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}

        {/* geometry: detect, draw or preview */}
        {!pendingFc ? (
          <View style={styles.mapBox}>
            {geometry ? (
              <MapView parcels={[{ parcel: draftParcel(geometry, name) }]} mode="view" height={260} />
            ) : source === 'cadastre' ? (
              <MapView
                parcels={orgParcels.map((p) => ({ parcel: p }))}
                mode="view"
                height={300}
                focus={
                  gps && orgParcels.length === 0 ? [gps[0], gps[1], CADASTRE_MIN_ZOOM + 1] : undefined
                }
                cadastre={{ features: cadFeatures, selected: Object.keys(selectedCad) }}
                onCadastreTap={toggleCadastre}
                onViewportChange={setViewport}
              />
            ) : (
              <MapView parcels={[]} mode="draw" height={260} onDrawComplete={(g) => applyGeometry(g)} />
            )}
          </View>
        ) : null}

        {/* cadastre status + selection actions */}
        {!pendingFc && !geometry && source === 'cadastre' ? (
          <View style={styles.cadPanel}>
            {cadStatus ? (
              <View style={styles.cadStatusRow}>
                {cadQ.isLoading && zoomedEnough ? (
                  <ActivityIndicator size="small" color={colors.primary} />
                ) : null}
                <Text style={[styles.hint, cadStatus.tone === 'error' && styles.hintError]}>
                  {t(cadStatus.key)}
                </Text>
              </View>
            ) : null}
            {selectedList.length > 0 ? (
              <>
                <Text style={styles.cadCount}>
                  {t('parcel.cadastre_selected', { count: selectedList.length })}
                </Text>
                <Pressable style={styles.primaryBtn} onPress={confirmCadastre}>
                  <TintCard gradient={gradients.forest} style={styles.primaryInner}>
                    <Text style={styles.primaryTxt}>
                      {t('parcel.cadastre_use', { count: selectedList.length })}
                    </Text>
                  </TintCard>
                </Pressable>
              </>
            ) : null}
          </View>
        ) : null}

        {!pendingFc ? (
          <View style={styles.geometryActions}>
            {geometry ? (
              <Pressable style={styles.secondaryBtn} onPress={clearGeometry}>
                <Ionicons name="pencil" size={16} color={colors.primary} />
                <Text style={styles.secondaryTxt}>{t('parcel.redraw')}</Text>
              </Pressable>
            ) : source === 'draw' ? (
              <Text style={styles.hint}>{t('parcel.draw_hint')}</Text>
            ) : (
              <View />
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

            <Field label={t('parcel.photo')}>
              {photo ? (
                <View style={styles.photoRow}>
                  <Image source={{ uri: photo.uri }} style={styles.photoThumb} contentFit="cover" />
                  <View style={styles.photoActions}>
                    <Pressable style={styles.secondaryBtn} onPress={pickPhotoFromLibrary}>
                      <Ionicons name="images" size={16} color={colors.primary} />
                      <Text style={styles.secondaryTxt}>{t('parcel.photo_change')}</Text>
                    </Pressable>
                    <Pressable style={styles.secondaryBtn} onPress={() => setPhoto(null)}>
                      <Ionicons name="trash" size={16} color={colors.primary} />
                      <Text style={styles.secondaryTxt}>{t('parcel.photo_remove')}</Text>
                    </Pressable>
                  </View>
                </View>
              ) : (
                <View style={styles.chips}>
                  {Platform.OS !== 'web' ? (
                    <Pressable style={styles.secondaryBtn} onPress={pickPhotoFromCamera}>
                      <Ionicons name="camera" size={16} color={colors.primary} />
                      <Text style={styles.secondaryTxt}>{t('parcel.photo_take')}</Text>
                    </Pressable>
                  ) : null}
                  <Pressable style={styles.secondaryBtn} onPress={pickPhotoFromLibrary}>
                    <Ionicons name="images" size={16} color={colors.primary} />
                    <Text style={styles.secondaryTxt}>{t('parcel.photo_pick')}</Text>
                  </Pressable>
                </View>
              )}
            </Field>

            <Pressable
              style={[styles.primaryBtn, busy && styles.disabled]}
              onPress={onSubmit}
              disabled={busy}
            >
              <TintCard gradient={gradients.forest} style={styles.primaryInner}>
                {createParcel.isPending || setParcelPhoto.isPending ? (
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
  cadPanel: { gap: spacing.sm },
  cadStatusRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  cadCount: { fontSize: 14, fontFamily: fonts.bodySemiBold, color: colors.text },
  hint: { color: colors.textMuted, fontSize: 13, fontFamily: fonts.body, flex: 1 },
  hintError: { color: colors.danger },
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
  photoRow: { flexDirection: 'row', gap: spacing.md, alignItems: 'center' },
  photoThumb: {
    width: 96,
    height: 96,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  photoActions: { gap: spacing.sm },
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
