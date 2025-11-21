import {
  Stack,
  StackProps,
  aws_iam as iam,
  aws_rds as rds,
  aws_ec2 as ec2,
  aws_s3 as s3, 
  aws_glue as glue,
  aws_lambda as lambda, 
  aws_sns as sns, 
  aws_kms as kms, 
  aws_lambda_event_sources as lambda_event_sources,
  Duration
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as path from 'path';
import { CDKContext } from 'types';

export enum RdsEventId {
  DB_AUTOMATED_AURORA_SNAPSHOT_CREATED = "RDS-EVENT-0169",
  DB_AUTOMATED_SNAPSHOT_CREATED = "RDS-EVENT-0091",
  DB_MANUAL_SNAPSHOT_CREATED = "RDS-EVENT-0042",
  DB_BACKUP_SNAPSHOT_FINISHED_COPY = "RDS-EVENT-0197",
}

export enum RdsSnapshotType {
  DB_AUTOMATED_SNAPSHOT = "AUTOMATED",
  DB_BACKUP_SNAPSHOT = "BACKUP",
  DB_MANUAL_SNAPSHOT = "MANUAL",
}

export interface RdsSnapshot {
  rdsEventId: RdsEventId;
  rdsSnapshotType: RdsSnapshotType;
}

export interface RdsSnapshotExportPipelineStackProps extends StackProps {
  readonly s3BucketName: string;
  readonly dbName: string;
  readonly rdsEvents: Array<RdsSnapshot>;
}

export class RdsSnapshotExportPipelineStack extends Stack {
  constructor(scope: Construct, id: string, props: RdsSnapshotExportPipelineStackProps, context: CDKContext) {
    super(scope, id, props);

    const bucket = new s3.Bucket(this, "SnapshotExportBucket", {
      bucketName: props.s3BucketName,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [
        {
          transitions: [
            {
              storageClass: s3.StorageClass.GLACIER,
              transitionAfter: Duration.days(7),
            },
            {
              storageClass: s3.StorageClass.DEEP_ARCHIVE,
              transitionAfter: Duration.days(97),
            },
          ],
          expiration: Duration.days(365), // Delete after a year.
        },
      ],
    });

    const snapshotExportTaskRole = new iam.Role(this, "SnapshotExportTaskRole", {
      assumedBy: new iam.ServicePrincipal("export.rds.amazonaws.com"),
      description: "Role used by RDS to perform snapshot exports to S3",
      inlinePolicies: {
        "SnapshotExportTaskPolicy": iam.PolicyDocument.fromJson({
          "Version": "2012-10-17",
          "Statement": [
            {
              "Action": [
                "s3:PutObject*",
                "s3:ListBucket",
                "s3:GetObject*",
                "s3:DeleteObject*",
                "s3:GetBucketLocation"
              ],
              "Resource": [
                `${bucket.bucketArn}`,
                `${bucket.bucketArn}/*`,
              ],
              "Effect": "Allow"
            }
          ],
        })
      }
    });

    const lambdaExecutionRole = new iam.Role(this, "RdsSnapshotExporterLambdaExecutionRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      description: 'RdsSnapshotExportToS3 Lambda execution role for the "' + props.dbName + '" database.',
      inlinePolicies: {
        "SnapshotExporterLambdaPolicy": iam.PolicyDocument.fromJson({
          "Version": "2012-10-17",
          "Statement": [
            {
              "Action": [
                "rds:StartExportTask",
                "rds:DescribeDBSnapshots",
                "rds:CreateDBSnapshot",
                "rds:DescribeDBSnapshots",
                "secretsmanager:GetSecretValue",
                "secretsmanager:DescribeSecret",
                "s3:GetObject",
                "s3:PutObject",
                "s3:ListBucket",
              ],
              "Resource": "*",
              "Effect": "Allow",
            },
            {
              "Action": "iam:PassRole",
              "Resource": [snapshotExportTaskRole.roleArn],
              "Effect": "Allow",
            }
          ]
        })
      },
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"),
        iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaVPCAccessExecutionRole"),
      ],
    });

    // Import existing VPC based on VPC ID.
    const vpc = ec2.Vpc.fromLookup(this, 'vpc', {  vpcId: context.vpc.id });
    const privateSubnets = vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnets;

    const lambdaSG = new ec2.SecurityGroup(this, 'lambdaSG', {
      vpc,
      allowAllOutbound: true,
      securityGroupName: `${context.appName}-${props.dbName.split('-')[0]}-lambda-sg`,
    });

    lambdaSG.addIngressRule(ec2.Peer.ipv4(context.vpc.cidr), ec2.Port.tcp(5432), 'Allow Lambda to access RDS');

    const snapshotExportGlueCrawlerRole = new iam.Role(this, "SnapshotExportsGlueCrawlerRole", {
      assumedBy: new iam.ServicePrincipal("glue.amazonaws.com"),
      description: "Role used by RDS to perform snapshot exports to S3",
      inlinePolicies: {
        "SnapshotExportsGlueCrawlerPolicy": iam.PolicyDocument.fromJson({
          "Version": "2012-10-17",
          "Statement": [
            {
              "Effect": "Allow",
              "Action": [
                "s3:GetObject",
                "s3:PutObject"
              ],
              "Resource": `${bucket.bucketArn}/*`,
            }
          ],
        }),
      },
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSGlueServiceRole"),
      ],
    });

    const snapshotExportEncryptionKey = new kms.Key(this, "SnapshotExportEncryptionKey", {
      alias: props.dbName + "-snapshot-exports",
      policy: iam.PolicyDocument.fromJson({
        "Version": "2012-10-17",
        "Statement": [
          {
            "Principal": {
              "AWS": [
                (new iam.AccountRootPrincipal()).arn
              ]
            },
            "Action": [
              "kms:*"
            ],
            "Resource": "*",
            "Effect": "Allow"
          },
          {
            "Principal": {
              "AWS": [
                lambdaExecutionRole.roleArn,
                snapshotExportGlueCrawlerRole.roleArn
              ]
            },
            "Action": [
              "kms:Encrypt",
              "kms:Decrypt",
              "kms:ReEncrypt*",
              "kms:GenerateDataKey*",
              "kms:DescribeKey"
            ],
            "Resource": "*",
            "Effect": "Allow"
          },
          {
            "Principal": { "AWS": lambdaExecutionRole.roleArn },
            "Action": [
              "kms:CreateGrant",
              "kms:ListGrants",
              "kms:RevokeGrant"
            ],
            "Resource": "*",
            "Condition": {
              "Bool": { "kms:GrantIsForAWSResource": true }
            },
            "Effect": "Allow"
          }
        ]
      })
    });

    const snapshotEventTopic = new sns.Topic(this, "SnapshotEventTopic", {
      displayName: "rds-snapshot-creation"
    });

    props.rdsEvents.find(rdsEvent => 
      rdsEvent.rdsEventId == RdsEventId.DB_AUTOMATED_AURORA_SNAPSHOT_CREATED) ? 
      new rds.CfnEventSubscription(this, 'RdsSnapshotEventNotification', {
        snsTopicArn: snapshotEventTopic.topicArn,
        enabled: true,
        eventCategories: ['backup'],
        sourceType: 'db-cluster-snapshot',
      }) :
      new rds.CfnEventSubscription(this, 'RdsSnapshotEventNotification', {
        snsTopicArn: snapshotEventTopic.topicArn,
        enabled: true,
        eventCategories: ['creation'],
        sourceType: 'db-snapshot',
      }
    );

    props.rdsEvents.find(rdsEvent => 
      rdsEvent.rdsEventId == RdsEventId.DB_BACKUP_SNAPSHOT_FINISHED_COPY) ? 
        new rds.CfnEventSubscription(this, 'RdsBackupCopyEventNotification', {
          snsTopicArn: snapshotEventTopic.topicArn,
          enabled: true,
          eventCategories: ['notification'],
          sourceType: 'db-snapshot',
        }
      ) : true;

    new lambda.Function(this, "LambdaFunction", {
      functionName: props.dbName.split("-")[0] + "-rds-snapshot-exporter",
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: "main.handler",
      code: lambda.Code.fromAsset(path.join(__dirname, "/../assets/exporter/")),
      environment: {
        RDS_EVENT_IDS: new Array(props.rdsEvents.map(e => e.rdsEventId)).join(),
        RDS_SNAPSHOT_TYPES: new Array(props.rdsEvents.map(e => e.rdsSnapshotType)).join(),
        DB_NAME: props.dbName,
        LOG_LEVEL: "INFO",
        SNAPSHOT_BUCKET_NAME: bucket.bucketName,
        SNAPSHOT_TASK_ROLE: snapshotExportTaskRole.roleArn,
        SNAPSHOT_TASK_KEY: snapshotExportEncryptionKey.keyArn,
        DB_SNAPSHOT_TYPES: new Array(props.rdsEvents.map(e => e.rdsEventId == RdsEventId.DB_AUTOMATED_AURORA_SNAPSHOT_CREATED ? "cluster-snapshot" : "snapshot")).join()
      },
      role: lambdaExecutionRole,
      timeout: Duration.seconds(30),
      vpc: vpc,
      securityGroups: [lambdaSG],
      vpcSubnets: {
        subnets: privateSubnets,
      },
      events: [
        new lambda_event_sources.SnsEventSource(snapshotEventTopic)
      ]
    });

    new glue.CfnCrawler(this, "SnapshotExportCrawler", {
      name: props.dbName + "-rds-snapshot-crawler",
      role: snapshotExportGlueCrawlerRole.roleArn,
      targets: {
        s3Targets: [
          {path: bucket.bucketName},
        ]
      },
      databaseName: props.dbName.replace(/[^a-zA-Z0-9_]/g, "_"),
      schemaChangePolicy: {
        deleteBehavior: 'DELETE_FROM_DATABASE'
      }
    });
  }
}
