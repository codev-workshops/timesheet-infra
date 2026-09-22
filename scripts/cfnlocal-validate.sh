#!/usr/bin/env bash
# Validate one or more CloudFormation templates against LocalStack (shape check only).
# Usage: scripts/cfnlocal-validate.sh [template ...]   (defaults to every cloudformation/*.yaml)
set -euo pipefail

export AWS_ENDPOINT_URL="${LOCALSTACK_ENDPOINT:-http://localhost:4566}"
export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-test}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-test}"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-us-east-1}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATES=("$@")
[ "${#TEMPLATES[@]}" -eq 0 ] && TEMPLATES=("${ROOT}"/cloudformation/*.yaml)

for t in "${TEMPLATES[@]}"; do
  echo ">> validate-template ${t}"
  aws cloudformation validate-template --template-body "file://${t}" --output table
done
