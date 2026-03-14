/**
 * Generates descriptive names for unnamed tab groups by analyzing tab titles and URLs.
 *
 * Strategy:
 *   1. Extract meaningful single words (unigrams) and word pairs (bigrams) from tab titles
 *   2. Extract keywords from hostnames (e.g. "github" from github.com)
 *   3. Score each candidate by coverage (% of tabs it appears in), frequency, and position
 *   4. Prefer bigrams when their score is competitive with the best unigram
 *   5. Fall back to the dominant hostname if signal is weak
 *   6. Fall back to the generic name "Tabs" as a last resort
 */

/** Common English words that carry no meaningful signal for group naming. */
const WORDS_TO_IGNORE_IN_TAB_TITLES = new Set([
  'a', 'an', 'and', 'as', 'at', 'by', 'for', 'from', 'in', 'into', 'is',
  'it', 'of', 'on', 'or', 'the', 'to', 'with',
]);

/** Words that appear in many tab titles but rarely make good group names. */
const GENERIC_WORDS_TO_PENALIZE = new Set([
  'account', 'apps', 'dashboard', 'default', 'home', 'index', 'landing', 'login', 'new',
  'page', 'search', 'site', 'start', 'tabs', 'untitled',
]);

/** Domain suffixes and common hostname parts that are too generic to be useful keywords. */
const COMMON_HOSTNAME_PARTS_TO_IGNORE = new Set([
  'com', 'dev', 'edu', 'example', 'gov', 'io', 'net', 'org', 'www',
]);

/**
 * Normalizes a raw token: lowercases, strips non-alphanumeric edges,
 * and rejects tokens that are too short, purely numeric, or stop words.
 * Uses Unicode-aware character classes to correctly handle umlauts and
 * other non-ASCII letters (e.g. ä, ö, ü, ß).
 * @returns {string} The cleaned token, or empty string if rejected
 */
function normalizeWordOrReject(rawWord) {
  if (!rawWord) return '';
  const cleaned = rawWord.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  if (cleaned.length < 2) return '';
  if (/^\d+$/u.test(cleaned)) return '';
  if (WORDS_TO_IGNORE_IN_TAB_TITLES.has(cleaned)) return '';
  return cleaned;
}

/**
 * Capitalizes the first letter of each word in a string.
 * "react hooks" → "React Hooks"
 */
function capitalizeFirstLetterOfEachWord(text) {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Extracts meaningful words from a text string (typically a tab title).
 * Splits on separators like |, /, -, etc., normalizes each token,
 * and filters out stop words and short/numeric tokens.
 *
 * Invisible non-separating characters (U+00AD soft hyphen, U+200C zero-width
 * non-joiner, U+200D zero-width joiner, U+FEFF byte-order mark / zero-width
 * no-break space, U+2060 word joiner) are stripped before tokenization so that
 * compound words containing them stay intact instead of being split into fragments.
 *
 * Characters that legitimately act as word separators (U+200B zero-width space,
 * U+00A0 non-breaking space) are left in place; they are not matched by
 * [\p{L}\p{N}]+ and therefore naturally cause word boundaries — which is the
 * correct behaviour.
 *
 * @param {string} text - The text to tokenize (usually a tab title)
 * @returns {string[]} Array of normalized, meaningful words
 */
export function extractMeaningfulWordsFromText(text) {
  if (!text) return [];
  const stripped = String(text).replace(/[\u00AD\u200C\u200D\uFEFF\u2060]/g, '');
  const withSeparatorsAsSpaces = stripped
    .toLowerCase()
    .replace(/[|:/\\\-_–—•·]+/g, ' ');
  const rawWords = withSeparatorsAsSpaces.match(/[\p{L}\p{N}]+/gu) || [];
  return rawWords
    .map(normalizeWordOrReject)
    .filter(Boolean);
}

/**
 * Extracts meaningful keywords from a URL's hostname.
 * For example, "docs.github.com" yields ["docs", "github"].
 *
 * @param {string} url - A full URL to extract hostname keywords from
 * @returns {string[]} Unique hostname keywords, preserving order
 */
export function extractKeywordsFromHostname(url) {
  if (!url) return [];
  try {
    const parsedUrl = new URL(url);
    const hostnameParts = parsedUrl.hostname
      .toLowerCase()
      .split('.')
      .map(normalizeWordOrReject)
      .filter((part) => part && !COMMON_HOSTNAME_PARTS_TO_IGNORE.has(part));

    return [...new Set(hostnameParts)];
  } catch {
    return [];
  }
}

/**
 * Builds adjacent word pairs (bigrams) from a token array.
 * ["react", "hooks", "guide"] → ["react hooks", "hooks guide"]
 */
function buildAdjacentWordPairs(tokens) {
  const wordPairs = [];
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const leftWord = tokens[i];
    const rightWord = tokens[i + 1];
    if (!leftWord || !rightWord) continue;
    wordPairs.push(`${leftWord} ${rightWord}`);
  }
  return wordPairs;
}

