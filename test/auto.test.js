import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import AutoController, { ACTION, normaliseBand } from '../src/auto.js';

describe('the AUTO band', () => {
  it('starts the air conditioner once the room is past the top of the band', () => {
    const auto = new AutoController({ deadband: 0.2 });

    assert.equal(auto.decide(23.0, { low: 22, high: 24 }), ACTION.HOLD);
    assert.equal(auto.decide(24.1, { low: 22, high: 24 }), ACTION.HOLD, 'inside the deadband');
    assert.equal(auto.decide(24.3, { low: 22, high: 24 }), ACTION.COOL);
  });

  it('keeps cooling until the bottom, not until it falls back below the top', () => {
    const auto = new AutoController({ deadband: 0.2 });
    auto.decide(25, { low: 22, high: 24 });

    // Back under the top of the band, which is where a controller without hysteresis would stop.
    assert.equal(auto.decide(23.5, { low: 22, high: 24 }), ACTION.HOLD);
    assert.equal(auto.decide(22.5, { low: 22, high: 24 }), ACTION.HOLD);
    assert.equal(auto.decide(21.7, { low: 22, high: 24 }), ACTION.OFF);
  });

  it('does not switch anything on a reading it does not have', () => {
    const auto = new AutoController();
    auto.sync(true);

    assert.equal(auto.decide(undefined, { low: 22, high: 24 }), ACTION.HOLD);
    assert.equal(auto.decide(Number.NaN, { low: 22, high: 24 }), ACTION.HOLD);
    assert.equal(auto.activity, 'cooling', 'and it keeps reporting what it was doing');
  });

  it('reports itself idle while the room is cool enough, not off', () => {
    const auto = new AutoController({ deadband: 0 });

    assert.equal(auto.activity, 'idle');
    auto.decide(25, { low: 22, high: 24 });
    assert.equal(auto.activity, 'cooling');
    auto.decide(21, { low: 22, high: 24 });
    assert.equal(auto.activity, 'idle');
  });

  it('takes the device\'s word for it after a restart', () => {
    const auto = new AutoController({ deadband: 0 });
    auto.sync(true);

    // Already running, so the next thing it should do is stop at the bottom - not start again.
    assert.equal(auto.decide(21, { low: 22, high: 24 }), ACTION.OFF);
  });
});

describe('a band with no width', () => {
  it('is widened, so the air conditioner is not switched on and off at one reading', () => {
    assert.deepEqual(normaliseBand({ low: 23, high: 23 }), { low: 23, high: 24 });
    assert.deepEqual(normaliseBand({ low: 23, high: 22 }), { low: 23, high: 24 });
    assert.deepEqual(normaliseBand({ low: 22, high: 24 }), { low: 22, high: 24 });
  });
});
