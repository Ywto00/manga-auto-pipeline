const {
  normalizeTitle,
  tokenizeTitle,
  scoreTitleMatch,
  isStrictTitleMatch,
  buildUniqueMatchInputs,
  scoreCandidateAgainstInputs,
  sortSourcesByPriority,
  sourceMatchesAnyPriority,
  findSourceById
} = require('../../features/links/domain/title-match-core');

function scoreTitle(a, b) {
  return scoreTitleMatch(a, b);
}

function isStrictMatch(a, b, minScore) {
  return isStrictTitleMatch(a, b, minScore);
}

module.exports = {
  normalizeTitle,
  tokenizeTitle,
  scoreTitleMatch,
  isStrictTitleMatch,
  buildUniqueMatchInputs,
  scoreCandidateAgainstInputs,
  sortSourcesByPriority,
  sourceMatchesAnyPriority,
  findSourceById,
  scoreTitle,
  isStrictMatch
};
