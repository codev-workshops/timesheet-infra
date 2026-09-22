#!/usr/bin/env bash
# Adopt the existing (Terraform-created) DynamoDB tables into the serverless stack via a
# CloudFormation IMPORT change set, then deploy the full template on top.
#
# Usage: scripts/cfnlocal-import-tables.sh [stack-name] [Key=Value ...]
#   stack-name defaults to timesheet-serverless.
#
# Steps:
#   1. create-change-set --change-set-type IMPORT with cloudformation/serverless-import-only.yaml
#      (an IMPORT change set may contain ONLY the imported resources) and
#      cloudformation/serverless-import.json (ResourcesToImport, keyed by TableName)
#   2. execute-change-set and wait for IMPORT_COMPLETE
#   3. `cloudformation deploy` cloudformation/serverless.yaml (normal UPDATE) to add the
#      Lambda / HTTP API / S3 resources next to the imported tables
#
# Targets LocalStack via LOCALSTACK_ENDPOINT (default http://localhost:4566). For real AWS:
#   AWS_ENDPOINT_URL= AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... AWS_DEFAULT_REGION=us-east-1 \
#     scripts/cfnlocal-import-tables.sh timesheet-serverless
# (an explicitly empty AWS_ENDPOINT_URL disables the LocalStack endpoint; real credentials are
#  taken from the environment / profile as usual).
set -euo pipefail

STACK_NAME="${1:-timesheet-serverless}"
[ "$#" -gt 0 ] && shift

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMPORT_TEMPLATE="${ROOT}/cloudformation/serverless-import-only.yaml"
FULL_TEMPLATE="${ROOT}/cloudformation/serverless.yaml"
RESOURCES_TO_IMPORT="${ROOT}/cloudformation/serverless-import.json"
CHANGE_SET_NAME="import-tables-$(date +%s)"

if [ -z "${AWS_ENDPOINT_URL+x}" ]; then
  export AWS_ENDPOINT_URL="${LOCALSTACK_ENDPOINT:-http://localhost:4566}"
elif [ -z "${AWS_ENDPOINT_URL}" ]; then
  unset AWS_ENDPOINT_URL  # real AWS
fi
if [ -n "${AWS_ENDPOINT_URL:-}" ]; then
  export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-test}"
  export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-test}"
fi
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-us-east-1}"

PARAMS=()
CFN_PARAMS=()
for kv in "$@"; do
  PARAMS+=("${kv}")
  CFN_PARAMS+=("ParameterKey=${kv%%=*},ParameterValue=${kv#*=}")
done

echo ">> endpoint: ${AWS_ENDPOINT_URL:-<real AWS>}  region: ${AWS_DEFAULT_REGION}  stack: ${STACK_NAME}"

# An IMPORT change set creates the stack if it does not exist yet, or imports into an existing one.
if aws cloudformation describe-stacks --stack-name "${STACK_NAME}" >/dev/null 2>&1; then
  echo ">> stack ${STACK_NAME} exists; importing tables into it"
else
  echo ">> stack ${STACK_NAME} does not exist; IMPORT change set will create it"
fi

echo ">> [1/3] create-change-set --change-set-type IMPORT (${CHANGE_SET_NAME})"
aws cloudformation create-change-set \
  --stack-name "${STACK_NAME}" \
  --change-set-name "${CHANGE_SET_NAME}" \
  --change-set-type IMPORT \
  --resources-to-import "file://${RESOURCES_TO_IMPORT}" \
  --template-body "file://${IMPORT_TEMPLATE}" \
  --capabilities CAPABILITY_NAMED_IAM \
  ${CFN_PARAMS[@]+"--parameters" "${CFN_PARAMS[@]}"} \
  --output table

echo ">> waiting for change set to be created"
aws cloudformation wait change-set-create-complete \
  --stack-name "${STACK_NAME}" --change-set-name "${CHANGE_SET_NAME}"
aws cloudformation describe-change-set --stack-name "${STACK_NAME}" --change-set-name "${CHANGE_SET_NAME}" \
  --query 'Changes[].ResourceChange.{Action:Action,LogicalId:LogicalResourceId,Type:ResourceType,PhysicalId:PhysicalResourceId}' --output table

echo ">> [2/3] execute-change-set"
aws cloudformation execute-change-set --stack-name "${STACK_NAME}" --change-set-name "${CHANGE_SET_NAME}"
aws cloudformation wait stack-import-complete --stack-name "${STACK_NAME}"
aws cloudformation describe-stacks --stack-name "${STACK_NAME}" \
  --query 'Stacks[0].{Name:StackName,Status:StackStatus}' --output table

echo ">> [3/3] deploy full template ${FULL_TEMPLATE}"
DEPLOY_PARAMS=()
[ "${#PARAMS[@]}" -gt 0 ] && DEPLOY_PARAMS=(--parameter-overrides "${PARAMS[@]}")
aws cloudformation deploy \
  --stack-name "${STACK_NAME}" \
  --template-file "${FULL_TEMPLATE}" \
  --capabilities CAPABILITY_NAMED_IAM CAPABILITY_AUTO_EXPAND \
  --no-fail-on-empty-changeset \
  ${DEPLOY_PARAMS[@]+"${DEPLOY_PARAMS[@]}"}

echo ">> final stack status"
aws cloudformation describe-stacks --stack-name "${STACK_NAME}" \
  --query 'Stacks[0].{Name:StackName,Status:StackStatus,Outputs:Outputs}' --output table
