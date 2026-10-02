const KEYBOARD_REDUCTION_PX = 96;

export type InputCapabilities = {
  primaryFine: boolean;
  primaryCoarse: boolean;
  anyCoarse: boolean;
  maxTouchPoints: number;
};

export function isTouchCapable(capabilities: InputCapabilities) {
  return (
    capabilities.primaryCoarse ||
    capabilities.anyCoarse ||
    capabilities.maxTouchPoints > 0
  );
}

export function shouldAutofocusQuestion(
  connected: boolean,
  active: boolean,
  phaseChanged: boolean,
  capabilities: InputCapabilities,
) {
  return (
    connected &&
    !active &&
    phaseChanged &&
    capabilities.primaryFine &&
    !isTouchCapable(capabilities)
  );
}

export function isVirtualKeyboardOpen(
  layoutHeight: number,
  visualHeight: number,
  questionFocused: boolean,
  alreadyOpen = false,
  scale = 1,
) {
  return (
    (questionFocused || alreadyOpen) &&
    layoutHeight - visualHeight * Math.max(1, scale) >= KEYBOARD_REDUCTION_PX
  );
}
