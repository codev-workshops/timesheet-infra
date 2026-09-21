import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Aws, CfnOutput, Duration, RemovalPolicy, Tags } from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { lookupDefaultVpc, resolve } from './context';

/** Mirrors terraform/serverless/variables.tf */
export interface ServerlessStackProps extends cdk.StackProps {
  /** Environment name. Default: "production" */
  readonly environment?: string;
  /** Application name. Default: "client-timesheet-app" */
  readonly appName?: string;
  /** Custom domain for frontend (optional; unused, kept for parity with Terraform). Default: "" */
  readonly frontendDomain?: string;
  /** Lambda function memory size in MB. Default: 256 */
  readonly lambdaMemorySize?: number;
  /** Lambda function timeout in seconds. Default: 30 */
  readonly lambdaTimeout?: number;
  /** Enable SonarQube server on Fargate Spot. Default: true */
  readonly enableSonarqube?: boolean;
  /** Fargate CPU units for SonarQube (256 = 0.25 vCPU). Default: 512 */
  readonly sonarqubeCpu?: number;
  /** Fargate memory in MB for SonarQube. Default: 2048 */
  readonly sonarqubeMemory?: number;
}

const PLACEHOLDER_CANDIDATES = [
  path.join(__dirname, '..', 'lambda-placeholder.zip'),
  path.join(__dirname, '..', '..', 'terraform', 'serverless', 'lambda-placeholder.zip'),
];

/**
 * Returns the Lambda deployment package used as the initial function code.
 * The real code is deployed by CI via `lambda:UpdateFunctionCode`.
 */
