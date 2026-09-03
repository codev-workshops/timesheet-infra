#!/bin/bash
set -e

# Log all output
exec > >(tee /var/log/user-data.log|logger -t user-data -s 2>/dev/console) 2>&1

echo "Starting user data script..."

# Update system
dnf update -y

# Install and start SSM agent (required for SSM Session Manager access)
dnf install -y amazon-ssm-agent
systemctl enable amazon-ssm-agent
systemctl start amazon-ssm-agent

# Install Docker
dnf install -y docker
systemctl start docker
systemctl enable docker

# Add ec2-user to docker group
usermod -aG docker ec2-user

# Install AWS CLI (already installed on AL2023, but ensure it's available)
dnf install -y aws-cli

# Create app directory
mkdir -p /opt/app
mkdir -p /opt/app/data

# Create deployment script
cat > /opt/app/deploy.sh << 'DEPLOY_SCRIPT'
#!/bin/bash
set -e

AWS_REGION="${aws_region}"
ECR_REPOSITORY="${ecr_repository}"
APP_PORT="${app_port}"

echo "Logging into ECR..."
aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin $ECR_REPOSITORY

echo "Pulling latest image..."
docker pull $ECR_REPOSITORY:latest

echo "Stopping existing container..."
docker stop client-timesheet-app 2>/dev/null || true
docker rm client-timesheet-app 2>/dev/null || true

echo "Starting new container..."
docker run -d \
  --name client-timesheet-app \
  --restart unless-stopped \
  -p 80:$APP_PORT \
  -v /opt/app/data:/app/data \
  -e NODE_ENV=production \
  -e PORT=$APP_PORT \
  -e DATABASE_PATH=/app/data/timesheet.db \
  $ECR_REPOSITORY:latest

echo "Cleaning up old images..."
docker image prune -f

echo "Deployment complete!"
DEPLOY_SCRIPT

chmod +x /opt/app/deploy.sh

# Create systemd service for auto-restart
cat > /etc/systemd/system/client-timesheet-app.service << 'SERVICE'
[Unit]
Description=Client Timesheet App
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/opt/app/deploy.sh
ExecStop=/usr/bin/docker stop client-timesheet-app

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable client-timesheet-app

echo "User data script completed successfully!"
