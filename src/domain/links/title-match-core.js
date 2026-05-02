/**
 * Title matching algorithms.
 *
 * Core functions used throughout the app to score how well a candidate
 * manga title matches the user's known title (from AniList input).
 *
 * Algorithm: normalize -> tokenize (excluding stop words) ->
 * measure overlap with weighted scoring.
 */

// Japanese stop words + common English stop words
const STOP_WORDS = new Set(['the', 'a', 'an', 'of', 'to', 'and', 'in', 'on', 'no', 'wa', 'ga', 'de', 'ni']);

/**
 * Normalizes a title: lowercase, remove paren/bracket groups,
 * strip non-alphanumeric, collapse whitespace.
 */
function normalizeTitle(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Splits a normalized title into meaningful tokens,
 * filtering out stop words and single-character tokens.
 */
function tokenizeTitle(s) {
  return normalizeTitle(s)
    .split(' ')
    .map(x => x.trim())
    .filter(Boolean)
    .filter(x => x.length > 1)
    .filter(x => !STOP_WORDS.has(x));
}

/**
 * Scores how well two titles match (0-100).
 *
 * Scoring tiers:
 *  100 - exact match after normalization
 *   92 - one contains the other as substring
 *   0-84 - weighted overlap: token overlap (55%), mutual overlap (15%), Jaccard (30%), +8 head bonus
 */
function scoreTitleMatch(inputTitle, candidateTitle) {
  const a = normalizeTitle(inputTitle);
  const b = normalizeTitle(candidateTitle);
  if (!a || !b) return 0;
  if (a === b) return 100;
  if (b.includes(a) || a.includes(b)) return 92;

  const aTokens = tokenizeTitle(a);
  const bTokens = tokenizeTitle(b);
  if (!aTokens.length || !bTokens.length) return 0;

  const aSet = new Set(aTokens);
  const bSet = new Set(bTokens);
  let common = 0;
  for (const t of aSet) if (bSet.has(t)) common += 1;

  const overlapA = common / Math.max(aSet.size, 1);
  const overlapB = common / Math.max(bSet.size, 1);
  const jaccard = common / Math.max(aSet.size + bSet.size - common, 1);
  const headBonus = aTokens[0] && bTokens[0] && aTokens[0] === bTokens[0] ? 8 : 0;
  return Math.min(100, Math.round((overlapA * 55) + (overlapB * 15) + (jaccard * 30) + headBonus));
}

/**
 * Strict title match: score must exceed minScore AND
 * share enough tokens to be a plausible match.
 */
function isStrictTitleMatch(inputTitle, candidateTitle, minScore = 88) {
  const score = scoreTitleMatch(inputTitle, candidateTitle);
  if (score < minScore) return false;

  const aTokens = tokenizeTitle(inputTitle);
  const bTokens = tokenizeTitle(candidateTitle);
  if (!aTokens.length || !bTokens.length) return false;

  const bSet = new Set(bTokens);
  const common = aTokens.filter(t => bSet.has(t));
  if (aTokens.length >= 3) return common.length >= 2;
  return common.length >= 1;
}

/**
 * Deduplicates search inputs (title, aliases, normalized key).
 */
function buildUniqueMatchInputs(searchKey, searchTerms = []) {
  const out = [];
  const push = (v) => {
    const s = String(v || '').trim();
    if (!s || out.some(x => x.toLowerCase() === s.toLowerCase())) return;
    out.push(s);
  };
  push(searchKey);
  if (Array.isArray(searchTerms)) searchTerms.forEach(push);
  return out.slice(0, 12);
}

/**
 * Scores a candidate title against multiple possible input variants.
 * Returns the best score and which input it matched against.
 */
function scoreCandidateAgainstInputs(matchInputs, candidateTitle, strictTitleMatch, strictMinScore) {
  const title = String(candidateTitle || '').trim();
  if (!title) return { score: 0, matchedAgainst: '', strictOk: false };

  let bestScore = 0;
  let matchedAgainst = '';
  let strictOk = false;

  for (const input of matchInputs) {
    const s = scoreTitleMatch(input, title);
    if (s > bestScore) { bestScore = s; matchedAgainst = input; }
    if (strictTitleMatch && !strictOk && isStrictTitleMatch(input, title, strictMinScore)) strictOk = true;
  }

  if (!strictTitleMatch) strictOk = true;
  return { score: bestScore, matchedAgainst, strictOk };
}

/**
 * Sorts sources by user's preferred source priority list.
 */
function sortSourcesByPriority(sources, sourcePriority = []) {
  if (!Array.isArray(sourcePriority) || sourcePriority.length === 0) return sources;
  const prefs = sourcePriority.map(p => String(p || '').toLowerCase()).filter(Boolean);
  const rank = (s) => {
    const hay = `${s.name || ''} ${s.displayName || ''} ${s.baseUrl || ''} ${s.lang || ''}`.toLowerCase();
    for (let i = 0; i < prefs.length; i += 1) if (hay.includes(prefs[i])) return i;
    return Number.MAX_SAFE_INTEGER;
  };
  return [...sources].sort((a, b) => rank(a) - rank(b));
}

/**
 * Checks if a source name/baseUrl/lang matches any user priority.
 */
function sourceMatchesAnyPriority(source, sourcePriority = []) {
  const prefs = (sourcePriority || []).map(p => String(p || '').toLowerCase()).filter(Boolean);
  if (!prefs.length) return true;
  const hay = `${source.name || ''} ${source.displayName || ''} ${source.baseUrl || ''} ${source.lang || ''}`.toLowerCase();
  return prefs.some(p => hay.includes(p));
}

/**
 * Finds a source by its ID string.
 */
function findSourceById(sources, sourceId) {
  const target = String(sourceId || '').trim();
  if (!target || !Array.isArray(sources) || !sources.length) return null;
  return sources.find(s => String(s && s.id).trim() === target) || null;
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
  findSourceById
};
