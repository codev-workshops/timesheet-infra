variable "aws_region" {
  description = "AWS region for resources"
  type        = string
  default     = "us-east-1"
}

variable "allow_destroy" {
  description = "Allow destruction of bootstrap resources (S3 bucket, ECR). Set to false for production."
  type        = bool
  default     = true
}

variable "github_org" {
  description = "GitHub organization name for OIDC trust policy"
  type        = string
  default     = "Cognition-Partner-Workshops"
}

variable "github_repo" {
  description = "GitHub repository name for OIDC trust policy"
  type        = string
  default     = "hosting-client-timesheet-app"
}
