# Repository Guidelines

## Project Structure

The Angular frontend lives in `src/`: `app/core` contains shared state and services, `app/features` contains product areas, `app/shared` and `app/ui` contain reusable components, and `public/` holds static assets. The NestJS API is in `server/src`; its unit tests sit beside implementation files and end-to-end tests are in `server/test`. Shared domain contracts are in `contracts/`, with synchronization tooling in `scripts/`.

## Build, Test, and Development

Install frontend dependencies with `npm install`. Use `npm start` to run the Angular app at `http://localhost:4300`, and `npm run build` for a production build. `npm test` runs Angular tests.

The API has its own dependencies and scripts: run `cd server && npm install`, then `npm run db:up` and `npm run start:dev` for local development. Run API unit tests with `npm test`, end-to-end tests with `npm run test:e2e`, and checks with `npm run lint` or `npm run build`. End-to-end tests recreate the `trama_core_test` database; do not point that test configuration at data you need to keep.

## Coding Style

Use two spaces, UTF-8, and a final newline. TypeScript uses single quotes; Prettier is configured for a 100-character print width and Angular HTML templates. Follow nearby Angular and NestJS patterns, use descriptive kebab-case filenames, and model domain concepts with explicit types instead of `any`. Keep persisted domain state separate from UI state and validate external input.

## Testing

API unit tests use Vitest and the `*.spec.ts` suffix. API end-to-end tests use `*.e2e-spec.ts`. Add or update focused tests for behavior changes, and run the relevant suite plus lint/build checks before opening a pull request. No repository-wide coverage threshold is configured.

## Commits and Pull Requests

Recent history uses short imperative summaries; `CONTRIBUTING.md` says there is no strict Conventional Commits requirement. Keep commit messages specific (for example, `Fix workspace scoping in execution query`). Keep pull requests focused and describe the problem, approach, trade-offs, and verification. Include screenshots or recordings for meaningful UI changes, and note migrations or compatibility impacts.

## Security and Configuration

Use `server/.env.example` for local API configuration. Never commit credentials or tokens. Read `SECURITY.md` before changing authentication, authorization, integrations, webhooks, or agent execution.
