# =============================================================================
# SonarQube on Fargate Spot (Cost-Optimized, Scale-to-Zero capable)
# =============================================================================

# VPC for Fargate (using default VPC for simplicity)
data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

# Security Group for SonarQube
resource "aws_security_group" "sonarqube" {
  count       = var.enable_sonarqube ? 1 : 0
  name        = "${var.app_name}-sonarqube-sg"
  description = "Security group for SonarQube"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description = "SonarQube Web UI"
    from_port   = 9000
    to_port     = 9000
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.tags, { Name = "SonarQube Security Group" })
}

# ECS Cluster for SonarQube
resource "aws_ecs_cluster" "sonarqube" {
  count = var.enable_sonarqube ? 1 : 0
  name  = "${var.app_name}-sonarqube"

  setting {
    name  = "containerInsights"
    value = "disabled"
  }

  tags = local.tags
}

# Enable Fargate Spot capacity provider
resource "aws_ecs_cluster_capacity_providers" "sonarqube" {
  count        = var.enable_sonarqube ? 1 : 0
  cluster_name = aws_ecs_cluster.sonarqube[0].name

  capacity_providers = ["FARGATE_SPOT"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE_SPOT"
    weight            = 1
  }
}

# IAM Role for ECS Task Execution
resource "aws_iam_role" "ecs_task_execution" {
  count = var.enable_sonarqube ? 1 : 0
  name  = "${var.app_name}-sonarqube-execution-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ecs-tasks.amazonaws.com"
        }
      }
    ]
  })

  tags = local.tags
}

resource "aws_iam_role_policy_attachment" "ecs_task_execution" {
  count      = var.enable_sonarqube ? 1 : 0
  role       = aws_iam_role.ecs_task_execution[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "ecs_cloudwatch_logs" {
  count = var.enable_sonarqube ? 1 : 0
  name  = "cloudwatch-logs"
  role  = aws_iam_role.ecs_task_execution[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "arn:aws:logs:${var.aws_region}:*:log-group:/ecs/${var.app_name}-sonarqube:*"
      }
    ]
  })
}

# EFS for SonarQube data persistence (optional, for data retention across restarts)
resource "aws_efs_file_system" "sonarqube" {
  count          = var.enable_sonarqube ? 1 : 0
  creation_token = "${var.app_name}-sonarqube-data"
  encrypted      = false

  lifecycle_policy {
    transition_to_ia = "AFTER_7_DAYS"
  }

  tags = merge(local.tags, { Name = "SonarQube Data" })
}

resource "aws_security_group" "efs" {
  count       = var.enable_sonarqube ? 1 : 0
  name        = "${var.app_name}-sonarqube-efs-sg"
  description = "Security group for SonarQube EFS"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description     = "NFS from SonarQube"
    from_port       = 2049
    to_port         = 2049
    protocol        = "tcp"
    security_groups = [aws_security_group.sonarqube[0].id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.tags, { Name = "SonarQube EFS Security Group" })
}

resource "aws_efs_mount_target" "sonarqube" {
  count           = var.enable_sonarqube ? min(length(data.aws_subnets.default.ids), 2) : 0
  file_system_id  = aws_efs_file_system.sonarqube[0].id
  subnet_id       = data.aws_subnets.default.ids[count.index]
  security_groups = [aws_security_group.efs[0].id]
}

# ECS Task Definition for SonarQube
resource "aws_ecs_task_definition" "sonarqube" {
  count                    = var.enable_sonarqube ? 1 : 0
  family                   = "${var.app_name}-sonarqube"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = var.sonarqube_cpu
  memory                   = var.sonarqube_memory
  execution_role_arn       = aws_iam_role.ecs_task_execution[0].arn

  container_definitions = jsonencode([
    {
      name      = "sonarqube"
      image     = "sonarqube:lts-community"
      essential = true

      portMappings = [
        {
          containerPort = 9000
          hostPort      = 9000
          protocol      = "tcp"
        }
      ]

      environment = [
        {
          name  = "SONAR_ES_BOOTSTRAP_CHECKS_DISABLE"
          value = "true"
        }
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = "/ecs/${var.app_name}-sonarqube"
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "sonarqube"
          "awslogs-create-group"  = "true"
        }
      }
    }
  ])

  tags = local.tags
}

# ECS Service for SonarQube (set desired_count to 0 for scale-to-zero)
resource "aws_ecs_service" "sonarqube" {
  count           = var.enable_sonarqube ? 1 : 0
  name            = "sonarqube"
  cluster         = aws_ecs_cluster.sonarqube[0].id
  task_definition = aws_ecs_task_definition.sonarqube[0].arn
  desired_count   = 1

  network_configuration {
    subnets          = slice(data.aws_subnets.default.ids, 0, min(length(data.aws_subnets.default.ids), 2))
    security_groups  = [aws_security_group.sonarqube[0].id]
    assign_public_ip = true
  }

  capacity_provider_strategy {
    capacity_provider = "FARGATE_SPOT"
    weight            = 1
  }

  tags = local.tags

}
