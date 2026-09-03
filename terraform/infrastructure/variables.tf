variable "aws_region" {
  description = "AWS region for resources"
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Environment name"
  type        = string
  default     = "production"
}

variable "instance_type" {
  description = "EC2 instance type"
  type        = string
  default     = "t3.micro"
}

variable "ecr_repository_url" {
  description = "ECR repository URL for the application"
  type        = string
}

variable "ecr_repository_arn" {
  description = "ECR repository ARN for IAM policy scoping"
  type        = string
}

variable "app_port" {
  description = "Application port"
  type        = number
  default     = 3001
}
