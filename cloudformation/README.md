# CloudFormation migration (Terraform -> CloudFormation)

This directory holds the raw AWS CloudFormation (YAML) equivalents of the Terraform
stacks under `terraform/`. The migration follows a stack-by-stack *strangler*
approach: each Terraform stack maps to exactly one CloudFormation template, and each
template lands in its own PR, stacked on the previous stage's branch.

| Terraform source                  | CloudFormation template            | Stage | LocalStack verification                         |
|-----------------------------------|------------------------------------|-------|-------------------------------------------------|
| (none - tooling scaffold)         | `README.md`, `scripts/`, `localstack/` | 0 | LocalStack boots, `awslocal` reachable          |
| `terraform/serverless/main.tf`    | `serverless.yaml`                  | 1     | deploy + behavioral smoke tests                 |
| `terraform/serverless/sonarqube.tf` | `sonarqube.yaml`                 | 2     | `validate-template` only (ECS/EFS are Pro-only) |
| `terraform/infrastructure/main.tf`| `infrastructure.yaml`              | 3     | `validate-template` only (EC2 is Pro-only)      |
| `terraform/bootstrap/main.tf`     | `bootstrap.yaml`                   | 4     | deploy + `ecr describe-repositories`, exports   |

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

Equivalent ad-hoc commands: `awslocal cloudformation deploy ...`,
`awslocal dynamodb list-tables`, `awslocal apigatewayv2 get-apis`,
`awslocal lambda invoke ...`, `awslocal ecr describe-repositories`.