/**
 * Records a name candidate in the candidate map, tracking its frequency,
 * which tabs it appeared in (coverage), and its position in titles.
 */
function recordNameCandidate(candidateMap, text, tabIndex, positionInTitle, candidateKind, isFromHostname = false) {
  if (!text) return;
  const normalizedKey = text.toLowerCase();
  if (!candidateMap.has(normalizedKey)) {
    candidateMap.set(normalizedKey, {
      text: normalizedKey,
      kind: candidateKind,
      wordCount: normalizedKey.split(/\s+/).length,
      frequency: 0,
      positionScore: 0,
      hostnameHitCount: 0,
      tabsCoveredByThisCandidate: new Set(),
    });
  }
  const candidate = candidateMap.get(normalizedKey);
  candidate.frequency += 1;
  candidate.tabsCoveredByThisCandidate.add(tabIndex);
  candidate.positionScore += 1 / (positionInTitle + 1);
  if (isFromHostname) candidate.hostnameHitCount += 1;
}

/**
 * Calculates a relevance score for a name candidate.
 * Higher scores indicate better group names. The score considers:
 *   - Coverage: what fraction of tabs contain this candidate
 *   - Frequency: how often the candidate appears across all tabs
 *   - Position: candidates appearing earlier in titles score higher
 *   - Bigram bonus: two-word names get a small bonus for specificity
 *   - Hostname bonus: candidates that match hostnames get a boost
 *   - Generic penalty: common/generic words are penalized
 */
function calculateCandidateRelevanceScore(candidate, totalTabCount) {
  const coverageFraction = candidate.tabsCoveredByThisCandidate.size / Math.max(1, totalTabCount);
  const bigramBonus = candidate.wordCount === 2 ? 0.4 : 0;
  const hostnameBonus = candidate.hostnameHitCount * 0.3;
  const genericWordPenalty = GENERIC_WORDS_TO_PENALIZE.has(candidate.text) ? 1.2 : 0;
  return (
    coverageFraction * 3
    + candidate.frequency * 0.8
    + candidate.positionScore * 0.4
    + bigramBonus
    + hostnameBonus
    - genericWordPenalty
  );
}

/**
 * Ranks all possible name candidates extracted from an array of tabs.
 * Returns candidates sorted by relevance score (highest first).
 *
 * @param {Array} tabs - Array of tab objects with { title, url } properties
 * @returns {Array} Ranked candidates with { text, kind, wordCount, coverageCount, frequency, score }
 */
