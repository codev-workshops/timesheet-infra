# CloudFormation migration (Terraform -> CloudFormation)

This directory holds the raw AWS CloudFormation (YAML) equivalents of the Terraform
stacks under `terraform/`. The migration follows a stack-by-stack *strangler*
approach: each Terraform stack maps to exactly one CloudFormation template, and each
template lands in its own PR, stacked on the previous stage's branch.

| Terraform source                  | CloudFormation template            | Stage | Status | LocalStack verification                         |
|-----------------------------------|------------------------------------|-------|--------|-------------------------------------------------|
| (none - tooling scaffold)         | `README.md`, `scripts/`, `localstack/` | 0 | [x]    | LocalStack boots, `awslocal` reachable          |
| `terraform/serverless/main.tf`    | `serverless.yaml`                  | 1     | [x]    | deploy + behavioral smoke tests                 |
| `terraform/serverless/sonarqube.tf` | `sonarqube.yaml`                 | 2     | [x]    | `validate-template` + `cfn-lint`; no-op deploy with `EnableSonarQube=false` (ECS/EFS are Pro-only) |
| `terraform/infrastructure/main.tf`| `infrastructure.yaml`              | 3     | [x]    | `validate-template` + `cfn-lint` only (EC2 is Pro-only; imports need Stage 4 bootstrap) |
| `terraform/bootstrap/main.tf`     | `bootstrap.yaml`                   | 4     | [ ]    | deploy + `ecr describe-repositories`, exports   |

The Terraform state S3 bucket and DynamoDB lock table from `bootstrap/` are **not**
migrated - they are Terraform-specific.

## Stacked-PR chain

```
main
 └─ stage-0-cfn-scaffold      PR #1  scaffold (this directory, localstack/, scripts/)
     └─ stage-1-serverless-cfn PR #2  serverless.yaml
         └─ stage-2-sonarqube-cfn PR #3  sonarqube.yaml
             └─ stage-3-infra-cfn PR #4  infrastructure.yaml
                 └─ stage-4-bootstrap-cfn PR #5  bootstrap.yaml
```

Rules:

- Each PR is based on the previous stage's branch. When a parent branch changes,
  rebase every descendant branch on top of it.
- A stage is not merged until its LocalStack verification passes. For Stages 2 and 3
  (resources LocalStack Community cannot emulate) template validation must pass and
  the limitation is documented in the PR.
- PR descriptions include the exact LocalStack commands run and their output.
- Resource names, tags and the `Project = client-timesheet-app` tagging convention
  (`Environment`, `Project`, `ManagedBy`) are preserved from Terraform.

## Preserving existing DynamoDB data

The live tables (`client-timesheet-app-users`, `-clients`, `-work-entries`) **must be
kept**. `serverless.yaml` declares them with `DeletionPolicy: Retain` and
`UpdateReplacePolicy: Retain`, and they are adopted into the stack with a CloudFormation
**resource import** instead of being recreated (a plain `create-stack` would fail on the
table-name collision).

Files:

- `serverless-import.json` - `ResourcesToImport` list (three tables keyed by `TableName`).
- `serverless-import-only.yaml` - import-only template containing **just** the three
  tables (an IMPORT change set may only contain the resources being imported). Its table
  definitions must stay byte-identical to `serverless.yaml`.
- `scripts/cfnlocal-import-tables.sh [stack] [Key=Value ...]` - runs the whole procedure.

### Real-AWS procedure (step by step)

```bash
export AWS_DEFAULT_REGION=us-east-1
STACK=timesheet-serverless

# 0. sanity: the live tables exist and their schema matches serverless-import-only.yaml
aws dynamodb describe-table --table-name client-timesheet-app-users \
  --query 'Table.{Keys:KeySchema,Attrs:AttributeDefinitions,GSIs:GlobalSecondaryIndexes[].IndexName,Billing:BillingModeSummary.BillingMode}'

# 1. IMPORT change set (creates the stack if it does not exist yet)
aws cloudformation create-change-set --stack-name "$STACK" --change-set-name import-tables \
  --change-set-type IMPORT \
  --resources-to-import file://cloudformation/serverless-import.json \
  --template-body file://cloudformation/serverless-import-only.yaml \
  --capabilities CAPABILITY_NAMED_IAM
aws cloudformation wait change-set-create-complete --stack-name "$STACK" --change-set-name import-tables
aws cloudformation describe-change-set --stack-name "$STACK" --change-set-name import-tables \
  --query 'Changes[].ResourceChange.{Action:Action,Id:LogicalResourceId,Physical:PhysicalResourceId}'
#   -> expect Action = Import for UsersTable / ClientsTable / WorkEntriesTable

# 2. execute and wait for IMPORT_COMPLETE
aws cloudformation execute-change-set --stack-name "$STACK" --change-set-name import-tables
aws cloudformation wait stack-import-complete --stack-name "$STACK"
aws cloudformation describe-stacks --stack-name "$STACK" --query 'Stacks[0].StackStatus'   # IMPORT_COMPLETE

# 3. normal UPDATE with the full template adds Lambda / Function URL / HTTP API / S3
aws cloudformation deploy --stack-name "$STACK" --template-file cloudformation/serverless.yaml \
  --capabilities CAPABILITY_NAMED_IAM CAPABILITY_AUTO_EXPAND
aws cloudformation describe-stacks --stack-name "$STACK" --query 'Stacks[0].StackStatus'   # UPDATE_COMPLETE

# 4. verify data is intact, then stop Terraform from tracking the tables
aws dynamodb scan --table-name client-timesheet-app-users --select COUNT
terraform -chdir=terraform/serverless state rm \
  aws_dynamodb_table.users aws_dynamodb_table.clients aws_dynamodb_table.work_entries
```

