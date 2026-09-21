# CDK implementation (TypeScript)

This directory is an AWS CDK (TypeScript) port of the three Terraform stacks in
[`../terraform`](../terraform). It is an **additive, parallel implementation** — the
Terraform code is unchanged and remains the source of truth for the currently deployed
resources.

| CDK stack             | Terraform source            | Contents                                                                                      |
| --------------------- | --------------------------- | --------------------------------------------------------------------------------------------- |
| `BootstrapStack`      | `terraform/bootstrap`       | Terraform state S3 bucket + DynamoDB lock table, ECR repository, GitHub Actions OIDC role     |
| `InfrastructureStack` | `terraform/infrastructure`  | EC2 host (AL2023, default VPC), security group, instance role, Elastic IP, `user_data.sh`     |
| `ServerlessStack`     | `terraform/serverless`      | DynamoDB tables, S3 static frontend, Lambda + Function URL + HTTP API, SonarQube on Fargate   |

Stack code lives in `lib/`, the app entry point in `bin/app.ts`.

## Install / synth / deploy

```bash
cd cdk
npm install

# Synthesize all three stacks (no AWS credentials required, see "Default VPC lookup")
npx cdk synth -c ecr_repository_url=<url> -c ecr_repository_arn=<arn>

# Deploy (requires credentials; `cdk bootstrap` once per account/region)
npx cdk bootstrap
npx cdk deploy BootstrapStack
npx cdk deploy InfrastructureStack \
  -c ecr_repository_url=<BootstrapStack.ecr_repository_url> \
  -c ecr_repository_arn=arn:aws:ecr:us-east-1:<account>:repository/client-timesheet-app
npx cdk deploy ServerlessStack
```

## Inputs (Terraform variables)

Every Terraform variable is exposed as a stack prop **and** as CDK context, using the
Terraform variable name (`-c key=value` or `cdk.json` `context`). Explicit props win over
context, context wins over the default.

| Stack          | Context key           | Default                        |
| -------------- | --------------------- | ------------------------------ |
| all            | `aws_region`          | `us-east-1`                    |
| all            | `account`             | `CDK_DEFAULT_ACCOUNT`          |
| bootstrap      | `allow_destroy`       | `true`                         |
| bootstrap      | `github_org`          | `Cognition-Partner-Workshops`  |
| bootstrap      | `github_repo`         | `hosting-client-timesheet-app` |
| infrastructure | `environment`         | `production`                   |
| infrastructure | `instance_type`       | `t3.micro`                     |
| infrastructure | `app_port`            | `3001`                         |
| infrastructure | `ecr_repository_url`  | **required**                   |
| infrastructure | `ecr_repository_arn`  | **required**                   |
| serverless     | `environment`         | `production`                   |
| serverless     | `app_name`            | `client-timesheet-app`         |
| serverless     | `frontend_domain`     | `""` (unused, kept for parity) |
| serverless     | `lambda_memory_size`  | `256`                          |
| serverless     | `lambda_timeout`      | `30`                           |
| serverless     | `enable_sonarqube`    | `true`                         |
| serverless     | `sonarqube_cpu`       | `512`                          |
| serverless     | `sonarqube_memory`    | `2048`                         |

`ecr_repository_url` / `ecr_repository_arn` have no defaults in Terraform either; they come
from the `BootstrapStack` outputs (`ecr_repository_url`, and the repository ARN
`arn:aws:ecr:<region>:<account>:repository/client-timesheet-app`).

Terraform outputs are emitted as `CfnOutput`s with the same names (CloudFormation strips
the underscores from the logical IDs, e.g. `terraform_state_bucket` -> `terraformstatebucket`).
`dynamodb_tables` is a JSON string since CloudFormation outputs cannot be maps; the
SonarQube outputs are omitted / `"SonarQube disabled"` when `enable_sonarqube=false`.

## Default VPC lookup

`InfrastructureStack` and `ServerlessStack` use the account's default VPC
(`ec2.Vpc.fromLookup({ isDefault: true })`). That lookup needs a concrete account/region and
AWS credentials at synth time, and the result is cached in `cdk.context.json`.

If no account is available (no credentials / `CDK_DEFAULT_ACCOUNT` / `-c account=`), or
`-c offline=true` is passed, `lib/context.ts#lookupDefaultVpc` falls back to placeholder
VPC/subnet IDs so `cdk synth` still succeeds in CI. Templates synthesized that way are for
validation only — do not deploy them.

## Differences from the Terraform stacks

- `ManagedBy` tag is `cdk` / `cdk-bootstrap` instead of `terraform` / `terraform-bootstrap`.
- The Lambda placeholder package is read from `terraform/serverless/lambda-placeholder.zip`
  (or `cdk/lambda-placeholder.zip` if present) rather than duplicated; if neither exists a
  minimal placeholder handler is generated at synth time.
- The SonarQube CloudWatch log group `/ecs/<app_name>-sonarqube` is created explicitly
  (Terraform relies on `awslogs-create-group`).
- `allow_destroy=false` maps to `RemovalPolicy.RETAIN` for the state bucket, lock table and
  ECR repository.
- Terraform's `aws_default_vpc`/`aws_default_subnet` only *adopt* the default VPC; CDK looks
  it up and never manages it.
