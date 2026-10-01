#!/usr/bin/env bash
# Package the Lambda, upload it to the bootstrap deployment bucket and deploy the
# CloudFormation stacks in dependency order: bootstrap -> infrastructure -> serverless.
#
# Usage: scripts/deploy.sh [all|bootstrap|infrastructure|serverless]...
#        scripts/deploy.sh [destroy|destroy-serverless|destroy-infrastructure|destroy-bootstrap]...
#
# destroy-serverless empties the frontend bucket first (CloudFormation cannot delete a
# non-empty bucket). Retained resources (DynamoDB tables, SonarQube EFS, deployment
# bucket) survive stack deletion and must be removed manually.
#
# Environment:
#   AWS_REGION          Region (default us-east-1)
#   ENDPOINT_URL        Optional endpoint override, e.g. http://localhost:4566 (LocalStack)
#   STACK_PREFIX        Stack name prefix (default client-timesheet)
#   ENVIRONMENT         Environment parameter (default production)
#   ALLOW_DESTROY       bootstrap AllowDestroy (default true)
#   INSTANCE_TYPE       infrastructure InstanceType (default t3.micro)
#   AMI_SSM_PARAMETER   SSM parameter name for the AMI (default: AL2023 public parameter)
#   INFRA_VPC_ID / INFRA_SUBNET_ID   Optional; empty = default VPC / first-AZ default subnet
#   ENABLE_SONARQUBE    serverless EnableSonarqube (default true)
#   VPC_ID / SUBNET_IDS SonarQube network; auto-discovered from the default VPC when empty
#   LAMBDA_ZIP          Prebuilt Lambda zip (default terraform/serverless/lambda-placeholder.zip)
#   LAMBDA_SOURCE_DIR   If set, zip this directory (after npm ci --omit=dev) instead of LAMBDA_ZIP
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CFN_DIR="${ROOT}/cloudformation"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"
STACK_PREFIX="${STACK_PREFIX:-client-timesheet}"
ENVIRONMENT="${ENVIRONMENT:-production}"
BOOTSTRAP_STACK="${STACK_PREFIX}-bootstrap"
INFRA_STACK="${STACK_PREFIX}-infrastructure"
SERVERLESS_STACK="${STACK_PREFIX}-serverless"
STACK_TAGS=(Project=client-timesheet-app ManagedBy=cloudformation "Environment=${ENVIRONMENT}")

cli() {
  aws ${ENDPOINT_URL:+--endpoint-url "$ENDPOINT_URL"} --region "$REGION" "$@"
}

stack_output() {
  cli cloudformation describe-stacks --stack-name "$1" \
    --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text
}

deploy_stack() {
  local stack="$1" template="$2"
  shift 2
  echo ">> deploying ${stack} (${template})"
  cli cloudformation deploy \
    --stack-name "$stack" \
    --template-file "${CFN_DIR}/${template}" \
    --capabilities CAPABILITY_NAMED_IAM \
    --no-fail-on-empty-changeset \
    --tags "${STACK_TAGS[@]}" \
    ${1:+--parameter-overrides "$@"}
  cli cloudformation describe-stacks --stack-name "$stack" \
    --query "Stacks[0].[StackName,StackStatus]" --output text
}

package_lambda() {
  local bucket="$1" zip sha key
  if [[ -n "${LAMBDA_SOURCE_DIR:-}" ]]; then
    zip="$(mktemp -d)/lambda.zip"
    (cd "$LAMBDA_SOURCE_DIR" && npm ci --omit=dev >/dev/null && zip -qr "$zip" . -x '*.env*' '.git/*')
  else
    zip="${LAMBDA_ZIP:-${ROOT}/terraform/serverless/lambda-placeholder.zip}"
  fi
  sha="$(sha256sum "$zip" | cut -c1-16)"
  key="lambda/api-${sha}.zip"
  if ! cli s3api head-object --bucket "$bucket" --key "$key" >/dev/null 2>&1; then
    echo ">> uploading ${zip} -> s3://${bucket}/${key}" >&2
    cli s3 cp --only-show-errors "$zip" "s3://${bucket}/${key}" >&2
  fi
  echo "$key"
}

