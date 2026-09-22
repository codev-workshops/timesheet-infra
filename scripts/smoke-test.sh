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
  # Stage 1: DynamoDB tables (users, clients, work_entries), Lambda, HTTP API, S3 frontend bucket.
  local stack="${SERVERLESS_STACK:-timesheet-serverless}" app="${APP_NAME:-client-timesheet-app}"
  check "stack ${stack} is *_COMPLETE" stack_complete "${stack}"

  local tables t
  tables="$(aws dynamodb list-tables --query 'TableNames' --output text)"
  for t in "${app}-users" "${app}-clients" "${app}-work-entries"; do
    check "dynamodb table ${t} exists" grep -qw "${t}" <<<"${tables}"
  done

  # apigatewayv2 is not part of every LocalStack license (Community/Hobby); fall back to the
  # CloudFormation resource status when the API call itself is rejected.
  local apis
  if apis="$(aws apigatewayv2 get-apis --query "Items[?Name=='${app}-api' && ProtocolType=='HTTP'].ApiId" --output text 2>/dev/null)"; then
    check "http api ${app}-api exists" test -n "${apis}"
  else
    echo "SKIP: apigatewayv2 API not available on this LocalStack license; checking stack resource instead"
    check "HttpApi stack resource is CREATE_COMPLETE" test "$(aws cloudformation describe-stack-resource \
      --stack-name "${stack}" --logical-resource-id HttpApi \
      --query 'StackResourceDetail.ResourceStatus' --output text)" = "CREATE_COMPLETE"
  fi

  check "lambda ${app}-api exists" aws lambda get-function --function-name "${app}-api" --query 'Configuration.FunctionName' --output text
  local out; out="$(mktemp)"
  check "lambda invoke returns StatusCode 200" test "$(aws lambda invoke --function-name "${app}-api" \
    --payload '{}' --cli-binary-format raw-in-base64-out "${out}" --query 'StatusCode' --output text)" = "200"
  echo "   invoke response: $(cat "${out}")"; rm -f "${out}"

  local bucket
  bucket="$(aws cloudformation describe-stacks --stack-name "${stack}" \
    --query "Stacks[0].Outputs[?OutputKey=='FrontendBucket'].OutputValue" --output text)"
  check "s3 bucket ${bucket} exists" aws s3api head-bucket --bucket "${bucket}"
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
