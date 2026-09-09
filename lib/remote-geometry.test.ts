import assert from 'node:assert/strict';
import test from 'node:test';

import {
  containedRect,
  displayToScreen,
  screenToDisplay,
  viewAroundAnchor,
} from './remote-geometry.ts';

const closeTo = (actual: number, expected: number) => {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} should equal ${expected}`);
};

void test('contains a widescreen desktop correctly in portrait and landscape controllers', () => {
  assert.deepEqual(containedRect(390, 700, 1920, 1080), {
    left: 0,
    top: 240.3125,
    width: 390,
    height: 219.375,
  });

  const landscape = containedRect(844, 326, 1920, 1080);
  closeTo(landscape.left, 132.22222222222223);
  closeTo(landscape.top, 0);
  closeTo(landscape.width, 579.5555555555555);
  closeTo(landscape.height, 326);
});

void test('keeps a pinch anchor under the same fingers', () => {
  const anchorScreen = { x: 0.78, y: 0.31 };
  const anchorDisplay = { x: 0.64, y: 0.42 };
  const view = viewAroundAnchor(3, anchorScreen, anchorDisplay);
  const displayed = screenToDisplay(anchorScreen, view);
  closeTo(displayed.x, anchorDisplay.x);
  closeTo(displayed.y, anchorDisplay.y);
});

void test('round-trips cursor coordinates at zoom after an orientation change', () => {
  const view = viewAroundAnchor(2.6, { x: 0.63, y: 0.44 }, { x: 0.34, y: 0.71 });
  for (const point of [{ x: 0.2, y: 0.3 }, { x: 0.63, y: 0.44 }, { x: 0.8, y: 0.7 }]) {
    const result = displayToScreen(screenToDisplay(point, view), view);
    closeTo(result.x, point.x);
    closeTo(result.y, point.y);
  }
});
