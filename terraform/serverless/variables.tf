variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Environment name"
  type        = string
  default     = "production"
}

variable "app_name" {
  description = "Application name"
  type        = string
  default     = "client-timesheet-app"
}

variable "frontend_domain" {
  description = "Custom domain for frontend (optional)"
  type        = string
  default     = ""
}

variable "lambda_memory_size" {
  description = "Lambda function memory size in MB"
  type        = number
  default     = 256
}

variable "lambda_timeout" {
  description = "Lambda function timeout in seconds"
  type        = number
  default     = 30
}

variable "enable_sonarqube" {
  description = "Enable SonarQube server on Fargate Spot"
  type        = bool
  default     = true
}

variable "sonarqube_cpu" {
  description = "Fargate CPU units for SonarQube (256 = 0.25 vCPU)"
  type        = number
  default     = 512
}

variable "sonarqube_memory" {
  description = "Fargate memory in MB for SonarQube"
  type        = number
  default     = 2048
}
