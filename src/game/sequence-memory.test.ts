import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createSequenceMemory,
  inputSequenceMemory,
  tickSequenceMemory,
  type SequenceMemoryState,
} from './sequence-memory.js';

function completeCurrentSequence(state: SequenceMemoryState): SequenceMemoryState {
  let current = tickSequenceMemory(state, state.phaseEndsAtMs).state;
  for (const button of current.sequence) {
    current = inputSequenceMemory(current, button, current.lastNowMs + 10).state;
  }
  return current;
}

test('completes after the six-color sequence without generating a seventh color', () => {
  let state = createSequenceMemory(
    {
      initialSequenceLength: 2,
      maxSequenceLength: 6,
      initialLives: 2,
      exampleItemMs: 700,
      exampleGapMs: 500,
      responseTimeoutMs: 10_000,
      feedbackMs: 750,
    },
    1234,
    0,
  );

  const completedLengths: number[] = [];
  while (state.lifecycle === 'PLAYING') {
    completedLengths.push(state.sequence.length);
    state = completeCurrentSequence(state);
    if (state.lifecycle === 'PLAYING') state = tickSequenceMemory(state, state.phaseEndsAtMs).state;
  }

  assert.deepEqual(completedLengths, [2, 3, 4, 5, 6]);
  assert.equal(state.sequence.length, 6);
  assert.equal(state.completion?.metrics.maxSequenceLength, 6);
  assert.equal(state.completion?.metrics.completionReason, 'LEVEL_CAP_REACHED');
});
