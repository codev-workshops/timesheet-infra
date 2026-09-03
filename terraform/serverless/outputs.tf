# =============================================================================
# Outputs
# =============================================================================

output "api_endpoint" {
  description = "API Gateway endpoint URL"
  value       = aws_apigatewayv2_api.api.api_endpoint
}

output "lambda_function_url" {
  description = "Lambda function URL (direct access)"
  value       = aws_lambda_function_url.api.function_url
}

output "frontend_url" {
  description = "S3 website URL for frontend"
  value       = "http://${aws_s3_bucket_website_configuration.frontend.website_endpoint}"
}

output "frontend_bucket" {
  description = "S3 bucket name for frontend deployment"
  value       = aws_s3_bucket.frontend.id
}

output "dynamodb_tables" {
  description = "DynamoDB table names"
  value = {
    users        = aws_dynamodb_table.users.name
    clients      = aws_dynamodb_table.clients.name
    work_entries = aws_dynamodb_table.work_entries.name
  }
}

output "lambda_function_name" {
  description = "Lambda function name for deployments"
  value       = aws_lambda_function.api.function_name
}

output "sonarqube_cluster" {
  description = "ECS cluster name for SonarQube"
  value       = var.enable_sonarqube ? aws_ecs_cluster.sonarqube[0].name : null
}

output "sonarqube_service" {
  description = "ECS service name for SonarQube"
  value       = var.enable_sonarqube ? aws_ecs_service.sonarqube[0].name : null
}

output "sonarqube_info" {
  description = "SonarQube access information"
  value       = var.enable_sonarqube ? "SonarQube runs on Fargate Spot. Get the public IP from ECS task. Default login: admin/admin" : "SonarQube disabled"
}