function placeholderCode(): lambda.Code {
  const existing = PLACEHOLDER_CANDIDATES.find((p) => fs.existsSync(p));
  if (existing) {
    return lambda.Code.fromAsset(existing);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-placeholder-'));
  fs.writeFileSync(
    path.join(dir, 'lambda.js'),
    "exports.handler = async () => ({ statusCode: 200, body: JSON.stringify({ message: 'placeholder' }) });\n",
  );
  return lambda.Code.fromAsset(dir);
}

/** Mirrors terraform/serverless: DynamoDB + S3 frontend + Lambda/HTTP API backend + optional SonarQube on Fargate Spot. */
export class ServerlessStack extends cdk.Stack {
  public readonly usersTable: dynamodb.Table;
  public readonly clientsTable: dynamodb.Table;
  public readonly workEntriesTable: dynamodb.Table;
  public readonly frontendBucket: s3.Bucket;
  public readonly apiFunction: lambda.Function;
  public readonly httpApi: apigwv2.HttpApi;

  constructor(scope: Construct, id: string, props: ServerlessStackProps = {}) {
    super(scope, id, props);

    const environment = resolve(this, 'environment', props.environment, 'production');
    const appName = resolve(this, 'app_name', props.appName, 'client-timesheet-app');
    resolve(this, 'frontend_domain', props.frontendDomain, '');
    const lambdaMemorySize = resolve(this, 'lambda_memory_size', props.lambdaMemorySize, 256);
    const lambdaTimeout = resolve(this, 'lambda_timeout', props.lambdaTimeout, 30);
    const enableSonarqube = resolve(this, 'enable_sonarqube', props.enableSonarqube, true);
    const sonarqubeCpu = resolve(this, 'sonarqube_cpu', props.sonarqubeCpu, 512);
    const sonarqubeMemory = resolve(this, 'sonarqube_memory', props.sonarqubeMemory, 2048);

    // Terraform uses ManagedBy="terraform"; the CDK implementation is tagged "cdk".
    Tags.of(this).add('Environment', environment);
    Tags.of(this).add('Project', appName);
    Tags.of(this).add('ManagedBy', 'cdk');

    // -------------------------------------------------------------------------
    // DynamoDB tables (scale-to-zero with on-demand billing)
    // -------------------------------------------------------------------------
    this.usersTable = new dynamodb.Table(this, 'UsersTable', {
      tableName: `${appName}-users`,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      partitionKey: { name: 'email', type: dynamodb.AttributeType.STRING },
      removalPolicy: RemovalPolicy.DESTROY,
    });
    Tags.of(this.usersTable).add('Name', 'Users Table');

    this.clientsTable = new dynamodb.Table(this, 'ClientsTable', {
      tableName: `${appName}-clients`,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      removalPolicy: RemovalPolicy.DESTROY,
    });
    this.clientsTable.addGlobalSecondaryIndex({
      indexName: 'user_email-index',
      partitionKey: { name: 'user_email', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    Tags.of(this.clientsTable).add('Name', 'Clients Table');

    this.workEntriesTable = new dynamodb.Table(this, 'WorkEntriesTable', {
      tableName: `${appName}-work-entries`,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      removalPolicy: RemovalPolicy.DESTROY,
    });
    this.workEntriesTable.addGlobalSecondaryIndex({
      indexName: 'user_email-index',
      partitionKey: { name: 'user_email', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    this.workEntriesTable.addGlobalSecondaryIndex({
      indexName: 'client_id-index',
      partitionKey: { name: 'client_id', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    Tags.of(this.workEntriesTable).add('Name', 'Work Entries Table');

    // -------------------------------------------------------------------------
    // S3 bucket for frontend (static website hosting, public read)
    // -------------------------------------------------------------------------
    this.frontendBucket = new s3.Bucket(this, 'FrontendBucket', {
      bucketName: `${appName}-frontend-${Aws.ACCOUNT_ID}`,
      websiteIndexDocument: 'index.html',
      websiteErrorDocument: 'index.html',
      blockPublicAccess: new s3.BlockPublicAccess({
        blockPublicAcls: false,
        blockPublicPolicy: false,
        ignorePublicAcls: false,
        restrictPublicBuckets: false,
      }),
      objectOwnership: s3.ObjectOwnership.OBJECT_WRITER,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    this.frontendBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'PublicReadGetObject',
        principals: [new iam.AnyPrincipal()],
        actions: ['s3:GetObject'],
        resources: [this.frontendBucket.arnForObjects('*')],
      }),
    );
    Tags.of(this.frontendBucket).add('Name', 'Frontend Bucket');

    // -------------------------------------------------------------------------
    // Lambda function for backend API
    // -------------------------------------------------------------------------
    const lambdaRole = new iam.Role(this, 'LambdaRole', {
      roleName: `${appName}-lambda-role`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
      inlinePolicies: {
        'dynamodb-access': new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: [
                'dynamodb:GetItem',
                'dynamodb:PutItem',
                'dynamodb:UpdateItem',
                'dynamodb:DeleteItem',
                'dynamodb:Query',
                'dynamodb:Scan',
              ],
              resources: [
                this.usersTable.tableArn,
                `${this.usersTable.tableArn}/index/*`,
                this.clientsTable.tableArn,
                `${this.clientsTable.tableArn}/index/*`,
                this.workEntriesTable.tableArn,
                `${this.workEntriesTable.tableArn}/index/*`,
              ],
            }),
          ],
        }),
      },
    });

    this.apiFunction = new lambda.Function(this, 'ApiFunction', {
      functionName: `${appName}-api`,
      role: lambdaRole,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'lambda.handler',
      memorySize: lambdaMemorySize,
      timeout: Duration.seconds(lambdaTimeout),
      code: placeholderCode(),
      environment: {
        NODE_ENV: environment,
        DB_MODE: 'dynamodb',
        USERS_TABLE: this.usersTable.tableName,
        CLIENTS_TABLE: this.clientsTable.tableName,
        WORK_ENTRIES_TABLE: this.workEntriesTable.tableName,
        FRONTEND_URL: this.frontendBucket.bucketWebsiteDomainName,
      },
    });

    const functionUrl = this.apiFunction.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      cors: {
        allowedOrigins: ['*'],
        allowedMethods: [lambda.HttpMethod.ALL],
        allowedHeaders: ['*'],
        allowCredentials: false,
        maxAge: Duration.seconds(86400),
      },
    });

    // -------------------------------------------------------------------------
    // API Gateway (HTTP API) - $default route + $default auto-deploy stage
    // -------------------------------------------------------------------------
    this.httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: `${appName}-api`,
      createDefaultStage: true,
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.PUT,
          apigwv2.CorsHttpMethod.DELETE,
          apigwv2.CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ['*'],
        allowCredentials: false,
        maxAge: Duration.seconds(86400),
      },
      defaultIntegration: new HttpLambdaIntegration('LambdaIntegration', this.apiFunction, {
        payloadFormatVersion: apigwv2.PayloadFormatVersion.VERSION_2_0,
      }),
    });

    // -------------------------------------------------------------------------
    // SonarQube on Fargate Spot (conditional)
    // -------------------------------------------------------------------------
    let sonarqubeCluster: ecs.Cluster | undefined;
    let sonarqubeService: ecs.FargateService | undefined;

    if (enableSonarqube) {
      const vpc = lookupDefaultVpc(this, 'DefaultVpc');
      // Terraform uses at most two of the default VPC's subnets
      const subnets = vpc.publicSubnets.slice(0, 2);

      const sonarqubeSg = new ec2.SecurityGroup(this, 'SonarqubeSecurityGroup', {
        vpc,
        securityGroupName: `${appName}-sonarqube-sg`,
        description: 'Security group for SonarQube',
        allowAllOutbound: true,
      });
      sonarqubeSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(9000), 'SonarQube Web UI');
      Tags.of(sonarqubeSg).add('Name', 'SonarQube Security Group');

      sonarqubeCluster = new ecs.Cluster(this, 'SonarqubeCluster', {
        clusterName: `${appName}-sonarqube`,
        vpc,
        containerInsightsV2: ecs.ContainerInsights.DISABLED,
      });
      const capacityProviders = new ecs.CfnClusterCapacityProviderAssociations(this, 'SonarqubeCapacityProviders', {
        cluster: sonarqubeCluster.clusterName,
        capacityProviders: ['FARGATE_SPOT'],
        defaultCapacityProviderStrategy: [{ capacityProvider: 'FARGATE_SPOT', weight: 1 }],
      });

      const executionRole = new iam.Role(this, 'SonarqubeExecutionRole', {
        roleName: `${appName}-sonarqube-execution-role`,
        assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
        managedPolicies: [
          iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
        ],
        inlinePolicies: {
          'cloudwatch-logs': new iam.PolicyDocument({
            statements: [
              new iam.PolicyStatement({
                actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
                resources: [`arn:aws:logs:${Aws.REGION}:*:log-group:/ecs/${appName}-sonarqube:*`],
              }),
            ],
          }),
        },
      });

      const efsSg = new ec2.SecurityGroup(this, 'SonarqubeEfsSecurityGroup', {
        vpc,
        securityGroupName: `${appName}-sonarqube-efs-sg`,
        description: 'Security group for SonarQube EFS',
        allowAllOutbound: true,
      });
      efsSg.addIngressRule(sonarqubeSg, ec2.Port.tcp(2049), 'NFS from SonarQube');
      Tags.of(efsSg).add('Name', 'SonarQube EFS Security Group');

      const fileSystem = new efs.FileSystem(this, 'SonarqubeData', {
        vpc,
        vpcSubnets: { subnets },
        securityGroup: efsSg,
        encrypted: false,
        lifecyclePolicy: efs.LifecyclePolicy.AFTER_7_DAYS,
        removalPolicy: RemovalPolicy.DESTROY,
      });
      Tags.of(fileSystem).add('Name', 'SonarQube Data');

      // The Terraform awslogs driver auto-creates this group; CDK manages it explicitly.
      const logGroup = new logs.LogGroup(this, 'SonarqubeLogGroup', {
        logGroupName: `/ecs/${appName}-sonarqube`,
        retention: logs.RetentionDays.INFINITE,
        removalPolicy: RemovalPolicy.DESTROY,
      });

      const taskDefinition = new ecs.FargateTaskDefinition(this, 'SonarqubeTaskDefinition', {
        family: `${appName}-sonarqube`,
        cpu: sonarqubeCpu,
        memoryLimitMiB: sonarqubeMemory,
        executionRole,
      });
      taskDefinition.addContainer('sonarqube', {
        containerName: 'sonarqube',
        image: ecs.ContainerImage.fromRegistry('sonarqube:lts-community'),
        essential: true,
        portMappings: [{ containerPort: 9000, hostPort: 9000, protocol: ecs.Protocol.TCP }],
        environment: { SONAR_ES_BOOTSTRAP_CHECKS_DISABLE: 'true' },
        logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: 'sonarqube' }),
      });

      sonarqubeService = new ecs.FargateService(this, 'SonarqubeService', {
        serviceName: 'sonarqube',
        cluster: sonarqubeCluster,
        taskDefinition,
        desiredCount: 1,
        minHealthyPercent: 100,
        maxHealthyPercent: 200,
        assignPublicIp: true,
        securityGroups: [sonarqubeSg],
        vpcSubnets: { subnets },
        capacityProviderStrategies: [{ capacityProvider: 'FARGATE_SPOT', weight: 1 }],
      });
      sonarqubeService.node.addDependency(capacityProviders);
    }

    // -------------------------------------------------------------------------
    // Outputs (mirror terraform/serverless/outputs.tf)
    // -------------------------------------------------------------------------
    new CfnOutput(this, 'api_endpoint', {
      description: 'API Gateway endpoint URL',
      value: this.httpApi.apiEndpoint,
    });
    new CfnOutput(this, 'lambda_function_url', {
      description: 'Lambda function URL (direct access)',
      value: functionUrl.url,
    });
    new CfnOutput(this, 'frontend_url', {
      description: 'S3 website URL for frontend',
      value: `http://${this.frontendBucket.bucketWebsiteDomainName}`,
    });
    new CfnOutput(this, 'frontend_bucket', {
      description: 'S3 bucket name for frontend deployment',
      value: this.frontendBucket.bucketName,
    });
    new CfnOutput(this, 'dynamodb_tables', {
      description: 'DynamoDB table names',
      value: cdk.Stack.of(this).toJsonString({
        users: this.usersTable.tableName,
        clients: this.clientsTable.tableName,
        work_entries: this.workEntriesTable.tableName,
      }),
    });
    new CfnOutput(this, 'lambda_function_name', {
      description: 'Lambda function name for deployments',
      value: this.apiFunction.functionName,
    });
    if (sonarqubeCluster && sonarqubeService) {
      new CfnOutput(this, 'sonarqube_cluster', {
        description: 'ECS cluster name for SonarQube',
        value: sonarqubeCluster.clusterName,
      });
      new CfnOutput(this, 'sonarqube_service', {
        description: 'ECS service name for SonarQube',
        value: sonarqubeService.serviceName,
      });
    }
    new CfnOutput(this, 'sonarqube_info', {
      description: 'SonarQube access information',
      value: enableSonarqube
        ? 'SonarQube runs on Fargate Spot. Get the public IP from ECS task. Default login: admin/admin'
        : 'SonarQube disabled',
    });
  }
}
