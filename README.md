# RDS Snapshot S3 Export Pipeline

This is an **AWS CDK infrastructure project** that automates the export of RDS database snapshots to S3 for data retention and analysis purposes.

## Project Purpose

The pipeline automatically exports RDS snapshots to S3 whenever new snapshots are created, allowing you to:
- Query database snapshots using Amazon Athena without impacting production database performance
- Maintain long-term data retention with cost-effective storage tiers
- Archive database data for compliance and audit purposes

## How It Works

1. **Event Trigger**: RDS creates a snapshot (automated, manual, or AWS Backup)
2. **SNS Notification**: An RDS event subscription sends a notification to an SNS topic
3. **Lambda Processing**: A Python Lambda function receives the SNS message and initiates an export task
4. **S3 Export**: The snapshot is exported to S3 in Parquet format
5. **Cataloging**: An AWS Glue crawler catalogs the exported data for querying with Amazon Athena

## Architecture

```
RDS Snapshot Created
        ↓
RDS Event Subscription
        ↓
    SNS Topic
        ↓
Lambda Function (Python)
        ↓
RDS Export Task
        ↓
    S3 Bucket → Glue Crawler → Athena
```

## Key Components

### Infrastructure (CDK - TypeScript)
- **`bin/rds-snapshot-s3exports-cdk.ts`** - Entry point that creates stacks based on git branch and database configuration
- **`lib/rds-snapshot-s3exports-stack.ts`** - Main CDK stack defining all AWS resources

### Lambda Function (Python)
- **`assets/exporter/main.py`** - Handles SNS events and triggers snapshot exports
  - Supports automated RDS snapshots
  - Supports manual snapshots
  - Supports AWS Backup service snapshots

### Configuration
- **`cdk.json`** - Environment-specific settings including:
  - **Dev environment**: Empty database list (branch: `develop`)
  - **Prod environment**: 3 databases configured (branch: `main`):
    - `pams-stack-prod` → exports to `pams-db-snapshots-export`
    - `maxonevams-stack-prod` → exports to `maxonevams-db-snapshots-export`
    - `maxonelams-stack-prod` → exports to `maxonelams-db-snapshots-export`

## AWS Resources Created

For each database configured, the stack creates:

- **S3 Bucket**: Stores exported snapshots with lifecycle policies
  - Transitions to Glacier after 7 days
  - Transitions to Deep Archive after 97 days
  - Deletes objects after 365 days
- **Lambda Function**: Processes snapshot events and triggers exports (30s timeout)
- **SNS Topic**: Receives RDS event notifications
- **RDS Event Subscriptions**: Monitors snapshot creation events
- **IAM Roles**: 
  - Lambda execution role (with VPC access)
  - RDS export task role
  - Glue crawler role
- **KMS Key**: Encrypts exported snapshots
- **AWS Glue Crawler**: Catalogs exported data for Athena queries
- **Security Groups**: Controls Lambda network access to RDS
- **VPC Integration**: Lambda runs in private subnets with access to RDS

## Deployment

### Prerequisites
- AWS CLI configured with appropriate credentials
- Node.js and npm installed
- AWS CDK CLI installed (`npm install -g aws-cdk`)

### Environment Selection

The CDK app automatically determines which environment to deploy based on the current git branch:
- `main` branch → **Production** 
- `develop` branch → **Development** 

### Deploy Commands

```bash
# Install dependencies
npm install

# Build the project
npm run build

# Synthesize CloudFormation templates
npm run cdk synth

# Deploy all stacks
npm run cdk deploy --all

# Deploy specific stack
npm run cdk deploy rds-snapshot-s3exports-<db-prefix>-<environment>
```

### Adding a New Database

To add a new database for snapshot exports, update the `databases` array in `cdk.json`:

```json
{
  "environment": "prod",
  "databases": [
    {
      "dbName": "your-database-cluster-id",
      "s3BucketName": "your-snapshot-export-bucket"
    }
  ]
}
```

## Supported Snapshot Types

The pipeline supports three types of RDS snapshots:

1. **Automated Snapshots** (RDS-EVENT-0091, RDS-EVENT-0169)
   - Daily automated backups
   - Aurora cluster snapshots

2. **Manual Snapshots** (RDS-EVENT-0042)
   - User-initiated snapshots

3. **AWS Backup Snapshots** (RDS-EVENT-0197)
   - Snapshots created by AWS Backup service
   - Requires additional API call to verify DB instance

## Monitoring

- Lambda execution logs are available in CloudWatch Logs
- Export task progress can be monitored in the RDS console
- SNS topic can be subscribed to for notifications
- Glue crawler runs can be monitored in AWS Glue console

## Security

- All S3 buckets block public access
- Snapshots are encrypted using KMS
- Lambda runs in private subnets with security groups
- IAM roles follow least privilege principle
- VPC security groups restrict Lambda access to specific CIDR ranges
