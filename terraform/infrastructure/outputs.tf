output "instance_id" {
  description = "EC2 instance ID"
  value       = aws_instance.app.id
}

output "instance_public_ip" {
  description = "EC2 instance public IP (Elastic IP)"
  value       = aws_eip.app.public_ip
}

output "instance_public_dns" {
  description = "EC2 instance public DNS"
  value       = aws_eip.app.public_dns
}

output "app_url" {
  description = "Application URL"
  value       = "http://${aws_eip.app.public_ip}"
}

output "security_group_id" {
  description = "Security group ID"
  value       = aws_security_group.app.id
}
