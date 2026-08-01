// OWNER: parcel-flow — create a field in two steps inside one route (docs/UX-REVAMP.md):
//   1 «Confini»: boundaries via cadastre tap-to-select (FR-0-010b, default), hand drawing,
//     or GeoJSON file import. Location priming (PrimeCard, never a cold system dialog) plus
//     an address-search fallback keep the map from dead-ending at zoom-5 Italy.
//   2 «Informazioni»: name + crop; variety/date/season/photo wait behind an optional-details
//     disclosure. The farm concept disappears for the common case — with no farm yet, one is
//     created silently on save (auto-named after the user).
// Cadastre multi-select and FeatureCollections bulk-import via POST /parcels/import.
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  type LayoutChangeEvent,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';

import AsyncStorage from '@react-native-async-storage/async-storage';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import * as Location from 'expo-location';
import { Stack, useNavigation, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { CadastralParcel, ParcelGeometry } from '@/api/types';
import { useAuth } from '@/auth/AuthContext';
import DateField from '@/components/DateField';
import MapView from '@/components/MapView';
import PrimeCard from '@/components/PrimeCard';
import { showToast } from '@/components/Toast';
import type { CadastreMapFeature } from '@/components/types';
import { InteractivePressable, TintCard } from '@/components/ui';
import {
  CROP_OPTIONS,
  type CropKey,
  currentSeasonYear,
  draftParcel,
  isValidDate,
} from '@/features/parcels/crops';
import { confirmDestructive } from '@/features/parcels/dialog';
import {
  useCadastralParcels,
  useCreateFarm,
  useCreateParcelAutoFarm,
  useFarms,
  useImportParcelsAutoFarm,
  useParcels,
  useSetParcelPhoto,
} from '@/features/parcels/hooks';
import { isAbortError, searchPlaces, type GeocodeResult } from '@/lib/geocode';
import * as haptics from '@/lib/haptics';
import { colors, fonts, gradients, radius, spacing, touch, type as typeScale } from '@/theme';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Below this zoom a viewport is too wide to fetch (and to tap) cadastral parcels. */
const CADASTRE_MIN_ZOOM = 15;

/** AsyncStorage flag: the location PrimeCard was answered once — never nag again. */
const PRIMED_LOCATION_KEY = 'arvo.primed.location';

type Step = 'boundary' | 'info';
type SourceMode = 'cadastre' | 'draw';
/** Location priming state: resolve → maybe prime → granted or manual fallback. */
type LocPrime = 'unknown' | 'show' | 'granted' | 'fallback';

interface LocalPhoto {
  uri: string;
  name: string;
  mime: string;
}

interface FieldErrors {
  geometry?: string;
  name?: string;
  farm?: string;
  date?: string;
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
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { height: winH } = useWindowDimensions();
  const { user, org } = useAuth();

  const farmsQ = useFarms();
  const parcelsQ = useParcels();
  const createParcel = useCreateParcelAutoFarm();
  const importParcels = useImportParcelsAutoFarm();
  const createFarm = useCreateFarm();
  const setParcelPhoto = useSetParcelPhoto();

  const [step, setStep] = useState<Step>('boundary');
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

  // Location priming + manual fallback (first field only).
  const [locPrime, setLocPrime] = useState<LocPrime>('unknown');
  const [searchQ, setSearchQ] = useState('');
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchResults, setSearchResults] = useState<GeocodeResult[] | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchFocus, setSearchFocus] = useState<[number, number] | null>(null);

  const [name, setName] = useState('');
  const [selectedFarm, setSelectedFarm] = useState<string | null>(null);
  const [crop, setCrop] = useState<CropKey | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [variety, setVariety] = useState('');
  const [plantingDate, setPlantingDate] = useState<string | null>(null);
  const [seasonYear, setSeasonYear] = useState(String(currentSeasonYear()));
  const [photo, setPhoto] = useState<LocalPhoto | null>(null);

  const [creatingFarm, setCreatingFarm] = useState(false);
  const [newFarmName, setNewFarmName] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<{ main: string; detail?: string } | null>(null);

  // Map gestures pause the outer ScrollView (MapViewProps.onInteractionChange, map-native).
  const [mapBusy, setMapBusy] = useState(false);

  const scrollRef = useRef<ScrollView>(null);
  /** y-offsets of scroll-to targets in the step-2 ScrollView (scroll-to-first-error). */
  const anchors = useRef<Record<string, number>>({});

  const orgParcels = useMemo(() => parcelsQ.data ?? [], [parcelsQ.data]);
  const farms = farmsQ.data ?? [];
  // The farm concept disappears: 0 farms → silent auto-create on save; 1 → preselected
  // via resolvedFarmId, no UI; >1 → the chip picker appears (also on the bulk-import path).
  const showFarmPicker = farms.length > 1;
  const resolvedFarmId = selectedFarm ?? (farms.length === 1 ? farms[0].id : null);

  const firstName = (user?.full_name ?? '').trim().split(/\s+/)[0] ?? '';
  const autoFarmName = firstName
    ? t('parcel.auto_farm_name', { name: firstName })
    : org?.name || t('parcel.new_farm');

  // ~60% of the screen for the boundary map — enough to actually see the farm.
  const mapH = Math.max(280, Math.round(winH * 0.6));

  // Cadastre detection is live while picking boundaries in cadastre mode.
  const cadastreActive = step === 'boundary' && source === 'cadastre' && !geometry && !pendingFc;
  const zoomedEnough = (viewport?.zoom ?? 0) >= CADASTRE_MIN_ZOOM;
  const cadQ = useCadastralParcels(
    cadastreActive && zoomedEnough && viewport ? viewport.bbox : null,
  );

  // --- unsaved-changes guard -------------------------------------------------------------

  const dirtyRef = useRef(false);
  const skipGuardRef = useRef(false);
  useEffect(() => {
    dirtyRef.current = geometry != null || pendingFc != null || name.trim().length > 0;
  }, [geometry, pendingFc, name]);

  useEffect(() => {
    return navigation.addListener('beforeRemove', (e) => {
      if (!dirtyRef.current || skipGuardRef.current) return;
      e.preventDefault();
      confirmDestructive({
        title: t('parcel.discard_title', { defaultValue: 'Vuoi uscire senza salvare?' }),
        message: t('parcel.discard_msg', {
          defaultValue: 'Se esci ora perdi i confini e i dati inseriti.',
        }),
        confirmLabel: t('parcel.discard_confirm', { defaultValue: 'Esci senza salvare' }),
        cancelLabel: t('common.cancel'),
        onConfirm: () => navigation.dispatch(e.data.action),
      });
    });
  }, [navigation, t]);

  // --- location priming (first field only) ----------------------------------------------
  // Never fire the cold system dialog on mount: check the current permission silently, show
  // the PrimeCard once, and request only after «Attiva». Denied/unavailable → manual fallback.

  const needsLocation =
    cadastreActive && parcelsQ.isSuccess && orgParcels.length === 0 && !gps;

  const locate = useCallback(async () => {
    try {
      const pos = await Location.getCurrentPositionAsync({});
      setGps([pos.coords.longitude, pos.coords.latitude]);
    } catch {
      setLocPrime('fallback'); // position unavailable — offer the address search
    }
  }, []);

  useEffect(() => {
    if (!needsLocation || locPrime !== 'unknown') return;
    let cancelled = false;
    (async () => {
      try {
        const perm = await Location.getForegroundPermissionsAsync();
        if (cancelled) return;
        if (perm.granted) {
          setLocPrime('granted');
          void locate();
          return;
        }
        const primed = await AsyncStorage.getItem(PRIMED_LOCATION_KEY);
        if (cancelled) return;
        // Already answered once (accepted-then-denied, or «Non ora») — don't nag again.
        setLocPrime(primed ? 'fallback' : 'show');
      } catch {
        if (!cancelled) setLocPrime('fallback');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [needsLocation, locPrime, locate]);

  async function onAcceptLocation() {
    try {
      await AsyncStorage.setItem(PRIMED_LOCATION_KEY, '1');
    } catch {
      // flag is best-effort
    }
    try {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (perm.granted) {
        setLocPrime('granted');
        void locate();
      } else {
        setLocPrime('fallback');
      }
    } catch {
      setLocPrime('fallback');
    }
  }

  async function onLaterLocation() {
    try {
      await AsyncStorage.setItem(PRIMED_LOCATION_KEY, '1');
    } catch {
      // flag is best-effort
    }
    setLocPrime('fallback');
  }

  async function runSearch() {
    const q = searchQ.trim();
    if (!q || searchBusy) return;
    setSearchBusy(true);
    setSearchError(null);
    setSearchResults(null);
    try {
      const results = await searchPlaces(q);
      setSearchResults(results);
    } catch (e) {
      if (!isAbortError(e)) {
        setSearchError(
          t('parcel.search_error', {
            defaultValue: 'Ricerca non riuscita. Controlla la connessione e riprova.',
          }),
        );
      }
    } finally {
      setSearchBusy(false);
    }
  }

  function pickSearchResult(r: GeocodeResult) {
    haptics.selection();
    setSearchFocus([r.lon, r.lat]);
    setSearchResults(null);
  }

  const mapFocus: [number, number, number] | undefined = searchFocus
    ? [searchFocus[0], searchFocus[1], CADASTRE_MIN_ZOOM + 1]
    : gps && orgParcels.length === 0
      ? [gps[0], gps[1], CADASTRE_MIN_ZOOM + 1]
      : undefined;

  // --- cadastre overlay ------------------------------------------------------------------
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
      if (selectedCad[ref]) {
        haptics.selection();
        setSelectedCad((prev) => {
          const next = { ...prev };
          delete next[ref];
          return next;
        });
        return;
      }
      const hit = (cadQ.data?.features ?? []).find((f) => f.properties.cadastral_ref === ref);
      if (!hit || hit.properties.existing_parcel_id) return;
      haptics.selection();
      setSelectedCad((prev) => ({ ...prev, [ref]: hit }));
    },
    [cadQ.data, selectedCad],
  );

  const selectedList = Object.values(selectedCad);

  /** Turn the current cadastre selection into step 2 (1 parcel) or a bulk import (n). */
  function confirmCadastre() {
    if (selectedList.length === 0) return;
    haptics.selection();
    if (selectedList.length === 1) {
      const f = selectedList[0];
      setGeometry(f.geometry);
      setCadastralRef(f.properties.cadastral_ref);
      if (!name) setName(cadastreName(f, t));
      setSelectedCad({});
      setErrors({});
      setStep('info');
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
    setErrors({});
    setStep('info');
  }

  function applyGeometry(geom: unknown, nm?: unknown) {
    const g = geom as { type?: string };
    if (g?.type !== 'Polygon' && g?.type !== 'MultiPolygon') {
      setErrors((prev) => ({ ...prev, geometry: t('parcel.import_invalid') }));
      return;
    }
    setPendingFc(null);
    setCadastralRef(null);
    setGeometry(geom as ParcelGeometry);
    if (typeof nm === 'string' && nm && !name) setName(nm);
    setErrors({});
  }

  function clearGeometry() {
    setGeometry(null);
    setCadastralRef(null);
  }

  async function onImport() {
    setErrors((prev) => ({ ...prev, geometry: undefined }));
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
        setStep('info');
      } else if (json?.type === 'Feature') {
        applyGeometry(json.geometry, json.properties?.name);
      } else if (json?.type === 'Polygon' || json?.type === 'MultiPolygon') {
        applyGeometry(json);
      } else {
        setErrors((prev) => ({ ...prev, geometry: t('parcel.import_invalid') }));
      }
    } catch {
      setErrors((prev) => ({ ...prev, geometry: t('parcel.import_invalid') }));
    }
  }

  // --- cover photo (single, optional) ----------------------------------------------------

  const addPhotoAsset = (a: ImagePicker.ImagePickerAsset) =>
    setPhoto({
      uri: a.uri,
      name: a.fileName ?? `field_${Date.now()}.jpg`,
      mime: a.mimeType ?? 'image/jpeg',
    });

  const photoDeniedToast = () =>
    showToast({
      message: t('parcel.photo_permission_denied', {
        defaultValue:
          'Per aggiungere foto serve il permesso: puoi attivarlo dalle Impostazioni del telefono.',
      }),
      kind: 'info',
    });

  const pickPhotoFromCamera = async () => {
    try {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) {
        photoDeniedToast();
        return;
      }
      const res = await ImagePicker.launchCameraAsync({ quality: 0.6 });
      if (!res.canceled && res.assets[0]) addPhotoAsset(res.assets[0]);
    } catch {
      // camera unavailable (e.g. web) — silently ignore
    }
  };

  const pickPhotoFromLibrary = async () => {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        photoDeniedToast();
        return;
      }
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

  // --- save ------------------------------------------------------------------------------

  function onCreateFarm() {
    const nm = newFarmName.trim();
    if (!nm) return;
    createFarm.mutate(nm, {
      onSuccess: (farm) => {
        setSelectedFarm(farm.id);
        setCreatingFarm(false);
        setNewFarmName('');
        setErrors((prev) => ({ ...prev, farm: undefined }));
      },
      onError: () => setErrors((prev) => ({ ...prev, farm: t('parcel.save_failed_retry') })),
    });
  }

  function humanizeSaveError(e: unknown): { main: string; detail?: string } {
    const raw = errMsg(e);
    if (raw.includes('photo_upload_413')) return { main: t('parcel.photo_too_large') };
    return { main: t('parcel.save_failed_retry'), detail: raw };
  }

  function validate(): FieldErrors {
    const errs: FieldErrors = {};
    if (!geometry) errs.geometry = t('parcel.err_geometry');
    if (!name.trim()) errs.name = t('parcel.err_name');
    if (showFarmPicker && !resolvedFarmId) errs.farm = t('parcel.err_farm');
    if (plantingDate && !isValidDate(plantingDate)) errs.date = t('parcel.err_date');
    return errs;
  }

  /** Scroll step 2 to the first invalid field (date lives behind the disclosure — open it). */
  function revealFirstError(errs: FieldErrors) {
    if (errs.date) setDetailsOpen(true);
    const first = errs.name ? 'name' : errs.farm ? 'farm' : 'details';
    requestAnimationFrame(() => {
      const y = anchors.current[first] ?? 0;
      scrollRef.current?.scrollTo({ y: Math.max(0, y - spacing.md), animated: true });
    });
  }

  async function onSubmit() {
    setFormError(null);
    const errs = validate();
    setErrors(errs);
    if (errs.geometry) {
      haptics.warning();
      setStep('boundary'); // shouldn't happen in the normal flow, but never strand the user
      return;
    }
    if (errs.name || errs.farm || errs.date) {
      haptics.warning();
      revealFirstError(errs);
      return;
    }
    const yr = parseInt(seasonYear, 10);
    try {
      const created = await createParcel.mutateAsync({
        farmId: resolvedFarmId,
        autoFarmName,
        parcel: {
          name: name.trim(),
          geometry: geometry!,
          crop: crop ?? undefined,
          variety: variety.trim() || undefined,
          planting_date: plantingDate ?? undefined,
          season_year: Number.isFinite(yr) ? yr : undefined,
          cadastral_ref: cadastralRef ?? undefined,
        },
      });
      // The field exists either way — a failed photo upload must not strand the flow.
      let photoError: string | null = null;
      if (photo) {
        try {
          await setParcelPhoto.mutateAsync({ parcelId: created.id, ...photo });
        } catch (e) {
          photoError = errMsg(e);
        }
      }
      skipGuardRef.current = true;
      if (photoError) {
        haptics.warning();
        showToast({
          message: photoError.includes('photo_upload_413')
            ? t('parcel.photo_too_large')
            : t('parcel.photo_error_msg'),
          kind: 'error',
        });
      } else {
        haptics.success();
        showToast({ message: t('toast.saved'), kind: 'success' });
      }
      router.back();
    } catch (e) {
      haptics.error();
      setFormError(humanizeSaveError(e));
    }
  }

  function onBulkImport() {
    setFormError(null);
    if (!pendingFc) return;
    if (showFarmPicker && !resolvedFarmId) {
      haptics.warning();
      setErrors({ farm: t('parcel.err_farm') });
      return;
    }
    importParcels.mutate(
      { farmId: resolvedFarmId, autoFarmName, feature_collection: pendingFc },
      {
        onSuccess: (r) => {
          skipGuardRef.current = true;
          haptics.success();
          showToast({
            message: t('parcel.import_done_msg', {
              created: r.created.length,
              skipped: r.skipped ?? 0,
            }),
            kind: 'success',
          });
          router.back();
        },
        onError: (e) => {
          haptics.error();
          setFormError(humanizeSaveError(e));
        },
      },
    );
  }

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

  const stepTitle =
    step === 'boundary' ? t('parcel.step_boundary') : t('parcel.step_info');

  // --- render ----------------------------------------------------------------------------

  const boundaryStep = (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      scrollEnabled={!mapBusy}
    >
      {/* boundary source: cadastre detection / hand drawing / file import (momentary) */}
      {!geometry ? (
        <View style={styles.segmentRow}>
          {(
            [
              { key: 'cadastre', icon: 'scan', label: t('parcel.source_cadastre', { defaultValue: 'Catasto' }) },
              { key: 'draw', icon: 'pencil', label: t('parcel.source_draw', { defaultValue: 'Disegna' }) },
              { key: 'import', icon: 'document-text', label: t('parcel.source_import', { defaultValue: 'Importa file' }) },
            ] as const
          ).map((s) => {
            const active = s.key === source;
            return (
              <InteractivePressable
                key={s.key}
                haptic
                style={[styles.segment, active && styles.segmentActive]}
                accessibilityLabel={s.label}
                accessibilityState={{ selected: active }}
                onPress={() => {
                  if (s.key === 'import') void onImport();
                  else setSource(s.key);
                }}
              >
                <Ionicons name={s.icon} size={15} color={active ? colors.onPrimary : colors.textMuted} />
                <Text
                  style={[styles.segmentTxt, active && styles.segmentTxtActive]}
                  maxFontSizeMultiplier={typeScale.maxMult}
                  numberOfLines={1}
                >
                  {s.label}
                </Text>
              </InteractivePressable>
            );
          })}
        </View>
      ) : null}

      {/* location priming — shown BEFORE any system dialog, only while locating the first field */}
      {needsLocation && locPrime === 'show' ? (
        <PrimeCard
          icon="location"
          titleKey="prime.location_title"
          bodyKey="prime.location_body"
          ctaKey="prime.location_cta"
          laterKey="prime.location_later"
          onAccept={() => void onAcceptLocation()}
          onLater={() => void onLaterLocation()}
        />
      ) : null}

      {/* denied/unavailable → address search + a way into draw mode (no dead ends) */}
      {needsLocation && locPrime === 'fallback' ? (
        <View style={styles.fallbackCard}>
          <Text style={styles.hint} maxFontSizeMultiplier={typeScale.maxMult}>
            {t('parcel.location_fallback_hint', {
              defaultValue: 'Senza la posizione puoi cercare il comune o l’indirizzo dei tuoi campi.',
            })}
          </Text>
          <View style={styles.searchRow}>
            <TextInput
              style={[styles.input, styles.flex1]}
              value={searchQ}
              onChangeText={setSearchQ}
              placeholder={t('parcel.search_address_ph', {
                defaultValue: 'Comune o indirizzo (es. Cerignola)',
              })}
              placeholderTextColor={colors.textMuted}
              returnKeyType="search"
              onSubmitEditing={() => void runSearch()}
              accessibilityLabel={t('common.search', { defaultValue: 'Cerca' })}
            />
            <InteractivePressable
              haptic
              style={styles.searchBtn}
              accessibilityLabel={t('common.search', { defaultValue: 'Cerca' })}
              onPress={() => void runSearch()}
              disabled={searchBusy}
            >
              {searchBusy ? (
                <ActivityIndicator size="small" color={colors.onPrimary} />
              ) : (
                <Ionicons name="search" size={18} color={colors.onPrimary} />
              )}
            </InteractivePressable>
          </View>
          {searchError ? (
            <Text style={styles.inlineError} maxFontSizeMultiplier={typeScale.maxMult}>
              {searchError}
            </Text>
          ) : null}
          {searchResults && searchResults.length === 0 ? (
            <Text style={styles.hint} maxFontSizeMultiplier={typeScale.maxMult}>
              {t('parcel.search_no_results', {
                defaultValue: 'Nessun risultato. Prova con il nome del comune.',
              })}
            </Text>
          ) : null}
          {searchResults?.map((r) => (
            <InteractivePressable
              key={`${r.lon},${r.lat}`}
              style={styles.resultRow}
              accessibilityLabel={r.label}
              onPress={() => pickSearchResult(r)}
            >
              <Ionicons name="location-outline" size={16} color={colors.textMuted} />
              <Text style={styles.resultTxt} maxFontSizeMultiplier={typeScale.maxMult} numberOfLines={2}>
                {r.label}
              </Text>
            </InteractivePressable>
          ))}
          <InteractivePressable
            style={styles.linkBtn}
            accessibilityLabel={t('parcel.fallback_draw', {
              defaultValue: 'Oppure disegna i confini a mano',
            })}
            onPress={() => setSource('draw')}
          >
            <Text style={styles.linkTxt} maxFontSizeMultiplier={typeScale.maxMult}>
              {t('parcel.fallback_draw', { defaultValue: 'Oppure disegna i confini a mano' })}
            </Text>
          </InteractivePressable>
        </View>
      ) : null}

      {/* boundary map: detect, draw or preview */}
      <View style={styles.mapBox}>
        {geometry ? (
          <MapView
            parcels={[{ parcel: draftParcel(geometry, name) }]}
            mode="view"
            height={mapH}
            onInteractionChange={setMapBusy}
          />
        ) : source === 'cadastre' ? (
          <MapView
            parcels={orgParcels.map((p) => ({ parcel: p }))}
            mode="view"
            height={mapH}
            focus={mapFocus}
            cadastre={{ features: cadFeatures, selected: Object.keys(selectedCad) }}
            onCadastreTap={toggleCadastre}
            onViewportChange={setViewport}
            onInteractionChange={setMapBusy}
          />
        ) : (
          <MapView
            parcels={[]}
            mode="draw"
            height={mapH}
            // A searched/located position carries over into draw mode — no zoom-5 restart.
            focus={mapFocus}
            onDrawComplete={(g) => applyGeometry(g)}
            onInteractionChange={setMapBusy}
          />
        )}
      </View>

      {/* one-line cadastre status machine + selection actions */}
      {cadastreActive ? (
        <View style={styles.cadPanel}>
          {cadStatus ? (
            <View style={styles.cadStatusRow}>
              {cadQ.isLoading && zoomedEnough ? (
                <ActivityIndicator size="small" color={colors.primary} />
              ) : null}
              <Text
                style={[styles.hint, cadStatus.tone === 'error' && styles.hintError]}
                maxFontSizeMultiplier={typeScale.maxMult}
              >
                {t(cadStatus.key)}
              </Text>
            </View>
          ) : null}
          {selectedList.length > 0 ? (
            <>
              <Text style={styles.cadCount} maxFontSizeMultiplier={typeScale.maxMult}>
                {t('parcel.cadastre_selected', { count: selectedList.length })}
              </Text>
              <InteractivePressable
                haptic
                style={styles.primaryBtn}
                accessibilityLabel={t('parcel.cadastre_use', { count: selectedList.length })}
                onPress={confirmCadastre}
              >
                <TintCard gradient={gradients.forest} style={styles.primaryInner}>
                  <Text style={styles.primaryTxt} maxFontSizeMultiplier={typeScale.maxMult}>
                    {t('parcel.cadastre_use', { count: selectedList.length })}
                  </Text>
                </TintCard>
              </InteractivePressable>
            </>
          ) : null}
        </View>
      ) : null}

      {source === 'draw' && !geometry ? (
        <Text style={styles.hint} maxFontSizeMultiplier={typeScale.maxMult}>
          {t('parcel.draw_hint')}
        </Text>
      ) : null}

      {errors.geometry ? (
        <Text style={styles.inlineError} maxFontSizeMultiplier={typeScale.maxMult}>
          {errors.geometry}
        </Text>
      ) : null}

      {/* boundary confirmed by drawing/import → preview + continue */}
      {geometry ? (
        <>
          <InteractivePressable
            haptic
            style={styles.primaryBtn}
            accessibilityLabel={t('common.continue', { defaultValue: 'Continua' })}
            onPress={() => {
              setErrors({});
              setStep('info');
            }}
          >
            <TintCard gradient={gradients.forest} style={styles.primaryInner}>
              <Text style={styles.primaryTxt} maxFontSizeMultiplier={typeScale.maxMult}>
                {t('common.continue', { defaultValue: 'Continua' })}
              </Text>
            </TintCard>
          </InteractivePressable>
          <InteractivePressable
            style={styles.secondaryBtn}
            accessibilityLabel={t('parcel.redraw')}
            onPress={clearGeometry}
          >
            <Ionicons name="pencil" size={16} color={colors.primary} />
            <Text style={styles.secondaryTxt} maxFontSizeMultiplier={typeScale.maxMult}>
              {t('parcel.redraw')}
            </Text>
          </InteractivePressable>
        </>
      ) : null}
    </ScrollView>
  );

  const bulkPanel = (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.card}>
        <Text style={styles.cardTitle} maxFontSizeMultiplier={typeScale.maxMult}>
          {t('parcel.import_ready', { count: pendingFcCount })}
        </Text>
        {showFarmPicker ? (
          <Field label={t('parcel.farm')} error={errors.farm}>
            <FarmPicker
              farms={farms}
              loading={farmsQ.isLoading}
              selected={selectedFarm}
              onSelect={(id) => {
                setSelectedFarm(id);
                setErrors((prev) => ({ ...prev, farm: undefined }));
              }}
              creating={creatingFarm}
              newFarmName={newFarmName}
              onNewFarmName={setNewFarmName}
              onToggleCreate={() => setCreatingFarm((v) => !v)}
              onCreate={onCreateFarm}
              creatingBusy={createFarm.isPending}
              t={t}
            />
          </Field>
        ) : null}
        <InteractivePressable
          haptic
          style={[styles.primaryBtn, busy && styles.disabled]}
          accessibilityLabel={t('parcel.import_action', { count: pendingFcCount })}
          onPress={onBulkImport}
          disabled={busy}
        >
          <TintCard gradient={gradients.forest} style={styles.primaryInner}>
            {importParcels.isPending ? (
              <ActivityIndicator color={colors.onPrimary} />
            ) : (
              <Text style={styles.primaryTxt} maxFontSizeMultiplier={typeScale.maxMult}>
                {t('parcel.import_action', { count: pendingFcCount })}
              </Text>
            )}
          </TintCard>
        </InteractivePressable>
        {formError ? (
          <View style={styles.formErrorBox}>
            <Text style={styles.inlineError} maxFontSizeMultiplier={typeScale.maxMult}>
              {formError.main}
            </Text>
            {formError.detail ? (
              <Text style={styles.errorDetail} maxFontSizeMultiplier={typeScale.maxMult}>
                {formError.detail}
              </Text>
            ) : null}
          </View>
        ) : null}
        <InteractivePressable
          style={styles.linkBtn}
          accessibilityLabel={t('common.cancel')}
          onPress={() => {
            setPendingFc(null);
            setStep('boundary');
          }}
        >
          <Text style={styles.linkTxt} maxFontSizeMultiplier={typeScale.maxMult}>
            {t('common.cancel')}
          </Text>
        </InteractivePressable>
      </View>
    </ScrollView>
  );

  const infoStep = (
    <KeyboardAvoidingView
      style={styles.kav}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      // Modal-sheet header ≈ 56pt; insets.top is 0 inside the iOS sheet.
      keyboardVerticalOffset={Platform.OS === 'ios' ? insets.top + 56 : 0}
    >
      <ScrollView
        ref={scrollRef}
        style={styles.root}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <InteractivePressable
          style={styles.backRow}
          accessibilityLabel={t('common.back')}
          onPress={() => setStep('boundary')}
        >
          <Ionicons name="chevron-back" size={18} color={colors.primary} />
          <Text style={styles.secondaryTxt} maxFontSizeMultiplier={typeScale.maxMult}>
            {t('parcel.step_boundary')}
          </Text>
        </InteractivePressable>

        <Field
          label={t('parcel.name')}
          error={errors.name}
          onLayout={(e) => {
            anchors.current.name = e.nativeEvent.layout.y;
          }}
        >
          <TextInput
            style={[styles.input, errors.name != null && styles.inputError]}
            value={name}
            onChangeText={(v) => {
              setName(v);
              if (errors.name) setErrors((prev) => ({ ...prev, name: undefined }));
            }}
            placeholder={t('parcel.name_ph')}
            placeholderTextColor={colors.textMuted}
            accessibilityLabel={t('parcel.name')}
          />
        </Field>

        {showFarmPicker ? (
          <Field
            label={t('parcel.farm')}
            error={errors.farm}
            onLayout={(e) => {
              anchors.current.farm = e.nativeEvent.layout.y;
            }}
          >
            <FarmPicker
              farms={farms}
              loading={farmsQ.isLoading}
              selected={selectedFarm}
              onSelect={(id) => {
                setSelectedFarm(id);
                setErrors((prev) => ({ ...prev, farm: undefined }));
              }}
              creating={creatingFarm}
              newFarmName={newFarmName}
              onNewFarmName={setNewFarmName}
              onToggleCreate={() => setCreatingFarm((v) => !v)}
              onCreate={onCreateFarm}
              creatingBusy={createFarm.isPending}
              t={t}
            />
          </Field>
        ) : null}

        <Field label={t('parcel.crop')}>
          <View style={styles.chips}>
            {CROP_OPTIONS.map((c) => {
              const active = crop === c.value;
              return (
                <InteractivePressable
                  key={c.value}
                  haptic
                  style={[styles.chip, active && styles.chipActive]}
                  accessibilityLabel={t(c.labelKey)}
                  accessibilityState={{ selected: active }}
                  onPress={() => setCrop(active ? null : c.value)}
                >
                  <Ionicons name={c.icon} size={15} color={active ? colors.onPrimary : colors.textMuted} />
                  <Text
                    style={[styles.chipTxt, active && styles.chipTxtActive]}
                    maxFontSizeMultiplier={typeScale.maxMult}
                  >
                    {t(c.labelKey)}
                  </Text>
                </InteractivePressable>
              );
            })}
          </View>
        </Field>

        {/* everything non-essential waits behind one honest disclosure */}
        <InteractivePressable
          style={styles.disclosure}
          accessibilityLabel={t('parcel.optional_details')}
          accessibilityState={{ expanded: detailsOpen }}
          onLayout={(e) => {
            anchors.current.details = e.nativeEvent.layout.y;
          }}
          onPress={() => {
            haptics.selection();
            setDetailsOpen((v) => !v);
          }}
        >
          <Ionicons
            name={detailsOpen ? 'chevron-down' : 'chevron-forward'}
            size={16}
            color={colors.textMuted}
          />
          <Text style={styles.disclosureTxt} maxFontSizeMultiplier={typeScale.maxMult}>
            {t('parcel.optional_details')}
          </Text>
        </InteractivePressable>

        {detailsOpen ? (
          <View style={styles.detailsBox}>
            <Field label={t('parcel.variety')}>
              <TextInput
                style={styles.input}
                value={variety}
                onChangeText={setVariety}
                placeholder={t('parcel.variety_ph')}
                placeholderTextColor={colors.textMuted}
                accessibilityLabel={t('parcel.variety')}
              />
            </Field>

            <View>
              <DateField
                label={t('parcel.planting_date')}
                value={plantingDate}
                onChange={(v) => {
                  setPlantingDate(v);
                  if (errors.date) setErrors((prev) => ({ ...prev, date: undefined }));
                }}
              />
              {errors.date ? (
                <Text style={styles.inlineError} maxFontSizeMultiplier={typeScale.maxMult}>
                  {errors.date}
                </Text>
              ) : null}
            </View>

            <Field label={t('parcel.season_year')}>
              <TextInput
                style={styles.input}
                value={seasonYear}
                onChangeText={setSeasonYear}
                keyboardType="number-pad"
                maxLength={4}
                accessibilityLabel={t('parcel.season_year')}
              />
            </Field>

            <Field label={t('parcel.photo')}>
              {photo ? (
                <View style={styles.photoRow}>
                  <Image source={{ uri: photo.uri }} style={styles.photoThumb} contentFit="cover" />
                  <View style={styles.photoActions}>
                    <InteractivePressable
                      style={styles.secondaryBtn}
                      accessibilityLabel={t('parcel.photo_change')}
                      onPress={() => void pickPhotoFromLibrary()}
                    >
                      <Ionicons name="images" size={16} color={colors.primary} />
                      <Text style={styles.secondaryTxt} maxFontSizeMultiplier={typeScale.maxMult}>
                        {t('parcel.photo_change')}
                      </Text>
                    </InteractivePressable>
                    <InteractivePressable
                      style={styles.secondaryBtn}
                      accessibilityLabel={t('parcel.photo_remove')}
                      onPress={() => setPhoto(null)}
                    >
                      <Ionicons name="trash" size={16} color={colors.primary} />
                      <Text style={styles.secondaryTxt} maxFontSizeMultiplier={typeScale.maxMult}>
                        {t('parcel.photo_remove')}
                      </Text>
                    </InteractivePressable>
                  </View>
                </View>
              ) : (
                <View style={styles.chips}>
                  {Platform.OS !== 'web' ? (
                    <InteractivePressable
                      style={styles.secondaryBtn}
                      accessibilityLabel={t('parcel.photo_take')}
                      onPress={() => void pickPhotoFromCamera()}
                    >
                      <Ionicons name="camera" size={16} color={colors.primary} />
                      <Text style={styles.secondaryTxt} maxFontSizeMultiplier={typeScale.maxMult}>
                        {t('parcel.photo_take')}
                      </Text>
                    </InteractivePressable>
                  ) : null}
                  <InteractivePressable
                    style={styles.secondaryBtn}
                    accessibilityLabel={t('parcel.photo_pick')}
                    onPress={() => void pickPhotoFromLibrary()}
                  >
                    <Ionicons name="images" size={16} color={colors.primary} />
                    <Text style={styles.secondaryTxt} maxFontSizeMultiplier={typeScale.maxMult}>
                      {t('parcel.photo_pick')}
                    </Text>
                  </InteractivePressable>
                </View>
              )}
            </Field>
          </View>
        ) : null}
      </ScrollView>

      {/* save pinned to the bottom, above the home indicator */}
      <View style={[styles.saveBar, { paddingBottom: Math.max(insets.bottom, spacing.sm) + spacing.sm }]}>
        {formError ? (
          <View style={styles.formErrorBox}>
            <Text style={styles.inlineError} maxFontSizeMultiplier={typeScale.maxMult}>
              {formError.main}
            </Text>
            {formError.detail ? (
              <Text style={styles.errorDetail} maxFontSizeMultiplier={typeScale.maxMult}>
                {formError.detail}
              </Text>
            ) : null}
          </View>
        ) : null}
        <InteractivePressable
          haptic
          style={[styles.primaryBtn, busy && styles.disabled]}
          accessibilityLabel={t('common.save')}
          onPress={() => void onSubmit()}
          disabled={busy}
        >
          <TintCard gradient={gradients.forest} style={styles.primaryInner}>
            {busy ? (
              <ActivityIndicator color={colors.onPrimary} />
            ) : (
              <Text style={styles.primaryTxt} maxFontSizeMultiplier={typeScale.maxMult}>
                {t('common.save')}
              </Text>
            )}
          </TintCard>
        </InteractivePressable>
      </View>
    </KeyboardAvoidingView>
  );

  return (
    <>
      <Stack.Screen options={{ title: stepTitle }} />
      {step === 'boundary' ? boundaryStep : pendingFc ? bulkPanel : infoStep}
    </>
  );
}

