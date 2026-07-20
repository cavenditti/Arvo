// OWNER: fe-capture — Flight registration → imagery upload → pipeline status (FR-P-010/012/014).
// One screen, three acts: register the flight (POST /captures), attach imagery
// (POST /captures/{id}/assets/{raw|ortho|dsm}, multipart with real byte progress), then watch the
// state machine (POST …/process → poll GET …/status every 5 s until `extracted`/`failed`, with a
// retry on the failed stage). Both upload paths of the contract are offered side by side: drone
// photos (server-side SfM) and a pre-built ortho + surface model (FR-P-014); `demo` synthesises a
// planting for servers built without GDAL (/meta features.imagery = false → capture.imagery_off,
// job error `stage_unsupported`).
// Terra: pipeline state is carried by the hero gradient + glyph badges and labelled chips —
// never a dot, never a left-border stripe; fonts are family tokens (never fontWeight).
import Ionicons from '@expo/vector-icons/Ionicons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { format, parseISO } from 'date-fns';
import * as DocumentPicker from 'expo-document-picker';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';
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

import { API_URL, ApiError, api, getAuthToken } from '@/api/client';
import {
  PLANT_UNITS,
  type Capture,
  type CaptureAssetKind,
  type CaptureSource,
  type CaptureStatus,
  type CaptureStatusInfo,
  type JobState,
  type Meta,
  type PipelineStage,
  type PlantUnit,
} from '@/api/types';
import { useAuth } from '@/auth/AuthContext';
import type { GlyphName } from '@/components/glyphs';
import { GlyphBadge, GlyphCard, MonoLabel, MonoValue, Pill, TintCard } from '@/components/ui';
import { dfLocale } from '@/features/insights/format';
import { notify } from '@/features/parcels/dialog';
import { useParcels } from '@/features/parcels/hooks';
import {
  useCapture,
  useCaptureStatus,
  useCreateCapture,
  useProcessCapture,
  useRetryCapture,
} from '@/features/plants/hooks';
import {
  colors,
  fonts,
  gradients,
  radius,
  severityTint,
  spacing,
  statusColors,
} from '@/theme';

const SOURCES: CaptureSource[] = ['drone', 'prebuilt', 'demo'];
const BANDS = ['red', 'green', 'blue', 'rededge', 'nir', 'swir'] as const;

const STAGES: PipelineStage[] = ['sfm', 'detect', 'register', 'extract'];
/** milestone reached → how far the machine has walked (docs/API-PLANT.md §Pipeline stages) */
const STATUS_RANK: Record<Exclude<CaptureStatus, 'failed'>, number> = {
  uploaded: 0,
  ortho: 1,
  detected: 2,
  registered: 3,
  extracted: 4,
};
/** stage → the rank of the status it produces on success */
const STAGE_OUT: Record<PipelineStage, number> = { sfm: 1, detect: 2, register: 3, extract: 4 };

/** `prebuilt`/`demo` skip SfM: /process sets `ortho` directly and enqueues `detect`. */
function stagesFor(source: CaptureSource): PipelineStage[] {
  return source === 'drone' ? STAGES : STAGES.slice(1);
}

function apiMessage(e: unknown, fallback: string): string {
  return e instanceof ApiError || e instanceof Error ? e.message || fallback : fallback;
}

// ─── Uploads ─────────────────────────────────────────────────────────────────

interface Picked {
  uri: string;
  name: string;
  mime: string;
  size: number;
  /** web only — the real File, so the part carries the right bytes and type */
  file?: File;
}

/** The server sniffs magic bytes, so declare the type the extension implies rather than the
 * `application/octet-stream` most desktops report for a .tif. */
function mimeFor(name: string, reported: string | undefined, kind: CaptureAssetKind): string {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (ext === 'tif' || ext === 'tiff') return 'image/tiff';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'zip') return 'application/zip';
  if (reported && reported !== 'application/octet-stream') return reported;
  return kind === 'raw' ? 'image/jpeg' : 'image/tiff';
}

function acceptFor(kind: CaptureAssetKind): string[] {
  const mimes =
    kind === 'raw' ? ['image/jpeg', 'image/tiff', 'application/zip'] : ['image/tiff'];
  if (Platform.OS !== 'web') return mimes;
  const exts = kind === 'raw' ? ['.jpg', '.jpeg', '.tif', '.tiff', '.zip'] : ['.tif', '.tiff'];
  return [...mimes, ...exts];
}

