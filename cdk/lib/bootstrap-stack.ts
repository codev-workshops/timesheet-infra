import * as cdk from 'aws-cdk-lib';
import { Aws, CfnOutput, Duration, RemovalPolicy, Tags } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { resolve } from './context';

/** Mirrors terraform/bootstrap/variables.tf */
export interface BootstrapStackProps extends cdk.StackProps {
  /** Allow destruction of bootstrap resources (S3 bucket, ECR). Default: true */
  readonly allowDestroy?: boolean;
  /** GitHub organization name for OIDC trust policy. Default: "Cognition-Partner-Workshops" */
  readonly githubOrg?: string;
  /** GitHub repository name for OIDC trust policy. Default: "hosting-client-timesheet-app" */
  readonly githubRepo?: string;
}

/** Mirrors terraform/bootstrap: Terraform state backend, ECR repository and GitHub Actions OIDC deploy role. */
export class BootstrapStack extends cdk.Stack {
  public readonly stateBucket: s3.Bucket;
  public readonly lockTable: dynamodb.Table;
  public readonly ecrRepository: ecr.Repository;
  public readonly githubActionsRole: iam.Role;
  public readonly oidcProvider: iam.OpenIdConnectProvider;

  constructor(scope: Construct, id: string, props: BootstrapStackProps = {}) {
    super(scope, id, props);

    const allowDestroy = resolve(this, 'allow_destroy', props.allowDestroy, true);
    const githubOrg = resolve(this, 'github_org', props.githubOrg, 'Cognition-Partner-Workshops');
    const githubRepo = resolve(this, 'github_repo', props.githubRepo, 'hosting-client-timesheet-app');

    Tags.of(this).add('Environment', 'shared');
    Tags.of(this).add('Project', 'client-timesheet-app');
    Tags.of(this).add('ManagedBy', 'cdk-bootstrap');

    const removalPolicy = allowDestroy ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN;

    // -------------------------------------------------------------------------
    // Terraform state backend resources
    // -------------------------------------------------------------------------
    this.stateBucket = new s3.Bucket(this, 'TerraformState', {
      bucketName: `client-timesheet-terraform-state-${Aws.ACCOUNT_ID}`,
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy,
      autoDeleteObjects: allowDestroy,
    });
    Tags.of(this.stateBucket).add('Name', 'Terraform State Bucket');

    this.lockTable = new dynamodb.Table(this, 'TerraformLocks', {
      tableName: 'client-timesheet-terraform-locks',
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      partitionKey: { name: 'LockID', type: dynamodb.AttributeType.STRING },
      removalPolicy,
    });
    Tags.of(this.lockTable).add('Name', 'Terraform Lock Table');

    // -------------------------------------------------------------------------
    // ECR repository
    // -------------------------------------------------------------------------
    this.ecrRepository = new ecr.Repository(this, 'AppRepository', {
      repositoryName: 'client-timesheet-app',
      imageTagMutability: ecr.TagMutability.MUTABLE,
      imageScanOnPush: true,
      removalPolicy,
      emptyOnDelete: allowDestroy,
      lifecycleRules: [
        {
          rulePriority: 1,
          description: 'Keep last 10 images',
          tagStatus: ecr.TagStatus.ANY,
          maxImageCount: 10,
        },
      ],
    });
    Tags.of(this.ecrRepository).add('Name', 'Client Timesheet App ECR');

    // -------------------------------------------------------------------------
    // GitHub Actions OIDC provider and deployment role (least privilege)
    // -------------------------------------------------------------------------
    this.oidcProvider = new iam.OpenIdConnectProvider(this, 'GithubActionsOidc', {
      url: 'https://token.actions.githubusercontent.com',
      clientIds: ['sts.amazonaws.com'],
      thumbprints: ['6938fd4d98bab03faadb97b34396831e3780aea1'],
    });
    Tags.of(this.oidcProvider).add('Name', 'GitHub Actions OIDC Provider');

    const sonarqubeClusterArn = `arn:aws:ecs:${Aws.REGION}:${Aws.ACCOUNT_ID}:cluster/client-timesheet-app-sonarqube`;

    this.githubActionsRole = new iam.Role(this, 'GithubActionsDeploy', {
      roleName: 'client-timesheet-github-actions-deploy',
      assumedBy: new iam.WebIdentityPrincipal(this.oidcProvider.openIdConnectProviderArn, {
        StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
        StringLike: { 'token.actions.githubusercontent.com:sub': `repo:${githubOrg}/${githubRepo}:*` },
      }),
      inlinePolicies: {
        'ecr-push-pull': new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              sid: 'ECRGetAuthToken',
              actions: ['ecr:GetAuthorizationToken'],
              resources: ['*'],
            }),
            new iam.PolicyStatement({
              sid: 'ECRPushPull',
              actions: [
                'ecr:BatchCheckLayerAvailability',
                'ecr:GetDownloadUrlForLayer',
                'ecr:BatchGetImage',
                'ecr:PutImage',
                'ecr:InitiateLayerUpload',
                'ecr:UploadLayerPart',
                'ecr:CompleteLayerUpload',
              ],
              resources: [this.ecrRepository.repositoryArn],
            }),
          ],
        }),
        'ec2-describe': new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              sid: 'EC2DescribeInstances',
              actions: ['ec2:DescribeInstances'],
              resources: ['*'],
              conditions: { StringEquals: { 'ec2:ResourceTag/Project': 'client-timesheet-app' } },
            }),
            new iam.PolicyStatement({
              sid: 'EC2DescribeAll',
              actions: ['ec2:DescribeInstances'],
              resources: ['*'],
            }),
          ],
        }),
        'ssm-send-command': new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              sid: 'SSMSendCommand',
              actions: ['ssm:SendCommand'],
              resources: [
                `arn:aws:ssm:${Aws.REGION}::document/AWS-RunShellScript`,
                `arn:aws:ec2:${Aws.REGION}:${Aws.ACCOUNT_ID}:instance/*`,
              ],
              conditions: { StringEquals: { 'ssm:resourceTag/Project': 'client-timesheet-app' } },
            }),
            new iam.PolicyStatement({
              sid: 'SSMGetCommandInvocation',
              actions: ['ssm:GetCommandInvocation'],
              resources: ['*'],
            }),
          ],
        }),
        'lambda-deploy': new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              sid: 'LambdaUpdateCode',
              actions: ['lambda:UpdateFunctionCode', 'lambda:GetFunction', 'lambda:GetFunctionConfiguration'],
              resources: [`arn:aws:lambda:${Aws.REGION}:${Aws.ACCOUNT_ID}:function:client-timesheet-app-*`],
            }),
          ],
        }),
        's3-frontend-deploy': new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              sid: 'S3FrontendDeploy',
              actions: ['s3:PutObject', 's3:GetObject', 's3:DeleteObject', 's3:ListBucket'],
              resources: [
                `arn:aws:s3:::client-timesheet-app-frontend-${Aws.ACCOUNT_ID}`,
                `arn:aws:s3:::client-timesheet-app-frontend-${Aws.ACCOUNT_ID}/*`,
              ],
            }),
            new iam.PolicyStatement({
              sid: 'TerraformStateAccess',
              actions: ['s3:GetObject', 's3:PutObject', 's3:ListBucket'],
              resources: [this.stateBucket.bucketArn, this.stateBucket.arnForObjects('*')],
            }),
            new iam.PolicyStatement({
              sid: 'DynamoDBStateLock',
              actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:DeleteItem'],
              resources: [this.lockTable.tableArn],
            }),
          ],
        }),
        'ecs-sonarqube': new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              sid: 'ECSDescribe',
              actions: ['ecs:DescribeServices', 'ecs:DescribeTasks', 'ecs:ListTasks', 'ecs:UpdateService'],
              resources: ['*'],
              conditions: { StringEquals: { 'ecs:cluster': sonarqubeClusterArn } },
            }),
            new iam.PolicyStatement({
              sid: 'ECSClusterAccess',
              actions: ['ecs:DescribeServices', 'ecs:DescribeTasks', 'ecs:ListTasks', 'ecs:UpdateService'],
              resources: [
                sonarqubeClusterArn,
                `arn:aws:ecs:${Aws.REGION}:${Aws.ACCOUNT_ID}:service/client-timesheet-app-sonarqube/*`,
                `arn:aws:ecs:${Aws.REGION}:${Aws.ACCOUNT_ID}:task/client-timesheet-app-sonarqube/*`,
              ],
            }),
            new iam.PolicyStatement({
              sid: 'EC2DescribeNetworkInterfaces',
              actions: ['ec2:DescribeNetworkInterfaces'],
              resources: ['*'],
            }),
          ],
        }),
      },
      maxSessionDuration: Duration.hours(1),
    });
    Tags.of(this.githubActionsRole).add('Name', 'GitHub Actions Deploy Role');

    // -------------------------------------------------------------------------
    // Outputs (mirror terraform/bootstrap/outputs.tf)
    // -------------------------------------------------------------------------
    new CfnOutput(this, 'terraform_state_bucket', {
      description: 'S3 bucket for Terraform state',
      value: this.stateBucket.bucketName,
    });
    new CfnOutput(this, 'terraform_lock_table', {
      description: 'DynamoDB table for Terraform state locking',
      value: this.lockTable.tableName,
    });
    new CfnOutput(this, 'ecr_repository_url', {
      description: 'ECR repository URL for the application',
      value: this.ecrRepository.repositoryUri,
    });
    new CfnOutput(this, 'ecr_repository_name', {
      description: 'ECR repository name',
      value: this.ecrRepository.repositoryName,
    });
    new CfnOutput(this, 'aws_account_id', {
      description: 'AWS Account ID',
      value: Aws.ACCOUNT_ID,
    });
    new CfnOutput(this, 'github_actions_role_arn', {
      description: 'IAM Role ARN for GitHub Actions to assume via OIDC',
      value: this.githubActionsRole.roleArn,
    });
    new CfnOutput(this, 'github_actions_oidc_provider_arn', {
      description: 'GitHub Actions OIDC Provider ARN',
      value: this.oidcProvider.openIdConnectProviderArn,
    });
  }
}
