#!/usr/bin/env bash
# Writes the fit-cli run summary to the GitHub Actions job summary.
# Usage: job-summary.sh <fit-cli-outcome>
# Relies on GITHUB_STEP_SUMMARY, GITHUB_REPOSITORY and GITHUB_RUN_ID from the runner.
set -euo pipefail

outcome="${1:-unknown}"

{
  echo "## fit-cli Run Artifacts"
  echo ""
  echo "**fit-cli result:** ${outcome}"
  echo ""
  echo "Artifacts are attached to [this run](https://github.com/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}) as \`fit-cli-run-${GITHUB_RUN_ID}\`."
  echo ""
  echo "**S3:** \`s3://fit-cli/runs/${GITHUB_RUN_ID}/\` ([console](https://us-west-2.console.aws.amazon.com/s3/buckets/fit-cli?region=us-west-2&prefix=runs/${GITHUB_RUN_ID}/))."
  echo ""
  echo "### Files"
  echo '```'
  find /tmp/fit-cli -type f 2>/dev/null | sort || echo "(none)"
  echo '```'
} >> "$GITHUB_STEP_SUMMARY"
