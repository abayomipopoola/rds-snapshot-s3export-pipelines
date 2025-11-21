export type CDKContext = {
  appName: string;
  region: string;
  environment: string;
  branchName: string;
  accountNumber: string;
  natGatewayId: string;
  vpc: {
    id: string;
    cidr: string;
    privateSubnetIds: string[];
  };
  databases: Db[];
};

export type Db = {
  dbName: string;
  s3BucketName: string;
};

export type LambdaDefinition = {
  name: string;
  memoryMB?: number;
  timeoutMins?: number;
  environment?: {
    [key: string]: string;
  };
  isPrivate?: boolean;
};
