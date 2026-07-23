// OWNER: fe-scouting — New observation: geolocation + nearest-parcel auto-pick, note, tags,
// photos (camera/library). Save is fully offline: local write + photo queue, no network awaits.
import Ionicons from '@expo/vector-icons/Ionicons';
import * as Crypto from 'expo-crypto';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import * as Location from 'expo-location';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import type { Observation } from '@/api/types';
import { TintCard } from '@/components/ui';
import { useOutsideDismiss } from '@/components/useOutsideDismiss';
import { nearestParcel, useParcels } from '@/features/scouting/parcels';
import { OBSERVATION_TAGS } from '@/features/scouting/tags';
import { queuePhoto, upsertLocal } from '@/offline/queue';
import { colors, fonts, gradients, radius, spacing } from '@/theme';

type LocStatus = 'pending' | 'ok' | 'denied' | 'unavailable';
interface LocalPhoto {
  uri: string;
  name: string;
  mime: string;
}

export default function Screen() {
  const { t } = useTranslation();
  const router = useRouter();
  // "Scout here"/"Record observation" from a parcel context preselects that parcel;
  // otherwise GPS auto-picks the nearest one below. `plantId` arrives from the plant detail
  // screen and pins the note to that plant (FR-P-060, docs/API-PLANT.md §Per-plant scouting) —
  // it is carried through, never edited here.
  const { parcelId: initialParcelId, plantId } = useLocalSearchParams<{
    parcelId?: string;
    plantId?: string;
  }>();
  const parcelsQ = useParcels();
  const parcels = useMemo(() => parcelsQ.data ?? [], [parcelsQ.data]);

  const [coords, setCoords] = useState<{ lat: number; lon: number } | null>(null);
  const [locStatus, setLocStatus] = useState<LocStatus>('pending');
  const [parcelId, setParcelId] = useState<string | null>(initialParcelId ?? null);
  const [parcelTouched, setParcelTouched] = useState(!!initialParcelId);
  const [autoPicked, setAutoPicked] = useState(false);
  const [note, setNote] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [customTag, setCustomTag] = useState('');
  const [photos, setPhotos] = useState<LocalPhoto[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<View | null>(null);
  const closePicker = useCallback(() => setPickerOpen(false), []);
  useOutsideDismiss(pickerRef, pickerOpen, closePicker);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const perm = await Location.requestForegroundPermissionsAsync();
        if (!perm.granted) {
          if (active) setLocStatus('denied');
          return;
        }
        const pos = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });
        if (!active) return;
        setCoords({ lat: pos.coords.latitude, lon: pos.coords.longitude });
        setLocStatus('ok');
      } catch {
        if (active) setLocStatus('unavailable');
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  // Auto-pick nearest parcel once coords + parcels are available (unless the user chose manually).
  useEffect(() => {
    if (parcelTouched || !coords || parcels.length === 0) return;
    const near = nearestParcel(parcels, coords.lat, coords.lon, 2);
    if (near) {
      setParcelId(near.id);
      setAutoPicked(true);
    }
  }, [coords, parcels, parcelTouched]);

  const selectedParcel = useMemo(
    () => parcels.find((p) => p.id === parcelId) ?? null,
    [parcels, parcelId],
  );

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

  const pickFromCamera = async () => {
    try {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) return;
      const res = await ImagePicker.launchCameraAsync({ quality: 0.6 });
      if (!res.canceled) addAssets(res.assets);
    } catch {
      // camera unavailable (e.g. web) — silently ignore
    }
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
    const pinnedPlantId = plantId && parcelId === initialParcelId ? plantId : null;
    const obs: Observation = {
      id,
      parcel_id: parcelId,
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
    router.back();
  };

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: t('observation.new_title') }} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {/* Location */}
        <View style={styles.section}>
          <Text style={styles.label}>{t('observation.location')}</Text>
          <View style={styles.locRow}>
            <Ionicons
              name={locStatus === 'ok' ? 'location' : 'location-outline'}
              size={18}
              color={locStatus === 'ok' ? colors.primary : colors.textMuted}
            />
            <Text style={styles.locText}>
              {locStatus === 'pending' && t('observation.location_detecting')}
              {locStatus === 'ok' &&
                coords &&
                `${coords.lat.toFixed(5)}, ${coords.lon.toFixed(5)}`}
              {locStatus === 'denied' && t('observation.location_denied')}
              {locStatus === 'unavailable' && t('observation.location_unavailable')}
            </Text>
          </View>
          {(locStatus === 'denied' || locStatus === 'unavailable') && (
            <Text style={styles.hint}>{t('observation.location_manual_hint')}</Text>
          )}
        </View>

        {/* Parcel */}
        <View ref={pickerRef} style={styles.section}>
          <View style={styles.rowBetween}>
            <Text style={styles.label}>{t('observation.parcel')}</Text>
            {autoPicked && !parcelTouched && parcelId ? (
              <Text style={styles.autoTag}>{t('observation.parcel_auto')}</Text>
            ) : null}
          </View>
          <Pressable
            style={styles.selector}
            accessibilityState={{ expanded: pickerOpen }}
            onPress={() => setPickerOpen((o) => !o)}
          >
            <Text style={styles.selectorText}>
              {selectedParcel ? selectedParcel.name : t('observation.parcel_none')}
            </Text>
            <Ionicons name={pickerOpen ? 'chevron-up' : 'chevron-down'} size={18} color={colors.textMuted} />
          </Pressable>
          {pickerOpen && (
            <View style={styles.options}>
              <Pressable
                style={styles.option}
                onPress={() => {
                  setParcelId(null);
                  setParcelTouched(true);
                  setPickerOpen(false);
                }}
              >
                <Text style={styles.optionText}>{t('observation.parcel_none')}</Text>
                {parcelId === null && <Ionicons name="checkmark" size={18} color={colors.primary} />}
              </Pressable>
              {parcels.map((p) => (
                <Pressable
                  key={p.id}
                  style={styles.option}
                  onPress={() => {
                    setParcelId(p.id);
                    setParcelTouched(true);
                    setPickerOpen(false);
                  }}
                >
                  <Text style={styles.optionText}>{p.name}</Text>
                  {parcelId === p.id && <Ionicons name="checkmark" size={18} color={colors.primary} />}
                </Pressable>
              ))}
            </View>
          )}
        </View>

        {/* Note */}
        <View style={styles.section}>
          <Text style={styles.label}>{t('observation.note')}</Text>
          <TextInput
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
          <Text style={styles.label}>{t('observation.tags')}</Text>
          <View style={styles.tagWrap}>
            {OBSERVATION_TAGS.map((tag) => {
              const on = tags.includes(tag);
              return (
                <Pressable
                  key={tag}
                  style={[styles.tagChip, on && styles.tagChipOn]}
                  onPress={() => toggleTag(tag)}
                >
                  <Text style={[styles.tagChipText, on && styles.tagChipTextOn]}>
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
                >
                  <Text style={[styles.tagChipText, styles.tagChipTextOn]}>{tg}</Text>
                  <Ionicons name="close" size={14} color="#fff" />
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
            <Pressable style={styles.addTagBtn} onPress={addCustomTag}>
              <Text style={styles.addTagBtnText}>{t('observation.add_tag')}</Text>
            </Pressable>
          </View>
        </View>

        {/* Photos */}
        <View style={styles.section}>
          <Text style={styles.label}>{t('observation.photos')}</Text>
          <View style={styles.photoBtns}>
            <Pressable style={styles.photoBtn} onPress={pickFromCamera}>
              <Ionicons name="camera-outline" size={20} color={colors.primary} />
              <Text style={styles.photoBtnText}>{t('observation.take_photo')}</Text>
            </Pressable>
            <Pressable style={styles.photoBtn} onPress={pickFromLibrary}>
              <Ionicons name="images-outline" size={20} color={colors.primary} />
              <Text style={styles.photoBtnText}>{t('observation.pick_photo')}</Text>
            </Pressable>
          </View>
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
                    <Ionicons name="close" size={14} color="#fff" />
                  </Pressable>
                </View>
              ))}
            </View>
          )}
        </View>
      </ScrollView>

      <View style={styles.footer}>
        <Pressable
          style={[styles.saveBtn, !canSave && styles.saveBtnDisabled]}
          onPress={save}
          disabled={!canSave}
        >
          <TintCard gradient={gradients.forest} style={styles.saveBtnInner}>
            <Ionicons name="checkmark" size={20} color={colors.onPrimary} />
            <Text style={styles.saveBtnText}>{t('observation.save')}</Text>
          </TintCard>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.md, gap: spacing.lg, paddingBottom: spacing.xl },
  section: { gap: spacing.sm },
  label: { fontSize: 13, fontFamily: fonts.bodySemiBold, color: colors.textMuted },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  autoTag: { fontSize: 12, color: colors.primary, fontFamily: fonts.bodySemiBold },
  locRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  locText: { fontSize: 15, fontFamily: fonts.body, color: colors.text },
  hint: { fontSize: 13, fontFamily: fonts.body, color: colors.textMuted },
  selector: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  selectorText: { fontSize: 15, fontFamily: fonts.body, color: colors.text },
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
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  optionText: { fontSize: 15, fontFamily: fonts.body, color: colors.text },
  noteInput: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    minHeight: 96,
    fontSize: 15,
    fontFamily: fonts.body,
    color: colors.text,
  },
  tagWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  tagChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  tagChipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  tagChipText: { fontSize: 14, fontFamily: fonts.body, color: colors.text },
  tagChipTextOn: { color: colors.onPrimary, fontFamily: fonts.bodySemiBold },
  addTagRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center' },
  addTagInput: {
    flex: 1,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: 15,
    fontFamily: fonts.body,
    color: colors.text,
  },
  addTagBtn: {
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  addTagBtnText: { color: '#fff', fontFamily: fonts.bodySemiBold },
  photoBtns: { flexDirection: 'row', gap: spacing.sm },
  photoBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.primary,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
  },
  photoBtnText: { color: colors.primary, fontFamily: fonts.bodySemiBold, fontSize: 15 },
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
    padding: spacing.md,
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
    paddingVertical: spacing.md,
    borderColor: 'transparent',
  },
  saveBtnDisabled: { opacity: 0.5 },
  saveBtnText: { color: colors.onPrimary, fontFamily: fonts.bodyBold, fontSize: 16 },
});
