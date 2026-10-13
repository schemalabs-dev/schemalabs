# Schema Labs Engine

> High-performance, browser-local JSON Schema validation and API contract drift analysis.

[![CI](https://github.com/schemalabs-dev/schemalabs/actions/workflows/test.yml/badge.svg)](https://schemalabs.co.uk)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Engine: Ajv](https://img.shields.io/badge/Ajv-2020--12%20%7C%20Draft--07-31563d.svg)](https://ajv.js.org/)

Schema Labs provides client-isolated tools for API contract governance and schema evolution. It detects breaking changes, validates payloads against strict JSON Schema specifications, and generates deterministic migration findings without uploading schemas to third-party servers.

Live Developer Preview: [https://schemalabs.co.uk](https://schemalabs.co.uk)

---

## Key Features

- **Client-Side Execution:** All validation and comparison runs inside a sandboxed Web Worker. Schemas and payloads never leave your browser tab.
- **Dialect Support:** Full compliance with JSON Schema **Draft-07** and **2020-12** via Ajv.
- **Granular Severity Rules:**
  - `breaking`: Constraint tightening, type removal, property addition to closed objects, required field additions.
  - `review`: Composition shifts (`anyOf`, `oneOf`, `allOf`), pattern updates, description modifications.
  - `compatible`: Relaxed boundaries, optional field additions, safe documentation updates.
- **Claude AI Migration Explainer (Beta):** Optional. With your own Anthropic key (or the offline mock), sends only the breaking findings straight from your browser to `api.anthropic.com` and returns a migration brief, an adapter schema sketch and a regression test.
- **Zero Tracking:** No analytics cookies, no telemetry, strict Content Security Policy (`connect-src` allows only `https://api.anthropic.com`, used solely by the optional explainer).

---

## Architecture & Project Structure

```text
├── bin/
│   └── schemalabs.js   # CLI runner (text, JSON and SARIF output)
├── src/
│   ├── engine.js       # Core comparison & validation engine (Ajv 2020-12 & Draft-07)
│   ├── sarif.js        # SARIF v2.1.0 export for GitHub code scanning
│   └── samples.js      # Baseline and candidate test schemas
├── public/
│   ├── assets/         # Bundled engine, workers, CSS ("the editor's proof" system)
│   ├── index.html      # Interactive review sheet & live diff demonstration
│   ├── playground.html # Dual-mode editor (Compare Schema vs Validate Payload)
│   ├── docs.html       # Dialect compatibility matrix and API specifications
│   └── about.html      # Governance principles and company disclosures
└── tests/
    ├── engine.test.js  # Node.js test runner suite (86 unit tests, 100% line coverage of src/)
    ├── fixtures/       # Official OASIS SARIF 2.1.0 JSON Schema used to validate exports
    └── site.browser.mjs# Playwright E2E browser regression suite (81 verification points)
```

---

## Getting Started

### Prerequisites

- Node.js >= 18.0.0
- npm >= 9.0.0

### Installation

```bash
git clone https://github.com/schemalabs-dev/schemalabs.git
cd schemalabs
npm install
```

### Running Tests

```bash
# Run unit test suite
npm test

# Run test coverage audit
npm run test:coverage

# Run local build
npm run build
```

### CLI Usage

```bash
# Human-readable report
node bin/schemalabs.js --baseline s1.json --candidate s2.json

# Raw JSON result for scripts
node bin/schemalabs.js --baseline s1.json --candidate s2.json --format json

# SARIF v2.1.0 for GitHub Code Scanning, written as UTF-8
node bin/schemalabs.js --baseline s1.json --candidate s2.json --format sarif -o results.sarif
```

| Flag | Meaning |
| --- | --- |
| `--baseline <file>` | Schema before the change (required) |
| `--candidate <file>` | Schema after the change (required) |
| `--format text\|json\|sarif` | Output format, `text` by default (`--json` is a shorthand for `--format json`) |
| `--output <file>`, `-o <file>` | Write the result to a UTF-8 file instead of standard output |

Exit codes: `0` no breaking change, `1` at least one breaking change, `2` usage or input error. A GitHub Actions workflow that uploads the SARIF file with `github/codeql-action/upload-sarif@v3` is in the [documentation](https://schemalabs.co.uk/docs.html#ci).

---

## Operating Company

Schema Labs Ltd is registered in England and Wales under Company No. 15348827.  
Registered Office: 20 Wenlock Road, London, England, N1 7GU.

For technical governance and inquiries: `founder@schemalabs.co.uk`

---

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