Steps 1-3 are exactly what `scripts/cfnlocal-import-tables.sh` executes; against real
AWS run it with an empty endpoint: `AWS_ENDPOINT_URL= scripts/cfnlocal-import-tables.sh`.
Optional: run `aws cloudformation detect-stack-drift` after step 3 to confirm the imported
tables match the template.

### LocalStack limitation: IMPORT change sets are not supported

LocalStack (Community and Pro/Hobby, tested with `2026.8.3`) does not implement
resource import - its CloudFormation coverage page lists "Importing Resources" as
unsupported. Observed behaviour:

- `create-change-set --change-set-type IMPORT` on a non-existent stack ->
  `ValidationError: Stack 'timesheet-serverless' does not exist` (real AWS creates it).
- on an existing stack -> `InternalFailure: Sorry, the cloudformation service is not
  supported by this version of LocalStack ...` (the generic not-implemented error).

So `cfnlocal-import-tables.sh` can only be exercised on real AWS. What *can* be verified on
LocalStack is the `Retain` behaviour that protects the data: deploy `serverless.yaml`,
put items into the tables, `delete-stack` -> stack reaches `DELETE_COMPLETE` and the tables
and their items are still there (see PR #3 for the transcript).

## Deploy order (real AWS)

`bootstrap` -> `infrastructure` -> `serverless` -> `sonarqube` (optional).
`infrastructure` and `serverless` consume `bootstrap` outputs through `Fn::ImportValue`.

`infrastructure.yaml` has no VPC lookup (Terraform used `aws_default_vpc` /
`aws_default_subnet`); pass the default VPC and subnet explicitly:

```bash
VPC=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)
SUBNET=$(aws ec2 describe-subnets --filters Name=vpc-id,Values=$VPC Name=default-for-az,Values=true \
  --query 'Subnets[0].SubnetId' --output text)
aws cloudformation deploy --stack-name timesheet-infrastructure --template-file cloudformation/infrastructure.yaml \
  --capabilities CAPABILITY_NAMED_IAM --parameter-overrides VpcId=$VPC SubnetId=$SUBNET
```

## LocalStack verification

Prerequisites: Docker, AWS CLI v2, optionally `awslocal` (`pip install awscli-local`).
All scripts target `LOCALSTACK_ENDPOINT` (default `http://localhost:4566`) and dummy
`test`/`test` credentials, so plain `aws` works without `awslocal`.

```bash
# 1. start LocalStack (waits for /_localstack/health)
scripts/localstack-up.sh

# 2. validate every template (shape check)
scripts/cfnlocal-validate.sh                      # or a single file

# 3. deploy a stack
scripts/cfnlocal-deploy.sh timesheet-bootstrap   cloudformation/bootstrap.yaml
scripts/cfnlocal-deploy.sh timesheet-serverless  cloudformation/serverless.yaml Environment=production

# 4. smoke tests
scripts/smoke-test.sh scaffold        # scaffold | serverless | sonarqube | infrastructure | bootstrap | all

# 5. stop
docker compose -f localstack/docker-compose.yml down
```

Known LocalStack limitation (Stage 1): `apigatewayv2` is not included in the
Community/Hobby license, so `awslocal apigatewayv2 get-apis` returns `InternalFailure`
even though the stack's `AWS::ApiGatewayV2::*` resources reach `CREATE_COMPLETE`.
`smoke-test.sh serverless` detects this and falls back to checking the stack resource
status; the Lambda itself is verified via `lambda invoke` and its Function URL.

Stage 2 (`sonarqube.yaml`): Terraform discovered the default VPC via data sources;
the template instead takes `VpcId` and `SubnetIds` (>= 2 subnets, comma separated)
as parameters and creates EFS mount targets / places the service in the first two
subnets. `EnableSonarQube=false` deploys a no-op stack:

```bash
scripts/cfnlocal-deploy.sh timesheet-sonarqube cloudformation/sonarqube.yaml EnableSonarQube=false
scripts/smoke-test.sh sonarqube      # validate-template (+ stack status if deployed)
```

Equivalent ad-hoc commands: `awslocal cloudformation deploy ...`,
`awslocal dynamodb list-tables`, `awslocal apigatewayv2 get-apis`,
`awslocal lambda invoke ...`, `awslocal ecr describe-repositories`.
