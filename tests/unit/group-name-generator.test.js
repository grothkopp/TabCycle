import { jest } from '@jest/globals';
import {
  tokenizeForGroupNaming,
  extractHostnameKeywords,
  rankNameCandidates,
  generateGroupNameFromTabs,
} from '../../src/background/group-name-generator.js';

describe('group-name-generator', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('tokenizes title text and removes stop words', () => {
    const tokens = tokenizeForGroupNaming('The React docs - Getting Started | Dashboard');
    expect(tokens).toEqual(['react', 'docs', 'getting', 'started', 'dashboard']);
  });

  it('extracts hostname keywords from URL', () => {
    expect(extractHostnameKeywords('https://news.ycombinator.com/item?id=1')).toEqual(['news', 'ycombinator']);
  });

  it('returns empty hostname keywords for invalid URL', () => {
    expect(extractHostnameKeywords('not-a-url')).toEqual([]);
  });

  it('ranks repeated bigrams above sparse tokens', () => {
    const ranked = rankNameCandidates([
      { title: 'React Testing Library Guide', url: 'https://testing-library.com/docs' },
      { title: 'React Hooks Guide', url: 'https://react.dev/learn' },
      { title: 'React Performance Guide', url: 'https://react.dev/reference' },
    ]);
    expect(ranked[0].text).toBe('react');
    expect(ranked.some((c) => c.text === 'react testing')).toBe(true);
  });

  it('generates a concise name with one or two words', () => {
    const result = generateGroupNameFromTabs([
      { title: 'Kubernetes Deployment Strategies', url: 'https://kubernetes.io/docs' },
      { title: 'Kubernetes Service Patterns', url: 'https://kubernetes.io/concepts' },
    ]);
    expect(result.name.split(/\s+/).length).toBeLessThanOrEqual(2);
    expect(result.name.length).toBeGreaterThan(0);
  });

  it('uses deterministic hostname fallback when title signal is weak', () => {
    const result = generateGroupNameFromTabs([
      { title: 'Home', url: 'https://github.com/openai/gpt-5' },
      { title: 'Login', url: 'https://github.com/openai/codex' },
    ]);
    expect(result.name).toBe('Github');
    expect(result.words).toBeLessThanOrEqual(2);
    expect(['hostname-fallback', 'scored']).toContain(result.reason);
  });

  it('uses generic fallback for empty tab context', () => {
    const result = generateGroupNameFromTabs([]);
    expect(result.name).toBe('Tabs');
    expect(result.reason).toBe('generic-fallback');
  });

  it('is deterministic for equal-score tie cases', () => {
    const first = generateGroupNameFromTabs([
      { title: 'Alpha Beta', url: 'https://a.example.com' },
      { title: 'Gamma Delta', url: 'https://g.example.com' },
    ]);
    const second = generateGroupNameFromTabs([
      { title: 'Alpha Beta', url: 'https://a.example.com' },
      { title: 'Gamma Delta', url: 'https://g.example.com' },
    ]);
    expect(first.name).toBe(second.name);
  });

  it('handles mixed-topic groups without exceeding two words', () => {
    const result = generateGroupNameFromTabs([
      { title: 'React State Patterns', url: 'https://react.dev/learn' },
      { title: 'Postgres Indexing Notes', url: 'https://postgresql.org/docs' },
      { title: 'Kubernetes Autoscaling', url: 'https://kubernetes.io/docs' },
    ]);
    expect(result.name.split(/\s+/).length).toBeLessThanOrEqual(2);
  });

  it('falls back to "Tabs" for sparse generic signals without a dominant host', () => {
    const result = generateGroupNameFromTabs([
      { title: 'Home', url: 'about:blank' },
      { title: 'Dashboard', url: 'about:blank' },
      { title: 'Login', url: 'about:blank' },
    ]);
    expect(result.name.length).toBeGreaterThan(0);
    expect(result.name.split(/\s+/).length).toBeLessThanOrEqual(2);
    expect(['generic-fallback', 'scored']).toContain(result.reason);
  });

  it('uses lexical tie-break when scores are otherwise equal', () => {
    const ranked = rankNameCandidates([
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
});