export function rankAllNameCandidatesByRelevance(tabs) {
  const tabList = Array.isArray(tabs) ? tabs : [];
  const candidateMap = new Map();

  tabList.forEach((tab, tabIndex) => {
    const titleWords = extractMeaningfulWordsFromText(tab?.title || '');
    titleWords.forEach((word, position) => recordNameCandidate(candidateMap, word, tabIndex, position, 'unigram'));
    buildAdjacentWordPairs(titleWords).forEach((pair, position) => {
      recordNameCandidate(candidateMap, pair, tabIndex, position, 'bigram');
    });

    const hostnameKeywords = extractKeywordsFromHostname(tab?.url || '');
    hostnameKeywords.forEach((keyword, position) => recordNameCandidate(candidateMap, keyword, tabIndex, position, 'host', true));
  });

  const rankedCandidates = [];
  for (const candidate of candidateMap.values()) {
    const score = calculateCandidateRelevanceScore(candidate, tabList.length);
    rankedCandidates.push({
      text: candidate.text,
      kind: candidate.kind,
      wordCount: candidate.wordCount,
      coverageCount: candidate.tabsCoveredByThisCandidate.size,
      frequency: candidate.frequency,
      score,
    });
  }

  rankedCandidates.sort((a, b) => (
    b.score - a.score
    || b.coverageCount - a.coverageCount
    || b.wordCount - a.wordCount
    || a.text.localeCompare(b.text)
  ));

  return rankedCandidates;
}

/**
 * Finds the most common hostname keyword among tabs as a fallback group name.
 * Only returns a result if a single hostname covers at least 50% of tabs.
 *
 * @returns {string|null} The dominant hostname keyword, or null if none qualifies
 */
function chooseMostCommonHostnameAsFallback(tabs) {
  const tabList = Array.isArray(tabs) ? tabs : [];
  if (tabList.length === 0) return null;

  const hostnameOccurrenceCounts = new Map();
  for (const tab of tabList) {
    const uniqueKeywords = new Set(extractKeywordsFromHostname(tab?.url || ''));
    for (const keyword of uniqueKeywords) {
      hostnameOccurrenceCounts.set(keyword, (hostnameOccurrenceCounts.get(keyword) || 0) + 1);
    }
  }

  let bestHostname = null;
  let bestCount = 0;
  for (const [keyword, count] of hostnameOccurrenceCounts.entries()) {
    if (count > bestCount || (count === bestCount && keyword < bestHostname)) {
      bestHostname = keyword;
      bestCount = count;
    }
  }

  if (!bestHostname) return null;
  const coverageRatio = bestCount / tabList.length;
  if (coverageRatio < 0.5) return null;
  return bestHostname;
}

/**
 * Generates the best possible group name by analyzing the titles and URLs
 * of all tabs in the group.
 *
 * @param {Array} tabs - The tabs in the group
 * @returns {{ name: string, words: number, score: number, reason: string, candidateType: string }}
 */
export function generateBestGroupNameFromTabs(tabs) {
  const rankedCandidates = rankAllNameCandidatesByRelevance(tabs);
  const bestSingleWord = rankedCandidates.find((candidate) => candidate.wordCount === 1);
  const bestWordPair = rankedCandidates.find((candidate) => candidate.wordCount === 2);

  let chosenCandidate = bestSingleWord || bestWordPair || null;
  if (bestWordPair && (!bestSingleWord || bestWordPair.score >= bestSingleWord.score - 0.15)) {
    chosenCandidate = bestWordPair;
  }

  // If the best candidate's signal is too weak, prefer a stable hostname fallback.
  if (!chosenCandidate || chosenCandidate.score < 1.2) {
    const fallbackHostname = chooseMostCommonHostnameAsFallback(tabs);
    if (fallbackHostname) {
      return {
        name: capitalizeFirstLetterOfEachWord(fallbackHostname),
        words: 1,
        score: 0,
        reason: 'hostname-fallback',
        candidateType: 'fallback-host',
      };
    }
  }

  if (!chosenCandidate) {
    return {
      name: 'Tabs',
      words: 1,
      score: 0,
      reason: 'generic-fallback',
      candidateType: 'fallback-generic',
    };
  }

  return {
    name: capitalizeFirstLetterOfEachWord(chosenCandidate.text),
    words: chosenCandidate.wordCount,
    score: chosenCandidate.score,
    reason: 'scored',
    candidateType: chosenCandidate.kind,
  };
}
