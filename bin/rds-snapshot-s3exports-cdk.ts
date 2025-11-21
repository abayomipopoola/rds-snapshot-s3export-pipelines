#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { RdsEventId, RdsSnapshotExportPipelineStack, RdsSnapshotExportPipelineStackProps, RdsSnapshotType } from '../lib/rds-snapshot-s3exports-stack';
import gitBranch from 'git-branch';
import { CDKContext } from '../types';

// Get CDK Context based on git branch
export const getContext = async (app: cdk.App): Promise<CDKContext> => {
  return new Promise(async (resolve, reject) => {
    try {
      const currentBranch = await gitBranch();

      const environment = app.node.tryGetContext('environments').find((e: any) => e.branchName === currentBranch);

      const globals = app.node.tryGetContext('globals');

      return resolve({ ...globals, ...environment });
    } catch (error) {
      console.error(error);
      return reject();
    }
  });
};

// Create Stacks
const createCDKStacks = async () => {
  try {
    const app = new cdk.App();
    const context = await getContext(app);

    const tags: any = {
      Environment: context.environment,
    };

    const stackProps: cdk.StackProps = {
      env: {
        region: context.region,
        account: context.accountNumber,
      },
      description: `Aurora data retention stack`,
      tags,
    };

    context.databases.forEach(db => {
      const stackId = `${context.appName}-${db.dbName.split('-')[0]}-${context.environment}`
      const rdsSnapshotExportPipelineStackProps: RdsSnapshotExportPipelineStackProps = {
        ...stackProps,
        stackName: `${context.appName}-${db.dbName.split('-')[0]}-${context.environment}`,
        dbName: db.dbName,
        s3BucketName: db.s3BucketName,
        rdsEvents:
          [
            {
              rdsEventId: RdsEventId.DB_AUTOMATED_AURORA_SNAPSHOT_CREATED,
              rdsSnapshotType: RdsSnapshotType.DB_AUTOMATED_SNAPSHOT
            }
          ],
      }
  
      new RdsSnapshotExportPipelineStack(app, stackId, rdsSnapshotExportPipelineStackProps, context);
    });
  } catch (error) {
    console.error(error);
  }
};

createCDKStacks();
