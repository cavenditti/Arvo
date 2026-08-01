// OWNER: capture-observe — one-thumb field capture (docs/UX-REVAMP.md). Camera-first: the photo
// tiles lead, note and tags follow, and the location line speaks the farmer's language
// ("Dentro Uliveto Vecchio") instead of raw GPS decimals. Every permission dialog is primed with
// a PrimeCard before iOS asks. Save stays fully offline: local write + photo queue, then back.
import AsyncStorage from '@react-native-async-storage/async-storage';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as Crypto from 'expo-crypto';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import * as Location from 'expo-location';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { Observation, Parcel } from '@/api/types';
import PrimeCard from '@/components/PrimeCard';
import { useOnlineStatus } from '@/components/StaleBanner';
import { showToast } from '@/components/Toast';
import { TintCard } from '@/components/ui';
import { useOutsideDismiss } from '@/components/useOutsideDismiss';
import { useParcels } from '@/features/parcels/hooks';
import { OBSERVATION_TAGS } from '@/features/scouting/tags';
import { nearestParcel, pointInPolygon } from '@/lib/geo';
import * as haptics from '@/lib/haptics';
import { queuePhoto, upsertLocal } from '@/offline/queue';
import { colors, fonts, gradients, radius, spacing, touch, type as typeScale } from '@/theme';

// Priming flags — 'arvo.primed.location' is intentionally the same string parcel-flow uses,
// so the farmer sees the location pitch once, wherever he meets it first.
const CAMERA_PRIMED_KEY = 'arvo.primed.camera';
const LOCATION_PRIMED_KEY = 'arvo.primed.location';

const NEAR_MAX_M = 500;

type LocStatus = 'pending' | 'unprimed' | 'skipped' | 'ok' | 'denied' | 'unavailable';

interface LocalPhoto {
  uri: string;
  name: string;
  mime: string;
}

type LocationMatch =
  | { kind: 'inside'; parcel: Parcel }
  | { kind: 'near'; parcel: Parcel; distanceM: number }
  | { kind: 'far' };

