#!/usr/bin/env bash
# Smoke tests against stacks deployed to LocalStack.
#
# Usage: scripts/smoke-test.sh <stage>
#   stage: scaffold | serverless | sonarqube | infrastructure | bootstrap | all
#
# Each stage's tests are filled in by the migration PR that introduces that stack.
set -euo pipefail

export AWS_ENDPOINT_URL="${LOCALSTACK_ENDPOINT:-http://localhost:4566}"
export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-test}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-test}"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-us-east-1}"

STAGE="${1:-all}"
FAILURES=0

check() { # check <description> <command...>
  local desc="$1"; shift
  if "$@"; then echo "PASS: ${desc}"; else echo "FAIL: ${desc}"; FAILURES=$((FAILURES+1)); fi
}

stack_complete() { # stack_complete <stack-name>
  local status
  status="$(aws cloudformation describe-stacks --stack-name "$1" --query 'Stacks[0].StackStatus' --output text)"
  echo "   ${1}: ${status}"
  [[ "${status}" == *_COMPLETE ]] && [[ "${status}" != ROLLBACK_COMPLETE ]]
}

smoke_scaffold() {
  check "LocalStack health endpoint reachable" curl -sf "${AWS_ENDPOINT_URL}/_localstack/health" -o /dev/null
  check "cloudformation list-stacks works" aws cloudformation list-stacks --query 'length(StackSummaries)' --output text
}

smoke_serverless() {
  # Stage 1: DynamoDB tables (users, clients, work_entries), Lambda, Function URL, HTTP API, S3 frontend bucket.
  echo "TODO(stage-1): implement serverless smoke tests"
}

smoke_sonarqube() {
  # Stage 2: ECS/EFS are not runnable on LocalStack Community -> template validation only.
  echo "TODO(stage-2): validate cloudformation/sonarqube.yaml"
}

smoke_infrastructure() {
  # Stage 3: EC2 not fully supported on LocalStack Community -> template validation only.
  echo "TODO(stage-3): validate cloudformation/infrastructure.yaml"
}

smoke_bootstrap() {
  # Stage 4: ECR repository, OIDC provider, deploy role, exported Outputs.
  echo "TODO(stage-4): implement bootstrap smoke tests"
}

case "${STAGE}" in
  scaffold) smoke_scaffold ;;
  serverless) smoke_serverless ;;
  sonarqube) smoke_sonarqube ;;
  infrastructure) smoke_infrastructure ;;
  bootstrap) smoke_bootstrap ;;
  all) smoke_scaffold; smoke_bootstrap; smoke_serverless; smoke_sonarqube; smoke_infrastructure ;;
  *) echo "unknown stage: ${STAGE}" >&2; exit 2 ;;
esac

echo
if [ "${FAILURES}" -eq 0 ]; then echo "smoke-test(${STAGE}): OK"; else echo "smoke-test(${STAGE}): ${FAILURES} failure(s)"; exit 1; fi
