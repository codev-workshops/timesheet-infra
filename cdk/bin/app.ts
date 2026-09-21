#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { BootstrapStack } from '../lib/bootstrap-stack';
import { InfrastructureStack } from '../lib/infrastructure-stack';
import { ServerlessStack } from '../lib/serverless-stack';

const app = new cdk.App();

// All three Terraform stacks default aws_region to us-east-1.
const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT ?? app.node.tryGetContext('account'),
  region: app.node.tryGetContext('aws_region') ?? 'us-east-1',
};

new BootstrapStack(app, 'BootstrapStack', { env });
new InfrastructureStack(app, 'InfrastructureStack', { env });
new ServerlessStack(app, 'ServerlessStack', { env });
