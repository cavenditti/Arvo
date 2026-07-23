import { useEffect, type RefObject } from 'react';
import { Platform } from 'react-native';

/** Close a floating surface when a pointer lands outside its owning element (web only). */
export function useOutsideDismiss(
  ref: RefObject<unknown>,
  open: boolean,
  onDismiss: () => void,
) {
  useEffect(() => {
    if (Platform.OS !== 'web' || !open) return;

    const doc = (globalThis as typeof globalThis & { document?: Document }).document;
    if (!doc) return;

    const onPointerDown = (event: PointerEvent) => {
      const node = ref.current as { contains?: (target: EventTarget | null) => boolean } | null;
      if (node?.contains?.(event.target)) return;
      onDismiss();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDismiss();
    };

    // Capture phase runs before map canvases or nested controls can stop propagation.
    doc.addEventListener('pointerdown', onPointerDown, true);
    doc.addEventListener('keydown', onKeyDown, true);
    return () => {
      doc.removeEventListener('pointerdown', onPointerDown, true);
      doc.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open, onDismiss, ref]);
}