/** XHR rather than fetch: an ortho is GB-scale and the field needs a real byte counter. */
function uploadOne(
  captureId: string,
  kind: CaptureAssetKind,
  picked: Picked,
  onProgress: (loaded: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    if (picked.file) {
      form.append('file', picked.file.slice(0, picked.file.size, picked.mime), picked.name);
    } else {
      // React Native multipart file part
      form.append('file', {
        uri: picked.uri,
        name: picked.name,
        type: picked.mime,
      } as unknown as Blob);
    }
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_URL}/api/v1/captures/${captureId}/assets/${kind}`);
    const token = getAuthToken();
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.upload.onprogress = (e: ProgressEvent) => {
      if (e.lengthComputable) onProgress(e.loaded);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(picked.size);
        resolve();
        return;
      }
      let message = `HTTP ${xhr.status}`;
      try {
        const body = JSON.parse(xhr.responseText) as { error?: { message?: string } };
        if (body.error?.message) message = body.error.message;
      } catch {
        // non-JSON error body
      }
      reject(new Error(message));
    };
    // Empty message on purpose: the caller then shows the localized upload error.
    xhr.onerror = () => reject(new Error(''));
    xhr.send(form);
  });
}

function bytesText(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** RFC3339 stamps → epoch millis, dropping the nulls the job rows are full of. */
function epochs(values: (string | null | undefined)[]): number[] {
  const out: number[] = [];
  for (const v of values) {
    if (!v) continue;
    const n = Date.parse(v);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

function elapsedText(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

// ─── Terra tones (no dots: state lives in the surface + glyph badge + labelled chip) ──────────

function heroTone(status: CaptureStatus): {
  gradient: [string, string];
  glyph: GlyphName;
  tone: string;
} {
  if (status === 'failed') return { gradient: gradients.clay, glyph: 'thermo', tone: colors.accent };
  if (status === 'extracted')
    return { gradient: gradients.meadow, glyph: 'sprout', tone: colors.success };
  if (status === 'uploaded')
    return { gradient: gradients.paper, glyph: 'cloud', tone: colors.textFaint };
  return { gradient: gradients.eucalyptus, glyph: 'wind', tone: colors.info };
}

function stateBadge(state: JobState): { glyph: GlyphName; fg: string; bg: string } {
  if (state === 'succeeded')
    return { glyph: 'leaf', fg: statusColors.healthy.fg, bg: statusColors.healthy.bg };
  if (state === 'running')
    return { glyph: 'wind', fg: severityTint.info.fg, bg: severityTint.info.bg };
  if (state === 'failed')
    return { glyph: 'thermo', fg: severityTint.critical.fg, bg: severityTint.critical.bg };
  return { glyph: 'cloud', fg: colors.textFaint, bg: colors.borderSoft };
}

interface StageView {
  stage: PipelineStage;
  state: JobState;
  attempts: number;
  maxAttempts: number;
  error: string | null;
}

/** Job rows are the truth; before the worker writes them, derive the rail from the milestone. */
function stageViews(capture: Capture, info: CaptureStatusInfo | undefined): StageView[] {
  const status = info?.status ?? capture.status;
  const failedStage = info?.failed_stage ?? capture.failed_stage;
  const reached =
    status === 'failed'
      ? failedStage
        ? STAGE_OUT[failedStage] - 1
        : 0
      : STATUS_RANK[status];
  const jobs = new Map((capture.jobs ?? []).map((j) => [j.stage, j]));
  return stagesFor(capture.source).map((stage) => {
    const job = jobs.get(stage);
    if (job) {
      return {
        stage,
        state: job.state,
        attempts: job.attempts,
        maxAttempts: job.max_attempts,
        error: job.error,
      };
    }
    const state: JobState =
      reached >= STAGE_OUT[stage] ? 'succeeded' : failedStage === stage ? 'failed' : 'queued';
    return { stage, state, attempts: 0, maxAttempts: 3, error: null };
  });
}

// ─── Screen ──────────────────────────────────────────────────────────────────

export default function NewCaptureScreen() {
  const { t } = useTranslation();
  const { parcelId: paramParcelId, captureId: paramCaptureId } = useLocalSearchParams<{
    parcelId?: string;
    captureId?: string;
  }>();
  const [captureId, setCaptureId] = useState<string | null>(paramCaptureId ?? null);
  const [justCreated, setJustCreated] = useState(false);

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: t('capture.new_title') }} />
      {captureId ? (
        <FlightPanel
          captureId={captureId}
          justCreated={justCreated}
          onRestart={() => {
            setCaptureId(null);
            setJustCreated(false);
          }}
        />
      ) : (
        <RegisterForm
          initialParcelId={paramParcelId ?? null}
          onCreated={(id) => {
            setCaptureId(id);
            setJustCreated(true);
          }}
        />
      )}
    </View>
  );
}

// ─── Act 1 — register the flight ─────────────────────────────────────────────

function RegisterForm({
  initialParcelId,
  onCreated,
}: {
  initialParcelId: string | null;
  onCreated: (id: string) => void;
}) {
  const { t } = useTranslation();
  const { role } = useAuth();
  const parcelsQ = useParcels();
  const parcels = useMemo(() => parcelsQ.data ?? [], [parcelsQ.data]);
  const metaQ = useQuery({ queryKey: ['meta'], queryFn: () => api.get<Meta>('/meta') });
  // Assume imagery is on until /meta answers, so the hint never flashes on a healthy server.
  const imageryOn = metaQ.data?.features.imagery ?? true;
  // `source: "demo"` is [agronomist+] — hiding it beats offering a button that 403s.
  const canDemo = role === 'agronomist' || role === 'admin' || role === 'owner';

  const [parcelId, setParcelId] = useState<string | null>(initialParcelId);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [source, setSource] = useState<CaptureSource>('drone');
  const [unitType, setUnitType] = useState<PlantUnit>('tree');
  const [capturedAt, setCapturedAt] = useState(() => format(new Date(), 'yyyy-MM-dd'));
  const [sensor, setSensor] = useState('');
  const [gsdCm, setGsdCm] = useState('');
  const [bands, setBands] = useState<Record<string, string>>({ red: '1', green: '2', blue: '3' });
  const [pilotName, setPilotName] = useState('');
  const [operatorId, setOperatorId] = useState('');
  const [droneModel, setDroneModel] = useState('');
  const [flightRef, setFlightRef] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);

  const createM = useCreateCapture();
  const selected = parcels.find((p) => p.id === parcelId) ?? null;
  const showImagery = source !== 'demo';

  const submit = () => {
    setError(null);
    if (!parcelId) {
      setError(t('capture.err_parcel'));
      return;
    }
    const day = capturedAt.trim();
    const at = new Date(`${day}T12:00:00`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(at.getTime())) {
      setError(t('capture.err_date'));
      return;
    }
    let gsd: number | undefined;
    if (gsdCm.trim()) {
      gsd = Number(gsdCm.trim().replace(',', '.'));
      if (!Number.isFinite(gsd) || gsd < 0.1 || gsd > 100) {
        setError(t('capture.err_gsd'));
        return;
      }
    }
    const bandPayload: Record<string, number> = {};
    if (showImagery) {
      for (const key of BANDS) {
        const raw = bands[key]?.trim();
        if (!raw) continue;
        const n = Number(raw);
        if (Number.isInteger(n) && n >= 1 && n <= 16) bandPayload[key] = n;
      }
    }
    createM.mutate(
      {
        parcel_id: parcelId,
        captured_at: at.toISOString(),
        source,
        unit_type: unitType,
        sensor: sensor.trim() || undefined,
        gsd_cm: gsd,
        bands: Object.keys(bandPayload).length ? bandPayload : undefined,
        pilot_name: pilotName.trim() || undefined,
        operator_id: operatorId.trim() || undefined,
        drone_model: droneModel.trim() || undefined,
        flight_ref: flightRef.trim() || undefined,
        notes: notes.trim() || undefined,
      },
      {
        onSuccess: (capture) => onCreated(capture.id),
        onError: (e) => setError(apiMessage(e, t('capture.create_error'))),
      },
    );
  };

  return (
    <>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>{t('capture.new_title')}</Text>
        <Text style={styles.subtitle}>{t('capture.subtitle')}</Text>

        {/* Data source — the fork between the ODM path and the pre-built ortho path (FR-P-014) */}
        <View style={styles.section}>
          <Text style={styles.label}>{t('capture.source')}</Text>
          {SOURCES.filter((s) => s !== 'demo' || canDemo).map((s) => {
            const on = source === s;
            return (
              <Pressable
                key={s}
                style={[styles.choice, on && styles.choiceOn]}
                onPress={() => setSource(s)}
                accessibilityRole="radio"
                accessibilityState={{ selected: on }}
              >
                <View style={styles.choiceText}>
                  <Text style={[styles.choiceTitle, on && styles.choiceTitleOn]}>
                    {t(`capture.source.${s}`)}
                  </Text>
                  <Text style={styles.choiceHint}>{t(`capture.source_hint.${s}`)}</Text>
                </View>
                {on ? (
                  <Ionicons name="checkmark-circle-outline" size={20} color={colors.primary} />
                ) : null}
              </Pressable>
            );
          })}
          {!imageryOn && source !== 'demo' ? (
            <GlyphCard
              gradient={gradients.straw}
              glyph="cloud"
              glyphColor={colors.warning}
              glyphSize={92}
              style={styles.noticeCard}
            >
              <Text style={styles.noticeText}>{t('capture.imagery_off')}</Text>
              {canDemo ? (
                <Text style={styles.noticeHint}>{t('capture.source_hint.demo')}</Text>
              ) : null}
            </GlyphCard>
          ) : null}
        </View>

        {/* Parcel */}
        <View style={styles.section}>
          <Text style={styles.label}>{t('capture.parcel')}</Text>
          <Pressable style={styles.selector} onPress={() => setPickerOpen((o) => !o)}>
            <Text style={styles.selectorText}>
              {selected ? selected.name : t('capture.select_parcel')}
            </Text>
            <Ionicons
              name={pickerOpen ? 'chevron-up' : 'chevron-down'}
              size={18}
              color={colors.textMuted}
            />
          </Pressable>
          {pickerOpen ? (
            <View style={styles.options}>
              {parcels.map((p) => (
                <Pressable
                  key={p.id}
                  style={styles.option}
                  onPress={() => {
                    setParcelId(p.id);
                    setPickerOpen(false);
                  }}
                >
                  <Text style={styles.optionText}>{p.name}</Text>
                  {parcelId === p.id ? (
                    <Ionicons name="checkmark" size={18} color={colors.primary} />
                  ) : null}
                </Pressable>
              ))}
            </View>
          ) : null}
        </View>

        {/* Flight date */}
        <View style={styles.section}>
          <Text style={styles.label}>{t('capture.captured_at')}</Text>
          <TextInput
            style={styles.input}
            value={capturedAt}
            onChangeText={setCapturedAt}
            placeholder={t('capture.captured_at_ph')}
            placeholderTextColor={colors.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>

        {/* Unit type */}
        <View style={styles.section}>
          <Text style={styles.label}>{t('capture.unit_type')}</Text>
          <View style={styles.chipWrap}>
            {PLANT_UNITS.map((u) => {
              const on = unitType === u;
              return (
                <Pressable
                  key={u}
                  style={[styles.chip, on && styles.chipOn]}
                  onPress={() => setUnitType(u)}
                >
                  <Text style={[styles.chipText, on && styles.chipTextOn]}>
                    {t(`plant.unit.${u}`)}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        {/* Sensor + ground resolution */}
        <View style={styles.section}>
          <Text style={styles.label}>{t('capture.sensor')}</Text>
          <TextInput
            style={styles.input}
            value={sensor}
            onChangeText={setSensor}
            placeholder={t('capture.sensor_ph')}
            placeholderTextColor={colors.textFaint}
          />
          <Text style={styles.label}>{t('capture.gsd')}</Text>
          <TextInput
            style={styles.input}
            value={gsdCm}
            onChangeText={setGsdCm}
            placeholder={t('capture.gsd_ph')}
            placeholderTextColor={colors.textFaint}
            keyboardType="decimal-pad"
          />
        </View>

        {/* Bands — only meaningful when real pixels get sampled */}
        {showImagery ? (
          <View style={styles.section}>
            <Text style={styles.label}>{t('capture.bands')}</Text>
            <Text style={styles.hint}>{t('capture.bands_hint')}</Text>
            <View style={styles.bandGrid}>
              {BANDS.map((b) => (
                <View key={b} style={styles.bandCell}>
                  <MonoLabel>{t(`capture.band.${b}`)}</MonoLabel>
                  <TextInput
                    style={[styles.input, styles.bandInput]}
                    value={bands[b] ?? ''}
                    onChangeText={(v) => setBands((prev) => ({ ...prev, [b]: v }))}
                    keyboardType="number-pad"
                    maxLength={2}
                    placeholder="—"
                    placeholderTextColor={colors.textFaint}
                  />
                </View>
              ))}
            </View>
          </View>
        ) : null}

        {/* Flight details (EASA record, NFR-P-OPS) */}
        <View style={styles.section}>
          <Text style={styles.label}>{t('capture.flight_meta')}</Text>
          <TextInput
            style={styles.input}
            value={pilotName}
            onChangeText={setPilotName}
            placeholder={t('capture.pilot_name')}
            placeholderTextColor={colors.textFaint}
          />
          <TextInput
            style={styles.input}
            value={operatorId}
            onChangeText={setOperatorId}
            placeholder={t('capture.operator_id')}
            placeholderTextColor={colors.textFaint}
            autoCapitalize="characters"
          />
          <TextInput
            style={styles.input}
            value={droneModel}
            onChangeText={setDroneModel}
            placeholder={t('capture.drone_model')}
            placeholderTextColor={colors.textFaint}
          />
          <TextInput
            style={styles.input}
            value={flightRef}
            onChangeText={setFlightRef}
            placeholder={t('capture.flight_ref')}
            placeholderTextColor={colors.textFaint}
          />
        </View>

        {/* Notes */}
        <View style={styles.section}>
          <Text style={styles.label}>{t('capture.notes')}</Text>
          <TextInput
            style={[styles.input, styles.textArea]}
            value={notes}
            onChangeText={setNotes}
            placeholder={t('capture.notes_ph')}
            placeholderTextColor={colors.textFaint}
            multiline
            textAlignVertical="top"
          />
        </View>

        {error ? <Text style={styles.errorText}>{error}</Text> : null}
      </ScrollView>

      <View style={styles.footer}>
        <PrimaryButton
          label={t('capture.create')}
          icon="airplane-outline"
          busy={createM.isPending}
          onPress={submit}
        />
      </View>
    </>
  );
}

// ─── Act 2 + 3 — upload the imagery, then watch the pipeline ─────────────────

function FlightPanel({
  captureId,
  justCreated,
  onRestart,
}: {
  captureId: string;
  justCreated: boolean;
  onRestart: () => void;
}) {
  const { t } = useTranslation();
  const router = useRouter();
  const qc = useQueryClient();
  const captureQ = useCapture(captureId);
  const statusQ = useCaptureStatus(captureId);
  const parcelsQ = useParcels();
  const metaQ = useQuery({ queryKey: ['meta'], queryFn: () => api.get<Meta>('/meta') });
  const processM = useProcessCapture();
  const retryM = useRetryCapture();

  const [uploading, setUploading] = useState<{
    kind: CaptureAssetKind;
    loaded: number;
    total: number;
    index: number;
    count: number;
  } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // Known only for a run started in this session; a deep-linked run reads it off the job rows.
  const [localStart, setLocalStart] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const capture = captureQ.data;
  const info = statusQ.data;
  const status = info?.status ?? capture?.status ?? 'uploaded';
  const terminal = status === 'extracted' || status === 'failed';

  // The 5 s poll is the cheap target; pull the expensive detail (assets + jobs) only when it moves.
  const signature = info
    ? `${info.status}:${info.stage}:${info.state}:${info.attempts}`
    : '';
  const lastSignature = useRef('');
  useEffect(() => {
    if (!signature || signature === lastSignature.current) return;
    lastSignature.current = signature;
    void qc.invalidateQueries({ queryKey: ['capture', captureId] });
  }, [signature, captureId, qc]);

  const jobs = capture?.jobs ?? [];
  const startTimes = epochs(jobs.map((j) => j.started_at));
  const startedAt = startTimes.length ? Math.min(...startTimes) : localStart;
  const endTimes = terminal
    ? epochs([...jobs.map((j) => j.finished_at), capture?.processed_at])
    : [];
  const finishedAt = endTimes.length ? Math.max(...endTimes) : null;

  const running = !!startedAt && !terminal;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  if (captureQ.isLoading || !capture) {
    return (
      <View style={styles.centered}>
        {captureQ.isError ? (
          <Text style={styles.errorText}>{t('capture.load_error')}</Text>
        ) : (
          <ActivityIndicator color={colors.primary} />
        )}
      </View>
    );
  }

  const parcel = (parcelsQ.data ?? []).find((p) => p.id === capture.parcel_id) ?? null;
  const stages = stageViews(capture, info);
  const current = stages.find((s) => s.state === 'running') ?? stages.find((s) => s.state === 'queued');
  const failedStage = info?.failed_stage ?? capture.failed_stage;
  const errorMessage = info?.error ?? capture.error;
  const counts = info?.asset_counts ?? {
    raw: (capture.assets ?? []).filter((a) => a.kind === 'raw').length,
    ortho: (capture.assets ?? []).filter((a) => a.kind === 'ortho').length,
    dsm: (capture.assets ?? []).filter((a) => a.kind === 'dsm').length,
  };
  const needsDsm = capture.unit_type === 'tree' || capture.unit_type === 'bush';
  const started = status !== 'uploaded' || (capture.jobs ?? []).length > 0;
  // A server built without GDAL fails every real-imagery stage with `stage_unsupported`; say so
  // before the bytes are uploaded, not after (docs/API-PLANT.md §Pipeline stages).
  const imageryOff = metaQ.data ? !metaQ.data.features.imagery : false;
  const unsupported = !!errorMessage?.includes('stage_unsupported');
  const tone = heroTone(status);
  const elapsed = startedAt ? elapsedText((finishedAt ?? now) - startedAt) : null;

  let blocked: string | null = null;
  if (capture.source === 'drone' && counts.raw === 0) blocked = t('capture.err_no_raw');
  else if (capture.source === 'prebuilt' && counts.ortho === 0) blocked = t('capture.err_no_ortho');
  else if (capture.source === 'prebuilt' && needsDsm && counts.dsm === 0)
    blocked = t('capture.err_no_dsm');

  const pickAndUpload = async (kind: CaptureAssetKind) => {
    setActionError(null);
    let picked: Picked[];
    try {
      const res = await DocumentPicker.getDocumentAsync({
        type: acceptFor(kind),
        multiple: kind === 'raw',
      });
      if (res.canceled || !res.assets?.length) return;
      picked = res.assets.map((a) => ({
        uri: a.uri,
        name: a.name,
        mime: mimeFor(a.name, a.mimeType, kind),
        size: a.size ?? 0,
        file: a.file,
      }));
    } catch (e) {
      setActionError(apiMessage(e, t('capture.upload_error')));
      return;
    }
    const total = picked.reduce((sum, f) => sum + f.size, 0);
    let done = 0;
    setUploading({ kind, loaded: 0, total, index: 0, count: picked.length });
    try {
      for (let i = 0; i < picked.length; i++) {
        const file = picked[i];
        await uploadOne(captureId, kind, file, (loaded) =>
          setUploading({ kind, loaded: done + loaded, total, index: i, count: picked.length }),
        );
        done += file.size;
      }
      await qc.invalidateQueries({ queryKey: ['capture', captureId] });
      void qc.invalidateQueries({ queryKey: ['capture-status', captureId] });
      notify(t('capture.upload_done', { count: picked.length }));
    } catch (e) {
      setActionError(apiMessage(e, t('capture.upload_error')));
    } finally {
      setUploading(null);
    }
  };

  const startProcessing = () => {
    setActionError(null);
    if (blocked) {
      setActionError(blocked);
      return;
    }
    setLocalStart(Date.now());
    processM.mutate(captureId, {
      onError: (e) => setActionError(apiMessage(e, t('capture.process_error'))),
    });
  };

  const retryStage = () => {
    setActionError(null);
    setLocalStart(Date.now());
    retryM.mutate(
      { id: captureId, stage: failedStage ?? undefined },
      { onError: (e) => setActionError(apiMessage(e, t('capture.retry_error'))) },
    );
  };

  const uploadPct =
    uploading && uploading.total > 0
      ? Math.min(99, Math.round((uploading.loaded / uploading.total) * 100))
      : 0;

  return (
    <>
      <ScrollView contentContainerStyle={styles.content}>
        {/* Hero — the pipeline condition, told in plain language */}
        <GlyphCard
          gradient={tone.gradient}
          glyph={tone.glyph}
          glyphColor={tone.tone}
          glyphSize={150}
          style={styles.hero}
        >
          <MonoLabel>
            {[
              parcel?.name,
              format(parseISO(capture.captured_at), 'd MMM yyyy', { locale: dfLocale() }),
              t(`capture.source.${capture.source}`),
            ]
              .filter(Boolean)
              .join(' · ')}
          </MonoLabel>
          <Text style={styles.heroTitle}>
            {terminal || !started ? t(`capture.status.${status}`) : t('capture.processing')}
          </Text>
          <Text style={styles.heroBody}>
            {!started
              ? justCreated
                ? `${t('capture.created')} ${t('capture.subtitle')}`
                : t('capture.subtitle')
              : status === 'extracted'
                ? t('capture.stage_hint.extract')
                : status === 'failed'
                  ? t('capture.failed_at_stage', {
                      stage: failedStage ? t(`capture.stage.${failedStage}`) : '—',
                    })
                  : t(`capture.stage_hint.${current?.stage ?? 'detect'}`)}
          </Text>
          {elapsed ? (
            <View style={styles.heroMeta}>
              <MonoValue size={20} color={colors.text}>
                {elapsed}
              </MonoValue>
              {current && !terminal ? (
                <MonoLabel color={colors.textMuted}>
                  {`${t('capture.stage_label')} · ${t(`capture.stage.${current.stage}`)}`}
                </MonoLabel>
              ) : null}
            </View>
          ) : null}
          {status === 'extracted' ? (
            <View style={styles.heroStats}>
              <MonoValue size={18} color={colors.text}>
                {t('capture.plants_found', { count: info?.plant_count ?? capture.plant_count })}
              </MonoValue>
              <MonoValue size={18} color={colors.text}>
                {t('capture.observations_found', {
                  count: info?.observation_count ?? capture.observation_count,
                })}
              </MonoValue>
              {capture.processed_at ? (
                <MonoLabel>
                  {t('capture.processed_at', {
                    date: format(parseISO(capture.processed_at), 'd MMM HH:mm', {
                      locale: dfLocale(),
                    }),
                  })}
                </MonoLabel>
              ) : null}
            </View>
          ) : null}
        </GlyphCard>

        {/* Failure — the message a field user can act on, no logs required */}
        {status === 'failed' ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>{t('capture.error_detail')}</Text>
            <Text style={styles.errorText}>
              {unsupported
                ? t('capture.error_stage_unsupported')
                : (errorMessage ?? t('capture.status.failed'))}
            </Text>
            {unsupported ? (
              <>
                <MonoLabel color={colors.textFaint}>{errorMessage}</MonoLabel>
                {/* Retrying the same stage would fail identically — the way out is a demo flight. */}
                <Pressable style={styles.secondaryBtn} onPress={onRestart}>
                  <Ionicons name="add" size={18} color={colors.primary} />
                  <Text style={styles.secondaryBtnText}>{t('capture.new_title')}</Text>
                </Pressable>
              </>
            ) : null}
          </View>
        ) : null}

        {/* Same warning, before the bytes go up rather than after */}
        {imageryOff && capture.source !== 'demo' && !started ? (
          <GlyphCard
            gradient={gradients.straw}
            glyph="cloud"
            glyphColor={colors.warning}
            glyphSize={92}
            style={styles.noticeCard}
          >
            <Text style={styles.noticeText}>{t('capture.imagery_off')}</Text>
            <Text style={styles.noticeHint}>{t('capture.source_hint.demo')}</Text>
          </GlyphCard>
        ) : null}

        {/* Imagery — the two contract paths; demo needs no bytes at all */}
        {capture.source !== 'demo' ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>{t('capture.assets')}</Text>
            {capture.source === 'drone' ? (
              <UploadRow
                kind="raw"
                count={counts.raw}
                disabled={status !== 'uploaded' || !!uploading}
                onPress={() => void pickAndUpload('raw')}
              />
            ) : (
              <>
                <UploadRow
                  kind="ortho"
                  count={counts.ortho}
                  disabled={(status !== 'uploaded' && status !== 'failed') || !!uploading}
                  onPress={() => void pickAndUpload('ortho')}
                />
                <UploadRow
                  kind="dsm"
                  count={counts.dsm}
                  disabled={(status !== 'uploaded' && status !== 'failed') || !!uploading}
                  onPress={() => void pickAndUpload('dsm')}
                />
              </>
            )}

            {uploading ? (
              <View style={styles.uploadState}>
                <ActivityIndicator color={colors.primary} />
                <View style={styles.uploadStateText}>
                  <Text style={styles.uploadPct}>
                    {t('capture.uploading', { pct: uploadPct })}
                  </Text>
                  <MonoLabel>
                    {uploading.total > 0
                      ? `${uploading.index + 1}/${uploading.count} · ${bytesText(uploading.loaded)} / ${bytesText(uploading.total)}`
                      : `${uploading.index + 1}/${uploading.count}`}
                  </MonoLabel>
                </View>
              </View>
            ) : null}

            {(capture.assets ?? []).length === 0 && !uploading ? (
              <Text style={styles.hint}>{t('capture.no_assets')}</Text>
            ) : null}
            {(capture.assets ?? []).slice(0, 8).map((a) => (
              <View key={a.id} style={styles.assetRow}>
                <Text style={styles.assetName} numberOfLines={1}>
                  {a.file_name}
                </Text>
                <MonoLabel>{bytesText(a.bytes)}</MonoLabel>
              </View>
            ))}
            {(capture.assets ?? []).length > 8 ? (
              <MonoLabel>
                {t('capture.file_count', { count: (capture.assets ?? []).length })}
              </MonoLabel>
            ) : null}
          </View>
        ) : null}

        {/* The rail: every stage, its state, and what it is actually doing */}
        {started ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>{t('capture.status_label')}</Text>
            {stages.map((s, i) => {
              const badge = stateBadge(s.state);
              return (
                <View key={s.stage} style={styles.stageRow}>
                  <View style={styles.stageRail}>
                    <GlyphBadge glyph={badge.glyph} fg={badge.fg} bg={badge.bg} size={30} />
                    {i < stages.length - 1 ? <View style={styles.stageConnector} /> : null}
                  </View>
                  <View style={styles.stageBody}>
                    <View style={styles.rowBetween}>
                      <Text style={styles.stageName}>{t(`capture.stage.${s.stage}`)}</Text>
                      <Pill
                        label={t(`capture.job_state.${s.state}`)}
                        fg={badge.fg}
                        bg={badge.bg}
                      />
                    </View>
                    <Text style={styles.stageHint}>{t(`capture.stage_hint.${s.stage}`)}</Text>
                    {s.attempts > 1 ? (
                      <MonoLabel>
                        {t('capture.attempts', { attempts: s.attempts, max: s.maxAttempts })}
                      </MonoLabel>
                    ) : null}
                    {s.state === 'failed' && s.error ? (
                      <Text style={styles.stageError}>
                        {s.error.includes('stage_unsupported')
                          ? t('capture.error_stage_unsupported')
                          : s.error}
                      </Text>
                    ) : null}
                  </View>
                </View>
              );
            })}
          </View>
        ) : null}

        {actionError ? <Text style={styles.errorText}>{actionError}</Text> : null}
        {!started && blocked ? <Text style={styles.hint}>{blocked}</Text> : null}
      </ScrollView>

      <View style={styles.footer}>
        {status === 'failed' ? (
          <PrimaryButton
            label={t('capture.retry')}
            icon="refresh"
            busy={retryM.isPending}
            onPress={retryStage}
          />
        ) : status === 'extracted' ? (
          <PrimaryButton
            label={t('capture.view_plants')}
            icon="leaf-outline"
            onPress={() => router.push(`/parcel/${capture.parcel_id}`)}
          />
        ) : started ? (
          <View style={styles.waitRow}>
            <ActivityIndicator color={colors.primary} />
            <Text style={styles.waitText}>{t('capture.processing')}</Text>
          </View>
        ) : (
          <PrimaryButton
            label={t('capture.process')}
            icon="play"
            busy={processM.isPending}
            disabled={!!blocked || !!uploading}
            onPress={startProcessing}
          />
        )}
      </View>
    </>
  );
}

function UploadRow({
  kind,
  count,
  disabled,
  onPress,
}: {
  kind: CaptureAssetKind;
  count: number;
  disabled: boolean;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  const action =
    kind === 'raw'
      ? 'capture.upload_raw'
      : kind === 'ortho'
        ? 'capture.upload_ortho'
        : 'capture.upload_dsm';
  return (
    <Pressable
      style={[styles.uploadBtn, disabled && styles.disabled]}
      onPress={onPress}
      disabled={disabled}
    >
      <Ionicons name="cloud-upload-outline" size={20} color={colors.primary} />
      <View style={styles.uploadText}>
        <Text style={styles.uploadTitle}>{t(action)}</Text>
        <Text style={styles.uploadHint}>{t(`capture.upload_hint_${kind}`)}</Text>
      </View>
      {count > 0 ? (
        <Pill
          label={t('capture.file_count', { count })}
          fg={statusColors.healthy.fg}
          bg={statusColors.healthy.bg}
        />
      ) : null}
    </Pressable>
  );
}

function PrimaryButton({
  label,
  icon,
  busy,
  disabled,
  onPress,
}: {
  label: string;
  icon: ComponentProps<typeof Ionicons>['name'];
  busy?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  const off = !!disabled || !!busy;
  return (
    <Pressable onPress={onPress} disabled={off} style={off ? styles.disabled : undefined}>
      <TintCard gradient={gradients.forest} style={styles.primaryBtn}>
        {busy ? (
          <ActivityIndicator color={colors.onPrimary} />
        ) : (
          <Ionicons name={icon} size={20} color={colors.onPrimary} />
        )}
        <Text style={styles.primaryBtnText}>{label}</Text>
      </TintCard>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg },
  content: { padding: spacing.md, gap: spacing.md, paddingBottom: spacing.xl },
  title: { fontFamily: fonts.display, fontSize: 24, color: colors.text },
  subtitle: { fontFamily: fonts.body, fontSize: 14, color: colors.textMuted },
  section: { gap: spacing.sm },
  label: { fontSize: 13, fontFamily: fonts.bodySemiBold, color: colors.textMuted },
  hint: { fontSize: 13, fontFamily: fonts.body, color: colors.textMuted },
  errorText: { fontSize: 14, fontFamily: fonts.bodyMedium, color: colors.danger },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },

  // source / parcel pickers
  choice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  choiceOn: { backgroundColor: colors.primarySoft, borderColor: colors.primary },
  choiceText: { flex: 1, gap: 2 },
  choiceTitle: { fontSize: 15, fontFamily: fonts.bodySemiBold, color: colors.text },
  choiceTitleOn: { color: colors.primary },
  choiceHint: { fontSize: 13, fontFamily: fonts.body, color: colors.textMuted },
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
    borderBottomColor: colors.borderSoft,
  },
  optionText: { fontSize: 15, fontFamily: fonts.body, color: colors.text },

  // inputs
  input: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    fontSize: 15,
    fontFamily: fonts.body,
    color: colors.text,
  },
  textArea: { minHeight: 88 },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  chipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 14, fontFamily: fonts.body, color: colors.text },
  chipTextOn: { color: colors.onPrimary, fontFamily: fonts.bodySemiBold },
  bandGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  bandCell: { width: 96, gap: spacing.xs },
  bandInput: { paddingVertical: spacing.sm, textAlign: 'center' },

  // notices + cards
  noticeCard: { padding: spacing.md, gap: spacing.xs },
  noticeText: { fontSize: 14, fontFamily: fonts.bodyMedium, color: colors.text },
  noticeHint: { fontSize: 13, fontFamily: fonts.body, color: colors.textMuted },
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.sm,
  },
  cardTitle: { fontSize: 17, fontFamily: fonts.display, color: colors.text },

  // hero
  hero: { padding: spacing.md, gap: spacing.xs, borderRadius: radius.xl },
  heroTitle: { fontSize: 22, fontFamily: fonts.display, color: colors.text },
  heroBody: { fontSize: 14, fontFamily: fonts.body, color: colors.textMuted, maxWidth: '86%' },
  heroMeta: { marginTop: spacing.sm, gap: 2 },
  heroStats: { marginTop: spacing.sm, gap: 2 },

  // uploads
  uploadBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.cardAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  uploadText: { flex: 1, gap: 2 },
  uploadTitle: { fontSize: 15, fontFamily: fonts.bodySemiBold, color: colors.primary },
  uploadHint: { fontSize: 13, fontFamily: fonts.body, color: colors.textMuted },
  uploadState: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  uploadStateText: { flex: 1, gap: 2 },
  uploadPct: { fontSize: 14, fontFamily: fonts.bodyMedium, color: colors.text },
  assetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingVertical: spacing.xs,
  },
  assetName: { flex: 1, fontSize: 14, fontFamily: fonts.body, color: colors.text },

  // pipeline rail
  stageRow: { flexDirection: 'row', gap: spacing.sm },
  stageRail: { width: 30, alignItems: 'center' },
  stageConnector: { flex: 1, width: 1, backgroundColor: colors.border, marginVertical: 4 },
  stageBody: { flex: 1, gap: 2, paddingBottom: spacing.md },
  stageName: { flex: 1, fontSize: 15, fontFamily: fonts.bodySemiBold, color: colors.text },
  stageHint: { fontSize: 13, fontFamily: fonts.body, color: colors.textMuted },
  stageError: { fontSize: 13, fontFamily: fonts.bodyMedium, color: colors.danger },

  // footer
  footer: {
    padding: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.card,
  },
  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    borderColor: 'transparent',
    borderRadius: radius.lg,
  },
  primaryBtnText: { color: colors.onPrimary, fontFamily: fonts.bodyBold, fontSize: 16 },
  secondaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    marginTop: spacing.sm,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.primary,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
  },
  secondaryBtnText: { color: colors.primary, fontFamily: fonts.bodySemiBold, fontSize: 15 },
  disabled: { opacity: 0.5 },
  waitRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
  },
  waitText: { fontSize: 15, fontFamily: fonts.bodyMedium, color: colors.textMuted },
});
