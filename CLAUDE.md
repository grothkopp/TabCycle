# TabCycle Development Guidelines

Auto-generated from all feature plans. Last updated: 2026-02-16

## Active Technologies

- JavaScript ES Modules (native, no transpilation) + None (vanilla JS, Chrome Extension APIs) (004-extended-config)

## Project Structure

```text
src/
tests/
```

## Commands

npm test && npm run lint

## Code Style

JavaScript ES Modules (native, no transpilation): Follow standard conventions

## Recent Changes

- 004-extended-config: Added JavaScript ES Modules (native, no transpilation) + None (vanilla JS, Chrome Extension APIs)

<!-- MANUAL ADDITIONS START -->

## Testing

- `npm test` launches real Chrome e2e tests that take ~2 minutes and steal screen focus. **Only run the test suite once per task.** Pipe output to a file (`npm test 2>&1 > /tmp/test-output.txt`) and read that file for further analysis instead of re-running.
- To run only unit/integration tests without Chrome: `npx jest --testPathIgnorePatterns='e2e-chrome'`

<!-- MANUAL ADDITIONS END -->
