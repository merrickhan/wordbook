export type SwipePoint = { x: number; y: number; time: number };

export function hasVerticalIntent(start: SwipePoint, point: SwipePoint): boolean {
  const vertical = Math.abs(point.y - start.y);
  return vertical >= 12 && vertical > Math.abs(point.x - start.x);
}

export function swipeDirection(start: SwipePoint, end: SwipePoint): 'previous' | 'next' | null {
  const horizontal = end.x - start.x;
  const vertical = end.y - start.y;
  const duration = end.time - start.time;
  if (
    ![horizontal, vertical, duration].every(Number.isFinite)
    || duration < 0 || duration > 700
    || Math.abs(horizontal) < 50
    || Math.abs(horizontal) < Math.abs(vertical) * 1.5
  ) return null;
  return horizontal < 0 ? 'next' : 'previous';
}
