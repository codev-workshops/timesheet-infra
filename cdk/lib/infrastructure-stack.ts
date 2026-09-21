import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Aws, CfnOutput, Tags } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { lookupDefaultVpc, resolve, resolveRequired } from './context';

/** Mirrors terraform/infrastructure/variables.tf */
export interface InfrastructureStackProps extends cdk.StackProps {
  /** Environment name. Default: "production" */
  readonly environment?: string;
  /** EC2 instance type. Default: "t3.micro" */
  readonly instanceType?: string;
  /** Application port. Default: 3001 */
  readonly appPort?: number;
  /**
   * ECR repository URL for the application (required).
   * Comes from the BootstrapStack `ecr_repository_url` output.
   */
  readonly ecrRepositoryUrl?: string;
  /**
   * ECR repository ARN for IAM policy scoping (required).
   * Derived from the BootstrapStack ECR repository
   * (`arn:aws:ecr:<region>:<account>:repository/client-timesheet-app`).
   */
  readonly ecrRepositoryArn?: string;
}

const USER_DATA_PATH = path.join(__dirname, '..', '..', 'terraform', 'infrastructure', 'user_data.sh');

/** Mirrors terraform/infrastructure: single EC2 host in the default VPC running the app container. */
export class InfrastructureStack extends cdk.Stack {
  public readonly instance: ec2.Instance;
  public readonly securityGroup: ec2.SecurityGroup;
  public readonly eip: ec2.CfnEIP;

  constructor(scope: Construct, id: string, props: InfrastructureStackProps = {}) {
    super(scope, id, props);

    const environment = resolve(this, 'environment', props.environment, 'production');
    const instanceType = resolve(this, 'instance_type', props.instanceType, 't3.micro');
    const appPort = resolve(this, 'app_port', props.appPort, 3001);
    const ecrRepositoryUrl = resolveRequired(
      this,
      'ecr_repository_url',
      props.ecrRepositoryUrl,
      'BootstrapStack output ecr_repository_url',
    );
    const ecrRepositoryArn = resolveRequired(
      this,
      'ecr_repository_arn',
      props.ecrRepositoryArn,
      'ARN of the BootstrapStack ECR repository',
    );

    Tags.of(this).add('Environment', environment);
    Tags.of(this).add('Project', 'client-timesheet-app');

    // Replaces aws_default_vpc / aws_default_subnet
    const vpc = lookupDefaultVpc(this, 'DefaultVpc');

    this.securityGroup = new ec2.SecurityGroup(this, 'AppSecurityGroup', {
      vpc,
      securityGroupName: 'client-timesheet-app-sg',
      description: 'Security group for Client Timesheet App',
      allowAllOutbound: true,
    });
    this.securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP');
    this.securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS');
    // No SSH ingress - access is via SSM Session Manager
    Tags.of(this.securityGroup).add('Name', 'client-timesheet-app-sg');

    const role = new iam.Role(this, 'Ec2Role', {
      roleName: 'client-timesheet-ec2-role',
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
      inlinePolicies: {
        'ecr-access-policy': new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              sid: 'ECRGetAuthToken',
              actions: ['ecr:GetAuthorizationToken'],
              resources: ['*'],
            }),
            new iam.PolicyStatement({
              sid: 'ECRPullImages',
              actions: ['ecr:BatchCheckLayerAvailability', 'ecr:GetDownloadUrlForLayer', 'ecr:BatchGetImage'],
              resources: [ecrRepositoryArn],
            }),
          ],
        }),
      },
    });
    Tags.of(role).add('Name', 'client-timesheet-ec2-role');

    const userDataScript = fs
      .readFileSync(USER_DATA_PATH, 'utf8')
      .replace(/\$\{aws_region\}/g, Aws.REGION)
      .replace(/\$\{ecr_repository\}/g, ecrRepositoryUrl)
      .replace(/\$\{app_port\}/g, String(appPort));

    this.instance = new ec2.Instance(this, 'AppInstance', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: new ec2.InstanceType(instanceType),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({
        cpuType: ec2.AmazonLinuxCpuType.X86_64,
      }),
      securityGroup: this.securityGroup,
      role,
      userData: ec2.UserData.custom(userDataScript),
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(20, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
          }),
        },
      ],
    });
    Tags.of(this.instance).add('Name', 'client-timesheet-app');

    this.eip = new ec2.CfnEIP(this, 'AppEip', {
      domain: 'vpc',
      instanceId: this.instance.instanceId,
      tags: [
        { key: 'Name', value: 'client-timesheet-app-eip' },
        { key: 'Environment', value: environment },
        { key: 'Project', value: 'client-timesheet-app' },
      ],
    });

    // -------------------------------------------------------------------------
    // Outputs (mirror terraform/infrastructure/outputs.tf)
    // -------------------------------------------------------------------------
    new CfnOutput(this, 'instance_id', {
      description: 'EC2 instance ID',
      value: this.instance.instanceId,
    });
    new CfnOutput(this, 'instance_public_ip', {
      description: 'EC2 instance public IP (Elastic IP)',
      value: this.eip.attrPublicIp,
    });
    new CfnOutput(this, 'instance_public_dns', {
      description: 'EC2 instance public DNS',
      value: this.instance.instancePublicDnsName,
    });
    new CfnOutput(this, 'app_url', {
      description: 'Application URL',
      value: `http://${this.eip.attrPublicIp}`,
    });
    new CfnOutput(this, 'security_group_id', {
      description: 'Security group ID',
      value: this.securityGroup.securityGroupId,
    });
  }
}