discover_default_network() {
  if [[ -z "${VPC_ID:-}" ]]; then
    VPC_ID="$(cli ec2 describe-vpcs --filters Name=isDefault,Values=true \
      --query 'Vpcs[0].VpcId' --output text)"
    if [[ "$VPC_ID" == "None" ]]; then VPC_ID=""; fi
  fi
  if [[ -z "${SUBNET_IDS:-}" && -n "$VPC_ID" ]]; then
    SUBNET_IDS="$(cli ec2 describe-subnets \
      --filters "Name=vpc-id,Values=${VPC_ID}" Name=default-for-az,Values=true \
      --query 'sort_by(Subnets,&AvailabilityZone)[:2].SubnetId' --output text | tr -s '\t ' ',')"
    if [[ "$SUBNET_IDS" == "None" ]]; then SUBNET_IDS=""; fi
  fi
}

deploy_bootstrap() {
  deploy_stack "$BOOTSTRAP_STACK" bootstrap.yaml \
    "AllowDestroy=${ALLOW_DESTROY:-true}"
}

deploy_infrastructure() {
  local params=(
    "BootstrapStackName=${BOOTSTRAP_STACK}"
    "Environment=${ENVIRONMENT}"
    "InstanceType=${INSTANCE_TYPE:-t3.micro}"
    "VpcId=${INFRA_VPC_ID:-}"
    "SubnetId=${INFRA_SUBNET_ID:-}"
  )
  if [[ -n "${AMI_SSM_PARAMETER:-}" ]]; then params+=("LatestAmiId=${AMI_SSM_PARAMETER}"); fi
  deploy_stack "$INFRA_STACK" infrastructure.yaml "${params[@]}"
}

deploy_serverless() {
  local bucket key enable="${ENABLE_SONARQUBE:-true}"
  bucket="$(stack_output "$BOOTSTRAP_STACK" DeploymentBucketName)"
  key="$(package_lambda "$bucket")"
  if [[ "$enable" == "true" ]]; then
    discover_default_network
    if [[ -z "${SUBNET_IDS:-}" ]]; then
      echo "ERROR: ENABLE_SONARQUBE=true but no subnets found; set VPC_ID/SUBNET_IDS" >&2
      exit 1
    fi
  fi
  deploy_stack "$SERVERLESS_STACK" serverless.yaml \
    "Environment=${ENVIRONMENT}" \
    "LambdaCodeS3Bucket=${bucket}" \
    "LambdaCodeS3Key=${key}" \
    "EnableSonarqube=${enable}" \
    "VpcId=${VPC_ID:-}" \
    "SonarqubeSubnetIds=${SUBNET_IDS:-}"
}

destroy_stack() {
  local stack="$1"
  echo ">> deleting ${stack}"
  cli cloudformation delete-stack --stack-name "$stack"
  cli cloudformation wait stack-delete-complete --stack-name "$stack"
}

destroy_serverless() {
  local bucket
  bucket="$(stack_output "$SERVERLESS_STACK" FrontendBucket 2>/dev/null || true)"
  if [[ -n "$bucket" && "$bucket" != "None" ]]; then
    echo ">> emptying s3://${bucket}"
    cli s3 rm --only-show-errors --recursive "s3://${bucket}"
  fi
  destroy_stack "$SERVERLESS_STACK"
}

targets=("$@")
[[ ${#targets[@]} -eq 0 ]] && targets=(all)
for target in "${targets[@]}"; do
  case "$target" in
    all) deploy_bootstrap; deploy_infrastructure; deploy_serverless ;;
    bootstrap) deploy_bootstrap ;;
    infrastructure) deploy_infrastructure ;;
    serverless) deploy_serverless ;;
    destroy) destroy_serverless; destroy_stack "$INFRA_STACK"; destroy_stack "$BOOTSTRAP_STACK" ;;
    destroy-serverless) destroy_serverless ;;
    destroy-infrastructure) destroy_stack "$INFRA_STACK" ;;
    destroy-bootstrap) destroy_stack "$BOOTSTRAP_STACK" ;;
    *) echo "unknown target: $target" >&2; exit 2 ;;
  esac
done
