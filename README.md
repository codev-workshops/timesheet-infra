# Client Timesheet App - AWS Infrastructure

This repository contains the infrastructure-as-code (Terraform) and CI/CD configuration (GitHub Actions) for deploying the Client Timesheet App to AWS.

## Architecture Overview

The simplest and most cost-effective AWS hosting solution for this application:

- **EC2 t3.micro instance** (~$8/month, free tier eligible for 12 months)
- **Docker container** running the full-stack application
- **SQLite database** stored on EBS volume for persistence
- **Elastic IP** for consistent public address
- **ECR** for Docker image storage

The backend serves both the API and the static frontend files, eliminating the need for separate hosting services.

## Cost Estimate

| Resource | Monthly Cost |
|----------|-------------|
| EC2 t3.micro | ~$8.35 (or free with free tier) |
| EBS 20GB gp3 | ~$1.60 |
| Elastic IP | Free (when attached to running instance) |
| ECR | ~$0.10/GB stored |
| Data Transfer | ~$0.09/GB (first 1GB free) |
| **Total** | **~$10-15/month** (or ~$2/month with free tier) |

## Prerequisites

Before setting up the CD pipeline, you need:

1. **AWS Account** with appropriate permissions
2. **GitHub repository access** to both this repo and the application repo

## Initial Setup Instructions

### Step 1: Bootstrap AWS Infrastructure

The bootstrap step creates:
- S3 bucket for Terraform state
- DynamoDB table for state locking
- ECR repository for Docker images
- GitHub Actions OIDC provider for secure credential-less deployments
- IAM role with least privilege permissions for GitHub Actions

This is a **separate destroyable stack** that can be torn down independently.

```bash
cd terraform/bootstrap

# Initialize Terraform
terraform init

# Review the plan
terraform plan

# Apply the bootstrap infrastructure
terraform apply

# To destroy bootstrap resources (when no longer needed):
# terraform destroy
```

Save the outputs - you'll need them for the next steps:
- `terraform_state_bucket` - S3 bucket name for Terraform state
- `ecr_repository_url` - ECR repository URL for Docker images
- `ecr_repository_arn` - ECR repository ARN for IAM policies
- `github_actions_role_arn` - IAM role ARN for GitHub Actions OIDC

### Step 2: Configure GitHub Secrets

In your GitHub repository settings, add the following secrets:

| Secret Name | Description | How to Get |
|-------------|-------------|------------|
| `AWS_ROLE_ARN` | IAM role ARN for OIDC authentication | From bootstrap output `github_actions_role_arn` |
| `ECR_REPOSITORY_URL` | ECR repository URL | From bootstrap output `ecr_repository_url` |
| `ECR_REPOSITORY_ARN` | ECR repository ARN | From bootstrap output (for Terraform) |
| `GH_PAT` | GitHub Personal Access Token | Create PAT with `repo` scope to access the app repo |

**Note:** No AWS access keys or SSH keys needed! The workflow uses:
- **OIDC** for secure, credential-less AWS authentication
- **SSM Session Manager** for EC2 access (no SSH ports open)

### Step 3: Deploy Infrastructure

After configuring secrets, deploy the main infrastructure:

```bash
cd terraform/infrastructure

# Initialize Terraform with the S3 backend
terraform init

# Set required variables
export TF_VAR_ecr_repository_url="<ECR_REPOSITORY_URL_FROM_BOOTSTRAP>"
export TF_VAR_ecr_repository_arn="<ECR_REPOSITORY_ARN_FROM_BOOTSTRAP>"

# Review the plan
terraform plan

# Apply the infrastructure
terraform apply
```

### Step 4: Trigger First Deployment

Once the infrastructure is deployed:

1. Push to the `main` branch to trigger the CD pipeline
2. Or manually trigger the workflow from GitHub Actions

The workflow will:
1. Build the Docker image with the application
2. Push to ECR
3. Deploy via SSM Run Command (no SSH needed)
4. Run health check to verify deployment

## Directory Structure

```
.
├── .github/
│   └── workflows/
│       └── deploy.yml          # CD pipeline
├── docker/
│   ├── Dockerfile              # Multi-stage Docker build
│   └── overrides/              # Production-ready server files
│       ├── server.js           # Modified server for static file serving
│       └── database/
│           └── init.js         # File-based SQLite support
├── terraform/
│   ├── bootstrap/              # One-time setup (S3, DynamoDB, ECR)
│   │   ├── main.tf
│   │   ├── variables.tf
│   │   └── outputs.tf
│   └── infrastructure/         # Main infrastructure (EC2, Security Groups)
│       ├── main.tf
│       ├── variables.tf
│       ├── outputs.tf
│       └── user_data.sh        # EC2 initialization script
└── README.md
```

## CD Pipeline

The GitHub Actions workflow (`deploy.yml`) runs on:
- Push to `main` branch
- Manual trigger via workflow_dispatch

Pipeline stages:
1. **Build and Push**: Builds Docker image and pushes to ECR
2. **Deploy**: Deploys via SSM Run Command (no SSH needed)
3. **Health Check**: Verifies the application is running

Security features:
- **OIDC Authentication**: No static AWS credentials stored in GitHub
- **SSM Session Manager**: No SSH ports open, IAM-based access control
- **Least Privilege IAM**: Deployment role has minimal required permissions

## Accessing the Application

After deployment, access the application at:
```
http://<ELASTIC_IP>
```

Get the Elastic IP from Terraform outputs:
```bash
cd terraform/infrastructure
terraform output instance_public_ip
```

## Troubleshooting

### Access EC2 via SSM Session Manager

Use AWS Systems Manager Session Manager to access the EC2 instance (no SSH needed):

```bash
# Get instance ID
INSTANCE_ID=$(aws ec2 describe-instances \
  --filters "Name=tag:Name,Values=client-timesheet-app" "Name=instance-state-name,Values=running" \
  --query 'Reservations[0].Instances[0].InstanceId' \
  --output text)

# Start SSM session
aws ssm start-session --target $INSTANCE_ID
```

Or use the AWS Console: EC2 > Instances > Select instance > Connect > Session Manager

### Check EC2 Logs
```bash
# Via SSM session:
sudo cat /var/log/user-data.log
docker logs client-timesheet-app
```

### Manual Deployment
```bash
# Via SSM session:
sudo /opt/app/deploy.sh
```

### Check Container Status
```bash
# Via SSM session:
docker ps
docker logs client-timesheet-app
```

## Security Considerations

- **No SSH access**: Uses SSM Session Manager with IAM-based authentication and audit logging
- **OIDC Authentication**: GitHub Actions uses OIDC - no static AWS credentials stored
- **Least Privilege IAM**: Deployment role has minimal required permissions scoped to specific resources
- The application uses email-only authentication - consider implementing proper auth for production
- SQLite data is stored on EBS - consider regular backups
- HTTPS is not configured - consider adding an Application Load Balancer with ACM certificate

## Scaling Considerations

If you need to scale beyond a single instance:
1. Move SQLite to RDS (PostgreSQL/MySQL)
2. Add Application Load Balancer
3. Use Auto Scaling Group
4. Consider ECS Fargate for container orchestration
