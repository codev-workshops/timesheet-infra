# CloudFormation migration (Terraform -> CloudFormation)

This directory holds the raw AWS CloudFormation (YAML) equivalents of the Terraform
stacks under `terraform/`. The migration follows a stack-by-stack *strangler*
approach: each Terraform stack maps to exactly one CloudFormation template, and each
template lands in its own PR, stacked on the previous stage's branch.

| Terraform source                  | CloudFormation template            | Stage | Status | LocalStack verification                         |
|-----------------------------------|------------------------------------|-------|--------|-------------------------------------------------|
| (none - tooling scaffold)         | `README.md`, `scripts/`, `localstack/` | 0 | [x]    | LocalStack boots, `awslocal` reachable          |
| `terraform/serverless/main.tf`    | `serverless.yaml`                  | 1     | [x]    | deploy + behavioral smoke tests                 |
| `terraform/serverless/sonarqube.tf` | `sonarqube.yaml`                 | 2     | [ ]    | `validate-template` only (ECS/EFS are Pro-only) |
| `terraform/infrastructure/main.tf`| `infrastructure.yaml`              | 3     | [ ]    | `validate-template` only (EC2 is Pro-only)      |
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

`serverless.yaml` declares the three DynamoDB tables (`client-timesheet-app-users`,
`-clients`, `-work-entries`) with `DeletionPolicy: Retain` and
`UpdateReplacePolicy: Retain`. If those tables already exist (created by Terraform),
adopt them with a CloudFormation **resource import** instead of letting the stack try
to create them (which would fail on the name collision):

```bash
cat > resources-to-import.json <<'EOF'
[
  {"ResourceType":"AWS::DynamoDB::Table","LogicalResourceId":"UsersTable",
   "ResourceIdentifier":{"TableName":"client-timesheet-app-users"}},
  {"ResourceType":"AWS::DynamoDB::Table","LogicalResourceId":"ClientsTable",
   "ResourceIdentifier":{"TableName":"client-timesheet-app-clients"}},
  {"ResourceType":"AWS::DynamoDB::Table","LogicalResourceId":"WorkEntriesTable",
   "ResourceIdentifier":{"TableName":"client-timesheet-app-work-entries"}}
]
EOF
# 1. import with a tables-only copy of the template (an IMPORT change set may contain only imported resources)
aws cloudformation create-change-set --stack-name timesheet-serverless --change-set-name import-tables \
  --change-set-type IMPORT --resources-to-import file://resources-to-import.json \
  --template-body file://serverless-tables-only.yaml --capabilities CAPABILITY_NAMED_IAM
aws cloudformation execute-change-set --stack-name timesheet-serverless --change-set-name import-tables
# 2. normal update with the full template adds Lambda / API / S3
aws cloudformation deploy --stack-name timesheet-serverless --template-file cloudformation/serverless.yaml \
  --capabilities CAPABILITY_NAMED_IAM
# 3. stop Terraform from tracking the tables
terraform -chdir=terraform/serverless state rm aws_dynamodb_table.users aws_dynamodb_table.clients aws_dynamodb_table.work_entries
```

The table definitions in the template mirror `main.tf` 1:1 (key schema, attribute
definitions, GSIs, `PAY_PER_REQUEST`), which is a requirement for the import to succeed.

## Deploy order (real AWS)

`bootstrap` -> `infrastructure` -> `serverless` -> `sonarqube` (optional).
`infrastructure` and `serverless` consume `bootstrap` outputs through `Fn::ImportValue`.

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

Equivalent ad-hoc commands: `awslocal cloudformation deploy ...`,
`awslocal dynamodb list-tables`, `awslocal apigatewayv2 get-apis`,
`awslocal lambda invoke ...`, `awslocal ecr describe-repositories`.
