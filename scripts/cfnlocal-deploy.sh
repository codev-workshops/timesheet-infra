#!/usr/bin/env bash
# Deploy a CloudFormation template to LocalStack.
#
# Usage: scripts/cfnlocal-deploy.sh <stack-name> <template-file> [Key=Value ...]
# Example: scripts/cfnlocal-deploy.sh timesheet-serverless cloudformation/serverless.yaml Environment=production
set -euo pipefail

STACK_NAME="${1:?stack name required}"
TEMPLATE="${2:?template file required}"
shift 2

export AWS_ENDPOINT_URL="${LOCALSTACK_ENDPOINT:-http://localhost:4566}"
export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-test}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-test}"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-us-east-1}"

PARAMS=()
if [ "$#" -gt 0 ]; then
  PARAMS=(--parameter-overrides "$@")
fi

echo ">> validate-template ${TEMPLATE}"
aws cloudformation validate-template --template-body "file://${TEMPLATE}" >/dev/null

echo ">> deploy ${STACK_NAME} from ${TEMPLATE} -> ${AWS_ENDPOINT_URL}"
aws cloudformation deploy \
  --stack-name "${STACK_NAME}" \
  --template-file "${TEMPLATE}" \
  --capabilities CAPABILITY_NAMED_IAM CAPABILITY_AUTO_EXPAND \
  --no-fail-on-empty-changeset \
  "${PARAMS[@]}"

echo ">> stack status"
aws cloudformation describe-stacks --stack-name "${STACK_NAME}" \
  --query 'Stacks[0].{Name:StackName,Status:StackStatus,Outputs:Outputs}' --output table
