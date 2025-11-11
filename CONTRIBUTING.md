# Contributing to Trailscribe

Thank you for considering a contribution to Trailscribe!  Contributions help make this project useful for everyone.  The following guidelines describe how to propose improvements and ensure a smooth review process.

## Code of conduct

All participants are expected to abide by the [Code of Conduct](CODE_OF_CONDUCT.md).  Be respectful, inclusive and patient when interacting with others.

## How to contribute

1. **Open an issue**: If you discover a bug or have a feature request, open a new issue on GitHub.  Describe the problem, steps to reproduce and the desired outcome.  Mark the issue as a bug or enhancement.
2. **Discuss**: For larger changes, please discuss your idea in the issue before starting implementation.  This helps ensure the work aligns with the project’s goals and avoids duplicated effort.
3. **Fork the repo**: Create your own fork of the repository and clone it locally.
4. **Create a branch**: Use descriptive names such as `fix-idempotency-bug` or `feature-web-search`.
5. **Make changes**: Follow the existing coding style.  Write unit tests for new functionality and run the test suite (`pnpm test`) to ensure nothing breaks.
6. **Update docs**: If your change affects user‑facing behaviour or configuration, update the relevant documentation in the `docs/` folder.
7. **Submit a pull request**: Open a PR against the `main` branch.  Include a summary of what you changed and why.  Reference the corresponding issue.
8. **Address feedback**: Collaborate with reviewers to refine your change.  Once your PR is approved and CI passes, it will be merged.

## Development workflow

This project uses TypeScript and is built with `pnpm`.  To get started:

```bash
pnpm install       # install dependencies
pnpm lint         # run ESLint and Prettier checks
pnpm test         # run unit tests with Jest
pnpm dev          # start a local development server
```

The CI workflow runs linting, type checks and tests automatically on each PR.  Please ensure your changes pass these checks.

## Style guide

* Use TypeScript with strict mode enabled.
* Format code using Prettier (run `pnpm lint --fix` to auto‑fix issues).
* Write small, focused functions with descriptive names.
* Document functions and modules using JSDoc where appropriate.
* Keep responses and commands concise to fit within SMS limits.

Thank you for helping to make Trailscribe better!