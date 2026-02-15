const STOP_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'by', 'for', 'from', 'in', 'into', 'is',
  'it', 'of', 'on', 'or', 'the', 'to', 'with',
]);

const GENERIC_WORDS = new Set([
  'account', 'apps', 'dashboard', 'default', 'home', 'index', 'landing', 'login', 'new',
  'page', 'search', 'site', 'start', 'tabs', 'untitled',
]);

const COMMON_HOST_PARTS = new Set([
  'com', 'dev', 'edu', 'example', 'gov', 'io', 'net', 'org', 'www',
]);

function normalizeToken(raw) {
  if (!raw) return '';
  const token = raw.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
  if (token.length < 2) return '';
  if (/^\d+$/.test(token)) return '';
  if (STOP_WORDS.has(token)) return '';
  return token;
}

function capitalizeWords(text) {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(' ');
}

export function tokenizeForGroupNaming(text) {
  if (!text) return [];
  const normalizedText = String(text)
    .toLowerCase()
    .replace(/[|:/\\\-_–—•·]+/g, ' ');
  const rawTokens = normalizedText.match(/[a-z0-9]+/g) || [];
  return rawTokens
    .map(normalizeToken)
    .filter(Boolean);
}

export function extractHostnameKeywords(url) {
  if (!url) return [];
  try {
    const parsed = new URL(url);
    const hostParts = parsed.hostname
      .toLowerCase()
      .split('.')
      .map(normalizeToken)
      .filter((part) => part && !COMMON_HOST_PARTS.has(part));

    // Keep order but dedupe.
    return [...new Set(hostParts)];
  } catch {
    return [];
  }
}

function buildBigrams(tokens) {
  const bigrams = [];
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const left = tokens[i];
    const right = tokens[i + 1];
    if (!left || !right) continue;
    bigrams.push(`${left} ${right}`);
  }
  return bigrams;
}

function addCandidate(candidateMap, text, tabIndex, position, kind, hostBoost = false) {
  if (!text) return;
  const key = text.toLowerCase();
  if (!candidateMap.has(key)) {
    candidateMap.set(key, {
      text: key,
      kind,
      wordCount: key.split(/\s+/).length,
      frequency: 0,
      positionScore: 0,
      hostHits: 0,
      coverage: new Set(),
    });
  }
  const candidate = candidateMap.get(key);
  candidate.frequency += 1;
  candidate.coverage.add(tabIndex);
  candidate.positionScore += 1 / (position + 1);
  if (hostBoost) candidate.hostHits += 1;
}

function scoreCandidate(candidate, tabCount) {
  const coverageScore = candidate.coverage.size / Math.max(1, tabCount);
  const bigramBonus = candidate.wordCount === 2 ? 0.4 : 0;
  const hostBonus = candidate.hostHits * 0.3;
  const genericPenalty = GENERIC_WORDS.has(candidate.text) ? 1.2 : 0;
  return (
    coverageScore * 3
    + candidate.frequency * 0.8
    + candidate.positionScore * 0.4
    + bigramBonus
    + hostBonus
    - genericPenalty
  );
}

export function rankNameCandidates(tabs) {
  const list = Array.isArray(tabs) ? tabs : [];
  const candidateMap = new Map();

  list.forEach((tab, tabIndex) => {
    const titleTokens = tokenizeForGroupNaming(tab?.title || '');
    titleTokens.forEach((token, idx) => addCandidate(candidateMap, token, tabIndex, idx, 'unigram'));
    buildBigrams(titleTokens).forEach((bigram, idx) => {
      addCandidate(candidateMap, bigram, tabIndex, idx, 'bigram');
    });

    const hostTokens = extractHostnameKeywords(tab?.url || '');
    hostTokens.forEach((token, idx) => addCandidate(candidateMap, token, tabIndex, idx, 'host', true));
  });

  const ranked = [];
  for (const candidate of candidateMap.values()) {
    const score = scoreCandidate(candidate, list.length);
    ranked.push({
      text: candidate.text,
      kind: candidate.kind,
      wordCount: candidate.wordCount,
      coverageCount: candidate.coverage.size,
      frequency: candidate.frequency,
      score,
    });
  }

  ranked.sort((a, b) => (
    b.score - a.score
    || b.coverageCount - a.coverageCount
    || b.wordCount - a.wordCount
    || a.text.localeCompare(b.text)
  ));

  return ranked;
}

function chooseDominantHostFallback(tabs) {
  const list = Array.isArray(tabs) ? tabs : [];
  if (list.length === 0) return null;

  const counts = new Map();
  for (const tab of list) {
    const tokens = new Set(extractHostnameKeywords(tab?.url || ''));
    for (const token of tokens) {
      counts.set(token, (counts.get(token) || 0) + 1);
    }
  }

  let chosen = null;
  let chosenCount = 0;
  for (const [token, count] of counts.entries()) {
    if (count > chosenCount || (count === chosenCount && token < chosen)) {
      chosen = token;
      chosenCount = count;
    }
  }

  if (!chosen) return null;
  const ratio = chosenCount / list.length;
  if (ratio < 0.5) return null;
  return chosen;
}

export function generateGroupNameFromTabs(tabs) {
  const ranked = rankNameCandidates(tabs);
  const bestUnigram = ranked.find((candidate) => candidate.wordCount === 1);
  const bestBigram = ranked.find((candidate) => candidate.wordCount === 2);

  let chosen = bestUnigram || bestBigram || null;
  if (bestBigram && (!bestUnigram || bestBigram.score >= bestUnigram.score - 0.15)) {
    chosen = bestBigram;
  }

  // If signal is weak, prefer a stable host fallback when available.
  if (!chosen || chosen.score < 1.2) {
    const fallbackHost = chooseDominantHostFallback(tabs);
    if (fallbackHost) {
      return {
        name: capitalizeWords(fallbackHost),
        words: 1,
        score: 0,
        reason: 'hostname-fallback',
        candidateType: 'fallback-host',
      };
    }
  }

  if (!chosen) {
    return {
      name: 'Tabs',
      words: 1,
      score: 0,
      reason: 'generic-fallback',
      candidateType: 'fallback-generic',
    };
  }

  return {
    name: capitalizeWords(chosen.text),
    words: chosen.wordCount,
    score: chosen.score,
    reason: 'scored',
    candidateType: chosen.kind,
  };
}
