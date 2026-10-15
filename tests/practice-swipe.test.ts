import assert from 'node:assert/strict';
import test from 'node:test';
import { hasVerticalIntent, swipeDirection } from '../src/practice-swipe';

const start = Object.freeze({ x: 100, y: 100, time: 1000 });
const end = (x: number, y = 0, time = 200) => Object.freeze({ x: start.x + x, y: start.y + y, time: start.time + time });

test('horizontal swipes browse left-to-next and right-to-previous without mutating their points', () => {
  for (const distance of [50, 80, 200]) {
    const left = end(-distance);
    const right = end(distance);
    assert.equal(swipeDirection(start, left), 'next');
    assert.equal(swipeDirection(start, right), 'previous');
    assert.deepEqual(left, { x: 100 - distance, y: 100, time: 1200 });
    assert.deepEqual(right, { x: 100 + distance, y: 100, time: 1200 });
  }
  assert.deepEqual(start, { x: 100, y: 100, time: 1000 });
});

test('swipes reject taps, short movement and insufficiently horizontal diagonals', () => {
  for (const distance of [0, 1, 49.99, -1, -49.99]) assert.equal(swipeDirection(start, end(distance)), null);
  for (const sign of [-1, 1]) {
    assert.equal(swipeDirection(start, end(sign * 75, 50)), sign === -1 ? 'next' : 'previous');
    assert.equal(swipeDirection(start, end(sign * 75, -50)), sign === -1 ? 'next' : 'previous');
    assert.equal(swipeDirection(start, end(sign * 74.99, 50)), null);
    assert.equal(swipeDirection(start, end(sign * 80, 80)), null);
    assert.equal(swipeDirection(start, end(sign * 80, -100)), null);
  }
  assert.equal(swipeDirection(start, end(0, 200)), null);
});

test('swipes have a bounded duration and reject invalid event coordinates or time', () => {
  for (const duration of [0, 1, 699, 700]) assert.equal(swipeDirection(start, end(-80, 0, duration)), 'next');
  for (const duration of [-1, 700.01, 1000]) assert.equal(swipeDirection(start, end(-80, 0, duration)), null);
  for (const value of [NaN, Infinity, -Infinity]) {
    assert.equal(swipeDirection(start, end(value)), null);
    assert.equal(swipeDirection(start, end(80, value)), null);
    assert.equal(swipeDirection(start, end(80, 0, value)), null);
  }
});

test('vertical intent can cancel a candidate before it later moves horizontally', () => {
  assert.equal(hasVerticalIntent(start, end(0, 11.99)), false);
  assert.equal(hasVerticalIntent(start, end(0, 12)), true);
  assert.equal(hasVerticalIntent(start, end(0, -12)), true);
  assert.equal(hasVerticalIntent(start, end(12, 12)), false);
  assert.equal(hasVerticalIntent(start, end(-12, 13)), true);
  assert.equal(hasVerticalIntent(start, end(40, 20)), false);
});
