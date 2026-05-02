const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeTitle,
  tokenizeTitle,
  scoreTitleMatch,
  isStrictTitleMatch,
  scoreTitle,
  isStrictMatch
} = require('../src/services/title-match');

test('normalizeTitle strips punctuation and bracketed chunks', () => {
  assert.equal(normalizeTitle('One Piece (PT-BR) [WEB]'), 'one piece');
});

test('tokenizeTitle removes stop words and single-char tokens', () => {
  assert.deepEqual(tokenizeTitle('The a no One Piece'), ['one', 'piece']);
});

test('scoreTitleMatch returns 100 for exact normalized match', () => {
  assert.equal(scoreTitleMatch('Solo Leveling', 'solo leveling'), 100);
});

test('scoreTitleMatch returns high score for containment', () => {
  assert.equal(scoreTitleMatch('naruto', 'naruto shippuden'), 92);
});

test('strict match requires sufficient overlap', () => {
  assert.equal(isStrictTitleMatch('Berserk', 'Berserk'), true);
  assert.equal(isStrictTitleMatch('Berserk', 'Blue Lock'), false);
});

test('service aliases scoreTitle/isStrictMatch map to core functions', () => {
  assert.equal(scoreTitle('Monster', 'Monster'), 100);
  assert.equal(isStrictMatch('Attack on Titan', 'Attack on Titan'), true);
});
