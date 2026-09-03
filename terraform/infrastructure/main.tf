terraform {
  required_version = ">= 1.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  backend "s3" {
    bucket         = "client-timesheet-terraform-state-599083837640"
    key            = "infrastructure/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "client-timesheet-terraform-locks"
    encrypt        = true
  }
}

provider "aws" {
  region = var.aws_region
}

data "aws_caller_identity" "current" {}

data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_ami" "amazon_linux_2023" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["al2023-ami-*-x86_64"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

resource "aws_default_vpc" "default" {
  tags = {
    Name = "Default VPC"
  }
}

resource "aws_default_subnet" "default" {
  availability_zone = data.aws_availability_zones.available.names[0]

  tags = {
    Name = "Default Subnet"
  }
}

resource "aws_security_group" "app" {
  name        = "client-timesheet-app-sg"
  description = "Security group for Client Timesheet App"
  vpc_id      = aws_default_vpc.default.id

  # HTTP access for the application
  ingress {
    description = "HTTP"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # HTTPS access for the application
  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # No SSH ingress needed - using SSM Session Manager instead
  # This is more secure as it:
  # - Doesn't require open ports
  # - Uses IAM for authentication
  # - Provides audit logging

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name        = "client-timesheet-app-sg"
    Environment = var.environment
    Project     = "client-timesheet-app"
  }
}

resource "aws_iam_role" "ec2_role" {
  name = "client-timesheet-ec2-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ec2.amazonaws.com"
        }
      }
    ]
  })

  tags = {
    Name        = "client-timesheet-ec2-role"
    Environment = var.environment
    Project     = "client-timesheet-app"
  }
}

resource "aws_iam_role_policy" "ecr_policy" {
  name = "ecr-access-policy"
  role = aws_iam_role.ec2_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ECRGetAuthToken"
        Effect = "Allow"
        Action = ["ecr:GetAuthorizationToken"]
        Resource = "*"
      },
      {
        Sid    = "ECRPullImages"
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage"
        ]
        Resource = var.ecr_repository_arn
      }
    ]
  })
}

# SSM permissions for Session Manager access (no SSH needed)
resource "aws_iam_role_policy_attachment" "ssm_managed_instance" {
  role       = aws_iam_role.ec2_role.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "ec2_profile" {
  name = "client-timesheet-ec2-profile"
  role = aws_iam_role.ec2_role.name
}

# SSH key pair removed - using SSM Session Manager instead

resource "aws_instance" "app" {
  ami                    = data.aws_ami.amazon_linux_2023.id
  instance_type          = var.instance_type
  # No SSH key - using SSM Session Manager for access
  vpc_security_group_ids = [aws_security_group.app.id]
  subnet_id              = aws_default_subnet.default.id
  iam_instance_profile   = aws_iam_instance_profile.ec2_profile.name

  root_block_device {
    volume_size = 20
    volume_type = "gp3"
    encrypted   = true
  }

  user_data = base64encode(templatefile("${path.module}/user_data.sh", {
    aws_region     = var.aws_region
    ecr_repository = var.ecr_repository_url
    app_port       = var.app_port
  }))

  tags = {
    Name        = "client-timesheet-app"
    Environment = var.environment
    Project     = "client-timesheet-app"
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_eip" "app" {
  instance = aws_instance.app.id
  domain   = "vpc"

  tags = {
    Name        = "client-timesheet-app-eip"
    Environment = var.environment
    Project     = "client-timesheet-app"
  }
}
