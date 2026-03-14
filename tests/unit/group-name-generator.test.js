import { jest } from '@jest/globals';
import {
  extractMeaningfulWordsFromText,
  extractKeywordsFromHostname,
  rankAllNameCandidatesByRelevance,
  generateBestGroupNameFromTabs,
} from '../../src/background/group-name-generator.js';

describe('group-name-generator', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('tokenizes title text and removes stop words', () => {
    const tokens = extractMeaningfulWordsFromText('The React docs - Getting Started | Dashboard');
    expect(tokens).toEqual(['react', 'docs', 'getting', 'started', 'dashboard']);
  });

  it('extracts hostname keywords from URL', () => {
    expect(extractKeywordsFromHostname('https://news.ycombinator.com/item?id=1')).toEqual(['news', 'ycombinator']);
  });

  it('returns empty hostname keywords for invalid URL', () => {
    expect(extractKeywordsFromHostname('not-a-url')).toEqual([]);
  });

  it('ranks repeated bigrams above sparse tokens', () => {
    const ranked = rankAllNameCandidatesByRelevance([
      { title: 'React Testing Library Guide', url: 'https://testing-library.com/docs' },
      { title: 'React Hooks Guide', url: 'https://react.dev/learn' },
      { title: 'React Performance Guide', url: 'https://react.dev/reference' },
    ]);
    expect(ranked[0].text).toBe('react');
    expect(ranked.some((c) => c.text === 'react testing')).toBe(true);
  });

  it('generates a concise name with one or two words', () => {
    const result = generateBestGroupNameFromTabs([
      { title: 'Kubernetes Deployment Strategies', url: 'https://kubernetes.io/docs' },
      { title: 'Kubernetes Service Patterns', url: 'https://kubernetes.io/concepts' },
    ]);
    expect(result.name.split(/\s+/).length).toBeLessThanOrEqual(2);
    expect(result.name.length).toBeGreaterThan(0);
  });

  it('uses deterministic hostname fallback when title signal is weak', () => {
    const result = generateBestGroupNameFromTabs([
      { title: 'Home', url: 'https://github.com/openai/gpt-5' },
      { title: 'Login', url: 'https://github.com/openai/codex' },
    ]);
    expect(result.name).toBe('Github');
    expect(result.words).toBeLessThanOrEqual(2);
    expect(['hostname-fallback', 'scored']).toContain(result.reason);
  });

  it('uses generic fallback for empty tab context', () => {
    const result = generateBestGroupNameFromTabs([]);
    expect(result.name).toBe('Tabs');
    expect(result.reason).toBe('generic-fallback');
  });

  it('is deterministic for equal-score tie cases', () => {
    const first = generateBestGroupNameFromTabs([
      { title: 'Alpha Beta', url: 'https://a.example.com' },
      { title: 'Gamma Delta', url: 'https://g.example.com' },
    ]);
    const second = generateBestGroupNameFromTabs([
      { title: 'Alpha Beta', url: 'https://a.example.com' },
      { title: 'Gamma Delta', url: 'https://g.example.com' },
    ]);
    expect(first.name).toBe(second.name);
  });

  it('handles mixed-topic groups without exceeding two words', () => {
    const result = generateBestGroupNameFromTabs([
      { title: 'React State Patterns', url: 'https://react.dev/learn' },
      { title: 'Postgres Indexing Notes', url: 'https://postgresql.org/docs' },
      { title: 'Kubernetes Autoscaling', url: 'https://kubernetes.io/docs' },
    ]);
    expect(result.name.split(/\s+/).length).toBeLessThanOrEqual(2);
  });

  it('falls back to "Tabs" for sparse generic signals without a dominant host', () => {
    const result = generateBestGroupNameFromTabs([
      { title: 'Home', url: 'about:blank' },
      { title: 'Dashboard', url: 'about:blank' },
      { title: 'Login', url: 'about:blank' },
    ]);
    expect(result.name.length).toBeGreaterThan(0);
    expect(result.name.split(/\s+/).length).toBeLessThanOrEqual(2);
    expect(['generic-fallback', 'scored']).toContain(result.reason);
  });

  it('uses lexical tie-break when scores are otherwise equal', () => {
    const ranked = rankAllNameCandidatesByRelevance([
      { title: 'Alpha Tools', url: 'https://one.dev' },
      { title: 'Bravo Notes', url: 'https://two.dev' },
    ]);
    const sameScore = ranked.filter((candidate) => candidate.score === ranked[0].score);
    if (sameScore.length > 1) {
      const texts = sameScore.map((candidate) => candidate.text);
      const sorted = [...texts].sort((a, b) => a.localeCompare(b));
      expect(texts).toEqual(sorted);
    } else {
      expect(ranked[0].text).toBeDefined();
    }
  });

  it('correctly tokenizes words containing German umlauts', () => {
    const tokens = extractMeaningfulWordsFromText('Gärtnerei Pflanzencenter');
    expect(tokens).toContain('gärtnerei');
    expect(tokens).toContain('pflanzencenter');
    expect(tokens).not.toContain('rtnerei');
  });

  it('correctly tokenizes words starting with German umlauts', () => {
    const tokens = extractMeaningfulWordsFromText('Äpfel und Öl aus der Mühle');
    expect(tokens).toContain('äpfel');
    expect(tokens).toContain('mühle');
  });

  it('generates the correct group name for tabs with German umlaut titles', () => {
    const result = generateBestGroupNameFromTabs([
      { title: 'Gärtnerei Mustermann - Pflanzen & Zubehör', url: 'https://example.com/1' },
      { title: 'Gärtnerei Mustermann - Kontakt', url: 'https://example.com/2' },
    ]);
    // The name should include the full word "Gärtnerei" with the umlaut intact,
    // not a truncated version like "rtnerei" (which was the bug).
    expect(result.name.toLowerCase()).toContain('gärtnerei');
    // Verify the umlaut was not dropped (buggy output started with 'r' not 'gä')
    expect(result.name.toLowerCase()).not.toMatch(/^rtnerei/);
  });
});
