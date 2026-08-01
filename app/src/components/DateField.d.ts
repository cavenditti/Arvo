// SPINE — type-only resolution shim (same pattern as MapView.d.ts). Metro ignores .d.ts and picks
// DateField.tsx (native) / DateField.web.tsx per platform. Keep props identical in both forks.
import type { ComponentType } from 'react';

export interface DateFieldProps {
  label: string;
  value: string | null;
  onChange(v: string | null): void;
  minimumDate?: Date;
  maximumDate?: Date;
}

declare const DateField: ComponentType<DateFieldProps>;
export default DateField;
