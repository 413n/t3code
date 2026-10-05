import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { View, type ViewInstance } from "react-native";
import { useKeyboardState } from "react-native-keyboard-controller";

import { OverlayPortal } from "../../components/OverlayPortal";

const COMPOSER_GAP = 8;

type Frame = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

function sameFrame(a: Frame | null, b: Frame) {
  return a !== null && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/**
 * Places a composer popover just above the composer. Android only delivers
 * drags to views inside their parent's bounds, so a popover hung above the
 * composer with `bottom-full` takes taps but its list never scrolls. Render it
 * through OverlayPortal instead, positioned from the composer's window frame.
 */
export function ComposerPopoverAnchor(props: { readonly children: ReactNode }) {
  const anchorRef = useRef<ViewInstance>(null);
  const overlayRef = useRef<ViewInstance>(null);
  const [anchor, setAnchor] = useState<Frame | null>(null);
  const [overlay, setOverlay] = useState<Frame | null>(null);
  const keyboardHeight = useKeyboardState((state) => state.height);

  const measureAnchor = useCallback(() => {
    anchorRef.current?.measureInWindow((x, y, width, height) => {
      const next = { x, y, width, height };
      setAnchor((current) => (sameFrame(current, next) ? current : next));
    });
  }, []);

  const measureOverlay = useCallback(() => {
    overlayRef.current?.measureInWindow((x, y, width, height) => {
      const next = { x, y, width, height };
      setOverlay((current) => (sameFrame(current, next) ? current : next));
    });
  }, []);

  // The composer moves without resizing when the keyboard opens or closes.
  useEffect(measureAnchor, [measureAnchor, keyboardHeight]);

  return (
    <>
      {/* Covers the composer so its onLayout fires when the composer grows. */}
      <View
        ref={anchorRef}
        collapsable={false}
        pointerEvents="none"
        className="absolute inset-0"
        onLayout={measureAnchor}
      />
      <OverlayPortal>
        <View
          ref={overlayRef}
          collapsable={false}
          pointerEvents="box-none"
          className="absolute inset-0"
          onLayout={measureOverlay}
        >
          {anchor === null || overlay === null ? null : (
            <View
              className="absolute"
              style={{
                left: anchor.x - overlay.x,
                width: anchor.width,
                bottom: overlay.height - (anchor.y - overlay.y) + COMPOSER_GAP,
              }}
            >
              {props.children}
            </View>
          )}
        </View>
      </OverlayPortal>
    </>
  );
}
