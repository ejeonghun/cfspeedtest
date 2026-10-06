# Contributing

Thanks for contributing to cfspeedtest. Keep changes focused and include or update tests when
appropriate.

## Development

- Use Node.js 22 or later.
- Install dependencies with `npm ci`.
- Run the tests with `npm test`.
- Run the project checks with `npm run check`.

The default `npm test` suite and CI Node.js 22/24 unit matrix use offline local
HTTP mocks and metadata/registry fixtures. Keep live requests out of those tests.
After the whole matrix succeeds, one separate Node.js 22 CI job packs and globally
installs the candidate from that checkout, then runs exactly once:
`cfspeedtest --json --timeout 120 --max-bytes 330000000`.
This measures the GitHub runner's connection, not the developer's PC. Both the CLI
and the result validator must succeed: complete default results need positive finite
download/upload speeds and duration, nonnegative finite HTTP latency/jitter, and
positive safe byte counters within the combined 330 MB body budget. Optional
loaded metrics and provider metadata may be unavailable. Service errors, timeouts,
invalid results, and network failures fail CI; the job does not rerun the CLI.
The engine's existing bounded HTTP 429 retry handling still applies.
The command has a 120-second deadline and the job has a five-minute timeout,
cancels stale workflow runs, and retains only result JSON and stderr diagnostics
for three days. After validation, the GitHub Summary uses the same eight-row
layout as the default CLI output. The default profile has 315.8 MB
nominal main payload; metadata, lookup, side-ping, retry, and protocol traffic add
traffic (protocol overhead is outside the body budget). Check authorization,
service terms, and costs first. The default profile's existing 25 MB per-request
cap is unchanged. Avoid looping or flooding real endpoints.

Keep [README.md](README.md) and [README.ko.md](README.ko.md), and the English and
Korean [service notices](DISCLAIMER.md), equivalent when changing behavior.
Preserve [LICENSE](LICENSE), [NOTICE](NOTICE), and upstream license text.
