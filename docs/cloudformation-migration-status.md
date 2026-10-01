# Terraform → CloudFormation migration status

Scope: `terraform/{bootstrap,infrastructure,serverless}` → `cloudformation/{bootstrap,infrastructure,serverless}.yaml`,
plus `scripts/deploy.sh` (package/upload/deploy) and `localstack/docker-compose.yml` (local test harness).

**Overall status: converted, lint-clean, deploys end-to-end on LocalStack 4.4 (community).**
Several resource types are only mocked by LocalStack community, so a dev-account deploy is still
required before the Terraform modules can be retired (see [Next steps](#recommended-next-steps)).

| Stack | Template | Depends on | Status |
|---|---|---|---|
| `client-timesheet-bootstrap` | `cloudformation/bootstrap.yaml` | – | Converted, LocalStack `CREATE_COMPLETE` |
| `client-timesheet-infrastructure` | `cloudformation/infrastructure.yaml` | bootstrap exports (`Fn::ImportValue`) | Converted, LocalStack `CREATE_COMPLETE` |
| `client-timesheet-serverless` | `cloudformation/serverless.yaml` | bootstrap deployment bucket (parameter, filled by `deploy.sh`) | Converted, LocalStack `CREATE_COMPLETE` (SonarQube on and off) |

## How to deploy

```bash
# real AWS (uses default credentials/region)
scripts/deploy.sh all                       # bootstrap -> infrastructure -> serverless
ENABLE_SONARQUBE=true scripts/deploy.sh serverless

# LocalStack
docker compose -f localstack/docker-compose.yml up -d
ENDPOINT_URL=http://localhost:4566 AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test \
  AWS_DEFAULT_REGION=us-east-1 scripts/deploy.sh all
```

`deploy.sh` zips `lambda/`, uploads it to the bootstrap `DeploymentBucket` under a content-addressed
key (`lambda/api-<sha256[:16]>.zip`), and passes `LambdaCodeS3Bucket`/`LambdaCodeS3Key` to the
serverless stack, so code changes produce a new key and therefore a Lambda update.

## Cross-stack wiring

| Terraform variable / remote value | CloudFormation |
|---|---|
| `ecr_repository_arn` / ECR URL passed into `infrastructure` | bootstrap `Export` `${BootstrapStackName}-EcrRepositoryArn` / `-EcrRepositoryUrl`, consumed with `Fn::ImportValue` |
| Lambda zip path (`filename`, `source_code_hash`) | bootstrap export `-DeploymentBucketName` → `deploy.sh` → `LambdaCodeS3Bucket` / `LambdaCodeS3Key` parameters |
| `aws_region`, `aws_caller_identity` | `AWS::Region`, `AWS::AccountId`, `AWS::Partition` pseudo-parameters |
| `var.enable_sonarqube` | `EnableSonarqube` parameter (`"true"`/`"false"`) + `Conditions` |
| `backend "s3"` | removed – CloudFormation stores stack state |

## Per-module resource mapping

### bootstrap

| Terraform | CloudFormation | Notes |
|---|---|---|
| `aws_s3_bucket.terraform_state` + `_versioning` + `_server_side_encryption_configuration` + `_public_access_block` | `DeploymentBucket` (`AWS::S3::Bucket`, `Retain`/`Retain`) | Repurposed: no state to store, now holds deploy artifacts (Lambda zips). Versioning, AES256, full public-access block preserved as bucket properties. |
| `aws_dynamodb_table.terraform_locks` | – (dropped) | Terraform-only. |
| `aws_iam_openid_connect_provider.github_actions` | `GitHubActionsOidcProvider` (`AWS::IAM::OIDCProvider`) | Same URL, client ID, thumbprints. |
| `aws_iam_role.github_actions_deploy` + 6× `aws_iam_role_policy` | `GitHubActionsDeployRole` with inline `Policies` | Policies merged into the role. Added `cloudformation-read-outputs` so CI can read stack outputs (replaces `terraform output`). |
| `aws_ecr_repository.app` + `aws_ecr_lifecycle_policy.app` | `AppRepository` (`AWS::ECR::Repository` with `LifecyclePolicy`) | `force_delete` → `EmptyOnDelete` driven by `AllowDestroy` parameter. |
| `data.aws_caller_identity` | `AWS::AccountId` | |

### infrastructure

| Terraform | CloudFormation | Notes |
|---|---|---|
| `data.aws_ami.amazon_linux_2023` | `LatestAmiId` parameter, `AWS::SSM::Parameter::Value<AWS::EC2::Image::Id>`, default `/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64` | |
| `data.aws_availability_zones` | `!Select [0, !GetAZs ""]` | Used only when no `SubnetId` is given. |
| `aws_default_vpc` / `aws_default_subnet` | `VpcId` / `SubnetId` parameters (optional; `deploy.sh` discovers the default VPC) | `AWS::EC2::VPC::Default` / `AWS::EC2::Subnet::Default` do not exist as CloudFormation resource types; with empty parameters EC2 places the SG/instance in the default VPC. |
| `aws_security_group.app` | `AppSecurityGroup` | Egress rule emitted only when `VpcId` is set (cfn-lint E3021: `SecurityGroupEgress` requires `VpcId`). |
| `aws_iam_role.ec2_role` + `_role_policy.ecr_policy` + `_role_policy_attachment.ssm_managed_instance` | `Ec2Role` (inline policy + `ManagedPolicyArns`) | ECR ARN via `Fn::ImportValue`. |
| `aws_iam_instance_profile.ec2_profile` | `Ec2InstanceProfile` | |
| `aws_instance.app` + `templatefile("user_data.sh")` | `AppInstance` with `UserData: Fn::Base64: !Sub` | Script inlined; `${...}` Terraform vars → `!Sub` variables, shell `${VAR}` escaped as `${!VAR}`. |
| `aws_eip.app` | `AppEip` (`AWS::EC2::EIP`, `InstanceId`) | |

### serverless

| Terraform | CloudFormation | Notes |
|---|---|---|
| `aws_dynamodb_table.users` / `.clients` / `.work_entries` | `UsersTable` / `ClientsTable` / `WorkEntriesTable` (`Retain`/`Retain`) | Keys, GSIs, PAY_PER_REQUEST and tags preserved. |
| `aws_s3_bucket.frontend` + `_website_configuration` + `_public_access_block` | `FrontendBucket` (`WebsiteConfiguration`, `PublicAccessBlockConfiguration`, `Delete`) | Static site, re-deployable – deleted with the stack (see limitations). |
| `aws_s3_bucket_policy.frontend` (`depends_on` public access block) | `FrontendBucketPolicy` | The PAB is now a property of the bucket, so the policy's `!Ref FrontendBucket` already orders it after the PAB. |
| `aws_iam_role.lambda_role` + `_role_policy.lambda_dynamodb` + `_role_policy_attachment.lambda_logs` | `LambdaRole` | |
| `aws_lambda_function.api` (`filename`, `source_code_hash`) | `ApiFunction` (`Code.S3Bucket`/`S3Key`) | Runtime bumped `nodejs20.x` → `nodejs22.x` (cfn-lint W2531 deprecation). |
| `aws_lambda_function_url.api` | `ApiFunctionUrl` + `ApiFunctionUrlPermission` | CloudFormation needs the explicit `lambda:InvokeFunctionUrl` permission Terraform adds implicitly. |
| `aws_apigatewayv2_api` / `_integration` / `_route` / `_stage` | `HttpApi` / `LambdaIntegration` / `DefaultRoute` / `DefaultStage` | |
| `aws_lambda_permission.api_gateway` | `ApiGatewayInvokePermission` | |
| `data.aws_vpc.default` / `data.aws_subnets.default` | `VpcId` / `SonarqubeSubnetIds` parameters (discovered by `deploy.sh`) | No CloudFormation lookup for "all default subnets". |
| `aws_security_group.sonarqube` | `SonarqubeSecurityGroup` (`Condition: SonarqubeEnabled`) | |
| `aws_ecs_cluster` + `aws_ecs_cluster_capacity_providers` | `SonarqubeCluster` (`CapacityProviders: [FARGATE_SPOT]`, default strategy) | Two Terraform resources → one. |
| `aws_iam_role.ecs_task_execution` + attachment + `_role_policy.ecs_cloudwatch_logs` | `SonarqubeExecutionRole` | |
| `aws_efs_file_system.sonarqube` | `SonarqubeFileSystem` (`Retain`/`Retain`) | SonarQube data. |
| `aws_security_group.efs` | `SonarqubeEfsSecurityGroup` | |
| `aws_efs_mount_target.sonarqube` (`count = min(length(subnets), 2)`) | `SonarqubeMountTargetA` (`SonarqubeEnabled`) + `SonarqubeMountTargetB` (`SonarqubeSecondAz`) | Explicit per-AZ resources. |
| `aws_ecs_task_definition.sonarqube` | `SonarqubeTaskDefinition` | `jsonencode(container_definitions)` → native YAML. |
| `aws_ecs_service.sonarqube` | `SonarqubeService` | Fargate Spot strategy, public IP, all `SonarqubeSubnetIds`. |
| `data.aws_caller_identity` / `data.aws_region` | pseudo-parameters | |

## What converted cleanly

* All DynamoDB tables, IAM roles/policies, Lambda + function URL + permissions, API Gateway v2 HTTP API,
  S3 buckets (website, encryption, versioning, public access block), ECR repo + lifecycle policy,
  OIDC provider, EC2 instance/profile/EIP, ECS/EFS resources – 1:1 or N:1 property mappings.
* Tags: every taggable resource carries `Environment`, `Project`, `ManagedBy=cloudformation` and the
  original `Name` tags (verified on LocalStack DynamoDB tables).
* `count`/ternaries → `Condition:`; `templatefile` → `Fn::Base64` + `!Sub`; data sources → SSM parameter
  type, pseudo-parameters, `Fn::GetAZs`.

## What required redesign (and why)

| Area | Change | Why |
|---|---|---|
| State backend + lock table | Removed; state bucket repurposed as `DeploymentBucket` | CloudFormation keeps its own state; Lambda code must live in S3 for CloudFormation. |
| Lambda packaging | `scripts/deploy.sh` zips/uploads with a content hash key | `filename`/`source_code_hash` are Terraform-provider features; CloudFormation only re-deploys code when `S3Key` changes. |
| Default VPC / subnets | Optional parameters, auto-discovered by `deploy.sh` | `AWS::EC2::VPC::Default`/`AWS::EC2::Subnet::Default` are not CloudFormation resource types; CloudFormation cannot enumerate subnets. |
| EFS mount-target `count = min(n, 2)` | Two explicit resources; B conditioned on "more than one subnet" | No list-length intrinsic. The condition is `Join("", list) != Join(",", list)` – true iff the list has ≥2 elements. A first version used `Fn::Select` inside `Conditions`, which LocalStack rejected (`CreateChangeSet` → `InternalError`); `Fn::Select` in conditions is also undocumented in AWS, so it was replaced. |
| SonarQube subnet precondition | `Rules` assertion: `EnableSonarqube=true` requires a non-empty `SonarqubeSubnetIds` | Terraform failed at plan time on an empty `data.aws_subnets`; CloudFormation would otherwise fail mid-create on `Fn::Select`. cfn-lint W1035 is suppressed at template level for the same reason. |
| `force_destroy` / `force_delete` | `DeletionPolicy`/`UpdateReplacePolicy` + ECR `EmptyOnDelete` (`AllowDestroy`) | CloudFormation has no "empty bucket on delete". |
| Security group egress | Only rendered when `VpcId` is set | cfn-lint E3021. |
| GitHub deploy role | Added `cloudformation:DescribeStacks`/`ListExports` | CI reads stack outputs instead of `terraform output`. |

## Validation

| Check | Result |
|---|---|
| `cfn-lint` 1.57.1 on all three templates | Clean (fixed E3021 SG egress, W2531 runtime; W1035 suppressed with justification). |
| `aws cloudformation validate-template` (LocalStack) | All three valid. |
| `bash -n scripts/deploy.sh`, `shellcheck` | Clean. |

## LocalStack test results

Environment: `localstack/localstack:4.4` (community, legacy CloudFormation engine) via
`localstack/docker-compose.yml`, `SERVICES=cloudformation,iam,s3,dynamodb,lambda,apigatewayv2,ec2,ecr,efs,ssm,ecs,sts`,
deployed with `scripts/deploy.sh` (`aws cloudformation deploy`).

### Per stack

| Stack / scenario | Result | Notes |
|---|---|---|
| bootstrap | **PASS** – `CREATE_COMPLETE` | Bucket (versioning `Enabled`, AES256) and deploy role created. OIDC provider and ECR repo mocked (`GitHubActionsOidcProviderArn=unknown`, ECR URL `http://localhost:4566`). |
| infrastructure | **PASS** – `CREATE_COMPLETE` | Imports resolved; instance created from the SSM AMI parameter (`ami-071226ecf16aa7d96`); rendered user data contains the imported ECR URL, region and app port. EIP mocked (`InstancePublicIp=unknown`). |
| serverless, `EnableSonarqube=false` | **PASS** – `CREATE_COMPLETE` (after fix) | 3 tables (PAY_PER_REQUEST, GSIs), frontend bucket (website + policy), Lambda `nodejs22.x` 256 MB/30 s with correct env vars, function URL (`AuthType NONE`), both Lambda permissions. `lambda invoke` succeeds (`StatusCode 200`, Express handler responds). No Sonarqube resources created. |
| serverless, `EnableSonarqube=true`, 2 subnets (fresh stack) | **PASS** – `CREATE_COMPLETE` | Mount targets A and B both in the stack. |
| serverless, `EnableSonarqube=true`, 1 subnet (fresh stack) | **PASS** – `CREATE_COMPLETE` | Mount target A only (B skipped by `SonarqubeSecondAz`). |
| serverless, `EnableSonarqube=true`, 0 subnets | **LocalStack gap** – `CREATE_COMPLETE` | LocalStack does not evaluate `Rules`; real AWS rejects this at create time. |
| serverless update `false → true` | **LocalStack gap** – `UPDATE_FAILED` | `Failed to delete resource with id SonarqubeExecutionRole of type AWS::IAM::Role`; the legacy engine diffs condition-skipped resources as if they existed (`'NoneType' object is not subscriptable`). Same template as a fresh create succeeds. |
| serverless update `true → false` | **Partial** – `UPDATE_COMPLETE` | Most Sonarqube resources removed, but the IAM role is leaked and two resources stay `UPDATE_FAILED`/`UPDATE_IN_PROGRESS` in the resource list (LocalStack). |
| serverless delete | **PASS (stack) / LocalStack gap (retention)** | `DELETE_COMPLETE`, but LocalStack also deleted the `Retain` DynamoDB tables and a non-empty frontend bucket – it ignores `DeletionPolicy`. |

### Fixes made as a result of LocalStack testing

1. `HasSecondSubnet` condition rewritten without `Fn::Select` (LocalStack `CreateChangeSet` 500 `InternalError`).
2. `deploy.sh`: `[[ … ]] && …` lines under `set -e` silently aborted the script with rc=1 when the
   default-VPC lookup returned a value; replaced with `if` statements.
3. `deploy.sh`: `s3 cp --only-show-errors` so upload progress doesn't pollute captured output.

### Emulation gaps (not template defects)

| Resource / feature | LocalStack 4.4 community behaviour |
|---|---|
| `AWS::IAM::OIDCProvider` | No provider – mocked, `Ref` = `unknown`. |
| `AWS::ECR::Repository` | Mock for CDK bootstrap only; `ecr describe-repositories` → "not included in your current license plan". |
| `AWS::EC2::EIP` | No provider – mocked, public IP/DNS outputs `unknown`. |
| `AWS::ApiGatewayV2::*` | No provider – mocked; `apigatewayv2 get-apis` not available; `ApiEndpoint=unknown`. |
| `AWS::ECS::*`, `AWS::EFS::*` | No provider – mocked; `ecs`/`efs` APIs not available. Fargate Spot / EFS mounting cannot be exercised. |
| `AWS::EC2::SecurityGroup` `SecurityGroupIngress` | Inline ingress rules are dropped (reproduced with a 1-resource template); egress is applied. |
| `AWS::S3::Bucket` `PublicAccessBlockConfiguration` | Ignored – frontend bucket reports all four flags `true` although the template sets `false`; bucket policy still applied. |
| EC2 user data | Stored and rendered correctly but not executed (no Docker/ECR pull on the mock instance). |
| `Rules` | Not evaluated. |
| `DeletionPolicy: Retain`, non-empty bucket delete | Ignored – resources deleted. |
| Conditional resource add/remove on update | Unreliable (see table above). |
| `PROVIDER_OVERRIDE_CLOUDFORMATION=engine-v2` (preview) | Tried; incompatible with `aws cloudformation deploy` in 4.4 (DescribeStacks error text differs, CLI aborts), so not used. |

### Resource verification commands (final state)

| Command | Result |
|---|---|
| `awslocal dynamodb list-tables` | `client-timesheet-app-{users,clients,work-entries}` |
| `awslocal s3 ls` | `client-timesheet-deployment-000000000000`, `client-timesheet-app-frontend-000000000000` |
| `awslocal lambda list-functions` | `client-timesheet-app-api` (`nodejs22.x`) |
| `awslocal apigatewayv2 get-apis` | Not emulated in community |
| `awslocal iam list-roles` | `client-timesheet-github-actions-deploy`, `client-timesheet-ec2-role`, `client-timesheet-app-lambda-role`, `client-timesheet-app-sonarqube-execution-role` |
| `awslocal ecr describe-repositories` | Not emulated in community |
| `awslocal cloudformation list-exports` | 6 bootstrap, 3 infrastructure, 3 serverless exports |

## Known limitations vs. real AWS

* **Non-empty resources block deletion.** `FrontendBucket` (`Delete`) fails to delete while it contains
  objects – run `aws s3 rm s3://<bucket> --recursive` first. `DeploymentBucket`, DynamoDB tables and the
  SonarQube EFS are `Retain`ed and must be removed manually if really unwanted. `AppRepository` is
  emptied on delete only when `AllowDestroy=true`; otherwise delete images first.
* **Retained resources keep their physical names** (`client-timesheet-app-users`, …). Re-creating a stack
  with the same `AppName` after a delete fails with "already exists" until they are removed or imported
  (`aws cloudformation create-change-set --change-set-type IMPORT`).
* **Migrating existing Terraform-managed resources**: these templates create new resources with the same
  names. For an in-place cut-over, remove the resources from Terraform state (`terraform state rm`) and
  adopt them with a CloudFormation resource import instead of deploying fresh.
* **Untested on AWS**: OIDC trust, ECR push/pull, EIP association, API Gateway routing, Fargate Spot,
  EFS mounting by SonarQube, inline SG ingress, user-data execution, `Rules`, and in-place SonarQube
  toggles were only mocked or not evaluated by LocalStack.
* SonarQube with `EnableSonarqube=true` needs `VpcId` and at least one public subnet; `deploy.sh` supplies
  the first two default subnets by AZ.

## Recommended next steps

1. **Dev-account deploy**: `scripts/deploy.sh all` into a sandbox account, then toggle
   `ENABLE_SONARQUBE=true/false` in place and delete/re-create, to cover every LocalStack gap above.
2. **Change sets in CI**: `aws cloudformation deploy --no-execute-changeset` (or `create-change-set`) on
   PRs, post the change-set diff, execute on merge; enable termination protection on bootstrap.
3. **cfn-guard rules**, e.g.: DynamoDB/EFS/deployment bucket must have `DeletionPolicy: Retain`; S3
   buckets must have encryption; only `FrontendBucket` may disable public access block; IAM policies
   must not use `Action: "*"`; all resources tagged `Project`/`Environment`/`ManagedBy`.
4. **CI integration**: run `cfn-lint` + `cfn-guard validate` in GitHub Actions and switch the deploy
   workflows from `terraform apply` to `scripts/deploy.sh` using `GitHubActionsDeployRole`.
5. **Cut-over**: import existing resources (see limitations), then delete `terraform/`.
6. Optional: LocalStack Pro (or the GA v2 engine in a newer LocalStack) to emulate ECR, ECS, EFS,
   API Gateway v2 and `Rules` locally.
