# Serverless Infrastructure for Client Timesheet App

**True scale-to-zero, cloud-native architecture** with AWS Lambda, API Gateway, S3, DynamoDB, and SonarQube on Fargate Spot.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        AWS Cloud                                 │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐       │
│  │   S3 Bucket  │    │ API Gateway  │    │  DynamoDB    │       │
│  │  (Frontend)  │    │  (HTTP API)  │    │  (3 tables)  │       │
│  │              │    │              │    │              │       │
│  │  Static SPA  │    │   Routes     │    │  users       │       │
│  │  React App   │    │   to Lambda  │    │  clients     │       │
│  │              │    │              │    │  work_entries│       │
│  └──────────────┘    └──────┬───────┘    └──────────────┘       │
│                             │                    ▲               │
│                             ▼                    │               │
│                      ┌──────────────┐            │               │
│                      │   Lambda     │────────────┘               │
│                      │  (Node.js)   │                            │
│                      │              │                            │
│                      │  Express API │                            │
│                      └──────────────┘                            │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                    SonarQube (Optional)                   │   │
│  │  ┌──────────────┐    ┌──────────────┐    ┌────────────┐  │   │
│  │  │ ECS Cluster  │    │ Fargate Spot │    │    EFS     │  │   │
│  │  │              │───▶│   Task       │───▶│   Data     │  │   │
│  │  │              │    │  (0.5 vCPU)  │    │ Persistence│  │   │
│  │  └──────────────┘    └──────────────┘    └────────────┘  │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

## Cost Estimate (Scale-to-Zero)

| Resource | Cost | Notes |
|----------|------|-------|
| **Lambda** | ~$0.00 | Free tier: 1M requests/month |
| **API Gateway** | ~$0.00 | Free tier: 1M requests/month |
| **DynamoDB** | ~$0.00 | On-demand: pay per request |
| **S3** | ~$0.02/month | Static hosting |
| **SonarQube (Fargate Spot)** | ~$5-10/month | Only when running |
| **EFS** | ~$0.30/GB/month | Data persistence |
| **Total (idle)** | **~$0.02/month** | When no traffic |
| **Total (active)** | **~$5-15/month** | With SonarQube running |

## Prerequisites

1. AWS account with appropriate permissions
2. Terraform >= 1.0
3. Bootstrap infrastructure deployed (S3 state bucket, DynamoDB locks)

## Deployment

### Step 1: Deploy Infrastructure

```bash
cd terraform/serverless

# Initialize Terraform
terraform init

# Review the plan
terraform plan

# Apply
terraform apply
```

### Step 2: Deploy Lambda Function

```bash
cd lambda

# Install dependencies
npm install

# Create deployment package
zip -r ../terraform/serverless/lambda.zip .

# Update Lambda function
aws lambda update-function-code \
  --function-name client-timesheet-app-api \
  --zip-file fileb://../terraform/serverless/lambda.zip
```

### Step 3: Deploy Frontend

```bash
# Build frontend
cd ../../../client-timesheet-app/frontend
npm run build

# Deploy to S3
aws s3 sync dist/ s3://$(terraform -chdir=../../hosting-client-timesheet-app/terraform/serverless output -raw frontend_bucket) --delete
```

## SonarQube

SonarQube runs on **Fargate Spot** (up to 70% cheaper than on-demand).

### Access SonarQube

1. Get the task public IP:
```bash
aws ecs list-tasks --cluster client-timesheet-app-sonarqube --query 'taskArns[0]' --output text | \
xargs aws ecs describe-tasks --cluster client-timesheet-app-sonarqube --tasks | \
jq -r '.tasks[0].attachments[0].details[] | select(.name=="networkInterfaceId") | .value' | \
xargs aws ec2 describe-network-interfaces --network-interface-ids | \
jq -r '.NetworkInterfaces[0].Association.PublicIp'
```

2. Access: `http://<PUBLIC_IP>:9000`
3. Default login: `admin` / `admin`

### Scale SonarQube to Zero

To stop SonarQube when not needed (save costs):
```bash
aws ecs update-service --cluster client-timesheet-app-sonarqube --service sonarqube --desired-count 0
```

To start SonarQube:
```bash
aws ecs update-service --cluster client-timesheet-app-sonarqube --service sonarqube --desired-count 1
```

## Outputs

After deployment, get the endpoints:
```bash
terraform output
```

- `api_endpoint`: API Gateway URL for backend
- `frontend_url`: S3 website URL for frontend
- `lambda_function_name`: Lambda function name for deployments