export default function Screen() {
  const { t } = useTranslation();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const online = useOnlineStatus();
  // "Scout here"/"Rileva qui" from a parcel or map context preselects that parcel — the strongest
  // signal, never overridden by GPS. `plantId` arrives from the plant detail screen and pins the
  // note to that plant (FR-P-060) — carried through, never edited here.
  const { parcelId: initialParcelId, plantId, mode } = useLocalSearchParams<{
    parcelId?: string;
    plantId?: string;
    mode?: 'camera' | 'note';
  }>();
  const parcelsQ = useParcels();
  const parcels = parcelsQ.data ?? [];

  const [coords, setCoords] = useState<{ lat: number; lon: number } | null>(null);
  const [locStatus, setLocStatus] = useState<LocStatus>('pending');
  const [parcelId, setParcelId] = useState<string | null>(initialParcelId ?? null);
  const [parcelTouched, setParcelTouched] = useState(!!initialParcelId);
  const [note, setNote] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [customTag, setCustomTag] = useState('');
  const [photos, setPhotos] = useState<LocalPhoto[]>([]);
  const [cameraPrimed, setCameraPrimed] = useState(false);
  const [showCameraPrime, setShowCameraPrime] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<View | null>(null);
  const noteRef = useRef<TextInput | null>(null);
  const closePicker = useCallback(() => setPickerOpen(false), []);
  useOutsideDismiss(pickerRef, pickerOpen, closePicker);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /** The real system prompt + fix. Only ever called after priming (or with permission granted). */
  const detectLocation = useCallback(async () => {
    setLocStatus('pending');
    try {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (!mounted.current) return;
      if (!perm.granted) {
        setLocStatus('denied');
        return;
      }
      const pos = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      if (!mounted.current) return;
      setCoords({ lat: pos.coords.latitude, lon: pos.coords.longitude });
      setLocStatus('ok');
    } catch {
      if (mounted.current) setLocStatus('unavailable');
    }
  }, []);

  // Boot: never let iOS ask cold. Fetch straight away only when the prime was already shown
  // (or the permission already exists); otherwise park on the PrimeCard.
  useEffect(() => {
    let active = true;
    (async () => {
      let cameraFlag = false;
      let locationFlag = false;
      try {
        const pairs = await AsyncStorage.multiGet([CAMERA_PRIMED_KEY, LOCATION_PRIMED_KEY]);
        for (const [key, value] of pairs) {
          if (key === CAMERA_PRIMED_KEY) cameraFlag = value === '1';
          if (key === LOCATION_PRIMED_KEY) locationFlag = value === '1';
        }
      } catch {
        // storage unavailable — treat as unprimed
      }
      if (!active) return;
      setCameraPrimed(cameraFlag);
      if (locationFlag) {
        void detectLocation();
        return;
      }
      try {
        const perm = await Location.getForegroundPermissionsAsync();
        if (!active) return;
        if (perm.granted) {
          // Granted elsewhere — no pitch needed, remember it.
          void AsyncStorage.setItem(LOCATION_PRIMED_KEY, '1').catch(() => {});
          void detectLocation();
          return;
        }
      } catch {
        // fall through to priming
      }
      if (active) setLocStatus('unprimed');
    })();
    return () => {
      active = false;
    };
  }, [detectLocation]);

  const acceptLocationPrime = () => {
    void AsyncStorage.setItem(LOCATION_PRIMED_KEY, '1').catch(() => {});
    void detectLocation();
  };

  // Where the fix lands, in field terms: inside a parcel beats near one; far keeps quiet coords.
  // Derived at render (the compiler memoizes) — never stored, so it can't fight the user's pick.
  let match: LocationMatch | null = null;
  if (coords && parcels.length > 0) {
    const inside = parcels.find((p) => pointInPolygon(coords.lon, coords.lat, p.geometry));
    if (inside) {
      match = { kind: 'inside', parcel: inside };
    } else {
      const near = nearestParcel(parcels, coords.lon, coords.lat);
      match =
        near && near.distanceM < NEAR_MAX_M
          ? { kind: 'near', parcel: near.parcel, distanceM: near.distanceM }
          : { kind: 'far' };
    }
  }

  // GPS auto-pick is derived state: the user's own choice (or ?parcelId=) always wins over it.
  const autoParcel = !parcelTouched && match != null && match.kind !== 'far' ? match.parcel : null;
  const effectiveParcelId = autoParcel ? autoParcel.id : parcelId;
  const autoPicked = autoParcel != null;

  const selectedParcel = parcels.find((p) => p.id === effectiveParcelId) ?? null;

  const toggleTag = (tag: string) =>
    setTags((prev) => (prev.includes(tag) ? prev.filter((x) => x !== tag) : [...prev, tag]));

  const addCustomTag = () => {
    const v = customTag.trim().toLowerCase();
    if (v && !tags.includes(v)) setTags((prev) => [...prev, v]);
    setCustomTag('');
  };

  const addAssets = (assets: ImagePicker.ImagePickerAsset[]) => {
    setPhotos((prev) => [
      ...prev,
      ...assets.map((a, i) => ({
        uri: a.uri,
        name: a.fileName ?? `photo_${Date.now()}_${i}.jpg`,
        mime: a.mimeType ?? 'image/jpeg',
      })),
    ]);
  };

  const launchCamera = useCallback(async () => {
    try {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) return;
      const res = await ImagePicker.launchCameraAsync({ quality: 0.6 });
      if (!res.canceled && mounted.current) addAssets(res.assets);
    } catch {
      // camera unavailable (e.g. web) — silently ignore
    }
  }, []);

  // First camera use goes through the PrimeCard; a permission granted elsewhere skips the pitch.
  const pickFromCamera = async () => {
    if (cameraPrimed) {
      void launchCamera();
      return;
    }
    try {
      const perm = await ImagePicker.getCameraPermissionsAsync();
      if (perm.granted) {
        setCameraPrimed(true);
        void AsyncStorage.setItem(CAMERA_PRIMED_KEY, '1').catch(() => {});
        void launchCamera();
        return;
      }
    } catch {
      // fall through to priming
    }
    setShowCameraPrime(true);
  };

  // Speed-dial intents ("Scatta una foto" / "Nuova nota" from the + menu): run once after
  // the modal settles — camera goes through the normal priming path, note just gets focus.
  const modeHandled = useRef(false);
  useEffect(() => {
    if (modeHandled.current || !mode) return;
    modeHandled.current = true;
    const timer = setTimeout(() => {
      if (!mounted.current) return;
      if (mode === 'camera') void pickFromCamera();
      else if (mode === 'note') noteRef.current?.focus();
    }, 450);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot launch intent
  }, [mode]);

  const acceptCameraPrime = () => {
    setShowCameraPrime(false);
    setCameraPrimed(true);
    void AsyncStorage.setItem(CAMERA_PRIMED_KEY, '1').catch(() => {});
    void launchCamera();
  };

  const pickFromLibrary = async () => {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) return;
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsMultipleSelection: true,
        quality: 0.6,
      });
      if (!res.canceled) addAssets(res.assets);
    } catch {
      // ignore
    }
  };

  const removePhoto = (uri: string) => setPhotos((prev) => prev.filter((p) => p.uri !== uri));

  const canSave = note.trim().length > 0 || tags.length > 0 || photos.length > 0;

  const save = () => {
    const id = Crypto.randomUUID();
    const now = new Date().toISOString();
    // The pin belongs to the parcel we arrived from — if the user re-picks another parcel the
    // plant no longer applies, and storing both would pair a plant with a foreign parcel.
    const pinnedPlantId = plantId && effectiveParcelId === initialParcelId ? plantId : null;
    const obs: Observation = {
      id,
      parcel_id: effectiveParcelId,
      plant_id: pinnedPlantId,
      note: note.trim(),
      tags,
      photos: [],
      lon: coords?.lon ?? null,
      lat: coords?.lat ?? null,
      taken_at: now,
      updated_at: now,
      deleted: false,
    };
    // Offline-first: fire-and-forget local writes (serialized in the store), then leave.
    void upsertLocal(obs);
    for (const p of photos) {
      void queuePhoto({ obsId: id, localUri: p.uri, name: p.name, mime: p.mime });
    }
    haptics.success();
    showToast({ message: t(online ? 'toast.saved' : 'toast.saved_offline'), kind: 'success' });
    router.back();
  };

  // The location line, in the farmer's words. Raw decimals survive only as a quiet caption.
  const locationLine = (() => {
    if (locStatus === 'ok' && match?.kind === 'inside') {
      return t('observation.inside', {
        name: match.parcel.name,
        defaultValue: 'Dentro {{name}}',
      });
    }
    if (locStatus === 'ok' && match?.kind === 'near') {
      return t('observation.near', {
        name: match.parcel.name,
        m: Math.round(match.distanceM),
        defaultValue: 'A {{m}} m da {{name}}',
      });
    }
    if (locStatus === 'pending') return t('observation.location_detecting');
    if (locStatus === 'denied') return t('observation.location_denied');
    if (locStatus === 'unavailable') return t('observation.location_unavailable');
    return null;
  })();
  const coordsCaption =
    locStatus === 'ok' && coords && (match == null || match.kind === 'far')
      ? `${coords.lat.toFixed(3)}, ${coords.lon.toFixed(3)}`
      : null;

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      // Native stack header ≈ 44pt below the status bar (no useHeaderHeight in this navigator).
      keyboardVerticalOffset={Platform.OS === 'ios' ? insets.top + 44 : 0}
    >
      <Stack.Screen options={{ title: t('observation.new_title') }} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        {/* Photos — camera first: the thing the thumb reaches for in the field */}
        <View style={styles.section}>
          {showCameraPrime ? (
            <PrimeCard
              icon="camera-outline"
              titleKey="prime.camera_title"
              bodyKey="prime.camera_body"
              ctaKey="prime.camera_cta"
              laterKey="prime.camera_later"
              onAccept={acceptCameraPrime}
              onLater={() => setShowCameraPrime(false)}
            />
          ) : (
            <View style={styles.photoTiles}>
              <Pressable
                style={styles.cameraTile}
                onPress={() => void pickFromCamera()}
                accessibilityRole="button"
                accessibilityLabel={t('observation.take_photo_big', {
                  defaultValue: 'Scatta una foto',
                })}
              >
                <Ionicons name="camera-outline" size={34} color={colors.primary} />
                <Text style={styles.cameraTileText} maxFontSizeMultiplier={typeScale.maxMult}>
                  {t('observation.take_photo_big', { defaultValue: 'Scatta una foto' })}
                </Text>
              </Pressable>
              <Pressable
                style={styles.galleryTile}
                onPress={() => void pickFromLibrary()}
                accessibilityRole="button"
                accessibilityLabel={t('observation.pick_photo')}
              >
                <Ionicons name="images-outline" size={26} color={colors.primary} />
                <Text style={styles.galleryTileText} maxFontSizeMultiplier={typeScale.maxMult}>
                  {t('observation.pick_photo')}
                </Text>
              </Pressable>
            </View>
          )}
          {photos.length > 0 && (
            <View style={styles.thumbs}>
              {photos.map((p) => (
                <View key={p.uri} style={styles.thumbWrap}>
                  <Image source={{ uri: p.uri }} style={styles.thumb} contentFit="cover" />
                  <Pressable
                    style={styles.thumbRemove}
                    onPress={() => removePhoto(p.uri)}
                    hitSlop={12}
                    accessibilityRole="button"
                    accessibilityLabel={t('common.cancel')}
                  >
                    <Ionicons name="close" size={14} color={colors.onPrimary} />
                  </Pressable>
                </View>
              ))}
            </View>
          )}
        </View>

        {/* Note */}
        <View style={styles.section}>
          <Text style={styles.label} maxFontSizeMultiplier={typeScale.maxMult}>
            {t('observation.note')}
          </Text>
          <TextInput
            ref={noteRef}
            style={styles.noteInput}
            value={note}
            onChangeText={setNote}
            placeholder={t('observation.note_placeholder')}
            placeholderTextColor={colors.textMuted}
            multiline
            textAlignVertical="top"
          />
        </View>

        {/* Tags */}
        <View style={styles.section}>
          <Text style={styles.label} maxFontSizeMultiplier={typeScale.maxMult}>
            {t('observation.tags')}
          </Text>
          <View style={styles.tagWrap}>
            {OBSERVATION_TAGS.map((tag) => {
              const on = tags.includes(tag);
              return (
                <Pressable
                  key={tag}
                  style={[styles.tagChip, on && styles.tagChipOn]}
                  onPress={() => toggleTag(tag)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  accessibilityLabel={t(`tags.${tag}`, tag)}
                >
                  <Text
                    style={[styles.tagChipText, on && styles.tagChipTextOn]}
                    maxFontSizeMultiplier={typeScale.maxMult}
                  >
                    {t(`tags.${tag}`, tag)}
                  </Text>
                </Pressable>
              );
            })}
            {/* custom tags added by the user */}
            {tags
              .filter((tg) => !(OBSERVATION_TAGS as readonly string[]).includes(tg))
              .map((tg) => (
                <Pressable
                  key={tg}
                  style={[styles.tagChip, styles.tagChipOn]}
                  onPress={() => toggleTag(tg)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: true }}
                  accessibilityLabel={tg}
                >
                  <Text
                    style={[styles.tagChipText, styles.tagChipTextOn]}
                    maxFontSizeMultiplier={typeScale.maxMult}
                  >
                    {tg}
                  </Text>
                  <Ionicons name="close" size={14} color={colors.onPrimary} />
                </Pressable>
              ))}
          </View>
          <View style={styles.addTagRow}>
            <TextInput
              style={styles.addTagInput}
              value={customTag}
              onChangeText={setCustomTag}
              placeholder={t('observation.add_tag_placeholder')}
              placeholderTextColor={colors.textMuted}
              onSubmitEditing={addCustomTag}
              returnKeyType="done"
            />
            <Pressable
              style={styles.addTagBtn}
              onPress={addCustomTag}
              accessibilityRole="button"
              accessibilityLabel={t('observation.add_tag')}
            >
              <Text style={styles.addTagBtnText} maxFontSizeMultiplier={typeScale.maxMult}>
                {t('observation.add_tag')}
              </Text>
            </Pressable>
          </View>
        </View>

        {/* Location + field */}
        <View ref={pickerRef} style={styles.section}>
          <View style={styles.rowBetween}>
            <Text style={styles.label} maxFontSizeMultiplier={typeScale.maxMult}>
              {t('observation.parcel')}
            </Text>
            {autoPicked ? (
              <Text style={styles.autoTag} maxFontSizeMultiplier={typeScale.maxMult}>
                {t('observation.parcel_auto')}
              </Text>
            ) : null}
          </View>
          {locStatus === 'unprimed' ? (
            <PrimeCard
              icon="location-outline"
              titleKey="prime.location_title"
              bodyKey="prime.location_body"
              ctaKey="prime.location_cta"
              laterKey="prime.location_later"
              onAccept={acceptLocationPrime}
              onLater={() => setLocStatus('skipped')}
            />
          ) : (
            <>
              {locationLine ? (
                <View style={styles.locRow}>
                  <Ionicons
                    name={locStatus === 'ok' ? 'location' : 'location-outline'}
                    size={18}
                    color={locStatus === 'ok' ? colors.primary : colors.textMuted}
                  />
                  <Text style={styles.locText} maxFontSizeMultiplier={typeScale.maxMult}>
                    {locationLine}
                  </Text>
                </View>
              ) : null}
              {coordsCaption ? (
                <Text style={styles.locCaption} maxFontSizeMultiplier={typeScale.maxMult}>
                  {coordsCaption}
                </Text>
              ) : null}
              {(locStatus === 'denied' ||
                locStatus === 'unavailable' ||
                locStatus === 'skipped') && (
                <Text style={styles.hint} maxFontSizeMultiplier={typeScale.maxMult}>
                  {t('observation.location_manual_hint')}
                </Text>
              )}
            </>
          )}
          <Pressable
            style={styles.selector}
            accessibilityRole="button"
            accessibilityState={{ expanded: pickerOpen }}
            accessibilityLabel={t('observation.parcel')}
            onPress={() => setPickerOpen((o) => !o)}
          >
            <Text style={styles.selectorText} maxFontSizeMultiplier={typeScale.maxMult}>
              {selectedParcel ? selectedParcel.name : t('observation.parcel_none')}
            </Text>
            <Ionicons
              name={pickerOpen ? 'chevron-up' : 'chevron-down'}
              size={18}
              color={colors.textMuted}
            />
          </Pressable>
          {pickerOpen && (
            <View style={styles.options}>
              <Pressable
                style={styles.option}
                accessibilityRole="button"
                accessibilityLabel={t('observation.parcel_none')}
                onPress={() => {
                  setParcelId(null);
                  setParcelTouched(true);
                  setPickerOpen(false);
                }}
              >
                <Text style={styles.optionText} maxFontSizeMultiplier={typeScale.maxMult}>
                  {t('observation.parcel_none')}
                </Text>
                {effectiveParcelId === null && (
                  <Ionicons name="checkmark" size={18} color={colors.primary} />
                )}
              </Pressable>
              {parcels.map((p) => (
                <Pressable
                  key={p.id}
                  style={styles.option}
                  accessibilityRole="button"
                  accessibilityLabel={p.name}
                  onPress={() => {
                    setParcelId(p.id);
                    setParcelTouched(true);
                    setPickerOpen(false);
                  }}
                >
                  <Text style={styles.optionText} maxFontSizeMultiplier={typeScale.maxMult}>
                    {p.name}
                  </Text>
                  {effectiveParcelId === p.id && (
                    <Ionicons name="checkmark" size={18} color={colors.primary} />
                  )}
                </Pressable>
              ))}
            </View>
          )}
        </View>
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: spacing.sm + insets.bottom }]}>
        <Pressable
          style={[styles.saveBtn, !canSave && styles.saveBtnDisabled]}
          onPress={save}
          disabled={!canSave}
          accessibilityRole="button"
          accessibilityLabel={t('observation.save')}
          accessibilityState={{ disabled: !canSave }}
        >
          <TintCard gradient={gradients.forest} style={styles.saveBtnInner}>
            <Ionicons name="checkmark" size={20} color={colors.onPrimary} />
            <Text style={styles.saveBtnText} maxFontSizeMultiplier={typeScale.maxMult}>
              {t('observation.save')}
            </Text>
          </TintCard>
        </Pressable>
        {!canSave && (
          <Text style={styles.needHint} maxFontSizeMultiplier={typeScale.maxMult}>
            {t('observation.need_something', {
              defaultValue: 'Aggiungi una foto, una nota o una categoria per salvare',
            })}
          </Text>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.md, gap: spacing.lg, paddingBottom: spacing.xl },
  section: { gap: spacing.sm },
  label: { fontSize: typeScale.body, fontFamily: fonts.bodySemiBold, color: colors.textMuted },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  autoTag: { fontSize: typeScale.caption, color: colors.primary, fontFamily: fonts.bodySemiBold },
  locRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  locText: { fontSize: typeScale.bodyLg, fontFamily: fonts.bodyMedium, color: colors.text, flexShrink: 1 },
  locCaption: { fontSize: typeScale.caption, fontFamily: fonts.mono, color: colors.textFaint },
  hint: { fontSize: typeScale.body, fontFamily: fonts.body, color: colors.textMuted },
  photoTiles: { flexDirection: 'row', gap: spacing.sm },
  cameraTile: {
    flex: 2,
    minHeight: 120,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.primary,
    borderRadius: radius.lg,
    padding: spacing.md,
  },
  cameraTileText: {
    color: colors.primary,
    fontFamily: fonts.bodyBold,
    fontSize: typeScale.bodyLg,
    textAlign: 'center',
  },
  galleryTile: {
    flex: 1,
    minHeight: 120,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: spacing.sm,
  },
  galleryTileText: {
    color: colors.primary,
    fontFamily: fonts.bodySemiBold,
    fontSize: typeScale.body,
    textAlign: 'center',
  },
  selector: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: touch.min,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  selectorText: { fontSize: typeScale.bodyLg, fontFamily: fonts.body, color: colors.text },
  options: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    overflow: 'hidden',
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: touch.min,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSoft,
  },
  optionText: { fontSize: typeScale.bodyLg, fontFamily: fonts.body, color: colors.text },
  noteInput: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    minHeight: 96,
    fontSize: typeScale.bodyLg,
    fontFamily: fonts.body,
    color: colors.text,
  },
  tagWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  tagChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    minHeight: touch.chip,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  tagChipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  tagChipText: { fontSize: typeScale.body, fontFamily: fonts.body, color: colors.text },
  tagChipTextOn: { color: colors.onPrimary, fontFamily: fonts.bodySemiBold },
  addTagRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center' },
  addTagInput: {
    flex: 1,
    minHeight: touch.chip,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: typeScale.bodyLg,
    fontFamily: fonts.body,
    color: colors.text,
  },
  addTagBtn: {
    minHeight: touch.chip,
    justifyContent: 'center',
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.primary,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  addTagBtnText: { color: colors.primary, fontFamily: fonts.bodySemiBold, fontSize: typeScale.body },
  thumbs: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm },
  thumbWrap: { width: 84, height: 84 },
  thumb: { width: 84, height: 84, borderRadius: radius.sm },
  thumbRemove: {
    position: 'absolute',
    top: -6,
    right: -6,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
  },
  footer: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    gap: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.card,
  },
  saveBtn: {},
  saveBtnInner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    minHeight: touch.min,
    paddingVertical: spacing.sm,
    borderColor: 'transparent',
  },
  saveBtnDisabled: { opacity: 0.5 },
  saveBtnText: { color: colors.onPrimary, fontFamily: fonts.bodyBold, fontSize: typeScale.bodyLg },
  needHint: {
    fontSize: typeScale.body,
    fontFamily: fonts.body,
    color: colors.textMuted,
    textAlign: 'center',
  },
});
