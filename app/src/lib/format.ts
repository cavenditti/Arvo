// OWNER: foundation-ui — locale-aware number/date formatting (docs/UX-REVAMP.md frozen contract).
// One voice for every number and date the farmer reads: Intl.NumberFormat for numbers
// (Hermes supports it), date-fns for prose dates. Never ISO YYYY-MM-DD in user-visible text.
import { format as dfFormat, isValid, parseISO } from 'date-fns';
import { enUS, it } from 'date-fns/locale';

import i18n from '@/i18n';

function isItalian(): boolean {
  return i18n.language?.startsWith('it') ?? true;
}

function numberLocale(): string {
  return isItalian() ? 'it-IT' : 'en-US';
}

function dateLocale() {
  return isItalian() ? it : enUS;
}

function toDate(input: number | string): Date {
  return typeof input === 'number' ? new Date(input) : parseISO(input);
}

/** Locale-aware number: 12.5 → "12,5" (it) / "12.5" (en). */
export function formatNumber(n: number, opts?: Intl.NumberFormatOptions): string {
  if (!Number.isFinite(n)) return '—';
  return new Intl.NumberFormat(numberLocale(), opts).format(n);
}

/** Area in hectares, one decimal max: 12.53 → "12,5 ha" (it). */
export function formatHectares(ha: number): string {
  return `${formatNumber(ha, { maximumFractionDigits: 1 })} ha`;
}

/** Prose day from an ISO date: '2026-08-04' → "lunedì 4 agosto" (it) / "Monday 4 August" (en). */
export function formatDay(dateIso: string): string {
  const d = parseISO(dateIso);
  if (!isValid(d)) return '—';
  return dfFormat(d, 'EEEE d MMMM', { locale: dateLocale() });
}

/** Compact day from an ISO date: '2026-08-04' → "lun 4 ago" (it) / "Mon 4 Aug" (en). */
export function formatShortDay(dateIso: string): string {
  const d = parseISO(dateIso);
  if (!isValid(d)) return '—';
  return dfFormat(d, 'EEE d MMM', { locale: dateLocale() });
}

/** Clock time from an epoch (ms) or ISO timestamp: → "12:30". Never shows seconds. */
export function formatTime(ts: number | string): string {
  const d = toDate(ts);
  if (!isValid(d)) return '—';
  return dfFormat(d, 'HH:mm', { locale: dateLocale() });
}
