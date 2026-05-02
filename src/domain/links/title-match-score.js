function normalizeTitleLocal(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeTitleLocal(s) {
  const stop = new Set(['the', 'a', 'an', 'of', 'to', 'and', 'in', 'on', 'no', 'wa', 'ga', 'de', 'ni']);
  return normalizeTitleLocal(s)
    .split(' ')
    .map(x => x.trim())
    .filter(Boolean)
    .filter(x => x.length > 1)
    .filter(x => !stop.has(x));
}

function scoreTitleLocal(inputTitle, candidateTitle) {
  const a = normalizeTitleLocal(inputTitle);
  const b = normalizeTitleLocal(candidateTitle);
  if (!a || !b) return 0;
  if (a === b) return 100;
  if (b.includes(a) || a.includes(b)) return 92;

  const aTokens = tokenizeTitleLocal(a);
  const bTokens = tokenizeTitleLocal(b);
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

function computeBestLocalMatch(item, linked) {
  if (!item || !linked || !linked.mangaTitle) return null;
  const inputs = [];
  const push = (v) => {
    const s = String(v || '').trim();
    if (!s) return;
    if (!inputs.some(x => x.toLowerCase() === s.toLowerCase())) inputs.push(s);
  };

  push(item.title);
  (Array.isArray(item.altTitles) ? item.altTitles : []).forEach(push);
  push(item.searchKey);

  let best = { score: 0, matchedAgainst: '' };
  for (const name of inputs.slice(0, 12)) {
    const s = scoreTitleLocal(name, linked.mangaTitle);
    if (s > best.score) {
      best = { score: s, matchedAgainst: name };
    }
  }

  return best;
}

module.exports = {
  computeBestLocalMatch,
  scoreTitleLocal,
  normalizeTitleLocal,
  tokenizeTitleLocal
};
