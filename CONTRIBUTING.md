# Contributing

Thanks for contributing to cfspeedtest. Keep changes focused and include or update tests when
appropriate.

## Development

- Use Node.js 22 or later.
- Install dependencies with `npm ci`.
- Run the tests with `npm test`.
- Run the project checks with `npm run check`.

The default tests use offline local HTTP mocks and metadata/registry fixtures.
Do not add live Cloudflare or registry tests to routine CI. A deliberate live
`cfspeedtest --quick` run transfers up to 18.1 MB of nominal main payload plus
metadata, lookup, side-ping, retry, and protocol traffic; check authorization,
service terms, and costs first. Avoid looping or flooding real endpoints.

Keep [README.md](README.md) and [README.ko.md](README.ko.md), and the English and
Korean [service notices](DISCLAIMER.md), equivalent when changing behavior.
Preserve [LICENSE](LICENSE), [NOTICE](NOTICE), and upstream license text.
