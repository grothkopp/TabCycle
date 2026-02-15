# Research: Auto-Name Unnamed Groups

**Branch**: `003-auto-group-names` | **Date**: 2026-02-15

## 1. Method for Generating 1-2 Word Group Names

**Decision**: Use a deterministic hybrid keyphrase approach (RAKE/YAKE-inspired scoring on tab titles and URL-host signals), constrained to unigram/bigram output.

**Rationale**:  
The feature needs local, fast, deterministic output in a Chrome MV3 service worker. Graph or embedding-heavy methods are unnecessary for short tab-title snippets and increase complexity/risk. A lightweight hybrid method works well for short text and keeps behavior testable/reproducible.

**Alternatives considered**:
- **Full TextRank graph ranking** (Mihalcea & Tarau, 2004) — rejected as primary method: effective but overkill for small tab-group text batches; adds graph complexity for marginal gains.
- **LLM/remote summarization** — rejected: violates privacy/least-privilege posture and adds network/runtime risk.
- **Domain-only naming** — rejected: too generic and misses content semantics.

## 2. Candidate Extraction Pipeline

**Decision**: Build candidates from:
1. cleaned title tokens,
2. contiguous 2-word phrases (bigrams),
3. dominant hostname tokens from URLs (domain prior signal).

Apply normalization:
- lowercase,
- remove punctuation and separators (`|`, `-`, `:`),
- remove stopwords and very short tokens,
- discard numeric-only tokens,
- enforce max 2 words in final output.

**Rationale**:  
RAKE emphasizes candidate extraction from content phrases; YAKE emphasizes local text features without external corpora. Combining phrase candidates with host priors improves stability for sparse groups (few tabs, short titles).

**Alternatives considered**:
- **POS tagging / noun phrase parsing** — rejected: no NLP stack in project; language-dependent and heavier for MV3.
- **TF-IDF against external corpus** — rejected: no corpus available in extension runtime.

## 3. Candidate Scoring Strategy

**Decision**: Score each candidate with weighted local features:
- cross-tab coverage (in how many tabs the candidate appears),
- in-title position (earlier terms score higher),
- phrase preference (bigram bonus when confidence is close),
- host prior bonus for dominant domain token overlap,
- generic-token penalty (e.g., "home", "login", "new").

Selection rule:
- choose the highest-scoring candidate,
- prefer bigram if score is meaningfully higher than best unigram,
- otherwise choose best unigram.

**Rationale**:  
YAKE shows local features can rank keywords effectively in single-document contexts. Cross-tab coverage introduces group-level relevance (not just per-tab prominence), which better fits tab groups.

**Alternatives considered**:
- **Simple frequency only** — rejected: often chooses generic tokens.
- **Single-tab lead-title only** — rejected: unstable and not representative of group content.

## 4. Low-Signal Fallback Behavior

**Decision**: Use a deterministic fallback chain when confidence is low:
1. dominant non-generic hostname token (if a clear majority exists),
2. short generic fallback label (`Tabs`).

**Rationale**:  
Spec requires naming to still happen when content is weak while keeping labels short and non-misleading.

**Alternatives considered**:
- Leave unnamed indefinitely — rejected: violates feature intent.
- Randomized fallback among labels — rejected: non-deterministic and hard to test.

## 5. Non-Collision with Group Age Suffix Feature

**Decision**: Introduce explicit base-title composition semantics:
- parse current display title into `{ baseName, ageSuffix }` using existing age-suffix rules,
- auto-naming reads/writes only `baseName`,
- age updater reads/writes only `ageSuffix`,
- compose final display title from both parts in a deterministic order.

**Rationale**:  
This directly enforces clarified requirements that age text is metadata, not the semantic group name, and prevents extension features from overwriting each other.

**Alternatives considered**:
- Treat full title as mutable plain string in each feature — rejected: causes collisions/race overwrites.

## 6. Active User Naming Detection and Abort Policy

**Decision**: Track recent user title-edit activity per group and gate auto-name writes:
- skip auto-naming when group is marked as actively edited,
- before applying an auto-name write, verify edit marker/title snapshot still valid,
- if user edit starts during an in-flight attempt, abort completion and preserve user change.

**Rationale**:  
This fulfills the clarification requiring no auto-naming attempt/overwrite while users are naming groups, including near-threshold races.

**Alternatives considered**:
- Blind last-write-wins update — rejected: violates user-control requirements.
- Global lock for all groups — rejected: unnecessary coupling and avoidable missed naming opportunities.

## 7. References

- Rose, S., Engel, D., Cramer, N., Cowley, W. (2010). *Automatic Keyword Extraction from Individual Documents*. In *Text Mining: Applications and Theory*. [Wiley chapter](https://onlinelibrary.wiley.com/doi/10.1002/9780470689646.ch1), [OSTI record](https://www.osti.gov/biblio/1027832).
- Mihalcea, R., Tarau, P. (2004). *TextRank: Bringing Order into Text*. EMNLP 2004. [ACL Anthology](https://aclanthology.org/W04-3252/).
- Campos, R., Mangaravite, V., Pasquali, A., Jorge, A., Nunes, C., Jatowt, A. (2020). *YAKE! Keyword extraction from single documents using multiple local features*. [ScienceDirect entry](https://www.sciencedirect.com/science/article/pii/S0020025519308588), [semantic summary](https://www.semanticscholar.org/paper/YAKE!-Keyword-extraction-from-single-documents-Campos-Mangaravite/8f6e1f2586f00f5e878f6f2d5f8f19c1bdf4fc4e).
- Chrome Extensions API documentation: tab group title updates. [chrome.tabGroups reference](https://developer.chrome.com/docs/extensions/reference/api/tabGroups), [chrome.tabGroups.update](https://developer.chrome.com/docs/extensions/reference/api/tabGroups#method-update).