type TFn = (key: string, opts?: Record<string, unknown>) => string;

function Field({
  label,
  error,
  onLayout,
  children,
}: {
  label: string;
  error?: string;
  onLayout?: (e: LayoutChangeEvent) => void;
  children: ReactNode;
}) {
  return (
    <View style={styles.field} onLayout={onLayout}>
      <Text style={styles.fieldLabel} maxFontSizeMultiplier={typeScale.maxMult}>
        {label}
      </Text>
      {children}
      {error ? (
        <Text style={styles.inlineError} maxFontSizeMultiplier={typeScale.maxMult}>
          {error}
        </Text>
      ) : null}
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
            <InteractivePressable
              key={f.id}
              haptic
              style={[styles.chip, active && styles.chipActive]}
              accessibilityLabel={f.name}
              accessibilityState={{ selected: active }}
              onPress={() => onSelect(f.id)}
            >
              <Text
                style={[styles.chipTxt, active && styles.chipTxtActive]}
                maxFontSizeMultiplier={typeScale.maxMult}
              >
                {f.name}
              </Text>
            </InteractivePressable>
          );
        })}
        <InteractivePressable
          style={[styles.chip, styles.chipAdd]}
          accessibilityLabel={t('parcel.new_farm')}
          onPress={props.onToggleCreate}
        >
          <Ionicons name="add" size={15} color={colors.primary} />
          <Text style={[styles.chipTxt, { color: colors.primary }]} maxFontSizeMultiplier={typeScale.maxMult}>
            {t('parcel.new_farm')}
          </Text>
        </InteractivePressable>
      </View>
      {creating ? (
        <View style={styles.newFarmRow}>
          <TextInput
            style={[styles.input, styles.flex1]}
            value={newFarmName}
            onChangeText={props.onNewFarmName}
            placeholder={t('parcel.farm_name_ph')}
            placeholderTextColor={colors.textMuted}
            accessibilityLabel={t('parcel.farm_name_ph')}
          />
          <InteractivePressable
            style={[styles.smallBtn, props.creatingBusy && styles.disabled]}
            accessibilityLabel={t('common.save')}
            onPress={props.onCreate}
            disabled={props.creatingBusy}
          >
            {props.creatingBusy ? (
              <ActivityIndicator color={colors.onPrimary} />
            ) : (
              <Text style={styles.primaryTxt} maxFontSizeMultiplier={typeScale.maxMult}>
                {t('common.save')}
              </Text>
            )}
          </InteractivePressable>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  kav: { flex: 1, backgroundColor: colors.bg },
  flex1: { flex: 1 },
  root: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.md, gap: spacing.md, paddingBottom: spacing.xl },
  segmentRow: { flexDirection: 'row', gap: spacing.sm },
  segment: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    minHeight: touch.min,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  segmentActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  segmentTxt: { fontSize: typeScale.body, fontFamily: fonts.body, color: colors.text, flexShrink: 1 },
  segmentTxtActive: { color: colors.onPrimary, fontFamily: fonts.bodySemiBold },
  fallbackCard: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.sm,
  },
  searchRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center' },
  searchBtn: {
    minWidth: touch.min,
    minHeight: touch.min,
    borderRadius: radius.md,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  resultRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: touch.min,
    paddingVertical: spacing.xs,
  },
  resultTxt: { flex: 1, fontSize: typeScale.body, fontFamily: fonts.body, color: colors.text },
  mapBox: { borderRadius: radius.md, overflow: 'hidden', borderWidth: 1, borderColor: colors.border },
  cadPanel: { gap: spacing.sm },
  cadStatusRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  cadCount: { fontSize: typeScale.body, fontFamily: fonts.bodySemiBold, color: colors.text },
  hint: { color: colors.textMuted, fontSize: 13, fontFamily: fonts.body, flexShrink: 1 },
  hintError: { color: colors.danger },
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardTitle: { fontSize: typeScale.bodyLg, fontFamily: fonts.display, color: colors.text },
  backRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    minHeight: touch.min,
    alignSelf: 'flex-start',
    paddingRight: spacing.md,
  },
  field: { gap: spacing.xs },
  fieldLabel: { fontSize: 13, fontFamily: fonts.bodySemiBold, color: colors.textMuted },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    minHeight: touch.min,
    fontSize: typeScale.bodyLg,
    fontFamily: fonts.body,
    color: colors.text,
    backgroundColor: colors.card,
  },
  inputError: { borderColor: colors.danger },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, alignItems: 'center' },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    minHeight: touch.chip,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipAdd: { borderStyle: 'dashed', borderColor: colors.primary },
  chipTxt: { fontSize: typeScale.body, fontFamily: fonts.body, color: colors.text },
  chipTxtActive: { color: colors.onPrimary, fontFamily: fonts.bodySemiBold },
  disclosure: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: touch.min,
  },
  disclosureTxt: { fontSize: typeScale.bodyLg, fontFamily: fonts.bodySemiBold, color: colors.text },
  detailsBox: { gap: spacing.md },
  newFarmRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm, alignItems: 'center' },
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
  primaryBtn: { borderRadius: radius.lg },
  primaryInner: {
    paddingVertical: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: touch.min,
    borderColor: 'transparent',
  },
  primaryTxt: { color: colors.onPrimary, fontFamily: fonts.bodyBold, fontSize: typeScale.bodyLg },
  smallBtn: {
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    justifyContent: 'center',
    alignItems: 'center',
    minHeight: touch.min,
  },
  secondaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    minHeight: touch.min,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.primary,
    alignSelf: 'flex-start',
  },
  secondaryTxt: { color: colors.primary, fontFamily: fonts.bodySemiBold, fontSize: typeScale.body },
  linkBtn: { alignItems: 'center', justifyContent: 'center', minHeight: touch.min },
  linkTxt: { color: colors.textMuted, fontSize: typeScale.body, fontFamily: fonts.body },
  disabled: { opacity: 0.5 },
  inlineError: { color: colors.danger, fontSize: typeScale.caption, fontFamily: fonts.bodySemiBold },
  errorDetail: { color: colors.textFaint, fontSize: typeScale.caption, fontFamily: fonts.mono },
  formErrorBox: { gap: 2 },
  saveBar: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    gap: spacing.sm,
    backgroundColor: colors.bg,
    borderTopWidth: 1,
    borderTopColor: colors.borderSoft,
  },
});
