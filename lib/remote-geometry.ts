export type RemotePoint = { x: number; y: number };
export type RemoteView = { scale: number; centerX: number; centerY: number };
export type RemoteRect = { left: number; top: number; width: number; height: number };

export const MIN_VIEW_SCALE = 1;
export const MAX_VIEW_SCALE = 4;

export function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function clampPoint(point: RemotePoint): RemotePoint {
  return { x: clamp(point.x, 0, 1), y: clamp(point.y, 0, 1) };
}

export function containedRect(
  containerWidth: number,
  containerHeight: number,
  contentWidth: number,
  contentHeight: number,
): RemoteRect {
  if (containerWidth <= 0 || containerHeight <= 0 || contentWidth <= 0 || contentHeight <= 0) {
    return { left: 0, top: 0, width: Math.max(0, containerWidth), height: Math.max(0, containerHeight) };
  }

  const contentRatio = contentWidth / contentHeight;
  const containerRatio = containerWidth / containerHeight;
  if (containerRatio > contentRatio) {
    const width = containerHeight * contentRatio;
    return { left: (containerWidth - width) / 2, top: 0, width, height: containerHeight };
  }

  const height = containerWidth / contentRatio;
  return { left: 0, top: (containerHeight - height) / 2, width: containerWidth, height };
}

export function clampView(view: RemoteView): RemoteView {
  const scale = clamp(view.scale, MIN_VIEW_SCALE, MAX_VIEW_SCALE);
  if (scale === 1) return { scale: 1, centerX: 0.5, centerY: 0.5 };
  const halfVisible = 0.5 / scale;
  return {
    scale,
    centerX: clamp(view.centerX, halfVisible, 1 - halfVisible),
    centerY: clamp(view.centerY, halfVisible, 1 - halfVisible),
  };
}

export function screenToDisplay(point: RemotePoint, view: RemoteView): RemotePoint {
  return {
    x: (point.x - view.centerX) * view.scale + 0.5,
    y: (point.y - view.centerY) * view.scale + 0.5,
  };
}

export function displayToScreen(point: RemotePoint, view: RemoteView): RemotePoint {
  return clampPoint({
    x: view.centerX + (point.x - 0.5) / view.scale,
    y: view.centerY + (point.y - 0.5) / view.scale,
  });
}

export function viewAroundAnchor(
  scale: number,
  anchorScreen: RemotePoint,
  anchorDisplay: RemotePoint,
): RemoteView {
  return clampView({
    scale,
    centerX: anchorScreen.x - (anchorDisplay.x - 0.5) / scale,
    centerY: anchorScreen.y - (anchorDisplay.y - 0.5) / scale,
  });
}
