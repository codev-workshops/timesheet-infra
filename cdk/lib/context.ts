import { Stack, Token } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

/**
 * Looks up the account's default VPC (replaces `aws_default_vpc` / `data.aws_vpc.default`).
 *
 * `Vpc.fromLookup` needs a concrete account/region plus AWS credentials at synth time.
 * When the stack has no resolved account (no `CDK_DEFAULT_ACCOUNT`, no `-c account=`)
 * or `-c offline=true` is passed, a placeholder VPC is used instead so `cdk synth`
 * still succeeds (e.g. in CI without credentials). Templates produced that way are
 * for validation only and must not be deployed.
 */
export function lookupDefaultVpc(scope: Construct, id: string): ec2.IVpc {
  const stack = Stack.of(scope);
  const offline = String(scope.node.tryGetContext('offline') ?? '').toLowerCase() === 'true';
  if (!offline && !Token.isUnresolved(stack.account) && !Token.isUnresolved(stack.region)) {
    return ec2.Vpc.fromLookup(scope, id, { isDefault: true });
  }
  return ec2.Vpc.fromVpcAttributes(scope, id, {
    vpcId: 'vpc-00000000000000000',
    availabilityZones: [`${stack.region}a`, `${stack.region}b`],
    publicSubnetIds: ['subnet-00000000000000001', 'subnet-00000000000000002'],
  });
}

/**
 * Resolves a stack input the same way Terraform resolves a variable:
 * explicit prop -> `cdk.json` / `-c key=value` context -> default.
 */
export function resolve<T extends string | number | boolean>(
  scope: Construct,
  key: string,
  prop: T | undefined,
  defaultValue: T,
): T {
  if (prop !== undefined) {
    return prop;
  }
  const ctx = scope.node.tryGetContext(key);
  if (ctx === undefined || ctx === null) {
    return defaultValue;
  }
  return coerce(ctx, defaultValue);
}

export function resolveRequired(scope: Construct, key: string, prop: string | undefined, source: string): string {
  const value = prop ?? scope.node.tryGetContext(key);
  if (value === undefined || value === null || value === '') {
    throw new Error(`Missing required input "${key}". Pass it via props or "-c ${key}=<value>" (${source}).`);
  }
  return String(value);
}

function coerce<T extends string | number | boolean>(raw: unknown, defaultValue: T): T {
  if (typeof defaultValue === 'boolean') {
    if (typeof raw === 'boolean') return raw as T;
    return (String(raw).toLowerCase() === 'true') as T;
  }
  if (typeof defaultValue === 'number') {
    if (typeof raw === 'number') return raw as T;
    const n = Number(raw);
    if (Number.isNaN(n)) {
      throw new Error(`Context value ${JSON.stringify(raw)} is not a number`);
    }
    return n as T;
  }
  return String(raw) as T;
}
